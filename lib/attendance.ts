// 出勤簿 data 層
//
// 設計:
//   payroll-app の居宅出勤簿と「同じ table を共有」する。
//   出勤簿は給与計算の一次入力なので、identity は payroll_employees が正。
//   order-app の共通マスタ (members) とは繋がない (= 二重管理を作らない)。
//
//   order-app の currentOfficeId (共通 offices.id)
//     → payroll_offices.office_id で JOIN して payroll office を解決
//     → payroll_employees.office_id = payroll_offices.id で職員を引く
//
//   table 名の kyotaku は居宅由来だが、中身 (出退勤/休憩/法定休日/有給/振替/出張km)
//   に居宅固有要素は無く完全に汎用。居宅専用の月次件数・ケアマネ加算
//   (_monthly / _monthly_kasan) は order-app では一切扱わない。

import { supabase } from "@/lib/supabase";
import { extendedMonthRange, type AttendanceRecord } from "@/lib/attendance/attendance-calc";

// =====================================================================
// 型
// =====================================================================

/** payroll 側の事業所 (共通 offices.id → payroll_offices の解決結果) */
export type AttendanceOffice = {
  id: string;
  office_id: string;
  /** 1週間の起算曜日 (0=日, 1=月, ..., 6=土) */
  work_week_start: number;
  /** 共通マスタの事業所名 */
  name: string;
};

/**
 * 出勤簿の対象となる共通 offices の or-filter。
 * - 福祉用具 (+ service_type 未設定の旧データ) は URL tenant (kt-group) のもの
 * - 本社 (統括営業本部など) は tenant が sales-hq に分かれているため別枠で含める。
 *   ただし fukuyogu-kanri (福祉用具管理者 = 管理用の擬似事業所) は除外するので
 *   tenant を kt-group / sales-hq に限定する
 */
export function attendanceOfficesOrFilter(tenantId: string): string {
  return [
    `and(tenant_id.eq.${tenantId},service_type.eq.福祉用具)`,
    `and(tenant_id.eq.${tenantId},service_type.is.null)`,
    `and(service_type.eq.本社,or(tenant_id.eq.${tenantId},tenant_id.eq.sales-hq))`,
  ].join(",");
}

export type AttendanceEmployee = {
  id: string;
  name: string;
  office_id: string;
};

/** DB row (payroll_kyotaku_attendance_records) */
export type AttendanceDbRow = {
  id?: string;
  tenant_id: string;
  office_id: string;
  employee_id: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  is_legal_holiday: boolean;
  is_paid_leave: boolean;
  paid_leave_type: "full" | "half" | null;
  note: string | null;
  business_km: number | null;
  substitute_for_date: string | null;
};

export type AttendanceFetchResult = {
  /** 当月分の DB row (UI 入力欄に展開する) */
  currentMonthRows: AttendanceDbRow[];
  /** 前後隣接月分。月跨ぎ週の週次残業を正しく按分するための calc 用 (UI 表示しない) */
  neighborRecords: AttendanceRecord[];
  /**
   * neighborRecords と同じ row の生 DB 形式。
   * 稼働開始月 (2026-07) で前月最終週を編集可能な行として出すために使う。
   */
  neighborRows: AttendanceDbRow[];
};

// =====================================================================
// 内部 helper
// =====================================================================

/** DB の TIME ("09:00:00") を UI の "HH:mm" に。null/不正は "" */
export function toUiTime(s: string | null): string {
  if (!s) return "";
  const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) return "";
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}`;
}

/** YYYY-MM の初日 / 末日 */
export function monthBounds(month: string): { start: string; end: string } | null {
  const [yStr, mStr] = month.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(lastDay).padStart(2, "0")}` };
}

function toRecord(r: AttendanceDbRow): AttendanceRecord {
  const paidLeaveType: "full" | "half" | null =
    r.paid_leave_type === "full" || r.paid_leave_type === "half"
      ? r.paid_leave_type
      : r.is_paid_leave
        ? "full"
        : null;
  return {
    work_date: r.work_date,
    start_time: toUiTime(r.start_time) || null,
    end_time: toUiTime(r.end_time) || null,
    break_minutes: r.break_minutes ?? 0,
    is_legal_holiday: !!r.is_legal_holiday,
    paid_leave_type: paidLeaveType,
    substitute_for_date: r.substitute_for_date ?? null,
  };
}

// =====================================================================
// 事業所 / 職員
// =====================================================================

/**
 * 出勤簿で扱える payroll 事業所の一覧 (福祉用具 5 事業所 + 本社/統括営業本部)。
 * 共通マスタ (offices) を service_type で絞り、payroll_offices にリンク済みのものだけ返す。
 * payroll 未取込の事業所は含まれない (= スタッフ管理の事業所タブで取込むと現れる)。
 */
