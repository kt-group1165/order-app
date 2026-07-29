"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Loader2, Save, AlertTriangle, Download, Upload, Printer, Link2, Copy, Check, X, Users } from "lucide-react";
import {
  getAttendanceOffices,
  getAttendanceEmployees,
  getAttendanceRecords,
  upsertAttendanceRecords,
  deleteAttendanceRecords,
  getCompanyHolidays,
  toUiTime,
  type AttendanceOffice,
  type AttendanceEmployee,
  type AttendanceDbRow,
} from "@/lib/attendance";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  extendedMonthRange,
  formatHM,
  minutesBetween,
  type AttendanceRecord,
} from "@/lib/attendance/attendance-calc";
import { isJapaneseHoliday, getJapaneseHolidayName } from "@/lib/attendance/japan-holidays";
import {
  exportAttendanceCsv,
  parseAttendanceCsv,
  type AttendanceCsvRow,
} from "@/lib/attendance/attendance-csv";
import AttendanceAdminModal from "./AttendanceAdminModal";

// 月間の時間外 上限 (自社基準)。36協定の法定上限 45h より手前に置いた運用ライン。
// 「通常残業を何時間できるか」を基準にした枠。
const MONTHLY_OVERTIME_LIMIT_HOURS = 35;
const MONTHLY_OVERTIME_LIMIT_MIN = MONTHLY_OVERTIME_LIMIT_HOURS * 60;

// 割増率 (労基法 §37)。法定休日労働・深夜も枠を消費するが、割増率が違うぶん
// 通常残業に換算してから引く。
//   換算係数 = その労働の割増率 ÷ 通常残業の割増率
//   例) 法定休日 8h → 8h × (1.35 / 1.25) = 8:38 を消費
//       深夜 4h    → 4h × (0.25 / 1.25) = 0:48 を消費 (深夜は上乗せぶんのみ)
// このため「消費した実時間 + 残り」は 35:00 にはならない。残りは常に
// 「あと通常残業を何時間できるか」を指す。
const RATE_OVERTIME = 1.25;
const RATE_HOLIDAY = 1.35;
const RATE_MIDNIGHT_EXTRA = 0.25;

/** 法定休日労働の分数を、通常残業の分数に換算 */
function holidayToOvertimeEquiv(min: number): number {
  return Math.round(min * (RATE_HOLIDAY / RATE_OVERTIME));
}

/** 深夜労働の分数を、上乗せぶんだけ通常残業の分数に換算 */
function midnightToOvertimeEquiv(min: number): number {
  return Math.round(min * (RATE_MIDNIGHT_EXTRA / RATE_OVERTIME));
}

const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// 出勤簿の稼働開始月。これより前の月へは移動できない。
// 開始月に限り、前月 (2026-06) 最終週のうち開始月の初週に属する日を
// 「編集可能な行」としてグリッド先頭に出す (週 40h 残業の計算材料。月合計には含めない)。
const FIRST_MONTH = "2026-07";

/**
 * 開始月の初週に属する前月側の日付 (YYYY-MM-DD) を返す。
 * 開始月以外は空。週起算 (weekStart) により 0〜6 日になる。
 */
