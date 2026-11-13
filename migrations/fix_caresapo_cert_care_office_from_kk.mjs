/**
 * ケアサポの認定行 (client_insurance_records の office_id = ケアサポ) の 担当居宅 (care_office_id) を、
 * ほのぼの福祉用具の実伝送 KK の 基本 項20 居宅介護支援事業所番号 に合わせる。
 *
 *   node migrations/fix_caresapo_cert_care_office_from_kk.mjs                       # DRY RUN
 *   node migrations/fix_caresapo_cert_care_office_from_kk.mjs --execute             # 本番 (★ user 承認後)
 *   node migrations/fix_caresapo_cert_care_office_from_kk.mjs --revert <batch_id> [--execute]
 *   --kk <KK*.CSV>   既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV (提供 2026-09)
 *
 * 背景 (2026-11-13): 事業所別保険 (per_office) では 伝送の 項20 は「自事業所の認定行の care_office_id」だけを見る
 *   (BillingTab densouCertOf)。旧 sync_fukuyogu_care_office_from_honobono.mjs は clients.care_office_id しか書かないので、
 *   認定行の担当居宅が 空 (髙取 愛子・鈴木 銀治) や 別の事業所 (中村 弘子・岸 きみ) のまま残っていた。
 *
 * 対象 (DB から機械的に選ぶ):
 *   KK の 基本 (01) で 項19 計画作成区分 = 1 (居宅介護支援事業所作成) or 3 (介護予防支援) かつ 項20 の番号が care_offices に 1 件だけある人。
 *   その人 (保険者, 被保番) の ケアサポの認定行のうち、KK の提供月にかかる行 1 行 の care_office_id が その事業所と違うもの。
 *   行が 0 / 2 以上・番号が care_offices に無い/複数・区分 2 (自己作成) は 一覧に出すだけで直さない。
 * 書くもの: client_insurance_records.care_office_id だけ (care_manager_org などの文字列は触らない)。
 *   update は id と 今の care_office_id を条件に件数 1 を確認。
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
const SCRIPT_REL = "apps/order-app/migrations/fix_caresapo_cert_care_office_from_kk.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "fix-caresapo-cert-care-office-from-kk";
const CS = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
const KK = opt("--kk") ?? join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV");
let EXEC_LOCK = null;

const nInsurer = (s) => String(s ?? "").normalize("NFKC").trim().replace(/^0+/, "").padStart(6, "0");
const nInsured = (s) => String(s ?? "").normalize("NFKC").trim().padStart(10, "0");
const nNo = (s) => String(s ?? "").normalize("NFKC").trim();

/** KK 基本 (01)。列 = [2]様式 [3]種別 [4]提供年月 [6]保険者 [7]被保番 [20]項19 計画作成区分 [21]項20 居宅事業所番号 */
function readKk(path) {
  const lines = readFileSync(path, "latin1").split(/\r\n|\n/).filter((l) => l.length > 0);
  const unq = (s) => s.replace(/^"(.*)"$/, "$1");
  const recs = [];
  for (const l of lines) {
    const c = l.split(",").map(unq);
    if (c[0] !== "2" || c[3] !== "01" || !["7131", "7132"].includes(c[2])) continue;
    recs.push({ form: c[2], ym: c[4], insurer: nInsurer(c[6]), insured: nInsured(c[7]), kubun: c[20], no: nNo(c[21]) });
  }
  if (!recs.length) throw new Error(`★ ${path}: 7131/7132 の基本 (01) レコードが 0 件`);
  const yms = [...new Set(recs.map((r) => r.ym))];
  if (yms.length !== 1) throw new Error(`★ ${path}: 提供年月が複数 (${yms.join(",")})`);
  return { recs, ym: `${yms[0].slice(0, 4)}-${yms[0].slice(4, 6)}` };
}

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
  const kk = readKk(KK);
  const monthStart = `${kk.ym}-01`;
  const [y, m] = kk.ym.split("-").map(Number);
  const monthEnd = `${kk.ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const offices = await selectAll(sb, "care_offices", "id,name,office_number", (q) => q.eq("tenant_id", TENANT));
  const officeByNo = new Map();
  for (const o of offices) { const k = nNo(o.office_number); if (!k) continue; if (!officeByNo.has(k)) officeByNo.set(k, []); officeByNo.get(k).push(o); }
  const officeById = new Map(offices.map((o) => [o.id, o]));
  const rows = await selectAll(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number,care_office_id,care_manager_org,certification_start_date,certification_end_date",
    (q) => q.eq("tenant_id", TENANT).eq("office_id", CS));
  const rowsByKey = new Map();
  for (const r of rows) {
    const k = `${nInsurer(r.insurer_number)}|${nInsured(r.insured_number)}`;
    if (!rowsByKey.has(k)) rowsByKey.set(k, []);
    rowsByKey.get(k).push(r);
  }
  const ops = [], skipped = [];
  const seen = new Set();
  for (const p of kk.recs) {
    const key = `${p.insurer}|${p.insured}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.kubun !== "1" && p.kubun !== "3") continue; // 2 = 自己作成 (番号なし) は触らない
    const hits = officeByNo.get(p.no) ?? [];
    if (hits.length !== 1) { skipped.push(`${key} 番号 ${p.no} — care_offices に ${hits.length} 件 (追加・重複の整理が先)`); continue; }
    const target = hits[0];
    const cand = (rowsByKey.get(key) ?? []).filter((r) => (!r.certification_start_date || r.certification_start_date <= monthEnd)
      && (!r.certification_end_date || r.certification_end_date >= monthStart));
    if (cand.length !== 1) { skipped.push(`${key} 番号 ${p.no} — ケアサポの認定行で ${kk.ym} にかかる行が ${cand.length} 行`); continue; }
    const r = cand[0];
    if (r.care_office_id === target.id) continue;
    const before = r.care_office_id ? officeById.get(r.care_office_id) : null;
    ops.push({ rec: r, label: `${key} ${r.certification_start_date}〜${r.certification_end_date ?? ""}  ${before ? `${before.name} (${before.office_number})` : "(空)"} → ${target.name} (${target.office_number})  [文字列 care_manager_org=${r.care_manager_org ?? ""}]`,
      before: { care_office_id: r.care_office_id }, patch: { care_office_id: target.id } });
  }
  return { ops, skipped, ym: kk.ym, persons: seen.size };
}

