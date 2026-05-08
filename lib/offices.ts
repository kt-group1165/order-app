import { supabase } from "./supabase";
import { cached, invalidateCache } from "./cache";

export type Office = {
  id: string;
  tenant_id: string;
  name: string;
  business_number: string | null;
  service_type: string | null;
  sort_order: number;
  created_at: string;
};

// order-app は福祉用具貸与アプリなので、福祉用具の事業所のみ扱う
export const APP_SERVICE_TYPE = "福祉用具";

export type EquipmentOfficePrice = {
  id: string;
  tenant_id: string;
  product_code: string;
  office_id: string;
  rental_price: number;
  updated_at: string;
};

export async function getOffices(tenantId: string): Promise<Office[]> {
  return cached(`offices:${tenantId}`, async () => {
    // 福祉用具の事業所 + service_type未設定（旧データ）を返す
    const { data, error } = await supabase
      .from("offices")
      .select("*")
      .eq("tenant_id", tenantId)
      .or(`service_type.eq.${APP_SERVICE_TYPE},service_type.is.null`)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });
}

export async function createOffice(tenantId: string, name: string): Promise<Office> {
  // order-app から作成される事業所は必ず福祉用具
  const { data, error } = await supabase
    .from("offices")
    .insert({ tenant_id: tenantId, name, service_type: APP_SERVICE_TYPE, sort_order: 0 })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("offices:");
  return data;
}

export async function updateOffice(id: string, name: string, businessNumber?: string | null): Promise<void> {
  const patch: { name: string; business_number?: string | null } = { name };
  if (businessNumber !== undefined) patch.business_number = businessNumber;
  const { error } = await supabase.from("offices").update(patch).eq("id", id);
  if (error) throw error;
  invalidateCache("offices:");
}

export async function deleteOffice(id: string): Promise<void> {
  const { error } = await supabase.from("offices").delete().eq("id", id);
  if (error) throw error;
  invalidateCache("offices:");
}

export async function getOfficePrices(tenantId: string): Promise<EquipmentOfficePrice[]> {
  return cached(`office_prices:${tenantId}`, async () => {
    const { data, error } = await supabase
      .from("equipment_office_prices")
      .select("*")
      .eq("tenant_id", tenantId);
    if (error) throw error;
    return data ?? [];
  });
}

