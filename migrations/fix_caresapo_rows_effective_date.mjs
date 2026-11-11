/**
 * build_caresapo_rows_from_master.mjs (batch 0c46125e) で作ったケアサポの認定行の effective_date を 認定開始日に揃える。
 *
 *   node migrations/fix_caresapo_rows_effective_date.mjs              # DRY RUN
 *   node migrations/fix_caresapo_rows_effective_date.mjs --execute
 *   node migrations/fix_caresapo_rows_effective_date.mjs --revert <batch_id> [--execute]
 *
 * 背景 (2026-11-11): 元の行を写したので effective_date が元の行のまま (または空) だった (222 行中 45 行)。
 *   同じ元の行から 2 世代作った人 (山越 京子: 〜6/14 要介護1 / 6/15〜 要介護5) は effective_date が同値になり、
 *   「当月有効な認定のうち effective_date 最新」で選ぶ請求画面・検査が 6 月に 要介護1 を選んだ
 *   (check:keido-exception 151→156 の +5 は全部この人)。認定の世代の新旧は 認定開始日で表すのが正しい。
 * 記録: data_import_batches / data_import_rows (op=update、before/after)。
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
const SRC_BATCH = "0c46125e-1ae0-4599-9fec-2fb1f90a785d";
const SCRIPT_REL = "apps/order-app/migrations/fix_caresapo_rows_effective_date.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "insurance-office-stage1:fix-effective-date";
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

async function plan(sb) {
  const recs = await selectAll(sb, "data_import_rows", "row_id,source_ref", (q) => q.eq("batch_id", SRC_BATCH).eq("op", "insert"));
  const ids = recs.map((r) => r.row_id);
  const rows = [];
  for (let i = 0; i < ids.length; i += 150) rows.push(...await selectAll(sb, "client_insurance_records", "id,client_id,effective_date,certification_start_date", (q) => q.in("id", ids.slice(i, i + 150))));
  const refOf = new Map(recs.map((r) => [r.row_id, r.source_ref]));
  return rows.filter((r) => r.certification_start_date && r.effective_date !== r.certification_start_date)
    .map((r) => ({ id: r.id, name: refOf.get(r.id)?.氏名 ?? "", from: r.effective_date, to: r.certification_start_date }));
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `batch ${SRC_BATCH} で作ったケアサポの認定行 ${ops.length} 行の effective_date を認定開始日に揃える`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fix_caresapo_effective_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    let q = sb.from("client_insurance_records").update({ effective_date: o.to }, { count: "exact" }).eq("id", o.id);
    q = o.from == null ? q.is("effective_date", null) : q.eq("effective_date", o.from);
    const { error, count } = await q;
    if (error || count !== 1) await fail(`${o.name}: ${error?.message ?? `件数 ${count}`}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: o.id, op: "update",
      source_key: o.name, source_ref: { 氏名: o.name }, before: { effective_date: o.from }, after: { effective_date: o.to } });
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
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し` }, async () => {
    for (const r of recs) {
      const { error, count } = await sb.from("client_insurance_records").update(r.before, { count: "exact" }).eq("id", r.row_id).eq("effective_date", r.after.effective_date);
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
const ops = await plan(sb);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  effective_date を認定開始日に揃える ${ops.length} 行`);
for (const o of ops) console.log(`  - ${o.name}  ${o.from ?? "(空)"} → ${o.to}`);
if (EXECUTE && ops.length) await execute(sb, ops);
