/**
 * 提供票からの貸与の組み直し (rebuild_rentals_from_teikyohyo.mjs / batch 8583d46b-3572-415d-bffe-a369e90ff28c・2026-11-09) の是正
 *
 *   node migrations/fix_rebuild_rentals_202611.mjs                       # DRY RUN (既定)
 *   node migrations/fix_rebuild_rentals_202611.mjs --execute             # 本番 (★ user 承認後)
 *   node migrations/fix_rebuild_rentals_202611.mjs --revert <batch_id> [--execute]
 *   node migrations/fix_rebuild_rentals_202611.mjs --cleanup-batch <batch_id> [--execute]
 *     (--revert / --cleanup-batch は sync_fukuyogu_from_honobono.mjs の汎用処理に渡す。data_import_rows の before/after で戻す)
 *
 *   --keep-master-price   EQ-000246 の equipment_master.rental_price (5,800) を変えない (既定は 5,700 に揃える)
 *   --out-dir <dir>       計画 JSON の出力先 (既定 OS の一時フォルダ/teikyo-rebuild-fix)
 *
 * ── 是正の中身 ─────────────────────────────────────────────────────────────
 *   1. 用具の取り違えで二重になった明細 2 件を削除 (組み直しが「+単位+中止」で別の TAIS を選び、元の明細と別に insert した)
 *        d42c37ba… 松本 ちよ 00167-000437   (元の明細 1aed1f73… 00167-000435 が残っている)
 *        4ed8b7c6… 小山 いわ 00563-000021   (元の明細 f9100f6d… 00563-000019 が残っている)
 *      削除の前提 (どれか外れたら止める): 二重の明細が batch で入れたときのまま / 元の明細が同じ利用者で 有効 (rental_started か
 *      terminated・取消なし) で 二重の明細の期間を覆う / 二重の明細を参照する行 (単位上書き・価格変更・モニタリング・
 *      doc_tasks・care_plan_elements) が無い
 *   2. 介護 0 円 (batch の insert で payment_type='介護' かつ rental_price=0 = 自費レンタル欄が空の 0 円付属) → payment_type='自費'
 *      統合の判定: 同じ利用者 (orders.client_id)・同じ product_code・同じ数量・どちらも単価 0 (自費 か この是正の対象)・
 *                  状態 rental_started/terminated・取消なし で、前の明細の終了日 + 1 日 = 後の明細の開始日
 *                  (前後とも 1 対 1 のときだけつなぐ。複数あれば つながず報告)
 *      つながった列 (2 明細以上) は 先頭の明細に寄せる: 先頭の 終了日・状態 を 末尾の明細のものに延ばし、payment_type='自費'、
 *      notes に 後ろの明細の [4/1以前から] [休止 …] 等 (先頭に無い [...]) を足す。後ろの明細は削除 (参照があれば止める)
 *      つながらない対象は 自費に変えるだけ
 *   3. 価格履歴 (equipment_price_history: tenant_id, product_code, rental_price, valid_from) を追加
 *        00122-000702 (CRT-SG-3B)   2026-04-01 7,600 円 / 2026-10-01 7,300 円
 *            ほのぼの 用具マスタの 旧行 (●CRT-SG-3B 760 単位) が 4〜9 月の提供票、新行 (自走CRT-SG-3B 730) が 10 月の提供票
 *            (秦 幸三)。equipment_master.rental_price は 7,300 (今の値) のまま
 *        EQ-000246 (エバープラウド 83R・TAIS 00170-000968)   2026-10-01 5,700 円
 *            ほのぼの 用具マスタの単位は 570 (小原 保三 10/26〜 の提供票も 半額 285 = 570)。価格履歴は月単位
 *            (getPriceForMonth は valid_from <= 月初) なので 10/26 を含む 10 月 1 日から。既存の 2020-01-01 5,800 は残す
 *            (2026-09 以前は 5,800 のまま。この用具の貸与は 10/26〜 の 1 件だけ)。
 *            equipment_master.rental_price 5,800 → 5,700 (★ 提案。今の単価を表す値。発注画面の既定単価等が読む。--keep-master-price で据え置き)
 *      既に同じ (product_code, valid_from) の行があれば: 同じ金額なら何もしない / 違う金額なら止める
 *
 * ── 書込みの作法 (--execute) ─────────────────────────────────────────────
 *   rebuild_rentals_from_teikyohyo.mjs と同じ: data_import_batches (step 'teikyo-rebuild-fix') → 各書込みの直後に data_import_rows
 *   (before/after)。変更前の行は migrations/_backup_teikyo_rebuild_fix_<時刻>.json にも保存。trigger が作る doc_tasks /
 *   care_plan_elements は 参照先がこの batch で触った行 (明細 / その注文) のものだけ消して記録 (op=delete・cleanup)。
 *   update は更新件数 1 を確認。.in() は 150 件ずつ。DB は毎回読み直す。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { execLockStart, execLockAcquire } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (opt("--revert") || opt("--cleanup-batch")) {
  const r = spawnSync(process.execPath, [join(HERE, "sync_fukuyogu_from_honobono.mjs"), ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
const EXECUTE = argv.includes("--execute");
const KEEP_MASTER_PRICE = argv.includes("--keep-master-price");
const OUT_DIR = resolve(opt("--out-dir") ?? join(tmpdir(), "teikyo-rebuild-fix"));
const TENANT = "kt-group";
const OFFICE = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a"; // 介護ショップ ケア・サポート千葉
const REBUILD_BATCH = "8583d46b-3572-415d-bffe-a369e90ff28c";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP = "teikyo-rebuild-fix";
const SCRIPT_REL = "apps/order-app/migrations/fix_rebuild_rentals_202611.mjs";
let EXEC_LOCK = null; // 同じ script の同時 --execute を止める (_exec_lock.mjs)。--execute の最初に execLockStart で取る
const DUPS = [
  { dup: "d42c37ba-4ac9-4984-8b66-15253debcd8c", orig: "1aed1f73-bb3b-4d6d-ae13-e2075f99a63f", name: "松本 ちよ" },
  { dup: "4ed8b7c6-3dcd-459a-921a-515f2fde6ef6", orig: "f9100f6d-c4ee-4058-bc5f-93637558557b", name: "小山 いわ" },
];
const PRICES = [
  { product_code: "00122-000702", valid_from: "2026-04-01", rental_price: 7600, why: "CRT-SG-3B 4〜9 月 760 単位 (ほのぼの 用具マスタの旧行 ●CRT-SG-3B / 提供票 秦 幸三)" },
  { product_code: "00122-000702", valid_from: "2026-10-01", rental_price: 7300, why: "CRT-SG-3B 10 月〜 730 単位 (ほのぼの 用具マスタの新行 自走CRT-SG-3B)" },
  { product_code: "EQ-000246", valid_from: "2026-10-01", rental_price: 5700, why: "エバープラウド 83R 570 単位 (ほのぼの 用具マスタ / 小原 保三 10/26〜 の提供票 半額 285)" },
];
const MASTER_PRICE = { product_code: "EQ-000246", rental_price: 5700 };
const REF_TABLES = [["billing_unit_overrides", "order_item_id"], ["order_item_price_changes", "order_item_id"], ["monitoring_items", "order_item_id"], ["doc_tasks", "trigger_ref_id"], ["care_plan_elements", "ref_id"]];
const DERIVED = [["doc_tasks", "trigger_ref_id"], ["care_plan_elements", "ref_id"]];

// ── 小道具 ────────────────────────────────────────────────────────────────
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const ymd = (s) => (s ? String(s).slice(0, 10) : null);
const addDay = (d) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (a != null && b != null && String(a) === String(b));
const stop = (msg) => { console.error(`\n★ 止める: ${msg}`); process.exit(2); };
/** notes の後ろの明細の [...] のうち 先頭に無いものを足す ([teikyo-rebuild-…] の印は先頭にあるので重ならない) */
const mergeNotes = (head, rest) => {
  let out = head ?? "";
  for (const n of rest) {
    for (const t of (n ?? "").match(/\[[^\]]+\]/g) ?? []) if (!out.includes(t)) out = [out, t].filter(Boolean).join(" ");
    const plain = (n ?? "").replace(/\[[^\]]+\]/g, "").trim();
    if (plain && !out.includes(plain)) out = [out, plain].filter(Boolean).join(" ");
  }
  return out || null;
};

