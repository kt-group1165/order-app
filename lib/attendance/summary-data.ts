// summary-data.ts
// 残業集計 (職員 × 月) と Excel 反映のプレビューで使う 読み込み。
// 1 職員 1 か月ずつ読む lib/attendance.ts と違い、複数職員 × 複数か月をまとめて読む。

import { supabase } from "@/lib/supabase";
import { selectInChunks } from "@/lib/inChunks";
import type { AttendanceDbRow } from "@/lib/attendance";

const PAGE = 1000;

/**
 * 職員 (複数) × 期間 の出勤簿行。
 * 職員 id は 150 件ずつ (lib/inChunks)、各回は 1000 行ずつページング。
 * 並び順に id を足す (一意でない列だけで並べるとページの境目で行が抜ける)。
 */
export async function fetchAttendanceRowsRange(
  employeeIds: string[],
  start: string,
  end: string,
): Promise<AttendanceDbRow[]> {
  if (employeeIds.length === 0 || start > end) return [];
  return selectInChunks<AttendanceDbRow>(employeeIds, async (chunk) => {
    const out: AttendanceDbRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("payroll_kyotaku_attendance_records")
        .select("*")
        .in("employee_id", chunk)
        .gte("work_date", start)
        .lte("work_date", end)
        .order("work_date")
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) return { data: null, error };
      const rows = (data ?? []) as AttendanceDbRow[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return { data: out, error: null };
  });
}

/** tenant の会社休日 (お盆・年末年始等) を期間で */
export async function fetchCompanyHolidaysRange(
  tenantId: string,
  start: string,
  end: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("payroll_company_holidays")
    .select("holiday_date")
    .eq("tenant_id", tenantId)
    .gte("holiday_date", start)
    .lte("holiday_date", end)
    .order("holiday_date");
  if (error) throw new Error(`会社休日の取得に失敗: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { holiday_date: string }).holiday_date));
}

/** 職員 × 月 の提出・承認状況。キーは `${employee_id}|YYYY-MM`。表が未適用 (42P01) なら空 */
export async function fetchMonthStatuses(
  employeeIds: string[],
  months: string[],
): Promise<Map<string, "submitted" | "approved">> {
  const out = new Map<string, "submitted" | "approved">();
  if (employeeIds.length === 0 || months.length === 0) return out;
  const monthStarts = [...new Set(months)].map((m) => `${m}-01`);
  try {
    const rows = await selectInChunks<{ employee_id: string; month_start: string; status: string }>(
      employeeIds,
      (chunk) =>
        supabase
          .from("attendance_month_status")
          .select("employee_id, month_start, status")
          .in("employee_id", chunk)
          .in("month_start", monthStarts),
    );
    for (const r of rows) {
      if (r.status === "submitted" || r.status === "approved") {
        out.set(`${r.employee_id}|${r.month_start.slice(0, 7)}`, r.status);
      }
    }
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return out;
    throw new Error(`提出状況の取得に失敗: ${(e as { message?: string }).message ?? String(e)}`);
  }
  return out;
}
