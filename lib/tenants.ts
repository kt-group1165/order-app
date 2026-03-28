import { supabase } from "./supabase";

export type Tenant = {
  id: string;
  name: string;
  created_at: string;
};

export async function getTenants(): Promise<Tenant[]> {
  const { data, error } = await supabase
    .from("tenants")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}
