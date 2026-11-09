/**
 * ケアサポの貸与 (orders.office_id = ケアサポ) があるのに、clients.office_id も client_office_assignments も
 * ケアサポを指していない利用者に、ケアサポの割当 (client_office_assignments) を足す。
 *
 *   node migrations/assign_caresapo_for_rental_clients.mjs                       # DRY RUN
 *   node migrations/assign_caresapo_for_rental_clients.mjs --execute
 *   node migrations/assign_caresapo_for_rental_clients.mjs --revert <batch_id> [--execute]
 *
 * 背景 (2026-11-10): 請求画面 (lib/clients.ts getClients) は clients.office_id で利用者を絞っていたため、
 *   kaigo と共有の利用者 (clients.office_id が空) は ケアサポの貸与があっても請求に乗らなかった。
 *   getClients は junction の割当も見るように直したが、割当自体が無い人が 21 名 (全員 過去の貸与) いる。
 *   ほのぼのは 2026-06 岡本良子・2026-08 原田純 を月遅れで請求済み (KK261001/003)。
 * 割当の期間: start_date = 最初の貸与開始 / end_date = 最後の貸与終了 (貸与中の台があれば null)。
 * clients は書き換えない (共有の人の clients.office_id は kaigo 側の持ち物)。
 * 記録: data_import_batches / data_import_rows (op=insert)。
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
const SCRIPT_REL = "apps/order-app/migrations/assign_caresapo_for_rental_clients.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "assign-caresapo-for-rental-clients";
const CS = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
let EXEC_LOCK = null;

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
async function selectIn(sb, table, select, col, ids, extra = (q) => q) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll(sb, table, select, (q) => extra(q.in(col, c))));
  return out;
}

async function plan(sb) {
  const orders = await selectAll(sb, "orders", "id,client_id", (q) => q.eq("tenant_id", TENANT).eq("office_id", CS));
  const clientOf = new Map(orders.filter((o) => o.client_id).map((o) => [o.id, o.client_id]));
  const items = await selectIn(sb, "order_items", "id,order_id,status,rental_start_date,rental_end_date,cancelled_at", "order_id", [...clientOf.keys()],
    (q) => q.not("rental_start_date", "is", null));
  const byClient = new Map();
  for (const it of items) {
    if (it.cancelled_at) continue;
    const cid = clientOf.get(it.order_id);
    if (!byClient.has(cid)) byClient.set(cid, []);
    byClient.get(cid).push(it);
  }
  const assigned = new Set((await selectAll(sb, "client_office_assignments", "id,client_id", (q) => q.eq("office_id", CS))).map((a) => a.client_id));
  const clients = await selectIn(sb, "clients", "id,name,user_number,office_id,deleted_at,tenant_id", "id", [...byClient.keys()]);
  const ops = [];
  for (const c of clients) {
    if (c.deleted_at || c.office_id === CS || assigned.has(c.id)) continue;
    const its = byClient.get(c.id);
    const start = its.map((i) => i.rental_start_date.slice(0, 10)).sort()[0];
    const open = its.some((i) => !i.rental_end_date);
    const end = open ? null : its.map((i) => i.rental_end_date.slice(0, 10)).sort().at(-1);
    ops.push({ client_id: c.id, name: c.name, user_number: c.user_number, items: its.length, row: { tenant_id: TENANT, client_id: c.id, office_id: CS, start_date: start, end_date: end } });
  }
  return ops;
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `ケアサポの貸与があるのに割当が無い ${ops.length} 名にケアサポの割当を足す`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_assign_caresapo_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { data, error } = await sb.from("client_office_assignments").insert(o.row).select("id").single();
    if (error) await fail(`insert ${o.name}: ${error.message}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_office_assignments", row_id: data.id, op: "insert", source_key: o.client_id, source_ref: { 氏名: o.name, 利用者番号: o.user_number, 貸与台数: o.items }, before: null, after: o.row });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 件。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 消す ${recs.length} 件`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し` }, async () => {
    for (const r of recs) {
      const { error, count } = await sb.from("client_office_assignments").delete({ count: "exact" }).eq("id", r.row_id);
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
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  割当を足す ${ops.length} 名`);
for (const o of ops) console.log(`  - ${o.name} (${o.user_number})  ${o.row.start_date} 〜 ${o.row.end_date ?? "(貸与中)"}  ${o.items} 台`);
if (EXECUTE && ops.length) await execute(sb, ops);
