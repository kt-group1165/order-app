/**
 * check:futan-period (order-app・福祉用具) — 負担割合証の期間と、月ごとに採る割合の食い違い (★ READ ONLY・基準値方式)
 *
 *   npm run check:futan-period                     # 既定 MONTHS=2026-08,2026-09
 *   MONTHS=2026-07,2026-08 npm run check:futan-period
 *   npm run check:futan-period -- --update         # 基準値を書く (中身を確認してから)
 *
 * 母数: その月に介護保険の貸与がある利用者 (抽出条件は BillingTab の careItems / benefit-rate-check.mts と同じ)。
 * 認定行の割合: benefit_rate を優先、無ければ copay_rate (割) — 純関数の cert_row と同じ。
 * 数えるもの・基準値・負のコントロールは scripts/_futan-period-core.mts の冒頭を参照。
 * 負担割合証の出どころ: client_benefit_certificates (適用済み) / 未作成なら ほのぼのの CSV (ケアサポ + 全社) をメモリ上で。
 */
import { join } from "node:path";
import { runFutanPeriod, serviceClient, selectAll, loadCertRows, loadBenefitCertsDbOrCsv } from "./_futan-period-core.mjs";
import { benefitRateOfCertRow } from "../lib/insurance/cert-month";

const sb = await serviceClient(["../kaigo-app/.env.local", ".env.local"]);
if (!sb) { console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (exit 0・★ 合格ではない)"); process.exit(0); }
const MONTHS = (process.env.MONTHS ?? "2026-08,2026-09").split(",").map((s) => s.trim()).filter(Boolean);
const K = "../kaigo-app";
const CSV_SETS = [
  { label: "ケアサポ 20261109", futan: join(K, "伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/負担割合証等_全件.CSV"), ins: [join(K, "伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/介護保険_全件_保険と認定.CSV")] },
  { label: "全社 20260830", futan: join(K, "利用者データ/全社_R8-08/負担割合証等1.CSV"), ins: [join(K, "利用者データ/全社_R8-08/介護保険1.CSV")] },
];

type Order = { id: string; client_id: string | null; payment_type: string | null };
type Item = { id: string; order_id: string; status: string | null; payment_type: string | null; rental_start_date: string | null; rental_end_date: string | null };
const orders = await selectAll<Order>(sb, "orders", "id,client_id,payment_type");
const items = await selectAll<Item>(sb, "order_items", "id,order_id,status,payment_type,rental_start_date,rental_end_date");
const clients = await selectAll<{ id: string; name: string; deleted_at: string | null }>(sb, "clients", "id,name,deleted_at");
const nameOf = new Map(clients.map((c) => [c.id, c.name]));
const orderOf = new Map(orders.map((o) => [o.id, o]));

await runFutanPeriod({
  app: "order-app 福祉用具",
  months: MONTHS,
  baselinePath: "scripts/futan-period-baseline.json",
  update: process.argv.includes("--update"),
  targets: async (ym) => {
    const [y, m] = ym.split("-").map(Number);
    const MS = `${ym}-01`, ME = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
    const out = new Map<string, string>();
    for (const i of items) {
      const o = orderOf.get(i.order_id);
      if (!o?.client_id) continue;
      if ((i.payment_type ?? o.payment_type ?? "介護") !== "介護") continue;
      if (!i.rental_start_date || i.rental_start_date > ME) continue;
      if (i.status === "terminated" && i.rental_end_date && i.rental_end_date < MS) continue;
      if (i.status !== "rental_started" && i.status !== "terminated") continue;
      out.set(o.client_id, nameOf.get(o.client_id) ?? o.client_id);
    }
    return out;
  },
  certRows: (ids) => loadCertRows(sb, ids),
  benefitCerts: (ids) => loadBenefitCertsDbOrCsv(sb, ids, CSV_SETS),
  certRowRate: (row) => benefitRateOfCertRow(row),
});
