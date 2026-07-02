/**
 * 旧発注 order_items.purchase_price の backfill。
 *
 * 背景:
 *   月次損益 (発生ベース) の原価の正 = order_items.purchase_price (発注時スナップ)。
 *   旧データは NULL が多く、集計時はライブカタログ値にフォールバックしている。
 *   → その item の「レンタル開始月 (無ければ発注 created_at の月)」時点で有効な
 *     カタログ価格 (equipment_prices, valid_from 履歴) で NULL を埋める。
 *
 * 対象: tenant_id='kt-group' の order_items で
 *   purchase_price IS NULL かつ supplier_id IS NOT NULL かつ status <> 'cancelled'
 *
 * 埋める値: equipment_prices から (product_code, supplier_id) 一致で
 *   valid_from <= 対象月初 の最新 1 行 (is_active=true のみ)。
 *   該当が無い item はスキップ (件数報告)。
 *
 * サンプル値警告: 使うカタログ行が supplier_product_code='SAMPLE-40-50pct' の
 *   サンプル由来である場合、その割合をサマリで明示する (埋めるのは埋める)。
 *
 * Usage:
 *   node migrations/backfill_order_items_purchase_price.mjs            # DRY RUN
 *   node migrations/backfill_order_items_purchase_price.mjs --execute  # 本番 (backup JSON 保存後 UPDATE)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ SUPABASE_URL / SERVICE_ROLE_KEY が読めません"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const TENANT_ID = "kt-group";
const SAMPLE_MARKER = "SAMPLE-40-50pct";
const EXECUTE = process.argv.includes("--execute");

async function fetchAll(table, columns, filterFn) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) { console.error(`❌ ${table} fetch 失敗:`, error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/** "YYYY-MM-DD..." → その月の月初 "YYYY-MM-01" (不正値は null) */
function monthStartOf(dateStr) {
  if (!dateStr) return null;
  const m = String(dateStr).match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

async function main() {
  console.log(`\n=== order_items.purchase_price backfill (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) ===`);

  // ── 1. 対象 order_items をページング全件取得 ───────────────────────
  const items = await fetchAll(
    "order_items",
    "id, product_code, supplier_id, purchase_price, status, rental_start_date, created_at",
    (q) => q.eq("tenant_id", TENANT_ID).is("purchase_price", null)
            .not("supplier_id", "is", null).neq("status", "cancelled"),
  );
  console.log(`対象 (purchase_price IS NULL / supplier_id あり / cancelled 除外): ${items.length} 件`);
  if (items.length === 0) { console.log("対象なし。終了。"); return; }

  // ── 2. カタログ (equipment_prices) を一括ロードして JS lookup ──────
  //    is_active=true のみ (false = 論理削除・切替済 offering)
  const catalog = await fetchAll(
    "equipment_prices",
    "product_code, supplier_id, purchase_price, valid_from, supplier_product_code",
    (q) => q.eq("tenant_id", TENANT_ID).eq("is_active", true),
  );
  console.log(`カタログ (equipment_prices, is_active): ${catalog.length} 行`);

  // (product_code, supplier_id) → valid_from 降順の行リスト
  const catalogMap = new Map();
  for (const row of catalog) {
    const key = `${row.product_code}|${row.supplier_id}`;
    if (!catalogMap.has(key)) catalogMap.set(key, []);
    catalogMap.get(key).push(row);
  }
  for (const rows of catalogMap.values()) {
    rows.sort((a, b) => (a.valid_from < b.valid_from ? 1 : a.valid_from > b.valid_from ? -1 : 0));
  }

  // ── 3. item ごとに対象月時点の価格を解決 ───────────────────────────
  const fills = [];        // { id, price, month, product_code, supplier_id, isSample }
  const skipped = [];      // { id, reason, product_code, supplier_id, month }
  for (const it of items) {
    const month = monthStartOf(it.rental_start_date) ?? monthStartOf(it.created_at);
    if (!month) { skipped.push({ ...it, month: null, reason: "対象月が判定不能 (rental_start_date/created_at なし)" }); continue; }
    const rows = catalogMap.get(`${it.product_code}|${it.supplier_id}`);
    if (!rows) { skipped.push({ ...it, month, reason: "カタログに (product_code, supplier_id) が無い" }); continue; }
    // valid_from 降順なので、valid_from <= 月初 の最初の行が「その時点の最新」
    const hit = rows.find((r) => r.valid_from <= month);
    if (!hit) { skipped.push({ ...it, month, reason: `対象月 ${month} 以前に有効なカタログ行が無い` }); continue; }
    if (hit.purchase_price == null) { skipped.push({ ...it, month, reason: "カタログ行の purchase_price が NULL" }); continue; }
    fills.push({
      id: it.id,
      price: Number(hit.purchase_price),
      month,
      product_code: it.product_code,
      supplier_id: it.supplier_id,
      isSample: hit.supplier_product_code === SAMPLE_MARKER,
    });
  }

  const sampleCount = fills.filter((f) => f.isSample).length;
  const samplePct = fills.length > 0 ? ((sampleCount / fills.length) * 100).toFixed(1) : "0.0";

  // ── 4. サマリ ──────────────────────────────────────────────────────
  console.log(`\n── サマリ ──`);
  console.log(`対象件数            : ${items.length}`);
  console.log(`埋められる件数      : ${fills.length}`);
  console.log(`スキップ件数        : ${skipped.length}`);
  if (skipped.length > 0) {
    const byReason = new Map();
    for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) console.log(`  - ${reason}: ${n} 件`);
  }
  console.log(`サンプル由来        : ${sampleCount} 件 (${samplePct}%)`);
  if (sampleCount > 0) {
    console.log(`\n⚠️⚠️⚠️ 警告: backfill 値の ${samplePct}% がサンプルカタログ (supplier_product_code='${SAMPLE_MARKER}') 由来です ⚠️⚠️⚠️`);
    console.log(`   実仕入価格ではなく「レンタル価格の 40〜50% ランダム」のダミー値が入ります。`);
    console.log(`   実カタログ投入後にやり直すか、承知の上で --execute してください。`);
  }

  console.log(`\n── 例 (先頭 10 件) ──`);
  for (const f of fills.slice(0, 10)) {
    console.log(`  ${f.product_code} × ${String(f.supplier_id).slice(0, 8)} | 月=${f.month.slice(0, 7)} | ¥${f.price.toLocaleString()}${f.isSample ? " [SAMPLE]" : ""}`);
  }

  if (!EXECUTE) {
    console.log(`\n(DRY RUN) 内容確認のうえ --execute で反映。`);
    return;
  }

  if (fills.length === 0) { console.log("\n埋められる行が 0 件のため UPDATE なしで終了。"); return; }

  // ── 5. backup JSON (id と、変更前が NULL であることの記録) ─────────
  const backupPath = join(__dirname, "_backup_order_items_purchase_price_20260702.json");
  writeFileSync(backupPath, JSON.stringify(fills.map((f) => ({ id: f.id, purchase_price_before: null })), null, 2));
  console.log(`\nbackup: ${backupPath}`);

  // ── 6. price ごとに group して .in() で batch UPDATE ───────────────
  const byPrice = new Map();
  for (const f of fills) {
    if (!byPrice.has(f.price)) byPrice.set(f.price, []);
    byPrice.get(f.price).push(f.id);
  }
  console.log(`UPDATE: ${fills.length} 行 / ${byPrice.size} price group`);
  const BATCH = 200;
  let done = 0;
  for (const [price, ids] of byPrice) {
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      const { error } = await sb.from("order_items")
        .update({ purchase_price: price })
        .in("id", slice)
        .is("purchase_price", null); // 二重実行・競合更新ガード
      if (error) { console.error(`❌ UPDATE 失敗 (price=${price}, offset=${i}):`, error.message); process.exit(1); }
      done += slice.length;
      if (done % 1000 === 0 || done === fills.length) console.log(`  UPDATE ${done}/${fills.length}`);
    }
  }

  // ── 7. 検証: 対象条件で purchase_price IS NULL の残数 ──────────────
  const { count: remaining, error: verErr } = await sb
    .from("order_items").select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID).is("purchase_price", null)
    .not("supplier_id", "is", null).neq("status", "cancelled");
  if (verErr) { console.error("❌ 検証クエリ失敗:", verErr.message); process.exit(1); }
  console.log(`\n✅ 完了。残 NULL (対象条件): ${remaining} 件 (期待: スキップ ${skipped.length} 件)`);
  if (remaining !== skipped.length) {
    console.error(`⚠️ 残数が期待と不一致。並行更新の可能性あり、内容を確認してください。`);
    process.exit(1);
  }
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
