import { supabase, ClientDocument } from "./supabase";

export async function getClientDocuments(
  tenantId: string,
  clientId: string
): Promise<ClientDocument[]> {
  const { data, error } = await supabase
    .from("client_documents")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function saveClientDocument(
  doc: Omit<ClientDocument, "id" | "created_at">
): Promise<ClientDocument> {
  const { data, error } = await supabase
    .from("client_documents")
    .insert(doc)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteClientDocument(id: string): Promise<void> {
  const { error } = await supabase
    .from("client_documents")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
