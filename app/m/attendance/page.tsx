"use client";

// スマホ用: 出勤簿 自己入力ページ。
// URL: /m/attendance?t=<個人トークン> (管理者が出勤簿タブの「URL 管理」で発行)
// 読み書きは /api/attendance-self 経由 (トークン検証 + service_role)。
// 本人は自分の分だけ入力できる。管理者は本体アプリの出勤簿タブで全員分を見る。

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarClock, ChevronLeft, ChevronRight, Loader2, Save, AlertTriangle } from "lucide-react";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  extendedMonthRange,
  formatHM,
  minutesBetween,
  type AttendanceRecord,
} from "@/lib/attendance/attendance-calc";
import { isJapaneseHoliday, getJapaneseHolidayName } from "@/lib/attendance/japan-holidays";
import { calcDailyAllowance, summarizeAllowance } from "@/lib/attendance/allowance";

// 35h 枠と割増換算 (AttendanceTab.tsx と同一ロジック。福祉用具の運用ライン)
const LIMIT_HOURS = 35;
const LIMIT_MIN = LIMIT_HOURS * 60;
const RATE_OVERTIME = 1.25;
const RATE_HOLIDAY = 1.35;
const RATE_MIDNIGHT_EXTRA = 0.25;
const holidayEq = (m: number) => Math.round(m * (RATE_HOLIDAY / RATE_OVERTIME));
const midnightEq = (m: number) => Math.round(m * (RATE_MIDNIGHT_EXTRA / RATE_OVERTIME));

// 拘束 6h 以上で自動休憩 60 分 (手入力済みは上書きしない)
const DEFAULT_BREAK_THRESHOLD_MIN = 6 * 60;
const DEFAULT_BREAK_MINUTES = 60;

const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// 稼働開始月 (AttendanceTab.tsx と同一)。これより前へは移動不可。
// 開始月のみ、初週に属する前月 (6月) の日を編集行として先頭に出す (週40h 計算用)。
const FIRST_MONTH = "2026-07";

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

type DbRow = {
  id?: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  is_legal_holiday: boolean;
  is_paid_leave: boolean;
  paid_leave_type: "full" | "half" | null;
  note: string | null;
  business_km: number | string | null;
  substitute_for_date: string | null;
  phone_duty?: boolean;
  holiday_support_count?: number;
};

type RowState = {
  work_date: string;
  dow: number;
  start_time: string;
  end_time: string;
  break_minutes: number;
  paid_leave_type: "full" | "half" | null;
  business_km: string;
  note: string;
  phone_duty: boolean;
  holiday_support_count: string;
  dirty: boolean;
  existed: boolean;
};

/** 土日祝対応 件数の入力文字列 → 0 以上の整数 */
function parseHolidayCount(v: string): number {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 法定休日 = 日曜で固定 (AttendanceTab.tsx と同一運用)。手動チェック無しの自動判定。
// 振替は管理者画面のみの機能なので、本人入力では単純に日曜 = 法定休日とする。
const LEGAL_HOLIDAY_DOW = 0; // 0 = 日曜
function isLegalHolidayDow(dow: number): boolean {
  return dow === LEGAL_HOLIDAY_DOW;
}

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

function toUiTime(s: string | null): string {
  if (!s) return "";
  const m = /^(\d{1,2}):(\d{1,2})/.exec(s);
  if (!m) return "";
  return `${String(parseInt(m[1], 10)).padStart(2, "0")}:${String(parseInt(m[2], 10)).padStart(2, "0")}`;
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
    note: "",
    phone_duty: false,
    holiday_support_count: "",
    dirty: false,
    existed: false,
  };
}

function isBlank(r: RowState): boolean {
  return (
    !r.start_time && !r.end_time && r.break_minutes === 0 &&
    r.paid_leave_type === null &&
    !r.business_km.trim() && !r.note.trim() &&
    !r.phone_duty && !parseHolidayCount(r.holiday_support_count)
  );
}

function toRecord(r: RowState): AttendanceRecord {
  return {
    work_date: r.work_date,
    start_time: r.start_time || null,
    end_time: r.end_time || null,
    break_minutes: r.break_minutes,
    is_legal_holiday: isLegalHolidayDow(r.dow),
    paid_leave_type: r.paid_leave_type,
    substitute_for_date: null,
  };
}

