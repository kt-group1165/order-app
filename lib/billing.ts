import { supabase } from "./supabase";

export type BillingLateFlag = {
  id: string;
  tenant_id: string;
  client_id: string;
  month: string;
  created_at: string;
};

export type BillingUnitOverride = {
  id: string;
  tenant_id: string;
  client_id: string;
  month: string;
  order_item_id: string;
  units_override: number;
  created_at: string;
  updated_at: string;
};

export type BillingRebillFlag = {
  id: string;
  tenant_id: string;
  client_id: string;
  month: string;
  flag_type: "返戻" | "取り下げ";
  created_at: string;
};

// ── 月遅れフラグ ────────────────────────────────────────────────────────────

export async function getLateFlags(tenantId: string, month: string): Promise<BillingLateFlag[]> {
  const { data, error } = await supabase
    .from("billing_late_flags")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("month", month);
  if (error) throw error;
  return data ?? [];
}

export async function setLateFlag(tenantId: string, clientId: string, month: string): Promise<void> {
  const { error } = await supabase
    .from("billing_late_flags")
    .upsert({ tenant_id: tenantId, client_id: clientId, month }, { onConflict: "tenant_id,client_id,month" });
  if (error) throw error;
}

export async function removeLateFlag(tenantId: string, clientId: string, month: string): Promise<void> {
  const { error } = await supabase
    .from("billing_late_flags")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .eq("month", month);
  if (error) throw error;
}

// ── 単位数上書き ─────────────────────────────────────────────────────────────

export async function getUnitOverrides(tenantId: string, month: string): Promise<BillingUnitOverride[]> {
  const { data, error } = await supabase
    .from("billing_unit_overrides")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("month", month);
  if (error) throw error;
  return data ?? [];
}

export async function setUnitOverride(
  tenantId: string,
  clientId: string,
  month: string,
  orderItemId: string,
  unitsOverride: number
): Promise<void> {
  const { error } = await supabase
    .from("billing_unit_overrides")
    .upsert(
      {
        tenant_id: tenantId,
        client_id: clientId,
        month,
        order_item_id: orderItemId,
        units_override: unitsOverride,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,client_id,month,order_item_id" }
    );
  if (error) throw error;
}

export async function removeUnitOverride(
  tenantId: string,
  clientId: string,
  month: string,
  orderItemId: string
): Promise<void> {
  const { error } = await supabase
    .from("billing_unit_overrides")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .eq("month", month)
    .eq("order_item_id", orderItemId);
  if (error) throw error;
}

// ── 返戻・取り下げフラグ ──────────────────────────────────────────────────────

export async function getRebillFlags(tenantId: string): Promise<BillingRebillFlag[]> {
  const { data, error } = await supabase
    .from("billing_rebill_flags")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("month", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function setRebillFlag(
  tenantId: string,
  clientId: string,
  month: string,
  flagType: "返戻" | "取り下げ"
): Promise<void> {
  const { error } = await supabase
    .from("billing_rebill_flags")
    .upsert(
      { tenant_id: tenantId, client_id: clientId, month, flag_type: flagType },
      { onConflict: "tenant_id,client_id,month" }
    );
  if (error) throw error;
}

export async function removeRebillFlag(tenantId: string, clientId: string, month: string): Promise<void> {
  const { error } = await supabase
    .from("billing_rebill_flags")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .eq("month", month);
  if (error) throw error;
}
