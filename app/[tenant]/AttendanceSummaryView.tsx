"use client";

// 出勤簿 › 残業集計: 職員 × 月 (直近 12 か月 + 当月) の残業時間の一覧。
// 残業はアプリの計算 (1日8h超 + 週40h超、法定休日・深夜は換算) が正 (2026-11 user 決定)。
// 入力画面 (AttendanceTab) と同じ calc 関数・同じ 35h 枠の換算を使うので、
// 同じ職員・同じ月なら入力画面の「消費」と一致する。
// 当月は 今日までの日の行だけで計算する (未来日の行が先に入っていても数えない)。

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, FileSpreadsheet, Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { toRecord, type AttendanceOffice, type AttendanceDbRow } from "@/lib/attendance";
import {
  calcMonthlySummary,
  extendedMonthRange,
  formatHM,
  type AttendanceRecord,
} from "@/lib/attendance/attendance-calc";
import {
  MONTHLY_OVERTIME_LIMIT_HOURS,
  overtimeConsumption,
  type OvertimeConsumption,
} from "@/lib/attendance/overtime-limit";
import { fetchAttendanceRowsRange, fetchCompanyHolidaysRange } from "@/lib/attendance/summary-data";
import { ATTENDANCE_FIRST_MONTH } from "@/lib/attendance/excelImport";
import { todayYmd } from "@/lib/date-jst";
import AttendanceExcelImportModal from "./AttendanceExcelImportModal";

const MONTHS_BACK = 12;

type Emp = {
  id: string;
  name: string;
  employment_status: string | null;
  attendance_hidden?: boolean | null;
};

