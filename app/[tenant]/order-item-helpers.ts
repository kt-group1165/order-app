// OrderItem のステータス表示・帳票用の共有ヘルパー。
// Orders/Clients タブ本体(page.tsx)と CarePlanModal/ProposalModal/
// ContractDocumentsModal/RentalReportModal の両方から参照するため独立させている。
import type { CSSProperties } from "react";
import type { OrderItem } from "@/lib/supabase";
import { halfMonthUnits } from "@/lib/half-month-units";

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
    // ⚠ **この分岐は正常データでは到達しない** (2026-09-03 確認)。
    //   条件は `start > 月末` かつ `end <= 月末` = **終了日が開始日より前**。
    //   到達したときは日付が壊れているのに **黙って満額を請求に載せる**ので、
    //   呼出側で `hasBrokenRentalDates()` を見て警告を出すこと。
    //   実測: order_items 4,669 行中 該当 **0 行** (終了<開始 も 開始日なし も 0)。
    if (item.status === "terminated" && end && end <= monthEnd) {
      return end <= day15 ? halfMonthUnits(fullUnits, true, false) : fullUnits;
    }
    return null; // 翌月以降開始
  }

  // 上半期（1〜15日）に1日でも利用
  const inUpper = (!start || start <= day15) && (!end || end >= monthStart);
  // 下半期（16〜末日）に1日でも利用
  const inLower = (!start || start <= monthEnd) && (!end || end >= day16);

  return halfMonthUnits(fullUnits, inUpper, inLower);
}

/**
 * 貸与期間の日付が壊れているか (終了日 < 開始日)。
 *
 * `calcMonthUnits` はこの状態でも **満額を返して請求に載せてしまう**ので、
 * 請求を組む側で警告に出す。⚠ **値は変えない** (null にすると請求から消えて
 * それはそれで黙るため。気づけるようにするのが目的)。
 * 実測 (2026-09-03): order_items 4,669 行中 該当 0 行。
 */
export function hasBrokenRentalDates(item: OrderItem): boolean {
  return !!(item.rental_start_date && item.rental_end_date &&
    item.rental_end_date < item.rental_start_date);
}

// ============================================================
// 軽度者(要支援1・2/要介護1) 原則対象外品目 — B-6d (2026-09-05)
// ============================================================
// ⚠⚠⚠ 告示の条件は未確認 (2026-09-05 時点) ⚠⚠⚠
//   下記は一般的な福祉用具貸与の軽度者原則対象外ルールから G が整理したもので、
//   ★ 告示・通知の条文原文までは確認していない。user が確認したらこの注記と
//   migrations/fukuyogu_exception_grants.sql の同趣旨コメントを消すこと。
//
// 6区分 (車いす系〜移動用リフト) は「要支援1・2/要介護1」が原則対象外で、
// 例外給付 (医師意見書 or サービス担当者会議等) があれば対象になる。
//
// ⚠ 自動排泄処理装置は上記6区分と別ロジック (要介護4・5のみ対象、かつ
//   「尿のみ吸引」型は要介護度不問という更なる例外がある)。equipment_master.category
//   にはこの2型を区別する列が無い (2026-09-05 実測: 該当0件でまだ実害なし)。
//   → judgeKeidoException() は自動排泄処理装置について **判定を保留** し、
//     警告を出さない。誤警告 (尿のみ吸引型なのに軽度者向け警告を出す) を
//     避けるため。将来 equipment_master に型を区別する列が増えたら見直すこと。

/** equipment_master.category → 例外給付の単位となる区分 (fukuyogu_exception_grants.restriction_group と揃える) */
export const RESTRICTION_GROUP_OF_CATEGORY: Record<string, string> = {
  "車いす": "車いす系", "車椅子": "車いす系",
  "車いす付属品": "車いす系", "車椅子付属品": "車いす系",
  "特殊寝台": "特殊寝台系", "特殊寝台付属品": "特殊寝台系",
  "床ずれ防止用具": "床ずれ防止用具",
  "体位変換器": "体位変換器",
  "徘徊感知機器": "徘徊感知機器", "認知症老人徘徊感知機器": "徘徊感知機器",
  "移動用リフト": "移動用リフト",
  // 自動排泄処理装置は意図的に含めない (上記コメント参照。判定保留)
};

/** 軽度者 (要支援1・2/要介護1)。NFKC 正規化後の値で判定すること */
export const KEIDO_CARE_LEVELS = new Set(["要支援1", "要支援2", "要介護1"]);

/**
 * この (要介護度, 品目カテゴリ) の組合せが「軽度者原則対象外」に該当するか。
 * 自動排泄処理装置は判定保留のため常に false (上記コメント参照)。
 */
export function isKeidoRestricted(careLevel: string | null | undefined, category: string | null | undefined): boolean {
  if (!careLevel || !category) return false;
  const cl = careLevel.normalize("NFKC").replace(/\s/g, "");
  if (!KEIDO_CARE_LEVELS.has(cl)) return false;
  return category in RESTRICTION_GROUP_OF_CATEGORY;
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
