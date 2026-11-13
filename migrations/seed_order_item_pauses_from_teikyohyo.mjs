/**
 * 福祉用具 貸与の休止期間 (order_item_pauses) の初期投入 — 提供票から組み直した貸与 (batch 8583d46b) の休止。2026-11-09 FY-PZ。
 *
 *   node migrations/seed_order_item_pauses_from_teikyohyo.mjs                        # DRY RUN (既定。DB は読むだけ)
 *   node migrations/seed_order_item_pauses_from_teikyohyo.mjs --execute              # ★ user 承認後 (表の適用後)
 *   node migrations/seed_order_item_pauses_from_teikyohyo.mjs --revert <batch_id> [--execute]
 *   --teikyo-dir <dir>  既定 kaigo-app/伝送データ/ケアサポ/福祉用具/用具貸与期間_20261109 (提供票_YYYYMM.csv)
 *
 * 何を入れるか:
 *   rebuild_rentals_from_teikyohyo.mjs が 提供票の「同じ行の中で 0 が挟まる日」(= 休止) を
 *   order_items.notes に "[休止 YYYY-MM-DD〜YYYY-MM-DD]" と書いた。その明細 (notes に取込マーカー
 *   "[teikyo-rebuild-" がある明細だけ) の休止を 1 期間 1 行で order_item_pauses に入れる (source='teikyohyo')。
 *   ★ notes の文字列をそのまま信じない: 各期間を 提供票 から作り直した休止 (利用者名 × 月 × 休止の日) と突き合わせ、
 *     提供票に同じ休止がある期間だけを入れる。無いもの・貸与期間の外にかかるもの・書式外は 対象外 として表示 (書かない)。
 * 既にある行 (同じ order_item_id × pause_from × pause_to) は何もしない。
 * 記録: data_import_batches / data_import_rows (op=insert, after = 入れた行)。--revert は 記録した行のうち
 *   今も同じ期間で残っている行だけ消す。
 * 同時実行: _exec_lock.mjs (FY-L) — 同じ script の --execute / --revert --execute が 2 本同時に走らないようにする。
 * 表が無い (migrations/order_item_pauses.sql 未適用) なら DRY RUN は計画だけ出し、--execute は止まる (exit 2)。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";
import { resolveFukuyoguOffice, latestTeikyoDir, describeFukuyoguOffice } from "./_fukuyogu_office.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const REPO_ROOT = resolve(HERE, "../../..");
// 対象事業所: 既定 ケアサポ (介護ショップ ケア・サポート千葉 1bfc0d57…)。--area / --office-bn で切替 (_fukuyogu_office.mjs)
//   この script は事業所で絞らない (提供票の利用者+用具で order_items を引く)。事業所は 既定の提供票の置き場を決めるだけ
const FO = resolveFukuyoguOffice(argv);
if (!FO.isDefault) console.log(describeFukuyoguOffice(FO));
const TEIKYO_DIR = resolve(opt("--teikyo-dir") ?? latestTeikyoDir(FO.dir) ?? join(FO.dir, "用具貸与期間_(未着)"));
const SCRIPT_REL = "apps/order-app/migrations/seed_order_item_pauses_from_teikyohyo.mjs";
const TENANT = "kt-group";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "seed-order-item-pauses";
const TABLE = "order_item_pauses";
const REBUILD_MARK = "[teikyo-rebuild-";
const NOTE_MARK = "[seed-order-item-pauses-20261109]";
let EXEC_LOCK = null;

const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const nf = (s) => (s ?? "").normalize("NFKC").trim();
/** 氏名の照合キー: 空白・括弧書き (提供票は「和田 千枝子 (…)」のように注記が付く) を外し、異体字を寄せる (青栁/青柳) */
const VARIANTS = { 栁: "柳", 髙: "高", 﨑: "崎", 邊: "辺", 邉: "辺", 齋: "斎", 齊: "斉", 濵: "浜", 濱: "浜" };
const nName = (s) => nf(s).replace(/[(（].*$/, "").replace(/[\s　]+/g, "").replace(/[栁髙﨑邊邉齋齊濵濱]/g, (c) => VARIANTS[c]);

function readEnv() {
  const p = join(HERE, "../../kaigo-app/.env.local");
  const env = {};
  for (const l of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error(`${p} に SUPABASE_URL / SERVICE_ROLE_KEY が無い`);
  return env;
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
async function selectIn(sb, table, select, col, ids, extra = (q) => q) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll(sb, table, select, (q) => extra(q.in(col, c))));
  return out;
}

// ── 提供票: 実績行の「同じ行の中で 0 が挟まる日」= 休止 ─────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
/** @returns {Set<string>} "氏名|YYYY-MM-DD|YYYY-MM-DD" (休止の初日・最終日) */
function readTeikyoPauses(dir) {
  const files = readdirSync(dir).filter((f) => /^提供票_\d{6}\.csv$/i.test(f)).sort();
  if (!files.length) throw new Error(`★ ${dir} に 提供票_YYYYMM.csv が無い`);
  const keys = new Set();
  let rowsWithGap = 0;
  for (const f of files) {
    const lines = new TextDecoder("shift-jis").decode(readFileSync(join(dir, f))).split(/\r\n|\n/).filter((l) => l.length > 0);
    const head = parseCsvLine(lines[0]);
    const col = (k) => { const i = head.indexOf(k); if (i < 0) throw new Error(`★ ${f} に列「${k}」が無い`); return i; };
    const c1 = col("1日"), cPa = col("予定／実績"), cYm = col("提供年月"), cName = col("利用者名");
    if (col("31日") - c1 !== 30) throw new Error(`★ ${f}: 1日〜31日の列が連続していない`);
    for (const l of lines.slice(1)) {
      const r = parseCsvLine(l);
      if (r.length !== head.length) throw new Error(`★ ${f}: 列数 ${r.length} ≠ ${head.length}`);
      if (nf(r[cPa]) !== "実績") continue;
      const ym = nf(r[cYm]).replace("/", "-");
      const [y, m] = ym.split("-").map(Number);
      const nd = new Date(y, m, 0).getDate();
      const marks = r.slice(c1, c1 + nd).map((v) => nf(v) === "1");
      const on = marks.map((v, i) => (v ? i + 1 : 0)).filter(Boolean);
      if (on.length < 2) continue;
      let had = false;
      for (let i = 0; i + 1 < on.length; i++) {
        if (on[i + 1] - on[i] <= 1) continue;
        had = true;
        const d = (n) => `${ym}-${String(n).padStart(2, "0")}`;
        keys.add(`${nName(r[cName])}|${d(on[i] + 1)}|${d(on[i + 1] - 1)}`);
      }
      if (had) rowsWithGap++;
    }
  }
  return { keys, files, rowsWithGap };
}

async function tableExists(sb) {
  const { error } = await sb.from(TABLE).select("id").limit(1);
  if (!error) return { ok: true };
  if (error.code === "PGRST205" || error.code === "42P01") return { ok: false, why: `表 ${TABLE} が未適用 (migrations/order_item_pauses.sql を SQL Editor で流してから)` };
  throw new Error(`${TABLE}: ${error.message}`);
}

const PAUSE_RE = /\[休止 (\d{4}-\d{2}-\d{2})〜(\d{4}-\d{2}-\d{2})\]/g;

async function plan(sb, teikyo, tableOk) {
  const items = await selectAll(sb, "order_items", "id,order_id,product_code,notes,rental_start_date,rental_end_date,status",
    (q) => q.eq("tenant_id", TENANT).like("notes", "%休止%"));
  const orders = new Map((await selectIn(sb, "orders", "id,client_id", "id", items.map((i) => i.order_id))).map((o) => [o.id, o]));
  const clients = new Map((await selectIn(sb, "clients", "id,name", "id", [...orders.values()].map((o) => o.client_id).filter(Boolean))).map((c) => [c.id, c]));
  const existing = !tableOk ? new Set() : new Set((await selectIn(sb, TABLE, "order_item_id,pause_from,pause_to", "order_item_id", items.map((i) => i.id),
    (q) => q.eq("tenant_id", TENANT))).map((r) => `${r.order_item_id}|${r.pause_from}|${r.pause_to}`));
  const ops = [], skip = [], same = [];
  let periods = 0;
  for (const it of items) {
    const name = clients.get(orders.get(it.order_id)?.client_id)?.name ?? null;
    const notes = it.notes ?? "";
    const found = [...notes.matchAll(PAUSE_RE)];
    const rawCount = (notes.match(/\[休止/g) ?? []).length;
    if (rawCount !== found.length) skip.push({ item: it.id, name, why: `notes の休止 ${rawCount} 件中 ${rawCount - found.length} 件が書式外: ${notes}` });
    if (!notes.includes(REBUILD_MARK)) {
      if (found.length) skip.push({ item: it.id, name, why: `提供票の組み直しマーカー (${REBUILD_MARK}) が無い明細 — 手で書いた notes かもしれないので入れない: ${notes}` });
      continue;
    }
    for (const [, from, to] of found) {
      periods++;
      const base = { item: it.id, name, product: it.product_code, from, to };
      if (to < from) { skip.push({ ...base, why: "終わりが始まりより前" }); continue; }
      if (!it.rental_start_date || from < it.rental_start_date.slice(0, 10) || (it.rental_end_date && to > it.rental_end_date.slice(0, 10))) {
        skip.push({ ...base, why: `貸与期間 (${it.rental_start_date}〜${it.rental_end_date ?? ""}) の外にかかる` }); continue;
      }
      if (!name || !teikyo.keys.has(`${nName(name)}|${from}|${to}`)) { skip.push({ ...base, why: "提供票に同じ休止 (利用者名 × 日) が無い" }); continue; }
      if (existing.has(`${it.id}|${from}|${to}`)) { same.push(base); continue; }
      ops.push({
        key: `${it.id}|${from}|${to}`, name, product: it.product_code,
        row: { tenant_id: TENANT, order_item_id: it.id, pause_from: from, pause_to: to, reason: null, source: "teikyohyo",
          notes: `${NOTE_MARK} 提供票の実績で印の無い日 (同じ行の中で 0 が挟まる)` },
      });
    }
  }
  return { items, periods, ops, skip, same };
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [relative(REPO_ROOT, TEIKYO_DIR).replace(/\\/g, "/")], script: SCRIPT_REL,
    args: argv.join(" "), step: STEP_NAME, notes: `貸与の休止期間の初期投入 ${ops.length} 期間 (order_items.notes の [休止 …] を提供票で裏取り)`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_seed_order_item_pauses_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  for (const o of ops) {
    const { data, error } = await sb.from(TABLE).insert(o.row).select("id").single();
    if (error) await fail(`insert ${TABLE} ${o.name} ${o.row.pause_from}〜${o.row.pause_to}: ${error.message}`);
    const { error: e2 } = await sb.from("data_import_rows").insert({
      batch_id: BATCH, tenant_id: TENANT, table_name: TABLE, row_id: data.id, op: "insert", source_key: o.key,
      source_ref: { 理由: "提供票の実績で同じ行の中に印の無い日 (休止)", 利用者: o.name, 用具: o.product }, before: null, after: o.row,
    });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const { count: c2, error: e4 } = await sb.from(TABLE).select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT).like("notes", `${NOTE_MARK}%`);
  if (e4) await fail(`verify ${TABLE}: ${e4.message}`);
  console.log(`  確認: ${TABLE} のマーカー付き行 ${c2} 件`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 期間。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId).eq("table_name", TABLE));
  const cur = new Map((await selectIn(sb, TABLE, "id,pause_from,pause_to", "id", recs.map((r) => r.row_id))).map((r) => [r.id, r]));
  const back = recs.filter((r) => { const c = cur.get(r.row_id); return c && c.pause_from === r.after.pause_from && c.pause_to === r.after.pause_to; });
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 消す ${back.length} / 記録 ${recs.length} (期間が変わった行・既に無い行は触らない)`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し (同時実行ロック用。行の記録はしない)` }, async () => {
    for (const r of back) {
      const { error, count } = await sb.from(TABLE).delete({ count: "exact" }).eq("id", r.row_id).eq("pause_from", r.after.pause_from).eq("pause_to", r.after.pause_to);
      if (error || count !== 1) throw new Error(`revert ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
    }
    const status = back.length === recs.length ? "reverted" : "partially_reverted";
    const { error } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
    if (error) throw new Error(`batch: ${error.message}`);
    console.log(`取り消し完了 (${status})`);
  });
}

console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  ${REVERT ? `--revert ${REVERT}` : "休止の初期投入"}`);
const sb = await makeSb();
if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
const t = await tableExists(sb);
if (!t.ok && (EXECUTE || REVERT)) {
  console.log(`\n★ ${t.why} — ここで止めます (DB には何も書いていません)`);
  process.exit(2);
}
if (REVERT) { await revert(sb, REVERT); process.exit(0); }
const teikyo = readTeikyoPauses(TEIKYO_DIR);
console.log(`提供票 ${relative(REPO_ROOT, TEIKYO_DIR)} (${teikyo.files.length} か月): 休止のある実績行 ${teikyo.rowsWithGap} / 休止 (氏名×期間) ${teikyo.keys.size} 種`);
const { items, periods, ops, skip, same } = await plan(sb, teikyo, t.ok);
if (!t.ok) console.log(`\n★ ${t.why} — 計画だけ表示しました (既存行との照合はしていない。--execute は表の適用後に)`);
console.log(`\nnotes に「休止」がある明細 ${items.length} / 休止期間 ${periods}`);
console.log(`入れる ${ops.length} 期間 (明細 ${new Set(ops.map((o) => o.row.order_item_id)).size}) / 入力済み ${same.length} / 対象外 ${skip.length}`);
const byMonth = new Map();
for (const o of ops) { const k = o.row.pause_from.slice(0, 7); byMonth.set(k, (byMonth.get(k) ?? 0) + 1); }
console.log(`  月別: ${[...byMonth].sort().map(([k, v]) => `${k} ${v}`).join(" / ")}`);
for (const o of ops.slice(0, 10)) console.log(`  + ${o.name}  ${o.product}  ${o.row.pause_from}〜${o.row.pause_to}`);
if (ops.length > 10) console.log(`  … ほか ${ops.length - 10} 期間`);
for (const s of skip) console.log(`  (対象外) ${JSON.stringify(s)}`);
if (EXECUTE && ops.length) await execute(sb, ops);