export async function getAttendanceOffices(tenantId: string): Promise<AttendanceOffice[]> {
  const { data: commons, error: cErr } = await supabase
    .from("offices")
    .select("id, name, service_type, is_active")
    .or(attendanceOfficesOrFilter(tenantId));
  if (cErr) throw new Error(`共通マスタの取得に失敗: ${cErr.message}`);
  const active = (commons ?? []).filter(
    (c) => (c as { is_active?: boolean }).is_active !== false,
  ) as { id: string; name: string }[];
  if (active.length === 0) return [];

  const { data, error } = await supabase
    .from("payroll_offices")
    .select("id, office_id, work_week_start")
    .in("office_id", active.map((c) => c.id));
  if (error) throw new Error(`事業所の取得に失敗: ${error.message}`);

  const nameById = new Map(active.map((c) => [c.id, c.name]));
  const rows = ((data ?? []) as { id: string; office_id: string; work_week_start: number | null }[]).map(
    (r) => ({
      id: r.id,
      office_id: r.office_id,
      work_week_start: r.work_week_start ?? 0,
      name: nameById.get(r.office_id) ?? "(名称不明)",
    }),
  );
  rows.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return rows;
}

/** payroll 事業所に所属する在籍職員 (退職者と出勤簿非表示を除く) */
export async function getAttendanceEmployees(payrollOfficeId: string): Promise<AttendanceEmployee[]> {
  // attendance_hidden は後付け列 (migration 未適用でも動くよう select("*") + JS filter)
  const { data, error } = await supabase
    .from("payroll_employees")
    .select("*")
    .eq("office_id", payrollOfficeId)
    .neq("employment_status", "退職者")
    .order("name");
  if (error) throw new Error(`職員の取得に失敗: ${error.message}`);
  return ((data ?? []) as (AttendanceEmployee & { attendance_hidden?: boolean })[])
    .filter((e) => e.attendance_hidden !== true)
    .map((e) => ({ id: e.id, name: e.name, office_id: e.office_id }));
}

// =====================================================================
// 出勤簿 row
// =====================================================================

/**
 * 1 職員 × 1 月の出勤簿を取得。
 * 月跨ぎ週の週次残業 (40h 超) を正しく按分するため、隣接月の row も併せて取る。
 */
export async function getAttendanceRecords(
  employeeId: string,
  month: string,
  weekStart: number,
): Promise<AttendanceFetchResult> {
  const bounds = monthBounds(month);
  if (!bounds) return { currentMonthRows: [], neighborRecords: [], neighborRows: [] };
  const { start: extStart, end: extEnd } = extendedMonthRange(month, weekStart);

  const { data, error } = await supabase
    .from("payroll_kyotaku_attendance_records")
    .select("*")
    .eq("employee_id", employeeId)
    .gte("work_date", extStart || bounds.start)
    .lte("work_date", extEnd || bounds.end);
  if (error) throw new Error(`出勤簿の取得に失敗: ${error.message}`);

  const currentMonthRows: AttendanceDbRow[] = [];
  const neighborRecords: AttendanceRecord[] = [];
  const neighborRows: AttendanceDbRow[] = [];
  for (const r of (data ?? []) as AttendanceDbRow[]) {
    if (r.work_date >= bounds.start && r.work_date <= bounds.end) {
      currentMonthRows.push(r);
    } else {
      neighborRecords.push(toRecord(r));
      neighborRows.push(r);
    }
  }
  return { currentMonthRows, neighborRecords, neighborRows };
}

/** 変更のあった行のみ upsert (UNIQUE: employee_id, work_date) */
export async function upsertAttendanceRecords(rows: AttendanceDbRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase
    .from("payroll_kyotaku_attendance_records")
    .upsert(rows, { onConflict: "employee_id,work_date" });
  if (error) throw new Error(`保存に失敗: ${error.message}`);
}

/** 入力が空になった行を削除 */
export async function deleteAttendanceRecords(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase
    .from("payroll_kyotaku_attendance_records")
    .delete()
    .in("id", ids);
  if (error) throw new Error(`削除に失敗: ${error.message}`);
}

// =====================================================================
// 会社休日
// =====================================================================

/** tenant の会社休日 (お盆・年末年始等)。指定月の前後を含む拡張範囲で取る */
export async function getCompanyHolidays(
  tenantId: string,
  month: string,
  weekStart: number,
): Promise<Set<string>> {
  const bounds = monthBounds(month);
  if (!bounds) return new Set();
  const { start: extStart, end: extEnd } = extendedMonthRange(month, weekStart);
  const { data, error } = await supabase
    .from("payroll_company_holidays")
    .select("holiday_date")
    .eq("tenant_id", tenantId)
    .gte("holiday_date", extStart || bounds.start)
    .lte("holiday_date", extEnd || bounds.end);
  if (error) throw new Error(`会社休日の取得に失敗: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { holiday_date: string }).holiday_date));
}
