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
import { DEFAULT_PHONE_DUTY_PAY } from "@/lib/attendance/allowance";

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
  /** payroll_offices.office_type。'本社' なら電話当番・土日祝対応の入力欄が出る */
  office_type: string;
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
  /** 電話当番の単価 (円/回)。本社の手当計算に使う。列未適用なら既定 3,000 */
  phone_duty_pay: number;
  /** 事務員か。true なら出勤簿に 通勤距離 + 出張距離 の 2 列を出す */
  is_office_worker: boolean;
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
  /** 振替・代休元 1 (order-app 方式: この日の休みの元になった出勤日) */
  substitute_for_date: string | null;
  /** 振替・代休元 2 (列未適用の環境では undefined) */
  substitute_for_date2?: string | null;
  /** 出張距離 (km)。事務員のみ。列未適用の環境では undefined */
  business_trip_km?: number | null;
  /** 電話当番 (本社のみ)。列未適用の環境では undefined */
  phone_duty?: boolean;
  /** 土日祝対応 件数 (本社のみ)。列未適用の環境では undefined */
  holiday_support_count?: number;
};

export type AttendanceFetchResult = {
  /** 当月分の DB row (UI 入力欄に展開する) */
  currentMonthRows: AttendanceDbRow[];
  /** 前後隣接月分。月跨ぎ週の週次残業を正しく按分するための calc 用 (UI 表示しない) */
  neighborRecords: AttendanceRecord[];
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
    // どちらかの元日付があれば代休 (休み扱い)
    substitute_for_date: r.substitute_for_date ?? r.substitute_for_date2 ?? null,
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
    .select("id, office_id, work_week_start, office_type")
    .in("office_id", active.map((c) => c.id));
  if (error) throw new Error(`事業所の取得に失敗: ${error.message}`);

  const nameById = new Map(active.map((c) => [c.id, c.name]));
  const rows = (
    (data ?? []) as {
      id: string;
      office_id: string;
      work_week_start: number | null;
      office_type: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    office_id: r.office_id,
    work_week_start: r.work_week_start ?? 0,
    name: nameById.get(r.office_id) ?? "(名称不明)",
    office_type: r.office_type ?? "",
  }));
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
  return (
    (data ?? []) as (AttendanceEmployee & {
      attendance_hidden?: boolean;
      phone_duty_pay?: number | null;
      is_office_worker?: boolean | null;
    })[]
  )
    .filter((e) => e.attendance_hidden !== true)
    .map((e) => ({
      id: e.id,
      name: e.name,
      office_id: e.office_id,
      phone_duty_pay: e.phone_duty_pay ?? DEFAULT_PHONE_DUTY_PAY,
      is_office_worker: e.is_office_worker === true,
    }));
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
  if (!bounds) return { currentMonthRows: [], neighborRecords: [] };
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
  for (const r of (data ?? []) as AttendanceDbRow[]) {
    if (r.work_date >= bounds.start && r.work_date <= bounds.end) currentMonthRows.push(r);
    else neighborRecords.push(toRecord(r));
  }
  return { currentMonthRows, neighborRecords };
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

// =====================================================================
// 月次ステータス (確定＆提出 / 承認)
// =====================================================================

/** row 無し = 未提出。submitted = 本人提出済 (本人ロック)、approved = 管理者承認済 */
export type MonthStatus = {
  status: "submitted" | "approved";
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
};

/** 1 職員 × 1 月のステータス。未提出 or table 未適用なら null */
export async function getMonthStatus(
  employeeId: string,
  month: string,
): Promise<MonthStatus | null> {
  const { data, error } = await supabase
    .from("attendance_month_status")
    .select("status, submitted_at, approved_at, approved_by")
    .eq("employee_id", employeeId)
    .eq("month_start", `${month}-01`)
    .maybeSingle();
  if (error) {
    // 42P01 = table 未適用 → 未提出として扱う
    if (error.code === "42P01") return null;
    throw new Error(`提出状況の取得に失敗: ${error.message}`);
  }
  return (data as MonthStatus | null) ?? null;
}

/** 提出 (管理者操作) */
export async function submitMonth(
  tenantId: string,
  employeeId: string,
  month: string,
  by: string | null,
): Promise<void> {
  const { error } = await supabase.from("attendance_month_status").upsert(
    {
      tenant_id: tenantId,
      employee_id: employeeId,
      month_start: `${month}-01`,
      status: "submitted",
      submitted_at: new Date().toISOString(),
      submitted_by: by,
      approved_at: null,
      approved_by: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "employee_id,month_start" },
  );
  if (error) throw new Error(missingTableMsg(error, "提出に失敗"));
}

/** 承認 (管理者操作) */
export async function approveMonth(
  tenantId: string,
  employeeId: string,
  month: string,
  by: string | null,
): Promise<void> {
  const { error } = await supabase.from("attendance_month_status").upsert(
    {
      tenant_id: tenantId,
      employee_id: employeeId,
      month_start: `${month}-01`,
      status: "approved",
      approved_at: new Date().toISOString(),
      approved_by: by,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "employee_id,month_start" },
  );
  if (error) throw new Error(missingTableMsg(error, "承認に失敗"));
}

/** 差し戻し (row 削除 = 未提出に戻す) */
export async function reopenMonth(employeeId: string, month: string): Promise<void> {
  const { error } = await supabase
    .from("attendance_month_status")
    .delete()
    .eq("employee_id", employeeId)
    .eq("month_start", `${month}-01`);
  if (error) throw new Error(missingTableMsg(error, "差し戻しに失敗"));
}

function missingTableMsg(error: { code?: string; message: string }, prefix: string): string {
  if (error.code === "42P01") {
    return `${prefix}: 提出状況のテーブルが未適用です (migrations/attendance_month_status.sql を適用してください)`;
  }
  return `${prefix}: ${error.message}`;
}
