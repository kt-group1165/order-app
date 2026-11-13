/**
 * 事業所ごとの用具の価格を ほのぼのの用具マスタ (FYGMST01) から作る案 — ★ DRY RUN 専用 (DB は読まない・書かない)
 * (2026-11-13 user 決定: (a) 価格は事業所ごとに履歴付きで持つ / (b) 新システムの用具マスタに無い品目は足してよい)
 *
 *   node migrations/import_office_prices_from_fygmst.mjs --area 誉田 --db-cache <rebuild の控え json> [--valid-from 2026-04-01] [--month 2026-11] [--out <dir>]
 *
 * 前提: equipment_price_history.office_id (migrations/equipment_price_history_office_id.sql) と、
 *   価格の決め方 = その事業所の行 → 共通の行 → equipment_master.rental_price (lib/equipment.ts getPriceForMonth)
 *
 * 作る案 (TAIS ごと。FYGMST01 の介護・予防。自費は TAIS が無いので外す):
 *   「今の価格」= その TAIS の 使用中 (中止=0) の行のうち
 *       ケアサポ: 名前が「●」で始まらない行 (● = 古い世代)。複数なら ID が最大の行
 *       それ以外 (誉田 等): 記号 (略称・商品名称の先頭) の優先 ★ > ☆ > (◎・◇・▲) > 無印。同じ記号なら ID が最大の行
 *         (2026-11-13 誉田の提供票 R8/5〜10 の新規開始で確認: 価格が複数ある品目の新規は ☆ 176 / 無印 64 (☆ の無い品目) / ★ 2 / ◎◇ 3。
 *          ★ は ☆ より新しく安い世代)。◎・◇・▲ や無印の古い価格は G (古い世代の品目の候補) に出る
 *   P1 用具マスタに無い TAIS → equipment_master に品目を足す (product_code = TAIS・rental_price = 今の価格)。事業所の行は作らない (共通 = その価格)
 *   P2 用具マスタにあり、共通の価格 (--valid-from の月初・今月 の両方) が今の価格と同じ → 何もしない
 *   P3 用具マスタにあり、共通の価格と違う → equipment_price_history に office_id = その事業所・valid_from = --valid-from の行 (その TAIS の品目コードごと)
 *      ★ ケアサポは作らない (2026-11-13 決定。共通の価格 = ケアサポの請求価格なので二重に持たせない) → J に出すだけ
 *   J  判断が要る (書かない): 用具マスタの同じ TAIS に価格の違う品目が複数 (世代が分かれている) / 共通の価格が無い
 *   G  使用中の価格が 2 通り以上ある TAIS は、今の価格のほかの価格を「古い世代の品目が要る候補」として出す
 *      (① の方針: 古い世代は別の product_code の品目にして、その価格で借りている明細をそちらに付ける。品目の作成・付け替えは別の手順)
 * ★ 影響: その事業所の注文で --valid-from 〜 --month に貸与していた明細が使っている品目は、事業所の行を作らず J に回す
 *   (過去の月を含め 今の請求額を変えない)
 * ★ --execute は未実装。件数を user が確認してから 書込み (data_import_batches / data_import_rows の作法) を足す。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFukuyoguOffice, latestTeikyoDir } from "./_fukuyogu_office.mjs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (argv.includes("--execute")) { console.error("★ --execute は未実装 (DRY RUN 専用)。件数を user が確認してから書込みを足す"); process.exit(1); }
const CACHE = opt("--db-cache");
if (!CACHE) { console.error("usage: node migrations/import_office_prices_from_fygmst.mjs --area 誉田 --db-cache <json> [--valid-from 2026-04-01] [--month 2026-11]"); process.exit(1); }
const FO = resolveFukuyoguOffice(argv);
const VALID_FROM = opt("--valid-from") ?? "2026-04-01";
const MONTH = opt("--month") ?? new Date().toISOString().slice(0, 7);
const OUT = opt("--out") ?? join(tmpdir(), "office-prices-from-fygmst");
const IS_CARESAPO = FO.bn === "1272400050";
const nf = (s) => String(s ?? "").normalize("NFKC").trim();
const nTais = (s) => nf(s).toUpperCase().replace(/[‐－―ー–?]/g, "-");
const isTais = (t) => /^\d{5}-[0-9A-Z]{6}$/.test(t);

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
    out.push({ id: Number(r[H.ID]), stop: r[H.中止] === "1", cat: nf(r[H.福祉用具種目]).replace(/^予防/, ""), name: nf(r[H.商品名称]), abbr: nf(r[H.略称]), tais, units: Number(r[H.単位数]) });
  }
  return out;
}

const mdir = join(FO.dir, "マスタ");
if (!existsSync(mdir)) { console.log(`未着: ${mdir} が無い`); process.exit(0); }
const files = readdirSync(mdir).filter((f) => /^FYGMST.*\.csv$/i.test(f) && !/自費/.test(f));
const byTais = new Map();
for (const f of files) for (const r of readMaster(join(mdir, f))) { if (!byTais.has(r.tais)) byTais.set(r.tais, []); byTais.get(r.tais).push(r); }

// ★ 2026-11-13: 提供票 (入力側) で 実際に使われている行を優先する (誉田の ◎ と 無印 で、無印は ID が新しいのに ほぼ使われていなかった)
//   提供票の実績行の「(略称)」と 月額の単位数 (全額 = 概算単位・半額 = ×2) で FYGMST01 の行に当てる
//   use = 実績行の数 / fresh = 新しく始まった (利用者, 行) の数 (提供票の最初の月より後に初めて出たもの)
const useOf = new Map(), freshOf = new Map();
const spanOf = new Map(); // 利用者|略称|単位 → { min, max } (提供年月)
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
      const k = `${nf(m[1])}|${full}`;
      useOf.set(k, (useOf.get(k) ?? 0) + 1);
      const pk = `${nf(r[c.利用者番号])}|${k}`, ym = nf(r[c.提供年月]);
      if (!firstSeen.has(pk) || firstSeen.get(pk) > ym) firstSeen.set(pk, ym);
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

// ★ 2026-11-13 user 判断: 1 TAIS = 1 品目。本数違い (KS-161Q 1本) は 別の届出コード (00170-Z00019) が正しい。
//   正しいコードは もう一方の事業所の FYGMST01 で 同じ略称 (記号・予 を除く)・同じ単位数 の行の TAIS から引く (ケアサポのマスタは 1 本を Z コードで持っていた)
const coreAbbr = (a) => nf(a).replace(/^[予★☆◎◇▲●]+/, "").replace(/[\s　]/g, "");
const otherCode = new Map(); // coreAbbr|単位 → Set<TAIS>
const OTHER_AREA = IS_CARESAPO ? "誉田" : "ケアサポ";
{
  const odir = join(resolveFukuyoguOffice(["--area", OTHER_AREA]).dir, "マスタ");
  if (existsSync(odir)) for (const f of readdirSync(odir).filter((x) => /^FYGMST.*\.csv$/i.test(x) && !/自費/.test(x))) {
    for (const r of readMaster(join(odir, f))) { const k = `${coreAbbr(r.abbr || r.name)}|${r.units}`; if (!otherCode.has(k)) otherCode.set(k, new Set()); otherCode.get(k).add(r.tais); }
  }
}
const qtyOf = (r) => { const m = (r.abbr || r.name).match(/(\d+)\s*(本|枚|セット|個|組|台)/); return m ? `${m[1]}${m[2]}` : null; };

const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const hist = snap.priceHist ?? [];
const commonPrice = (e, ym) => {
  const hs = hist.filter((h) => h.product_code === e.product_code && !h.office_id && h.valid_from <= `${ym}-01`).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
  return hs[0]?.rental_price ?? e.rental_price ?? null;
};
const eqByTais = new Map();
for (const e of snap.equipment ?? []) for (const t of new Set([nTais(e.tais_code), nTais(e.product_code)])) { if (!isTais(t)) continue; if (!eqByTais.has(t)) eqByTais.set(t, []); if (!eqByTais.get(t).includes(e)) eqByTais.get(t).push(e); }
const vfYm = VALID_FROM.slice(0, 7);

const R = { P1: [], P2: [], P3: [], J: [], G: [], A: [], B: [], C: [], diffFromIdMax: [], diffFromSym: [], unused: [] };
/** 誉田の世代の記号 (略称 → 商品名称 の先頭)。★ = 最新・最安 / ☆ = その前 / ◎◇▲ = ☆ より前 / 無印 = 古いか 世代の分かれていない品目 */
const genMark = (r) => ((r.abbr || r.name).match(/^[★☆◎◇▲●]/) ?? r.name.match(/^[★☆◎◇▲●]/) ?? [""])[0];
const genRank = (r) => ({ "★": 4, "☆": 3, "◎": 2, "◇": 2, "▲": 2 })[genMark(r)] ?? 1;
for (const [tais, rows] of byTais) {
  const act = rows.filter((r) => !r.stop);
  if (!act.length) continue; // 中止だけの品目は作らない
  // (a) 本数違いで 別の届出コードが正しい行 (もう一方の事業所のマスタで 同じ略称・単位が 別の TAIS) → この TAIS の価格から外す
  const wrongCode = new Map();
  for (const r of act) {
    if (!qtyOf(r)) continue;
    const cands = [...(otherCode.get(`${coreAbbr(r.abbr || r.name)}|${r.units}`) ?? [])].filter((t) => t !== tais);
    if (cands.length === 1) wrongCode.set(r, cands[0]);
  }
  const actOk = act.filter((r) => !wrongCode.has(r));
  const curCands = IS_CARESAPO ? actOk.filter((r) => !r.name.startsWith("●")) : actOk;
  const poolBase = curCands.length ? curCands : actOk.length ? actOk : act;
  const pick = (rs) => rs.reduce((a, b) => (genRank(b) > genRank(a) || (genRank(b) === genRank(a) && b.id > a.id) ? b : a));
  const byId = poolBase.reduce((a, b) => (b.id > a.id ? b : a));
  // ケアサポ: ● の無い行の ID 最大 / それ以外 (誉田): 提供票で 新しく使われている行 → 使われている行 → 全部 の順に絞り、その中で 記号の優先・同じ記号なら ID 最大
  const freshRows = poolBase.filter((r) => freshOfRow(r) > 0), usedRows = poolBase.filter((r) => usedOf(r) > 0);
  const pool = IS_CARESAPO ? poolBase : freshRows.length ? freshRows : usedRows.length ? usedRows : poolBase;
  const cur = IS_CARESAPO ? byId : pick(pool);
  const curSym = IS_CARESAPO ? byId : pick(poolBase); // 記号だけで選んだ行 (提供票を見ない)
  if (!IS_CARESAPO && cur !== byId) R.diffFromIdMax.push({ TAIS: tais, 記号で選んだ行: `${cur.id} ${cur.abbr || cur.name} ${cur.units * 10}円`, ID最大の行: `${byId.id} ${byId.abbr || byId.name} ${byId.units * 10}円`, 価格が違う: cur.units !== byId.units });
  if (!IS_CARESAPO && cur !== curSym) R.diffFromSym.push({ TAIS: tais, 提供票で選んだ行: `${cur.id} ${cur.abbr || cur.name} ${cur.units * 10}円 (新規 ${freshOfRow(cur)}・実績 ${usedOf(cur)})`, 記号だけで選んだ行: `${curSym.id} ${curSym.abbr || curSym.name} ${curSym.units * 10}円 (新規 ${freshOfRow(curSym)}・実績 ${usedOf(curSym)})`, 価格が違う: cur.units !== curSym.units });
  const price = cur.units * 10;
  // (a) 本数違い → 正しいコード
  for (const [r, t] of wrongCode) R.A.push({ TAIS: tais, 行: `${r.id}:${r.abbr || r.name}:${r.units * 10}円 (実績 ${usedOf(r)})`, 正しいコード: t, 根拠: `${OTHER_AREA} の FYGMST01 で 同じ略称・単位数が ${t}` });
  // 使われていない行は数えるだけ (品目は P1 で足すが 価格は作らない)
  const unusedRows = IS_CARESAPO ? [] : actOk.filter((r) => r !== cur && usedOf(r) === 0);
  if (unusedRows.length) R.unused.push({ TAIS: tais, 行: unusedRows.map((r) => `${r.id}:${r.abbr || r.name}:${r.units * 10}円`).join(" ") });
  // 今の価格と違う 使われている行 → (b) 古い価格 (履歴) か (c) user 確認
  const otherRows = (IS_CARESAPO ? actOk.filter((r) => r.units !== cur.units) : actOk.filter((r) => r.units !== cur.units && usedOf(r) > 0));
  for (const u of [...new Set(otherRows.map((r) => r.units))]) {
    const rs = otherRows.filter((r) => r.units === u);
    const base = { TAIS: tais, 名前: cur.abbr || cur.name, 今の価格: price, 今の行: `${cur.id}:${cur.abbr || cur.name}`, ほかの価格: u * 10, ほかの行: rs.map((r) => `${r.id}:${r.abbr || r.name}(新${freshOfRow(r)}/実${usedOf(r)})`).join(" ") };
    if (IS_CARESAPO) { R.G.push(base); continue; } // ケアサポは 今までどおり 候補として出すだけ
    const qr = rs.find((r) => qtyOf(r) && qtyOf(r) !== qtyOf(cur));
    if (qr) { R.C.push({ ...base, 理由: `本数・セットの違い (${qtyOf(qr)}) だが 正しいコードが見つからない` }); continue; }
    // 古い価格の行を使った人が 全員 あとで今の価格の行に付け替わっている → 改定 (履歴)
    const curUsers = usersOfRow(cur);
    const oldUsers = new Map(rs.flatMap((r) => [...usersOfRow(r)]));
    const switched = [...oldUsers].every(([n, sp]) => curUsers.has(n) && curUsers.get(n).min > sp.max);
    const fresh = rs.reduce((a, r) => a + freshOfRow(r), 0);
    const lastOld = [...oldUsers.values()].map((sp) => sp.max).sort().pop() ?? "-";
    if (oldUsers.size && switched) R.B.push({ ...base, 理由: `古い価格を使った ${oldUsers.size} 名が 全員 あとで今の価格に付け替わっている (改定)`, 最後に使った月: lastOld });
    else if (fresh === 0) R.B.push({ ...base, 理由: `新規に使われていない (今借りている人 ${[...oldUsers.values()].filter((sp) => sp.max === lastOld).length} 名は 古い価格のまま)`, 最後に使った月: lastOld });
    else R.C.push({ ...base, 理由: `古い価格の行でも 新規が ${fresh} 件ある (古い行で登録した可能性・または別の品目)`, 最後に使った月: lastOld });
  }
  const eqs = eqByTais.get(tais) ?? [];
  if (!eqs.length) { R.P1.push({ TAIS: tais, 名前: cur.abbr || cur.name, 種目: cur.cat, 価格: price }); continue; }
  const cps = [...new Set(eqs.map((e) => `${commonPrice(e, vfYm)}|${commonPrice(e, MONTH)}`))];
  if (cps.length > 1) { R.J.push({ TAIS: tais, 名前: cur.abbr || cur.name, 理由: "用具マスタの同じ TAIS に 価格の違う品目が複数 (世代が分かれている)", 品目: eqs.map((e) => `${e.product_code}=${commonPrice(e, MONTH)}`).join(" / "), 今の価格: price }); continue; }
  const [p0, p1] = cps[0].split("|").map((x) => (x === "null" ? null : Number(x)));
  if (p0 == null && p1 == null) { R.J.push({ TAIS: tais, 名前: cur.abbr || cur.name, 理由: "共通の価格が無い", 品目: eqs.map((e) => e.product_code).join(" / "), 今の価格: price }); continue; }
  if (p0 === price && p1 === price) { R.P2.push({ TAIS: tais }); continue; }
  // ★ ケアサポは 事業所の行を作らない (2026-11-13 決定: 共通の価格 = ケアサポで実際に請求してきた価格。二重に持たせない)
  if (IS_CARESAPO) { R.J.push({ TAIS: tais, 名前: cur.abbr || cur.name, 理由: "ケアサポは 事業所の行を作らない (共通の価格がケアサポの請求価格)。FYGMST01 の今の価格と共通の価格が違う", 品目: eqs.map((e) => e.product_code).join(" / "), 今の価格: price }); continue; }
  R.P3.push({ TAIS: tais, 名前: cur.abbr || cur.name, 品目コード: eqs.map((e) => e.product_code), 共通の価格: `${p0}→${p1}`, 事業所の価格: price, 差: price - (p1 ?? p0) });
}

