"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Loader2, Save, AlertTriangle } from "lucide-react";
import {
  getAttendanceOffice,
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
  formatHM,
  type AttendanceRecord,
} from "@/lib/attendance/attendance-calc";
import { isJapaneseHoliday, getJapaneseHolidayName } from "@/lib/attendance/japan-holidays";

// 月間の時間外労働 上限 (自社基準)。36協定の法定上限 45h より手前に置いた運用ライン。
// 法定休日労働・深夜割増は 36協定の「時間外労働時間」とは別枠なので、この合計には含めない。
const MONTHLY_OVERTIME_LIMIT_HOURS = 35;
const MONTHLY_OVERTIME_LIMIT_MIN = MONTHLY_OVERTIME_LIMIT_HOURS * 60;

const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

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
  is_legal_holiday: boolean;
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
    is_legal_holiday: false,
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
    !r.is_legal_holiday &&
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
    is_legal_holiday: r.is_legal_holiday,
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
  currentOfficeId: string | null;
}) {
  const [month, setMonth] = useState<string>(currentMonth);
  const [office, setOffice] = useState<AttendanceOffice | null>(null);
  const [officeMissing, setOfficeMissing] = useState(false);
  const [employees, setEmployees] = useState<AttendanceEmployee[]>([]);
  const [employeeId, setEmployeeId] = useState<string>("");
  const [rows, setRows] = useState<RowState[]>([]);
  const [neighbors, setNeighbors] = useState<AttendanceRecord[]>([]);
  const [companyHolidays, setCompanyHolidays] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const weekStart = office?.work_week_start ?? 0;

  // ─── 事業所解決 + 職員一覧 ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentOfficeId) {
        setOffice(null);
        setEmployees([]);
        setEmployeeId("");
        setOfficeMissing(false);
        return;
      }
      try {
        const po = await getAttendanceOffice(currentOfficeId);
        if (cancelled) return;
        setOffice(po);
        setOfficeMissing(po === null);
        if (!po) {
          setEmployees([]);
          setEmployeeId("");
          return;
        }
        const emps = await getAttendanceEmployees(po.id);
        if (cancelled) return;
        setEmployees(emps);
        setEmployeeId((prev) => (emps.some((e) => e.id === prev) ? prev : (emps[0]?.id ?? "")));
      } catch (e) {
        if (!cancelled) alert(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [currentOfficeId]);

  // ─── 出勤簿 row 読込 ────────────────────────────────────────────────
  const load = useCallback(async () => {
    const days = daysOfMonth(month);
    if (!employeeId) {
      setRows(days.map(emptyRow));
      setNeighbors([]);
      return;
    }
    setLoading(true);
    try {
      const [res, holidays] = await Promise.all([
        getAttendanceRecords(employeeId, month, weekStart),
        getCompanyHolidays(tenantId, month, weekStart),
      ]);
      const byDate = new Map(res.currentMonthRows.map((r) => [r.work_date, r]));
      setRows(
        days.map((d) => {
          const db = byDate.get(d);
          if (!db) return emptyRow(d);
          return {
            work_date: d,
            dow: dowOf(d),
            start_time: toUiTime(db.start_time),
            end_time: toUiTime(db.end_time),
            break_minutes: db.break_minutes ?? 0,
            is_legal_holiday: !!db.is_legal_holiday,
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
      setNeighbors(res.neighborRecords);
      setCompanyHolidays(holidays);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
      setRows(days.map(emptyRow));
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

  /** 36協定でいう時間外労働 (法定内残業・法定休日労働・深夜割増は含まない) */
  const overtimeTotal = summary.total_daily_overtime + summary.total_weekly_overtime;
  const remaining = MONTHLY_OVERTIME_LIMIT_MIN - overtimeTotal;
  const overLimit = remaining < 0;
  const ratio = Math.min(1, overtimeTotal / MONTHLY_OVERTIME_LIMIT_MIN);
  const nearLimit = !overLimit && ratio >= 0.8;

  const dirtyCount = rows.filter((r) => r.dirty).length;

  // ─── 編集 ───────────────────────────────────────────────────────────
  const patchRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch, dirty: true } : r)));
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
        is_legal_holiday: r.is_legal_holiday,
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

  // ─── 表示 ───────────────────────────────────────────────────────────
  if (!currentOfficeId) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">事業所を選択してください</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* ヘッダー */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0 flex-wrap">
        <CalendarClock size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-700">出勤簿</h2>

        <div className="flex items-center gap-1 ml-2">
          <button onClick={() => setMonth((m) => shiftMonth(m, -1))} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="前月">
            <ChevronLeft size={16} />
          </button>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          />
          <button onClick={() => setMonth((m) => shiftMonth(m, 1))} className="p-1 rounded hover:bg-gray-100 text-gray-500" title="次月">
            <ChevronRight size={16} />
          </button>
        </div>

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

        <button
          onClick={handleSave}
          disabled={saving || dirtyCount === 0 || !employeeId}
          className="ml-auto text-xs px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          保存{dirtyCount > 0 ? ` (${dirtyCount})` : ""}
        </button>
      </div>

      {/* 残業サマリー */}
      <div
        className={`px-3 py-2 border-b shrink-0 ${
          overLimit ? "bg-red-50 border-red-200" : nearLimit ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-100"
        }`}
      >
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] text-gray-500">今月の時間外</span>
            <span className={`text-xl font-bold tabular-nums ${overLimit ? "text-red-600" : "text-gray-800"}`}>
              {formatHM(overtimeTotal)}
            </span>
            <span className="text-[11px] text-gray-400">/ {MONTHLY_OVERTIME_LIMIT_HOURS}:00</span>
          </div>

          <div className="flex items-baseline gap-1.5">
            <span className="text-[11px] text-gray-500">{overLimit ? "超過" : "残り"}</span>
            <span className={`text-xl font-bold tabular-nums ${overLimit ? "text-red-600" : nearLimit ? "text-amber-600" : "text-emerald-600"}`}>
              {formatHM(Math.abs(remaining))}
            </span>
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
            <span>深夜 {formatHM(summary.total_midnight)}</span>
            <span>法定休日 {formatHM(summary.total_holiday)}</span>
            <span>有給 {summary.total_paid_leave_days} 日</span>
            {summary.total_absence > 0 && <span className="text-red-500">欠勤 {formatHM(summary.total_absence)}</span>}
          </div>
        </div>

        {/* 進捗バー */}
        <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${overLimit ? "bg-red-500" : nearLimit ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.round(ratio * 100)}%` }}
          />
        </div>
        <p className="mt-1 text-[10px] text-gray-400">
          時間外 = 1日8時間超 + 週40時間超。法定休日労働と深夜割増は 36協定の時間外には含めていません。
        </p>
      </div>

      {/* 明細 */}
      {officeMissing ? (
        <div className="flex-1 flex items-center justify-center px-6 text-center text-sm text-gray-400">
          この事業所は給与計算システムに取込まれていません。<br />
          給与計算システムの「事業所」→「共通マスタから取込」を先に実行してください。
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
                <th className="text-center px-2 py-2 w-12">法休</th>
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
              {rows.map((r, i) => {
                const d = dailies[i];
                const holidayName = getJapaneseHolidayName(r.work_date);
                const isCompanyHoliday = companyHolidays.has(r.work_date);
                const isRed = r.dow === 0 || isJapaneseHoliday(r.work_date);
                const overtime = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
                return (
                  <tr
                    key={r.work_date}
                    className={`border-b border-gray-100 ${r.dirty ? "bg-emerald-50/60" : isCompanyHoliday ? "bg-amber-50/50" : "hover:bg-gray-50"}`}
                  >
                    <td className="px-2 py-1 whitespace-nowrap">
                      <span className={isRed ? "text-red-600" : r.dow === 6 ? "text-blue-600" : "text-gray-700"}>
                        {parseInt(r.work_date.slice(8), 10)}日 ({WEEK_DAY_LABELS[r.dow]})
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
                    <td className="px-2 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={r.is_legal_holiday}
                        onChange={(e) => patchRow(i, { is_legal_holiday: e.target.checked })}
                        className="accent-emerald-600"
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
    </div>
  );
}
