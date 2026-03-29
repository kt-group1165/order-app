import { supabase, CarePlanTemplate } from "./supabase";

export async function getCarePlanTemplates(tenantId: string): Promise<CarePlanTemplate[]> {
  const { data, error } = await supabase
    .from("care_plan_templates")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("category");
  if (error) throw error;
  return data ?? [];
}

export async function upsertCarePlanTemplate(
  tenantId: string,
  category: string,
  goals: string,
  precautions: string
): Promise<CarePlanTemplate> {
  const { data, error } = await supabase
    .from("care_plan_templates")
    .upsert(
      { tenant_id: tenantId, category, goals, precautions, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,category" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteCarePlanTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from("care_plan_templates")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
