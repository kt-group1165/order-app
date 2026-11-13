/**
 * 事業所ごとの用具の価格を ほのぼのの用具マスタ (FYGMST01) から作る
 * (2026-11-13 user 決定: (a) 価格は事業所ごとに履歴付きで持つ / (b) 新システムの用具マスタに無い品目は足してよい)
 *
 *   node migrations/import_office_prices_from_fygmst.mjs --area 誉田 --db-cache <控え json> [--valid-from 2026-04-01] [--month 2026-11] [--out <dir>]   DRY RUN (控え)
 *   node migrations/import_office_prices_from_fygmst.mjs --area 誉田 --live                                                                      DRY RUN (今の DB を読む。READ ONLY)
 *   node migrations/import_office_prices_from_fygmst.mjs --area 誉田 --live --execute --expect <品目>,<価格の行>                                本番 (★ user 承認後)
 *   node migrations/import_office_prices_from_fygmst.mjs --revert <batch_id> [--execute]                                                         取り消し (sync_fukuyogu_from_honobono.mjs の汎用処理)
 *     控え json = { fetchedAt, equipment[{id,product_code,tais_code,name,category,rental_price,parent_product_code}],
 *                   priceHist[{product_code,rental_price,valid_from,office_id}], orders[{id,office_id}], items[…], ceilings[{tais_code,product_name,model_number}] }
 *
 * 前提: equipment_price_history.office_id (applied_archive/equipment_price_history_office_id.sql) と、
 *   価格の決め方 = その事業所の行 → 共通の行 → equipment_master.rental_price (lib/equipment.ts getPriceForMonth)
 *
 * 決め方 (2026-11-14 ★福祉用具新ソフト 経由の user 決定):
 *   ① 今の価格 = 使用中 (中止=0) の行のうち 記号 ★ > ☆ > ◇ > ◎ (▲ も ◎ と同じ) > 無印、同じ記号なら ID が最大の行
 *      (ケアサポは 名前が「●」で始まらない行の ID 最大)。提供票の「新規で使われている行を優先」は使わない。
 *      記号で選んだ行と ID 最大の行が 違う価格でも 記号の順で決める (2026-11-14 user 決定: ◎ の安い方が現役。無印の高い行はコピーで登録し直した古い価格)。
 *   ② 古い価格は 品目を分けず、その事業所の価格の履歴の行にする:
 *        適用開始 --valid-from = 古い価格 / 付け替えた月 = 今の価格
 *      付け替えた月 = 提供票で 古い価格の行を使った人が 今の価格の行に移った最初の月 (全員がその月より前に古い行を使い終えていること)。
 *      付け替えた月が決まらない (古い行のまま借りている人がいる 等) → --switch-unknown (既定 2026-12) の前月までは古い価格・その月から今の価格
 *        (2026-11-14 user 決定: 過去の月は ほのぼのの請求と一致のまま・12 月から全員 今の価格)
 *      古い行で新規がある・古い価格が 2 つ以上・本数が違う → J
 *   ③' 用具マスタに品目はあるが 共通の価格が無い → その事業所の価格を事業所の行で入れる (2026-11-14 user 決定。ケアサポは作らない)
 *   ③ 価格の行は 用具マスタの親 (parent_product_code が空) だけ
 *   ④ 本数違い (1 本のサイドレール 等) は もう一方の事業所の FYGMST01 で 同じ略称・単位数の別 TAIS を候補にし、
 *      上限マスタ (equipment_price_ceilings) で その TAIS が実在し 商品名・型番に その本数 (「1本」「-1」等) があるときだけ
 *      正しいコードの品目に価格を付ける (A)。確かめられないものは J。
 *   P1 用具マスタに無い TAIS → equipment_master に品目を足す (product_code = TAIS・rental_price = 今の価格)。
 *      履歴 (②) があるときは その品目に 事業所の行も作る
 *   P2 用具マスタにあり、--valid-from 〜 --month の毎月 共通の価格 = その事業所の価格 → 何もしない
 *   P3 違う月がある → equipment_price_history に office_id = その事業所 の行 (履歴ごと。その TAIS の親の品目ごと)
 *      ★ ケアサポは作らない (共通の価格 = ケアサポの請求価格なので二重に持たせない) → J
 *   J  判断が要る (書かない)
 * ★ その事業所の注文で --valid-from 〜 --month に貸与していた明細が使っている品目は 事業所の行を作らず J (今の請求額を変えない)
 *
 * --execute (data_import_batches / data_import_rows の作法・_exec_lock.mjs):
 *   --live のみ。--expect <P1 の品目数>,<価格の行数> が DRY RUN と違えば止める。
 *   書込みの計画を migrations/_backup_office_prices_<拠点>_<YYYYMMDD-HHmmss-SSS>.json に退避 (ミリ秒まで = 続けて回しても上書きしない)。
 *   書く直前に 同じ品目・同じ価格の行が既に無いかを 1 行ずつ確かめ、1 行ずつ insert して 返った行数 1 を確かめる。
 *   5xx・HTML・タイムアウトは止める (リトライしない)。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { resolveFukuyoguOffice, latestTeikyoDir } from "./_fukuyogu_office.mjs";
import { execLockStart, execLockAcquire } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (opt("--revert") || opt("--cleanup-batch")) {
  const r = spawnSync(process.execPath, [join(HERE, "sync_fukuyogu_from_honobono.mjs"), ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const EXECUTE = argv.includes("--execute");
const LIVE = argv.includes("--live");
const CACHE = opt("--db-cache");
if (!LIVE && !CACHE) { console.error("usage: --area 誉田 (--db-cache <json> | --live [--execute --expect <品目>,<価格の行>]) [--valid-from 2026-04-01] [--month 2026-11]"); process.exit(1); }
if (EXECUTE && !LIVE) { console.error("★ --execute は --live (今の DB) と一緒に"); process.exit(1); }
if (EXECUTE && !/^\d+,\d+(,\d+)?$/.test(opt("--expect") ?? "")) { console.error("★ --execute には --expect <P1 の品目数>,<価格の行数>[,<消す事業所の行数>] が要る (DRY RUN の「書込みの見込み」の数)"); process.exit(1); }
const FO = resolveFukuyoguOffice(argv);
const VALID_FROM = opt("--valid-from") ?? "2026-04-01";
const MONTH = opt("--month") ?? new Date().toISOString().slice(0, 7);
// ② 改定月が提供票で決まらないとき 今の価格に切り替える月 (2026-11-14 user 決定: 2026-11 までは古い価格・2026-12-01 から全員 今の価格)
const SWITCH_UNKNOWN = opt("--switch-unknown") ?? "2026-12";
// 既にある事業所の行を 決め方どおりに置き換えてよい TAIS (カンマ区切り)。指定が無ければ 既にある行と違うものは J (勝手に書き換えない)
// user が「--valid-from から今の価格」と決めた TAIS (カンマ区切り)。同じ月の混在が無くても 履歴にしない (例 BPZ丸ト伸固9012: ケアサポの現役 4900・誉田は古い 5000 だけで請求)
const FROM_START = new Set((opt("--price-from-start") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const REPLACE = new Set((opt("--replace-tais") ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const OUT = opt("--out") ?? join(tmpdir(), "office-prices-from-fygmst");
const TENANT = "kt-group";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP = "office-prices-fygmst";
const SCRIPT_REL = "apps/order-app/migrations/import_office_prices_from_fygmst.mjs";
const IS_CARESAPO = FO.bn === "1272400050";
const nf = (s) => String(s ?? "").normalize("NFKC").trim();
const nTais = (s) => nf(s).toUpperCase().replace(/[‐－―ー–?]/g, "-");
const isTais = (t) => /^\d{5}-[0-9A-Z]{6}$/.test(t);
const ymAdd = (ym, n) => { const [y, m] = ym.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const months = (a, b) => { const out = []; for (let m = a; m <= b; m = ymAdd(m, 1)) out.push(m); return out; };
/** 提供票の提供年月 (YYYYMM / YYYY/MM / YYYY-MM / R8/05 等) → YYYY-MM */
const toYm = (s) => {
  const t = nf(s);
  let m = t.match(/^(\d{4})[\/\-]?(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  m = t.match(/^R(\d+)[\/\-.年]?(\d{1,2})/i); if (m) return `${2018 + Number(m[1])}-${m[2].padStart(2, "0")}`;
  return null;
};

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
function readMaster(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const col = (k) => { const i = head.indexOf(k); if (i < 0) throw new Error(`★ ${path} に列「${k}」が無い`); return i; };
  const H = Object.fromEntries(["ID", "中止", "福祉用具種目", "商品名称", "略称", "型番", "TAISコード等", "単位数"].map((k) => [k, col(k)]));
  const out = [];
  for (let r of lines.slice(1).map(parseCsvLine)) {
    if (r.length === head.length + 1) r = [...r.slice(0, H.型番), `${r[H.型番]},${r[H.型番 + 1]}`, ...r.slice(H.型番 + 2)];
    if (r.length !== head.length) throw new Error(`★ ${path}: 列数 ${r.length} ≠ ${head.length}`);
    const tais = nTais(r[H.TAISコード等]);
    if (!isTais(tais) || r[H.単位数] === "") continue;
    out.push({ id: Number(r[H.ID]), stop: r[H.中止] === "1", cat: nf(r[H.福祉用具種目]).replace(/^予防/, ""), name: nf(r[H.商品名称]), abbr: nf(r[H.略称]), model: nf(r[H.型番]), tais, units: Number(r[H.単位数]) });
  }
  return out;
}

const mdir = join(FO.dir, "マスタ");
if (!existsSync(mdir)) { console.log(`未着: ${mdir} が無い`); process.exit(0); }
const files = readdirSync(mdir).filter((f) => /^FYGMST.*\.csv$/i.test(f) && !/自費/.test(f));
const byTais = new Map();
for (const f of files) for (const r of readMaster(join(mdir, f))) { if (!byTais.has(r.tais)) byTais.set(r.tais, []); byTais.get(r.tais).push(r); }

// 提供票 (入力側) の実績行を「(略称)」と 月額の単位数 (全額 = 概算単位・半額 = ×2) で FYGMST01 の行に当てる
//   use = 実績行の数 / fresh = 新しく始まった (利用者, 行) の数 (提供票の最初の月より後に初めて出たもの) / spanOf = 利用者ごとの使用期間
const useOf = new Map(), freshOf = new Map();
const spanOf = new Map(); // 利用者|略称|単位 → { min, max } (YYYY-MM)
const ymsOf = new Map(); // 略称|単位 → Set<YYYY-MM> (その行で請求した月)
const TDIR = latestTeikyoDir(FO.dir);
if (TDIR) {
  const firstSeen = new Map();
  const tfiles = readdirSync(TDIR).filter((f) => /^提供票_\d{6}\.csv$/i.test(f)).sort();
  for (const f of tfiles) {
    const lines = new TextDecoder("shift-jis").decode(readFileSync(join(TDIR, f))).split(/\r\n|\n/).filter((l) => l.length > 0);
    const head = parseCsvLine(lines[0]);
    const c = Object.fromEntries(["利用者番号", "提供年月", "サービス内容", "予定／実績", "日割区分", "概算単位数"].map((k) => { const i = head.indexOf(k); if (i < 0) throw new Error(`★ ${f} に列「${k}」が無い`); return [k, i]; }));
    for (const r of lines.slice(1).map(parseCsvLine)) {
      if (nf(r[c["予定／実績"]]) !== "実績") continue;
      const m = nf(r[c.サービス内容]).match(/貸与[（(](.*)[)）]$/);
      const u = Number(r[c.概算単位数] || 0), hw = nf(r[c.日割区分]);
      const full = hw === "全額" ? u : hw === "半額" ? u * 2 : null;
      if (!m || full == null) continue;
      const ym = toYm(r[c.提供年月]);
      if (!ym) throw new Error(`★ ${f}: 提供年月「${r[c.提供年月]}」を読めない`);
      const k = `${nf(m[1])}|${full}`;
      useOf.set(k, (useOf.get(k) ?? 0) + 1);
      const pk = `${nf(r[c.利用者番号])}|${k}`;
      if (!firstSeen.has(pk) || firstSeen.get(pk) > ym) firstSeen.set(pk, ym);
      if (!ymsOf.has(k)) ymsOf.set(k, new Set()); ymsOf.get(k).add(ym);
      const sp = spanOf.get(pk); if (!sp) spanOf.set(pk, { min: ym, max: ym }); else { if (ym < sp.min) sp.min = ym; if (ym > sp.max) sp.max = ym; }
    }
  }
  const minYm = [...firstSeen.values()].sort()[0];
  for (const [pk, ym] of firstSeen) if (ym > minYm) { const k = pk.slice(pk.indexOf("|") + 1); freshOf.set(k, (freshOf.get(k) ?? 0) + 1); }
}
const usedOf = (r) => useOf.get(`${r.abbr}|${r.units}`) ?? 0;
const freshOfRow = (r) => freshOf.get(`${r.abbr}|${r.units}`) ?? 0;
/** その行 (略称|単位) を使った利用者 → 期間 */
const usersOfRow = (r) => { const k = `${r.abbr}|${r.units}`, out = new Map(); for (const [pk, sp] of spanOf) if (pk.slice(pk.indexOf("|") + 1) === k) out.set(pk.slice(0, pk.indexOf("|")), sp); return out; };

// ④ 本数違い: もう一方の事業所の FYGMST01 で 同じ略称 (記号・予 を除く)・同じ単位数 の行の TAIS を候補にする
const coreAbbr = (a) => nf(a).replace(/^[予★☆◎◇▲●]+/, "").replace(/[\s　]/g, "");
const otherCode = new Map(); // coreAbbr|単位 → Set<TAIS>
const OTHER_AREA = IS_CARESAPO ? "誉田" : "ケアサポ";
{
  const odir = join(resolveFukuyoguOffice(["--area", OTHER_AREA]).dir, "マスタ");
  if (existsSync(odir)) for (const f of readdirSync(odir).filter((x) => /^FYGMST.*\.csv$/i.test(x) && !/自費/.test(x))) {
    for (const r of readMaster(join(odir, f))) { const k = `${coreAbbr(r.abbr || r.name)}|${r.units}`; if (!otherCode.has(k)) otherCode.set(k, new Set()); otherCode.get(k).add(r.tais); }
  }
}
const QTY_RE = /(\d+)\s*(本|枚|セット|個|組|台)/;
const qtyOf = (r) => { const m = (r.abbr || r.name).match(QTY_RE); return m ? `${m[1]}${m[2]}` : null; };

// ── DB (控え or 今の DB。READ ONLY) ─────────────────────────────────────────
let E, H, sb = null, EXEC_LOCK = null;
async function rest(path) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetch(`${E.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, { headers: H, signal: ctl.signal });
    const t = await r.text();
    if (!r.ok || t.startsWith("<")) throw new Error(`STOP (リトライしない) ${r.status} ${path.slice(0, 80)} ${t.slice(0, 160)}`);
    return JSON.parse(t);
  } finally { clearTimeout(tm); }
}
async function restAll(table, select) {
  const out = [];
  for (let o = 0; ; o += 1000) { const j = await rest(`${table}?select=${select}&tenant_id=eq.${TENANT}&order=id&limit=1000&offset=${o}`); out.push(...j); if (j.length < 1000) break; }
  if (!out.length) throw new Error(`★ ${table} が 0 行 (列名 / tenant を疑う)`);
  return out;
}
let snap;
if (LIVE) {
  const txt = readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8");
  E = Object.fromEntries(txt.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
  H = { apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_ROLE_KEY}` };
  if (EXECUTE) {
    sb = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  }
  const equipment = await restAll("equipment_master", "id,product_code,tais_code,name,category,kind,rental_price,parent_product_code");
  const priceHist = await restAll("equipment_price_history", "id,product_code,rental_price,valid_from,office_id");
  const orders = await restAll("orders", "id,client_id,office_id,status");
  const items = await restAll("order_items", "id,order_id,product_code,rental_price,status,rental_start_date,rental_end_date,cancelled_at");
  const cand = [...new Set([...byTais.keys(), ...[...otherCode.values()].flatMap((s) => [...s])])];
  const ceilings = [];
  for (let i = 0; i < cand.length; i += 150) ceilings.push(...await rest(`equipment_price_ceilings?select=tais_code,effective_from,ceiling_price,product_name,model_number&tais_code=in.(${cand.slice(i, i + 150).map((t) => `"${t}"`).join(",")})`));
  snap = { fetchedAt: `今の DB (${new Date().toISOString()})`, equipment, priceHist, orders, items, ceilings };
} else snap = JSON.parse(readFileSync(CACHE, "utf8"));
if (!snap.ceilings) console.log("⚠ 控えに上限マスタ (ceilings) が無い → 本数違いは全部 J になる");

const hist = snap.priceHist ?? [];
if (hist.some((h) => h.office_id === undefined)) console.log("⚠ 控えの価格履歴に office_id 列が無い (古い控え)。共通の行とみなす");
if (hist.some((h) => h.office_id === FO.officeId)) console.log(`⚠ ${FO.area} の事業所の行が 既に ${hist.filter((h) => h.office_id === FO.officeId).length} 行ある (同じ行は書かない・違う価格なら J)`);
const commonPrice = (e, ym) => {
  const hs = hist.filter((h) => h.product_code === e.product_code && !h.office_id && h.valid_from <= `${ym}-01`).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
  return hs[0]?.rental_price ?? e.rental_price ?? null;
};
const officeRowsOf = (code) => hist.filter((h) => h.product_code === code && h.office_id === FO.officeId);
const ceilByTais = new Map();
for (const c of snap.ceilings ?? []) { const t = nTais(c.tais_code); if (!ceilByTais.has(t)) ceilByTais.set(t, []); ceilByTais.get(t).push(c); }
const eqByTais = new Map();
// ③ 価格の行は 親 (parent_product_code が空) にだけ作る (子は親の価格を使う)
const parentEquipment = (snap.equipment ?? []).filter((e) => !e.parent_product_code);
for (const e of parentEquipment) for (const t of new Set([nTais(e.tais_code), nTais(e.product_code)])) { if (!isTais(t)) continue; if (!eqByTais.has(t)) eqByTais.set(t, []); if (!eqByTais.get(t).includes(e)) eqByTais.get(t).push(e); }
const allCodes = new Set((snap.equipment ?? []).map((e) => e.product_code));
const knownCats = new Set((snap.equipment ?? []).map((e) => e.category).filter(Boolean));
if (parentEquipment.length !== (snap.equipment ?? []).length) console.log(`(用具マスタの子 ${(snap.equipment ?? []).length - parentEquipment.length} 行は 価格の行を作る対象から外した)`);
const vfYm = VALID_FROM.slice(0, 7);

const R = { P1: [], P2: [], P3: [], RP: [], J: [], G: [], A: [], hist: [], symVsId: [], raise: [], unused: [] };
const jOf = (tais, name, why, extra = {}) => R.J.push({ TAIS: tais, 名前: name, 理由: why, ...extra });
/** ① 記号の優先。★ = 最新・最安 / ☆ = その前 / ◇ / ◎・▲ / 無印 */
const genMark = (r) => ((r.abbr || r.name).match(/^[★☆◎◇▲●]/) ?? r.name.match(/^[★☆◎◇▲●]/) ?? [""])[0];
const genRank = (r) => ({ "★": 5, "☆": 4, "◇": 3, "◎": 2, "▲": 2 })[genMark(r)] ?? 1;
const label = (r) => `${r.id}:${r.abbr || r.name}:${r.units * 10}円`;

/** その TAIS に その事業所の価格の推移 (timeline) を付ける: 新しい品目 (P1) か 既存の品目 (P2/P3/J) か を決める */
function place(tais, name, cat, timeline, note) {
  const priceAt = (ym) => timeline.filter((t) => t.from <= ym).at(-1)?.price ?? timeline[0].price;
  const cur = timeline.at(-1).price;
  const eqs = eqByTais.get(tais) ?? [];
  if (!eqs.length) {
    if (allCodes.has(tais)) return jOf(tais, name, "用具マスタに product_code = TAIS の子の品目がある (親が無い)", { 今の価格: cur });
    if (!knownCats.has(cat)) return jOf(tais, name, `種目「${cat}」が 用具マスタの種目に無い`, { 今の価格: cur });
    return R.P1.push({ TAIS: tais, 名前: name, 種目: cat, 価格: cur, 事業所の行: timeline.length > 1 ? timeline.map((t) => `${t.from}=${t.price}`).join(" → ") : "", 備考: note ?? "" });
  }
  const MS = months(vfYm, [MONTH, timeline.at(-1).from].sort().at(-1)); // 履歴の最後の行 (例 2026-12) まで比べる
  const cps = [...new Set(eqs.map((e) => MS.map((m) => commonPrice(e, m)).join("|")))];
  if (cps.length > 1) return jOf(tais, name, "用具マスタの同じ TAIS に 価格の違う品目が複数 (世代が分かれている)", { 品目: eqs.map((e) => `${e.product_code}=${commonPrice(e, MONTH)}`).join(" / "), 今の価格: cur });
  const common = MS.map((m) => commonPrice(eqs[0], m));
  // ③ 共通の価格が無い → その事業所の価格を事業所の行として入れる (2026-11-14 user 決定)。ケアサポは作らない
  const noCommon = common.every((p) => p == null);
  if (noCommon && IS_CARESAPO) return jOf(tais, name, "共通の価格が無い (ケアサポは事業所の行を作らない)", { 品目: eqs.map((e) => e.product_code).join(" / "), 今の価格: cur });
  const existing = eqs.flatMap((e) => officeRowsOf(e.product_code));
  if (existing.length) {
    const same = eqs.every((e) => { const ex = officeRowsOf(e.product_code); return ex.length === timeline.length && timeline.every((t) => ex.some((x) => x.valid_from === `${t.from}-01` && x.rental_price === t.price)); });
    if (same) return R.P2.push({ TAIS: tais, 既に: "事業所の行あり" });
    if (REPLACE.has(tais)) {
      // 置き換え: 決め方どおりの価格が 毎月 共通の価格と同じなら 事業所の行は要らない (消すだけ)
      const needRows = noCommon || !MS.every((m, i) => common[i] === priceAt(m));
      const want = needRows ? eqs.flatMap((e) => timeline.map((t) => ({ product_code: e.product_code, valid_from: `${t.from}-01`, rental_price: t.price }))) : [];
      const same1 = (a, b) => a.product_code === b.product_code && a.valid_from === b.valid_from && a.rental_price === b.rental_price;
      const del = existing.filter((x) => !want.some((w) => same1(w, x)));
      const ins = want.filter((w) => !existing.some((x) => same1(w, x)));
      return R.RP.push({ TAIS: tais, 名前: name, 今の行: existing.map((x) => `${x.product_code} ${x.valid_from}=${x.rental_price}`).join(" / "), 直した行: want.length ? want.map((w) => `${w.product_code} ${w.valid_from}=${w.rental_price}`).join(" / ") : "(無し = 共通の価格どおり)", 消す: del, 足す: ins, 備考: note ?? "" });
    }
    return jOf(tais, name, `${FO.area} の事業所の行が既に別の内容である (${existing.map((x) => `${x.product_code} ${x.valid_from}=${x.rental_price}`).join(" / ")})`, { 今の価格: cur });
  }
  if (!noCommon && MS.every((m, i) => common[i] === priceAt(m))) return R.P2.push({ TAIS: tais });
  if (IS_CARESAPO) return jOf(tais, name, "ケアサポは 事業所の行を作らない (共通の価格がケアサポの請求価格)。FYGMST01 と共通の価格が違う", { 品目: eqs.map((e) => e.product_code).join(" / "), 今の価格: cur });
  R.P3.push({ TAIS: tais, 名前: name, 品目コード: eqs.map((e) => e.product_code), 共通の価格: noCommon ? "無し" : `${common[0]}→${common.at(-1)}`, 事業所の行: timeline.map((t) => `${t.from}=${t.price}`).join(" → "), 差: noCommon ? null : cur - (common.at(-1) ?? common[0]), timeline, 備考: [noCommon ? "共通の価格が無い → 事業所の行で埋める" : "", note ?? ""].filter(Boolean).join(" / ") });
}

const aCands = []; // ④ 確かめた正しいコード → 後で place
for (const [tais, rows] of byTais) {
  const act = rows.filter((r) => !r.stop);
  if (!act.length) continue; // 中止だけの品目は作らない
  // ④ 本数違い: 候補が 1 つ・上限マスタで確かめられたものだけ
  const wrongCode = new Map();
  for (const r of act) {
    const q = qtyOf(r);
    if (!q) continue;
    const cands = [...(otherCode.get(`${coreAbbr(r.abbr || r.name)}|${r.units}`) ?? [])].filter((t) => t !== tais);
    if (!cands.length) continue;
    const base = { TAIS: tais, 行: `${label(r)} (実績 ${usedOf(r)})`, 候補: cands.join(" / ") };
    if (cands.length > 1) { wrongCode.set(r, null); jOf(tais, r.abbr || r.name, `本数違い (${q}) の正しいコードの候補が ${cands.length} 個`, base); continue; }
    const t = cands[0];
    const cs = ceilByTais.get(t) ?? [];
    const [n, unit] = [q.match(QTY_RE)[1], q.match(QTY_RE)[2]];
    const hasQty = (c) => nf(`${c.product_name ?? ""} ${c.model_number ?? ""}`).includes(`${n}${unit}`) || (unit === "本" && n === "1" && /-1$/.test(nf(c.model_number)));
    const own = ceilByTais.get(tais) ?? [];
    if (!cs.length) { wrongCode.set(r, null); jOf(tais, r.abbr || r.name, `本数違い (${q}): 候補 ${t} が 上限マスタに無い (確かめられない)`, base); continue; }
    if (!cs.some(hasQty)) { wrongCode.set(r, null); jOf(tais, r.abbr || r.name, `本数違い (${q}): 候補 ${t} の上限マスタ (${cs[0].product_name} ${cs[0].model_number ?? ""}) に ${q} が無い`, base); continue; }
    if (own.some(hasQty)) { wrongCode.set(r, null); jOf(tais, r.abbr || r.name, `本数違い (${q}): 元の ${tais} の上限マスタにも ${q} がある (どちらが正しいか決まらない)`, base); continue; }
    wrongCode.set(r, t);
    R.A.push({ ...base, 正しいコード: t, 上限マスタ: `${cs[0].product_name} ${cs[0].model_number ?? ""}`.trim(), 元の上限マスタ: own.length ? `${own[0].product_name} ${own[0].model_number ?? ""}`.trim() : "(無い)" });
    aCands.push({ t, r });
  }
  const actOk = act.filter((r) => !wrongCode.has(r));
  if (!actOk.length) continue;
  const poolBase = IS_CARESAPO ? (actOk.filter((r) => !r.name.startsWith("●")).length ? actOk.filter((r) => !r.name.startsWith("●")) : actOk) : actOk;
  const byId = poolBase.reduce((a, b) => (b.id > a.id ? b : a));
  const cur = IS_CARESAPO ? byId : poolBase.reduce((a, b) => (genRank(b) > genRank(a) || (genRank(b) === genRank(a) && b.id > a.id) ? b : a));
  const name = cur.abbr || cur.name;
  // ① 記号と ID が食い違い 価格も違う → J
  // ① 記号と ID 最大が違う価格でも 記号の順で決める (2026-11-14 user 決定: ◎ の安い方が現役。無印の高い行は コピーで登録し直した古い価格)。数えるだけ
  if (cur !== byId && cur.units !== byId.units) R.symVsId.push({ TAIS: tais, 記号で選んだ行: label(cur), ID最大の行: label(byId) });
  if (!IS_CARESAPO && actOk.some((r) => r.units < cur.units)) R.raise.push({ TAIS: tais, 今の行: label(cur), 安い行: actOk.filter((r) => r.units < cur.units).map(label).join(" ") });
  const unusedRows = IS_CARESAPO ? [] : actOk.filter((r) => r !== cur && r.units !== cur.units && usedOf(r) === 0);
  if (unusedRows.length) R.unused.push({ TAIS: tais, 行: unusedRows.map(label).join(" ") });
  // ② 今の価格と違う 使われている行 → 古い価格 (履歴)
  const otherRows = actOk.filter((r) => r.units !== cur.units && (IS_CARESAPO || usedOf(r) > 0));
  if (IS_CARESAPO) {
    for (const u of [...new Set(otherRows.map((r) => r.units))]) R.G.push({ TAIS: tais, 名前: name, 今の価格: cur.units * 10, ほかの価格: u * 10, ほかの行: otherRows.filter((r) => r.units === u).map(label).join(" ") });
    place(tais, name, cur.cat, [{ from: vfYm, price: cur.units * 10 }]);
    continue;
  }
  if (!otherRows.length) { place(tais, name, cur.cat, [{ from: vfYm, price: cur.units * 10 }]); continue; }
  const olds = [...new Set(otherRows.map((r) => r.units))];
  const base = { 今の行: label(cur), 古い行: otherRows.map((r) => `${label(r)}(新${freshOfRow(r)}/実${usedOf(r)})`).join(" ") };
  if (olds.length > 1) { jOf(tais, name, `古い価格が ${olds.length} 通り (履歴の順が決まらない)`, base); continue; }
  const qr = otherRows.find((r) => qtyOf(r) !== qtyOf(cur));
  if (qr) { jOf(tais, name, `古い行と本数・セットが違う (${qtyOf(qr) ?? "無印"} / ${qtyOf(cur) ?? "無印"}) で 正しいコードが確かめられない`, base); continue; }
  const curUsers = usersOfRow(cur);
  const oldUsers = new Map(otherRows.flatMap((r) => [...usersOfRow(r)]));
  const lastOld = [...oldUsers.values()].map((sp) => sp.max).sort().at(-1);
  const switchers = [...oldUsers].filter(([n, sp]) => curUsers.has(n) && curUsers.get(n).min > sp.max);
  const stillOld = [...oldUsers].filter(([n]) => !switchers.some(([m]) => m === n));
  const fresh = otherRows.reduce((a, r) => a + freshOfRow(r), 0);
  // ★ 同じ月に 今の価格と古い価格の両方で請求している = 請求ミス (2026-11-14 user: 「同じ月に同じ TAIS を複数価格で出していたら 100% ミス」)
  //   → 改定ではない。--valid-from から今の価格 (記号の順。ケアサポの現役の価格とも突き合わせた: BPZ 4900・KQ-C6322 12200・クリンディ 2800)
  const curYms = ymsOf.get(`${cur.abbr}|${cur.units}`) ?? new Set();
  const mixed = [...new Set(otherRows.flatMap((r) => [...(ymsOf.get(`${r.abbr}|${r.units}`) ?? [])]))].filter((ym) => curYms.has(ym)).sort();
  if (FROM_START.has(tais) && !mixed.length) {
    const nt = `user 決定 (2026-11-14) で ${vfYm} から ${cur.units * 10} (古い価格 ${olds[0] * 10} は使わない)`;
    R.hist.push({ TAIS: tais, 名前: name, ...base, 付け替えた月: "(user 決定)", 移った人: 0, 備考: nt });
    place(tais, name, cur.cat, [{ from: vfYm, price: cur.units * 10 }], nt);
    continue;
  }
  if (mixed.length) {
    const nt = `同じ月 (${mixed.join(",")}) に ${olds[0] * 10} と ${cur.units * 10} の両方で請求 = 請求ミス → ${vfYm} から ${cur.units * 10} (2026-11-14 user 決定)`;
    R.hist.push({ TAIS: tais, 名前: name, ...base, 付け替えた月: "(請求ミス)", 移った人: switchers.length, 備考: nt });
    place(tais, name, cur.cat, [{ from: vfYm, price: cur.units * 10 }], nt);
    continue;
  }
  const unknownSwitch = (why) => {
    // 値上げは書かない (2026-11-14 user: 了解は「値下げなので 古い価格の人を移しても過大にならない」が前提。値上げは別に確認する)
    if (cur.units > olds[0]) return jOf(tais, name, `改定月が分からない・値上げ (${olds[0] * 10}→${cur.units * 10}) → 12 月から今借りている人の請求を上げることになるので書かない (user 確認待ち)`, base);
    const nt = `改定月が分からない (${why}) → ${ymAdd(SWITCH_UNKNOWN, -1)} まで古い価格・${SWITCH_UNKNOWN} から今の価格 (2026-11-14 user 決定)`;
    R.hist.push({ TAIS: tais, 名前: name, ...base, 付け替えた月: SWITCH_UNKNOWN, 移った人: switchers.length, 備考: nt });
    place(tais, name, cur.cat, [{ from: vfYm, price: olds[0] * 10 }, { from: SWITCH_UNKNOWN, price: cur.units * 10 }], nt);
  };
  if (!switchers.length) { unknownSwitch(`移った人なし・古い価格のまま ${stillOld.length} 名・最後 ${lastOld}`); continue; }
  if (stillOld.length) { unknownSwitch(`移った人 ${switchers.length} 名・古い価格のまま ${stillOld.length} 名・最後 ${lastOld}`); continue; }
  const sw = switchers.map(([n]) => curUsers.get(n).min).sort()[0];
  if (lastOld >= sw) { unknownSwitch(`付け替え ${sw} より後 ${lastOld} まで古い価格の人がいる`); continue; }
  if (fresh > 0 && [...curUsers.values()].some((sp) => sp.min < sw)) { jOf(tais, name, `古い行で新規 ${fresh} 件・付け替え ${sw} より前に今の行の人もいる (別の品目の可能性)`, base); continue; }
  if (sw <= vfYm) { place(tais, name, cur.cat, [{ from: vfYm, price: cur.units * 10 }], `古い価格 ${olds[0] * 10} は ${sw} より前 (--valid-from 前) で終わり`); continue; }
  R.hist.push({ TAIS: tais, 名前: name, ...base, 付け替えた月: sw, 移った人: switchers.length });
  place(tais, name, cur.cat, [{ from: vfYm, price: olds[0] * 10 }, { from: sw, price: cur.units * 10 }], `改定 ${sw} (提供票で ${switchers.length} 名が付け替え)`);
}
// ④ 確かめた正しいコード: その事業所の FYGMST01 に そのコードの使用中の行が無いときだけ (あれば そちらで決まる)
for (const [t, rs] of Object.entries(Object.groupBy(aCands, (x) => x.t))) {
  const own = (byTais.get(t) ?? []).filter((r) => !r.stop);
  const prices = [...new Set(rs.map((x) => x.r.units))];
  const nm = rs[0].r.abbr || rs[0].r.name;
  if (prices.length > 1) { jOf(t, nm, `本数違いの行が 正しいコードで ${prices.length} 通りの価格`, { 行: rs.map((x) => label(x.r)).join(" ") }); continue; }
  if (own.length) { if (!own.some((r) => r.units === prices[0])) jOf(t, nm, `本数違いの行の価格 ${prices[0] * 10} が その事業所の ${t} の行 (${own.map(label).join(" ")}) と違う`); continue; }
  place(t, nm, rs[0].r.cat, [{ from: vfYm, price: prices[0] * 10 }], `本数違い (${rs.map((x) => x.r.tais).join(",")} の ${qtyOf(rs[0].r)}) → 上限マスタで確かめたコード`);
}

// 影響: この事業所の注文で --valid-from 〜 --month に貸与していた明細が 事業所の行を作る品目を使っているか → J に回す
const orders = new Map((snap.orders ?? []).map((o) => [o.id, o]));
const p3codes = new Set(R.P3.flatMap((x) => x.品目コード));
const ms = VALID_FROM, me = `${MONTH}-31`;
const hit = (snap.items ?? []).filter((it) => {
  const o = orders.get(it.order_id);
  if (!o || o.office_id !== FO.officeId || !p3codes.has(it.product_code)) return false;
  if (!["rental_started", "terminated"].includes(it.status) || it.cancelled_at) return false;
  return (it.rental_start_date ?? "9") <= me && (!it.rental_end_date || it.rental_end_date >= ms);
});
const hitCodes = new Set(hit.map((i) => i.product_code));
for (const x of [...R.P3]) {
  const used = x.品目コード.filter((c) => hitCodes.has(c));
  if (!used.length) continue;
  R.P3.splice(R.P3.indexOf(x), 1);
  jOf(x.TAIS, x.名前, `${vfYm}〜${MONTH} に 貸与していた明細 ${hit.filter((i) => used.includes(i.product_code)).length} 本が 共通の価格 (${x.共通の価格}) で請求されている → 事業所の行を作ると請求額が変わる`, { 品目: used.join(" / "), 事業所の行: x.事業所の行 });
}

// ── 書込みの計画 ───────────────────────────────────────────────────────────
const plan = { equipment: [], prices: [], deletes: [] };
for (const x of R.RP) {
  for (const d of x.消す) plan.deletes.push({ key: `価格|${d.product_code}|${FO.officeId}|${d.valid_from.slice(0, 7)}`, ref: { 理由: `置き換え: ${x.備考}`, TAIS: x.TAIS }, row: d });
  for (const w of x.足す) plan.prices.push({ key: `価格|${w.product_code}|${FO.officeId}|${w.valid_from.slice(0, 7)}`, ref: { 理由: `置き換え: ${x.備考}`, TAIS: x.TAIS }, row: { tenant_id: TENANT, ...w, office_id: FO.officeId } });
}
for (const x of R.P1) {
  plan.equipment.push({ key: `品目|${x.TAIS}`, ref: { 理由: "FYGMST01 にあり 用具マスタに無い TAIS", 名前: x.名前, 備考: x.備考 }, row: { tenant_id: TENANT, product_code: x.TAIS, tais_code: x.TAIS, name: x.名前, category: x.種目, kind: "single", rental_price: x.価格 } });
  if (x.事業所の行) for (const s of x.事業所の行.split(" → ")) { const [from, p] = s.split("="); plan.prices.push({ key: `価格|${x.TAIS}|${FO.officeId}|${from}`, ref: { 理由: x.備考 || "事業所の価格", TAIS: x.TAIS }, row: { tenant_id: TENANT, product_code: x.TAIS, office_id: FO.officeId, valid_from: `${from}-01`, rental_price: Number(p) } }); }
}
for (const x of R.P3) for (const code of x.品目コード) for (const t of x.timeline) plan.prices.push({ key: `価格|${code}|${FO.officeId}|${t.from}`, ref: { 理由: x.備考 || "FYGMST01 の今の価格が共通の価格と違う", TAIS: x.TAIS, 共通の価格: x.共通の価格 }, row: { tenant_id: TENANT, product_code: code, office_id: FO.officeId, valid_from: `${t.from}-01`, rental_price: t.price } });

mkdirSync(OUT, { recursive: true });
const esc = (v) => `"${String(Array.isArray(v) ? v.join(" / ") : v ?? "").replace(/"/g, '""')}"`;
const labels = { RP: "RP_事業所の行を置き換える", P1: "P1_品目を足す", P2: "P2_同じ_何もしない", P3: "P3_事業所の価格の行を作る", J: "J_判断が要る", G: "G_古い世代の候補 (ケアサポ)", A: "A_本数違い_正しいコード", hist: "H_古い価格を履歴に" };
console.log(`事業所 ${FO.area} ${FO.bn} / FYGMST01 ${files.join(" / ")} / 使用中の TAIS ${[...byTais.values()].filter((rs) => rs.some((r) => !r.stop)).length}`);
console.log(`控え ${snap.fetchedAt} / 事業所の行の valid_from ${VALID_FROM} / 比べる月 ${vfYm}〜${MONTH}${IS_CARESAPO ? " / 今の価格 = 中止=0 で ● の無い行 (複数なら ID 最大)" : " / 今の価格 = 中止=0 の行で 記号 ★ > ☆ > ◇ > ◎▲ > 無印 (同じ記号なら ID 最大)"}  ※ 提供票 ${TDIR ? TDIR.split(/[\\/]/).pop() : "★ 無い"}\n`);
for (const k of ["P1", "P2", "P3", "RP", "J", "G", "A", "hist"]) {
  const xs = R[k];
  console.log(`  ${labels[k].padEnd(28)} ${String(xs.length).padStart(5)}`);
  for (const x of k === "P2" ? [] : xs.slice(0, Number(process.env.SHOW ?? 3))) console.log(`      - ${JSON.stringify({ ...x, timeline: undefined, 消す: undefined, 足す: undefined }).slice(0, 260)}`);
  if (!xs.length || k === "P2") continue;
  const cols = [...new Set(xs.flatMap((x) => Object.keys(x)))].filter((c) => !["timeline", "消す", "足す"].includes(c)); // 理由ごとに列が違う (J) ので全部の列
  writeFileSync(join(OUT, `${FO.area}_${labels[k]}.csv`), "﻿" + [cols.map(esc).join(","), ...xs.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n"));
}
if (!IS_CARESAPO) {
  const jWhy = {};
  for (const x of R.J) { const k = x.理由.replace(/\d+/g, "N").replace(/\(.*?\)/g, "").slice(0, 40); jWhy[k] = (jWhy[k] ?? 0) + 1; }
  console.log(`\n  J の理由: ${JSON.stringify(jWhy, null, 1)}`);
  console.log(`  記号と ID 最大が違う価格 (記号の順で決めた): ${R.symVsId.length}`);
  console.log(`  今の行より安い使用中の行がある (値上げ・記号と ID は一致): ${R.raise.length}`);
  for (const x of R.raise.slice(0, Number(process.env.SHOW_DIFF ?? 5))) console.log(`      - ${JSON.stringify(x)}`);
  console.log(`  提供票で使われていない 別価格の行がある TAIS: ${R.unused.length} (履歴にしない)`);
}
console.log(`\n  P3 の内訳: 事業所の方が高い ${R.P3.filter((x) => x.差 > 0).length} / 安い ${R.P3.filter((x) => x.差 < 0).length} / 今は同じ (履歴だけ違う) ${R.P3.filter((x) => x.差 === 0).length}`);
console.log(`★ ${vfYm}〜${MONTH} に ${FO.area} の注文で貸与していた明細が使っていた品目 ${hitCodes.size} (明細 ${hit.length} 本) は J に回した → 請求額が変わる明細は 0 本`);
console.log(`\n書込みの見込み (承認後): equipment_master insert ${plan.equipment.length} 品目 / equipment_price_history insert ${plan.prices.length} 行 (office_id=${FO.area})${plan.deletes.length ? ` / 事業所の行を消す ${plan.deletes.length} 行 (--replace-tais)` : ""}。J・G は書かない`);
console.log(`  → 本番: --live --execute --expect ${plan.equipment.length},${plan.prices.length}${plan.deletes.length ? `,${plan.deletes.length}` : ""}${REPLACE.size ? ` --replace-tais ${[...REPLACE].join(",")}` : ""}`);
console.log(`→ CSV: ${OUT}`);

if (!EXECUTE) { console.log("DRY RUN — DB は書き換えていない"); process.exit(0); }

// ── 本番書込み ──────────────────────────────────────────────────────────────
const [xEq, xPr, xDel = 0] = opt("--expect").split(",").map(Number);
if (xEq !== plan.equipment.length || xPr !== plan.prices.length || xDel !== plan.deletes.length) { console.error(`★ 書込み ${plan.equipment.length},${plan.prices.length},${plan.deletes.length} が --expect ${xEq},${xPr},${xDel} と違う。止める (DRY RUN をやり直して確かめる)`); process.exit(2); }
// 重複の確認 (計画の中)
for (const [k, xs] of [["品目", plan.equipment], ["価格の行", plan.prices]]) {
  const keys = xs.map((x) => x.key);
  if (new Set(keys).size !== keys.length) { console.error(`★ 計画の ${k} に同じキーが 2 つ以上`); process.exit(2); }
}
for (const t of ["data_import_batches", "data_import_rows"]) {
  const { error } = await sb.from(t).select("id").limit(1);
  if (error) { console.error(`★ 出どころ記録の表 ${t} を読めない (${error.message})`); process.exit(2); }
}
const d = new Date();
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}-${String(d.getMilliseconds()).padStart(3, "0")}`;
const bpath = join(HERE, `_backup_office_prices_${FO.area}_${stamp}.json`);
writeFileSync(bpath, JSON.stringify({ taken_at: d.toISOString(), office: FO, valid_from: VALID_FROM, month: MONTH, fetchedAt: snap.fetchedAt, plan }, null, 2) + "\n");
console.log(`\n退避 (書込みの計画): ${bpath}`);
const batch = await execLockAcquire(sb, EXEC_LOCK, {
  tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: files.map((f) => `伝送データ/${FO.area}/福祉用具/マスタ/${f}`), script: SCRIPT_REL, args: argv.join(" "), step: STEP,
  notes: `${FO.area} の事業所の価格を FYGMST01 から: 品目 ${plan.equipment.length} / 価格の行 ${plan.prices.length} / 消す事業所の行 ${plan.deletes.length} (valid_from ${VALID_FROM}${REPLACE.size ? ` / 置き換え ${[...REPLACE].join(",")}` : ""})`,
});
const BATCH = batch.id;
console.log(`batch ${BATCH}`);
const fail = async (msg) => {
  const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
  if (error) console.error(`batch を failed にできない: ${error.message}`);
  console.error(`★ ${msg}\n  ここまでの書込みは data_import_rows に記録済み → --revert ${BATCH} で戻せる`);
  process.exit(1);
};
const record = async (r) => { const { error } = await sb.from("data_import_rows").insert(r); if (error) await fail(`data_import_rows: ${error.message}`); };
let nEq = 0, nPr = 0;
for (const x of plan.equipment) {
  const { data: ex, error: e0 } = await sb.from("equipment_master").select("id").eq("tenant_id", TENANT).or(`product_code.eq.${x.row.product_code},tais_code.eq.${x.row.tais_code}`);
  if (e0) await fail(`equipment_master を読めない: ${e0.message}`);
  if (ex.length) await fail(`${x.row.product_code}: 用具マスタに既にある (${ex.length} 行)。計画が古い`);
  const { data, error } = await sb.from("equipment_master").insert(x.row).select("id");
  if (error) await fail(`insert equipment_master ${x.row.product_code}: ${error.message}`);
  if (data?.length !== 1) await fail(`insert equipment_master ${x.row.product_code}: 返った行数 ${data?.length}`);
  await record({ batch_id: BATCH, tenant_id: TENANT, table_name: "equipment_master", row_id: data[0].id, op: "insert", source_key: x.key, source_ref: x.ref, before: null, after: x.row });
  nEq++;
}
let nDel = 0;
for (const x of plan.deletes) {
  // 消す前の行が DRY RUN のときと同じ (id・価格・事業所・適用開始) ことを条件に 1 行ずつ消し、件数 1 を確かめる
  const { data, error } = await sb.from("equipment_price_history").delete().eq("id", x.row.id).eq("tenant_id", TENANT).eq("office_id", FO.officeId).eq("product_code", x.row.product_code).eq("valid_from", x.row.valid_from).eq("rental_price", x.row.rental_price).select("id");
  if (error) await fail(`delete equipment_price_history ${x.row.product_code} ${x.row.valid_from}: ${error.message}`);
  if (data?.length !== 1) await fail(`delete equipment_price_history ${x.row.product_code} ${x.row.valid_from}: 消した行数 ${data?.length} (DRY RUN の後に変わった)`);
  await record({ batch_id: BATCH, tenant_id: TENANT, table_name: "equipment_price_history", row_id: x.row.id, op: "delete", source_key: x.key, source_ref: x.ref, before: x.row, after: null });
  nDel++;
}
for (const x of plan.prices) {
  const { data: ex, error: e0 } = await sb.from("equipment_price_history").select("id,rental_price").eq("tenant_id", TENANT).eq("product_code", x.row.product_code).eq("office_id", x.row.office_id).eq("valid_from", x.row.valid_from);
  if (e0) await fail(`equipment_price_history を読めない: ${e0.message}`);
  if (ex.length) await fail(`${x.row.product_code} ${x.row.valid_from}: 事業所の行が既にある (${ex.map((r) => r.rental_price).join(",")})。計画が古い`);
  const { data, error } = await sb.from("equipment_price_history").insert(x.row).select("id");
  if (error) await fail(`insert equipment_price_history ${x.row.product_code} ${x.row.valid_from}: ${error.message}`);
  if (data?.length !== 1) await fail(`insert equipment_price_history ${x.row.product_code}: 返った行数 ${data?.length}`);
  await record({ batch_id: BATCH, tenant_id: TENANT, table_name: "equipment_price_history", row_id: data[0].id, op: "insert", source_key: x.key, source_ref: x.ref, before: null, after: x.row });
  nPr++;
}
const { error: eDone } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
if (eDone) await fail(`batch を executed にできない: ${eDone.message}`);
console.log(`\n完了: 品目 ${nEq} / 価格の行 ${nPr} / 消した事業所の行 ${nDel}。batch ${BATCH}。確認: --live の DRY RUN で 書込みの見込みが 0,0 になること。取り消しは --revert ${BATCH}`);
