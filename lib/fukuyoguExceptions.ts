// 福祉用具貸与 軽度者 例外給付記録 (B-6d・2026-09-05)
//
// ⚠ migrations/fukuyogu_exception_grants.sql が未適用の間は、テーブルが
//   存在せず PostgREST が 42P01 を返す。呼出側は必ず { error } を見て
//   「テーブル未作成」を握りつぶさずに区別できるようにする。
import { supabase } from "./supabase";

export type FukuyoguExceptionGrant = {
  id: string;
  tenant_id: string;
  client_id: string;
  restriction_group: string;
  judgment_route: "医師意見書" | "サービス担当者会議等" | "その他" | null;
  doctor_opinion_date: string | null;
  meeting_confirmed_date: string | null;
  insurer_confirmed_date: string | null;
  valid_from: string;
  valid_end: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

/** テーブル未作成 (42P01) かどうか。呼出側でエラー種別を分けるために使う */
export function isTableMissingError(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

export async function getExceptionGrants(tenantId: string, clientIds: string[]): Promise<FukuyoguExceptionGrant[]> {
  if (clientIds.length === 0) return [];
  const { data, error } = await supabase
    .from("fukuyogu_exception_grants")
    .select("*")
    .eq("tenant_id", tenantId)
    .in("client_id", clientIds);
  if (error) throw error;
  return (data ?? []) as FukuyoguExceptionGrant[];
}

export async function createExceptionGrant(
  tenantId: string,
  input: Omit<FukuyoguExceptionGrant, "id" | "tenant_id" | "created_at" | "updated_at">,
): Promise<void> {
  const { error } = await supabase.from("fukuyogu_exception_grants").insert({ tenant_id: tenantId, ...input });
  if (error) throw error;
}

export async function updateExceptionGrant(
  id: string,
  patch: Partial<Omit<FukuyoguExceptionGrant, "id" | "tenant_id" | "client_id" | "created_at" | "updated_at">>,
): Promise<void> {
  const { error } = await supabase.from("fukuyogu_exception_grants").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteExceptionGrant(id: string): Promise<void> {
  const { error } = await supabase.from("fukuyogu_exception_grants").delete().eq("id", id);
  if (error) throw error;
}

/** 指定日時点で有効な記録が (client×restriction_group で) あるか */
export function hasActiveGrant(
  grants: FukuyoguExceptionGrant[],
  clientId: string,
  restrictionGroup: string,
  onDate: string,
): boolean {
  return grants.some((g) =>
    g.client_id === clientId &&
    g.restriction_group === restrictionGroup &&
    g.valid_from <= onDate &&
    (g.valid_end == null || g.valid_end >= onDate),
  );
}
