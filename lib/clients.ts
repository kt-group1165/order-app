import { supabase, Client } from "./supabase";

export async function getClients(tenantId: string): Promise<Client[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("furigana", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data ?? [];
}
