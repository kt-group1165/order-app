/**
 * ケアサポだけの利用者 (clients.office_id = ケアサポ) で、被保険者番号が ほのぼの福祉用具の利用者マスタ (入力側) と
 * 違う人を マスタに合わせる。clients.insured_number と、同じ client の client_insurance_records のうち 旧番号の行。
 *
 *   node migrations/fix_caresapo_insured_number_from_master.mjs                       # DRY RUN
 *   node migrations/fix_caresapo_insured_number_from_master.mjs --execute
 *   node migrations/fix_caresapo_insured_number_from_master.mjs --revert <batch_id> [--execute]
 *
 * 背景 (2026-11-11): ほのぼのは 佐藤昭子 (1000083549) ・森春江 (仮番号 1000011111) を旧番号で請求し、
 *   11 月に正しい番号 (1000083548 / 1000059363) で 9 月分を出し直した。当方は旧番号のまま。
 *   同じく仮番号 (9999…/8888… 等) や入力違いのまま残っている人がいる。
 * 対象: 利用者番号でマスタ (介護保険_*.CSV、利用登録 有 + 無) を引き、被保番が 1 種類に決まり、
 *   DB の被保番が空でなく、先頭 0 埋めで揃えても違う人だけ (0 埋めだけの差・空欄は対象外)。
 * kaigo と共有の利用者 (office_id がケアサポ以外/空) は触らない (保険は事業所ごとに持つ設計待ち)。
 * 記録: data_import_batches / data_import_rows (op=update、before/after)。
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
const { TENANT, readEnv } = core;

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const SCRIPT_REL = "apps/order-app/migrations/fix_caresapo_insured_number_from_master.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "fix-caresapo-insured-number-from-master";
const CS = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
const BASE = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const MASTER_FILES = [
  "利用者マスタ_20261109/介護保険_全件_保険と認定.CSV",
  "利用者マスタ_全件_20261109/介護保険_利用登録無_全件_保険と認定.CSV",
];
let EXEC_LOCK = null;

const parseLine = (l) => (l.match(/("([^"]*)"|[^,]*)(,|$)/g) || []).map((s) => s.replace(/,$/, "").replace(/^"|"$/g, ""));
const pad10 = (s) => String(s ?? "").trim().padStart(10, "0");

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
  const m = new Map(); // 利用者番号 → Set(被保番)
  for (const f of MASTER_FILES) {
    const lines = new TextDecoder("shift_jis").decode(readFileSync(join(BASE, f))).split(/\r?\n/).filter(Boolean);
    const hd = parseLine(lines[0]);
    const iNo = hd.findIndex((h) => h.includes("被保険者番号"));
    if (iNo < 0) throw new Error(`${f}: 被保険者番号 列が無い`);
    for (const l of lines.slice(1)) {
      const r = parseLine(l);
      if (!r[0] || !r[iNo]) continue;
      if (!m.has(r[0])) m.set(r[0], new Set());
      m.get(r[0]).add(pad10(r[iNo]));
    }
  }
  return m;
}

async function plan(sb) {
  const master = loadMaster();
  const clients = await selectAll(sb, "clients", "id,name,user_number,insurer_number,insured_number",
    (q) => q.eq("tenant_id", TENANT).eq("office_id", CS).is("deleted_at", null));
  const ops = [];
  for (const c of clients) {
    const s = master.get(c.user_number);
    if (!s || s.size !== 1 || !c.insured_number) continue;
    const to = [...s][0];
    if (pad10(c.insured_number) === to) continue;
    const recs = await selectAll(sb, "client_insurance_records", "id,insured_number,certification_start_date",
      (q) => q.eq("client_id", c.id).eq("insured_number", c.insured_number));
    ops.push({ client: c, from: c.insured_number, to, recs });
  }
  return ops;
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: MASTER_FILES, script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `ケアサポのみの利用者 ${ops.length} 名の被保険者番号を利用者マスタに合わせる`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fix_caresapo_insured_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  let n = 0;
  const log = async (table, rowId, before, after, ref) => {
    const { error } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: rowId, op: "update", source_key: ref.利用者番号, source_ref: ref, before, after });
    if (error) await fail(`data_import_rows: ${error.message}`);
    n++;
  };
  for (const o of ops) {
    const ref = { 氏名: o.client.name, 利用者番号: o.client.user_number };
    const { error, count } = await sb.from("clients").update({ insured_number: o.to }, { count: "exact" }).eq("id", o.client.id).eq("insured_number", o.from);
    if (error || count !== 1) await fail(`clients ${o.client.name}: ${error?.message ?? `件数 ${count}`}`);
    await log("clients", o.client.id, { insured_number: o.from }, { insured_number: o.to }, ref);
    for (const r of o.recs) {
      const { error: e2, count: c2 } = await sb.from("client_insurance_records").update({ insured_number: o.to }, { count: "exact" }).eq("id", r.id).eq("insured_number", o.from);
      if (e2 || c2 !== 1) await fail(`client_insurance_records ${o.client.name}: ${e2?.message ?? `件数 ${c2}`}`);
      await log("client_insurance_records", r.id, { insured_number: o.from }, { insured_number: o.to }, ref);
    }
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== n) await fail(`verify: data_import_rows ${count} ≠ ${n}`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 名 / ${n} 行。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 戻す ${recs.length} 行`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し` }, async () => {
    for (const r of recs) {
      const { error, count } = await sb.from(r.table_name).update(r.before, { count: "exact" }).eq("id", r.row_id).eq("insured_number", r.after.insured_number);
      if (error || count !== 1) throw new Error(`revert ${r.table_name} ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
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
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  被保番を直す ${ops.length} 名`);
for (const o of ops) console.log(`  - ${o.client.name} (${o.client.user_number})  ${o.from} → ${o.to}  認定行 ${o.recs.length}`);
if (EXECUTE && ops.length) await execute(sb, ops);
