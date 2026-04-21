import { supabase } from "./supabase";

// 売上帳票の手入力項目だけを保存するテーブル
export type SalesRecord = {
  id: string;
  tenant_id: string;
  order_item_id: string;
  event_type: "start" | "end";
  cancellation_reason: string | null;
  sales_rep: string | null;
  delivery_person: string | null;
  input_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// 対象テナントの sales_records をまとめて取得
export async function getSalesRecords(tenantId: string): Promise<SalesRecord[]> {
  const { data, error } = await supabase
    .from("sales_records")
    .select("*")
    .eq("tenant_id", tenantId);
  if (error) throw error;
  return (data ?? []) as SalesRecord[];
}

// 手入力項目を upsert（行が存在しなければ作成、あれば更新）
export async function upsertSalesRecord(
  tenantId: string,
  orderItemId: string,
  eventType: "start" | "end",
  patch: Partial<Omit<SalesRecord, "id" | "tenant_id" | "order_item_id" | "event_type" | "created_at" | "updated_at">>,
): Promise<void> {
  const { error } = await supabase
    .from("sales_records")
    .upsert(
      {
        tenant_id: tenantId,
        order_item_id: orderItemId,
        event_type: eventType,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "order_item_id,event_type" },
    );
  if (error) throw error;
}
