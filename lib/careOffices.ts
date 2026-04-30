import { supabase } from "./supabase";
import { cached, invalidateCache } from "./cache";

export type CareOffice = {
  id: string;
  tenant_id: string;
  name: string;
  fax_number: string | null;
  phone_number: string | null;
  address: string | null;
  email: string | null;
  notes: string | null;
  // 厚労省介護サービス情報公表システムの事業所番号（10桁）
  office_number: string | null;
  created_at: string;
};

export async function getCareOffices(tenantId: string): Promise<CareOffice[]> {
  return cached(`care_offices:${tenantId}`, async () => {
    const { data, error } = await supabase
      .from("care_offices")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });
}

export async function upsertCareOffice(
  tenantId: string,
  office: Omit<CareOffice, "id" | "tenant_id" | "created_at"> & { id?: string }
): Promise<CareOffice> {
  const { data, error } = await supabase
    .from("care_offices")
    .upsert({ ...office, tenant_id: tenantId }, { onConflict: "id" })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("care_offices:");
  return data;
}

export async function deleteCareOffice(id: string): Promise<void> {
  const { error } = await supabase.from("care_offices").delete().eq("id", id);
  if (error) throw error;
  invalidateCache("care_offices:");
  invalidateCache("care_managers:");
}

// ─── ケアマネ ────────────────────────────────────────────────────────────────

export type CareManager = {
  id: string;
  tenant_id: string;
  care_office_id: string;
  name: string;
  active: boolean;
  created_at: string;
};

export async function getCareManagers(tenantId: string): Promise<CareManager[]> {
  return cached(`care_managers:${tenantId}`, async () => {
    const { data, error } = await supabase
      .from("care_managers")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("name", { ascending: true });
    if (error) throw error;
    return data ?? [];
  });
}

export async function addCareManager(
  tenantId: string,
  careOfficeId: string,
  name: string
): Promise<CareManager> {
  const { data, error } = await supabase
    .from("care_managers")
    .insert({ tenant_id: tenantId, care_office_id: careOfficeId, name, active: true })
    .select()
    .single();
  if (error) throw error;
  invalidateCache("care_managers:");
  return data;
}

export async function updateCareManager(
  id: string,
  params: { name?: string; care_office_id?: string; active?: boolean }
): Promise<void> {
  const { error } = await supabase.from("care_managers").update(params).eq("id", id);
  if (error) throw error;
  invalidateCache("care_managers:");
}

export async function deleteCareManager(id: string): Promise<void> {
  const { error } = await supabase.from("care_managers").delete().eq("id", id);
  if (error) throw error;
  invalidateCache("care_managers:");
}

// eFax送信（API Route経由）
export async function sendFax(params: {
  toFaxNumber: string;
  pdfBase64: string;
  subject?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const res = await fetch("/api/send-fax", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}
