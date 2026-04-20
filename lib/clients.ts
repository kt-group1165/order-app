import { supabase, Client } from "./supabase";

// Supabase のデフォルト 1000件制限を回避するためページング取得
export async function getClients(tenantId: string): Promise<Client[]> {
  const PAGE = 1000;
  const all: Client[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("clients")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("furigana", { ascending: true, nullsFirst: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
