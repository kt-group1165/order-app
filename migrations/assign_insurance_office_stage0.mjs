/**
 * 保険・認定・公費を「事業所ごと」に持つ — 段階 0 の移行: 既存行に office_id / office_source を付ける
 * 2026-11-09 FY-OF0。設計: ルート DESIGN_INSURANCE_PER_OFFICE.md §5 (2026-11-09 user 合意 9 項目)
 *
 *   node migrations/assign_insurance_office_stage0.mjs                               # DRY RUN (既定。3 表 + ケアサポ行の作成計画)
 *   node migrations/assign_insurance_office_stage0.mjs --out <明細.json>             # 明細を JSON に書く (既定は OS の tmp)
 *   node migrations/assign_insurance_office_stage0.mjs --table client_kohi_records   # 1 表だけ
 *   node migrations/assign_insurance_office_stage0.mjs --only-office <uuid>          # 付ける先がその事業所の行だけ
 *   node migrations/assign_insurance_office_stage0.mjs --step assign   --execute     # ① 既存行に事業所を付ける (UPDATE のみ)
 *   node migrations/assign_insurance_office_stage0.mjs --step caresapo --execute     # ② ケアサポの行を作る (INSERT。①の後・段階 1)
 *   node migrations/assign_insurance_office_stage0.mjs --revert <batch_id> [--execute]
 *
 * 前提 (--execute のみ。DRY RUN は SQL 未適用でも回る)
 *   ・ルート migrations/insurance_per_office_stage0.sql 適用済み (列 office_id / office_source / copied_from_id)
 *   ・apps/order-app/migrations/data_import_provenance.sql 適用済み (data_import_batches / rows)
 *   ・②は ①の実行後 (ケアサポの insert 行に office_id が付いていること) かつ
 *     trigger fn_care_plan_elements_from_insurance が段階 0 の版 (直前行を同じ事業所から引く) であること
 *
 * ── ① 事業所の付け方 (設計 §5.2。1 行に 1 事業所を付けるだけ。複写はしない・行は増えない) ──
 *   優先順                                                         office_source
 *   A1 data_import_rows: ほのぼの福祉用具の取込で insert / update した行 → ケアサポ   import_record
 *      (batch の script = sync_fukuyogu_from_honobono.mjs / fix_honobono_sync_7_cases_202609.mjs。
 *       status は見ない: d2b5a9bb / 4154b219 は failed だが実際に書かれている = 設計 §5.3)
 *      公費 client_public_expenses の insert も同じ
 *   A2 notes マーカーに拠点名: [居宅STEP1 <月> <拠点>] → その拠点の居宅 / [MEISAI-STEP1 <月> <拠点>] → 訪問介護   notes_marker
 *      公費 client_kohi_records: [居宅STEP1 …] → 居宅 / [MEISAI公費 <月> <拠点>] → 訪問介護
 *      拠点名 → 事業所は kaigo-app/migrations/_area_offices.mjs (部分一致は使わない)。
 *      拠点に同じ制度の事業所が 2 つ以上 → 利用者の割当 (現・終了) と重なる 1 つ。決まらなければ B 扱い
 *   B  制度だけ分かる: [KYOTAKU-SYNC] [KYOTAKU-CSV] [伝送取込] (居宅) / [MEISAI-STEP1 <月>] 拠点名なし (訪問介護)
 *      その制度の現割当が 1 事業所 → system_single / 2 以上 → NULL / 0 → その制度の終了割当 (最後に終わったもの) → ended_assignment
 *   C  不明 (notes なし / [認定履歴取込] / [認定バックフィル] / [利用票取込] / [公費マスタ] / 公費の手入力)
 *      現割当が 1 事業所 → assignment_single / 2 以上 → NULL / 0 → 終了割当 (最後に終わったもの) → ended_assignment / 無ければ NULL
 *   Z  [fake テスト用-…] → NULL のまま (別途削除)
 *   ・「割当」= client_office_assignments。役割 tenant (fukuyogu-kanri) / 本社系 office は数えない
 *   ・「現割当」= end_date が空か 今日以降 (設計 付録と同じ)
 *   ・既に office_id が付いている行は触らない (UPDATE も .is("office_id", null) 条件付き)
 *
 * ── ② ケアサポの行 (設計 §5.3。共有の人。ケアサポ自身のデータの取込であって複写ではない) ──
 *   data_import_rows の op=observe (table=client_insurance_records) = 共有のため上書きせず控えた ほのぼの福祉用具の値。
 *   元の行 (row_id) の値 + observe の after で ケアサポの行を INSERT (office_id=ケアサポ / office_source=import_record /
 *   copied_from_id=NULL)。同じ row_id が複数 batch にあれば新しい batch の値。
 *   作らないもの: 元の行が消えている / 元の行が①でケアサポに付く / ケアサポに同じ認定 (開始日・保険者・被保番) が既にある
 *   ★ observe は「差がある項目があったとき」しか残っていない。完全に一致していた共有者の行は作れない → 切替前の一覧 (設計 §7.1) で複写
 *   ★ INSERT で trigger が作った care_plan_elements / doc_tasks は同じ実行内で消して op=delete (source_key cleanup:trigger) で記録
 *
 * 書込は全部 data_import_batches / data_import_rows に記録 (source_system 'kt-internal')。--revert で戻す:
 *   update → 現在値が after のままの行だけ office_id / office_source を before (NULL) に戻す (人が触った行は一覧に出す)
 *   insert → その行を DELETE (複写の元になっていたら止める)
 * 同時実行は ./_exec_lock.mjs (FY-L) で止める。
 */
import { writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";
import { officesForArea, AREA_OFFICES } from "../../kaigo-app/migrations/_area_offices.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const STEP = opt("--step"); // assign | caresapo (--execute のとき必須)
const ONLY_TABLE = opt("--table");
const ONLY_OFFICE = opt("--only-office");
const OUT = resolve(opt("--out") ?? join(tmpdir(), "assign_insurance_office_stage0.json"));
const TENANT = "kt-group";
const SOURCE_SYSTEM = "kt-internal";
const SCRIPT_REL = "apps/order-app/migrations/assign_insurance_office_stage0.mjs";
const CARESAPO = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a"; // 介護ショップケア・サポート千葉
const MARKER = "[insurance-office-stage0 ケアサポ 20261109]";
const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST
const TABLES = ["client_insurance_records", "client_public_expenses", "client_kohi_records"];
// ほのぼの福祉用具 (ケアサポ) の値を書いた script。status は見ない (failed でも書かれている)
const CARESAPO_IMPORT_SCRIPTS = ["sync_fukuyogu_from_honobono.mjs", "fix_honobono_sync_7_cases_202609.mjs"];
// 割当に数えない office (役割 tenant / 本社系)
const NON_OWNER_OFFICES = new Set([
  "00cbb92e-b0c0-43f4-adcc-97d952c39548", // 福祉用具管理者 (fukuyogu-kanri)
  "5e8a6e8d-bbcd-460f-91da-d846f6d44db7", // 統括営業本部
]);
// notes の拠点名 → _area_offices.mjs のキー (取込 script の TAG と フォルダ名が違うもの)
const AREA_ALIAS = { "姉む": "姉ム", "さつき": "さつきが丘", "リンクス茂原": "茂原" };

// ── 小道具 ────────────────────────────────────────────────────────────────
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const stop = (msg) => { console.error(`\n★ 止める: ${msg}`); process.exit(2); };
const norm = (v) => String(v ?? "").normalize("NFKC").replace(/[\s　]/g, "");

function readEnv() {
  const env = {};
  for (const l of readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8").split(/\r?\n/)) { const i = l.indexOf("="); if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ""); }
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  return env;
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
async function selectIn(sb, table, select, col, ids, extra = (q) => q) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll(sb, table, select, (q) => extra(q.in(col, c))));
  return out;
}
/** 列が有るか (SQL 適用前でも DRY RUN を回すため) */
async function hasColumns(sb, table, cols) {
  const { error } = await sb.from(table).select(cols.join(",")).limit(1);
  return !error;
}

// ── 判定 ─────────────────────────────────────────────────────────────────
/** notes → { cat, system?, area? }  system: 居宅介護支援 | 訪問介護 */
function classifyNotes(table, notes) {
  const n = notes ?? "";
  if (/\[fake テスト用/.test(n)) return { cat: "Z テスト" };
  let m;
  if ((m = n.match(/\[居宅STEP1 \d{4}-\d{2}(?:-\d{2})? ([^\]\s]+)\]/))) return { cat: "A2 居宅STEP1", system: "居宅介護支援", area: m[1] };
  if (table === "client_insurance_records") {
    if ((m = n.match(/\[MEISAI-STEP1 \d{4}-\d{2}(?:-\d{2})? ([^\]\s]+)\]/))) return { cat: "A2 MEISAI-STEP1", system: "訪問介護", area: m[1] };
    if (/\[MEISAI-STEP1 \d{4}-\d{2}(?:-\d{2})?\]/.test(n)) return { cat: "B MEISAI-STEP1 拠点名なし", system: "訪問介護" };
    if (/\[(KYOTAKU-SYNC|KYOTAKU-CSV|伝送取込)[ \]]/.test(n)) return { cat: "B 居宅 (KYOTAKU-SYNC/CSV・伝送取込)", system: "居宅介護支援" };
    if (/\[honobono-sync-/.test(n)) return { cat: "C honobono-sync マーカーのみ (取込記録なし)" };
    if (/\[認定履歴取込/.test(n)) return { cat: "C 認定履歴取込" };
    if (/\[(認定バックフィル|利用票取込)/.test(n)) return { cat: "C 認定バックフィル・利用票取込" };
  }
  if (table === "client_kohi_records") {
    if ((m = n.match(/\[MEISAI公費 \d{4}-\d{2}(?:-\d{2})? ([^\]\s]+)\]/))) return { cat: "A2 MEISAI公費", system: "訪問介護", area: m[1] };
    if (/\[公費マスタ/.test(n)) return { cat: "C 公費マスタ" };
  }
  return { cat: n.trim() ? "C その他の notes" : "C notes なし" };
}

function buildContext(offices, coa) {
  const off = new Map(offices.map((o) => [o.id, o]));
  const isOwner = (id) => off.has(id) && !NON_OWNER_OFFICES.has(id);
  const cur = new Map(); const ended = new Map();
  for (const a of coa) {
    if (!isOwner(a.office_id)) continue;
    const active = !a.end_date || a.end_date >= TODAY;
    const m = active ? cur : ended;
    if (!m.has(a.client_id)) m.set(a.client_id, []);
    m.get(a.client_id).push(a);
  }
  const uniq = (arr) => [...new Set(arr.map((a) => a.office_id))];
  const curOffices = (cid, system) => uniq((cur.get(cid) ?? []).filter((a) => !system || off.get(a.office_id)?.service_type === system));
  const lastEnded = (cid, system) => {
    const list = (ended.get(cid) ?? []).filter((a) => !system || off.get(a.office_id)?.service_type === system)
      .sort((x, y) => (y.end_date ?? "").localeCompare(x.end_date ?? "") || (y.start_date ?? "").localeCompare(x.start_date ?? ""));
    return list[0]?.office_id ?? null;
  };
  const allOffices = (cid) => new Set([...(cur.get(cid) ?? []), ...(ended.get(cid) ?? [])].map((a) => a.office_id));
  // 拠点名 → その制度の事業所 (完全一致を優先。_area_offices.mjs の前方一致は「リンクスヘルパーステーション」で山武等も拾うため)
  const areaCache = new Map();
  const areaOffices = (area, system) => {
    const key = `${area}|${system}`;
    if (areaCache.has(key)) return areaCache.get(key);
    const folder = AREA_ALIAS[area] ?? area;
    let list = officesForArea(folder, offices).filter((o) => o.service_type === system);
    if (list.length > 1) {
      // 前方一致で複数 → 名前が完全一致するものに絞る (例: 茂原 → リンクスヘルパーステーション。前方一致だと山武・東郷等も拾う)
      const wants = AREA_OFFICES[folder];
      const ex = Array.isArray(wants) ? list.filter((o) => wants.some((w) => norm(w) === norm(o.name))) : [];
      if (ex.length) list = ex;
    }
    areaCache.set(key, list.map((o) => o.id));
    return areaCache.get(key);
  };
  return { off, curOffices, lastEnded, allOffices, areaOffices };
}

/** 1 行の事業所を決める → { office_id, office_source, cat, reason } */
function decide(table, row, ctx, importRec) {
  if (importRec) return { office_id: CARESAPO, office_source: "import_record", cat: `A1 取込記録 (${importRec.op})`, reason: `batch ${importRec.batch.slice(0, 8)} ${importRec.script}` };
  const c = classifyNotes(table, row.notes);
  if (c.cat.startsWith("Z")) return { office_id: null, office_source: null, cat: c.cat, reason: "テスト行 (別途削除)" };
  if (c.area) {
    const cand = ctx.areaOffices(c.area, c.system);
    if (cand.length === 1) return { office_id: cand[0], office_source: "notes_marker", cat: c.cat, reason: `拠点 ${c.area}` };
    if (cand.length > 1) {
      const mine = cand.filter((id) => ctx.allOffices(row.client_id).has(id));
      if (mine.length === 1) return { office_id: mine[0], office_source: "notes_marker", cat: c.cat, reason: `拠点 ${c.area} (候補 ${cand.length} のうち割当と重なる 1 つ)` };
    }
    // 拠点名から決まらない → 制度だけ分かる (B) と同じ扱い
    return decideBySystem(row, ctx, c.system, `${c.cat} → 拠点 ${c.area} で決まらず (候補 ${cand.length})`);
  }
  if (c.system) return decideBySystem(row, ctx, c.system, c.cat);
  // C
  const curAll = ctx.curOffices(row.client_id, null);
  if (curAll.length === 1) return { office_id: curAll[0], office_source: "assignment_single", cat: c.cat, reason: "現割当 1" };
  if (curAll.length > 1) return { office_id: null, office_source: null, cat: c.cat, reason: `現割当 ${curAll.length} → 事業所未定` };
  const e = ctx.lastEnded(row.client_id, null);
  if (e) return { office_id: e, office_source: "ended_assignment", cat: c.cat, reason: "現割当 0 → 最後に終了した割当" };
  return { office_id: null, office_source: null, cat: c.cat, reason: "割当なし (終了済みも無し) → 事業所未定" };
}
function decideBySystem(row, ctx, system, cat) {
  const cur = ctx.curOffices(row.client_id, system);
  if (cur.length === 1) return { office_id: cur[0], office_source: "system_single", cat, reason: `${system} の現割当 1` };
  if (cur.length > 1) return { office_id: null, office_source: null, cat, reason: `${system} の現割当 ${cur.length} → 事業所未定` };
  const e = ctx.lastEnded(row.client_id, system);
  if (e) return { office_id: e, office_source: "ended_assignment", cat, reason: `${system} の現割当 0 → 最後に終了した ${system} の割当` };
  return { office_id: null, office_source: null, cat, reason: `${system} の割当なし → 事業所未定` };
}

// ── 計画 ─────────────────────────────────────────────────────────────────
async function plan(sb) {
  const offices = await selectAll(sb, "offices", "id,name,service_type,app_type,tenant_id");
  const coa = await selectAll(sb, "client_office_assignments", "id,client_id,office_id,start_date,end_date");
  const clients = await selectAll(sb, "clients", "id,deleted_at");
  const ctx = buildContext(offices, coa);
  const batches = await selectAll(sb, "data_import_batches", "id,script,status,source_system,created_at");
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const base = (s) => String(s ?? "").split("/").pop();
  const csBatchIds = batches.filter((b) => CARESAPO_IMPORT_SCRIPTS.includes(base(b.script))).map((b) => b.id);

  const tables = ONLY_TABLE ? [ONLY_TABLE] : TABLES;
  for (const t of tables) if (!TABLES.includes(t)) stop(`--table は ${TABLES.join(" / ")} のどれか`);
  const sqlApplied = {};
  const plans = [];
  const importStats = {};
  for (const t of tables) {
    sqlApplied[t] = await hasColumns(sb, t, ["office_id", "office_source", "copied_from_id"]);
    const hasUpd = t !== "client_public_expenses" || await hasColumns(sb, t, ["updated_at"]);
    const notesCol = t === "client_public_expenses" ? "" : ",notes";
    const sel = `id,client_id,created_at${notesCol}${hasUpd ? ",updated_at" : ""}${sqlApplied[t] ? ",office_id,office_source" : ""}`;
    const rows = await selectAll(sb, t, sel);
    // 取込記録 (insert / update) → ケアサポ
    const recs = await selectIn(sb, "data_import_rows", "id,batch_id,row_id,op", "batch_id", csBatchIds, (q) => q.eq("table_name", t).in("op", ["insert", "update"]));
    const recByRow = new Map();
    for (const r of recs) { const b = batchById.get(r.batch_id); if (!recByRow.has(r.row_id) || r.op === "insert") recByRow.set(r.row_id, { op: r.op, batch: r.batch_id, script: base(b?.script) }); }
    const live = new Set(rows.map((r) => r.id));
    importStats[t] = { 取込記録_insert: recs.filter((r) => r.op === "insert").length, 取込記録_update: recs.filter((r) => r.op === "update").length, 取込記録のうち今も在る行: [...recByRow.keys()].filter((id) => live.has(id)).length };
    for (const r of rows) {
      if (sqlApplied[t] && r.office_id) { plans.push({ table: t, id: r.id, client_id: r.client_id, office_id: r.office_id, office_source: r.office_source, cat: "(既に付いている)", reason: "触らない", skip: true }); continue; }
      const d = decide(t, r, ctx, recByRow.get(r.id));
      // 取込記録 update の行で、普通の規則なら別の事業所になるもの (報告用)
      let alt = null;
      if (d.cat === "A1 取込記録 (update)") { const a = decide(t, r, ctx, null); if (a.office_id !== CARESAPO) alt = a; }
      plans.push({ table: t, id: r.id, client_id: r.client_id, notes: r.notes ?? null, updated_at: r.updated_at ?? null, ...d, alt });
    }
  }

  // ② ケアサポの行 (observe 由来)
  const inserts = [];
  const insSkip = [];
  let observeCount = 0;
  if (tables.includes("client_insurance_records")) {
    const obs = await selectIn(sb, "data_import_rows", "id,batch_id,row_id,source_key,after,created_at", "batch_id", csBatchIds, (q) => q.eq("table_name", "client_insurance_records").eq("op", "observe"));
    observeCount = obs.length;
    // 同じ row_id は新しい batch の値
    const latest = new Map();
    for (const o of obs.sort((a, b) => (batchById.get(a.batch_id)?.created_at ?? "").localeCompare(batchById.get(b.batch_id)?.created_at ?? "") || a.created_at.localeCompare(b.created_at))) latest.set(o.row_id, o);
    const baseRows = await selectIn(sb, "client_insurance_records", "*", "id", [...latest.keys()]);
    const baseById = new Map(baseRows.map((r) => [r.id, r]));
    const planById = new Map(plans.filter((p) => p.table === "client_insurance_records").map((p) => [p.id, p]));
    // ケアサポに付く既存行 (重複検査用)
    const allIns = await selectAll(sb, "client_insurance_records", "id,client_id,certification_start_date,insurer_number,insured_number");
    const certKey = (r) => `${r.client_id}|${r.certification_start_date ?? ""}|${r.insurer_number ?? ""}|${r.insured_number ?? ""}`;
    const csKeys = new Set(allIns.filter((r) => planById.get(r.id)?.office_id === CARESAPO).map(certKey));
    const droppedKeys = {};
    for (const [rowId, o] of latest) {
      const b = baseById.get(rowId);
      if (!b) { insSkip.push({ row_id: rowId, why: "元の行が消えている (後の掃除で削除済み)", observe: o.id }); continue; }
      if (planById.get(rowId)?.office_id === CARESAPO) { insSkip.push({ row_id: rowId, client_id: b.client_id, why: "元の行が①でケアサポに付く (作らない)", observe: o.id }); continue; }
      const patch = {};
      for (const [k, v] of Object.entries(o.after ?? {})) { if (k in b) patch[k] = v; else droppedKeys[k] = (droppedKeys[k] ?? 0) + 1; }
      const row = {};
      for (const [k, v] of Object.entries(b)) if (!["id", "created_at", "updated_at", "office_id", "office_source", "copied_from_id"].includes(k)) row[k] = v;
      Object.assign(row, patch);
      row.notes = `${MARKER} 元の行 ${rowId} + ほのぼの福祉用具の値 (observe batch ${o.batch_id.slice(0, 8)})`;
      if (sqlApplied.client_insurance_records) { row.office_id = CARESAPO; row.office_source = "import_record"; row.copied_from_id = null; }
      const k = certKey(row);
      if (csKeys.has(k)) { insSkip.push({ row_id: rowId, client_id: b.client_id, why: "ケアサポに同じ認定 (開始日・保険者・被保番) が既にある", observe: o.id }); continue; }
      csKeys.add(k);
      inserts.push({ base_row_id: rowId, observe_id: o.id, observe_batch: o.batch_id, source_key: o.source_key, patchKeys: Object.keys(patch), row });
    }
    if (Object.keys(droppedKeys).length) console.log(`  ⚠ observe の after のうち 表に無い列 (捨てた): ${JSON.stringify(droppedKeys)}`);
  }

  // 共有の人 (福祉用具 + 居宅/訪問介護 の現割当) の 2026-09 のケアサポ行の有無 (計画後)
  const fuku = new Set(offices.filter((o) => o.service_type === "福祉用具").map((o) => o.id));
  const sharedIds = clients.filter((c) => !c.deleted_at).map((c) => c.id).filter((id) => {
    const cur = ctx.curOffices(id, null);
    return cur.some((x) => fuku.has(x)) && cur.some((x) => ["居宅介護支援", "訪問介護"].includes(ctx.off.get(x)?.service_type));
  });
  return { plans, inserts, insSkip, observeCount, sqlApplied, importStats, ctx, offices, sharedIds };
}

async function sharedCoverage(sb, P, month = "2026-09") {
  const ms = `${month}-01`, me = `${month}-30`;
  const ids = new Set(P.sharedIds);
  const rows = await selectIn(sb, "client_insurance_records", "id,client_id,certification_start_date,certification_end_date", "client_id", [...ids]);
  const planById = new Map(P.plans.filter((p) => p.table === "client_insurance_records").map((p) => [p.id, p]));
  const valid = (r) => r.certification_start_date && r.certification_start_date <= me && (!r.certification_end_date || r.certification_end_date >= ms);
  const csHas = new Set(rows.filter((r) => valid(r) && planById.get(r.id)?.office_id === CARESAPO).map((r) => r.client_id));
  const csAfter = new Set(csHas);
  for (const i of P.inserts) if (ids.has(i.row.client_id) && valid(i.row)) csAfter.add(i.row.client_id);
  const anyValid = new Set(rows.filter(valid).map((r) => r.client_id));
  return { 共有の人: ids.size, [`${month} にケアサポの当月有効行あり (①のみ)`]: csHas.size, [`${month} にケアサポの当月有効行あり (①+②)`]: csAfter.size,
    [`${month} にケアサポ行が無く 他の当月有効行はある (= 切替前の一覧で複写)`]: [...ids].filter((id) => !csAfter.has(id) && anyValid.has(id)).length,
    [`${month} に当月有効行がどこにも無い`]: [...ids].filter((id) => !anyValid.has(id)).length };
}

function report(P, cov) {
  const name = (id) => (id ? P.ctx.off.get(id)?.name ?? id : "(NULL 事業所未定)");
  const plans = P.plans.filter((p) => !p.skip && (!ONLY_OFFICE || p.office_id === ONLY_OFFICE));
  console.log("\n══ SQL (列) の適用状況 ══");
  for (const [t, ok] of Object.entries(P.sqlApplied)) console.log(`  ${t}: ${ok ? "列あり" : "列なし (insurance_per_office_stage0.sql 未適用。DRY RUN のみ可)"}`);
  console.log("\n══ 取込記録 (data_import_rows・ほのぼの福祉用具) ══");
  console.log(JSON.stringify(P.importStats, null, 1));
  const skipped = P.plans.filter((p) => p.skip).length;
  if (skipped) console.log(`\n既に office_id が付いている行 (触らない): ${skipped}`);
  for (const t of TABLES) {
    const ps = plans.filter((p) => p.table === t);
    if (!ps.length) continue;
    console.log(`\n══ ${t} — ${ps.length} 行 ══`);
    console.log("  office_source 別:", JSON.stringify(countBy(ps, (p) => p.office_source ?? "NULL")));
    console.log("  区分 × office_source:");
    const g = countBy(ps, (p) => `${p.cat} → ${p.office_source ?? "NULL"}`);
    for (const [k, v] of Object.entries(g).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)}  ${k}`);
    console.log("  NULL の理由:");
    for (const [k, v] of Object.entries(countBy(ps.filter((p) => !p.office_id), (p) => p.reason.replace(/\d+ →/, "N →"))).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(6)}  ${k}`);
    console.log("  事業所別 (行 / 人):");
    const byOff = new Map();
    for (const p of ps) { const k = p.office_id ?? ""; if (!byOff.has(k)) byOff.set(k, { rows: 0, cl: new Set(), src: {} }); const x = byOff.get(k); x.rows++; x.cl.add(p.client_id); x.src[p.office_source ?? "NULL"] = (x.src[p.office_source ?? "NULL"] ?? 0) + 1; }
    for (const [k, x] of [...byOff].sort((a, b) => b[1].rows - a[1].rows)) console.log(`    ${String(x.rows).padStart(6)} 行 ${String(x.cl.size).padStart(5)} 人  ${name(k || null)}  ${JSON.stringify(x.src)}`);
    const alt = ps.filter((p) => p.alt);
    if (alt.length) console.log(`  ⚠ 取込記録 (update) でケアサポに付けるが、普通の規則なら別になる行: ${alt.length} (${JSON.stringify(countBy(alt, (p) => `${p.alt.office_source ?? "NULL"}:${name(p.alt.office_id)}`))})`);
  }
  console.log(`\n══ ② ケアサポの行の作成 (observe 由来・段階 1) ══`);
  console.log(`  observe 記録 ${P.observeCount} 行 → 元の行 (row_id) で畳んで 作る ${P.inserts.length} 行 / 作らない ${P.insSkip.length} 行`);
  console.log("  作らない理由:", JSON.stringify(countBy(P.insSkip, (s) => s.why)));
  console.log(`  作る行の人数: ${new Set(P.inserts.map((i) => i.row.client_id)).size} 名 / observe batch 別: ${JSON.stringify(countBy(P.inserts, (i) => i.observe_batch.slice(0, 8)))}`);
  console.log("  上書きする項目 (件数):", JSON.stringify(countBy(P.inserts.flatMap((i) => i.patchKeys), (k) => k)));
  if (cov) { console.log("\n══ 共有の人 (福祉用具 + 居宅/訪問介護 の現割当) のケアサポ行 ══"); console.log(JSON.stringify(cov, null, 1)); }
}

// ── 実行 ─────────────────────────────────────────────────────────────────
async function execute(sb, P, lock) {
  if (!STEP || !["assign", "caresapo"].includes(STEP)) stop("--execute には --step assign か --step caresapo を付ける (1 回に 1 つ)");
  for (const t of Object.keys(P.sqlApplied)) if (!P.sqlApplied[t]) stop(`${t} に office_id 等の列が無い。migrations/insurance_per_office_stage0.sql を先に適用`);
  for (const t of ["data_import_batches", "data_import_rows"]) { const { error } = await sb.from(t).select("id").limit(1); if (error) stop(`出どころ記録の表 ${t} が無い (${error.message})`); }
  if (STEP === "caresapo") {
    const { count, error } = await sb.from("client_insurance_records").select("id", { count: "exact", head: true }).eq("office_id", CARESAPO).eq("office_source", "import_record");
    if (error) throw new Error(error.message);
    if (!count) stop("ケアサポの取込行にまだ office_id が付いていない。先に --step assign --execute");
    if (!P.inserts.length) stop("作る行が 0");
  }
  const work = STEP === "assign" ? P.plans.filter((p) => !p.skip && p.office_id && (!ONLY_OFFICE || p.office_id === ONLY_OFFICE)) : P.inserts;
  const batch = await execLockAcquire(sb, lock, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: `insurance-office-stage0:${STEP}`,
    notes: STEP === "assign" ? `段階0 既存行に事業所を付ける ${work.length} 行 (DESIGN_INSURANCE_PER_OFFICE.md §5.2)` : `段階1 ケアサポの行を observe から作る ${work.length} 行 (DESIGN §5.3)`,
  });
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => { const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH); if (error) console.error(`batch を failed にできない: ${error.message}`); throw new Error(msg); };
  const record = async (rows) => { for (const c of chunks(rows, 500)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); } };
  let written = 0; const notUpdated = [];
  if (STEP === "assign") {
    const groups = new Map();
    for (const p of work) { const k = `${p.table}|${p.office_id}|${p.office_source}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
    for (const [k, ps] of groups) {
      const [table, office_id, office_source] = k.split("|");
      for (const c of chunks(ps, 150)) {
        const { data, error } = await sb.from(table).update({ office_id, office_source }).in("id", c.map((p) => p.id)).is("office_id", null).select("id");
        if (error) await fail(`update ${table}: ${error.message}`);
        const got = new Set((data ?? []).map((r) => r.id));
        for (const p of c) if (!got.has(p.id)) notUpdated.push(p.id);
        await record(c.filter((p) => got.has(p.id)).map((p) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: p.id, op: "update", source_key: p.cat,
          source_ref: { reason: p.reason, notes: p.notes ?? null }, before: { office_id: null, office_source: null, updated_at: p.updated_at ?? null }, after: { office_id, office_source } })));
        written += got.size;
      }
      process.stdout.write(`\r  update ${written}/${work.length}`);
    }
  } else {
    // 全行で同じキー集合 (memory feedback_batch_insert_key_mismatch_null_fill)
    const keys = new Set(work.flatMap((i) => Object.keys(i.row)));
    const ids = [];
    for (const c of chunks(work, 100)) {
      const rows = c.map((i) => Object.fromEntries([...keys].map((k) => [k, k in i.row ? i.row[k] : null])));
      const { data, error } = await sb.from("client_insurance_records").insert(rows).select("*");
      if (error) await fail(`insert client_insurance_records: ${error.message}`);
      if ((data ?? []).length !== c.length) await fail(`insert の戻りが ${data?.length} 行 ≠ ${c.length}`);
      await record(data.map((r, i) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: r.id, op: "insert", source_key: c[i].source_key,
        source_ref: { base_row_id: c[i].base_row_id, observe_row: c[i].observe_id, observe_batch: c[i].observe_batch }, before: null, after: r })));
      ids.push(...data.map((r) => r.id)); written += data.length;
      process.stdout.write(`\r  insert ${written}/${work.length}`);
    }
    // trigger が作った行の掃除 (取り消しでは入れ直さない)
    for (const [t, col] of [["care_plan_elements", "ref_id"], ["doc_tasks", "trigger_ref_id"]]) {
      const made = await selectIn(sb, t, "*", col, ids);
      for (const c of chunks(made, 150)) {
        const { error, count } = await sb.from(t).delete({ count: "exact" }).in("id", c.map((r) => r.id));
        if (error || count !== c.length) await fail(`delete ${t}: ${error?.message ?? `件数 ${count} ≠ ${c.length}`}`);
        await record(c.map((r) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger", source_ref: { cleanup: true }, before: r, after: null })));
      }
      console.log(`\n  trigger が作った ${t}: ${made.length} 行を消した`);
    }
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`件数確認: ${error.message}`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH} / 書いた ${written} 行 / data_import_rows ${count} 行${notUpdated.length ? ` / ★ 既に誰かが office_id を付けていて書かなかった ${notUpdated.length} 行` : ""}。取り消しは --revert ${BATCH}`);
  console.log(`件数確認 SQL:
  SELECT 'cir' t, office_source, count(*) FROM client_insurance_records GROUP BY 1,2
  UNION ALL SELECT 'cpe', office_source, count(*) FROM client_public_expenses GROUP BY 1,2
  UNION ALL SELECT 'ckr', office_source, count(*) FROM client_kohi_records GROUP BY 1,2 ORDER BY 1,2;
  SELECT op, table_name, count(*) FROM data_import_rows WHERE batch_id = '${BATCH}' GROUP BY 1,2;`);
}

