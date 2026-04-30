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

export type ClientOfficeAssignment = {
  tenant_id: string;
  client_id: string;
  office_id: string;
  created_at: string;
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
