import { supabase, OvertimeRequest } from "./supabase";

// 残業許可申請書 + 承認ワークフロー (残業許可制)。
// RLS: SELECT は本人の申請のみ/事業所管理者は事業所全体、UPDATE は本人(pending中のみ)/事業所管理者で分岐。
// (apps/order-app/supabase/migrations/create_overtime_requests.sql,
//  overtime_requests_read_own_or_admin.sql)

export type NewOvertimeRequest = {
  tenantId: string;
  officeId: string;
  memberId: string;
  memberName: string;
  targetDate: string; // YYYY-MM-DD
  scheduledEndTime: string | null;
  overtimeStartTime: string;
  overtimeEndTime: string;
  plannedMinutes: number;
  workContent: string | null;
  reason: string;
};

export async function getOvertimeRequests(
  tenantId: string,
  officeId: string | null,
): Promise<OvertimeRequest[]> {
  const PAGE = 1000;
  const all: OvertimeRequest[] = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from("overtime_requests")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("target_date", { ascending: false })
      .range(from, from + PAGE - 1);
    if (officeId) q = q.eq("office_id", officeId);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as OvertimeRequest[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

export async function createOvertimeRequest(input: NewOvertimeRequest): Promise<OvertimeRequest> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) throw userError ?? new Error("unauthenticated");

  const { data, error } = await supabase
    .from("overtime_requests")
    .insert({
      tenant_id: input.tenantId,
      office_id: input.officeId,
      member_id: input.memberId,
      member_name: input.memberName,
      submitted_by: userData.user.id,
      target_date: input.targetDate,
      scheduled_end_time: input.scheduledEndTime,
      overtime_start_time: input.overtimeStartTime,
      overtime_end_time: input.overtimeEndTime,
      planned_minutes: input.plannedMinutes,
      work_content: input.workContent,
      reason: input.reason,
    })
    .select()
    .single();
  if (error) throw error;
  return data as OvertimeRequest;
}

/** 本人による取消 (pending のみ。RLS 側でも同条件を強制) */
export async function cancelOvertimeRequest(id: string): Promise<void> {
  const { error } = await supabase
    .from("overtime_requests")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw error;
}

/** 事業所管理者による承認 */
export async function approveOvertimeRequest(id: string): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) throw userError ?? new Error("unauthenticated");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("overtime_requests")
    .update({
      status: "approved",
      approved_by: userData.user.id,
      approved_at: now,
      rejected_reason: null,
      updated_at: now,
    })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw error;
}

/** 事業所管理者による却下 */
export async function rejectOvertimeRequest(id: string, reason: string): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) throw userError ?? new Error("unauthenticated");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("overtime_requests")
    .update({
      status: "rejected",
      approved_by: userData.user.id,
      approved_at: now,
      rejected_reason: reason,
      updated_at: now,
    })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw error;
}

/** 承認済み申請の実績時間 (分) を記録。事業所管理者が終業後に入力する想定 */
export async function recordOvertimeActual(id: string, actualMinutes: number): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) throw userError ?? new Error("unauthenticated");

  const now = new Date().toISOString();
  const { error } = await supabase
    .from("overtime_requests")
    .update({
      actual_minutes: actualMinutes,
      actual_recorded_by: userData.user.id,
      actual_recorded_at: now,
      updated_at: now,
    })
    .eq("id", id)
    .eq("status", "approved");
  if (error) throw error;
}