async function revert(sb, batchId) {
  const { data: b, error } = await sb.from("data_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!b) stop(`batch ${batchId} が無い`);
  if (b.script !== SCRIPT_REL) stop(`batch ${batchId} はこの script のものではない (${b.script})`);
  const recs = (await selectAll(sb, "data_import_rows", "id,table_name,row_id,op,after,source_ref", (q) => q.eq("batch_id", batchId))).filter((r) => !r.source_ref?.cleanup);
  const upd = recs.filter((r) => r.op === "update"); const ins = recs.filter((r) => r.op === "insert");
  const cur = new Map();
  for (const t of TABLES) for (const r of await selectIn(sb, t, "id,office_id,office_source", "id", [...upd, ...ins].filter((x) => x.table_name === t).map((x) => x.row_id))) cur.set(r.id, r);
  const back = upd.filter((r) => { const c = cur.get(r.row_id); return c && c.office_id === r.after.office_id && c.office_source === r.after.office_source; });
  const touched = upd.filter((r) => !back.includes(r));
  const del = ins.filter((r) => cur.has(r.row_id));
  const refs = del.length ? await selectIn(sb, "client_insurance_records", "id,copied_from_id", "copied_from_id", del.map((r) => r.row_id)) : [];
  console.log(`batch ${batchId} (${b.step} / ${b.status}): 戻す update ${back.length} / 人が触ったので戻さない ${touched.length} / 消す insert ${del.length} (既に無い ${ins.length - del.length})`);
  if (refs.length) stop(`消す行を元に [複写] した行が ${refs.length} 行ある。先にそちらを確かめる`);
  if (!EXECUTE) { console.log("DRY RUN。戻すなら --execute"); return; }
  const lock = await execLockStart(sb, { script: SCRIPT_REL, argv });
  await execLockRun(sb, lock, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `revert ${batchId}` }, async () => {
    const g = new Map();
    // 表 × 付けた事業所 ごとに戻す (現在値が after のままの行だけ = 条件にも office_id / office_source を入れる)
    for (const r of back) { const k = `${r.table_name}|${r.after.office_id}|${r.after.office_source}`; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
    for (const [k, rs] of g) {
      const [t, oid, osrc] = k.split("|");
      for (const c of chunks(rs, 150)) {
        const { error: e } = await sb.from(t).update({ office_id: null, office_source: null }).in("id", c.map((r) => r.row_id)).eq("office_id", oid).eq("office_source", osrc);
        if (e) throw new Error(`revert update ${t}: ${e.message}`);
      }
    }
    for (const c of chunks(del, 150)) {
      const { error: e, count } = await sb.from("client_insurance_records").delete({ count: "exact" }).in("id", c.map((r) => r.row_id));
      if (e || count !== c.length) throw new Error(`revert delete: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`);
    }
  });
  const status = touched.length ? "partially_reverted" : "reverted";
  const { error: e3 } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
  if (e3) throw new Error(e3.message);
  console.log(`取り消し完了 (${status})`);
}

async function main() {
  const env = readEnv();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  if (REVERT) return revert(sb, REVERT);
  const lock = EXECUTE ? await execLockStart(sb, { script: SCRIPT_REL, argv }) : null; // ★ 計画の DB 読みより前
  console.log(`${EXECUTE ? "★ EXECUTE" : "DRY RUN"} / 今日 ${TODAY}${ONLY_TABLE ? ` / 表 ${ONLY_TABLE}` : ""}${ONLY_OFFICE ? ` / 事業所 ${ONLY_OFFICE}` : ""}`);
  const P = await plan(sb);
  const cov = !ONLY_TABLE || ONLY_TABLE === "client_insurance_records" ? await sharedCoverage(sb, P) : null;
  report(P, cov);
  const name = (id) => (id ? P.ctx.off.get(id)?.name ?? id : null);
  writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString(), today: TODAY, sqlApplied: P.sqlApplied,
    assign: P.plans.filter((p) => !p.skip).map((p) => ({ table: p.table, id: p.id, client_id: p.client_id, office_id: p.office_id, office: name(p.office_id), office_source: p.office_source, cat: p.cat, reason: p.reason, alt: p.alt ? { office: name(p.alt.office_id), office_source: p.alt.office_source } : undefined })),
    caresapo_insert: P.inserts.map((i) => ({ base_row_id: i.base_row_id, client_id: i.row.client_id, cert: [i.row.certification_start_date, i.row.certification_end_date], care_level: i.row.care_level, patchKeys: i.patchKeys })),
    caresapo_skip: P.insSkip,
  }, null, 1));
  console.log(`\n明細: ${OUT}`);
  if (!EXECUTE) { console.log("\nDRY RUN (DB には書いていない)。実行は --step assign --execute (user 承認後)"); return; }
  await execute(sb, P, lock);
}
main().catch((e) => { console.error(e); process.exit(1); });
