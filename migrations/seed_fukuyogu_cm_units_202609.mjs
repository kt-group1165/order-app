/**
 * 福祉用具 CM 指示単位数 (fukuyogu_cm_units) の初期値 — 2026-09 の 6 名ぶん。2026-11-09 user 合意。
 *
 *   node migrations/seed_fukuyogu_cm_units_202609.mjs                       # DRY RUN (既定。DB は読むだけ)
 *   node migrations/seed_fukuyogu_cm_units_202609.mjs --execute
 *   node migrations/seed_fukuyogu_cm_units_202609.mjs --revert <batch_id> [--execute]
 *   --kk <KK*.CSV>  既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV
 *
 * 何を入れるか: KK の 集計 (10) レコードで 項9 計画単位数 < 項10 限度額管理対象単位数 (= CM の給付管理で頭打ち) の人の
 *   項9 の値を、その月・ケアサポ (1272400050) の CM 指示単位数として入れる。
 *   項9 は ケアマネが給付管理票に書いた計画単位数 (ほのぼのが決めた値ではない) なので、ほのぼのの出力で当方の入力を
 *   直す「循環」(SESSION_START ⑬) にはあたらない。項9 = 項10 の人 (頭打ちなし) は入れない (空欄 = 実績で請求)。
 * 引き当て: KK の (保険者, 被保番) が clients の番号 または client_insurance_records に一致する削除されていない client が
 *   **1 人だけ** のとき。0 人・複数は対象外として表示 (書かない)。
 * 既にその 利用者×月×事業所 の行があれば: 同じ値なら何もしない / 違う値なら上書きせず対象外 (画面で人が入れた値を優先)。
 * 記録: data_import_batches / data_import_rows (op=insert, after = 入れた行)。--revert は「現在値 = after」の行だけ消す。
 * 表が無い (migrations/fukuyogu_cm_units.sql 未適用) なら「表未適用」で止まる。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
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
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const REPO_ROOT = resolve(HERE, "../../..");
const KK_PATH = resolve(opt("--kk") ?? join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV"));
const SCRIPT_REL = "apps/order-app/migrations/seed_fukuyogu_cm_units_202609.mjs";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "seed-fukuyogu-cm-units";
const CAPASAPO_OFFICE = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
const CAPASAPO_BN = "1272400050";
const TABLE = "fukuyogu_cm_units";

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

/** KK の 集計 (10) で 項9 < 項10 の人 (= CM の計画単位数で頭打ち) */
function readCapped(path) {
  const lines = readFileSync(path, "latin1").split(/\r\n|\n/).filter(Boolean);
  const unq = (s) => s.replace(/^"(.*)"$/, "$1");
  const out = [];
  let n10 = 0;
  for (const l of lines) {
    const c = l.split(",").map(unq);
    if (c[0] !== "2" || c[3] !== "10" || !["7131", "7132"].includes(c[2])) continue;
    n10++;
    // c[k+1] = 項k  (c[0]=レコード種別 2, c[1]=レコード番号)
    if (c[5] !== CAPASAPO_BN) throw new Error(`${path}: 事業所番号 ${c[5]} (ケアサポ ${CAPASAPO_BN} の KK ではない)`);
    const ym = c[4], plan = Number(c[10]), limit = Number(c[11]), billed = Number(c[15]);
    if (!(plan < limit)) continue;
    if (billed !== plan) throw new Error(`${path}: ${c[7]} 項14 ${billed} ≠ 項9 ${plan} (想定外の形)`);
    out.push({ form: c[2], month: `${ym.slice(0, 4)}-${ym.slice(4, 6)}`, insurerRaw: c[6], insuredRaw: c[7], insurer: nInsurer(c[6]), insured: nInsured(c[7]), plan, limit });
  }
  if (!n10) throw new Error(`${path}: 集計 (10) レコードが 0 件`);
  return { capped: out, n10 };
}

async function tableExists(sb) {
  // ⚠ head: true (HEAD) だと 404 に本文が無く error.code が取れないので、普通の GET で見る
  const { error } = await sb.from(TABLE).select("id").limit(1);
  if (!error) return { ok: true };
  if (error.code === "PGRST205" || error.code === "42P01") return { ok: false, why: `表 ${TABLE} が未適用 (migrations/fukuyogu_cm_units.sql を SQL Editor で流してから)` };
  throw new Error(`${TABLE}: ${error.message}`);
}