// 影響: この事業所の注文で 今月 貸与中の明細が P3 の品目コードを使っているか
const orders = new Map((snap.orders ?? []).map((o) => [o.id, o]));
const p3codes = new Map(R.P3.flatMap((x) => x.品目コード.map((c) => [c, x])));
// 影響を見る期間 = 事業所の行の valid_from 〜 --month の末 (過去の月の請求・再請求も変えない)
const ms = VALID_FROM, me = `${MONTH}-31`;
const hit = (snap.items ?? []).filter((it) => {
  const o = orders.get(it.order_id);
  if (!o || o.office_id !== FO.officeId || !p3codes.has(it.product_code)) return false;
  if (!["rental_started", "terminated"].includes(it.status) || it.cancelled_at) return false;
  return (it.rental_start_date ?? "9") <= me && (!it.rental_end_date || it.rental_end_date >= ms);
});
// ★ 今月 その事業所で貸与中の明細が使っている品目は 事業所の行を作らない (今の請求額を変えない)。判断が要るに回す
//   (ケアサポは 共通の価格 = ケアサポで実際に請求している価格。FYGMST01 の「今の価格」は 新しい世代の価格で、今の明細の価格ではない)
const hitCodes = new Set(hit.map((i) => i.product_code));
for (const x of [...R.P3]) {
  const used = x.品目コード.filter((c) => hitCodes.has(c));
  if (!used.length) continue;
  R.P3.splice(R.P3.indexOf(x), 1);
  R.J.push({ TAIS: x.TAIS, 名前: x.名前, 理由: `${VALID_FROM.slice(0, 7)}〜${MONTH} に 貸与していた明細 ${hit.filter((i) => used.includes(i.product_code)).length} 本が 共通の価格 (${x.共通の価格}) で請求されている → 事業所の行を作ると請求額が変わる (古い世代の品目にするかの判断が要る)`, 品目: used.join(" / "), 今の価格: x.事業所の価格 });
}

