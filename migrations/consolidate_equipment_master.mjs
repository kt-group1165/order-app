/**
 * 用具マスタ (equipment_master) の 同じ TAIS の重複を 1 TAIS = 1 商品 にまとめる (2026-11-09 / FY-M)
 *
 *   node migrations/consolidate_equipment_master.mjs                          # DRY RUN (既定)
 *   node migrations/consolidate_equipment_master.mjs --with-category          # DRY RUN (B: 種目名の是正も含める)
 *   node migrations/consolidate_equipment_master.mjs --execute [--with-category]   # 本番 (★ user 承認後)
 *   node migrations/consolidate_equipment_master.mjs --revert <batch_id> [--execute]
 *
 * 何をするか (user 合意 2026-11-09):
 *   A  KDS0031 (全月) に出る TAIS のうち equipment_master に複数行あるものを 1 行にまとめる。
 *      残す行 = product_code = TAIS の行 (請求の単価引きは product_code)。無ければ参照の多い行の product_code を TAIS に直す。
 *      単位数 = KDS0031 の当月 (月を通した行) の実請求。当月が無ければ他月 → FYGMST01 の使用中 (中止=0) 行。
 *      決まらないもの (KDS 当月に単位数が複数 / FYGMST01 も複数 / 種目が食い違う / 1 行が 2 つの TAIS にまたがる) は
 *      ★ 自動で統合せず「判断が要る」一覧に出す。
 *      付け替え: order_items.product_code / order_items.tokka_bill_product_code / equipment_prices / equipment_office_prices /
 *               equipment_set_items (set/component) / monitoring_items / equipment_master.comparison_product_codes
 *      余りの行と、その行の価格履歴 (equipment_price_history) は ★ 削除 (equipment_master に無効フラグの列が無い。
 *      残すと 画面の一覧・音声発注の名前照合・BillingTab の find(先頭一致) で再び拾われる)。消した行は data_import_rows.before に全列。
 *      付け替えない (履歴・控えなので当時の値のまま): equipment_change_log / equipment_master_history / care_plan_elements.detail
 *   C  equipment_master に無い TAIS を FYGMST01 の商品名・種目で追加 / product_code = TAIS の行が無い (tais_code だけ一致) ものを是正 (= A と同じ扱い)
 *   B  種目名 (category) が「予歩行器」等でサービスコードが引けない行の一覧と是正案。★ 書込みは --with-category のときだけ
 *      (A で残す行の種目が引けないときは、統合で請求が落ちないよう A の一部として直す)
 *
 * 請求に効くか: 2026-09 (KDS0031 の最頻の提供月) の請求モデル (scripts/_honobono-sync-core の buildBillingModel = BillingTab と同じ) を
 *   統合前後で組み、単価・サービスコード・請求に乗るかが変わる明細と利用者を数える。
 *   さらに scripts/honobono-sync-diff.mts を 統合前 / 統合後 のスナップショットで回し、KDS0031 との「合計一致」人数を比べる。
 *
 * 書込みの作法 (--execute): sync_fukuyogu_from_honobono.mjs と同じ。
 *   ・DB は必ず読み直して計画を作り直す (DRY RUN のキャッシュは使わない)
 *   ・最初に data_import_batches (step='consolidate-equipment') を作り、各 insert/update/delete の直後に data_import_rows を書く。書けなければ止める
 *   ・update/delete は .eq(id).eq(tenant_id) で件数 1 を確認
 *   ・order_items の product_code だけの更新は doc_tasks / care_plan_elements の trigger を発火させない (status 遷移時のみ) が、
 *     念のため実行前後の件数を比べて出す
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
const { C, TENANT, PROVIDER_BN, readKds0031, loadSnapshot, loadLibs, readEnv, buildBillingModel, parseCsvLine, nfkc, toInt, ymOf, daysIn } = core;

// ── 引数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const WITH_CATEGORY = argv.includes("--with-category");
const DENSOU = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const REPO_ROOT = resolve(HERE, "../../..");
const CSV_PATH = resolve(opt("--csv") ?? join(DENSOU, "202609/ほのぼのから/KDS0031_明細書明細付_処理R8-09.CSV"));
const MASTER_CSV = resolve(opt("--master-csv") ?? join(DENSOU, "マスタ/FYGMST01_用具マスタ_20261109.CSV"));
const OUT_TXT = opt("--out") ? resolve(opt("--out")) : null;
const SCRIPT_REL = "apps/order-app/migrations/consolidate_equipment_master.mjs";
let EXEC_LOCK = null; // 同じ script の同時 --execute を止める (_exec_lock.mjs)。--execute の最初に execLockStart で取る
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "consolidate-equipment";
const TAIS_RE = /^\d{5}-[0-9A-Z]{6}$/; // 00170-Z00019 のような Z 付きも TAIS として扱う

// 出力は画面と --out の両方へ
const outLines = [];
const log = (...a) => { const s = a.join(" "); outLines.push(s); console.log(s); };

// ── 小道具 ────────────────────────────────────────────────────────────────
const clone = (x) => JSON.parse(JSON.stringify(x));
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const relPath = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const mode = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
let seq = 0;
const newId = (kind) => `new:${kind}:${++seq}`;
/** 種目名の揺れ (先頭の「予」・略称) を正しい名前に寄せる。表に無い名前はそのまま返す */
const CAT_ALIAS = { 車いす付: "車いす付属品", 特寝台付: "特殊寝台付属品", 特殊寝台付: "特殊寝台付属品", 床ずれ防: "床ずれ防止用具", 歩行補助杖: "歩行補助つえ", 体位変換: "体位変換器" };
const stripYobo = (c) => { const s = nfkc(c).replace(/^予防/, "").replace(/^予/, ""); return CAT_ALIAS[s] ?? s; };

