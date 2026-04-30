import { supabase, Order, OrderItem, Member } from "./supabase";
import { cached, invalidateCache } from "./cache";

export async function getMembers(tenantId: string): Promise<Member[]> {
  return cached(`members:${tenantId}`, async () => {
    const { data, error } = await supabase
      .from("members")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("sort_order", { nullsFirst: false })
      .order("name");
    if (error) throw error;
    return data ?? [];
  });
}

// Supabase のデフォルト 1000件制限を回避するためページング取得
export async function getOrders(tenantId: string): Promise<Order[]> {
  return cached(`orders:${tenantId}:active`, async () => {
    const PAGE = 1000;
    const all: Order[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("orders")
        .select("*")
        .eq("tenant_id", tenantId)
        .neq("status", "cancelled")
        .order("ordered_at", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  });
}

export async function getAllOrders(tenantId: string): Promise<Order[]> {
  return cached(`orders:${tenantId}:all`, async () => {
    const PAGE = 1000;
    const all: Order[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("orders")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("ordered_at", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  });
}

export async function getOrderItems(orderId: string): Promise<OrderItem[]> {
  // 単一発注の明細はキャッシュしない（呼出頻度が低く、即時性が必要なため）
  const { data, error } = await supabase
    .from("order_items")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getAllOrderItemsByTenant(tenantId: string): Promise<OrderItem[]> {
  return cached(`order_items:${tenantId}`, async () => {
    const PAGE = 1000;
    const all: OrderItem[] = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from("order_items")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return all;
  });
}

export async function updateOrderItemStatus(
  id: string,
  status: OrderItem["status"],
  extra?: {
    rental_start_date?: string;
    rental_end_date?: string;
    rental_start_decided_at?: string;
    delivered_at?: string;
  }
): Promise<void> {
  const updates: Record<string, string> = {
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  if (status === "cancelled") {
    updates.cancelled_at = new Date().toISOString();
  }
  if (status === "rental_started" && !extra?.rental_start_decided_at) {
    updates.rental_start_decided_at = new Date().toISOString();
  }
  const { error } = await supabase
    .from("order_items")
    .update(updates)
    .eq("id", id);
  if (error) throw error;
  invalidateCache("order_items:");
  invalidateCache("orders:");
}

export async function createOrder(params: {
  tenantId: string;
  clientId?: string;
  eventId?: string;
  notes?: string;
  createdBy?: string;
  paymentType?: "介護" | "自費" | "特価自費";
  deliveryDate?: string;
  deliveryTime?: string;
  deliveryAddress?: string;
  deliveryType?: "直納" | "自社納品";
  attendanceRequired?: boolean;
  attendeeIds?: string[];
  supplierId?: string;
  tokkaSetPrice?: number;
}): Promise<Order> {
  const { data, error } = await supabase
    .from("orders")
    .insert({
      tenant_id: params.tenantId,
      client_id: params.clientId ?? null,
      event_id: params.eventId ?? null,
      ordered_at: new Date().toISOString(),
      status: "ordered",
      notes: params.notes ?? null,
      created_by: params.createdBy ?? null,
      payment_type: params.paymentType ?? "介護",
      delivery_date: params.deliveryDate ?? null,
      delivery_time: params.deliveryTime ?? null,
      delivery_address: params.deliveryAddress ?? null,
      delivery_type: params.deliveryType ?? "自社納品",
      attendance_required: params.attendanceRequired ?? false,
      attendee_ids: params.attendeeIds ?? [],
      supplier_id: params.supplierId ?? null,
      tokka_set_price: params.tokkaSetPrice ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("orders:");
  return data;
}

export async function createOrderItem(params: {
  orderId: string;
  tenantId: string;
  productCode: string;
  supplierId?: string;
  purchasePrice?: number;
  rentalPrice?: number;
  notes?: string;
  paymentType?: "介護" | "自費" | "特価自費" | null;
  quantity?: number;
  tokkaGroup?: string;
  tokkaGroupPrice?: number;
}): Promise<OrderItem> {
  const { data, error } = await supabase
    .from("order_items")
    .insert({
      order_id: params.orderId,
      tenant_id: params.tenantId,
      product_code: params.productCode,
      supplier_id: params.supplierId ?? null,
      purchase_price: params.purchasePrice ?? null,
      rental_price: params.rentalPrice ?? null,
      payment_type: params.paymentType ?? null,
      status: "ordered",
      notes: params.notes ?? null,
      quantity: params.quantity ?? 1,
      tokka_group: params.tokkaGroup ?? null,
      tokka_group_price: params.tokkaGroupPrice ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("order_items:");
  return data;
}

export async function recordEmailSent(orderId: string): Promise<void> {
  // email_sent_count をインクリメント、email_sent_at を更新
  const { data: current } = await supabase
    .from("orders")
    .select("email_sent_count")
    .eq("id", orderId)
    .single();
  const { error } = await supabase
    .from("orders")
    .update({
      email_sent_at: new Date().toISOString(),
      email_sent_count: (current?.email_sent_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId);
  if (error) throw error;
  invalidateCache("orders:");
}

export async function updateSupplierEmail(supplierId: string, email: string): Promise<void> {
  const { error } = await supabase
    .from("suppliers")
    .update({ email })
    .eq("id", supplierId);
  if (error) throw error;
  invalidateCache("suppliers:");
}

export async function updateOrderStatus(
  id: string,
  status: Order["status"]
): Promise<void> {
  const { error } = await supabase
    .from("orders")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  invalidateCache("orders:");
}
