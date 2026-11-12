/**
 * ケアサポの認定行で「給付率 (benefit_rate) と負担割合 (copay_rate) が食い違う」行の 負担割合 を 給付率から決め直す。
 *
 *   node migrations/fix_caresapo_cert_copay_mismatch.mjs                       # DRY RUN
 *   node migrations/fix_caresapo_cert_copay_mismatch.mjs --execute             # 本番 (★ user 承認後)
 *   node migrations/fix_caresapo_cert_copay_mismatch.mjs --revert <batch_id> [--execute]
 *
 * 背景 (2026-11-13 里 輝子): 事業所別保険の段階 0 (assign_insurance_office_stage0.mjs --step caresapo) は
 *   元の行 (kaigo の値) を写したうえで ほのぼの福祉用具の観測値 (給付率) で上書きしたため、
 *   給付率 = ほのぼの / 負担割合 = 元の行 のまま、1 行の中で食い違う行ができた (例 給付率 70 / 負担 1 割)。
 *   請求 (BillingTab) は 給付率を優先して読む (lib/insurance/cert-month.ts benefitRateOfCertRow) ので金額は給付率どおりだが、
 *   負担割合を見る画面・kaigo 側の表示と食い違う。
 *
 * 対象 (DB から機械的に選ぶ):
 *   client_insurance_records の office_id = ケアサポ で、給付率 90/80/70 と 負担割合 1/2/3 (割) が対応しない行のうち、
 *   ★ ほのぼの利用者マスタ (介護保険 CSV・登録有/無) の 同じ (被保番, 認定開始日) の行の給付率 が DB の給付率と一致するもの
 *   (= 給付率は ほのぼのの値で正しく、負担割合だけが古い)。一致しない・マスタに無い行は 一覧に出すだけで直さない。
 * 書くもの: copay_rate = (100 − 給付率) / 10 ("1"/"2"/"3")。update は id と 今の値 を条件に件数 1 を確認。
 * 記録: data_import_batches / data_import_rows (op=update、before/after)。--revert で before に戻す。
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
const SCRIPT_REL = "apps/order-app/migrations/fix_caresapo_cert_copay_mismatch.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "fix-caresapo-cert-copay-mismatch";
const CS = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
const BASE = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const MASTER_FILES = [
  "利用者マスタ_20261109/介護保険_全件_保険と認定.CSV",
  "利用者マスタ_全件_20261109/介護保険_利用登録無_全件_保険と認定.CSV",
];
const COPAY_OF = { 90: "1", 80: "2", 70: "3" };
let EXEC_LOCK = null;

const parseLine = (l) => { const o = []; let c = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } o.push(c); return o; };
const pad10 = (s) => String(s ?? "").normalize("NFKC").trim().padStart(10, "0");
const ymd = (s) => { const m = String(s ?? "").normalize("NFKC").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : null; };
const num = (v) => { const n = Number(String(v ?? "").normalize("NFKC").trim()); return Number.isFinite(n) ? n : null; };

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
  const m = new Map(); // `${被保番}|${認定開始}` → 給付率
  for (const f of MASTER_FILES) {
    const lines = new TextDecoder("shift_jis").decode(readFileSync(join(BASE, f))).split(/\r?\n/).filter(Boolean);
    const hd = parseLine(lines[0]);
    const col = (name) => { const i = hd.indexOf(name); if (i < 0) throw new Error(`${f}: 列「${name}」が無い`); return i; };
    const iNo = col("被保険者番号"), iRate = col("給付率"), iS = col("認定有効期間－開始日");
    for (const l of lines.slice(1)) {
      const r = parseLine(l);
      if (!r[iNo] || !r[iS]) continue;
      m.set(`${pad10(r[iNo])}|${ymd(r[iS])}`, num(r[iRate]));
    }
  }
  return m;
}

async function plan(sb) {
  const master = loadMaster();
  const rows = await selectAll(sb, "client_insurance_records", "id,client_id,insured_number,benefit_rate,copay_rate,certification_start_date,certification_end_date,office_source",
    (q) => q.eq("tenant_id", TENANT).eq("office_id", CS));
  const bad = rows.filter((r) => { const b = num(r.benefit_rate); const want = COPAY_OF[b]; return want && r.copay_rate != null && String(r.copay_rate).trim() !== "" && String(r.copay_rate).normalize("NFKC").trim() !== want; });
  const names = new Map();
  for (let i = 0; i < bad.length; i += 150) {
    const ids = [...new Set(bad.slice(i, i + 150).map((r) => r.client_id))];
    const { data, error } = await sb.from("clients").select("id,name,user_number").in("id", ids);
    if (error) throw new Error(`clients: ${error.message}`);
    for (const c of data) names.set(c.id, c);
  }
  const ops = [], skipped = [];
  for (const r of bad) {
    const c = names.get(r.client_id);
    const mk = master.get(`${pad10(r.insured_number)}|${r.certification_start_date}`);
    const label = `${c?.name ?? r.client_id} (${c?.user_number ?? "-"}) ${r.certification_start_date}〜${r.certification_end_date ?? ""} 給付率 ${r.benefit_rate} / 負担 ${r.copay_rate}`;
    if (mk == null) { skipped.push(`${label} — マスタに同じ (被保番, 認定開始) の行が無い`); continue; }
    if (mk !== num(r.benefit_rate)) { skipped.push(`${label} — マスタの給付率 ${mk} と DB の給付率が違う (どちらが正か決められない)`); continue; }
    ops.push({ rec: r, client: c, label, before: { copay_rate: r.copay_rate }, patch: { copay_rate: COPAY_OF[num(r.benefit_rate)] } });
  }
  return { ops, skipped, scanned: rows.length, bad: bad.length };
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: MASTER_FILES, script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `ケアサポの認定行 ${ops.length} 行の 負担割合 を 給付率 (ほのぼの) から決め直す`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fix_caresapo_cert_copay_mismatch_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { error, count } = await sb.from("client_insurance_records").update(o.patch, { count: "exact" })
      .eq("id", o.rec.id).eq("copay_rate", o.rec.copay_rate);
    if (error || count !== 1) await fail(`${o.label}: ${error?.message ?? `件数 ${count}`}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: o.rec.id, op: "update",
      source_key: o.client?.user_number ?? null, source_ref: { 氏名: o.client?.name, 認定開始: o.rec.certification_start_date, 給付率: o.rec.benefit_rate }, before: o.before, after: o.patch });
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
const { ops, skipped, scanned, bad } = await plan(sb);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  ケアサポの認定行 ${scanned} 行 / 給付率と負担割合が食い違う ${bad} 行 / 直す ${ops.length} 行`);
for (const o of ops) console.log(`  - ${o.label}  負担 ${o.before.copay_rate} → ${o.patch.copay_rate}`);
if (skipped.length) console.log(`\n直さない ${skipped.length} 行:\n${skipped.map((s) => `  - ${s}`).join("\n")}`);
if (EXECUTE && ops.length) await execute(sb, ops);
if (!EXECUTE) console.log("\nDRY RUN — DB は書き換えていない。--execute で本番 (★ user 承認後)");