type Cell = { c: OvertimeConsumption; days: number } | null;

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default function AttendanceSummaryView({
  tenantId,
  offices,
  initialPayrollOfficeId,
  isMaster,
  onBack,
  onOpenEmployee,
}: {
  tenantId: string;
  offices: AttendanceOffice[];
  initialPayrollOfficeId: string;
  /** master user だけ「Excel から反映」を出す (職員の新規作成を伴うため。スタッフ管理と同じ判定) */
  isMaster: boolean;
  onBack: () => void;
  /** セルをクリック → 入力画面でその職員・その月を開く */
  onOpenEmployee: (payrollOfficeId: string, employeeId: string, ym: string) => void;
}) {
  const [payrollOfficeId, setPayrollOfficeId] = useState(initialPayrollOfficeId || offices[0]?.id || "");
  const [emps, setEmps] = useState<Emp[]>([]);
  const [rows, setRows] = useState<AttendanceDbRow[]>([]);
  const [holidays, setHolidays] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const office = offices.find((o) => o.id === payrollOfficeId) ?? null;
  const weekStart = office?.work_week_start ?? 0;
  const today = todayYmd();
  const currentYm = today.slice(0, 7);

  /** 表示する月 (古い → 新しい)。出勤簿の稼働開始月より前は出さない */
  const months = useMemo(() => {
    const list: string[] = [];
    for (let i = MONTHS_BACK; i >= 0; i--) {
      const ym = shiftMonth(currentYm, -i);
      if (ym >= ATTENDANCE_FIRST_MONTH) list.push(ym);
    }
    return list;
  }, [currentYm]);

  // 週 40h の月跨ぎ判定のため、最初の月の週頭から 今日 までを読む
  const range = useMemo(() => {
    const first = months[0] ?? currentYm;
    const ext = extendedMonthRange(first, weekStart);
    return { start: ext.start || `${first}-01`, end: today };
  }, [months, currentYm, weekStart, today]);

  const load = useCallback(async () => {
    if (!payrollOfficeId) return;
    setLoading(true);
    setError(null);
    try {
      const { data, error: eErr } = await supabase
        .from("payroll_employees")
        .select("*")
        .eq("office_id", payrollOfficeId)
        .order("name")
        .order("id");
      if (eErr) throw new Error(`職員の取得に失敗: ${eErr.message}`);
      const all = (data ?? []) as Emp[];
      const [recs, hol] = await Promise.all([
        fetchAttendanceRowsRange(
          all.map((e) => e.id),
          range.start,
          range.end,
        ),
        fetchCompanyHolidaysRange(tenantId, range.start, range.end),
      ]);
      setEmps(all);
      setRows(recs);
      setHolidays(hol);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String((e as { message?: string }).message ?? e);
      setError(msg);
      alert(msg);
    } finally {
      setLoading(false);
    }
  }, [payrollOfficeId, range.start, range.end, tenantId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 事業所切替・再読込時の async fetch
    load();
  }, [load, reloadKey]);

  /** 職員 × 月 の計算結果 */
  const table = useMemo(() => {
    const byEmp = new Map<string, AttendanceRecord[]>();
    for (const r of rows) {
      if (r.work_date > today) continue; // 当月は今日まで
      const list = byEmp.get(r.employee_id) ?? [];
      list.push(toRecord(r));
      byEmp.set(r.employee_id, list);
    }
    // 非表示 (attendance_hidden) の職員は記録があっても出さない (テスト用・集計対象外の枠)。
    // それ以外は 在籍者、または期間内に行のある退職者を出す
    const shown = emps.filter(
      (e) => e.attendance_hidden !== true && (e.employment_status !== "退職者" || byEmp.has(e.id)),
    );
    return shown.map((e) => {
      const recs = byEmp.get(e.id) ?? [];
      const cells: Cell[] = months.map((ym) => {
        const days = recs.filter((r) => r.work_date.startsWith(ym)).length;
        if (days === 0) return null;
        return { c: overtimeConsumption(calcMonthlySummary(recs, weekStart, ym, holidays)), days };
      });
      const totalOvertime = cells.reduce((s, c) => s + (c?.c.overtime ?? 0), 0);
      const totalConsumed = cells.reduce((s, c) => s + (c?.c.consumed ?? 0), 0);
      return { emp: e, cells, totalOvertime, totalConsumed };
    });
  }, [rows, emps, months, weekStart, holidays, today]);

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0 flex-wrap">
        <button
          onClick={onBack}
          className="text-xs px-2 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1"
          title="出勤簿の入力に戻る"
        >
          <ArrowLeft size={14} />
          入力に戻る
        </button>
        <h2 className="font-semibold text-gray-700">残業集計</h2>
        <select
          value={payrollOfficeId}
          onChange={(e) => setPayrollOfficeId(e.target.value)}
          className="text-xs border border-gray-300 rounded px-2 py-1 max-w-[14rem]"
        >
          {offices.map((o) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
        <span className="text-[11px] text-gray-400">
          {months[0]?.replace("-", "/")}〜{currentYm.replace("-", "/")} (当月は {today.slice(5).replace("-", "/")} までの入力分)
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={() => setReloadKey((n) => n + 1)}
            disabled={loading}
            className="text-xs px-2 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-40"
          >
            <RefreshCw size={13} />
            再読込
          </button>
          {isMaster && (
            <button
              onClick={() => setShowImport(true)}
              disabled={!office}
              className="text-xs px-2.5 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
              title="Excel の出勤簿 (.xls) を選んで、職員の追加と日々の出退勤をこの事業所の出勤簿に反映する"
            >
              <FileSpreadsheet size={14} />
              反映 (Excel)
            </button>
          )}
        </div>
      </div>

      <div className="px-3 py-1.5 border-b border-gray-100 text-[10px] text-gray-500 shrink-0 flex items-center gap-3 flex-wrap">
        <span>数字 = 通常残業 (1日8時間超 + 週40時間超)。「+」は法定休日・深夜の換算ぶん</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-100 border border-amber-200" />{MONTHLY_OVERTIME_LIMIT_HOURS}h 枠の 80% 以上</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-100 border border-red-200" />{MONTHLY_OVERTIME_LIMIT_HOURS}h 超過</span>
        <span>セルを押すとその月の出勤簿を開きます</span>
      </div>

      {error && <div className="px-3 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">{error}</div>}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="text-xs bg-white border-collapse">
            <thead className="bg-gray-50 text-gray-600 sticky top-0 z-10">
              <tr>
                <th className="text-left px-2 py-2 w-40 min-w-[10rem] sticky left-0 bg-gray-50">職員</th>
                {months.map((ym) => (
                  <th key={ym} className={`text-right px-2 py-2 w-20 min-w-[5rem] whitespace-nowrap ${ym === currentYm ? "text-emerald-700" : ""}`}>
                    {ym.slice(2).replace("-", "/")}
                    {ym === currentYm && <span className="ml-0.5 text-[9px]">(途中)</span>}
                  </th>
                ))}
                <th className="text-right px-2 py-2 w-20 min-w-[5rem]">合計</th>
              </tr>
            </thead>
            <tbody>
              {table.length === 0 && (
                <tr><td colSpan={months.length + 2} className="px-3 py-8 text-center text-gray-400">職員がいません</td></tr>
              )}
              {table.map(({ emp, cells, totalOvertime, totalConsumed }) => (
                <tr key={emp.id} className="border-b border-gray-100 hover:bg-gray-50/60">
                  <td className="px-2 py-1 whitespace-nowrap truncate max-w-[10rem] sticky left-0 bg-white" title={emp.name}>
                    {emp.name}
                    {emp.employment_status === "退職者" && <span className="ml-1 text-[10px] text-gray-400">退職</span>}
                  </td>
                  {cells.map((cell, i) => {
                    const ym = months[i];
                    if (!cell) {
                      return <td key={ym} className="px-2 py-1 text-right text-gray-300">—</td>;
                    }
                    const { c } = cell;
                    const equiv = c.holidayEquiv + c.midnightEquiv;
                    const color = c.overLimit
                      ? "bg-red-100 text-red-700 font-semibold"
                      : c.nearLimit
                        ? "bg-amber-100 text-amber-800"
                        : c.overtime > 0
                          ? "text-gray-800"
                          : "text-gray-400";
                    return (
                      <td
                        key={ym}
                        onClick={() => onOpenEmployee(payrollOfficeId, emp.id, ym)}
                        className={`px-2 py-1 text-right tabular-nums whitespace-nowrap cursor-pointer hover:ring-1 hover:ring-emerald-300 ${color}`}
                        title={[
                          `${emp.name} ${ym} (${cell.days} 日分の入力)`,
                          `通常残業 ${formatHM(c.overtime)}`,
                          `法定休日・深夜の換算 +${formatHM(equiv)}`,
                          `35h 枠の消費 ${formatHM(c.consumed)} / 残り ${formatHM(c.remaining)}`,
                        ].join("\n")}
                      >
                        {formatHM(c.overtime)}
                        {equiv > 0 && <span className="text-[9px] ml-0.5">+{formatHM(equiv)}</span>}
                      </td>
                    );
                  })}
                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap font-medium text-gray-700" title={`35h 枠の消費 合計 ${formatHM(totalConsumed)}`}>
                    {formatHM(totalOvertime)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showImport && office && (
        <AttendanceExcelImportModal
          tenantId={tenantId}
          office={office}
          onClose={(changed) => {
            setShowImport(false);
            if (changed) setReloadKey((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