function readEnv() {
  const env = {};
  for (const l of readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8").split(/\r?\n/)) { const i = l.indexOf("="); if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, ""); }
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  return env;
}
async function selectAll(sb, table, select, build = (q) => q) {
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

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const env = readEnv();
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  console.log(`${EXECUTE ? "★★ EXECUTE (本番書込み)" : "DRY RUN (DB は書き換えない)"} / 組み直しの batch ${REBUILD_BATCH}`);

  // DB (READ ONLY)
  const { data: rb, error: rbErr } = await sb.from("data_import_batches").select("id,status,step,executed_at").eq("id", REBUILD_BATCH).maybeSingle();
  if (rbErr) throw new Error(`data_import_batches: ${rbErr.message}`);
  if (!rb) stop(`組み直しの batch ${REBUILD_BATCH} が無い`);
  if (rb.status !== "executed") stop(`組み直しの batch の status が ${rb.status} (executed のときだけ是正する。取り消し済みなら不要)`);
  const recs = await selectAll(sb, "data_import_rows", "id,table_name,row_id,op,after", (q) => q.eq("batch_id", REBUILD_BATCH).eq("table_name", "order_items"));
  const items = await selectAll(sb, "order_items", "*", (q) => q.eq("tenant_id", TENANT));
  const orders = await selectAll(sb, "orders", "id,client_id,office_id", (q) => q.eq("tenant_id", TENANT));
  const priceHist = await selectIn(sb, "equipment_price_history", "*", "product_code", PRICES.map((p) => p.product_code));
  const eqs = await selectIn(sb, "equipment_master", "*", "product_code", [...new Set([...PRICES.map((p) => p.product_code), MASTER_PRICE.product_code])], (q) => q.eq("tenant_id", TENANT));
  for (const [k, v] of Object.entries({ "data_import_rows (order_items)": recs, order_items: items, orders })) if (!v.length) stop(`${k} が 0 行 (列名 / tenant を疑う)`);
  console.log(`DB: 組み直しの記録 (order_items) ${recs.length} / order_items ${items.length} / orders ${orders.length} / 価格履歴 (対象 2 品) ${priceHist.length} / 用具マスタ (対象) ${eqs.length}`);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const cidOf = (it) => orderById.get(it.order_id)?.client_id ?? null;
  const insRec = new Map(recs.filter((r) => r.op === "insert").map((r) => [r.row_id, r]));
  // 現在値が batch で入れたときのまま (= 後から人が触っていない) か
  const untouched = (it) => { const r = insRec.get(it.id); return r && Object.keys(r.after ?? {}).every((k) => same(it[k], r.after[k])); };

  const ops = [];
  const R = { dup: [], toJihi: [], merge: [], skip: [], price: [], master: [] };

  // ── 1. 二重の明細 ──────────────────────────────────────────────────────
  for (const d of DUPS) {
    const dup = itemById.get(d.dup), orig = itemById.get(d.orig);
    if (!dup) { R.skip.push({ 是正: 1, 理由: "二重の明細が既に無い", id: d.dup, 氏名: d.name }); continue; }
    if (!insRec.has(dup.id)) stop(`${d.name} ${d.dup} は組み直しの batch で入れた明細ではない`);
    if (!untouched(dup)) stop(`${d.name} ${d.dup} は batch の後に変わっている (人が触った?) → 手で確認`);
    if (!orig) stop(`${d.name} の元の明細 ${d.orig} が無い`);
    if (cidOf(orig) !== cidOf(dup)) stop(`${d.name}: 元の明細 ${d.orig} が別の利用者`);
    if (!["rental_started", "terminated"].includes(orig.status) || orig.cancelled_at) stop(`${d.name}: 元の明細の状態 ${orig.status} / 取消 ${orig.cancelled_at}`);
    if (orderById.get(orig.order_id)?.office_id !== OFFICE) stop(`${d.name}: 元の明細がケアサポの注文でない`);
    const os = ymd(orig.rental_start_date) ?? "9999", oe = ymd(orig.rental_end_date) ?? "9999", ds = ymd(dup.rental_start_date), de = ymd(dup.rental_end_date) ?? "9999";
    if (!(os <= ds && oe >= de)) stop(`${d.name}: 元の明細 ${os}〜${oe} が 二重の明細 ${ds}〜${de} を覆っていない`);
    if ((orig.quantity ?? 1) !== (dup.quantity ?? 1) || (orig.payment_type ?? "介護") !== (dup.payment_type ?? "介護")) stop(`${d.name}: 数量・支払区分が元の明細と違う`);
    R.dup.push({ 氏名: d.name, 消す: { id: dup.id, 用具: dup.product_code, 期間: `${ds}〜${ymd(dup.rental_end_date) ?? ""}`, 状態: dup.status, 単価: dup.rental_price, notes: dup.notes },
      残す: { id: orig.id, 用具: orig.product_code, 期間: `${os}〜${ymd(orig.rental_end_date) ?? ""}`, 状態: orig.status, 単価: orig.rental_price } });
    ops.push({ table: "order_items", action: "delete", id: dup.id, cid: cidOf(dup), order_id: dup.order_id, why: "用具の取り違えで二重 (組み直しの insert)", src: { key: `二重|${d.name}|${dup.product_code}`, ref: { 元の明細: orig.id, 元の用具: orig.product_code } } });
  }

  // ── 2. 介護 0 円 → 自費 (+ 翌日から続く 0 円明細と統合) ─────────────────────
  const targets = [];
  for (const r of recs.filter((x) => x.op === "insert" && x.after?.payment_type === "介護" && x.after?.rental_price === 0)) {
    const it = itemById.get(r.row_id);
    if (!it) { R.skip.push({ 是正: 2, 理由: "既に無い", id: r.row_id }); continue; }
    if (!untouched(it)) { R.skip.push({ 是正: 2, 理由: "batch の後に変わっている (触らない)", id: it.id, 今: { 支払: it.payment_type, 単価: it.rental_price, 状態: it.status } }); continue; }
    targets.push(it);
  }
  const targetIds = new Set(targets.map((t) => t.id));
  const dupIds = new Set(DUPS.map((d) => d.dup));
  // 0 円の明細 (自費 / 対象) を 利用者×用具×数量 で並べ、終了日+1 = 開始日 でつなぐ
  const pool = items.filter((it) => !dupIds.has(it.id) && (it.rental_price ?? 0) === 0 && it.rental_price != null && (it.payment_type === "自費" || targetIds.has(it.id))
    && ["rental_started", "terminated"].includes(it.status) && !it.cancelled_at && it.rental_start_date && cidOf(it));
  const chains = [];
  for (const [, g] of groupBy(pool, (it) => `${cidOf(it)}|${it.product_code}|${it.quantity ?? 1}`)) {
    if (!g.some((it) => targetIds.has(it.id))) continue;
    const next = new Map(), prevN = new Map();
    for (const a of g) {
      if (!a.rental_end_date) continue;
      const nx = g.filter((b) => b.id !== a.id && ymd(b.rental_start_date) === addDay(ymd(a.rental_end_date)));
      if (nx.length === 1) { next.set(a.id, nx[0]); prevN.set(nx[0].id, (prevN.get(nx[0].id) ?? 0) + 1); }
      else if (nx.length > 1) R.skip.push({ 是正: 2, 理由: "翌日から続く 0 円明細が 2 件以上 (つながない)", id: a.id, 候補: nx.map((x) => x.id) });
    }
    for (const [id, n] of prevN) if (n > 1) { R.skip.push({ 是正: 2, 理由: "前の日で終わる 0 円明細が 2 件以上 (つながない)", id }); for (const [a, b] of [...next]) if (b.id === id) next.delete(a); }
    const hasPrev = new Set([...next.values()].map((b) => b.id));
    for (const head of g.filter((it) => !hasPrev.has(it.id))) {
      const ch = [head]; let cur = head;
      while (next.has(cur.id)) { cur = next.get(cur.id); ch.push(cur); }
      if (ch.some((it) => targetIds.has(it.id))) chains.push(ch);
    }
  }
  const merged = new Set();
  for (const ch of chains) {
    const head = ch[0], last = ch[ch.length - 1];
    const label = (it) => ({ id: it.id, 支払: it.payment_type, 期間: `${ymd(it.rental_start_date)}〜${ymd(it.rental_end_date) ?? ""}`, 状態: it.status, notes: it.notes, 注文: it.order_id });
    if (ch.length === 1) {
      if (!targetIds.has(head.id)) continue;
      ops.push({ table: "order_items", action: "update", id: head.id, cid: cidOf(head), order_id: head.order_id, why: "介護 0 円 → 自費 (つながる 0 円明細なし)", patch: { payment_type: "自費" }, src: { key: `0円付属|${head.product_code}`, ref: { 組み直し: REBUILD_BATCH } } });
      R.toJihi.push({ 用具: head.product_code, ...label(head) });
      continue;
    }
    const patch = {};
    if (head.payment_type !== "自費") patch.payment_type = "自費";
    if (ymd(head.rental_end_date) !== ymd(last.rental_end_date)) patch.rental_end_date = ymd(last.rental_end_date);
    if (head.status !== last.status) patch.status = last.status;
    const notes = mergeNotes(head.notes, ch.slice(1).map((x) => x.notes));
    if ((notes ?? null) !== (head.notes ?? null)) patch.notes = notes;
    ops.push({ table: "order_items", action: "update", id: head.id, cid: cidOf(head), order_id: head.order_id, why: `0 円明細 ${ch.length} 件を先頭に統合 (介護 0 円 → 自費)`, patch, src: { key: `0円付属|${head.product_code}`, ref: { 組み直し: REBUILD_BATCH, 統合: ch.map((x) => x.id) } } });
    for (const x of ch.slice(1)) {
      ops.push({ table: "order_items", action: "delete", id: x.id, cid: cidOf(x), order_id: x.order_id, why: "0 円明細の統合 (先頭に寄せた後ろの明細)", src: { key: `0円付属|${x.product_code}`, ref: { 寄せた先: head.id } } });
      merged.add(x.id);
    }
    R.merge.push({ 用具: head.product_code, 明細数: ch.length, 介護0円の数: ch.filter((x) => targetIds.has(x.id)).length, 注文が同じ: new Set(ch.map((x) => x.order_id)).size === 1, 後: { 期間: `${ymd(head.rental_start_date)}〜${patch.rental_end_date !== undefined ? patch.rental_end_date ?? "" : ymd(head.rental_end_date) ?? ""}`, 状態: patch.status ?? head.status, notes }, 元: ch.map(label) });
  }
  const covered = new Set(chains.flat().map((x) => x.id));
  for (const t of targets) if (!covered.has(t.id)) stop(`介護 0 円 ${t.id} が計画から漏れた (pool の条件を確認)`);

  // 消す明細の参照
  const delIds = ops.filter((o) => o.action === "delete").map((o) => o.id);
  for (const [tb, col] of REF_TABLES) {
    const got = await selectIn(sb, tb, `id,${col}`, col, delIds);
    if (got.length) stop(`消す明細を ${tb}.${col} が参照している ${got.length} 件 (例 ${JSON.stringify(got.slice(0, 3))})`);
  }
  console.log(`消す明細 ${delIds.length} 件を参照する行: ${REF_TABLES.map(([t]) => t).join(" / ")} すべて 0`);

  // ── 3. 価格履歴 ───────────────────────────────────────────────────────
  for (const p of PRICES) {
    if (!eqs.some((e) => e.product_code === p.product_code)) stop(`equipment_master に ${p.product_code} が無い`);
    const ex = priceHist.filter((h) => h.product_code === p.product_code && h.valid_from === p.valid_from && h.tenant_id === TENANT);
    if (ex.length && ex.every((h) => h.rental_price === p.rental_price)) { R.price.push({ ...p, 結果: "既にある (何もしない)" }); continue; }
    if (ex.length) stop(`価格履歴 ${p.product_code} ${p.valid_from} が既に別の金額 ${ex.map((h) => h.rental_price)}`);
    const row = { tenant_id: TENANT, product_code: p.product_code, rental_price: p.rental_price, valid_from: p.valid_from };
    ops.push({ table: "equipment_price_history", action: "insert", why: p.why, row, src: { key: `価格|${p.product_code}|${p.valid_from}`, ref: { 理由: p.why } } });
    R.price.push({ ...p, 既存: priceHist.filter((h) => h.product_code === p.product_code).map((h) => `${h.valid_from} ${h.rental_price}`) });
  }
  const em = eqs.find((e) => e.product_code === MASTER_PRICE.product_code);
  if (KEEP_MASTER_PRICE) R.master.push({ 用具: em.product_code, 単価: em.rental_price, 結果: "--keep-master-price で据え置き" });
  else if (em.rental_price !== MASTER_PRICE.rental_price) {
    ops.push({ table: "equipment_master", action: "update", id: em.id, why: "今の単価 (ほのぼの 570 単位) に揃える", patch: { rental_price: MASTER_PRICE.rental_price }, src: { key: `マスタ単価|${em.product_code}`, ref: { 前: em.rental_price } } });
    R.master.push({ 用具: em.product_code, 名称: em.name, 前: em.rental_price, 後: MASTER_PRICE.rental_price });
  }

  // ── 報告 ─────────────────────────────────────────────────────────────
  const show = (title, arr, n) => { console.log(`\n== ${title}: ${arr.length}`); for (const x of arr.slice(0, n)) console.log(`   - ${JSON.stringify(x)}`); };
  show("1. 二重の明細を消す", R.dup, 5);
  console.log(`\n== 2. 介護 0 円 (batch の insert・今も batch のまま): ${targets.length} 件`);
  console.log(`   つながる列 ${R.merge.length} (明細 ${R.merge.reduce((a, m) => a + m.明細数, 0)} 件 → ${R.merge.length} 件。消す ${merged.size}) / 列の長さ ${JSON.stringify(countBy(R.merge, (m) => `${m.明細数}件`))} / 注文が違う列 ${R.merge.filter((m) => !m.注文が同じ).length}`);
  console.log(`   自費に変えるだけ ${R.toJihi.length}`);
  const tInMerge = R.merge.reduce((a, m) => a + m.介護0円の数, 0);
  console.log(`   内訳: 介護 0 円 ${targets.length} = 列の中 ${tInMerge} (うち 先頭で残る ${R.merge.filter((m) => targetIds.has(m.元[0].id)).length} / 後ろで消える ${R.merge.reduce((a, m) => a + m.元.slice(1).filter((x) => targetIds.has(x.id)).length, 0)}) + 単独 ${R.toJihi.length}`);
  show("   つながる列 (例)", R.merge, 4);
  show("   長さ 3 以上の列", R.merge.filter((m) => m.明細数 > 2), 5);
  show("   自費に変えるだけ", R.toJihi, 12);
  show("3. 価格履歴を足す", R.price, 5);
  show("   用具マスタの単価", R.master, 2);
  show("飛ばしたもの", R.skip, 10);
  console.log(`\n書込み見込み: ${JSON.stringify(countBy(ops, (o) => `${o.table} ${o.action}`))}`);
  const planPath = join(OUT_DIR, "fix_plan.json");
  writeFileSync(planPath, JSON.stringify({ at: new Date().toISOString(), ops, report: R }, null, 1));
  console.log(`計画 JSON: ${planPath}`);
  if (!EXECUTE) { console.log("\nDRY RUN — DB は書き換えていない。--execute で本番 (★ user 承認後)"); return; }
  await execute(sb, ops);
}

// ── 本番書込み (rebuild_rentals_from_teikyohyo.mjs と同じ作法) ───────────────
async function execute(sb, ops) {
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) stop(`出どころ記録の表 ${t} が無い (${error.message})`);
  }
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: STEP,
    notes: `組み直し (batch ${REBUILD_BATCH}) の是正: 二重の明細の削除 / 介護 0 円 → 自費 と 0 円明細の統合 / 価格履歴`,
  });
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => { const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH); if (error) console.error(`batch を failed にできない: ${error.message}`); throw new Error(msg); };
  const record = async (rs) => { for (const c of chunks(rs, 100)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); } };
  const srcRef = (o) => ({ why: o.why, ...(o.src?.ref ?? {}) });
  // 変更前の行 (DRY RUN の計画を作った後に変わっていないか = 更新の前提も確かめる)
  const beforeRows = new Map();
  for (const [table, us] of groupBy(ops.filter((o) => o.action !== "insert"), (o) => o.table)) {
    const got = await selectIn(sb, table, "*", "id", us.map((o) => o.id));
    if (got.length !== new Set(us.map((o) => o.id)).size) await fail(`${table}: 変更前の行が ${us.length} 件のはずが ${got.length} 件`);
    for (const r of got) beforeRows.set(`${table}:${r.id}`, r);
  }
  const bpath = join(HERE, `_backup_teikyo_rebuild_fix_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(bpath, JSON.stringify({ batch: BATCH, at: new Date().toISOString(), before: Object.fromEntries(beforeRows) }, null, 2));
  console.log(`バックアップ ${bpath}`);
  const cids = [...new Set(ops.map((o) => o.cid).filter(Boolean))];
  const beforeDerived = {};
  for (const [t] of DERIVED) beforeDerived[t] = new Set((await selectIn(sb, t, "id", "client_id", cids, (q) => q.eq("tenant_id", TENANT))).map((r) => r.id));
  const touched = new Set();
  const doCleanup = async () => {
    for (const [t, refCol] of DERIVED) {
      const rowsNow = await selectIn(sb, t, "*", "client_id", cids, (q) => q.eq("tenant_id", TENANT));
      const fresh = rowsNow.filter((r) => !beforeDerived[t].has(r.id));
      const mine = fresh.filter((r) => touched.has(r[refCol]));
      for (const c of chunks(mine.map((r) => r.id), 150)) {
        const { error, count } = await sb.from(t).delete({ count: "exact" }).in("id", c);
        if (error || count !== c.length) throw new Error(`掃除 ${t}: ${error?.message ?? `削除件数 ${count} ≠ ${c.length}`}`);
      }
      await record(mine.map((r) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger", source_ref: { cleanup: true, 理由: "組み直しの是正で trigger が作った行" }, before: r, after: null })));
      console.log(`  掃除 ${t}: 消した ${mine.length} / 参照先が違うので消さなかった新しい行 ${fresh.length - mine.length}`);
    }
  };
  try {
    // 順番: 用具マスタの単価 → 価格履歴 → 明細の update (先頭を延ばす・自費に) → 明細の delete (二重・統合の後ろ)
    for (const o of ops.filter((x) => x.action === "update")) {
      const { error, count } = await sb.from(o.table).update(o.patch, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
      if (error) await fail(`update ${o.table} ${o.id}: ${error.message}`);
      if (count !== 1) await fail(`update ${o.table} ${o.id}: 更新件数 ${count}`);
      await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "update", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${o.table}:${o.id}`), after: o.patch }]);
      if (o.table === "order_items") { touched.add(o.id); if (o.order_id) touched.add(o.order_id); }
    }
    const ins = ops.filter((x) => x.action === "insert");
    if (ins.length) {
      const { data, error } = await sb.from("equipment_price_history").insert(ins.map((o) => o.row)).select("id");
      if (error) await fail(`insert equipment_price_history: ${error.message}`);
      if (data.length !== ins.length) await fail(`insert equipment_price_history: 返った行数 ${data.length} ≠ ${ins.length}`);
      await record(ins.map((o, j) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: data[j].id, op: "insert", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: null, after: o.row })));
    }
    for (const o of ops.filter((x) => x.action === "delete")) {
      const { error, count } = await sb.from(o.table).delete({ count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
      if (error) await fail(`delete ${o.table} ${o.id}: ${error.message}`);
      if (count !== 1) await fail(`delete ${o.table} ${o.id}: 削除件数 ${count}`);
      await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "delete", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${o.table}:${o.id}`), after: null }]);
      touched.add(o.id); if (o.order_id) touched.add(o.order_id);
    }
    console.log(`  書いた: ${JSON.stringify(countBy(ops, (o) => `${o.table} ${o.action}`))}`);
  } catch (e) {
    console.error(`★ 途中で失敗: ${e.message} — ここまでに trigger が作った行の掃除だけは行う`);
    try { await doCleanup(); } catch (e2) { console.error(`★ 掃除も失敗: ${e2.message} → --cleanup-batch ${BATCH}`); }
    throw e;
  }
  try { await doCleanup(); } catch (e) { await fail(`掃除: ${e.message} (--cleanup-batch ${BATCH} で後から掃除できる)`); }
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH}。取り消しは --revert ${BATCH}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
