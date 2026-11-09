/**
 * 福祉用具 貸与の休止期間 (order_item_pauses) の読込。2026-11-09 FY-PZ。
 *
 * 休止日は 伝送の明細 項10 日数 (fukuyoguRentalDaysInMonth) と 半月按分の判定 (halfMonthFlags) から除く。
 * 計算は lib/half-month-units.ts / lib/kokuho-densou/build.ts の純関数。ここは読むだけ。
 *
 * ⚠ 表は migrations/order_item_pauses.sql。**未適用でも請求画面と伝送は壊さない**:
 *   読めなければ「休止なし」(空の Map) として扱い、available=false と理由を返す (呼出側で画面に出す)。
 *   console.error にも出す (silent にしない)。
 */
import { supabase } from "./supabase";
import { isTableMissingError } from "./fukuyoguExceptions";
import type { DateRange } from "./half-month-units";

export type OrderItemPauseRow = {
  id: string;
  tenant_id: string;
  order_item_id: string;
  pause_from: string;
  pause_to: string;
  reason: string | null;
  source: string;
  notes: string | null;
  created_at: string;
};

export type PausesLoad = {
  /** order_item_id → 休止期間 */
  byItem: Map<string, DateRange[]>;
  /** 表が読めたか (false = 未適用・権限なし・通信エラー。全員「休止なし」扱い) */
  available: boolean;
  /** 読めなかった理由 (画面に出す) */
  message: string | null;
};

/** 行の配列 → order_item_id ごとの DateRange[] (純関数。突合 script と共用) */
export function groupPausesByItem(rows: readonly Pick<OrderItemPauseRow, "order_item_id" | "pause_from" | "pause_to">[]): Map<string, DateRange[]> {
  const byItem = new Map<string, DateRange[]>();
  for (const r of rows) {
    if (!byItem.has(r.order_item_id)) byItem.set(r.order_item_id, []);
    byItem.get(r.order_item_id)!.push({ from: r.pause_from.slice(0, 10), to: r.pause_to.slice(0, 10) });
  }
  return byItem;
}

/** テナントの休止を全部読む (件数は数百行の想定。1000 行ずつページング) */
export async function loadOrderItemPauses(tenantId: string): Promise<PausesLoad> {
  const rows: Pick<OrderItemPauseRow, "order_item_id" | "pause_from" | "pause_to">[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("order_item_pauses")
      .select("order_item_id, pause_from, pause_to")
      .eq("tenant_id", tenantId)
      .order("id")
      .range(from, from + 999);
    if (error) {
      console.error("order_item_pauses 読込失敗:", error.code, error.message);
      const why = isTableMissingError(error)
        ? "貸与の休止期間の表 (order_item_pauses) が未適用です — migrations/order_item_pauses.sql を適用するまで、休止を除かずに (貸与期間の全日で) 日数・半月按分を計算します"
        : `貸与の休止期間を読めませんでした (${error.message}) — 休止を除かずに日数・半月按分を計算します`;
      return { byItem: new Map(), available: false, message: why };
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return { byItem: groupPausesByItem(rows), available: true, message: null };
}
