// 貸与報告書 (福祉用具貸与提供報告書) の判定 — 1 人ずつの画面 (RentalReportModal) と
// 毎月の一括作成 (BulkRentalReportModal) で同じ規則を使うための純関数。
// 検証: npm run check:rental-report (scripts/rental-report-verify.mts)

export const USAGE_TYPE_LABELS = ["新規納品", "追加納品", "一式回収", "一部回収", "特定福祉用具購入", "継続"] as const;
export type UsageType = (typeof USAGE_TYPE_LABELS)[number];

/** 判定に使う貸与明細の列 (OrderItem の一部) */
export type RentalItemLike = {
  status: string;
  rental_start_date: string | null;
  rental_end_date: string | null;
};

function monthRange(targetMonth: string): { start: string; end: string } {
  const [y, m] = targetMonth.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  return { start: `${targetMonth}-01`, end: `${targetMonth}-${String(lastDay).padStart(2, "0")}` };
}

/** 報告書の表に載せる明細 (貸与中・解約済・開始後の取消) */
export function isReportItem(i: RentalItemLike): boolean {
  return i.status === "rental_started" || ((i.status === "terminated" || i.status === "cancelled") && !!i.rental_start_date);
}

/**
 * 貸与利用項目 (新規納品 / 追加納品 / 一式回収 / 一部回収 / 継続) を対象月の動きから決める。
 * 何も当たらないときは「継続」。特定福祉用具購入は貸与明細からは決めない (手で付ける)。
 */
export function detectRentalUsage(items: RentalItemLike[], targetMonth: string): UsageType[] {
  const { start: monthStart, end: monthEnd } = monthRange(targetMonth);
  const all = items.filter((i) => i.status !== "cancelled" && i.rental_start_date);
  const terminatedThisMonth = all.filter((i) => i.status === "terminated" && i.rental_end_date && i.rental_end_date >= monthStart && i.rental_end_date <= monthEnd);
  const startedThisMonth = all.filter((i) => i.rental_start_date! >= monthStart && i.rental_start_date! <= monthEnd);
  const continuing = all.filter((i) => i.rental_start_date! < monthStart && (!i.rental_end_date || i.rental_end_date > monthEnd));

  const usage = new Set<UsageType>();
  if (terminatedThisMonth.length > 0) {
    const remaining = all.filter((i) => i.status === "rental_started" || (i.status === "terminated" && i.rental_end_date && i.rental_end_date > monthEnd));
    usage.add(remaining.length === 0 ? "一式回収" : "一部回収");
  }
  if (startedThisMonth.length > 0) usage.add(continuing.length > 0 ? "追加納品" : "新規納品");
  if (continuing.length > 0) usage.add("継続");
  if (usage.size === 0) usage.add("継続");
  return USAGE_TYPE_LABELS.filter((t) => usage.has(t));
}

/** 対象月に 1 日でも貸与している明細があるか (= その月の報告書の対象) */
export function hasRentalInMonth(items: RentalItemLike[], targetMonth: string): boolean {
  const { start, end } = monthRange(targetMonth);
  return items.some((i) =>
    (i.status === "rental_started" || i.status === "terminated") &&
    !!i.rental_start_date && i.rental_start_date <= end &&
    (!i.rental_end_date || i.rental_end_date >= start));
}

/** 対象月に開始か解約があったか (= 「動きのあった人」) */
export function hasMovementInMonth(items: RentalItemLike[], targetMonth: string): boolean {
  const { start, end } = monthRange(targetMonth);
  const inMonth = (d: string | null) => !!d && d >= start && d <= end;
  return items.some((i) =>
    (i.status === "rental_started" && inMonth(i.rental_start_date)) ||
    (i.status === "terminated" && (inMonth(i.rental_start_date) || inMonth(i.rental_end_date))));
}

/** 書類の題名 (1 人ずつの画面と同じ形。履歴の一覧で同じ月の重複を見分けるのに使う) */
export function rentalReportTitle(targetMonth: string): string {
  const [y, m] = targetMonth.split("-").map(Number);
  const n = new Date(y, m, 1);
  return `貸与報告書 ${y}年${m}月・${n.getFullYear()}年${n.getMonth() + 1}月分`;
}
