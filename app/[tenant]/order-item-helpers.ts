// OrderItem のステータス表示・帳票用の共有ヘルパー。
// Orders/Clients タブ本体(page.tsx)と CarePlanModal/ProposalModal/
// ContractDocumentsModal/RentalReportModal の両方から参照するため独立させている。
import type { CSSProperties } from "react";
import type { OrderItem } from "@/lib/supabase";

export const STATUS_LABEL: Record<OrderItem["status"], string> = {
  ordered: "発注済",
  delivered: "納品済",
  trial: "納品済",          // 試用中は廃止→納品済と統一
  rental_started: "レンタル中",
  cancelled: "キャンセル",
  terminated: "解約済",
};

export const STATUS_COLOR: Record<OrderItem["status"], string> = {
  ordered: "bg-blue-100 text-blue-700",
  delivered: "bg-purple-100 text-purple-700",
  trial: "bg-purple-100 text-purple-700", // 試用中=納品済扱い
  rental_started: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-gray-100 text-gray-500",
  terminated: "bg-red-100 text-red-600",
};

export const NEXT_STATUSES: Record<OrderItem["status"], OrderItem["status"][]> = {
  ordered: ["delivered", "rental_started", "cancelled"],
  delivered: ["rental_started", "cancelled"], // 試用中は廃止
  trial: ["rental_started", "cancelled"],     // DB後方互換のため残す
  rental_started: ["terminated"],
  cancelled: [],
  terminated: [],
};

/**
 * 半月ルール単位数計算
 * ・1〜15日のいずれかに利用あり → 半月分単位数
 * ・16〜末日のいずれかに利用あり → 半月分単位数
 */
export function calcMonthUnits(item: OrderItem, year: number, month: number, priceOverride?: number): number | null {
  const price = priceOverride ?? item.rental_price;
  if (!price) return null;
  if (item.status === "ordered" || item.status === "delivered" || item.status === "trial") return null;
  if (item.status === "cancelled") return 0;

  const fullUnits = Math.round(price / 10);
  const halfUnits = Math.floor(fullUnits / 2);
  const remUnits  = fullUnits - halfUnits; // ceil(fullUnits / 2)

  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart  = new Date(year, month - 1, 1);
  const monthEnd    = new Date(year, month - 1, daysInMonth);
  const day15       = new Date(year, month - 1, 15);
  const day16       = new Date(year, month - 1, 16);

  const start = item.rental_start_date ? new Date(item.rental_start_date + "T00:00:00") : null;
  const end   = item.rental_end_date   ? new Date(item.rental_end_date   + "T00:00:00") : null;

  if (end   && end   < monthStart) return 0;   // 先月以前終了
  if (start && start > monthEnd) {
    // 解約済みで終了日が今月内なら半月ルール適用（開始日が来月以降の場合）
    if (item.status === "terminated" && end && end <= monthEnd) {
      return end <= day15 ? halfUnits : halfUnits + remUnits;
    }
    return null; // 翌月以降開始
  }

  // 上半期（1〜15日）に1日でも利用
  const inUpper = (!start || start <= day15) && (!end || end >= monthStart);
  // 下半期（16〜末日）に1日でも利用
  const inLower = (!start || start <= monthEnd) && (!end || end >= day16);

  return (inUpper ? halfUnits : 0) + (inLower ? remUnits : 0);
}

/** 報告書用短縮日付: R8.3.15 形式 */
export function toShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (y > 2019 || (y === 2019 && m >= 5)) return `R${y - 2018}.${m}.${day}`;
  if (y > 1989 || (y === 1989 && m >= 1 && day >= 8)) return `H${y - 1988}.${m}.${day}`;
  return `S${y - 1925}.${m}.${day}`;
}

// 貸与報告書テーブルスタイル定数
export const RPT_TD: CSSProperties = { border: "1px solid #aaa", padding: "2px 5px", verticalAlign: "middle" };
export const RPT_TH: CSSProperties = { border: "1px solid #888", padding: "3px 4px", background: "#e8e8e8", textAlign: "center" as const, verticalAlign: "middle" };
export const RPT_TABLE: CSSProperties = { borderCollapse: "collapse" as const, width: "100%" };
