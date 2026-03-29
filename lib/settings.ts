import { supabase } from "./supabase";

export async function verifyPin(pin: string, tenantId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "master_pin")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data) return false;
  return data.value === pin;
}
