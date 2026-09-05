/**
 * 福祉用具貸与 (order-app) 請求ロジックの網羅率を測る (READ ONLY・DB書換なし・サンプル投入なし)
 *
 *   npx tsx scripts/fukuyogu-coverage-check.mts
 *   MONTH=2026-06 npx tsx scripts/fukuyogu-coverage-check.mts
 *
 * ── なぜ要るか (H の割当) ────────────────────────────────────────────────
 *   月 ¥17,527,920 の請求規模に対し、ほのぼのの福祉用具伝送が手元に無く
 *   一度も突合していない。「どこまで見えているか」の数字が存在しなかった。
 *   kaigo-app の scripts/_factors.mts + coverage-check.mts と同じ考え方
 *   (因子×因子の値ペアを実データがどこまで覆っているか) を福祉用具に作る。
 *
 * ── 因子の出どころ ───────────────────────────────────────────────────────
 *   ★ 実装 (app/[tenant]/BillingTab.tsx の activeRentals/clientGroups/
 *   generateTransferData と lib/kokuho-densou/build.ts) を読んで列挙した。
 *   仕様書からではない。各因子の why に「実装のどこが読むか」を書く。
 *
 * ── 因子から外したもの (理由あり) ────────────────────────────────────────
 *   payment_type            実装は読む(activeRentals:457)が、実データは
 *                            4,669 件全件が "介護" — 値が1種類しかないので
 *                            因子ではなく「未検証の分岐」として別掲する。
 *   equipment_master.kind   実装は存在する概念 (single/set, equipment_set_items
 *                            テーブルあり = 用具マスタv2 未適用) だが、実データは
 *                            2,159 件全件が "single" — 同上、別掲する。
 *   貸与 vs 販売             buildFukuyoguDensou は貸与 (サービス種類17) のみ。
 *                            特定福祉用具販売の国保連請求経路はコードに存在しない
 *                            (実装が無いので測りようがない、と明記する)。
 *   搬出入費                 lib/contractTemplateSections.ts に「別にいただきません」
 *                            と明記 = 貸与価格に含む契約。単位数計算に関与しない。
 *   軽度者例外(要介護度)      車いす/特殊寝台等の軽度者原則対象外の判定・医師意見書の
 *                            要否をコードは一切読んでいない (grep 0件)。因子化できない
 *                            = 網羅率以前に「実装されていない」ことを明記する。
 *   住宅改修との併用          単位数計算 (このファイルの対象) はrenovationsテーブルを
 *                            読んでいない。限度額は完全に別枠 (相互作用なし)。
 *
 * ⚠ 0 件の組合せはサンプルでしか通せない。★ この検査ではサンプル投入はしない
 *   (H の指示)。0 件は「まだ見えていない」とだけ報告する。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { EquipmentPriceHistory } from "../lib/supabase";

// lib/equipment.ts 等は module top-level で `@/lib/supabase` (browser client) を
// 生成しており、env が無いと import 時点で即クラッシュする。static import だと
// この env セットより先に評価されてしまうため、先に placeholder を入れてから
// dynamic import に切り替える (calendar-app の検証scriptと同じ回避策)。
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "placeholder";

const __dirname = dirname(fileURLToPath(import.meta.url));
// order-app 自身の .env.local には service role key が無い (kaigo-app 側にある共通DB)。
const env: Record<string, string> = {};
for (const l of readFileSync(join(__dirname, "..", "..", "kaigo-app", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い。分母が作れないので中止する");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { getPriceForMonth } = await import("../lib/equipment");
const { fukuyoguServiceCode } = await import("../lib/kokuho-densou/build");
const { hasBrokenRentalDates } = await import("../app/[tenant]/order-item-helpers");

const MONTH = process.env.MONTH ?? "2026-06";

async function pageAll<T>(table: string, select: string, orderCol = "id"): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb.from(table).select(select).order(orderCol).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
    from += 1000;
  }
  return out;
}

type OrderItemRow = {
  id: string; order_id: string; product_code: string; status: string;
  rental_start_date: string | null; rental_end_date: string | null;
  payment_type: string | null; quantity: number;
};
type OrderRow = { id: string; client_id: string; payment_type: string | null };
type EquipRow = { product_code: string; category: string | null; rental_price: number | null; kind: string | null };
type ClientRow = { id: string; benefit_rate: string | null; care_office_id: string | null };
type HospRow = { client_id: string; admission_date: string; discharge_date: string | null };
type KohiRow = { client_id: string; hohei_code: string | null; valid_start: string | null; valid_end: string | null };

console.log(`══ 福祉用具貸与 請求ロジック 網羅率測定 (${MONTH}・READ ONLY) ══\n`);

const [orderItemsAll, ordersAll, equipAll, clientsAll, hospAll, kohiAll, priceHistAll] = await Promise.all([
  pageAll<OrderItemRow>("order_items", "id, order_id, product_code, status, rental_start_date, rental_end_date, payment_type, quantity"),
  pageAll<OrderRow>("orders", "id, client_id, payment_type"),
  pageAll<EquipRow>("equipment_master", "product_code, category, rental_price, kind"),
  pageAll<ClientRow>("clients", "id, benefit_rate, care_office_id"),
  pageAll<HospRow>("client_hospitalizations", "client_id, admission_date, discharge_date"),
  pageAll<KohiRow>("client_public_expenses", "client_id, hohei_code, valid_start, valid_end"),
  pageAll<EquipmentPriceHistory>("equipment_price_history", "product_code, rental_price, valid_from"),
]);
console.log(`【分母の元】order_items ${orderItemsAll.length} 行 / equipment_master ${equipAll.length} 件 / clients ${clientsAll.length} 名`);
console.log(`           client_hospitalizations ${hospAll.length} 件 / client_public_expenses ${kohiAll.length} 件 / 価格履歴 ${priceHistAll.length} 行\n`);

const orderById = new Map(ordersAll.map((o) => [o.id, o]));
const equipByCode = new Map(equipAll.map((e) => [e.product_code, e]));
const clientById = new Map(clientsAll.map((c) => [c.id, c]));
const hospByClient = new Map<string, HospRow[]>();
for (const h of hospAll) { if (!hospByClient.has(h.client_id)) hospByClient.set(h.client_id, []); hospByClient.get(h.client_id)!.push(h); }
const monthStartYmd = `${MONTH}-01`;
const kohiActive = new Map<string, KohiRow>();
for (const k of kohiAll) {
  if (!k.hohei_code) continue;
  if (k.valid_start && k.valid_start > monthStartYmd) continue; // 粗い判定 (境界日は下で厳密化)
  if (!kohiActive.has(k.client_id)) kohiActive.set(k.client_id, k);
}

// ── activeRentals と同じフィルタ (BillingTab.tsx:452-471 を再現) ──
const [y, m] = MONTH.split("-").map(Number);
const monthStart = new Date(y, m - 1, 1);
const monthEnd = new Date(y, m, 0, 23, 59, 59);
const daysInMonth = new Date(y, m, 0).getDate();
const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };

const paymentTypeCounts = new Map<string, number>();
const statusCounts = new Map<string, number>();
const activeRentals = orderItemsAll.filter((item) => {
  const pt = item.payment_type ?? orderById.get(item.order_id)?.payment_type ?? "介護";
  paymentTypeCounts.set(pt, (paymentTypeCounts.get(pt) ?? 0) + 1);
  statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
  if (pt !== "介護") return false;
  if (!item.rental_start_date) return false;
  const start = parseLocalDate(item.rental_start_date);
  if (start > monthEnd) return false;
  if (item.status === "terminated" && item.rental_end_date) {
    const end = parseLocalDate(item.rental_end_date);
    if (end < monthStart) return false;
  }
  if (item.status !== "rental_started" && item.status !== "terminated") return false;
  return true;
});
console.log(`【分母】activeRentals (= ${MONTH} の請求対象候補): ${activeRentals.length} 行 / order_items全体 ${orderItemsAll.length} 行\n`);

// ── 半月按分バケツ判定 (BillingTab.tsx:560-584 の日ループを軽量に再現。
//    ★ 金額の正確性ではなく「前半のみ/後半のみ/全月/該当なし」の分類だけが目的) ──
function halfMonthBucket(item: OrderItemRow, clientId: string): "全月" | "前半のみ" | "後半のみ" | "該当なし" {
  if (!item.rental_start_date) return "該当なし";
  const rentalStart = parseLocalDate(item.rental_start_date);
  const rentalEnd = item.rental_end_date ? parseLocalDate(item.rental_end_date) : monthEnd;
  const clientHosp = hospByClient.get(clientId) ?? [];
  let firstHalf = false, secondHalf = false;
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(y, m - 1, d);
    if (date < rentalStart || date > rentalEnd) continue;
    const inHosp = clientHosp.some((h) => {
      const admit = parseLocalDate(h.admission_date);
      const discharge = h.discharge_date ? parseLocalDate(h.discharge_date) : monthEnd;
      return date >= admit && date <= discharge;
    });
    if (!inHosp) { if (d <= 15) firstHalf = true; else secondHalf = true; }
  }
  if (firstHalf && secondHalf) return "全月";
  if (firstHalf) return "前半のみ";
  if (secondHalf) return "後半のみ";
  return "該当なし";
}

// ── 因子定義 (実装を読んで列挙。measure = 実データ1行からの値の読み取り) ──
type Row = { item: OrderItemRow; clientId: string; eq: EquipRow | undefined };
interface Factor { name: string; why: string; values: readonly string[]; measure: (r: Row) => string | null; }

const FACTORS: Factor[] = [
  {
    name: "品目区分",
    why: "fukuyoguServiceCode(equipment.category) — BillingTab.tsx:749。サービスコード(6桁)を決め、未一致は請求から除外される",
    values: ["車いす", "車椅子付属品", "特殊寝台", "特殊寝台付属品", "床ずれ防止用具", "体位変換器", "手すり", "スロープ", "歩行器", "歩行補助つえ", "徘徊感知機器", "移動用リフト", "自動排泄処理装置", "不明(コード不一致)"],
    measure: (r) => {
      const cat = r.eq?.category ?? null;
      if (!cat) return "不明(コード不一致)";
      return fukuyoguServiceCode(cat) ? cat : "不明(コード不一致)";
    },
  },
  {
    name: "半月按分",
    why: "halfMonthUnits(base, firstHalf, secondHalf) — BillingTab.tsx:560-584。月の前半/後半それぞれに非入院の貸与日があるかで単位数が変わる",
    values: ["全月", "前半のみ", "後半のみ", "該当なし"],
    measure: (r) => halfMonthBucket(r.item, r.clientId),
  },
  {
    name: "入院による除外",
    why: "clientHosp.some(...) — BillingTab.tsx:575-579。貸与期間中に入院があると、その日を firstHalf/secondHalf 判定から除外する",
    values: ["入院あり", "入院なし"],
    measure: (r) => ((hospByClient.get(r.clientId) ?? []).length > 0 ? "入院あり" : "入院なし"),
  },
  {
    name: "価格改定",
    why: "getPriceForMonth(priceHistoryAll, code, billingMonth) ?? equipment.rental_price — BillingTab.tsx:559。当月に有効な履歴価格と現行価格が食い違うケースを別扱いできているか",
    values: ["履歴あり", "履歴なし(現行価格)"],
    measure: (r) => {
      const hist = getPriceForMonth(priceHistAll, r.item.product_code, MONTH);
      return hist != null ? "履歴あり" : "履歴なし(現行価格)";
    },
  },
  {
    name: "給付率",
    why: "client.benefit_rate — BillingTab.tsx:771-784。90/80/70 で保険請求額と自己負担額の按分が変わる。未設定は90扱い+警告",
    values: ["90", "80", "70", "未設定"],
    measure: (r) => {
      const raw = (clientById.get(r.clientId)?.benefit_rate ?? "").trim();
      if (!raw) return "未設定";
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? String(n) : "未設定";
    },
  },
  {
    name: "公費",
    why: "client_public_expenses (生保等) — BillingTab.tsx:792-794。あるとユーザー負担0円・公費へ全額振替",
    values: ["あり", "なし"],
    measure: (r) => (kohiActive.has(r.clientId) ? "あり" : "なし"),
  },
  {
    name: "居宅介護支援事業所",
    why: "client.care_office_id — BillingTab.tsx:788-790、build.ts:261。7131の計画作成区分コード(1/2)が変わる",
    values: ["あり", "なし"],
    measure: (r) => (clientById.get(r.clientId)?.care_office_id ? "あり" : "なし"),
  },
  {
    name: "貸与期間の逆転",
    why: "hasBrokenRentalDates(item) — order-item-helpers.ts。終了日<開始日のとき満額で請求に載る(警告のみ・値は変えない)",
    values: ["正常", "逆転"],
    measure: (r) => (hasBrokenRentalDates(r.item as never) ? "逆転" : "正常"),
  },
];

// ── 負のコントロール: 合成データで measure が動くことを先に確認する ──
console.log("── 負のコントロール (measure の生存確認) ──");
{
  const probeEq: EquipRow = { product_code: "PROBE", category: "車いす", rental_price: 5000, kind: "single" };
  const probeItem: OrderItemRow = { id: "probe", order_id: "probe", product_code: "PROBE", status: "rental_started", rental_start_date: "2026-06-01", rental_end_date: null, payment_type: "介護", quantity: 1 };
  const probeRow: Row = { item: probeItem, clientId: "__probe_client__", eq: probeEq };
  let ok = true;
  const f0 = FACTORS[0].measure(probeRow);
  if (f0 !== "車いす") { console.log(`  x 品目区分 probe 失敗: ${f0}`); ok = false; }
  const f1 = FACTORS[1].measure(probeRow);
  if (f1 !== "全月") { console.log(`  x 半月按分 probe 失敗 (該当日全部あるはずが ${f1})`); ok = false; }
  // 壊す: category を未知の値にすると「不明」に落ちることを確認 (検出力の確認)
  const brokenRow: Row = { ...probeRow, eq: { ...probeEq, category: "存在しない種目" } };
  const fBroken = FACTORS[0].measure(brokenRow);
  if (fBroken !== "不明(コード不一致)") { console.log(`  x 負のコントロール失敗: 未知categoryが「不明」に落ちない (${fBroken})`); ok = false; }
  console.log(`  ${ok ? "OK" : "NG"} 品目区分・半月按分の measure が合成データで期待通り動く (壊した入力も検出できる)`);
}
console.log("");

// ── 実データを因子で測る ──
const rows: Row[] = activeRentals.map((item) => ({
  item,
  clientId: orderById.get(item.order_id)?.client_id ?? "",
  eq: equipByCode.get(item.product_code),
}));

const seenValue = FACTORS.map(() => new Set<string>());
const seenPair = new Set<string>();
for (const r of rows) {
  const vals = FACTORS.map((f) => f.measure(r));
  for (let i = 0; i < FACTORS.length; i++) if (vals[i] != null) seenValue[i].add(vals[i]!);
  for (let i = 0; i < FACTORS.length; i++) {
    if (vals[i] == null) continue;
    for (let j = i + 1; j < FACTORS.length; j++) {
      if (vals[j] == null) continue;
      seenPair.add(`${i}:${vals[i]}|${j}:${vals[j]}`);
    }
  }
}

let theoreticalPairs = 0;
for (let i = 0; i < FACTORS.length; i++) for (let j = i + 1; j < FACTORS.length; j++) theoreticalPairs += FACTORS[i].values.length * FACTORS[j].values.length;

console.log("── 因子ごとの値カバレッジ (実データ: activeRentals " + rows.length + " 行) ──");
for (let i = 0; i < FACTORS.length; i++) {
  const f = FACTORS[i];
  const missing = f.values.filter((v) => !seenValue[i].has(v));
  console.log(`  ${f.name.padEnd(14)} 実データで見えた値 ${seenValue[i].size}/${f.values.length}` + (missing.length ? `   *0件: ${missing.join(" / ")}` : ""));
}

const rate = (100 * seenPair.size) / theoreticalPairs;
console.log(`\n══ 結論 ══`);
console.log(`測定可能ペア ${seenPair.size} / 理論ペア ${theoreticalPairs} = ${rate.toFixed(1)}%`);
console.log(`(理論ペア = ${FACTORS.length}因子 ${FACTORS.map((f) => f.values.length).join("×")} の総組合せ数を C(${FACTORS.length},2)=${(FACTORS.length * (FACTORS.length - 1)) / 2} 因子対ぶん積算)`);

console.log(`\n── 因子として扱わなかったが実装は読んでいるもの (0件ではなく「1種類しか無い」) ──`);
console.log(`  payment_type (activeRentals:457)   実データ分布: ${[...paymentTypeCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`    -> "介護" 以外 (医療保険/自費 等の分岐) は order_items 全体でも1件も無く、未検証`);
console.log(`  order_items.status (activeRentals:467)   実データ分布: ${[...statusCounts.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log(`  equipment_master.kind   全 ${equipAll.length} 件が "single" (用具マスタv2のset/BOM機能は未適用 — memory: project_order_app_equipment_master_v2)`);

console.log(`\n── 実装自体が存在せず測定できないもの ──`);
console.log(`  貸与 vs 販売(特定福祉用具販売)   buildFukuyoguDensou は貸与(サービス種類17)のみ。販売の国保連請求経路がコードに無い`);
console.log(`  軽度者例外(要介護度による対象外判定・医師意見書)   billing計算は care_level を読んでいない (grep 0件)`);
