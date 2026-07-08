import { supabase } from "./supabase";

// 福祉用具 上限価格・平均価格マスタ (厚労省公表データ)。
// 上限価格は TAIS コードごとに 1 つ決まり、適用月 (effective_from) で世代管理する。

export type EquipmentPriceCeiling = {
  id: string;
  tenant_id: string;
  tais_code: string;
  effective_from: string; // "YYYY-MM-DD" (適用月の初日)
  ceiling_price: number;
  average_price: number | null;
  corp_name: string | null;
  product_name: string | null;
  model_number: string | null;
  publication_label: string | null;
  created_at: string;
  updated_at: string;
};

// 取込 Excel 1 行分 (パース API が返す形)
export type CeilingImportRow = {
  tais_code: string;
  corp_name: string | null;
  product_name: string | null;
  model_number: string | null;
  average_price: number | null;
  ceiling_price: number;
};

export async function getCeilingPrices(tenantId: string): Promise<EquipmentPriceCeiling[]> {
  const all: EquipmentPriceCeiling[] = [];
  const pageSize = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("equipment_price_ceilings")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("effective_from", { ascending: false })
      .order("tais_code", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as EquipmentPriceCeiling[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// 取込データを (tenant, tais, 適用月) キーで upsert。既存の同月同TAISは上書き。
export async function upsertCeilingPrices(
  tenantId: string,
  effectiveFrom: string, // "YYYY-MM-DD"
  publicationLabel: string | null,
  rows: CeilingImportRow[]
): Promise<number> {
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({
    tenant_id: tenantId,
    tais_code: r.tais_code,
    effective_from: effectiveFrom,
    ceiling_price: r.ceiling_price,
    average_price: r.average_price,
    corp_name: r.corp_name,
    product_name: r.product_name,
    model_number: r.model_number,
    publication_label: publicationLabel,
    updated_at: now,
  }));
  let total = 0;
  for (let i = 0; i < payload.length; i += 500) {
    const chunk = payload.slice(i, i + 500);
    const { error } = await supabase
      .from("equipment_price_ceilings")
      .upsert(chunk, { onConflict: "tenant_id,tais_code,effective_from" });
    if (error) throw error;
    total += chunk.length;
  }
  return total;
}

// 指定した適用月の取込分をまるごと削除
export async function deleteCeilingMonth(tenantId: string, effectiveFrom: string): Promise<void> {
  const { error } = await supabase
    .from("equipment_price_ceilings")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("effective_from", effectiveFrom);
  if (error) throw error;
}