async function execute(sb, ops, ym) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [KK], script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `ケアサポの認定行 ${ops.length} 行の 担当居宅 を ほのぼの KK (提供 ${ym}) の 項20 に合わせる`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fix_caresapo_cert_care_office_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    let q = sb.from("client_insurance_records").update(o.patch, { count: "exact" }).eq("id", o.rec.id);
    q = o.rec.care_office_id ? q.eq("care_office_id", o.rec.care_office_id) : q.is("care_office_id", null);
    const { error, count } = await q;
    if (error || count !== 1) await fail(`${o.label}: ${error?.message ?? `件数 ${count}`}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: o.rec.id, op: "update",
      source_key: `${o.rec.insurer_number}|${o.rec.insured_number}`, source_ref: { 提供月: ym, 認定開始: o.rec.certification_start_date }, before: o.before, after: o.patch });
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
const { ops, skipped, ym, persons } = await plan(sb);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  KK 提供 ${ym}: ${persons} 名 / 直す ${ops.length} 行`);
for (const o of ops) console.log(`  - ${o.label}`);
if (skipped.length) console.log(`\n直さない ${skipped.length} 件:\n${skipped.map((s) => `  - ${s}`).join("\n")}`);
if (EXECUTE && ops.length) await execute(sb, ops, ym);
if (!EXECUTE) console.log("\nDRY RUN — DB は書き換えていない。--execute で本番 (★ user 承認後)");