async function plan(sb, capped, tableOk) {
  const keys = new Set(capped.map((k) => `${k.insurer}|${k.insured}`));
  const ins = await selectAll(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number", (q) => q.eq("tenant_id", TENANT));
  const byKey = new Map();
  const add = (k, cid) => { if (!keys.has(k)) return; if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(cid); };
  for (const r of ins) add(`${nInsurer(r.insurer_number ?? "")}|${nInsured(r.insured_number ?? "")}`, r.client_id);
  const insuredList = [...new Set(capped.map((k) => k.insuredRaw))];
  const direct = await selectIn(sb, "clients", "id,insurer_number,insured_number", "insured_number", insuredList, (q) => q.eq("tenant_id", TENANT));
  for (const c of direct) add(`${nInsurer(c.insurer_number ?? "")}|${nInsured(c.insured_number ?? "")}`, c.id);
  const cands = [...new Set([...byKey.values()].flatMap((s) => [...s]))];
  const clients = new Map((await selectIn(sb, "clients", "id,name,deleted_at,office_id", "id", cands)).map((c) => [c.id, c]));
  const months = [...new Set(capped.map((k) => k.month))];
  const existing = !tableOk ? new Map() : new Map((await selectIn(sb, TABLE, "id,client_id,service_month,units", "client_id", cands,
    (q) => q.eq("tenant_id", TENANT).eq("office_id", CAPASAPO_OFFICE).in("service_month", months))).map((r) => [`${r.client_id}|${r.service_month}`, r]));
  const ops = [], skip = [], same = [];
  for (const k of capped) {
    const key = `${k.form}|${k.insurer}|${k.insured}`;
    const cs = [...(byKey.get(`${k.insurer}|${k.insured}`) ?? [])].map((id) => clients.get(id)).filter((c) => c && !c.deleted_at);
    if (cs.length !== 1) { skip.push({ key, why: cs.length ? `client が ${cs.length} 人 (${cs.map((c) => c.name).join(" / ")})` : "client が見つからない" }); continue; }
    const c = cs[0];
    const ex = existing.get(`${c.id}|${k.month}`);
    if (ex) {
      if (ex.units === k.plan) same.push({ name: c.name, units: k.plan });
      else skip.push({ key, name: c.name, why: `既に ${ex.units} 単位が入っている (KK は ${k.plan}) — 画面で入れた値を優先して上書きしない` });
      continue;
    }
    ops.push({
      key, name: c.name, limit: k.limit,
      row: { tenant_id: TENANT, office_id: CAPASAPO_OFFICE, client_id: c.id, service_month: k.month, units: k.plan,
        note: `[seed-fukuyogu-cm-units-202609] 給付管理の計画単位数 (ほのぼの KK ${k.form}-10 項9。実績 ${k.limit})` },
    });
  }
  return { ops, skip, same };
}

async function execute(sb, ops) {
  const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [relative(REPO_ROOT, KK_PATH).replace(/\\/g, "/")], script: SCRIPT_REL,
    args: argv.join(" "), step: STEP_NAME, status: "running", notes: `福祉用具 CM 指示単位数の初期値 ${ops.length} 名 (KK 10 項9 < 項10)`,
  }).select("id").single();
  if (bErr) throw new Error(`data_import_batches: ${bErr.message}`);
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_seed_fukuyogu_cm_units_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { data, error } = await sb.from(TABLE).insert(o.row).select("id").single();
    if (error) await fail(`insert ${TABLE} ${o.name}: ${error.message}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({
      batch_id: BATCH, tenant_id: TENANT, table_name: TABLE, row_id: data.id, op: "insert", source_key: o.key,
      source_ref: { 理由: "KK 10 項9 計画単位数 < 項10 限度額管理対象 (CM の給付管理で頭打ち)", 実績: o.limit }, before: null, after: o.row,
    });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const { count: c2, error: e4 } = await sb.from(TABLE).select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT).eq("office_id", CAPASAPO_OFFICE).like("note", "[seed-fukuyogu-cm-units-202609]%");
  if (e4) await fail(`verify ${TABLE}: ${e4.message}`);
  console.log(`  確認: ${TABLE} のマーカー付き行 ${c2} 件`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 名。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId).eq("table_name", TABLE));
  const cur = new Map((await selectIn(sb, TABLE, "id,units", "id", recs.map((r) => r.row_id))).map((r) => [r.id, r]));
  const back = recs.filter((r) => cur.get(r.row_id)?.units === r.after.units);
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 消す ${back.length} / 記録 ${recs.length} (値が変わった行・既に無い行は触らない)`);
  if (!EXECUTE) return;
  for (const r of back) {
    const { error, count } = await sb.from(TABLE).delete({ count: "exact" }).eq("id", r.row_id).eq("units", r.after.units);
    if (error || count !== 1) throw new Error(`revert ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
  }
  const status = back.length === recs.length ? "reverted" : "partially_reverted";
  const { error } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
  if (error) throw new Error(`batch: ${error.message}`);
  console.log(`取り消し完了 (${status})`);
}

const { capped, n10 } = readCapped(KK_PATH);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  KK ${relative(REPO_ROOT, KK_PATH)} / 集計レコード ${n10} / 頭打ち (項9 < 項10) ${capped.length} 名`);
for (const k of capped) console.log(`  KK ${k.form} ${k.insurerRaw}|${k.insuredRaw}  計画 ${k.plan} / 実績 ${k.limit} (超過 ${k.limit - k.plan})`);
const sb = await makeSb();
const t = await tableExists(sb);
if (!t.ok && (EXECUTE || REVERT)) {
  console.log(`\n★ ${t.why} — ここで止めます (DB には何も書いていません)`);
  process.exit(2);
}
if (REVERT) { await revert(sb, REVERT); process.exit(0); }
const { ops, skip, same } = await plan(sb, capped, t.ok);
if (!t.ok) console.log(`\n★ ${t.why} — 引き当てだけ表示しました (既存行との照合はしていない。--execute は表の適用後に)`);
console.log(`\n入れる ${ops.length} 名 / 入力済み (同じ値) ${same.length} / 対象外 ${skip.length}`);
for (const o of ops) console.log(`  + ${o.name}  ${o.row.service_month}  ${o.row.units} 単位 (実績 ${o.limit})  client ${o.row.client_id}`);
for (const s of same) console.log(`  = ${s.name} ${s.units} (入力済み)`);
for (const s of skip) console.log(`  (対象外) ${JSON.stringify(s)}`);
if (EXECUTE && ops.length) await execute(sb, ops);