function SelfAttendanceInner() {
  const searchParams = useSearchParams();
  const token = searchParams.get("t");

  const [month, setMonth] = useState<string>(() => {
    const m = currentMonth();
    return m < FIRST_MONTH ? FIRST_MONTH : m;
  });
  const [name, setName] = useState<string>("");
  const [officeType, setOfficeType] = useState<string>("");
  const [weekStart, setWeekStart] = useState(0);
  const [rows, setRows] = useState<RowState[]>([]);
  const [neighbors, setNeighbors] = useState<AttendanceRecord[]>([]);
  const [companyHolidays, setCompanyHolidays] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  /** 統括営業本部 (本社)。電話当番・土日祝対応の入力と手当計算はここだけ */
  const isHonbu = officeType === "本社";

  const load = useCallback(async () => {
    if (!token) {
      setFatal("URL が正しくありません (トークンがありません)");
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/attendance-self?t=${encodeURIComponent(token)}&month=${month}`,
      );
      const json = await res.json();
      if (!res.ok) {
        setFatal(json.error ?? `エラー (${res.status})`);
        return;
      }
      setFatal(null);
      setName(json.employee?.name ?? "");
      setOfficeType(json.employee?.office_type ?? "");
      const ws: number = json.employee?.work_week_start ?? 0;
      setWeekStart(ws);
      setCompanyHolidays(new Set<string>(json.company_holidays ?? []));

      const days = daysOfMonth(month);
      // 開始月のみ: 初週に属する前月の日を編集行に昇格 (週40h 計算用)。
      // byDate に入れて allDays で行化し、calc 用 neighbor からは外す (二重計上防止)。
      const prevDays = prevMonthTailDates(month, ws);
      const prevSet = new Set(prevDays);
      const allDays = [...prevDays, ...days];
      const monthStart = days[0];
      const monthEnd = days[days.length - 1];
      const byDate = new Map<string, DbRow>();
      const neigh: AttendanceRecord[] = [];
      for (const r of (json.records ?? []) as DbRow[]) {
        if ((r.work_date >= monthStart && r.work_date <= monthEnd) || prevSet.has(r.work_date)) {
          byDate.set(r.work_date, r);
        } else {
          neigh.push({
            work_date: r.work_date,
            start_time: toUiTime(r.start_time) || null,
            end_time: toUiTime(r.end_time) || null,
            break_minutes: r.break_minutes ?? 0,
            is_legal_holiday: !!r.is_legal_holiday,
            paid_leave_type:
              r.paid_leave_type === "full" || r.paid_leave_type === "half"
                ? r.paid_leave_type
                : r.is_paid_leave ? "full" : null,
            substitute_for_date: r.substitute_for_date ?? null,
          });
        }
      }
      setNeighbors(neigh);
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
                : db.is_paid_leave ? "full" : null,
            business_km:
              db.business_km === null || db.business_km === undefined ? "" : String(db.business_km),
            note: db.note ?? "",
            phone_duty: db.phone_duty === true,
            holiday_support_count:
              db.holiday_support_count && db.holiday_support_count > 0
                ? String(db.holiday_support_count)
                : "",
            dirty: false,
            existed: true,
          };
        }),
      );
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [token, month]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount / 月変更時の async fetch
    load();
  }, [load]);

  const allowance = useMemo(
    () =>
      summarizeAllowance(
        rows
          .filter((r) => r.work_date.startsWith(month))
          .map((r) => ({
            phone_duty: r.phone_duty,
            holiday_support_count: parseHolidayCount(r.holiday_support_count),
          })),
      ),
    [rows, month],
  );

  const dailies = useMemo(() => {
    const all = [...rows.map(toRecord), ...neighbors];
    return calcDailyListWithWeekly(all, weekStart, companyHolidays);
  }, [rows, neighbors, weekStart, companyHolidays]);

  const summary = useMemo(() => {
    const all = [...rows.map(toRecord), ...neighbors];
    return calcMonthlySummary(all, weekStart, month, companyHolidays);
  }, [rows, neighbors, weekStart, month, companyHolidays]);

  const overtimeTotal = summary.total_daily_overtime + summary.total_weekly_overtime;
  const consumed = overtimeTotal + holidayEq(summary.total_holiday) + midnightEq(summary.total_midnight);
  const remaining = LIMIT_MIN - consumed;
  const overLimit = remaining < 0;
  const nearLimit = !overLimit && consumed / LIMIT_MIN >= 0.8;

  const dirtyCount = rows.filter((r) => r.dirty).length;

  const patchRow = (idx: number, patch: Partial<RowState>) => {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== idx) return r;
        const next = { ...r, ...patch, dirty: true };
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

  const handleSave = async () => {
    if (!token) return;
    const dirty = rows.filter((r) => r.dirty);
    if (dirty.length === 0) return;
    const upserts = dirty.filter((r) => !isBlank(r)).map((r) => ({
      work_date: r.work_date,
      start_time: r.start_time ? `${r.start_time}:00` : null,
      end_time: r.end_time ? `${r.end_time}:00` : null,
      break_minutes: r.break_minutes,
      // 法定休日 = 日曜固定の自動判定
      is_legal_holiday: isLegalHolidayDow(r.dow),
      paid_leave_type: r.paid_leave_type,
      business_km: r.business_km.trim() || null,
      note: r.note,
      // 本社のみ有効 (API 側で office_type 判定して無視/採用される)
      phone_duty: r.phone_duty,
      holiday_support_count: parseHolidayCount(r.holiday_support_count),
    }));
    const delete_dates = dirty.filter((r) => isBlank(r) && r.existed).map((r) => r.work_date);
    if (upserts.length === 0 && delete_dates.length === 0) return;

    setSaving(true);
    try {
      const res = await fetch("/api/attendance-self", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, upserts, delete_dates }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error ?? `保存に失敗しました (${res.status})`);
        return;
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (fatal) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="bg-white rounded-2xl shadow p-6 max-w-sm text-center">
          <AlertTriangle size={28} className="text-red-500 mx-auto mb-3" />
          <p className="text-sm text-gray-700">{fatal}</p>
          <p className="text-xs text-gray-400 mt-2">URL を確認するか、管理者にお問い合わせください。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* ヘッダー */}
      <header className="bg-emerald-600 text-white px-4 py-3 sticky top-0 z-20">
        <div className="flex items-center gap-2">
          <CalendarClock size={18} />
          <h1 className="text-sm font-semibold flex-1 truncate">出勤簿{name ? ` — ${name}` : ""}</h1>
        </div>
        <div className="flex items-center justify-center gap-2 mt-2">
          <button
            onClick={() => setMonth((m) => (shiftMonth(m, -1) < FIRST_MONTH ? m : shiftMonth(m, -1)))}
            disabled={month <= FIRST_MONTH}
            className="p-1 rounded hover:bg-emerald-500 disabled:opacity-30"
          >
            <ChevronLeft size={18} />
          </button>
          <span className="text-sm font-medium tabular-nums">{month.replace("-", "年")}月</span>
          <button onClick={() => setMonth((m) => shiftMonth(m, 1))} className="p-1 rounded hover:bg-emerald-500">
            <ChevronRight size={18} />
          </button>
        </div>
      </header>

      {/* 残業サマリー */}
      <div className={`px-4 py-2.5 border-b ${overLimit ? "bg-red-50 border-red-200" : nearLimit ? "bg-amber-50 border-amber-200" : "bg-emerald-50 border-emerald-100"}`}>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[11px] text-gray-500">{overLimit ? "超過" : "あと残業できる時間"}</span>
          <span className={`text-xl font-bold tabular-nums ${overLimit ? "text-red-600" : nearLimit ? "text-amber-600" : "text-emerald-600"}`}>
            {formatHM(Math.abs(remaining))}
          </span>
          <span className="text-[11px] text-gray-400 tabular-nums">
            (消費 {formatHM(consumed)} / {LIMIT_HOURS}:00)
          </span>
        </div>
        <div className="mt-1 text-[10px] text-gray-500 tabular-nums">
          実労働 {formatHM(summary.total_work)} ／ 残業 {formatHM(overtimeTotal)} ／ 深夜 {formatHM(summary.total_midnight)} ／ 法休 {formatHM(summary.total_holiday)} ／ 有給 {summary.total_paid_leave_days}日
          {isHonbu && <> ／ 手当 ¥{allowance.totalPay.toLocaleString()}</>}
          {summary.total_absence > 0 && (
            <span className="text-red-500"> ／ 欠勤 {formatHM(summary.total_absence)}</span>
          )}
        </div>
      </div>

      {/* 日次リスト */}
      {loading ? (
        <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-emerald-400" /></div>
      ) : (
        <div className="p-2 space-y-1">
          {rows.some((r) => !r.work_date.startsWith(month)) && (
            <div className="rounded-xl bg-sky-50 border border-sky-100 px-3 py-1.5 text-[10px] text-sky-700">
              下の {parseInt(rows[0].work_date.slice(5, 7), 10)}月分は前月最終週です。
              週40時間の残業計算にだけ使い、月合計には含まれません
            </div>
          )}
          {rows.map((r, i) => {
            const d = dailies[i];
            const isPrevMonth = !r.work_date.startsWith(month);
            const overtime = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
            const holidayName = getJapaneseHolidayName(r.work_date);
            const isCompanyHoliday = companyHolidays.has(r.work_date);
            const isRed = r.dow === 0 || isJapaneseHoliday(r.work_date);
            return (
              <div key={r.work_date} className={`rounded-xl border px-3 py-2 ${r.dirty ? "bg-white border-emerald-300" : isPrevMonth ? "bg-sky-50/60 border-sky-100" : "bg-white border-gray-200"}`}>
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-medium w-14 shrink-0 ${isRed ? "text-red-600" : r.dow === 6 ? "text-blue-600" : "text-gray-700"}`}>
                    {isPrevMonth
                      ? `${parseInt(r.work_date.slice(5, 7), 10)}/${parseInt(r.work_date.slice(8), 10)}(${WEEK_DAY_LABELS[r.dow]})`
                      : `${parseInt(r.work_date.slice(8), 10)}日(${WEEK_DAY_LABELS[r.dow]})`}
                  </span>
                  {(holidayName || isCompanyHoliday) && (
                    <span className="text-[9px] text-gray-400 shrink-0">{holidayName ?? "会社休日"}</span>
                  )}
                  <input
                    type="time"
                    value={r.start_time}
                    onChange={(e) => patchRow(i, { start_time: e.target.value })}
                    className="flex-1 min-w-0 border border-gray-200 rounded px-1 py-1 text-xs"
                  />
                  <span className="text-gray-300 text-xs">〜</span>
                  <input
                    type="time"
                    value={r.end_time}
                    onChange={(e) => patchRow(i, { end_time: e.target.value })}
                    className="flex-1 min-w-0 border border-gray-200 rounded px-1 py-1 text-xs"
                  />
                </div>
                <div className="flex items-center gap-2 mt-1.5 text-[11px]">
                  <label className="flex items-center gap-1 text-gray-500">
                    休憩
                    <input
                      type="number"
                      min={0}
                      step={5}
                      value={r.break_minutes}
                      onChange={(e) => patchRow(i, { break_minutes: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                      className="w-14 border border-gray-200 rounded px-1 py-0.5 text-right"
                    />
                    分
                  </label>
                  <select
                    value={r.paid_leave_type ?? ""}
                    onChange={(e) => patchRow(i, { paid_leave_type: (e.target.value || null) as "full" | "half" | null })}
                    className="border border-gray-200 rounded px-1 py-0.5 text-[11px]"
                  >
                    <option value="">有給なし</option>
                    <option value="full">全有給</option>
                    <option value="half">半有給</option>
                  </select>
                  <input
                    type="text"
                    placeholder="備考"
                    value={r.note}
                    onChange={(e) => patchRow(i, { note: e.target.value })}
                    className="flex-1 min-w-0 border border-gray-200 rounded px-1.5 py-0.5 text-[11px]"
                  />
                  {(d?.absence_minutes ?? 0) > 0 && (
                    <span className="text-[10px] text-red-500 font-medium shrink-0">欠勤 {formatHM(d.absence_minutes)}</span>
                  )}
                  <span className={`w-12 text-right tabular-nums shrink-0 ${overtime > 0 ? "text-amber-600 font-medium" : "text-gray-300"}`}>
                    {(d?.work_minutes ?? 0) > 0 ? formatHM(d.work_minutes) : ""}
                  </span>
                </div>
                {isHonbu && (
                  <div className="flex items-center gap-2 mt-1.5 text-[11px]">
                    <label className="flex items-center gap-1 text-gray-500">
                      <input
                        type="checkbox"
                        checked={r.phone_duty}
                        onChange={(e) => patchRow(i, { phone_duty: e.target.checked })}
                        className="accent-emerald-600"
                      />
                      電話当番
                    </label>
                    <label className="flex items-center gap-1 text-gray-500">
                      土日祝対応
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={r.holiday_support_count}
                        onChange={(e) => patchRow(i, { holiday_support_count: e.target.value })}
                        className="w-12 border border-gray-200 rounded px-1 py-0.5 text-right"
                      />
                      件
                    </label>
                    {(() => {
                      const pay = calcDailyAllowance(r.phone_duty, parseHolidayCount(r.holiday_support_count));
                      return pay > 0 ? (
                        <span className="ml-auto tabular-nums text-emerald-700 font-medium">¥{pay.toLocaleString()}</span>
                      ) : null;
                    })()}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 保存 (固定フッター) */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-3 z-20">
        <button
          onClick={handleSave}
          disabled={saving || dirtyCount === 0}
          className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
          保存{dirtyCount > 0 ? ` (${dirtyCount} 日分)` : ""}
        </button>
      </div>
    </div>
  );
}

export default function SelfAttendancePage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-emerald-400" /></div>}>
      <SelfAttendanceInner />
    </Suspense>
  );
}
