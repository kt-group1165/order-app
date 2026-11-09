// 福祉用具貸与 軽度者 例外給付記録 (B-6d・2026-09-05)
//
// ⚠ migrations/fukuyogu_exception_grants.sql が未適用の間は、テーブルが
//   存在せず PostgREST が 42P01 を返す。呼出側は必ず { error } を見て
//   「テーブル未作成」を握りつぶさずに区別できるようにする。
import { supabase } from "./supabase";
import { selectInChunks } from "./inChunks";
import type { ExceptionInsurerRule } from "./fukuyoguExceptionRules";

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
  // 事業所全員 (1,000 人超) を 1 回の .in() に渡すと 400 になる → 150 人ずつ
  return selectInChunks<FukuyoguExceptionGrant>(clientIds, (chunk) => supabase
    .from("fukuyogu_exception_grants")
    .select("*")
    .eq("tenant_id", tenantId)
    .in("client_id", chunk));
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

// ─── 市町村 (保険者) ごとのルール (2026-11-09) ─────────────────────────────
// ⚠ migrations/fukuyogu_exception_insurer_rules.sql が未適用の間は表が無い。
//   読めないときは rules=[] (= 全市町村「未設定」) で返し、message に理由を入れる。
//   呼出側は message を画面に出し、console.error も出す (silent にしない)。

export type InsurerRulesLoad = { rules: ExceptionInsurerRule[]; available: boolean; message: string | null };

export async function getExceptionInsurerRules(tenantId: string): Promise<InsurerRulesLoad> {
  const { data, error } = await supabase
    .from("fukuyogu_exception_insurer_rules")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("insurer_number")
    .order("id");
  if (error) {
    const missing = isTableMissingError(error);
    const message = missing
      ? "軽度者例外給付の市町村ルール表が未作成です (migrations/fukuyogu_exception_insurer_rules.sql 未適用)。全市町村「ルール未設定」として扱います"
      : `軽度者例外給付の市町村ルールを読めませんでした (${error.message})。全市町村「ルール未設定」として扱います`;
    console.error("例外給付 市町村ルールの取得失敗:", error.code, error.message);
    return { rules: [], available: false, message };
  }
  return { rules: (data ?? []) as ExceptionInsurerRule[], available: true, message: null };
}

export type InsurerRuleInput = Pick<ExceptionInsurerRule, "insurer_number" | "insurer_name" | "requires_period" | "period_months" | "notes">;

export async function createExceptionInsurerRule(tenantId: string, input: InsurerRuleInput): Promise<ExceptionInsurerRule> {
  const { data, error } = await supabase
    .from("fukuyogu_exception_insurer_rules")
    .insert({ tenant_id: tenantId, ...input })
    .select()
    .single();
  if (error) throw error;
  return data as ExceptionInsurerRule;
}

export async function updateExceptionInsurerRule(id: string, patch: InsurerRuleInput): Promise<void> {
  const { error } = await supabase.from("fukuyogu_exception_insurer_rules").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteExceptionInsurerRule(id: string): Promise<void> {
  const { error } = await supabase.from("fukuyogu_exception_insurer_rules").delete().eq("id", id);
  if (error) throw error;
}

/** 保険者番号から保険者名を引く (マスタが無いので認定行に入っている名前を 1 件借りる)。見つからなければ null */
export async function lookupInsurerName(tenantId: string, insurerNumber: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("client_insurance_records")
    .select("insurer_name")
    .eq("tenant_id", tenantId)
    .eq("insurer_number", insurerNumber)
    .not("insurer_name", "is", null)
    .limit(1);
  if (error) {
    console.error("保険者名の取得失敗:", error.message);
    return null;
  }
  return (data?.[0]?.insurer_name as string | undefined) ?? null;
}

/** テナントの例外給付記録を全件 (利用者一覧の印用)。記録は 1 利用者に数件なので全件で足りる */
export async function getAllExceptionGrants(tenantId: string): Promise<FukuyoguExceptionGrant[]> {
  const PAGE = 1000;
  const all: FukuyoguExceptionGrant[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("fukuyogu_exception_grants")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as FukuyoguExceptionGrant[]));
    if (!data || data.length < PAGE) break;
  }
  return all;
}
