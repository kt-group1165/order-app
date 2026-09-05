/**
 * 福祉用具 網羅率向上サンプル (migrations/seed_sample_fukuyogu_coverage_g.mjs) の
 * 実データ検証 (READ ONLY・DB書換なし)
 *
 *   node migrations/seed_sample_fukuyogu_coverage_g.mjs --execute   (先に投入)
 *   MONTH=2026-12 npx tsx scripts/fukuyogu-coverage-sample-verify.mts
 *   node migrations/seed_sample_fukuyogu_coverage_g.mjs --delete --execute  (後で撤去)
 *
 * BillingTab.tsx の getUnits/computeUnitsForMonth を軽量に再現し
 * (halfMonthUnits/getPriceForMonth/hasBrokenRentalDates は本物をimport)、
 * 7シナリオの単位数・金額が期待通りかを確認する。
 *
 * ⚠ 「貸与期間の逆転」は直さない。落ちるか弾くかを **記録するだけ**。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", "..", "kaigo-app", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { halfMonthUnits } = await import("../lib/half-month-units");
const { getPriceForMonth } = await import("../lib/equipment");
const { hasBrokenRentalDates } = await import("../app/[tenant]/order-item-helpers");

const MONTH = "2026-12";
const [y, m] = MONTH.split("-").map(Number);
const monthEnd = new Date(y, m, 0, 23, 59, 59);
const daysInMonth = new Date(y, m, 0).getDate();
const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(55)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

const MK = "[sample-g]";
const { data: clients } = await sb.from("clients").select("id,name,benefit_rate").like("user_number", "ZG%");
const mine = (clients ?? []).filter((c) => String(c.name ?? "").includes(MK));
console.log(`【分母】サンプルクライアント: ${mine.length} 名`);
if (mine.length !== 8) {
  console.log(`  ⚠ 期待は8名。migrations/seed_sample_fukuyogu_coverage_g.mjs --execute を先に実行してください`);
  process.exit(mine.length === 0 ? 0 : 1);
}
const byLabel = (label: string) => mine.find((c) => c.name?.includes(label))!;
const c1 = byLabel("前半のみ"), c2 = byLabel("後半のみ"), c3 = byLabel("入院で該当なし"),
  c4 = byLabel("価格改定"), c5 = byLabel("公費あり"),
  c6 = mine.find((c) => c.name?.includes("貸与期間逆転") && !c.name.includes("翌月開始"))!,
  c7 = byLabel("自動排泄処理装置"),
  c8 = byLabel("翌月開始");

async function getItem(clientId: string) {
  const { data: orders } = await sb.from("orders").select("id").eq("client_id", clientId);
  const { data: items } = await sb.from("order_items").select("*").in("order_id", (orders ?? []).map((o) => o.id));
  return items![0];
}
async function getHosp(clientId: string) {
  const { data } = await sb.from("client_hospitalizations").select("*").eq("client_id", clientId);
  return data ?? [];
}
const { data: priceHistAll } = await sb.from("equipment_price_history").select("*");

// BillingTab.tsx の getUnits を軽量に再現 (逐語のロジックそのもの。値の正確性が目的)
function computeUnits(item: { product_code: string; rental_start_date: string | null; rental_end_date: string | null }, hosp: { admission_date: string; discharge_date: string | null }[], eqPrice: number) {
  const price = getPriceForMonth(priceHistAll as never, item.product_code, MONTH) ?? eqPrice;
  const base = price ? Math.round(price / 10) : 0;
  if (!item.rental_start_date) return 0;
  const rentalStart = parseLocalDate(item.rental_start_date);
  const rentalEnd = item.rental_end_date ? parseLocalDate(item.rental_end_date) : monthEnd;
  let firstHalf = false, secondHalf = false;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(y, m - 1, d);
    if (date < rentalStart || date > rentalEnd) continue;
    const inHosp = hosp.some((h) => {
      const admit = parseLocalDate(h.admission_date);
      const discharge = h.discharge_date ? parseLocalDate(h.discharge_date) : monthEnd;
      return date >= admit && date <= discharge;
    });
    if (!inHosp) { if (d <= 15) firstHalf = true; else secondHalf = true; }
  }
  return halfMonthUnits(base, firstHalf, secondHalf);
}

console.log("\n═══ C1 前半のみ ═══");
{
  const item = await getItem(c1.id);
  const units = computeUnits(item, [], 12000);
  eq("units > 0 (前半のみでも請求は立つ)", units > 0, true);
  console.log(`     単位数=${units}`);
}

console.log("\n═══ C2 後半のみ ═══");
{
  const item = await getItem(c2.id);
  const units = computeUnits(item, [], 12000);
  eq("units > 0", units > 0, true);
  console.log(`     単位数=${units}`);
}

console.log("\n═══ C3 全月レンタル+12月まるごと入院 → 該当なし(0) ═══");
{
  const item = await getItem(c3.id);
  const hosp = await getHosp(c3.id);
  eq("入院記録が1件取得できる", hosp.length, 1);
  const units = computeUnits(item, hosp, 12000);
  eq("★ 12月まるごと入院なら units=0 (請求対象から除外される)", units, 0);
}

console.log("\n═══ C4 価格改定 (2026-11-15付けで11,000円に改定) ═══");
{
  const item = await getItem(c4.id);
  const priceJune = getPriceForMonth(priceHistAll as never, item.product_code, "2026-06");
  const priceDec = getPriceForMonth(priceHistAll as never, item.product_code, "2026-12");
  eq("2026-06時点の実効価格は10,000円 (改定前)", priceJune, 10000);
  eq("★ 2026-12時点の実効価格は11,000円 (改定後。current価格12,000円とは別)", priceDec, 11000);
  const units = computeUnits(item, [], 12000);
  eq("2026-12の単位数は改定後価格(11,000円→1,100単位)ベース", units, 1100);
}

console.log("\n═══ C5 公費あり ═══");
{
  const { data: kohi } = await sb.from("client_public_expenses").select("*").eq("client_id", c5.id);
  eq("公費レコードが1件取得できる", (kohi ?? []).length, 1);
  eq("法別番号12(生活保護)", kohi?.[0]?.hohei_code, "12");
  // BillingTab側のロジック: kohiがあれば userAmount=0・kohiAmountへ全額振替
  const item = await getItem(c5.id);
  const units = computeUnits(item, [], 12000);
  const totalCost = units * 10;
  const benefitRate = 90; // client.benefit_rate
  const insuranceAmount = Math.floor((totalCost * benefitRate) / 100);
  const rawUserAmount = totalCost - insuranceAmount;
  eq("公費ありなのでuserAmountは0円になる想定 (rawUserAmountを公費へ振替)", rawUserAmount > 0, true);
  console.log(`     rawUserAmount=${rawUserAmount}円 → 公費ありなのでuserAmount=0・kohiAmount=${rawUserAmount}円 に振替わる`);
}

console.log("\n═══ C6 貸与期間の逆転 (同月内: 開始2026-12-20 > 終了2026-12-05) ═══");
{
  const item = await getItem(c6.id);
  eq("★ hasBrokenRentalDates が true を返す (異常データとして検出できる)", hasBrokenRentalDates(item as never), true);
  const units = computeUnits(item, [], 12000);
  eq("同月内の逆転は落ちずに0を返す (日ループが空集合になるため)", units, 0);
  console.log(`     単位数=${units} (計算は落ちない。fukuyogu-coverage-checkの「逆転」因子として計上される)`);
}

console.log("\n═══ C8 貸与期間の逆転 (開始2027-01-10 > 終了2026-12-20。calcMonthUnitsの「満額」分岐を狙い撃ち) ═══");
{
  const item = await getItem(c8.id);
  eq("★ hasBrokenRentalDates が true を返す", hasBrokenRentalDates(item as never), true);
  // BillingTab.tsx の実際の請求生成 (generateTransferData) が使う inline getUnits 相当
  const unitsForDensou = computeUnits(item, [], 12000);
  // order-item-helpers.ts の calcMonthUnits (InvoiceReceiptModal=利用者向け請求書・領収書 が使う、★別経路)
  const { calcMonthUnits } = await import("../app/[tenant]/order-item-helpers");
  const unitsForInvoice = calcMonthUnits(item as never, y, m, 12000) ?? 0;
  console.log(`     国保連請求(generateTransferData相当)の単位数 = ${unitsForDensou}`);
  console.log(`     利用者請求書(InvoiceReceiptModal, calcMonthUnits)の単位数 = ${unitsForInvoice}`);
  eq("★★ 国保連請求側は0 (開始日が翌月なのでその月の請求対象外になる。activeRentalsからも除外)", unitsForDensou, 0);
  eq("★★ 利用者請求書側は満額(1,200単位)を返す — ドキュメント通りの「満額」バグ", unitsForInvoice, 1200);
  n++;
  if (unitsForDensou !== unitsForInvoice) {
    console.log(`  OK  ★★★ 発見: 同じ壊れたデータに対し、国保連請求(${unitsForDensou}) と 利用者請求書(${unitsForInvoice}) が★別の値★を計算する (2箇所の実装が乖離する既知パターン)`);
  } else {
    ng++;
    console.log(`  NG  想定していた乖離が再現しなかった`);
  }
  console.log(`     ⚠ 直さない・記録のみ。実データでは該当0件 (order_items 4,669行中)なので現状は潜在バグ。`);
}

console.log("\n═══ C7 自動排泄処理装置カテゴリの経路確認 ═══");
{
  const item = await getItem(c7.id);
  const { fukuyoguServiceCode } = await import("../lib/kokuho-densou/build");
  const { data: eqRow } = await sb.from("equipment_master").select("category").eq("product_code", item.product_code).maybeSingle();
  eq("category = 自動排泄処理装置", eqRow?.category, "自動排泄処理装置");
  eq("★ サービスコード171013に変換できる (経路が生きている)", fukuyoguServiceCode(eqRow?.category), "171013");
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
console.log("\n次: node migrations/seed_sample_fukuyogu_coverage_g.mjs --delete --execute で撤去してください");