class Report {
  constructor() { this.m = new Map(); }
  add(cat, ex) { if (!this.m.has(cat)) this.m.set(cat, []); this.m.get(cat).push(ex); }
  count(cat) { return this.m.get(cat)?.length ?? 0; }
  print(n = 5) {
    for (const [k, v] of this.m) {
      log(`  ${String(v.length).padStart(5)}  ${k}`);
      for (const e of v.slice(0, n)) log(`         - ${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
  }
  toJSON() { return Object.fromEntries([...this.m].map(([k, v]) => [k, { count: v.length, items: v }])); }
}

async function makeSb() {
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
async function selectAll(sb, table, select, build = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function selectIn(sb, table, select, col, ids) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll(sb, table, select, (q) => q.in(col, c)));
  return out;
}
async function provenanceReady(sb) {
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) return { ok: false, why: `${t}: ${error.message}` };
  }
  return { ok: true };
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  if (REVERT) return revert(REVERT);
  const libs = await loadLibs();
  const { fukuyoguServiceCode, FUKUYOGU_SERVICE_CODES, getPriceForMonth } = libs;
  /** サービス項目コード下 4 桁 → 正しい種目名 (表の最初の名前) */
  const catOfItem = new Map();
  for (const [k, v] of Object.entries(FUKUYOGU_SERVICE_CODES)) if (!catOfItem.has(v.slice(2))) catOfItem.set(v.slice(2), k);
  const itemOfCat = (cat) => { const c = fukuyoguServiceCode(cat); return c ? c.slice(2) : null; };

  // ── KDS0031 (全月) ─────────────────────────────────────────────────
  const { rows, monthCount } = readKds0031(CSV_PATH);
  const MONTH = opt("--month") ?? mode(monthCount);
  const monthStartS = `${MONTH}-01`;
  log(`${EXECUTE ? "★★ EXECUTE (本番書込み)" : "DRY RUN (DB は書き換えない)"} / 提供月 ${MONTH} / B (種目名) の書込み: ${WITH_CATEGORY ? "含める (--with-category)" : "含めない (一覧のみ)"}`);
  log(`KDS0031: ${CSV_PATH}\n  ${rows.length} 行 / 提供年月 ${[...monthCount].map(([k, v]) => `${k}:${v}`).join(" ")}`);
  const kds = new Map(); // TAIS → 集計
  for (const r of rows) {
    const t = nfkc(r[C.TAIS]);
    if (!t) continue;
    const ym = ymOf(r[C.SVC_MONTH]);
    let a = kds.get(t);
    if (!a) { a = { cur: new Map(), other: new Map(), half: [], items: new Set(), names: new Set(), users: new Set(), rows: 0 }; kds.set(t, a); }
    a.rows++;
    a.items.add(nfkc(r[C.SVC_ITEM]).padStart(4, "0"));
    a.names.add(nfkc(r[C.SVC_NAME]));
    a.users.add(`${r[C.INSURER]}|${r[C.INSURED]}`);
    const u = toInt(r[C.SVC_UNITS]);
    if (toInt(r[C.DAYS]) === daysIn(ym)) { const m = ym === MONTH ? a.cur : a.other; m.set(u, (m.get(u) ?? 0) + 1); } else a.half.push(u);
  }
  log(`  TAIS ${kds.size} 種 (全月)`);

  // ── FYGMST01 ───────────────────────────────────────────────────────
  const hmLines = new TextDecoder("shift-jis").decode(readFileSync(MASTER_CSV)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const hmHead = parseCsvLine(hmLines[0]);
  const H = Object.fromEntries(["ID", "中止", "区分", "福祉用具種目", "商品名称", "型番", "TAISコード等", "単位数"].map((k) => {
    const i = hmHead.indexOf(k); if (i < 0) throw new Error(`★ FYGMST01 に列「${k}」が無い`); return [k, i];
  }));
  const hmRows = []; let hmBad = 0;
  for (const l of hmLines.slice(1)) {
    const r = parseCsvLine(l);
    if (r.length !== hmHead.length) { hmBad++; continue; }
    hmRows.push({ id: r[H.ID], stop: r[H.中止] === "1", kubun: r[H.区分], cat: nfkc(r[H.福祉用具種目]), name: nfkc(r[H.商品名称]), model: nfkc(r[H.型番]), tais: nfkc(r[H.TAISコード等]), units: r[H.単位数] === "" ? null : toInt(r[H.単位数]) });
  }
  const hmByTais = groupBy(hmRows.filter((r) => r.tais && r.kubun === "レンタル"), (r) => r.tais);
  log(`FYGMST01: ${MASTER_CSV}\n  ${hmRows.length} 行 (列数不正 ${hmBad}) / レンタル TAIS ${hmByTais.size} 種`);
  const sourceFiles = [
    { path: relPath(CSV_PATH), sha256: sha256(CSV_PATH), rows: rows.length, kind: "KDS0031 明細書明細付 (全月)" },
    { path: relPath(MASTER_CSV), sha256: sha256(MASTER_CSV), rows: hmLines.length - 1, kind: "FYGMST01 用具マスタ" },
  ];
  const [SRC_KDS, SRC_HM] = sourceFiles.map((s) => s.path);

  // ── DB (★ SELECT のみ) ─────────────────────────────────────────────
  const sb = await makeSb();
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  const cachePath = EXECUTE ? join(tmpdir(), `consolidate_eq_db_${Date.now()}.json`) : resolve(opt("--db-cache") ?? join(tmpdir(), `honobono_sync_db_snapshot_${MONTH}.json`));
  const snap = await loadSnapshot(MONTH, cachePath, EXECUTE || argv.includes("--refresh"));
  log("DB 読込 (用具まわりは毎回読み直す・READ ONLY)...");
  const T = (q) => q.eq("tenant_id", TENANT);
  const live = {
    equipment: await selectAll(sb, "equipment_master", "*", T),
    priceHist: await selectAll(sb, "equipment_price_history", "*", T),
    items: await selectAll(sb, "order_items", "id,order_id,product_code,tokka_bill_product_code,status", T),
    prices: await selectAll(sb, "equipment_prices", "*", T),
    officePrices: await selectAll(sb, "equipment_office_prices", "*", T),
    setItems: await selectAll(sb, "equipment_set_items", "*", T),
    monitoring: await selectAll(sb, "monitoring_items", "id,product_code", T),
  };
  for (const [k, v] of Object.entries(live)) log(`  ${k.padEnd(14)} ${v.length} 行`);
  if (!live.equipment.length || !live.items.length) throw new Error("★ equipment_master / order_items が 0 行。tenant_id を疑うこと");
  // スナップショット (請求モデル用) と今の DB のずれ
  {
    const sEq = new Map(snap.equipment.map((e) => [e.id, `${e.product_code}|${e.category}|${e.rental_price}`]));
    const dEq = live.equipment.filter((e) => sEq.get(e.id) !== `${e.product_code}|${e.category}|${e.rental_price}`).length + snap.equipment.filter((e) => !live.equipment.some((x) => x.id === e.id)).length;
    const sIt = new Map(snap.items.map((i) => [i.id, i.product_code]));
    const dIt = live.items.filter((i) => sIt.get(i.id) !== i.product_code).length;
    log(`  請求モデル用スナップショット ${cachePath} (取得 ${snap.fetchedAt}) と今の DB の差: equipment_master ${dEq} 行 / order_items.product_code ${dIt} 行 ${dEq || dIt ? "→ 用具まわりは今の DB で上書きして使う (他の表も古い可能性。--refresh 推奨)" : ""}`);
  }
  // 請求モデルは 今の DB の用具まわりで組む
  const base = clone(snap);
  base.equipment = live.equipment.map((e) => ({ id: e.id, product_code: e.product_code, tais_code: e.tais_code, name: e.name, category: e.category, kind: e.kind, rental_price: e.rental_price }));
  base.priceHist = live.priceHist.map((h) => ({ id: h.id, product_code: h.product_code, rental_price: h.rental_price, valid_from: h.valid_from }));
  const livePc = new Map(live.items.map((i) => [i.id, i.product_code]));
  for (const it of base.items) if (livePc.has(it.id)) it.product_code = livePc.get(it.id);

  // ── 参照の数 (残す行の選び方・付け替えの見込み) ───────────────────────
  const refsByCode = (code) => ({
    order_items: live.items.filter((i) => i.product_code === code).length,
    tokka: live.items.filter((i) => i.tokka_bill_product_code === code).length,
    prices: live.prices.filter((p) => p.product_code === code).length,
    officePrices: live.officePrices.filter((p) => p.product_code === code).length,
    setItems: live.setItems.filter((s) => s.set_product_code === code || s.component_product_code === code).length,
    monitoring: live.monitoring.filter((m) => m.product_code === code).length,
    priceHist: live.priceHist.filter((h) => h.product_code === code).length,
    comparison: live.equipment.filter((e) => (e.comparison_product_codes ?? []).includes(code)).length,
  });
  const activeRefs = (code) => live.items.filter((i) => i.product_code === code && ["rental_started", "terminated"].includes(i.status)).length;

  // ── 計画 ───────────────────────────────────────────────────────────
  const ops = []; // { table, action, id, row?|patch?, before?, src, why, part: "A"|"B"|"C" }
  const RA = new Report(), RB = new Report(), RC = new Report(), RJ = new Report(), RN = new Report();
  const eqByKey = new Map(); // TAIS → equipment_master の行 (product_code か tais_code が一致)
  for (const e of live.equipment) for (const k of new Set([e.product_code, e.tais_code].filter(Boolean).map(nfkc))) {
    if (!TAIS_RE.test(k)) continue;
    if (!eqByKey.has(k)) eqByKey.set(k, []);
    eqByKey.get(k).push(e);
  }
  /** その行がどの TAIS の組に入るか (1 行が 2 つの TAIS にまたがるか) */
  const groupsOfRow = new Map();
  for (const [k, es] of eqByKey) for (const e of es) { if (!groupsOfRow.has(e.id)) groupsOfRow.set(e.id, []); groupsOfRow.get(e.id).push(k); }
  const renamed = new Map(); // 削除する行の product_code → 残す product_code (付け替え用)
  const removedIds = new Set();
  let nDupGroups = 0, nAuto = 0, nRenameSingle = 0;

  /** 単位数を決める。{ units, source } か { why } */
  const decideUnits = (t) => {
    const a = kds.get(t);
    const live0 = (hmByTais.get(t) ?? []).filter((h) => !h.stop && h.units != null);
    const hmUnits = new Set(live0.map((h) => h.units));
    if (a?.cur.size === 1) return { units: [...a.cur.keys()][0], source: "KDS 当月", hmUnits: [...hmUnits] };
    if (a?.cur.size > 1) return { why: `KDS 当月 (月を通した行) に単位数が複数 ${JSON.stringify(Object.fromEntries(a.cur))}`, hmUnits: [...hmUnits] };
    if (a?.other.size === 1) return { units: [...a.other.keys()][0], source: "KDS 他月 (月遅れ分)", hmUnits: [...hmUnits] };
    if (a?.other.size > 1) return { why: `KDS 他月に単位数が複数 ${JSON.stringify(Object.fromEntries(a.other))}`, hmUnits: [...hmUnits] };
    if (hmUnits.size === 1) {
      const u = [...hmUnits][0];
      // 月途中の開始/終了でも前半・後半の両方にかかれば満額 (halfMonthUnits) なので、半月行の単位は u か u/2 のどちらか
      if (!a?.half.length || a.half.every((h) => h === u || h === Math.round(u / 2))) return { units: u, source: "FYGMST01 使用中 (KDS は月の途中の行のみ・満額か半額で整合)", hmUnits: [u] };
      return { why: `KDS は月の途中の行のみで FYGMST01 ${u} の満額とも半額とも合わない ${JSON.stringify(a.half)}`, hmUnits: [u] };
    }
    return { why: hmUnits.size > 1 ? `KDS に月を通した行が無く FYGMST01 使用中も単位数が複数 ${JSON.stringify([...hmUnits])}` : "KDS に月を通した行が無く FYGMST01 使用中の行も無い", hmUnits: [...hmUnits] };
  };
  /** FYGMST01 の代表行 (使用中 → 単位数一致) */
  const pickHm = (t, units) => {
    let c = hmByTais.get(t) ?? [];
    if (c.length > 1) { const l = c.filter((h) => !h.stop); if (l.length) c = l; }
    if (c.length > 1 && units != null) { const m = c.filter((h) => h.units === units); if (m.length) c = m; }
    return c[0] ?? null;
  };

  for (const [t, a] of kds) {
    const es = eqByKey.get(t) ?? [];
    const kdsItems = [...a.items];
    const ex = { TAIS: t, サービス項目: [...a.names], KDS行数: a.rows, 利用者数: a.users.size };
    const hmAll = hmByTais.get(t) ?? [];
    const hmInfo = hmAll.map((h) => `${h.id}/${h.stop ? "中止" : "使用中"}/${h.cat}/${h.name}/${h.units}`);

    // ── C: マスタに無い ──
    if (es.length === 0) {
      const d = decideUnits(t);
      const hm = pickHm(t, d.units ?? null);
      const item = kdsItems.length === 1 ? kdsItems[0] : null;
      const cat = [hm?.cat, stripYobo(hm?.cat ?? ""), nfkc([...a.names][0]).replace(/^予防/, "").replace(/貸与$/, "")].find((c) => c && item && itemOfCat(c) === item) ?? null;
      const why = !item ? `KDS のサービス項目コードが複数 ${JSON.stringify(kdsItems)}` : d.units == null ? d.why : !cat ? `種目からサービスコードが引けない (FYGMST01 種目=${hm?.cat ?? "無し"} / KDS 項目 ${item})` : null;
      if (why) { RJ.add("C 追加できない (★ 判断が要る)", { ...ex, 理由: why, FYGMST01: hmInfo }); continue; }
      const name = hm?.name || `${cat} (TAIS ${t})`;
      const row = { tenant_id: TENANT, product_code: t, tais_code: t, name, category: cat, kind: "single", rental_price: d.units * 10 };
      ops.push({ part: "C", table: "equipment_master", action: "insert", id: newId("eq"), row, why: "equipment_master に無い TAIS を FYGMST01 で追加",
        src: { file: hm ? `${SRC_KDS} + ${SRC_HM}` : SRC_KDS, key: `TAIS:${t}${hm ? `|ほのぼの用具ID:${hm.id}` : ""}`, ref: { KDS: { 単位: d.units, 出どころ: d.source, 項目: kdsItems }, FYGMST01: hm } } });
      RC.add("C equipment_master に追加", { ...ex, 名前: name, 種目: cat, 単位: d.units, 出どころ: d.source, 商品名の出どころ: hm?.name ? "FYGMST01" : "★ 仮名 (FYGMST01 に無い)", 孤立した明細: live.items.filter((i) => i.product_code === t).length });
      continue;
    }
    const own = es.filter((e) => e.product_code === t);
    if (es.length === 1 && own.length === 1) continue; // 重複なし・正常
    if (es.length > 1) nDupGroups++;
    const label = es.length > 1 ? "A" : "C";
    const dbInfo = es.map((e) => `${e.product_code}/${e.category}/${e.rental_price}/${e.name}/参照${activeRefs(e.product_code)}`);

    // ── 判断が要るか ──
    const reasons = [];
    const cross = es.filter((e) => (groupsOfRow.get(e.id) ?? []).length > 1);
    if (cross.length) reasons.push(`1 行が 2 つの TAIS にまたがる (${cross.map((e) => `${e.product_code}/tais=${e.tais_code}`).join(", ")})`);
    if (kdsItems.length > 1) reasons.push(`KDS のサービス項目コードが複数 ${JSON.stringify(kdsItems)}`);
    const item = kdsItems[0];
    const wrongCat = es.filter((e) => e.category && itemOfCat(stripYobo(e.category)) && itemOfCat(stripYobo(e.category)) !== item);
    if (wrongCat.length) reasons.push(`種目が KDS のサービス項目 (${item}=${catOfItem.get(item)}) と食い違う行 (${wrongCat.map((e) => `${e.product_code}/${e.category}`).join(", ")})`);
    if (!catOfItem.has(item)) reasons.push(`KDS のサービス項目 ${item} が種目表に無い`);
    const d = decideUnits(t);
    if (d.units == null) reasons.push(d.why);
    if (own.length > 1) reasons.push(`product_code = TAIS の行が ${own.length} 行`);
    if (reasons.length) { RJ.add(`${label} 統合しない (★ 判断が要る)`, { ...ex, 理由: reasons, DB: dbInfo, FYGMST01: hmInfo }); continue; }

    // ── 残す行 ──
    const keep = own[0] ?? [...es].sort((x, y) => activeRefs(y.product_code) - activeRefs(x.product_code) || (x.created_at ?? "").localeCompare(y.created_at ?? ""))[0];
    const drop = es.filter((e) => e.id !== keep.id);
    const U = d.units;
    const hm = pickHm(t, U);
    const srcOf = (extra = {}) => ({ file: hm ? `${SRC_KDS} + ${SRC_HM}` : SRC_KDS, key: `TAIS:${t}${hm ? `|ほのぼの用具ID:${hm.id}` : ""}`,
      ref: { KDS: { 単位: U, 出どころ: d.source, 項目: kdsItems, 当月単位と件数: Object.fromEntries(a.cur) }, FYGMST01: hm, FYGMST01使用中の単位: d.hmUnits, ...extra } });
    if (d.hmUnits.length && !d.hmUnits.includes(U)) RN.add("FYGMST01 使用中の単位数と KDS (実請求) が違う (KDS を正にした)", { TAIS: t, KDS: U, FYGMST01: d.hmUnits });
    if (d.hmUnits.length > 1) RN.add("FYGMST01 使用中に同 TAIS で単位数が複数あるが KDS で 1 つに決まった", { TAIS: t, KDS: U, FYGMST01: d.hmUnits });
    const patch = {};
    if (keep.product_code !== t) patch.product_code = t;
    if (nfkc(keep.tais_code) !== t) patch.tais_code = t;
    if (keep.rental_price !== U * 10) patch.rental_price = U * 10;
    if (itemOfCat(keep.category) !== item) patch.category = catOfItem.get(item); // 残す行の種目が引けないと統合で請求が落ちる
    // 残す行の空欄を、消す行の値で埋める (消す行の間で値が 1 つに決まるときだけ)
    for (const col of ["furigana", "national_avg_price", "price_limit", "selection_reason", "proposal_reason"]) {
      if (keep[col] != null && keep[col] !== "") continue;
      const vals = [...new Set(drop.map((e) => e[col]).filter((v) => v != null && v !== ""))];
      if (vals.length === 1) patch[col] = vals[0];
      else if (vals.length > 1) RN.add(`残す行の ${col} が空で、消す行の値が複数 (埋めない)`, { TAIS: t, 値: vals });
    }
    const dropCodes = new Set(drop.map((e) => e.product_code).filter((c) => c !== t));
    const cmpUnion = [...new Set([...(keep.comparison_product_codes ?? []), ...drop.flatMap((e) => e.comparison_product_codes ?? [])].map((c) => (dropCodes.has(c) || c === keep.product_code ? t : c)).filter((c) => c !== t))];
    if (JSON.stringify(cmpUnion) !== JSON.stringify(keep.comparison_product_codes ?? []) && (cmpUnion.length || (keep.comparison_product_codes ?? []).length)) patch.comparison_product_codes = cmpUnion.length ? cmpUnion : null;
    if (Object.keys(patch).length) {
      ops.push({ part: label, table: "equipment_master", action: "update", id: keep.id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, keep[k] ?? null])), patch, why: "統合で残す行", src: srcOf({ 消す行: drop.map((e) => e.product_code) }) });
    }
    if (keep.product_code !== t) { renamed.set(keep.product_code, t); if (es.length === 1) nRenameSingle++; }
    for (const e of drop) {
      if (e.product_code !== t) renamed.set(e.product_code, t);
      removedIds.add(e.id);
      ops.push({ part: label, table: "equipment_master", action: "delete", id: e.id, before: e, why: `同じ TAIS ${t} の重複 (残す行 ${keep.product_code}→${t})`, src: srcOf({ 残す行id: keep.id }) });
    }
    // 価格履歴: 消す行の履歴は削除 / 残す行の旧コードの履歴は付け替え / 当月の価格が U でなければ当月 1 日の行を足す (同日があれば直す)
    const keptOldCode = keep.product_code;
    const histAfter = [];
    for (const h of live.priceHist) {
      if (h.product_code === keptOldCode) { histAfter.push({ ...h, product_code: t }); if (keptOldCode !== t) ops.push({ part: label, table: "equipment_price_history", action: "update", id: h.id, before: { product_code: h.product_code }, patch: { product_code: t }, why: "残す行の product_code を TAIS に直したので履歴も付け替え", src: srcOf() }); }
      else if (h.product_code === t && keptOldCode !== t) histAfter.push(h); // product_code=TAIS の行が無いのに残っていた履歴
      else if (drop.some((e) => e.product_code === h.product_code && e.product_code !== t)) ops.push({ part: label, table: "equipment_price_history", action: "delete", id: h.id, before: h, why: "消す行の価格履歴", src: srcOf() });
    }
    const eff = getPriceForMonth(histAfter, t, MONTH);
    if (eff != null && eff !== U * 10) {
      const same = histAfter.find((h) => h.valid_from === monthStartS);
      if (same) ops.push({ part: label, table: "equipment_price_history", action: "update", id: same.id, before: { rental_price: same.rental_price }, patch: { rental_price: U * 10 }, why: "当月 1 日の履歴が KDS と違う", src: srcOf() });
      else ops.push({ part: label, table: "equipment_price_history", action: "insert", id: newId("ph"), row: { tenant_id: TENANT, product_code: t, rental_price: U * 10, valid_from: monthStartS }, why: "当月に効く履歴が KDS と違う (請求は履歴を先に見る)", src: srcOf({ 履歴の当月価格: eff }) });
    }
    if (es.length > 1) nAuto++;
    const ref = Object.fromEntries(drop.map((e) => [e.product_code, refsByCode(e.product_code)]));
    (es.length > 1 ? RA : RC).add(es.length > 1 ? "A 自動で統合する" : "C product_code を TAIS に直す (tais_code だけ一致の行)", { ...ex, 残す: `${keep.product_code}${patch.product_code ? `→${t}` : ""}`, 消す: drop.map((e) => e.product_code), 単位: U, 出どころ: d.source, 直す列: Object.keys(patch), 消す行の参照: ref });
  }

  // ── 付け替え (消す行 / 名前を直した行の product_code → TAIS) ────────
  const rp = (code) => renamed.get(code);
  for (const i of live.items) {
    const patch = {};
    if (rp(i.product_code)) patch.product_code = rp(i.product_code);
    if (i.tokka_bill_product_code && rp(i.tokka_bill_product_code)) patch.tokka_bill_product_code = rp(i.tokka_bill_product_code);
    if (Object.keys(patch).length) ops.push({ part: "A", table: "order_items", action: "update", id: i.id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, i[k]])), patch, why: "用具の統合で product_code を付け替え", src: { file: SRC_KDS, key: `TAIS:${patch.product_code ?? patch.tokka_bill_product_code}`, ref: { 旧: i.product_code } } });
  }
  // 一意キーがある表は 付け替え後に衝突するものを削除 (残す側優先)
  const repointUnique = (table, rowsIn, keyOf, cols) => {
    const after = new Map(); // key → 付け替え後に残る行
    for (const r of rowsIn) if (!cols.some((c) => rp(r[c]))) after.set(keyOf(r), r); // 付け替え不要の行が先に場所を取る
    for (const r of rowsIn) {
      if (!cols.some((c) => rp(r[c]))) continue;
      const n = { ...r }; for (const c of cols) if (rp(r[c])) n[c] = rp(r[c]);
      const k = keyOf(n);
      const selfRef = table === "equipment_set_items" && n.set_product_code === n.component_product_code;
      if (after.has(k) || selfRef) {
        ops.push({ part: "A", table, action: "delete", id: r.id, before: r, why: selfRef ? "付け替えるとセット親=構成品になる" : `付け替えると一意キーが既存行 ${after.get(k)?.id} と重なる`, src: { file: SRC_KDS, key: `TAIS:${n[cols[0]]}`, ref: { 残る行: after.get(k) ?? null } } });
        if (!selfRef) { const o = after.get(k); const diffCols = Object.keys(r).filter((c) => !["id", "updated_at", "created_at", ...cols].includes(c) && JSON.stringify(r[c]) !== JSON.stringify(o[c])); if (diffCols.length) RN.add(`${table}: 重なって消す行と残る行で値が違う (残る側を採用)`, { 消す: r, 残る: o, 違う列: diffCols }); }
        continue;
      }
      after.set(k, n);
      ops.push({ part: "A", table, action: "update", id: r.id, before: Object.fromEntries(cols.filter((c) => rp(r[c])).map((c) => [c, r[c]])), patch: Object.fromEntries(cols.filter((c) => rp(r[c])).map((c) => [c, rp(r[c])])), why: "用具の統合で product_code を付け替え", src: { file: SRC_KDS, key: `TAIS:${n[cols[0]]}`, ref: {} } });
    }
  };
  repointUnique("equipment_prices", live.prices, (r) => `${r.product_code}|${r.supplier_id}|${r.valid_from}`, ["product_code"]);
  repointUnique("equipment_office_prices", live.officePrices, (r) => `${r.product_code}|${r.office_id}`, ["product_code"]);
  repointUnique("equipment_set_items", live.setItems, (r) => `${r.set_product_code}|${r.component_product_code}`, ["set_product_code", "component_product_code"]);
  for (const m of live.monitoring) if (rp(m.product_code)) ops.push({ part: "A", table: "monitoring_items", action: "update", id: m.id, before: { product_code: m.product_code }, patch: { product_code: rp(m.product_code) }, why: "用具の統合で product_code を付け替え", src: { file: SRC_KDS, key: `TAIS:${rp(m.product_code)}`, ref: {} } });
  // 他の行の comparison_product_codes (残す行は上で処理済み)
  const keptUpdated = new Set(ops.filter((o) => o.table === "equipment_master" && o.action === "update").map((o) => o.id));
  for (const e of live.equipment) {
    if (removedIds.has(e.id) || keptUpdated.has(e.id) || !(e.comparison_product_codes ?? []).some((c) => rp(c))) continue;
    const nv = [...new Set(e.comparison_product_codes.map((c) => rp(c) ?? c))].filter((c) => c !== e.product_code);
    ops.push({ part: "A", table: "equipment_master", action: "update", id: e.id, before: { comparison_product_codes: e.comparison_product_codes }, patch: { comparison_product_codes: nv.length ? nv : null }, why: "比較対象の product_code を付け替え", src: { file: SRC_KDS, key: `equipment:${e.product_code}`, ref: {} } });
  }

  // ── B: 種目名 (category) からサービスコードが引けない行 ──────────────
  for (const e of live.equipment) {
    if (removedIds.has(e.id) || !e.category || itemOfCat(e.category)) continue;
    const kept = ops.find((o) => o.table === "equipment_master" && o.action === "update" && o.id === e.id && o.patch.category);
    const proposal = itemOfCat(stripYobo(e.category)) ? catOfItem.get(itemOfCat(stripYobo(e.category))) : null;
    const t = nfkc(e.tais_code) || e.product_code;
    const k = kds.get(t);
    const kdsCat = k && k.items.size === 1 ? catOfItem.get([...k.items][0]) : null;
    const ex = { product_code: e.product_code, TAIS: e.tais_code, name: e.name, category: e.category, 是正案: proposal ?? kdsCat, KDS: kdsCat, 当月有効の明細: activeRefs(e.product_code) };
    if (kept) { RB.add("B A の残す行として種目を直す (A に含む)", { ...ex, 是正: kept.patch.category }); continue; }
    if (!proposal) { RB.add("B 是正案が作れない (★ 判断が要る)", ex); continue; }
    if (kdsCat && kdsCat !== proposal) { RB.add("B 是正案と KDS のサービス項目が食い違う (★ 判断が要る)", ex); continue; }
    RB.add("B 種目名を直す (--with-category のときだけ書く)", ex);
    ops.push({ part: "B", table: "equipment_master", action: "update", id: e.id, before: { category: e.category }, patch: { category: proposal }, why: `種目名 ${e.category} → ${proposal} (先頭の「予」を外す)`, src: { file: k ? SRC_KDS : "(種目表 FUKUYOGU_SERVICE_CODES)", key: `equipment:${e.product_code}`, ref: { KDSの種目: kdsCat } } });
  }
  const activeOps = ops.filter((o) => o.part !== "B" || WITH_CATEGORY);

  // ── 報告 ───────────────────────────────────────────────────────────
  const kdsDupAll = [...kds.keys()].filter((t) => (eqByKey.get(t) ?? []).length > 1).length;
  const dbDupAll = [...eqByKey.values()].filter((v) => v.length > 1).length;
  log("\n══ 母数 ══");
  log(`  equipment_master ${live.equipment.length} 行 / 同じ TAIS が複数行: DB 全体 ${dbDupAll} コード / うち KDS0031 (全月) に出る ${kdsDupAll} コード (= 対象。KDS に出ない ${dbDupAll - kdsDupAll} コードは請求の裏付けが無いので触らない)`);
  log(`  KDS の TAIS ${kds.size} 種 → equipment_master に無い ${[...kds.keys()].filter((t) => !(eqByKey.get(t) ?? []).length).length} / product_code=TAIS の行が無い ${[...kds.keys()].filter((t) => (eqByKey.get(t) ?? []).length && !(eqByKey.get(t) ?? []).some((e) => e.product_code === t)).length}`);
  log("\n══ A 重複の統合 ══"); log(`  重複 ${nDupGroups} コード → 自動 ${nAuto} / 判断が要る ${RJ.count("A 統合しない (★ 判断が要る)")}`); RA.print(5);
  log("\n══ C 追加・product_code の是正 ══"); log(`  (重複なしで product_code だけ直す ${nRenameSingle} 件。重複ありで product_code=TAIS の行が無いものは A で直す)`); RC.print(12);
  log("\n══ 判断が要る (★ 自動では触らない) ══"); RJ.print(15);
  log("\n══ B 種目名 ══"); RB.print(30);
  log("\n══ 参考 (統合はするが記録しておく) ══"); RN.print(5);
  log("\n══ 書込みの見込み ══");
  log(`  ${JSON.stringify(countBy(activeOps, (o) => `${o.part} ${o.table} ${o.action}`), null, 1)}`);
  if (!WITH_CATEGORY) log(`  (B の種目名 ${ops.filter((o) => o.part === "B").length} 行は --with-category のときだけ)`);
  log("  付け替えない表: equipment_change_log / equipment_master_history (履歴) / care_plan_elements.detail (当時の用具名の控え) / v_order_margin (view)");

  // ── 請求に効くか (2026-09) ─────────────────────────────────────────
  const office = base.offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
  if (!office) throw new Error(`offices に business_number=${PROVIDER_BN} が無い`);
  const simulate = (list) => {
    const s = clone(base);
    const tab = { equipment_master: s.equipment, equipment_price_history: s.priceHist, order_items: s.items };
    for (const o of list) {
      const arr = tab[o.table]; if (!arr) continue;
      if (o.action === "insert") arr.push({ id: o.id, ...o.row });
      else if (o.action === "delete") { const i = arr.findIndex((x) => x.id === o.id); if (i >= 0) arr.splice(i, 1); }
      else { const x = arr.find((y) => y.id === o.id); if (x) Object.assign(x, o.patch); }
    }
    return s;
  };
  const lineMap = (s) => {
    const m = buildBillingModel(s, MONTH, office.id, libs);
    const out = new Map();
    for (const [cid, ls] of m.dbLines) for (const l of ls) out.set(l.itemId, { cid, ...l, on: true });
    for (const [cid, ls] of m.dbSkipped) for (const l of ls) out.set(l.itemId, { cid, ...l, on: false });
    return out;
  };
  const before = lineMap(base);
  const variants = [["A+C", ops.filter((o) => o.part !== "B")], ["A+C+B", ops]];
  const sims = {};
  log(`\n══ 請求に効く変化 (提供 ${MONTH} / ${office.name}・BillingTab と同じ条件) ══`);
  for (const [name, list] of variants) {
    const s = simulate(list); sims[name] = s;
    const after = lineMap(s);
    const ch = [];
    for (const [id, b] of before) {
      const x = after.get(id);
      if (!x) { ch.push({ id, cid: b.cid, kind: "明細が消える", b }); continue; }
      const diffs = [];
      if (b.unitPer !== x.unitPer) diffs.push(`単位 ${b.unitPer}→${x.unitPer}`);
      if (b.code !== x.code) diffs.push(`コード ${b.code}→${x.code}`);
      if (b.on !== x.on) diffs.push(x.on ? "請求に乗るようになる" : `請求から外れる (${x.skipped})`);
      if (b.tais !== x.tais) diffs.push(`TAIS ${b.tais}→${x.tais}`);
      if (diffs.length) ch.push({ id, cid: b.cid, kind: diffs.join(" / "), b, x });
    }
    const people = groupBy(ch, (c) => c.cid);
    log(`  [${name}] 変わる明細 ${ch.length} 行 / 利用者 ${people.size} 名 (当月明細 ${before.size} 行中)`);
    log(`     内訳 ${JSON.stringify(countBy(ch, (c) => c.kind.replace(/\d+→\d+/g, "x→y").replace(/[0-9]{6}→[0-9]{6}|null→[0-9]{6}|[0-9]{6}→null/g, "c→c").replace(/TAIS \S+/, "TAIS")))}`);
    const cName = (cid) => base.clients.find((c) => c.id === cid)?.name ?? cid;
    const lst = [...people].map(([cid, cs]) => `${cName(cid)}: ${cs.map((c) => `${c.x?.tais ?? c.b.tais} ${c.kind}`).join("; ")}`);
    for (const l of lst.slice(0, name === "A+C" ? 400 : 60)) log(`     - ${l}`);
    if (lst.length > (name === "A+C" ? 400 : 60)) log(`     … ほか ${lst.length - 400} 名`);
  }
  // KDS0031 との一致 (差分 script を 統合前 / 統合後 のスナップショットで回す。同じ判定を使うため逐語コピーしない)
  const diffScript = join(HERE, "../scripts/honobono-sync-diff.mts");
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const dir = OUT_TXT ? dirname(OUT_TXT) : tmpdir();
  const runDiff = (label, s) => {
    const cp = join(dir, `consolidate_snap_${label}.json`), op = join(dir, `consolidate_diff_${label}.json`);
    writeFileSync(cp, JSON.stringify({ ...s, month: MONTH }));
    const r = spawnSync(process.execPath, [tsxCli, diffScript, "--csv", CSV_PATH, "--month", MONTH, "--db-cache", cp, "--out", op], { encoding: "utf8", maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`差分 script (${label}) が失敗: ${(r.stderr || r.stdout).slice(-800)}`);
    return JSON.parse(readFileSync(op, "utf8"));
  };
  log(`\n══ KDS0031 (提供 ${MONTH}) との一致 — scripts/honobono-sync-diff.mts を統合前後のスナップショットで実行 ══`);
  const dB = runDiff("before", base), dAC = runDiff("after_AC", sims["A+C"]), dACB = runDiff("after_ACB", sims["A+C+B"]);
  const keys = new Set([...Object.keys(dB.totals), ...Object.keys(dAC.totals), ...Object.keys(dACB.totals), ...Object.keys(dB.items), ...Object.keys(dAC.items), ...Object.keys(dACB.items)]);
  log(`  ${"項目".padEnd(50)} 統合前  A+C  A+C+B`);
  for (const k of keys) {
    const g = (d) => (d.totals[k] ?? d.items[k])?.count ?? 0;
    log(`  ${k.slice(0, 50).padEnd(50)} ${String(g(dB)).padStart(5)} ${String(g(dAC)).padStart(5)} ${String(g(dACB)).padStart(5)}`);
  }
  const writeOut = () => { if (OUT_TXT) { writeFileSync(OUT_TXT, outLines.join("\n") + "\n"); console.log(`\n→ 保存 ${OUT_TXT}`); writeFileSync(OUT_TXT.replace(/\.txt$/, ".json"), JSON.stringify({ A: RA, B: RB, C: RC, 判断: RJ, 参考: RN, ops }, null, 1)); } };

  const ready = await provenanceReady(sb);
  log(`\n出どころ記録の表: ${ready.ok ? "あり" : `無い (${ready.why})`}`);
  if (!EXECUTE) { log("\nDRY RUN — DB は書き換えていない。--execute で本番 (★ user 承認後)"); writeOut(); return; }
  if (!ready.ok) { console.error("★ 出どころ記録の表が無いので --execute しない"); process.exit(2); }
  writeOut();
  await execute(sb, activeOps, sourceFiles);
}

// ── 書込み ────────────────────────────────────────────────────────────────
async function execute(sb, ops, sourceFiles) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: sourceFiles, script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `用具マスタ 同 TAIS 統合${WITH_CATEGORY ? " + 種目名" : ""}`,
  }, "id,created_at");
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  const record = async (recs) => {
    for (const c of chunks(recs, 100)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); }
  };
  const countDerived = async () => {
    const out = {};
    for (const t of ["doc_tasks", "care_plan_elements"]) {
      const { count, error } = await sb.from(t).select("id", { count: "exact", head: true }).eq("tenant_id", TENANT).gte("created_at", batch.created_at);
      if (error) await fail(`${t} 件数: ${error.message}`);
      out[t] = count;
    }
    return out;
  };
  // 変更前の行 (全列) → バックアップ
  const beforeRows = new Map();
  for (const [table, us] of groupBy(ops.filter((o) => o.action !== "insert"), (o) => o.table)) {
    const got = await selectIn(sb, table, "*", "id", us.map((o) => o.id));
    if (got.length !== new Set(us.map((o) => o.id)).size) await fail(`${table}: 変更前の行が ${new Set(us.map((o) => o.id)).size} 件のはずが ${got.length} 件`);
    for (const r of got) beforeRows.set(`${table}:${r.id}`, r);
  }
  const bpath = join(HERE, `_backup_consolidate_equipment_${ts}.json`);
  writeFileSync(bpath, JSON.stringify({ batch: BATCH, at: new Date().toISOString(), before: Object.fromEntries(beforeRows) }, null, 2));
  console.log(`バックアップ ${bpath}`);
  const srcRef = (o) => ({ file: o.src?.file ?? null, why: o.why, ...(o.src?.ref ?? {}) });
  const doUpdate = async (o) => {
    const { error, count } = await sb.from(o.table).update(o.patch, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
    if (error) await fail(`update ${o.table} ${o.id}: ${error.message}`);
    if (count !== 1) await fail(`update ${o.table} ${o.id}: 更新件数 ${count}`);
    await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "update", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${o.table}:${o.id}`), after: o.patch }]);
  };
  const doDelete = async (o) => {
    const { error, count } = await sb.from(o.table).delete({ count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
    if (error) await fail(`delete ${o.table} ${o.id}: ${error.message}`);
    if (count !== 1) await fail(`delete ${o.table} ${o.id}: 削除件数 ${count}`);
    await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "delete", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${o.table}:${o.id}`), after: null }]);
  };
  const doInsert = async (list, table) => {
    // キー集合が同じ行だけを 1 回にまとめる (違うと PostgREST が欠けた列に NULL を明示して DEFAULT が効かない)
    for (const [, g] of groupBy(list, (o) => Object.keys(o.row).sort().join(","))) for (const c of chunks(g, 100)) {
      const { data, error } = await sb.from(table).insert(c.map((o) => o.row)).select("id");
      if (error) await fail(`insert ${table}: ${error.message}`);
      if (data.length !== c.length) await fail(`insert ${table}: 返った行数 ${data.length} ≠ ${c.length}`);
      await record(c.map((o, j) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: data[j].id, op: "insert", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: null, after: o.row })));
    }
  };
  const of = (table, action) => ops.filter((o) => o.table === table && o.action === action);
  const d0 = await countDerived();
  try {
    // 1. マスタ: 追加 → 残す行の更新 (product_code を TAIS に直す・単価・種目・空欄埋め)
    await doInsert(of("equipment_master", "insert"), "equipment_master");
    for (const o of of("equipment_master", "update")) await doUpdate(o);
    // 2. 価格履歴
    for (const o of of("equipment_price_history", "delete")) await doDelete(o);
    for (const o of of("equipment_price_history", "update")) await doUpdate(o);
    await doInsert(of("equipment_price_history", "insert"), "equipment_price_history");
    // 3. 参照の付け替え (一意キーが重なる行は先に消す)
    for (const t of ["equipment_prices", "equipment_office_prices", "equipment_set_items"]) { for (const o of of(t, "delete")) await doDelete(o); for (const o of of(t, "update")) await doUpdate(o); }
    for (const o of of("monitoring_items", "update")) await doUpdate(o);
    for (const o of of("order_items", "update")) await doUpdate(o);
    // 4. 余りの行を消す
    for (const o of of("equipment_master", "delete")) await doDelete(o);
  } catch (e) {
    console.error(`★ 途中で失敗: ${e.message}\n  ここまでの書込みは data_import_rows にある。--revert ${BATCH} で戻せる`);
    throw e;
  }
  const d1 = await countDerived();
  console.log(`trigger の副作用 (batch 開始以降に作られた行): doc_tasks ${d1.doc_tasks - d0.doc_tasks} / care_plan_elements ${d1.care_plan_elements - d0.care_plan_elements} (product_code だけの更新では 0 のはず。0 でなければ他セッションの書込みか確認)`);
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) console.warn(`⚠ data_import_rows ${count} 行 ≠ 書込み ${ops.length} 件`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH} / data_import_rows ${count} 行。取り消しは --revert ${BATCH}`);
}

// ── 取り消し ──────────────────────────────────────────────────────────────
async function revert(batchId) {
  const sb = await makeSb();
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  const ready = await provenanceReady(sb);
  if (!ready.ok) { console.error(`出どころ記録の表が無い (${ready.why})`); process.exit(2); }
  const { data: batch, error } = await sb.from("data_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(`data_import_batches: ${error.message}`);
  if (!batch) { console.error(`batch ${batchId} が無い`); process.exit(1); }
  if (batch.step !== STEP_NAME) { console.error(`batch ${batchId} は ${batch.step} (この script の batch ではない)`); process.exit(1); }
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 取り消し batch ${batchId} (${batch.status} / ${batch.created_at})`);
  if (batch.status === "reverted") { console.log("既に取り消し済み"); return; }
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  console.log(`記録 ${recs.length} 行 ${JSON.stringify(countBy(recs, (r) => `${r.table_name} ${r.op}`))}`);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (a != null && b != null && String(a) === String(b));
  const plan = { reinsert: [], restore: [], del: [], skip: [] };
  for (const [table, rs] of groupBy(recs.filter((r) => r.op !== "observe"), (r) => r.table_name)) {
    const cur = new Map((await selectIn(sb, table, "*", "id", rs.map((r) => r.row_id))).map((r) => [r.id, r]));
    for (const r of rs) {
      const now = cur.get(r.row_id);
      if (r.op === "delete") { if (now) plan.skip.push({ table, id: r.row_id, why: "同じ id の行が既にある" }); else plan.reinsert.push({ table, row: r.before }); continue; }
      if (!now) { plan.skip.push({ table, id: r.row_id, why: "既に無い" }); continue; }
      const changed = Object.keys(r.after ?? {}).filter((k) => !same(now[k], r.after[k]));
      if (changed.length) { plan.skip.push({ table, id: r.row_id, why: `後から変わった列 ${changed.join(",")} (★ 戻さない)` }); continue; }
      if (r.op === "insert") plan.del.push({ table, id: r.row_id });
      else plan.restore.push({ table, id: r.row_id, patch: Object.fromEntries(Object.keys(r.after).map((k) => [k, r.before?.[k] ?? null])) });
    }
  }
  // 追加した用具を 他の明細が使っていたら消さない
  for (const d of plan.del.filter((x) => x.table === "equipment_master")) {
    const e = (await selectIn(sb, "equipment_master", "id,product_code", "id", [d.id]))[0];
    const used = e ? (await selectAll(sb, "order_items", "id", (q) => q.eq("tenant_id", TENANT).eq("product_code", e.product_code))).length : 0;
    if (used) { plan.del = plan.del.filter((x) => x !== d); plan.skip.push({ table: "equipment_master", id: d.id, why: `order_items ${used} 行が ${e.product_code} を使っている` }); }
  }
  console.log(`入れ直す ${plan.reinsert.length} ${JSON.stringify(countBy(plan.reinsert, (d) => d.table))}`);
  console.log(`戻す ${plan.restore.length} ${JSON.stringify(countBy(plan.restore, (d) => d.table))}`);
  console.log(`消す ${plan.del.length} ${JSON.stringify(countBy(plan.del, (d) => d.table))}`);
  console.log(`戻さない ${plan.skip.length} ${JSON.stringify(countBy(plan.skip, (d) => `${d.table} ${d.why.split(" (")[0]}`))}`);
  for (const s of plan.skip.slice(0, 10)) console.log(`   - ${JSON.stringify(s)}`);
  if (!EXECUTE) { console.log("\nDRY RUN — 何も変えていない。--execute で取り消し"); return; }
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し (同時実行ロック用。行の記録はしない)` }, async () => {
    // 順番: 消した行を入れ直す (用具 → 価格等) → 更新を戻す → 追加した行を消す
    const reOrder = ["equipment_master", "equipment_price_history", "equipment_prices", "equipment_office_prices", "equipment_set_items"];
    for (const table of reOrder) for (const c of chunks(plan.reinsert.filter((r) => r.table === table).map((r) => r.row), 100)) {
      const { error: e } = await sb.from(table).insert(c);
      if (e) throw new Error(`reinsert ${table}: ${e.message}`);
    }
    for (const r of plan.restore) {
      const { error: e, count } = await sb.from(r.table).update(r.patch, { count: "exact" }).eq("id", r.id).eq("tenant_id", TENANT);
      if (e || count !== 1) throw new Error(`restore ${r.table} ${r.id}: ${e?.message ?? `件数 ${count}`}`);
    }
    for (const table of ["equipment_price_history", "equipment_master"]) for (const c of chunks(plan.del.filter((d) => d.table === table).map((d) => d.id), 150)) {
      const { error: e, count } = await sb.from(table).delete({ count: "exact" }).in("id", c).eq("tenant_id", TENANT);
      if (e || count !== c.length) throw new Error(`delete ${table}: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`);
    }
    const status = plan.skip.some((s) => s.why !== "既に無い") ? "partially_reverted" : "reverted";
    const { error: e3 } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
    if (e3) throw new Error(`batch 更新: ${e3.message}`);
    console.log(`\n取り消し完了 (${status})`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