mkdirSync(OUT, { recursive: true });
const esc = (v) => `"${String(Array.isArray(v) ? v.join(" / ") : v ?? "").replace(/"/g, '""')}"`;
const label = { P1: "P1_品目を足す", P2: "P2_同じ_何もしない", P3: "P3_事業所の価格の行を作る", J: "J_判断が要る", G: "G_古い世代の候補 (ケアサポ)", A: "A_本数違い_正しいコードへ", B: "B_古い価格_履歴へ", C: "C_user確認" };
console.log(`事業所 ${FO.area} ${FO.bn} / FYGMST01 ${files.join(" / ")} / 使用中の TAIS ${[...byTais.values()].filter((rs) => rs.some((r) => !r.stop)).length}`);
console.log(`控え ${snap.fetchedAt} / 事業所の行の valid_from ${VALID_FROM} / 影響を見る月 ${MONTH}${IS_CARESAPO ? " / 今の価格 = 中止=0 で ● の無い行 (複数なら ID 最大)" : " / 今の価格 = 中止=0 の行で 記号 ★ > ☆ > ◎◇▲ > 無印 (同じ記号なら ID 最大)"}\n`);
for (const k of ["P1", "P2", "P3", "J", "G", "A", "B", "C"]) {
  const xs = R[k];
  console.log(`  ${label[k].padEnd(28)} ${String(xs.length).padStart(5)}`);
  for (const x of k === "P2" ? [] : xs.slice(0, Number(process.env.SHOW ?? 3))) console.log(`      - ${JSON.stringify(x).slice(0, 240)}`);
  if (!xs.length || k === "P2") continue;
  const cols = Object.keys(xs[0]);
  writeFileSync(join(OUT, `${FO.area}_${label[k]}.csv`), "﻿" + [cols.map(esc).join(","), ...xs.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n"));
}
const p3rows = R.P3.reduce((s, x) => s + x.品目コード.length, 0);
if (!IS_CARESAPO) {
  console.log(`\n  記号の優先で選んだ行が ID 最大の行と違う TAIS: ${R.diffFromIdMax.length} (うち価格も違う ${R.diffFromIdMax.filter((x) => x.価格が違う).length})`);
  for (const x of R.diffFromIdMax.slice(0, Number(process.env.SHOW_DIFF ?? 10))) console.log(`      - ${JSON.stringify(x)}`);
  console.log(`  提供票の使用で選んだ行が 記号だけで選んだ行と違う TAIS: ${R.diffFromSym.length} (うち価格も違う ${R.diffFromSym.filter((x) => x.価格が違う).length})  ※ 提供票 ${TDIR ? TDIR.split(/[\\/]/).pop() : "★ 無い"}`);
  for (const x of R.diffFromSym.slice(0, Number(process.env.SHOW_DIFF ?? 10))) console.log(`      - ${JSON.stringify(x)}`);
  console.log(`  提供票で使われていない行がある TAIS: ${R.unused.length} (行 ${R.unused.reduce((s, x) => s + x.行.split(" ").length, 0)}。古い世代の候補にしない・価格の行は作らない)`);
}
console.log(`\n  P3 の内訳: 事業所の方が高い ${R.P3.filter((x) => x.差 > 0).length} / 安い ${R.P3.filter((x) => x.差 < 0).length}`);
console.log(`★ ${VALID_FROM.slice(0, 7)}〜${MONTH} に ${FO.area} の注文で貸与していた明細が使っていた品目 ${hitCodes.size} (明細 ${hit.length} 本) は P3 から外して J に回した → P3 で請求額が変わる明細は 0 本`);
console.log(`\n書込みの見込み (承認後): equipment_master insert ${R.P1.length} 品目 / equipment_price_history insert ${p3rows} 行 (office_id=${FO.area}・valid_from ${VALID_FROM})。J・G は書かない`);
console.log(`→ CSV: ${OUT}`);
console.log("DRY RUN — DB は読んでいない・書き換えていない (--execute は未実装)");
