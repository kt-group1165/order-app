// 福祉用具貸与の算定方法 (明細 × 月)。既定 = 自動 (半月按分)。行がある月だけ 日割り (2026-11-12 user 依頼)
//   表: order_item_proration (migrations/order_item_proration.sql)。計算は lib/half-month-units.ts rentalMonthUnits
//   ⚠ 表が未適用でも壊さない: 読めなければ available=false で全件 自動 (呼出側は notice を画面に出す)
import { supabase } from "./supabase";
import type { ProrationMode } from "./half-month-units";

export type ProrationLoad = {
  /** `${order_item_id}|${YYYY-MM}` → mode (行がある = daily) */
  byKey: Map<string, ProrationMode>;
  available: boolean;
  notice: string | null;
};

export const prorationKey = (orderItemId: string, ym: string) => `${orderItemId}|${ym}`;

/** その明細のその月の算定方法 (表が無い/行が無い = auto) */
export function prorationModeOf(load: ProrationLoad | null | undefined, orderItemId: string, ym: string): ProrationMode {
  return load?.byKey.get(prorationKey(orderItemId, ym)) ?? "auto";
}

/** 表が無い (42P01 / PGRST205) */
function isTableMissing(error: { code?: string; message?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205" || /order_item_proration/.test(error?.message ?? "") && /does not exist|Could not find/.test(error?.message ?? "");
}

/** テナントの全行を読む (行は日割りにした分だけなので少ない)。表が無ければ available=false。それ以外のエラーは throw */
export async function loadProrations(tenantId: string): Promise<ProrationLoad> {
  const byKey = new Map<string, ProrationMode>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("order_item_proration")
      .select("id, order_item_id, month, mode")
      .eq("tenant_id", tenantId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) {
      if (isTableMissing(error)) {
        return { byKey, available: false, notice: "日割りの設定表 (order_item_proration) が未適用のため、全件 半月按分の自動で計算しています" };
      }
      throw new Error(`日割り設定の読み込みに失敗: ${error.message}`);
    }
    for (const r of data ?? []) if (r.mode === "daily") byKey.set(prorationKey(r.order_item_id, r.month), "daily");
    if (!data || data.length < PAGE) break;
  }
  return { byKey, available: true, notice: null };
}

/** 算定方法を保存する。auto = 行を消す / daily = upsert。失敗は throw */
export async function saveProration(tenantId: string, orderItemId: string, ym: string, mode: ProrationMode): Promise<void> {
  if (mode === "auto") {
    const { error } = await supabase.from("order_item_proration").delete().eq("order_item_id", orderItemId).eq("month", ym);
    if (error) throw new Error(`日割りの解除に失敗: ${error.message}`);
    return;
  }
  const { error } = await supabase
    .from("order_item_proration")
    .upsert({ tenant_id: tenantId, order_item_id: orderItemId, month: ym, mode }, { onConflict: "order_item_id,month" });
  if (error) throw new Error(`日割りの保存に失敗: ${error.message}`);
}
