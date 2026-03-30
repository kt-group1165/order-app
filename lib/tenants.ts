import { supabase } from "./supabase";

export type Tenant = {
  id: string;
  name: string;
  business_number: string | null;
  company_name: string | null;
  company_address: string | null;
  company_tel: string | null;
  company_fax: string | null;
  staff_name: string | null;
  legal_name: string | null;
  service_area: string | null;
  business_days: string | null;
  business_hours: string | null;
  staff_manager_full: string | null;
  staff_manager_part: string | null;
  staff_specialist_full: string | null;
  staff_specialist_part: string | null;
  staff_admin_full: string | null;
  staff_admin_part: string | null;
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

export async function getTenantById(id: string): Promise<Tenant | null> {
  const { data } = await supabase
    .from("tenants")
    .select("*")
    .eq("id", id)
    .single();
  return data ?? null;
}

export async function updateTenantInfo(
  id: string,
  info: {
    business_number?: string;
    company_name?: string;
    company_address?: string;
    company_tel?: string;
    company_fax?: string;
    staff_name?: string;
    legal_name?: string;
    service_area?: string;
    business_days?: string;
    business_hours?: string;
    staff_manager_full?: string;
    staff_manager_part?: string;
    staff_specialist_full?: string;
    staff_specialist_part?: string;
    staff_admin_full?: string;
    staff_admin_part?: string;
  }
): Promise<void> {
  const { error } = await supabase
    .from("tenants")
    .update(info)
    .eq("id", id);
  if (error) throw error;
}
