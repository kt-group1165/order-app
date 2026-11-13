/**
 * ケアサポだけの利用者の認定 (client_insurance_records) を ほのぼの福祉用具の利用者マスタ (入力側) に合わせる。
 *
 *   node migrations/fix_caresapo_certs_from_master.mjs                       # DRY RUN
 *   node migrations/fix_caresapo_certs_from_master.mjs --execute
 *   node migrations/fix_caresapo_certs_from_master.mjs --revert <batch_id> [--execute]
 *     --include-shared  kaigo と共有の利用者も A (申請中→認定済み) だけ直す (★ user 判断。保険の事業所別設計の前倒し)
 *     --with-end-date   B (認定終了だけ違う) も直す (★ 既定は直さない: マスタは区分変更等で終了日を縮めており、
 *                       当方に次の認定行が無いと請求の空白を作る。2026-11-11 dry-run で 6+14 行が該当)
 *
 * 背景 (2026-11-11): 2026-10 提供分を ほのぼのの請求 (処理R8-10) と突合したら、当方で 認定が「申請中」のため
 *   月遅れ扱いにしている 8 名を ほのぼのは普通に請求していた。利用者マスタ (2026-11-09 出力) では全員 認定済み。
 *   当方の行は 8/31 の認定履歴取込のまま (申請中) で、結果が反映されていない。
 * 直すもの (同じ 被保番 × 認定開始日 の行どうしで比べる。認定終了が 2026-04-01 以降の行だけ):
 *   A. DB = 申請中 / マスタ = 認定済み → 認定状況・要介護度・認定終了 をマスタに
 *   B. 両方 認定済み で 認定終了 だけ違う → 認定終了 をマスタに
 *   (要介護度だけ違う・マスタに無い行 は直さず一覧だけ)
 * 対象: clients.office_id = ケアサポ で、ケアサポ以外の事業所の割当 (client_office_assignments) が無い人。
 *   kaigo と共有の人は 一覧に出すだけ (保険は事業所ごとに持つ設計待ち)。
 * 記録: data_import_batches / data_import_rows (op=update、before/after)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";
import { resolveUserMasterDirs } from "./_user_master_dir.mjs";
import { resolveFukuyoguOffice, describeFukuyoguOffice } from "./_fukuyogu_office.mjs";

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
const SCRIPT_REL = "apps/order-app/migrations/fix_caresapo_certs_from_master.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "fix-caresapo-certs-from-master";
// 対象事業所: 既定 ケアサポ (介護ショップ ケア・サポート千葉 1bfc0d57…)。--area / --office-bn で切替 (_fukuyogu_office.mjs)
//   (名前は従来のまま CS / caresapo。中身は選んだ事業所)
const FO = resolveFukuyoguOffice(argv);
if (!FO.isDefault) console.log(describeFukuyoguOffice(FO));
const CS = FO.officeId;
const BASE = FO.dir;
// 利用者マスタ: 既定 = 利用者マスタ_YYYYMMDD (登録有) / 利用者マスタ_全件_YYYYMMDD (登録無) の最新。--user-master-dir / --user-master-dir-off で上書き
const UM = resolveUserMasterDirs(BASE, argv);
const MASTER_FILES = [UM.file(UM.on, "介護保険_"), UM.file(UM.off, "介護保険_")].map((p, i) => {
  if (!p) throw new Error(`★ 利用者マスタ (${i ? "登録無" : "登録有"}) に 介護保険_*.CSV が無い`);
  return relative(BASE, p).split("\\").join("/");
});
const FROM_END = "2026-04-01";
const INCLUDE_SHARED = argv.includes("--include-shared");
const WITH_END = argv.includes("--with-end-date");
const EXTEND_END = argv.includes("--extend-end-only");
let EXEC_LOCK = null;

const parseLine = (l) => (l.match(/("([^"]*)"|[^,]*)(,|$)/g) || []).map((s) => s.replace(/,$/, "").replace(/^"|"$/g, ""));
const pad10 = (s) => String(s ?? "").trim().padStart(10, "0");
const ymd = (s) => (s ? s.replaceAll("/", "-").slice(0, 10) : null);
const level = (s) => (s ? s.normalize("NFKC").trim() : null);

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
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

function loadMaster() {
  const m = new Map(); // `${被保番}|${開始}` → { status, level, end, user }
  for (const f of MASTER_FILES) {
    const lines = new TextDecoder("shift_jis").decode(readFileSync(join(BASE, f))).split(/\r?\n/).filter(Boolean);
    const hd = parseLine(lines[0]);
    const col = (name) => { const i = hd.indexOf(name); if (i < 0) throw new Error(`${f}: 列「${name}」が無い`); return i; };
    const iNo = col("被保険者番号"), iSt = col("認定状況"), iLv = col("要介護度"), iS = col("認定有効期間－開始日"), iE = col("認定有効期間－終了日");
    for (const l of lines.slice(1)) {
      const r = parseLine(l);
      if (!r[iNo] || !r[iS]) continue;
      m.set(`${pad10(r[iNo])}|${ymd(r[iS])}`, { status: r[iSt], level: level(r[iLv]), end: ymd(r[iE]), user: r[0] });
    }
  }
  return m;
}

async function plan(sb) {
  const master = loadMaster();
  const own = await selectAll(sb, "clients", "id,name,user_number", (q) => q.eq("tenant_id", TENANT).eq("office_id", CS).is("deleted_at", null));
  // ★ 2026-11-11: --include-shared のときは clients.office_id が空/他でも ケアサポの割当がある人を含める (五位渕 和・松尾 光子・安田 八重子)
  const clients = [...own];
  if (INCLUDE_SHARED) {
    const have = new Set(own.map((c) => c.id));
    const asg = [...new Set((await selectAll(sb, "client_office_assignments", "id,client_id", (q) => q.eq("office_id", CS))).map((a) => a.client_id))].filter((id) => !have.has(id));
    for (const c of chunks(asg, 150)) clients.push(...await selectAll(sb, "clients", "id,name,user_number", (q) => q.in("id", c).is("deleted_at", null)));
  }
  const ids = clients.map((c) => c.id);
  const other = new Set();
  for (const c of chunks(ids, 150)) {
    for (const a of await selectAll(sb, "client_office_assignments", "id,client_id,office_id", (q) => q.in("client_id", c).neq("office_id", CS))) other.add(a.client_id);
  }
  const recs = [];
  for (const c of chunks(ids, 150)) {
    recs.push(...await selectAll(sb, "client_insurance_records", "id,client_id,insured_number,certification_status,care_level,certification_start_date,certification_end_date",
      (q) => q.in("client_id", c).gte("certification_end_date", FROM_END)));
  }
  const byId = new Map(clients.map((c) => [c.id, c]));
  const ops = [], shared = [], notes = [];
  for (const r of recs) {
    const mk = master.get(`${pad10(r.insured_number)}|${r.certification_start_date}`);
    if (!mk) continue;
    const c = byId.get(r.client_id);
    let patch = null, kind = null;
    if (r.certification_status === "申請中" && mk.status === "認定済み" && mk.level) {
      patch = { certification_status: "認定済み", care_level: mk.level, certification_end_date: mk.end };
      kind = "A 申請中→認定済み";
    } else if (r.certification_status === "認定済み" && mk.status === "認定済み" && mk.end && mk.end !== r.certification_end_date) {
      patch = { certification_end_date: mk.end };
      kind = "B 認定終了";
    } else if (r.certification_status === "認定済み" && mk.status === "認定済み" && level(r.care_level) !== mk.level) {
      notes.push(`  要介護度だけ違う (直さない): ${c.name} ${r.certification_start_date} DB ${r.care_level} / マスタ ${mk.level}`);
    }
    if (!patch) continue;
    // --extend-end-only: B のうち 終了日を延ばすものだけ直す (縮めると請求の空白を作るが、延ばすのは安全)
    if (kind.startsWith("B") && EXTEND_END && mk.end > r.certification_end_date) kind = "B 認定終了を延ばす";
    else if (kind.startsWith("B") && !WITH_END) {
      notes.push(`  [B 認定終了・--with-end-date が無いので直さない] ${c.name} ${r.certification_start_date} ${r.certification_end_date} → ${mk.end}${other.has(r.client_id) ? " (共有)" : ""}`);
      continue;
    }
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, r[k] ?? null]));
    const op = { kind, client: c, rec: r, before, patch };
    (other.has(r.client_id) && !(INCLUDE_SHARED && (kind.startsWith("A") || kind === "B 認定終了を延ばす")) ? shared : ops).push(op);
  }
  return { ops, shared, notes };
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: MASTER_FILES, script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `ケアサポのみの利用者の認定 ${ops.length} 行を利用者マスタに合わせる`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fix_caresapo_certs_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { error, count } = await sb.from("client_insurance_records").update(o.patch, { count: "exact" })
      .eq("id", o.rec.id).eq("certification_status", o.rec.certification_status);
    if (error || count !== 1) await fail(`${o.client.name}: ${error?.message ?? `件数 ${count}`}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: o.rec.id, op: "update",
      source_key: o.client.user_number, source_ref: { 氏名: o.client.name, 利用者番号: o.client.user_number, 種類: o.kind }, before: o.before, after: o.patch });
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
const { ops, shared, notes } = await plan(sb);
const show = (o) => `  - [${o.kind}] ${o.client.name} (${o.client.user_number}) 開始 ${o.rec.certification_start_date}  ${JSON.stringify(o.before)} → ${JSON.stringify(o.patch)}`;
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  直す ${ops.length} 行${INCLUDE_SHARED ? " (共有の人の A を含む)" : " (ケアサポのみの利用者)"}`);
for (const o of ops) console.log(show(o));
console.log(`\n共有 (kaigo の割当あり) のため直さない ${shared.length} 行:`);
for (const o of shared) console.log(show(o));
if (notes.length) console.log(`\n参考:\n${notes.join("\n")}`);
if (EXECUTE && ops.length) await execute(sb, ops);
