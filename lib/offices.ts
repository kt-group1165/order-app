import { supabase } from "./supabase";

export type Office = {
  id: string;
  tenant_id: string;
  name: string;
  sort_order: number;
  created_at: string;
};

export type EquipmentOfficePrice = {
  id: string;
  tenant_id: string;
  product_code: string;
  office_id: string;
  rental_price: number;
  updated_at: string;
};

export async function getOffices(tenantId: string): Promise<Office[]> {
  const { data, error } = await supabase
    .from("offices")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createOffice(tenantId: string, name: string): Promise<Office> {
  const { data, error } = await supabase
    .from("offices")
    .insert({ tenant_id: tenantId, name, sort_order: 0 })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateOffice(id: string, name: string): Promise<void> {
  const { error } = await supabase.from("offices").update({ name }).eq("id", id);
  if (error) throw error;
}

export async function deleteOffice(id: string): Promise<void> {
  const { error } = await supabase.from("offices").delete().eq("id", id);
  if (error) throw error;
}

export async function getOfficePrices(tenantId: string): Promise<EquipmentOfficePrice[]> {
  const { data, error } = await supabase
    .from("equipment_office_prices")
    .select("*")
    .eq("tenant_id", tenantId);
  if (error) throw error;
  return data ?? [];
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
}