function prevMonthTailDates(month: string, weekStart: number): string[] {
  if (month !== FIRST_MONTH) return [];
  const { start } = extendedMonthRange(month, weekStart);
  const monthStart = `${month}-01`;
  if (!start || start >= monthStart) return [];
  const out: string[] = [];
  const [y, m, d] = start.split("-").map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 7; i++) {
    const s = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}-${String(cur.getUTCDate()).padStart(2, "0")}`;
    if (s >= monthStart) break;
    out.push(s);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// 拘束 6 時間以上の日に自動で入れる休憩 (労基法 §34 は 6h 超で 45 分・8h 超で 60 分だが、
// 運用上は 6 時間以上なら一律 60 分を既定値にする)。手入力済みの行は上書きしない。
const DEFAULT_BREAK_THRESHOLD_MIN = 6 * 60;
const DEFAULT_BREAK_MINUTES = 60;

// 法定休日 = 日曜で固定 (KT Group の運用。実際に休むことが最も多い曜日)。
// 手動チェックは持たず自動判定する。週の起算曜日 (work_week_start) とは独立。
// 振替出勤の日曜 (振替元日付あり) は休日を別日に移しているため通常労働日扱い。
const LEGAL_HOLIDAY_DOW = 0; // 0 = 日曜
function isLegalHolidayRow(r: { dow: number; substitute_for_date: string }): boolean {
  return r.dow === LEGAL_HOLIDAY_DOW && !r.substitute_for_date;
}

// =====================================================================
// 型
// =====================================================================

/** UI 上の 1 行 state (時刻は "HH:mm" で保持) */
type RowState = {
  work_date: string;
  dow: number;
  start_time: string;
  end_time: string;
  break_minutes: number;
  paid_leave_type: "full" | "half" | null;
  business_km: string;
  substitute_for_date: string;
  note: string;
  dirty: boolean;
  existing_id: string | null;
};

// =====================================================================
// 補助関数
// =====================================================================

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(ym: string, delta: number): string {
  const [yStr, mStr] = ym.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 月の全日を YYYY-MM-DD で列挙 */
function daysOfMonth(ym: string): string[] {
  const [yStr, mStr] = ym.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return [];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return Array.from({ length: last }, (_, i) => `${y}-${mm}-${String(i + 1).padStart(2, "0")}`);
}

function dowOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function emptyRow(work_date: string): RowState {
  return {
    work_date,
    dow: dowOf(work_date),
    start_time: "",
    end_time: "",
    break_minutes: 0,
    paid_leave_type: null,
    business_km: "",
    substitute_for_date: "",
    note: "",
    dirty: false,
    existing_id: null,
  };
}

/** 実質的に何も入力されていない行か (= 保存対象から外して既存行は削除する) */
function isBlank(r: RowState): boolean {
  return (
    !r.start_time &&
    !r.end_time &&
    r.break_minutes === 0 &&
    r.paid_leave_type === null &&
    !r.business_km.trim() &&
    !r.substitute_for_date &&
    !r.note.trim()
  );
}

function toAttendanceRecord(r: RowState): AttendanceRecord {
  return {
    work_date: r.work_date,
    start_time: r.start_time || null,
    end_time: r.end_time || null,
    break_minutes: r.break_minutes,
    is_legal_holiday: isLegalHolidayRow(r),
    paid_leave_type: r.paid_leave_type,
    substitute_for_date: r.substitute_for_date || null,
  };
}

// =====================================================================
// 本体
// =====================================================================

export default function AttendanceTab({
  tenantId,
  currentOfficeId,
}: {
  tenantId: string;
  /** app 全体で選択中の共通 office id。出勤簿タブ内 dropdown の初期選択にだけ使う */
  currentOfficeId: string | null;
}) {
  const [month, setMonth] = useState<string>(() => {
    const m = currentMonth();
    return m < FIRST_MONTH ? FIRST_MONTH : m;
  });
  // 出勤簿は app 全体の事業所切替 (福祉用具のみ) と独立に、
  // 福祉用具 + 本社 (統括営業本部) をタブ内 dropdown で切り替える
  const [officeList, setOfficeList] = useState<AttendanceOffice[]>([]);
  const [payrollOfficeId, setPayrollOfficeId] = useState<string>("");
  const [officeMissing, setOfficeMissing] = useState(false);
  const [employees, setEmployees] = useState<AttendanceEmployee[]>([]);
  const [employeeId, setEmployeeId] = useState<string>("");
  const [rows, setRows] = useState<RowState[]>([]);
  const [neighbors, setNeighbors] = useState<AttendanceRecord[]>([]);
  const [companyHolidays, setCompanyHolidays] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [isMaster, setIsMaster] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  // 管理モーダルを閉じた時に事業所・職員一覧を再読込するためのカウンタ
  const [adminRefresh, setAdminRefresh] = useState(0);

  const office = officeList.find((o) => o.id === payrollOfficeId) ?? null;
  const weekStart = office?.work_week_start ?? 0;
  const employeeName = employees.find((e) => e.id === employeeId)?.name ?? "";

  // ─── 事業所一覧 (福祉用具 + 本社) ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getAttendanceOffices(tenantId);
        if (cancelled) return;
        setOfficeList(list);
        setOfficeMissing(list.length === 0);
        setPayrollOfficeId((prev) => {
          if (list.some((o) => o.id === prev)) return prev;
          // 初期選択は app 側で選択中の事業所に合わせ、無ければ先頭
          const match = currentOfficeId ? list.find((o) => o.office_id === currentOfficeId) : null;
          return match?.id ?? list[0]?.id ?? "";
        });
      } catch (e) {
        if (!cancelled) alert(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, currentOfficeId, adminRefresh]);

  // ─── 職員一覧 (選択事業所) ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!payrollOfficeId) {
        setEmployees([]);
        setEmployeeId("");
        return;
      }
      try {
        const emps = await getAttendanceEmployees(payrollOfficeId);
        if (cancelled) return;
        setEmployees(emps);
        setEmployeeId((prev) => (emps.some((e) => e.id === prev) ? prev : (emps[0]?.id ?? "")));
      } catch (e) {
        if (!cancelled) alert(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [payrollOfficeId, adminRefresh]);

  // ─── master user 判定 (スタッフ管理ボタンの表示可否) ────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/master-check");
        const json = await res.json();
        if (!cancelled) setIsMaster(json.is_master === true);
      } catch {
        // 判定失敗時はボタン非表示のまま (機能自体は payroll-app 側でも操作可能)
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── 出勤簿 row 読込 ────────────────────────────────────────────────
  // 開始月 (FIRST_MONTH) では前月最終週の日も編集可能な行として先頭に足す。
  // 保存先は同じ table (work_date が前月なだけ) なので、既存の extended fetch で
  // 拾われ、週 40h 計算に自動で乗る。月合計は calcMonthlySummary の monthFilter で
  // 当月分しか積まれないため汚染しない。
  const load = useCallback(async () => {
    const days = daysOfMonth(month);
    const prevDays = prevMonthTailDates(month, weekStart);
    const allDays = [...prevDays, ...days];
    if (!employeeId) {
      setRows(allDays.map(emptyRow));
      setNeighbors([]);
      return;
    }
    setLoading(true);
    try {
      const [res, holidays] = await Promise.all([
        getAttendanceRecords(employeeId, month, weekStart),
        getCompanyHolidays(tenantId, month, weekStart),
      ]);
      const prevSet = new Set(prevDays);
      const byDate = new Map(
        [...res.currentMonthRows, ...res.neighborRows.filter((r) => prevSet.has(r.work_date))].map(
          (r) => [r.work_date, r],
        ),
      );
      setRows(
        allDays.map((d) => {
          const db = byDate.get(d);
          if (!db) return emptyRow(d);
          return {
            work_date: d,
            dow: dowOf(d),
            start_time: toUiTime(db.start_time),
            end_time: toUiTime(db.end_time),
            break_minutes: db.break_minutes ?? 0,
            paid_leave_type:
              db.paid_leave_type === "full" || db.paid_leave_type === "half"
                ? db.paid_leave_type
                : db.is_paid_leave
                  ? "full"
                  : null,
            business_km: db.business_km === null || db.business_km === undefined ? "" : String(db.business_km),
            substitute_for_date: db.substitute_for_date ?? "",
            note: db.note ?? "",
            dirty: false,
            existing_id: db.id ?? null,
          };
        }),
      );
      // 前月最終週は編集行に昇格させたので、calc 用 neighbor からは除外 (二重計上防止)
      setNeighbors(res.neighborRecords.filter((n) => !prevSet.has(n.work_date)));
      setCompanyHolidays(holidays);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      setRows(allDays.map(emptyRow));
      setNeighbors([]);
    } finally {
      setLoading(false);
    }
  }, [employeeId, month, weekStart, tenantId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount / 選択変更時の async fetch
    load();
  }, [load]);

  // ─── 計算 ───────────────────────────────────────────────────────────
  // 当月全日 + 隣接月 record を渡し、月跨ぎ週の 40h 判定を正しく行う。
  // 返り値は元順なので、先頭 rows.length 件が当月各日に対応する。
  const dailies = useMemo(() => {
    const all = [...rows.map(toAttendanceRecord), ...neighbors];
    return calcDailyListWithWeekly(all, weekStart, companyHolidays);
  }, [rows, neighbors, weekStart, companyHolidays]);

  const summary = useMemo(() => {
    const all = [...rows.map(toAttendanceRecord), ...neighbors];
    return calcMonthlySummary(all, weekStart, month, companyHolidays);
  }, [rows, neighbors, weekStart, month, companyHolidays]);

  /** 通常残業 (1日8h超 + 週40h超) の実時間 */
  const overtimeTotal = summary.total_daily_overtime + summary.total_weekly_overtime;
  /** 法定休日労働・深夜を通常残業に換算した消費分 */
  const holidayEquiv = holidayToOvertimeEquiv(summary.total_holiday);
  const midnightEquiv = midnightToOvertimeEquiv(summary.total_midnight);
  /** 35h 枠の消費合計 (通常残業換算) */
  const consumed = overtimeTotal + holidayEquiv + midnightEquiv;
  /** あと何時間 通常残業できるか */
  const remaining = MONTHLY_OVERTIME_LIMIT_MIN - consumed;
  const overLimit = remaining < 0;
  const ratio = Math.min(1, consumed / MONTHLY_OVERTIME_LIMIT_MIN);
  const nearLimit = !overLimit && ratio >= 0.8;
  const hasEquiv = holidayEquiv > 0 || midnightEquiv > 0;

  const dirtyCount = rows.filter((r) => r.dirty).length;

  // ─── 編集 ───────────────────────────────────────────────────────────
  const patchRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const next = { ...r, ...patch, dirty: true };
        // 出退勤を入れて拘束 6 時間以上になったら、休憩が未入力の行に既定の 60 分を入れる。
        // 既に休憩が入っている行は上書きしない (0 に戻したい運用もあるため、明示入力を尊重)。
        const timeChanged = "start_time" in patch || "end_time" in patch;
        if (timeChanged && next.start_time && next.end_time && next.break_minutes === 0) {
          if (minutesBetween(next.start_time, next.end_time) >= DEFAULT_BREAK_THRESHOLD_MIN) {
            next.break_minutes = DEFAULT_BREAK_MINUTES;
          }
        }
        return next;
      }),
    );
  };

  // ─── 保存 ───────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!office || !employeeId) return;
    const dirty = rows.filter((r) => r.dirty);
    if (dirty.length === 0) return;

    const toUpsert: AttendanceDbRow[] = [];
    const toDelete: string[] = [];
    for (const r of dirty) {
      if (isBlank(r)) {
        if (r.existing_id) toDelete.push(r.existing_id);
        continue;
      }
      const km = r.business_km.trim();
      const kmNum = km === "" ? null : Number(km);
      if (kmNum !== null && !Number.isFinite(kmNum)) {
        alert(`${r.work_date} の出張距離が数値ではありません`);
        return;
      }
      toUpsert.push({
        tenant_id: tenantId,
        office_id: office.id,
        employee_id: employeeId,
        work_date: r.work_date,
        start_time: r.start_time ? `${r.start_time}:00` : null,
        end_time: r.end_time ? `${r.end_time}:00` : null,
        break_minutes: r.break_minutes ?? 0,
        // 法定休日 = 日曜固定の自動判定 (振替出勤の日曜は通常労働日)
        is_legal_holiday: isLegalHolidayRow(r),
        // legacy 列。paid_leave_type IS NOT NULL と同義になるよう同期して書く
        is_paid_leave: r.paid_leave_type !== null,
        paid_leave_type: r.paid_leave_type,
        note: r.note.trim() || null,
        business_km: kmNum,
        substitute_for_date: r.substitute_for_date || null,
      });
    }

    setSaving(true);
    try {
      await upsertAttendanceRecords(toUpsert);
      await deleteAttendanceRecords(toDelete);
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ─── CSV 出力 ───────────────────────────────────────────────────────
  const handleExportCsv = () => {
    try {
      exportAttendanceCsv({
        // 前月最終週の行 (開始月のみ存在) は当月の CSV に含めない
        rows: rows.filter((r) => r.work_date.startsWith(month)).map((r) => ({
          work_date: r.work_date,
          start_time: r.start_time,
          end_time: r.end_time,
          break_minutes: r.break_minutes,
          is_legal_holiday: isLegalHolidayRow(r),
          paid_leave_type: r.paid_leave_type,
          note: r.note,
          business_km: r.business_km,
        })),
        staffName: employeeName,
        month,
      });
    } catch (e) {
      alert(`CSV 出力に失敗: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ─── CSV 取込 ───────────────────────────────────────────────────────
  const handleCsvFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 同じ file を続けて選べるよう input は即座にリセット
    if (csvInputRef.current) csvInputRef.current.value = "";
    if (!file) return;

    const result = await parseAttendanceCsv(file, month);
    if (!result.success) {
      const head = result.errors.slice(0, 5).join("\n");
      const rest = result.errors.length > 5 ? `\n… 他 ${result.errors.length - 5} 件` : "";
      alert(`CSV 取込に失敗しました\n\n${head || "データがありません"}${rest}`);
      return;
    }
    if (result.detectedMonth && result.detectedMonth !== month) {
      alert(`CSV の月 (${result.detectedMonth}) が表示中の月 (${month}) と一致しません`);
      return;
    }

    const byDate = new Map<string, AttendanceCsvRow>(result.rows.map((r) => [r.work_date, r]));
    let applied = 0;
    setRows((prev) =>
      prev.map((r) => {
        const c = byDate.get(r.work_date);
        if (!c) return r;
        applied++;
        return {
          ...r,
          start_time: c.start_time,
          end_time: c.end_time,
          break_minutes: c.break_minutes,
          // 法定休日は日曜固定の自動判定なので CSV の値は取り込まない
          paid_leave_type: c.paid_leave_type,
          business_km: c.business_km,
          note: c.note,
          dirty: true,
        };
      }),
    );
    // 取込は入力欄への反映まで。DB へは「保存」を押した時点で書く。
    alert(`${applied} 日分を取込みました。内容を確認して「保存」を押してください。`);
  };

  // ─── 印刷 ───────────────────────────────────────────────────────────
  const handlePrint = () => {
    if (!employeeId) {
      alert("職員を選択してください");
      return;
    }
    window.print();
  };

  // ─── 自己入力 URL 管理 ─────────────────────────────────────────────
  const [showUrlModal, setShowUrlModal] = useState(false);

  // ─── 表示 ───────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* ヘッダー */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0 flex-wrap">
        <CalendarClock size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-700">出勤簿</h2>

        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => setMonth((m) => (shiftMonth(m, -1) < FIRST_MONTH ? m : shiftMonth(m, -1)))}
            disabled={month <= FIRST_MONTH}
            className="p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30"
            title={month <= FIRST_MONTH ? `${FIRST_MONTH} より前はありません` : "前月"}
          >
            <ChevronLeft size={16} />
          </button>
          <input
            type="month"
            value={month}
            min={FIRST_MONTH}
            onChange={(e) => setMonth(e.target.value < FIRST_MONTH ? FIRST_MONTH : e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          />
          <button onClick={() => setMonth((m) => shiftMonth(m, 1))} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="次月">
            <ChevronRight size={16} />
          </button>
        </div>

        <select
          value={payrollOfficeId}
          onChange={(e) => setPayrollOfficeId(e.target.value)}
          disabled={officeList.length === 0}
          className="text-xs border border-gray-300 rounded px-2 py-1 max-w-[14rem] disabled:bg-gray-50"
          title="出勤簿の対象事業所 (福祉用具 + 本社)"
        >
          {officeList.length === 0 && <option value="">事業所なし</option>}
          {officeList.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>

        <select
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          disabled={employees.length === 0}
          className="text-xs border border-gray-300 rounded px-2 py-1 max-w-[12rem] disabled:bg-gray-50"
        >
          {employees.length === 0 && <option value="">職員なし</option>}
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={handleExportCsv}
            disabled={!employeeId}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-40"
            title="表示中の出勤簿を CSV (Shift-JIS) でダウンロード"
          >
            <Download size={14} />
            CSV 出力
          </button>
          <button
            onClick={() => csvInputRef.current?.click()}
            disabled={!employeeId}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-40"
            title="編集済 CSV (Shift-JIS) を取込んで入力欄に反映"
          >
            <Upload size={14} />
            CSV 取込
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleCsvFile}
          />
          <button
            onClick={handlePrint}
            disabled={!employeeId}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-40"
            title="出勤簿を A4 横で印刷"
          >
            <Printer size={14} />
            印刷
          </button>
          <button
            onClick={() => setShowUrlModal(true)}
            disabled={!office}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-40"
            title="スタッフ本人が自分の出勤簿を入力するための個人 URL を発行・管理"
          >
            <Link2 size={14} />
            URL 管理
          </button>
          {isMaster && (
            <button
              onClick={() => setShowAdminModal(true)}
              className="text-xs px-2.5 py-1.5 rounded border border-indigo-300 text-indigo-600 hover:bg-indigo-50 inline-flex items-center gap-1"
              title="事業所とスタッフの管理 (master user 専用)"
            >
              <Users size={14} />
              スタッフ管理
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saving || dirtyCount === 0 || !employeeId}
            className="text-xs px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            保存{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
          </button>
        </div>
      </div>

      {/* 残業サマリー */}
      <div
        className={`px-3 py-2 border-b shrink-0 ${
          overLimit ? "bg-red-50 border-red-200" : nearLimit ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-100"
        }`}
      >
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] text-gray-500">{overLimit ? "超過" : "あと残業できる時間"}</span>
            <span className={`text-2xl font-bold tabular-nums ${overLimit ? "text-red-600" : nearLimit ? "text-amber-600" : "text-emerald-600"}`}>
              {formatHM(Math.abs(remaining))}
            </span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] text-gray-500">消費</span>
            <span className={`text-xl font-bold tabular-nums ${overLimit ? "text-red-600" : "text-gray-800"}`}>
              {formatHM(consumed)}
            </span>
            <span className="text-[11px] text-gray-400">/ {MONTHLY_OVERTIME_LIMIT_HOURS}:00</span>
          </div>

          {overLimit && (
            <span className="inline-flex items-center gap-1 text-[11px] text-red-600 font-medium">
              <AlertTriangle size={13} />
              月 {MONTHLY_OVERTIME_LIMIT_HOURS} 時間を超えています
            </span>
          )}
          {nearLimit && (
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-600 font-medium">
              <AlertTriangle size={13} />
              上限に近づいています
            </span>
          )}

          <div className="ml-auto flex items-center gap-3 text-[11px] text-gray-500 tabular-nums">
            <span>実労働 {formatHM(summary.total_work)}</span>
            <span>有給 {summary.total_paid_leave_days} 日</span>
            {summary.total_absence > 0 && <span className="text-red-500">欠勤 {formatHM(summary.total_absence)}</span>}
          </div>
        </div>

        {/* 消費の内訳 (実時間 → 通常残業への換算後) */}
        <div className="mt-1 flex items-center gap-3 text-[11px] text-gray-500 tabular-nums flex-wrap">
          <span className="text-gray-400">内訳</span>
          <span>
            通常残業 <span className="text-gray-700 font-medium">{formatHM(overtimeTotal)}</span>
          </span>
          <span className={summary.total_holiday > 0 ? "" : "text-gray-300"}>
            法定休日 {formatHM(summary.total_holiday)}
            {summary.total_holiday > 0 && (
              <span className="text-gray-700 font-medium"> → {formatHM(holidayEquiv)}</span>
            )}
          </span>
          <span
            className={summary.total_midnight > 0 ? "" : "text-gray-300"}
            title="深夜の時間帯そのものは通常残業側で消費済み。深夜手当 (+0.25) の上乗せぶんだけを追加で消費します"
          >
            深夜上乗せ {formatHM(summary.total_midnight)}分
            {summary.total_midnight > 0 && (
              <span className="text-gray-700 font-medium"> → +{formatHM(midnightEquiv)}</span>
            )}
          </span>
        </div>

        {/* 進捗バー */}
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${overLimit ? "bg-red-500" : nearLimit ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <p className="mt-1 text-[10px] text-gray-400">
          通常残業 = 1日8時間超 + 週40時間超。法定休日 (×1.35) と深夜 (+0.25) は割増率の比で通常残業 (×1.25) に換算して枠を消費します。
          {hasEquiv && "このため実時間の合計と残り時間を足しても 35:00 にはなりません。残りは「あと通常残業できる時間」です。"}
        </p>
      </div>

      {/* 明細 */}
      {officeMissing ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-gray-400">
          出勤簿を使える事業所がまだありません。<br />
          「スタッフ管理」→ 事業所タブで共通マスタから取込んでください。
        </div>
      ) : loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
      ) : (
        <div className="flex-1 overflow-auto p-3">
          <table className="w-full min-w-[1080px] text-sm bg-white">
            <thead className="bg-gray-50 text-xs text-gray-600 sticky top-0 z-10">
              <tr>
                <th className="text-left px-2 py-2 w-24">日付</th>
                <th className="text-left px-2 py-2 w-24">出勤</th>
                <th className="text-left px-2 py-2 w-24">退勤</th>
                <th className="text-left px-2 py-2 w-20">休憩(分)</th>
                <th className="text-left px-2 py-2 w-20">有給</th>
                <th className="text-left px-2 py-2 w-20">出張km</th>
                <th className="text-left px-2 py-2 w-32">振替元</th>
                <th className="text-left px-2 py-2">備考</th>
                <th className="text-right px-2 py-2 w-20">実労働</th>
                <th className="text-right px-2 py-2 w-20">時間外</th>
                <th className="text-right px-2 py-2 w-20">深夜</th>
              </tr>
            </thead>
            <tbody>
              {rows.some((r) => !r.work_date.startsWith(month)) && (
                <tr className="bg-sky-50 border-b border-sky-100">
                  <td colSpan={11} className="px-2 py-1 text-[11px] text-sky-700">
                    前月 ({parseInt(rows[0].work_date.slice(5, 7), 10)}月) 最終週 —
                    週40時間の残業計算にのみ使います。月合計・印刷・CSV には含まれません
                  </td>
                </tr>
              )}
              {rows.map((r, i) => {
                const d = dailies[i];
                const isPrevMonth = !r.work_date.startsWith(month);
                const holidayName = getJapaneseHolidayName(r.work_date);
                const isCompanyHoliday = companyHolidays.has(r.work_date);
                const isRed = r.dow === 0 || isJapaneseHoliday(r.work_date);
                const overtime = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
                return (
                  <tr
                    key={r.work_date}
                    className={`border-b border-gray-100 ${r.dirty ? "bg-emerald-50/60" : isPrevMonth ? "bg-sky-50/40" : isCompanyHoliday ? "bg-amber-50/50" : "hover:bg-gray-50"}`}
                  >
                    <td className="px-2 py-1 whitespace-nowrap">
                      <span className={isRed ? "text-red-600" : r.dow === 6 ? "text-blue-600" : "text-gray-700"}>
                        {isPrevMonth
                          ? `${parseInt(r.work_date.slice(5, 7), 10)}/${parseInt(r.work_date.slice(8), 10)} (${WEEK_DAY_LABELS[r.dow]})`
                          : `${parseInt(r.work_date.slice(8), 10)}日 (${WEEK_DAY_LABELS[r.dow]})`}
                      </span>
                      {(holidayName || isCompanyHoliday) && (
                        <span className="ml-1 text-[10px] text-gray-400" title={holidayName ?? "会社休日"}>
                          {holidayName ?? "会社休日"}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="time"
                        value={r.start_time}
                        onChange={(e) => patchRow(i, { start_time: e.target.value })}
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="time"
                        value={r.end_time}
                        onChange={(e) => patchRow(i, { end_time: e.target.value })}
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min={0}
                        step={5}
                        value={r.break_minutes}
                        onChange={(e) => patchRow(i, { break_minutes: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-right"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <select
                        value={r.paid_leave_type ?? ""}
                        onChange={(e) => patchRow(i, { paid_leave_type: (e.target.value || null) as "full" | "half" | null })}
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs"
                      >
                        <option value="">—</option>
                        <option value="full">全</option>
                        <option value="half">半</option>
                      </select>
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        value={r.business_km}
                        onChange={(e) => patchRow(i, { business_km: e.target.value })}
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-right"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="date"
                        value={r.substitute_for_date}
                        onChange={(e) => patchRow(i, { substitute_for_date: e.target.value })}
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs"
                        title="この出勤が振替出勤の場合、元の休日となる日付"
                      />
                    </td>
                    <td className="px-2 py-1">
                      <input
                        type="text"
                        value={r.note}
                        onChange={(e) => patchRow(i, { note: e.target.value })}
                        className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs"
                      />
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{formatHM(d?.work_minutes ?? 0)}</td>
                    <td className={`px-2 py-1 text-right tabular-nums font-medium ${overtime > 0 ? "text-amber-600" : "text-gray-300"}`}>
                      {formatHM(overtime)}
                    </td>
                    <td className={`px-2 py-1 text-right tabular-nums ${(d?.midnight_overtime ?? 0) > 0 ? "text-indigo-600" : "text-gray-300"}`}>
                      {formatHM(d?.midnight_overtime ?? 0)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 text-xs font-medium text-gray-700 sticky bottom-0">
              <tr>
                <td className="px-2 py-2" colSpan={9}>月合計</td>
                <td className="px-2 py-2 text-right tabular-nums">{formatHM(summary.total_work)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${overLimit ? "text-red-600" : "text-amber-600"}`}>
                  {formatHM(overtimeTotal)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{formatHM(summary.total_midnight)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* 印刷用 (画面には出ない。globals.css の @media print で表示に切替わる) */}
      <div className="print-area">
        <div className="print-head">
          <h1>出　勤　簿</h1>
          <div className="print-meta">
            <span>{office?.name ?? ""}</span>
            <span>{month.replace("-", "年")}月分</span>
            <span>氏名：{employeeName}</span>
          </div>
          <div className="print-seal">確認印</div>
        </div>

        <table className="print-table">
          <thead>
            <tr>
              <th>日付</th>
              <th>曜日</th>
              <th>出勤</th>
              <th>退勤</th>
              <th>休憩</th>
              <th>実労働</th>
              <th>時間外</th>
              <th>深夜</th>
              <th>法定休日</th>
              <th>有給</th>
              <th>出張km</th>
              <th className="print-note">備考</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              // 前月最終週の行 (開始月のみ) は印刷に含めない
              if (!r.work_date.startsWith(month)) return null;
              const d = dailies[i];
              const overtime = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
              const worked = (d?.work_minutes ?? 0) > 0;
              return (
                <tr key={r.work_date}>
                  <td>{parseInt(r.work_date.slice(8), 10)}</td>
                  <td>{WEEK_DAY_LABELS[r.dow]}</td>
                  <td>{r.start_time}</td>
                  <td>{r.end_time}</td>
                  <td>{r.break_minutes > 0 ? formatHM(r.break_minutes) : ""}</td>
                  <td>{worked ? formatHM(d.work_minutes) : ""}</td>
                  <td>{overtime > 0 ? formatHM(overtime) : ""}</td>
                  <td>{(d?.midnight_overtime ?? 0) > 0 ? formatHM(d.midnight_overtime) : ""}</td>
                  <td>{(d?.holiday_work ?? 0) > 0 ? formatHM(d.holiday_work) : ""}</td>
                  <td>{r.paid_leave_type === "full" ? "○" : r.paid_leave_type === "half" ? "半" : ""}</td>
                  <td>{r.business_km}</td>
                  <td className="print-note">{r.note}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={5}>月合計</td>
              <td>{formatHM(summary.total_work)}</td>
              <td>{formatHM(overtimeTotal)}</td>
              <td>{formatHM(summary.total_midnight)}</td>
              <td>{formatHM(summary.total_holiday)}</td>
              <td>{summary.total_paid_leave_days} 日</td>
              <td />
              <td className="print-note" />
            </tr>
          </tfoot>
        </table>

        <p className="print-foot">
          通常残業 {formatHM(overtimeTotal)}
          ／ 法定休日 {formatHM(summary.total_holiday)}（換算 {formatHM(holidayEquiv)}）
          ／ 深夜 {formatHM(summary.total_midnight)}（換算 {formatHM(midnightEquiv)}）
          {summary.total_absence > 0 && `　欠勤 ${formatHM(summary.total_absence)}`}
        </p>
        <p className="print-foot print-strong">
          消費計 {formatHM(consumed)} ／ 月上限 {MONTHLY_OVERTIME_LIMIT_HOURS}:00
          （{remaining >= 0 ? `あと残業できる時間 ${formatHM(remaining)}` : `超過 ${formatHM(-remaining)}`}）
        </p>
        <p className="print-foot print-note-small">
          通常残業は 1 日 8 時間超および週 40 時間超の合計。法定休日 (×1.35) と深夜 (+0.25) は
          通常残業 (×1.25) との割増率比で換算して上限枠を消費するため、実時間の合計と残り時間の和は
          {MONTHLY_OVERTIME_LIMIT_HOURS}:00 になりません。
        </p>
      </div>

      {showUrlModal && office && (
        <StaffUrlModal payrollOfficeId={office.id} onClose={() => setShowUrlModal(false)} />
      )}
      {showAdminModal && (
        <AttendanceAdminModal
          tenantId={tenantId}
          onClose={() => {
            setShowAdminModal(false);
            // 事業所取込・スタッフ追加を dropdown に反映
            setAdminRefresh((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

// =====================================================================
// 自己入力 URL 管理モーダル
// =====================================================================

type StaffUrl = { employee_id: string; name: string; url: string | null; disabled: boolean };

function StaffUrlModal({ payrollOfficeId, onClose }: { payrollOfficeId: string; onClose: () => void }) {
  const [staff, setStaff] = useState<StaffUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [settingsAvailable, setSettingsAvailable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/attendance-url?payroll_office_id=${payrollOfficeId}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.error ?? `エラー (${res.status})`);
          return;
        }
        setStaff(json.staff ?? []);
        setSettingsAvailable(json.settings_available !== false);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [payrollOfficeId]);

  const handleCopy = async (s: StaffUrl) => {
    if (!s.url) return;
    try {
      await navigator.clipboard.writeText(s.url);
      setCopiedId(s.employee_id);
      setTimeout(() => setCopiedId((prev) => (prev === s.employee_id ? null : prev)), 1500);
    } catch {
      // clipboard 不許可環境: prompt で手動コピーさせる
      window.prompt("この URL をコピーしてください", s.url);
    }
  };

  const handleAction = async (s: StaffUrl, action: "disable" | "enable" | "reissue") => {
    if (action === "reissue" && !window.confirm(`${s.name} の URL を再発行しますか？\n配布済みの旧 URL は使えなくなります。`)) {
      return;
    }
    setBusyId(s.employee_id);
    try {
      const res = await fetch("/api/attendance-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: s.employee_id, action }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error ?? `エラー (${res.status})`);
        return;
      }
      setStaff((prev) =>
        prev.map((p) =>
          p.employee_id === s.employee_id ? { ...p, disabled: json.disabled, url: json.url } : p,
        ),
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <Link2 size={16} className="text-emerald-600" />
          <h3 className="text-sm font-semibold text-gray-700 flex-1">出勤簿 自己入力 URL</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-gray-100 text-gray-400">
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-2 text-[11px] text-gray-500 border-b border-gray-50">
          各スタッフに自分の URL を渡すと、スマホから本人が自分の出勤簿だけを入力できます。
          URL はこの画面を開くたびに同じものが表示されます (個人ごとに固定)。
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
          ) : error ? (
            <div className="text-xs text-red-600 py-4 text-center">{error}</div>
          ) : staff.length === 0 ? (
            <div className="text-xs text-gray-400 py-4 text-center">在籍職員がいません</div>
          ) : (
            <div className="space-y-1.5">
              {staff.map((s) => (
                <div
                  key={s.employee_id}
                  className={`flex items-center gap-2 border rounded-lg px-3 py-2 ${
                    s.disabled ? "border-gray-200 bg-gray-50 opacity-70" : "border-gray-200"
                  }`}
                >
                  <span className="text-sm text-gray-700 w-24 shrink-0 truncate">{s.name}</span>
                  <span className="flex-1 min-w-0 text-[10px] truncate font-mono">
                    {s.disabled ? (
                      <span className="text-red-400 font-sans">無効化中 (URL は使えません)</span>
                    ) : (
                      <span className="text-gray-400">{s.url ?? "発行不可 (サーバー設定未完了)"}</span>
                    )}
                  </span>
                  {!s.disabled && (
                    <button
                      onClick={() => handleCopy(s)}
                      disabled={!s.url || busyId === s.employee_id}
                      className="text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 shrink-0 disabled:opacity-40"
                    >
                      {copiedId === s.employee_id ? (
                        <><Check size={12} className="text-emerald-600" />コピー済</>
                      ) : (
                        <><Copy size={12} />コピー</>
                      )}
                    </button>
                  )}
                  {settingsAvailable && (
                    <>
                      <button
                        onClick={() => handleAction(s, s.disabled ? "enable" : "disable")}
                        disabled={busyId === s.employee_id}
                        className={`text-[11px] px-2 py-1 rounded border shrink-0 disabled:opacity-40 ${
                          s.disabled
                            ? "border-emerald-300 text-emerald-600 hover:bg-emerald-50"
                            : "border-red-200 text-red-500 hover:bg-red-50"
                        }`}
                        title={s.disabled ? "同じ URL を再び使えるようにする" : "URL を使えなくする (URL 自体は変わらない)"}
                      >
                        {busyId === s.employee_id ? "…" : s.disabled ? "有効化" : "無効化"}
                      </button>
                      <button
                        onClick={() => handleAction(s, "reissue")}
                        disabled={busyId === s.employee_id}
                        className="text-[11px] px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 shrink-0 disabled:opacity-40"
                        title="旧 URL を失効させて新しい URL を発行する"
                      >
                        再発行
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-gray-100 text-[10px] text-gray-400">
          {settingsAvailable ? (
            <>無効化 = URL を止める (有効化で同じ URL が復活)。再発行 = 旧 URL を失効させて新 URL に切替。全員一斉に止めたい場合はサーバーの ATTENDANCE_FORM_SECRET を変更。</>
          ) : (
            <span className="text-amber-600">個別の無効化には attendance_url_settings テーブルの適用が必要です (migrations/attendance_url_settings.sql)。</span>
          )}
        </div>
      </div>
    </div>
  );
}
