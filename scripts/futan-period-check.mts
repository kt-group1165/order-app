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
import { rowsForOffice } from "../lib/insurance/office-scope-rules";

const sb = await serviceClient(["../kaigo-app/.env.local", ".env.local"]);
if (!sb) { console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (exit 0・★ 合格ではない)"); process.exit(0); }
const MONTHS = (process.env.MONTHS ?? "2026-08,2026-09").split(",").map((s) => s.trim()).filter(Boolean);
const K = "../kaigo-app";
const CSV_SETS = [
  { label: "ケアサポ 20261109", futan: join(K, "伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/負担割合証等_全件.CSV"), ins: [join(K, "伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/介護保険_全件_保険と認定.CSV")] },
  { label: "全社 20260830", futan: join(K, "利用者データ/全社_R8-08/負担割合証等1.CSV"), ins: [join(K, "利用者データ/全社_R8-08/介護保険1.CSV")] },
];

type Order = { id: string; client_id: string | null; payment_type: string | null; office_id: string | null };
type Item = { id: string; order_id: string; status: string | null; payment_type: string | null; rental_start_date: string | null; rental_end_date: string | null };
const orders = await selectAll<Order>(sb, "orders", "id,client_id,payment_type,office_id");
// ★ 2026-11-13: 認定行・負担割合証を 請求と同じ範囲に絞る (BillingTab / buildBillingModel の inScope と同じ規則)。
//   事業所別 (insurance_scope = per_office) の事業所の請求 → その事業所の行だけ / 共有の事業所の請求 → 他の per_office 事業所の行を外す。
//   絞らないと 他事業所の行 (給付率なし) が選ばれて「割合なし」に数えていた (上村 亮子。請求は ケアサポの行の 90 で正しく出る)
const offices = await selectAll<{ id: string; insurance_scope: string | null }>(sb, "offices", "id,insurance_scope");
const perOfficeIds = new Set(offices.filter((o) => o.insurance_scope === "per_office").map((o) => o.id));
let billingOfficeOf = new Map<string, string | null>(); // client_id → 請求する事業所 (その月の対象を数えるときに決める)
// 規則は 請求画面と同じ lib/insurance/office-scope-rules.ts の rowsForOffice (逐語コピーしない)
const scoped = <T extends { office_id?: string | null }>(cid: string, rows: T[]) => rowsForOffice(rows, billingOfficeOf.get(cid) ?? null, [...perOfficeIds]);
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
    const offOf = new Map<string, string | null>();
    for (const i of items) {
      const o = orderOf.get(i.order_id);
      if (!o?.client_id) continue;
      if ((i.payment_type ?? o.payment_type ?? "介護") !== "介護") continue;
      if (!i.rental_start_date || i.rental_start_date > ME) continue;
      if (i.status === "terminated" && i.rental_end_date && i.rental_end_date < MS) continue;
      if (i.status !== "rental_started" && i.status !== "terminated") continue;
      out.set(o.client_id, nameOf.get(o.client_id) ?? o.client_id);
      // 請求する事業所: per_office の事業所の注文があればそれを優先 (無ければ最初に見つかった事業所)
      const prev = offOf.get(o.client_id);
      if (prev === undefined || (!(prev && perOfficeIds.has(prev)) && o.office_id && perOfficeIds.has(o.office_id))) offOf.set(o.client_id, o.office_id);
    }
    billingOfficeOf = offOf;
    return out;
  },
  certRows: async (ids) => {
    const m = await loadCertRows(sb, ids);
    for (const [cid, rs] of m) m.set(cid, scoped(cid, rs as (typeof rs[number] & { office_id?: string | null })[]));
    return m;
  },
  benefitCerts: async (ids) => {
    const b = await loadBenefitCertsDbOrCsv(sb, ids, CSV_SETS);
    if (b.source === "db") for (const [cid, rs] of b.byClient) b.byClient.set(cid, scoped(cid, rs));
    return b;
  },
  certRowRate: (row) => benefitRateOfCertRow(row),
});
