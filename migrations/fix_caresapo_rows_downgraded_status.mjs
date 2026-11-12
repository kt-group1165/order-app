/**
 * 事業所別保険の段階 1 (build_caresapo_rows_from_master.mjs・2026-11-11 batch 0c46125e) が
 * 「認定済み → 申請中」で作ってしまった ケアサポの認定行を 認定済み に戻す。
 *
 *   node migrations/fix_caresapo_rows_downgraded_status.mjs                       # DRY RUN
 *   node migrations/fix_caresapo_rows_downgraded_status.mjs --execute             # 本番 (★ user 承認後)
 *   node migrations/fix_caresapo_rows_downgraded_status.mjs --revert <batch_id> [--execute]
 *
 * 背景 (2026-11-13): ほのぼのの利用者マスタの「認定状況=申請中」は 更新申請中の印で、その期間も ほのぼのは請求している。
 *   段階 1 はマスタの状態をそのまま写したため、元の行 (copied_from_id) が 認定済み なのに ケアサポの行が 申請中 になった。
 *   申請中の行は BillingTab の月遅れ自動判定で請求から外れる。規則: lib/insurance/certStatus.ts (08a8b58 で段階 1 側も修正済み)
 *
 * 対象 (DB から機械的に選ぶ。名前の決め打ちはしない):
 *   client_insurance_records で office_id = ケアサポ・office_source = import_record・certification_status = 申請中・
 *   要介護度あり・copied_from_id の行が 認定済み のもの。2026-11-13 の DRY RUN では 2 行 (吉田 絢子・箱﨑 国昭) のはず。
 * 書くもの: certification_status を 認定済み に (update は id と 今の状態 = 申請中 を条件に。件数 1 を確認)。
 * 記録: data_import_batches / data_import_rows (op=update、before/after)。--revert で before に戻す。
 */
import { writeFileSync } from "node:fs";
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
const { TENANT, readEnv } = core;

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const SCRIPT_REL = "apps/order-app/migrations/fix_caresapo_rows_downgraded_status.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "fix-caresapo-rows-downgraded-status";
const CS = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
let EXEC_LOCK = null;

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
const hasLevel = (s) => { const v = (s ?? "").normalize("NFKC").trim(); return v !== "" && !/申請|非該当|なし/.test(v); };

async function plan(sb) {
  const rows = await selectAll(sb, "client_insurance_records",
    "id,client_id,care_level,certification_status,certification_start_date,certification_end_date,copied_from_id,office_id,office_source",
    (q) => q.eq("tenant_id", TENANT).eq("office_id", CS).eq("office_source", "import_record").eq("certification_status", "申請中").not("copied_from_id", "is", null));
  const cand = rows.filter((r) => hasLevel(r.care_level));
  const ops = [], skipped = [];
  for (const r of cand) {
    const { data: src, error } = await sb.from("client_insurance_records").select("id,certification_status,care_level").eq("id", r.copied_from_id).maybeSingle();
    if (error) throw new Error(`元の行 ${r.copied_from_id}: ${error.message}`);
    const { data: c, error: ce } = await sb.from("clients").select("name,user_number").eq("id", r.client_id).maybeSingle();
    if (ce) throw new Error(`clients ${r.client_id}: ${ce.message}`);
    if (src?.certification_status !== "認定済み") { skipped.push(`${c?.name ?? r.client_id}: 元の行が ${src?.certification_status ?? "無い"} → 直さない`); continue; }
    ops.push({ rec: r, client: c, before: { certification_status: r.certification_status }, patch: { certification_status: "認定済み" } });
  }
  return { ops, skipped, scanned: rows.length };
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `段階 1 で 認定済み → 申請中 で作られた ケアサポの認定行 ${ops.length} 行を 認定済み に戻す`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fix_caresapo_rows_downgraded_status_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { error, count } = await sb.from("client_insurance_records").update(o.patch, { count: "exact" })
      .eq("id", o.rec.id).eq("certification_status", "申請中");
    if (error || count !== 1) await fail(`${o.client?.name}: ${error?.message ?? `件数 ${count}`}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: o.rec.id, op: "update",
      source_key: o.client?.user_number ?? null, source_ref: { 氏名: o.client?.name, 利用者番号: o.client?.user_number, 元の行: o.rec.copied_from_id, 理由: "段階1が認定済み→申請中で作った" }, before: o.before, after: o.patch });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 行。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 戻す ${recs.length} 行`);
  for (const r of recs) console.log(`  - ${r.source_ref?.氏名 ?? r.row_id}: ${JSON.stringify(r.after)} → ${JSON.stringify(r.before)}`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し` }, async () => {
    for (const r of recs) {
      const { error, count } = await sb.from("client_insurance_records").update(r.before, { count: "exact" }).eq("id", r.row_id);
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
const { ops, skipped, scanned } = await plan(sb);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  ケアサポ・import_record・申請中・複写元ありの行 ${scanned} 行を見て、直す ${ops.length} 行`);
for (const o of ops) console.log(`  - ${o.client?.name} (${o.client?.user_number}) 行 ${o.rec.id} ${o.rec.care_level} ${o.rec.certification_start_date}〜${o.rec.certification_end_date}  ${JSON.stringify(o.before)} → ${JSON.stringify(o.patch)} (元の行 ${o.rec.copied_from_id} = 認定済み)`);
if (skipped.length) console.log(`\n直さない:\n${skipped.map((s) => `  - ${s}`).join("\n")}`);
if (EXECUTE && ops.length) await execute(sb, ops);
if (!EXECUTE) console.log("\nDRY RUN — DB は書き換えていない。--execute で本番 (★ user 承認後)");
