/**
 * 共有の利用者 (kaigo-app でも使用) で clients.insurer_number / insured_number が「両方空」の人だけ、
 * ほのぼの福祉用具の実伝送 (KK) の番号で埋める。2026-11-09 user 承認 (保険情報を事業所別に持つまでのつなぎ)。
 *
 *   node migrations/fill_shared_client_insurance_numbers.mjs                       # DRY RUN
 *   node migrations/fill_shared_client_insurance_numbers.mjs --execute
 *   node migrations/fill_shared_client_insurance_numbers.mjs --revert <batch_id> [--execute]
 *   --kk <KK*.CSV>  既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV
 *
 * 背景: 反映 (sync_fukuyogu_from_honobono.mjs) は共有の人の clients を上書きしない (observe のみ)。
 *   伝送 (lib/kokuho-densou/build.ts) は clients の保険者番号・被保番を使うので、空の人がレセプトごと落ちていた
 *   (2026-09 で 12 名)。
 * 引き当て: KK の (保険者, 被保番) と一致する client_insurance_records を持つ client が **1 人だけ** で、
 *   その client の clients.insurer_number / insured_number が **両方空** のときだけ書く。片方でも値があれば触らない。
 * 記録: data_import_batches / data_import_rows (before/after)。update は「空のまま」を条件に付ける。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
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
const { TENANT, readEnv, nInsurer, nInsured } = core;

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const REPO_ROOT = resolve(HERE, "../../..");
const KK_PATH = resolve(opt("--kk") ?? join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV"));
const SCRIPT_REL = "apps/order-app/migrations/fill_shared_client_insurance_numbers.mjs";
let EXEC_LOCK = null; // 同じ script の同時 --execute を止める (_exec_lock.mjs)。--execute の最初に execLockStart で取る
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "fill-shared-insurance-numbers";
const CAPASAPO_OFFICE = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";

const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const empty = (v) => v == null || String(v).trim() === "";

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

function readKk(path) {
  const lines = readFileSync(path, "latin1").split(/\r\n|\n/).filter(Boolean);
  const unq = (s) => s.replace(/^"(.*)"$/, "$1");
  const recs = [];
  for (const l of lines) {
    const c = l.split(",").map(unq);
    if (c[0] !== "2" || c[3] !== "01" || !["7131", "7132"].includes(c[2])) continue;
    recs.push({ form: c[2], insurerRaw: c[6], insuredRaw: c[7], insurer: nInsurer(c[6]), insured: nInsured(c[7]) });
  }
  if (!recs.length) throw new Error(`${path}: 基本 (01) レコードが 0 件`);
  return recs;
}

async function plan(sb) {
  const kk = readKk(KK_PATH);
  const ins = await selectAll(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number", (q) => q.eq("tenant_id", TENANT));
  const byKey = new Map();
  for (const r of ins) {
    const k = `${nInsurer(r.insurer_number ?? "")}|${nInsured(r.insured_number ?? "")}`;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(r.client_id);
  }
  const cand = new Map();
  for (const k of kk) for (const cid of byKey.get(`${k.insurer}|${k.insured}`) ?? []) cand.set(cid, k);
  const clients = await selectIn(sb, "clients", "id,name,insurer_number,insured_number,office_id,deleted_at", "id", [...cand.keys()]);
  const coa = await selectIn(sb, "client_office_assignments", "client_id,office_id", "client_id", [...cand.keys()]);
  const otherOffice = new Set(coa.filter((a) => a.office_id !== CAPASAPO_OFFICE).map((a) => a.client_id));
  const ops = [], skip = [];
  for (const k of kk) {
    const ids = [...(byKey.get(`${k.insurer}|${k.insured}`) ?? [])];
    const cs = clients.filter((c) => ids.includes(c.id) && !c.deleted_at);
    if (cs.length !== 1) { if (cs.length > 1) skip.push({ key: `${k.insurer}|${k.insured}`, why: `client が ${cs.length} 人` }); continue; }
    const c = cs[0];
    if (!empty(c.insurer_number) || !empty(c.insured_number)) continue;
    const shared = otherOffice.has(c.id) || (c.office_id && c.office_id !== CAPASAPO_OFFICE);
    if (!shared) { skip.push({ name: c.name, why: "共有ではない (通常の反映の対象)" }); continue; }
    ops.push({ id: c.id, name: c.name, key: `${k.form}|${k.insurer}|${k.insured}`, before: { insurer_number: null, insured_number: null }, patch: { insurer_number: k.insurer, insured_number: k.insured } });
  }
  return { ops, skip, kkCount: kk.length };
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [relative(REPO_ROOT, KK_PATH).replace(/\\/g, "/")], script: SCRIPT_REL,
    args: argv.join(" "), step: STEP_NAME, notes: `共有の利用者で clients の保険者番号・被保番が両方空の ${ops.length} 名を KK で埋める`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fill_shared_insurance_numbers_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { error, count } = await sb.from("clients").update(o.patch, { count: "exact" })
      .eq("id", o.id).eq("tenant_id", TENANT).is("insurer_number", null).is("insured_number", null);
    if (error) await fail(`update clients ${o.id}: ${error.message}`);
    if (count !== 1) await fail(`update clients ${o.id} (${o.name}): 更新件数 ${count} (空でなくなった可能性)`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "clients", row_id: o.id, op: "update", source_key: o.key, source_ref: { 理由: "共有・両方空を KK で埋める" }, before: o.before, after: o.patch });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 名。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  const cur = new Map((await selectIn(sb, "clients", "id,insurer_number,insured_number", "id", recs.map((r) => r.row_id))).map((r) => [r.id, r]));
  const back = recs.filter((r) => { const c = cur.get(r.row_id); return c && c.insurer_number === r.after.insurer_number && c.insured_number === r.after.insured_number; });
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 戻す ${back.length} / 記録 ${recs.length}`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し (同時実行ロック用。行の記録はしない)` }, async () => {
    for (const r of back) {
      const { error, count } = await sb.from("clients").update({ insurer_number: null, insured_number: null }, { count: "exact" })
        .eq("id", r.row_id).eq("insurer_number", r.after.insurer_number).eq("insured_number", r.after.insured_number);
      if (error || count !== 1) throw new Error(`revert ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
    }
    const status = back.length === recs.length ? "reverted" : "partially_reverted";
    const { error } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
    if (error) throw new Error(`batch: ${error.message}`);
    console.log(`取り消し完了 (${status})`);
  });
}

const sb = await makeSb();
if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
if (REVERT) { await revert(sb, REVERT); process.exit(0); }
const { ops, skip, kkCount } = await plan(sb);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  KK 基本レコード ${kkCount} / 埋める ${ops.length} 名 / 対象外 ${skip.length}`);
for (const o of ops) console.log(`  - ${o.name}  → ${o.patch.insurer_number} | ${o.patch.insured_number}`);
for (const s of skip.slice(0, 20)) console.log(`  (対象外) ${JSON.stringify(s)}`);
if (EXECUTE && ops.length) await execute(sb, ops);
