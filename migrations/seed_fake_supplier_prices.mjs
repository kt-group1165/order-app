/**
 * 卸別仕入価格 (equipment_prices) にサンプルを投入する。
 *   - 各用具 × 各卸 に、レンタル価格の 40〜50% (セルごとにランダム) の仕入価格を入れる
 *   - valid_from = 2026-07-01 / is_active = true
 *   - マーカー: supplier_product_code = 'SAMPLE-40-50pct'
 *       → 後で一括削除:
 *         DELETE FROM equipment_prices WHERE supplier_product_code = 'SAMPLE-40-50pct';
 *
 * Usage:
 *   node migrations/seed_fake_supplier_prices.mjs            # DRY RUN
 *   node migrations/seed_fake_supplier_prices.mjs --execute  # 本番
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
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
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が読めません");
  process.exit(1);
}

const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const TENANT_ID = "kt-group";
const VALID_FROM = "2026-07-01";
const MARKER = "SAMPLE-40-50pct";
const PCT_MIN = 0.40;
const PCT_MAX = 0.50;
const EXECUTE = process.argv.includes("--execute");

const roundTo10 = (n) => Math.round(n / 10) * 10;

async function fetchAll(table, columns, filterFn) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  console.log(`\n=== 卸別仕入価格 サンプル投入 (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) ===`);

  // 卸 (tenant 非依存)
  const suppliers = await fetchAll("suppliers", "id, name");
  console.log(`卸(仕入先): ${suppliers.length} 件`);
  if (suppliers.length === 0) { console.error("❌ 卸が0件。先に卸を登録してください。"); process.exit(1); }

  // 用具 (rental_price あり)
  const equipment = await fetchAll("equipment_master", "product_code, name, rental_price",
    (q) => q.eq("tenant_id", TENANT_ID));
  const withRental = equipment.filter((e) => e.rental_price != null && Number(e.rental_price) > 0);
  console.log(`用具: 全 ${equipment.length} 件 / レンタル価格あり ${withRental.length} 件`);

  // 既存 equipment_prices の件数 (上書き事故の確認)
  const { count: existingCount, error: cntErr } = await sb
    .from("equipment_prices").select("*", { count: "exact", head: true }).eq("tenant_id", TENANT_ID);
  if (cntErr) throw cntErr;
  console.log(`既存 equipment_prices(kt-group): ${existingCount ?? "?"} 件`);
  const { count: markerCount } = await sb
    .from("equipment_prices").select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID).eq("supplier_product_code", MARKER);
  console.log(`うち既存サンプル(${MARKER}): ${markerCount ?? 0} 件`);

  // 生成
  const rows = [];
  for (const e of withRental) {
    const rental = Number(e.rental_price);
    for (const s of suppliers) {
      const pct = PCT_MIN + Math.random() * (PCT_MAX - PCT_MIN);
      const purchase = roundTo10(rental * pct);
      rows.push({
        tenant_id: TENANT_ID,
        product_code: e.product_code,
        supplier_id: s.id,
        purchase_price: purchase,
        valid_from: VALID_FROM,
        is_active: true,
        supplier_product_code: MARKER,
      });
    }
  }
  console.log(`\n投入予定: ${rows.length} 行 (${withRental.length} 用具 × ${suppliers.length} 卸)`);

  // サンプル表示 (先頭8件) + 実際の % レンジ
  const sample = rows.slice(0, 8).map((r) => {
    const eq = withRental.find((e) => e.product_code === r.product_code);
    const sup = suppliers.find((s) => s.id === r.supplier_id);
    const pct = ((r.purchase_price / Number(eq.rental_price)) * 100).toFixed(1);
    return `  ${eq.name} × ${sup.name}: レンタル¥${Number(eq.rental_price).toLocaleString()} → 仕入¥${r.purchase_price.toLocaleString()} (${pct}%)`;
  });
  console.log("サンプル:\n" + sample.join("\n"));
  const pcts = rows.map((r) => {
    const eq = withRental.find((e) => e.product_code === r.product_code);
    return (r.purchase_price / Number(eq.rental_price)) * 100;
  });
  console.log(`% レンジ: ${Math.min(...pcts).toFixed(1)}% 〜 ${Math.max(...pcts).toFixed(1)}%`);

  if (!EXECUTE) {
    console.log("\n(DRY RUN) --execute で本番投入。");
    return;
  }

  // upsert (valid_from 単位で冪等)
  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await sb.from("equipment_prices")
      .upsert(batch, { onConflict: "tenant_id,product_code,supplier_id,valid_from" });
    if (error) { console.error(`❌ batch ${i} 失敗:`, error.message); process.exit(1); }
    done += batch.length;
    console.log(`  upsert ${done}/${rows.length}`);
  }

  // 検証
  const { count: after } = await sb.from("equipment_prices")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID).eq("supplier_product_code", MARKER);
  console.log(`\n✅ 完了。サンプル行(${MARKER}): ${after ?? "?"} 件`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
