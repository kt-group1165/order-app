/**
 * 事業所別保険 段階 1 の残り: ケアサポの割当があるのに ケアサポの認定行が 1 行も無い利用者に、
 * ほのぼの福祉用具の利用者マスタ (介護保険 CSV = ケアサポ自身の入力) に載っている認定でケアサポの行を作る。
 *
 *   node migrations/build_caresapo_rows_from_master.mjs              # DRY RUN
 *   node migrations/build_caresapo_rows_from_master.mjs --execute
 *   node migrations/build_caresapo_rows_from_master.mjs --revert <batch_id> [--execute]
 *
 * 背景 (2026-11-11): assign_insurance_office_stage0.mjs --step caresapo (batch 1f13f235) は 11/09 の取込で
 *   「値が違った」(observe) 共有利用者の行しか作れない。ほのぼのと完全に一致していた人は記録が無く、
 *   ケアサポを per_office にすると 2026-09 で 9 名 (牧本 和身・折原 つる・守田 洋司・石島 和子・安藤 清彦・
 *   勝畑 百里子・中村 まさ子・板垣 きみ子・大槻 千代子) が「認定なし」で伝送から外れる (--as-per-office で実測)。
 *   user 方針 (2026-11-11): ケアサポの保険情報はほのぼの福祉用具に合わせてよい。
 * 作り方: 利用者マスタの認定 1 世代ごとに、DB の同じ (被保番, 認定開始日) の行 (どの事業所でも) を元にして
 *   office_id = ケアサポ / copied_from_id = 元の行 / office_source = 'import_record' で INSERT。
 *   要介護度・認定状況・認定終了日 はマスタの値にする (他の列は元の行のまま)。
 *   元の行が見つからない世代は作らず一覧に出す。認定終了が 2026-04-01 より前の世代は作らない。
 * ★ copied_from_id があるので care_plan_elements の trigger は何もしない (insurance_per_office_stage0.sql)。念のため件数を確認する。
 * 記録: data_import_batches / data_import_rows (op=insert)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
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
// 認定状況の規則は lib/insurance/certStatus.ts の 1 か所 (逐語コピーしない。check:cert-status)
const { certStatusFromHonobono, mayOverwriteCertStatus } = await import("../lib/insurance/certStatus.ts");
const { TENANT, readEnv } = core;

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const SCRIPT_REL = "apps/order-app/migrations/build_caresapo_rows_from_master.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "insurance-office-stage1:caresapo-from-master";
const CS = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
const BASE = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const MASTER_FILES = [
  "利用者マスタ_20261109/介護保険_全件_保険と認定.CSV",
  "利用者マスタ_全件_20261109/介護保険_利用登録無_全件_保険と認定.CSV",
];
const FROM_END = "2026-04-01";
const SKIP_COLS = new Set(["id", "created_at", "updated_at"]);
let EXEC_LOCK = null;

const parseLine = (l) => (l.match(/("([^"]*)"|[^,]*)(,|$)/g) || []).map((s) => s.replace(/,$/, "").replace(/^"|"$/g, ""));
const pad10 = (s) => String(s ?? "").trim().padStart(10, "0");
const ymd = (s) => (s ? s.replaceAll("/", "-").slice(0, 10) : null);
const level = (s) => (s ? s.normalize("NFKC").trim() : null);
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

async function makeSb() {
  const env = readEnv();
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
async function selectAll(sb, table, select, build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

function loadMaster() {
  const m = new Map(); // 利用者番号 → [{ insured, start, end, status, level }]
  const byIns = new Map(); // 被保番 (10 桁) → 同じ形 (★ 共有の人は clients.user_number が kaigo の番号なので 被保番でも引く)
  for (const f of MASTER_FILES) {
    const lines = new TextDecoder("shift_jis").decode(readFileSync(join(BASE, f))).split(/\r?\n/).filter(Boolean);
    const hd = parseLine(lines[0]);
    const col = (name) => { const i = hd.indexOf(name); if (i < 0) throw new Error(`${f}: 列「${name}」が無い`); return i; };
    const iNo = col("被保険者番号"), iSt = col("認定状況"), iLv = col("要介護度"), iS = col("認定有効期間－開始日"), iE = col("認定有効期間－終了日");
    for (const l of lines.slice(1)) {
      const r = parseLine(l);
      if (!r[0] || !r[iNo] || !r[iS]) continue;
      if (!m.has(r[0])) m.set(r[0], []);
      const g = { insured: pad10(r[iNo]), start: ymd(r[iS]), end: ymd(r[iE]), status: r[iSt] || null, level: level(r[iLv]) };
      if (!m.get(r[0]).some((x) => x.insured === g.insured && x.start === g.start)) m.get(r[0]).push(g);
      if (!byIns.has(g.insured)) byIns.set(g.insured, []);
      if (!byIns.get(g.insured).some((x) => x.start === g.start)) byIns.get(g.insured).push(g);
    }
  }
  return { byUser: m, byIns };
}

async function plan(sb) {
  const master = loadMaster();
  const own = await selectAll(sb, "clients", "id,name,user_number", (q) => q.eq("tenant_id", TENANT).eq("office_id", CS).is("deleted_at", null));
  const have = new Set(own.map((c) => c.id));
  const asg = [...new Set((await selectAll(sb, "client_office_assignments", "id,client_id", (q) => q.eq("office_id", CS))).map((a) => a.client_id))].filter((id) => !have.has(id));
  const clients = [...own];
  for (const c of chunks(asg, 150)) clients.push(...await selectAll(sb, "clients", "id,name,user_number", (q) => q.in("id", c).is("deleted_at", null)));
  const ids = clients.map((c) => c.id);
  const rows = [];
  for (const c of chunks(ids, 150)) rows.push(...await selectAll(sb, "client_insurance_records", "*", (q) => q.in("client_id", c)));
  const byClient = new Map();
  for (const r of rows) { if (!byClient.has(r.client_id)) byClient.set(r.client_id, []); byClient.get(r.client_id).push(r); }
  const ops = [], missing = [], noMaster = [], approx = [], keptCertified = [];
  for (const c of clients) {
    const rs = byClient.get(c.id) ?? [];
    if (rs.some((r) => r.office_id === CS)) continue; // ケアサポの行が 1 行でもあれば対象外 (② で作った・既存)
    // 利用者番号で引く → 無ければ その人の認定行の被保番で引く
    let gens = master.byUser.get(c.user_number) ?? [];
    if (!gens.length) {
      const insureds = new Set(rs.map((r) => pad10(r.insured_number)).filter((x) => x !== "0000000000"));
      gens = [...insureds].flatMap((i) => master.byIns.get(i) ?? []);
    }
    gens = gens.filter((g) => !g.end || g.end >= FROM_END);
    if (!gens.length) { if (rs.length) noMaster.push(`${c.name} (${c.user_number})`); continue; }
    for (const g of gens) {
      // 元の行: 同じ (被保番, 認定開始日) → 無ければ 同じ被保番で 認定開始日が最も近い行 (開始日もマスタの値にする)
      const same = rs.filter((r) => pad10(r.insured_number) === g.insured);
      const byDate = (a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
      const exact = same.filter((r) => r.certification_start_date === g.start).sort(byDate)[0];
      const dist = (r) => Math.abs(new Date(r.certification_start_date ?? "1900-01-01") - new Date(g.start));
      const src = exact ?? same.slice().sort((a, b) => dist(a) - dist(b))[0];
      if (!src) { missing.push(`${c.name} ${g.insured} ${g.start}〜${g.end ?? ""} ${g.level ?? ""} (同じ被保番の行が無い)`); continue; }
      if (!exact) approx.push(`${c.name} ${g.insured} マスタ ${g.start} ← 元の行 ${src.certification_start_date}`);
      const row = Object.fromEntries(Object.entries(src).filter(([k]) => !SKIP_COLS.has(k)));
      // ★ 2026-11-13: マスタの「申請中」は 更新申請中の印 (その期間も ほのぼのは請求している)。
      //   要介護度がある or 元の行が認定済み なら 認定済み で作る (申請中で作ると BillingTab が月遅れ扱いにする)。
      //   2026-11-11 の実行 (batch 0c46125e) では 吉田 絢子・箱﨑 国昭 の 2 行が 認定済み → 申請中 で作られていた
      //   = ① 要介護度があれば 認定済み (certStatusFromHonobono) / ② 元の行が認定済みなら 申請中に下げない (mayOverwriteCertStatus)
      const masterApplying = g.status === "申請中" && (certStatusFromHonobono(g.status, g.level) === "認定済み" || !mayOverwriteCertStatus(src.certification_status, g.status));
      if (masterApplying) keptCertified.push(`${c.name} ${g.start}〜${g.end ?? ""} ${g.level ?? src.care_level ?? ""}`);
      Object.assign(row, {
        office_id: CS, copied_from_id: src.id, office_source: "import_record",
        care_level: g.level ?? src.care_level, certification_status: masterApplying ? "認定済み" : g.status ?? src.certification_status,
        // ★ effective_date も認定開始日に (元の行のままだと同じ元から作った 2 世代が同値になり、新旧が逆に選ばれる。fix_caresapo_rows_effective_date.mjs)
        effective_date: g.start,
        certification_start_date: g.start, certification_end_date: g.end ?? src.certification_end_date,
      });
      ops.push({ client: c, src: src.id, gen: g, row });
    }
  }
  return { ops, missing, noMaster, approx, keptCertified };
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: MASTER_FILES, script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `ケアサポの認定行が無い利用者 ${new Set(ops.map((o) => o.client.id)).size} 名に利用者マスタの認定でケアサポの行を作る (${ops.length} 行)`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_caresapo_rows_from_master_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  const before = await countElements(sb, ops.map((o) => o.client.id));
  for (const o of ops) {
    const { data, error } = await sb.from("client_insurance_records").insert(o.row).select("id").single();
    if (error) await fail(`${o.client.name}: ${error.message}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: data.id, op: "insert",
      source_key: o.client.user_number, source_ref: { 氏名: o.client.name, 被保番: o.gen.insured, 認定開始: o.gen.start, 元の行: o.src }, before: null, after: o.row });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const after = await countElements(sb, ops.map((o) => o.client.id));
  console.log(`care_plan_elements (対象の人) 前 ${before} → 後 ${after}${after !== before ? " ★ trigger が行を作った。確認すること" : ""}`);
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 行。取り消しは --revert ${BATCH}`);
}

async function countElements(sb, clientIds) {
  let n = 0;
  for (const c of chunks([...new Set(clientIds)], 150)) {
    const { count, error } = await sb.from("care_plan_elements").select("id", { count: "exact", head: true }).in("client_id", c);
    if (error) { console.error(`care_plan_elements を数えられない: ${error.message}`); return -1; }
    n += count ?? 0;
  }
  return n;
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 消す ${recs.length} 行`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し` }, async () => {
    for (const r of recs) {
      const { error, count } = await sb.from("client_insurance_records").delete({ count: "exact" }).eq("id", r.row_id).eq("office_id", CS);
      if (error || count !== 1) throw new Error(`revert ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
    }
    const { error } = await sb.from("data_import_batches").update({ status: "reverted", reverted_at: new Date().toISOString() }).eq("id", batchId);
    if (error) throw new Error(`batch: ${error.message}`);
    console.log("取り消し完了");
  });
}

const sb = await makeSb();
if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv });
if (REVERT) { await revert(sb, REVERT); process.exit(0); }
const { ops, missing, noMaster, approx, keptCertified } = await plan(sb);
const people = new Map();
for (const o of ops) { const k = `${o.client.name} (${o.client.user_number})`; people.set(k, [...(people.get(k) ?? []), `${o.gen.start}〜${o.gen.end ?? ""} ${o.gen.level ?? ""} ${o.gen.status ?? ""}`]); }
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  作る ${ops.length} 行 / ${people.size} 名`);
for (const [k, v] of people) console.log(`  - ${k}: ${v.join(" / ")}`);
console.log(`\n開始日が違う行を元にした世代 ${approx.length} (開始日はマスタの値):`);
for (const m of approx) console.log(`  - ${m}`);
console.log(`
マスタは申請中だが 認定済み で作る世代 (申請中 = 更新申請中の印・下げない) ${keptCertified.length}:`);
for (const m of keptCertified) console.log(`  - ${m}`);
console.log(`\n元の行が見つからず作らない世代 ${missing.length}:`);
for (const m of missing) console.log(`  - ${m}`);
console.log(`\nケアサポの行が無く 利用者マスタにも認定が無い (2026-04 以降) 人 ${noMaster.length}: ${noMaster.join(", ")}`);
if (EXECUTE && ops.length) await execute(sb, ops);
