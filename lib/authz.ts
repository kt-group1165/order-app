// lib/authz.ts
//
// service_role (createAdminClient) を使う API route 用の認可ヘルパ。
//
// 2026-08-31 監査での是正:
//   attendance-url / attendance-pdf / orders(merge,unmerge) は
//   「ログインしているか」しか見ておらず、URL やボディで渡された
//   payroll_office_id / employee_id / order_id をそのまま service_role に
//   流していた。service_role は RLS を貫通するので、
//   任意のログインユーザが他事業所の職員 1,288 名分の出勤簿トークンを発行したり、
//   他事業所の受注を統合・削除できた。
//
//   認証 (getUser) の後に、**必ず**このヘルパで「その資源が呼出ユーザの
//   スコープに入っているか」を確かめてから admin client を使うこと。
//
// スコープの出どころ (どちらも SECURITY DEFINER / 引数なし / auth.uid() 由来):
//   auth_visible_tenant_ids()          … migrations/phase2_05_02_helper_functions.sql
//   auth_visible_payroll_office_ids()  … migrations/tier5_payroll/008_scoped_policies.sql
//     = payroll_offices.id の集合 (payroll_employees.office_id が指す先)

import { createClient } from "@/lib/supabase/server";

type Rpc = Awaited<ReturnType<typeof createClient>>;

/** rpc の戻りが string[] でも [{col: string}] でも拾えるように正規化する */
function flatten(rows: unknown, column: string): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => {
      if (typeof r === "string") return r;
      if (r && typeof r === "object") {
        const v = (r as Record<string, unknown>)[column];
        if (typeof v === "string") return v;
      }
      return "";
    })
    .filter((s) => s.length > 0);
}

/** 呼出ユーザに見える payroll_offices.id。取得失敗時は null (= 判定不能なので拒否側に倒す) */
export async function getVisiblePayrollOfficeIds(supabase: Rpc): Promise<string[] | null> {
  const { data, error } = await supabase.rpc("auth_visible_payroll_office_ids");
  if (error) {
    console.error("auth_visible_payroll_office_ids failed:", error.message);
    return null;
  }
  return flatten(data, "auth_visible_payroll_office_ids");
}

/** 呼出ユーザに見える tenant_id。取得失敗時は null */
export async function getVisibleTenantIds(supabase: Rpc): Promise<string[] | null> {
  const { data, error } = await supabase.rpc("auth_visible_tenant_ids");
  if (error) {
    console.error("auth_visible_tenant_ids failed:", error.message);
    return null;
  }
  return flatten(data, "auth_visible_tenant_ids");
}
