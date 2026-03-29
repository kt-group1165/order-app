import { supabase, Order, OrderItem, Member } from "./supabase";

export async function getMembers(tenantId: string): Promise<Member[]> {
  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("sort_order", { nullsFirst: false })
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function getOrders(tenantId: string): Promise<Order[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", tenantId)
    .neq("status", "cancelled")
    .order("ordered_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getAllOrders(tenantId: string): Promise<Order[]> {
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("ordered_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getOrderItems(orderId: string): Promise<OrderItem[]> {
  const { data, error } = await supabase
    .from("order_items")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getAllOrderItemsByTenant(tenantId: string): Promise<OrderItem[]> {
  const { data, error } = await supabase
    .from("order_items")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
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
}

export async function createOrder(params: {
  tenantId: string;
  clientId?: string;
  eventId?: string;
  notes?: string;
  createdBy?: string;
  paymentType?: "介護" | "自費";
  deliveryDate?: string;
  deliveryTime?: string;
  deliveryType?: "直納" | "自社納品";
  attendanceRequired?: boolean;
  attendeeIds?: string[];
  supplierId?: string;
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
      delivery_type: params.deliveryType ?? "自社納品",
      attendance_required: params.attendanceRequired ?? false,
      attendee_ids: params.attendeeIds ?? [],
      supplier_id: params.supplierId ?? null,
    })
    .select()
    .single();
  if (error) throw error;
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
  paymentType?: "介護" | "自費" | null;
  quantity?: number;
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
    })
    .select()
    .single();
  if (error) throw error;
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
}

export async function updateSupplierEmail(supplierId: string, email: string): Promise<void> {
  const { error } = await supabase
    .from("suppliers")
    .update({ email })
    .eq("id", supplierId);
  if (error) throw error;
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
}
