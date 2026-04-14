import { supabase } from "./supabase";

export type CareOffice = {
  id: string;
  tenant_id: string;
  name: string;
  fax_number: string | null;
  phone_number: string | null;
  address: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
};

export async function getCareOffices(tenantId: string): Promise<CareOffice[]> {
  const { data, error } = await supabase
    .from("care_offices")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("name", { ascending: true });
  if (error) throw error;
  return data ?? [];
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
  return data;
}

export async function deleteCareOffice(id: string): Promise<void> {
  const { error } = await supabase.from("care_offices").delete().eq("id", id);
  if (error) throw error;
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
