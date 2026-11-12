// OrderItem のステータス表示・帳票用の共有ヘルパー。
// Orders/Clients タブ本体(page.tsx)と CarePlanModal/ProposalModal/
// ContractDocumentsModal/RentalReportModal の両方から参照するため独立させている。
import type { CSSProperties } from "react";
import type { OrderItem } from "@/lib/supabase";
import { rentalMonthUnits, type DateRange, type ProrationMode } from "@/lib/half-month-units";

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
 * 1 明細の当月の算定単位 (1 個あたり)。利用者向け請求書・貸与報告書が使う。
 *   計算は請求・伝送と同じ lib/half-month-units.ts の rentalMonthUnits (2026-11-12 に calcMonthUnits から寄せた)。
 *   excluded = 入院・休止 (lib/rentalCalcContext.ts の excludedOf) / mode = 日割り設定 (modeOf)。
 *   price = 当月の価格 (価格履歴 → マスタ / 明細の価格 の順で呼出側が決める)
 * 戻り値: null = 価格なし / 未開始 (発注済・納品済) / 翌月以降に開始。0 = キャンセル・先月以前に終了
 * ⚠ 終了日 < 開始日 (壊れたデータ) は 貸与日が 0 日なので 0 になる (旧 calcMonthUnits は満額を返していた)。
 *   呼出側で hasBrokenRentalDates() を見て警告を出す。実測 (2026-09-03): 0 行。
 */
export function itemMonthUnits(
  item: OrderItem,
  ym: string,
  price: number | null | undefined,
  excluded: readonly DateRange[] = [],
  mode: ProrationMode = "auto",
): number | null {
  if (!price) return null;
  if (item.status === "ordered" || item.status === "delivered" || item.status === "trial") return null;
  if (item.status === "cancelled") return 0;
  const [y, m] = ym.split("-").map(Number);
  const monthEnd = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const start = (item.rental_start_date ?? "").slice(0, 10);
  const end = (item.rental_end_date ?? "").slice(0, 10);
  if (start && start > monthEnd && !(end && end < start)) return null; // 翌月以降に開始
  return rentalMonthUnits(Math.round(price / 10), item.rental_start_date, item.rental_end_date, ym, excluded, mode);
}

/**
 * 貸与期間の日付が壊れているか (終了日 < 開始日)。
 *
 * 請求を組む側で警告に出す。⚠ **値は変えない** (請求から黙って消さず、気づけるようにするのが目的)。
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
