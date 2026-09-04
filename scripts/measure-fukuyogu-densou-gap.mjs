/**
 * 福祉用具 伝送ビルダー クロス突合 (densou-builder-cross-diff.mts) で見つかった
 * ①②の「規模」を実データで測る。READ ONLY (GET のみ)。DB は書き換えない。
 *
 *   node scripts/measure-fukuyogu-densou-gap.mjs [YYYY-MM]   (既定 2026-06)
 *
 * BillingTab.tsx (app/[tenant]/BillingTab.tsx:452-494) の
 *   activeRentals / clientGroups 構築ロジックを同じ条件で再現し、
 *   その母集団に対して ①②の該当件数・金額を数える。
 *   (late フラグによる除外はここでは省略。除外は稀なので分母への影響は小さい想定。
 *    ⚠ 正確な母数が要る場面ではフラグ込みで再測定すること)
 */
import { readFileSync } from "node:fs";

const env = {};
for (const l of readFileSync("../kaigo-app/.env.local", "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function selectAll(table, query) {
  const out = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    const r = await fetch(`${URL}/rest/v1/${table}?${query}&order=id&limit=${PAGE}&offset=${from}`, { headers: H });
    if (!r.ok) throw new Error(`${table} HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error(`${table}: ${JSON.stringify(data)}`);
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// PostgRESTの .in() は id 数が多いと URL 長でBad Requestになる (400/414)。chunk して合成する。
// (memory: feedback_postgrest_in_query_plan_cliff.md — chunk=150推奨)
async function selectAllByIds(table, selectCols, idCol, ids, extraQuery = "") {
  const CHUNK = 150;
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const r = await fetch(
      `${URL}/rest/v1/${table}?select=${selectCols}&${idCol}=in.(${chunk.join(",")})${extraQuery}&limit=${CHUNK}`,
      { headers: H },
    );
    if (!r.ok) throw new Error(`${table} HTTP ${r.status}: ${await r.text()}`);
    const data = await r.json();
    if (!Array.isArray(data)) throw new Error(`${table}: ${JSON.stringify(data)}`);
    out.push(...data);
  }
  return out;
}

const YM = process.argv[2] ?? "2026-06";
const [Y, M] = YM.split("-").map(Number);
const monthStart = new Date(Y, M - 1, 1);
const monthEnd = new Date(Y, M, 0, 23, 59, 59);
const monthEndStr = `${Y}-${String(M).padStart(2, "0")}-${String(new Date(Y, M, 0).getDate()).padStart(2, "0")}`;

console.log(`対象月: ${YM} (BillingTab.tsx の activeRentals 条件を再現)`);

// ── order_items (rental_start_date <= 月末 / status in rental_started,terminated) ──
const items = await selectAll(
  "order_items",
  `select=id,order_id,rental_start_date,rental_end_date,status,payment_type&status=in.(rental_started,terminated)&rental_start_date=lte.${monthEndStr}`,
);
const orderIds = [...new Set(items.map((i) => i.order_id))];
const orders = await selectAllByIds("orders", "id,client_id,office_id,payment_type", "id", orderIds);
const orderById = new Map(orders.map((o) => [o.id, o]));

const pld = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const activeRentals = items.filter((item) => {
  const order = orderById.get(item.order_id);
  const pt = item.payment_type ?? order?.payment_type ?? "介護";
  if (pt !== "介護") return false;
  if (!item.rental_start_date) return false;
  if (pld(item.rental_start_date) > monthEnd) return false;
  if (item.status === "terminated" && item.rental_end_date) {
    if (pld(item.rental_end_date) < monthStart) return false;
  }
  return true;
});

const clientIds = [...new Set(activeRentals.map((i) => orderById.get(i.order_id)?.client_id).filter(Boolean))];
console.log(`activeRentals ${activeRentals.length} 行 / 対象利用者(clientGroups相当) ${clientIds.length} 名  ← 分母`);

const clients = await selectAllByIds("clients", "id,name,insurer_number,insured_number,benefit_rate,care_level", "id", clientIds);
const clientById = new Map(clients.map((c) => [c.id, c]));

console.log("\n══ ② 保険者番号/被保険者番号の欠損 (order-appは除外しないが、kaigo-appなら除外される行) ══");
let missingInsurer = 0, missingInsured = 0, missingEither = 0;
const missingList = [];
for (const id of clientIds) {
  const c = clientById.get(id);
  const mi = !c || !(c.insurer_number ?? "").trim();
  const mn = !c || !(c.insured_number ?? "").trim();
  if (mi) missingInsurer++;
  if (mn) missingInsured++;
  if (mi || mn) { missingEither++; missingList.push(c?.name ?? id); }
}
console.log(`  保険者番号 欠損: ${missingInsurer} / ${clientIds.length} 名`);
console.log(`  被保険者番号 欠損: ${missingInsured} / ${clientIds.length} 名`);
console.log(`  ★ どちらか欠損 (kaigo-appなら伝送から除外される): ${missingEither} / ${clientIds.length} 名`);
if (missingEither > 0) {
  console.log(`    該当: ${missingList.slice(0, 15).join(" / ")}${missingList.length > 15 ? ` ...他${missingList.length - 15}名` : ""}`);
}

// 金額規模: 欠損している利用者の当月レンタル単位数から概算 (福祉用具単価10円固定)
if (missingEither > 0) {
  // 種目マスタは使わず、order_item 単位の合算のみ概算 (単価不明分は quantity ベース概算は行わない)
  console.log(`  ⚠ 金額の概算には equipment.category からのサービスコード解決・貸与日数按分が要る`);
  console.log(`    (build.ts と同じロジック)。今回は「該当利用者数」までを分母として報告する。`);
}

console.log("\n══ ① 公費0円行 (kaigo-appは計上するが order-app は除外する行) ══");
const kohi = await selectAllByIds("client_public_expenses", "client_id,hohei_code,valid_start,valid_end", "client_id", clientIds);
const kohiByClient = new Map();
for (const k of kohi) {
  if (!k.hohei_code) continue;
  if (k.valid_start && k.valid_start > monthEndStr) continue;
  if (k.valid_end && k.valid_end < `${YM}-01`) continue;
  if (!kohiByClient.has(k.client_id)) kohiByClient.set(k.client_id, k);
}
console.log(`  当月 公費併用あり: ${kohiByClient.size} / ${clientIds.length} 名  ← 分母`);

// BillingTab.tsx の実式を再現: kohiAmount = kohi ? rawUserAmount : null
// rawUserAmount = totalCost - insuranceAmount = totalCost - floor(totalCost*benefitRate/100)
// → totalCost>0 かつ benefitRate<100 なら常に >0。0円になるのは
//   (a) totalCost=0 (=有効な貸与単位が無い。details.length===0 のグループは既に事前に除外済) か
//   (b) benefit_rate="100" (=1割負担が0という制度上あり得ない値) のときだけ。
let zeroYenKohi = 0;
const benefitRates = new Set();
for (const [cid] of kohiByClient) {
  const c = clientById.get(cid);
  const raw = (c?.benefit_rate ?? "").trim();
  benefitRates.add(raw || "(未設定→90扱い)");
  const parsed = parseInt(raw, 10);
  const benefitRate = Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
  if (benefitRate >= 100) zeroYenKohi++;
}
console.log(`  当月 公費併用者の benefit_rate 分布: ${[...benefitRates].join(", ")}`);
console.log(`  ★ 公費0円行 (benefit_rate>=100 で理論上 rawUserAmount=0 になる件): ${zeroYenKohi} / ${kohiByClient.size} 名`);
console.log(`  → 現在の order-app 実装 (kohiAmount = kohi ? totalCost-insuranceAmount : null) は`);
console.log(`    「全額公費 or 全額本人負担」の二値モデルで、kaigo-appのような`);
console.log(`    「本人負担上限額との差額だけ公費」という部分公費モデルを持たない。`);
console.log(`    そのため実務上 benefit_rate>=100 という制度上ありえない値が無い限り`);
console.log(`    0円行は発生しない = ★ 発火条件は「order-appの公費計算式が部分公費対応に`);
console.log(`    変わったとき」。現状のv1式のままなら ①は今は無害、という結論になる。`);

console.log(`\n══ まとめ (${YM}) ══`);
console.log(`  分母: activeRentals ${activeRentals.length}行 / 対象利用者 ${clientIds.length}名`);
console.log(`  ② 番号欠損: ${missingEither}名`);
console.log(`  ① 公費0円行: ${zeroYenKohi}名 (公費併用者 ${kohiByClient.size}名中)`);
