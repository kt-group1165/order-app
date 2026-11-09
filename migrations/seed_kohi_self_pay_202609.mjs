/**
 * 生保の本人支払額 (client_public_expenses.self_pay_amount) を ほのぼの公費 CSV から入れる — 中島 紀久子 1 名。2026-11-09。
 *
 *   node migrations/seed_kohi_self_pay_202609.mjs                       # DRY RUN (既定。DB は読むだけ)
 *   node migrations/seed_kohi_self_pay_202609.mjs --execute
 *   node migrations/seed_kohi_self_pay_202609.mjs --revert <batch_id> [--execute]
 *   --csv <公費_*.CSV>   既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/公費_全件.CSV (cp932)
 *   --insured <被保番,…> 既定 = 1000063779 (中島 紀久子)
 *
 * 背景: 当方は 中島 紀久子 の 2026-09 を 公費請求 1,200・本人 0 で出していたが、ほのぼの (KK261004 7132-01 項40/41・10 項19/20)
 *   は 公費請求 0・公費本人負担 1,200。介護券の本人支払額 (月 1,200 円) を持っていなかったため。
 *   本人支払額は福祉事務所が決めた値 (ほのぼのが計算した値ではない) なので、ほのぼのの出力で当方の入力を直す「循環」にはあたらない。
 * 何を入れるか: 公費 CSV の 本人支払額 (列「本人支払額」) が入っている行のうち、対象 client の DB の公費行と
 *   (負担者番号 = 法制コード2桁+6桁, 受給者番号, 有効開始, 有効終了) が一致する行に self_pay_amount を書く。
 *   DB 側が既に同じ値なら何もしない / 違う値が入っていれば上書きせず対象外 (画面で人が入れた値を優先)。
 * 引き当て: clients.insured_number が一致し、氏名 (空白除く) と生年月日が CSV と一致する削除されていない client が 1 人だけのとき。
 * 記録: data_import_batches / data_import_rows (op=update, before/after = self_pay_amount)。--revert は「現在値 = after」の行だけ null に戻す。
 * 列が無い (migrations/fukuyogu_kohi_month_mode.sql 未適用) なら DRY RUN は引き当てだけ表示、--execute は exit 2 で止まる。
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
const { TENANT, readEnv, nfkc, nName, nDate, parseCsvLine } = core;

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const REPO_ROOT = resolve(HERE, "../../..");
const CSV_PATH = resolve(opt("--csv") ?? join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/公費_全件.CSV"));
const INSURED = (opt("--insured") ?? "1000063779").split(",").map((s) => s.trim()).filter(Boolean);
const SCRIPT_REL = "apps/order-app/migrations/seed_kohi_self_pay_202609.mjs";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "seed-kohi-self-pay";
const TABLE = "client_public_expenses";

const dOrNull = (s) => (nfkc(s) ? nDate(s) : null);
const iOrNull = (s) => { const t = nfkc(s).replace(/,/g, ""); if (!t) return null; const n = Number(t); return Number.isInteger(n) ? n : NaN; };

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

function readKohiCsv(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`${path} に列「${name}」が無い`); return i; };
  const C = { no: col("利用者番号"), name: col("利用者名"), birth: col("生年月日"), hob: col("法制コード"), fut: col("負担者番号"), jyu: col("受給者番号"),
    start: col("有効期限－開始日"), end: col("有効期限－終了日"), pay: col("本人支払額") };
  const rows = lines.slice(1).map(parseCsvLine);
  const bad = rows.filter((r) => r.length !== head.length).length;
  if (bad) throw new Error(`${path}: 列数が ${head.length} でない行が ${bad} 行`);
  return rows.map((r) => {
    const hob = nfkc(r[C.hob]).split(/\s+/)[0];
    const fut6 = nfkc(r[C.fut]);
    return { userNo: nfkc(r[C.no]), name: nName(r[C.name]), birth: dOrNull(r[C.birth]), hob, fut: fut6.length === 6 ? hob + fut6 : fut6,
      jyu: nfkc(r[C.jyu]) || null, start: dOrNull(r[C.start]), end: dOrNull(r[C.end]), pay: iOrNull(r[C.pay]) };
  });
}

async function columnExists(sb) {
  const { error } = await sb.from(TABLE).select("id, self_pay_amount").limit(1);
  if (!error) return { ok: true };
  return { ok: false, why: `${TABLE}.self_pay_amount が未適用 (${error.message}) — migrations/fukuyogu_kohi_month_mode.sql を SQL Editor で流してから` };
}

async function plan(sb, csv, colOk) {
  const ops = [], skip = [], same = [];
  const clients = await selectAll(sb, "clients", "id,name,birth_date,insured_number,deleted_at", (q) => q.eq("tenant_id", TENANT).in("insured_number", INSURED));
  for (const insured of INSURED) {
    const cs = clients.filter((c) => c.insured_number === insured && !c.deleted_at);
    if (cs.length !== 1) { skip.push({ key: insured, why: cs.length ? `client が ${cs.length} 人` : "client が見つからない" }); continue; }
    const c = cs[0];
    const mine = csv.filter((k) => k.name === nName(c.name) && k.birth === nDate(c.birth_date));
    const userNos = [...new Set(mine.map((k) => k.userNo))];
    if (userNos.length !== 1) { skip.push({ key: insured, name: c.name, why: userNos.length ? `CSV の利用者番号が ${userNos.join("/")} の複数` : "CSV に同じ氏名・生年月日の行が無い" }); continue; }
    const withPay = mine.filter((k) => k.pay != null && k.pay !== 0);
    const badPay = withPay.filter((k) => !Number.isInteger(k.pay) || k.pay < 0);
    for (const k of badPay) skip.push({ key: insured, name: c.name, why: `本人支払額を読めない (${k.start}〜${k.end})` });
    const db = await selectAll(sb, TABLE, colOk ? "id,client_id,hohei_code,futan_sha_number,jukyu_sha_number,valid_start,valid_end,self_pay_amount" : "id,client_id,hohei_code,futan_sha_number,jukyu_sha_number,valid_start,valid_end",
      (q) => q.eq("tenant_id", TENANT).eq("client_id", c.id));
    for (const k of withPay.filter((x) => !badPay.includes(x))) {
      const hits = db.filter((e) => nfkc(e.futan_sha_number) === k.fut && (nfkc(e.jukyu_sha_number) || null) === k.jyu && (e.valid_start ?? null) === k.start && (e.valid_end ?? null) === k.end);
      const key = `ほのぼの利用者番号:${k.userNo}|${k.fut}|${k.jyu}|${k.start}`;
      if (hits.length !== 1) { skip.push({ key, name: c.name, why: hits.length ? `DB の公費行が ${hits.length} 行` : `DB に同じ公費行が無い (${k.start}〜${k.end})` }); continue; }
      const e = hits[0];
      const have = colOk ? (e.self_pay_amount ?? null) : null;
      if (have === k.pay) { same.push({ name: c.name, period: `${k.start}〜${k.end}`, pay: k.pay }); continue; }
      if (have != null) { skip.push({ key, name: c.name, why: `既に ${have} 円が入っている (CSV は ${k.pay}) — 画面で入れた値を優先して上書きしない` }); continue; }
      ops.push({ key, name: c.name, id: e.id, period: `${k.start}〜${k.end}`, before: { self_pay_amount: have }, after: { self_pay_amount: k.pay } });
    }
  }
  return { ops, skip, same };
}

async function execute(sb, ops) {
  const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [relative(REPO_ROOT, CSV_PATH).replace(/\\/g, "/")], script: SCRIPT_REL,
    args: argv.join(" "), step: STEP_NAME, status: "running", notes: `生保の本人支払額 ${ops.length} 行 (被保番 ${INSURED.join(",")})`,
  }).select("id").single();
  if (bErr) throw new Error(`data_import_batches: ${bErr.message}`);
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_seed_kohi_self_pay_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { error, count } = await sb.from(TABLE).update(o.after, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT).is("self_pay_amount", null);
    if (error) await fail(`update ${TABLE} ${o.id}: ${error.message}`);
    if (count !== 1) await fail(`update ${TABLE} ${o.id}: 更新件数 ${count} (他で値が入った?)`);
    const { error: e2 } = await sb.from("data_import_rows").insert({
      batch_id: BATCH, tenant_id: TENANT, table_name: TABLE, row_id: o.id, op: "update", source_key: o.key,
      source_ref: { 理由: "ほのぼの公費 CSV の本人支払額 (介護券)", 期間: o.period }, before: o.before, after: o.after,
    });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const got = await selectAll(sb, TABLE, "id,self_pay_amount", (q) => q.in("id", ops.map((o) => o.id)));
  const ng = ops.filter((o) => got.find((g) => g.id === o.id)?.self_pay_amount !== o.after.self_pay_amount);
  if (ng.length) await fail(`verify: 値が入っていない行 ${ng.length}`);
  console.log(`  確認: ${got.length} 行すべて self_pay_amount が入った`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 行。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId).eq("table_name", TABLE));
  const cur = new Map((await selectAll(sb, TABLE, "id,self_pay_amount", (q) => q.in("id", recs.map((r) => r.row_id)))).map((r) => [r.id, r]));
  const back = recs.filter((r) => cur.get(r.row_id)?.self_pay_amount === r.after.self_pay_amount);
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 戻す ${back.length} / 記録 ${recs.length} (値が変わった行・既に無い行は触らない)`);
  if (!EXECUTE) return;
  for (const r of back) {
    const { error, count } = await sb.from(TABLE).update({ self_pay_amount: r.before?.self_pay_amount ?? null }, { count: "exact" }).eq("id", r.row_id).eq("self_pay_amount", r.after.self_pay_amount);
    if (error || count !== 1) throw new Error(`revert ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
  }
  const status = back.length === recs.length ? "reverted" : "partially_reverted";
  const { error } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
  if (error) throw new Error(`batch: ${error.message}`);
  console.log(`取り消し完了 (${status})`);
}

const csv = readKohiCsv(CSV_PATH);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  CSV ${relative(REPO_ROOT, CSV_PATH)} / ${csv.length} 行 / 本人支払額あり ${csv.filter((k) => k.pay).length} 行 / 対象被保番 ${INSURED.join(",")}`);
const sb = await makeSb();
const col = await columnExists(sb);
if (!col.ok && (EXECUTE || REVERT)) {
  console.log(`\n★ ${col.why} — ここで止めます (DB には何も書いていません)`);
  process.exit(2);
}
if (REVERT) { await revert(sb, REVERT); process.exit(0); }
const { ops, skip, same } = await plan(sb, csv, col.ok);
if (!col.ok) console.log(`\n★ ${col.why} — 引き当てだけ表示しました (既存値との照合はしていない。--execute は列の適用後に)`);
console.log(`\n入れる ${ops.length} 行 / 入力済み (同じ値) ${same.length} / 対象外 ${skip.length}`);
for (const o of ops) console.log(`  + ${o.name}  ${o.period}  本人支払額 ${o.after.self_pay_amount} 円  (公費行 ${o.id})`);
for (const s of same) console.log(`  = ${s.name} ${s.period} ${s.pay} 円 (入力済み)`);
for (const s of skip) console.log(`  - ${s.name ?? ""} ${s.key}: ${s.why}`);
if (!EXECUTE) { console.log("\nDRY RUN — DB には何も書いていません。--execute で反映"); process.exit(0); }
if (ops.length === 0) { console.log("入れるものがありません"); process.exit(0); }
await execute(sb, ops);