export async function upsertOfficePrice(
  tenantId: string,
  productCode: string,
  officeId: string,
  rentalPrice: number
): Promise<void> {
  const { error } = await supabase
    .from("equipment_office_prices")
    .upsert(
      {
        tenant_id: tenantId,
        product_code: productCode,
        office_id: officeId,
        rental_price: rentalPrice,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,product_code,office_id" }
    );
  if (error) throw error;
  invalidateCache("office_prices:");
}

export async function deleteOfficePrice(
  tenantId: string,
  productCode: string,
  officeId: string
): Promise<void> {
  const { error } = await supabase
    .from("equipment_office_prices")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("product_code", productCode)
    .eq("office_id", officeId);
  if (error) throw error;
  invalidateCache("office_prices:");
}

export async function bulkUpsertOfficePrices(
  prices: { tenant_id: string; product_code: string; office_id: string; rental_price: number }[]
): Promise<void> {
  if (prices.length === 0) return;
  const rows = prices.map((p) => ({ ...p, updated_at: new Date().toISOString() }));
  const { error } = await supabase
    .from("equipment_office_prices")
    .upsert(rows, { onConflict: "tenant_id,product_code,office_id" });
  if (error) throw error;
  invalidateCache("office_prices:");
}

// ─── 利用者×事業所 適用紐付け ─────────────────────────────────────────────────
// (client_id, office_id) ペアで複数行 OK (UNIQUE 無し、検証済 2026-05-08)
// kaigo-app と共有: end_date IS NULL = 現役 / start_date - end_date で利用期間を表現

export type ClientOfficeAssignment = {
  id: string;
  tenant_id: string;
  client_id: string;
  office_id: string;
  start_date: string | null;
  end_date: string | null;
  service_notes: string | null;
  home_care_categories: string[] | null;
  created_at: string;
  updated_at: string | null;
};

export async function getClientOfficeAssignments(tenantId: string): Promise<ClientOfficeAssignment[]> {
  return cached(`client_office_assignments:${tenantId}`, async () => {
    const { data, error } = await supabase
      .from("client_office_assignments")
      .select("*")
      .eq("tenant_id", tenantId);
    if (error) throw error;
    return data ?? [];
  });
}

export async function assignClientToOffice(
  tenantId: string,
  clientId: string,
  officeId: string
): Promise<void> {
  const { error } = await supabase
    .from("client_office_assignments")
    .upsert(
      { tenant_id: tenantId, client_id: clientId, office_id: officeId },
      { onConflict: "tenant_id,client_id,office_id" }
    );
  if (error) throw error;
  invalidateCache("client_office_assignments:");
}

export async function removeClientFromOffice(
  tenantId: string,
  clientId: string,
  officeId: string
): Promise<void> {
  const { error } = await supabase
    .from("client_office_assignments")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .eq("office_id", officeId);
  if (error) throw error;
  invalidateCache("client_office_assignments:");
}

export async function getClientsByOffice(
  tenantId: string,
  officeId: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from("client_office_assignments")
    .select("client_id")
    .eq("tenant_id", tenantId)
    .eq("office_id", officeId);
  if (error) throw error;
  return (data ?? []).map((d) => d.client_id);
}

// ─── 利用期間 (start_date / end_date) 管理 ──────────────────────────────────
// rental_started 時に open 期間を自動 INSERT、すべての active item が終了したら自動 close。
// 加えて、利用期間そのものを手動 CRUD できる API も提供する。

/** 当該 client + (option) officeId の assignment 行を取得 (start_date 降順) */
export async function getClientAssignmentsForClient(
  clientId: string,
  officeId?: string | null
): Promise<ClientOfficeAssignment[]> {
  let q = supabase
    .from("client_office_assignments")
    .select("*")
    .eq("client_id", clientId)
    .order("start_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });
  if (officeId) q = q.eq("office_id", officeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ClientOfficeAssignment[];
}

/** open 期間 (end_date IS NULL) が 1 件も無ければ start_date=今日 で INSERT。返り値は INSERT 行 or null */
export async function ensureActiveAssignment(
  clientId: string,
  officeId: string,
  tenantId: string
): Promise<ClientOfficeAssignment | null> {
  const { data: existing, error: selErr } = await supabase
    .from("client_office_assignments")
    .select("id")
    .eq("client_id", clientId)
    .eq("office_id", officeId)
    .is("end_date", null)
    .limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length > 0) return null;
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("client_office_assignments")
    .insert({
      tenant_id: tenantId,
      client_id: clientId,
      office_id: officeId,
      start_date: today,
    })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("client_office_assignments:");
  return data as ClientOfficeAssignment;
}

/** 現 open 期間 (end_date IS NULL) があれば end_date=今日 で UPDATE。返り値は更新件数 */
export async function closeActiveAssignment(
  clientId: string,
  officeId: string
): Promise<number> {
  const today = new Date().toISOString().split("T")[0];
  const { data, error } = await supabase
    .from("client_office_assignments")
    .update({ end_date: today })
    .eq("client_id", clientId)
    .eq("office_id", officeId)
    .is("end_date", null)
    .select("id");
  if (error) throw error;
  invalidateCache("client_office_assignments:");
  return (data ?? []).length;
}

/** 手動: 任意 start/end_date で新規行を作成 */
export async function addAssignment(
  tenantId: string,
  clientId: string,
  officeId: string,
  startDate: string | null,
  endDate: string | null = null,
  notes: string | null = null
): Promise<ClientOfficeAssignment> {
  const { data, error } = await supabase
    .from("client_office_assignments")
    .insert({
      tenant_id: tenantId,
      client_id: clientId,
      office_id: officeId,
      start_date: startDate,
      end_date: endDate,
      service_notes: notes,
    })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("client_office_assignments:");
  return data as ClientOfficeAssignment;
}

/** 手動: 既存行の start/end_date / メモ を更新 */
export async function updateAssignment(
  id: string,
  patch: Partial<Pick<ClientOfficeAssignment, "start_date" | "end_date" | "service_notes">>
): Promise<void> {
  const { error } = await supabase
    .from("client_office_assignments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  invalidateCache("client_office_assignments:");
}

/** 手動: 行を削除 */
export async function deleteAssignment(id: string): Promise<void> {
  const { error } = await supabase
    .from("client_office_assignments")
    .delete()
    .eq("id", id);
  if (error) throw error;
  invalidateCache("client_office_assignments:");
}
