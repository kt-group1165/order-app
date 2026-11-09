/**
 * 共有の利用者で clients.benefit_rate (給付率) が 同じ DB の当月有効な認定行と矛盾し、
 * ほのぼの福祉用具の実伝送 (KK261004) が認定行の側と一致する人だけ、clients を認定行に合わせる。
 * 2026-11-09 user 合意 (DESIGN_INSURANCE_PER_OFFICE.md 決定 7「DB 内の矛盾」)。
 *
 *   node migrations/fix_shared_benefit_rate_contradiction.mjs            # DRY RUN
 *   node migrations/fix_shared_benefit_rate_contradiction.mjs --execute
 *   node migrations/fix_shared_benefit_rate_contradiction.mjs --revert <batch_id> [--execute]
 *
 * 判定: 2026-09 に有効な認定行 (effective_date 最新) の benefit_rate が clients.benefit_rate と違い、
 *   KK261004 の 7131/7132-01 の給付率 (index 30 = 項29 保険給付率) が 認定行と一致する人。
 *   書くのは clients.benefit_rate と clients.copay_rate (= 100 − 給付率。clients の規約 "10/20/30") だけ。
 *   kaigo-app は clients.benefit_rate を請求に使わない (認定行の copay_rate を使う) ので kaigo の金額は変わらない。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

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
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const KK_PATH = resolve(opt("--kk") ?? join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV"));
const MONTH_START = "2026-09-01", MONTH_END = "2026-09-30";
const SCRIPT_REL = "apps/order-app/migrations/fix_shared_benefit_rate_contradiction.mjs";
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const env = readEnv();
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function selectAll(table, select, build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function selectIn(table, select, col, ids) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll(table, select, (q) => q.in(col, c)));
  return out;
}

if (REVERT) {
  const recs = await selectAll("data_import_rows", "*", (q) => q.eq("batch_id", REVERT));
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 取り消し ${recs.length} 行`);
  if (EXECUTE) {
    for (const r of recs) {
      const { error, count } = await sb.from("clients").update(r.before, { count: "exact" }).eq("id", r.row_id)
        .eq("benefit_rate", r.after.benefit_rate);
      if (error || count !== 1) throw new Error(`revert ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
    }
    const { error } = await sb.from("data_import_batches").update({ status: "reverted", reverted_at: new Date().toISOString() }).eq("id", REVERT);
    if (error) throw new Error(error.message);
  }
  process.exit(0);
}

// KK の給付率
const kk = new Map();
for (const l of readFileSync(KK_PATH, "latin1").split(/\r\n|\n/)) {
  const c = l.split(",").map((s) => s.replace(/^"(.*)"$/, "$1"));
  if (c[0] !== "2" || c[3] !== "01" || !["7131", "7132"].includes(c[2])) continue;
  kk.set(`${nInsurer(c[6])}|${nInsured(c[7])}`, String(Number(c[30])));
}
const clients = await selectAll("clients", "id,name,insurer_number,insured_number,benefit_rate,copay_rate", (q) => q.eq("tenant_id", TENANT).is("deleted_at", null));
const target = clients.filter((c) => c.insured_number && kk.has(`${nInsurer(c.insurer_number ?? "")}|${nInsured(c.insured_number)}`));
const ins = await selectIn("client_insurance_records", "id,client_id,effective_date,certification_start_date,certification_end_date,benefit_rate", "client_id", target.map((c) => c.id));
const insBy = new Map();
for (const r of ins) { if (!insBy.has(r.client_id)) insBy.set(r.client_id, []); insBy.get(r.client_id).push(r); }
const ops = [];
for (const c of target) {
  const cert = (insBy.get(c.id) ?? []).slice().sort((a, b) => (b.effective_date ?? "").localeCompare(a.effective_date ?? ""))
    .find((r) => { const s = r.certification_start_date ?? r.effective_date; const e = r.certification_end_date; return !(s && s > MONTH_END) && !(e && e < MONTH_START); });
  const kkRate = kk.get(`${nInsurer(c.insurer_number ?? "")}|${nInsured(c.insured_number)}`);
  if (!cert?.benefit_rate || String(Number(cert.benefit_rate)) === String(Number(c.benefit_rate))) continue;
  if (String(Number(cert.benefit_rate)) !== kkRate) continue;
  const rate = Number(cert.benefit_rate);
  if (![70, 80, 90].includes(rate)) continue;
  ops.push({ id: c.id, name: c.name, before: { benefit_rate: c.benefit_rate, copay_rate: c.copay_rate }, after: { benefit_rate: String(rate), copay_rate: String(100 - rate) }, cert: cert.id, kk: kkRate });
}
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  KK ${kk.size} 名中 DB で引けた ${target.length} 名 / 直す ${ops.length} 名`);
for (const o of ops) console.log(`  - ${o.name}: clients 給付率 ${o.before.benefit_rate}/負担 ${o.before.copay_rate} → ${o.after.benefit_rate}/${o.after.copay_rate} (認定行・KK とも ${o.kk})`);
if (!EXECUTE || !ops.length) process.exit(0);

const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
  tenant_id: TENANT, source_system: "honobono-fukuyogu", source_files: ["apps/kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV"],
  script: SCRIPT_REL, args: argv.join(" "), step: "fix-benefit-rate-contradiction", status: "running", notes: `clients.benefit_rate が認定行と矛盾 ${ops.length} 名`,
}).select("id").single();
if (bErr) throw new Error(`data_import_batches: ${bErr.message}`);
writeFileSync(join(HERE, `_backup_fix_benefit_rate_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: batch.id, ops }, null, 2));
for (const o of ops) {
  let q = sb.from("clients").update(o.after, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
  q = o.before.benefit_rate == null ? q.is("benefit_rate", null) : q.eq("benefit_rate", o.before.benefit_rate);
  const { error, count } = await q;
  if (error || count !== 1) {
    await sb.from("data_import_batches").update({ status: "failed" }).eq("id", batch.id);
    throw new Error(`update ${o.name}: ${error?.message ?? `件数 ${count}`}`);
  }
  const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: batch.id, tenant_id: TENANT, table_name: "clients", row_id: o.id, op: "update", source_key: o.cert, source_ref: { 理由: "認定行・KK と一致する給付率に合わせる", kk: o.kk }, before: o.before, after: o.after });
  if (e2) throw new Error(`data_import_rows: ${e2.message}`);
}
const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", batch.id);
if (e3) throw new Error(e3.message);
console.log(`完了 batch ${batch.id} / 取り消しは --revert ${batch.id}`);
