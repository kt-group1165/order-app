"use client";

// スマホ用: 出勤簿 自己入力ページ。
// URL: /m/attendance?t=<個人トークン> (管理者が出勤簿タブの「URL 管理」で発行)
// 読み書きは /api/attendance-self 経由 (トークン検証 + service_role)。
// 本人は自分の分だけ入力できる。管理者は本体アプリの出勤簿タブで全員分を見る。

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CalendarClock, ChevronLeft, ChevronRight, ChevronDown, Loader2, Save, AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  formatHM,
  minutesBetween,
  type AttendanceRecord,
} from "@/lib/attendance/attendance-calc";
import { isJapaneseHoliday, getJapaneseHolidayName } from "@/lib/attendance/japan-holidays";
import {
  calcDailyAllowance,
  summarizeAllowance,
  DEFAULT_PHONE_DUTY_PAY,
} from "@/lib/attendance/allowance";

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
// 各月は自分の月の日付だけを編集する (隣接月は週40h 計算にのみ使う)。
const FIRST_MONTH = "2026-06";

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
  business_trip_km?: number | string | null;
  substitute_for_date: string | null;
  substitute_for_date2?: string | null;
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
  business_trip_km: string;
  note: string;
  phone_duty: boolean;
  holiday_support_count: string;
  /** 振替・代休元 (管理者が設定。本人入力 UI は無いが保存で消さないよう保持) */
  substitute_for_date: string;
  substitute_for_date2: string;
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
    business_trip_km: "",
    note: "",
    phone_duty: false,
    holiday_support_count: "",
    substitute_for_date: "",
    substitute_for_date2: "",
    dirty: false,
    existed: false,
  };
}

function isBlank(r: RowState): boolean {
  return (
    !r.start_time && !r.end_time && r.break_minutes === 0 &&
    r.paid_leave_type === null &&
    !r.business_km.trim() && !r.business_trip_km.trim() && !r.note.trim() &&
    !r.phone_duty && !parseHolidayCount(r.holiday_support_count) &&
    !r.substitute_for_date && !r.substitute_for_date2
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
    // 代休 (振替元あり) は休み扱い → 欠勤に積まれない
    substitute_for_date: r.substitute_for_date || r.substitute_for_date2 || null,
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
  const [isOfficeWorker, setIsOfficeWorker] = useState(false);
  // 月次ステータス (null = 未提出)。提出済みは編集不可
  const [monthStatus, setMonthStatus] = useState<{ status: string; submitted_at: string | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 詳細 (休憩・有給・備考など) を開いている日
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [phoneDutyPay, setPhoneDutyPay] = useState<number>(DEFAULT_PHONE_DUTY_PAY);
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
      setIsOfficeWorker(json.employee?.is_office_worker === true);
      setMonthStatus(json.month_status ?? null);
      setPhoneDutyPay(json.employee?.phone_duty_pay ?? DEFAULT_PHONE_DUTY_PAY);
      const ws: number = json.employee?.work_week_start ?? 0;
      setWeekStart(ws);
      setCompanyHolidays(new Set<string>(json.company_holidays ?? []));

      const days = daysOfMonth(month);
      const monthStart = days[0];
      const monthEnd = days[days.length - 1];
      const byDate = new Map<string, DbRow>();
      const neigh: AttendanceRecord[] = [];
      for (const r of (json.records ?? []) as DbRow[]) {
        if (r.work_date >= monthStart && r.work_date <= monthEnd) {
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
        days.map((d) => {
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
            business_trip_km:
              db.business_trip_km === null || db.business_trip_km === undefined
                ? ""
                : String(db.business_trip_km),
            note: db.note ?? "",
            substitute_for_date: db.substitute_for_date ?? "",
            substitute_for_date2: db.substitute_for_date2 ?? "",
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
        rows.map((r) => ({
          phone_duty: r.phone_duty,
          holiday_support_count: parseHolidayCount(r.holiday_support_count),
        })),
        phoneDutyPay,
      ),
    [rows, phoneDutyPay],
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

  /** 提出済み (submitted / approved) は本人編集不可 */
  const locked = monthStatus !== null;

  const patchRow = (idx: number, patch: Partial<RowState>) => {
    if (locked) return;
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

  const handleSubmitMonth = async () => {
    if (!token) return;
    if (rows.some((r) => r.dirty)) {
      alert("保存していない入力があります。先に「保存」を押してください。");
      return;
    }
    if (!window.confirm(`${month.replace("-", "年")}月分を確定して提出しますか？
提出後は編集できなくなります (修正が必要な場合は管理者に連絡してください)。`)) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/attendance-self-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, month }),
      });
      const json = await res.json();
      if (!res.ok) {
        alert(json.error ?? `提出に失敗しました (${res.status})`);
        return;
      }
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
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
      business_trip_km: r.business_trip_km.trim() || null,
      note: r.note,
      // 本社のみ有効 (API 側で office_type 判定して無視/採用される)
      phone_duty: r.phone_duty,
      holiday_support_count: parseHolidayCount(r.holiday_support_count),
      // 管理者が設定した代休を本人保存で消さないため送り返す
      substitute_for_date: r.substitute_for_date || null,
      substitute_for_date2: r.substitute_for_date2 || null,
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

      {/* 残業サマリー (スマホは 2 段: 残り時間を大きく → 内訳をグリッドで) */}
      <div
        className={`px-3 py-2 border-b ${
          overLimit
            ? "bg-red-50 border-red-200"
            : nearLimit
              ? "bg-amber-50 border-amber-200"
              : "bg-emerald-50 border-emerald-100"
        }`}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[11px] text-gray-500 shrink-0">
            {overLimit ? "超過" : "あと残業できる"}
          </span>
          <span
            className={`text-2xl font-bold tabular-nums ${
              overLimit ? "text-red-600" : nearLimit ? "text-amber-600" : "text-emerald-600"
            }`}
          >
            {formatHM(Math.abs(remaining))}
          </span>
          <span className="text-[10px] text-gray-400 tabular-nums ml-auto">
            消費 {formatHM(consumed)} / {LIMIT_HOURS}:00
          </span>
        </div>
        {/* 内訳は 3 列グリッド。1 行の長文だと折り返して読みにくいため */}
        <div className="mt-1.5 grid grid-cols-3 gap-x-2 gap-y-1 text-[10px] text-gray-500 tabular-nums">
          <div>
            実労働 <span className="text-gray-700 font-medium">{formatHM(summary.total_work)}</span>
          </div>
          <div>
            残業 <span className="text-gray-700 font-medium">{formatHM(overtimeTotal)}</span>
          </div>
          <div>
            深夜 <span className="text-gray-700 font-medium">{formatHM(summary.total_midnight)}</span>
          </div>
          <div>
            法休 <span className="text-gray-700 font-medium">{formatHM(summary.total_holiday)}</span>
          </div>
          <div>
            有給 <span className="text-gray-700 font-medium">{summary.total_paid_leave_days}日</span>
          </div>
          {isHonbu && (
            <div>
              手当{" "}
              <span className="text-gray-700 font-medium">
                ¥{allowance.totalPay.toLocaleString()}
              </span>
            </div>
          )}
          {summary.total_absence > 0 && (
            <div className="text-red-500">
              欠勤 <span className="font-medium">{formatHM(summary.total_absence)}</span>
            </div>
          )}
        </div>
      </div>

      {/* 日次リスト */}
      {loading ? (
        <div className="flex justify-center py-20"><Loader2 size={24} className="animate-spin text-emerald-400" /></div>
      ) : (
        <div className="p-2 space-y-1">
          {rows.map((r, i) => {
            const d = dailies[i];
            const overtime = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
            const holidayName = getJapaneseHolidayName(r.work_date);
            const isCompanyHoliday = companyHolidays.has(r.work_date);
            const isRed = r.dow === 0 || isJapaneseHoliday(r.work_date);
            const isRestDay =
              r.dow === 0 || r.dow === 6 || isJapaneseHoliday(r.work_date) || isCompanyHoliday;
            const pay = isHonbu
              ? calcDailyAllowance(r.phone_duty, parseHolidayCount(r.holiday_support_count), phoneDutyPay)
              : 0;
            // 休憩以外に何か入っている日は、たたまず開いたままにする
            const hasDetail =
              r.paid_leave_type !== null ||
              !!r.note.trim() ||
              r.phone_duty ||
              parseHolidayCount(r.holiday_support_count) > 0 ||
              !!r.business_trip_km.trim() ||
              !!r.substitute_for_date ||
              !!r.substitute_for_date2;
            const open = expanded.has(r.work_date) || hasDetail;
            return (
              <div
                key={r.work_date}
                className={`rounded-lg border px-2.5 py-1.5 ${
                  r.dirty
                    ? "bg-white border-emerald-300"
                    : isRestDay
                      ? "bg-gray-100/70 border-gray-200"
                      : "bg-white border-gray-200"
                }`}
              >
                {/* 1 行目: 日付 + 出退勤 + 実労働。大半の日はこの 1 行で完結する */}
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-[13px] font-medium w-12 shrink-0 ${
                      isRed ? "text-red-600" : r.dow === 6 ? "text-blue-600" : "text-gray-700"
                    }`}
                  >
                    {parseInt(r.work_date.slice(8), 10)}日
                    <span className="text-[10px]">({WEEK_DAY_LABELS[r.dow]})</span>
                  </span>
                  <input
                    type="time"
                    value={r.start_time}
                    disabled={locked}
                    onChange={(e) => patchRow(i, { start_time: e.target.value })}
                    className="flex-1 min-w-0 border border-gray-200 rounded px-1 py-1 text-xs disabled:bg-gray-50"
                  />
                  <span className="text-gray-300 text-[10px]">〜</span>
                  <input
                    type="time"
                    value={r.end_time}
                    disabled={locked}
                    onChange={(e) => patchRow(i, { end_time: e.target.value })}
                    className="flex-1 min-w-0 border border-gray-200 rounded px-1 py-1 text-xs disabled:bg-gray-50"
                  />
                  <span
                    className={`w-11 text-right text-[11px] tabular-nums shrink-0 ${
                      overtime > 0 ? "text-amber-600 font-medium" : "text-gray-400"
                    }`}
                  >
                    {(d?.work_minutes ?? 0) > 0 ? formatHM(d.work_minutes) : ""}
                  </span>
                  {!open && !locked && (
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          next.add(r.work_date);
                          return next;
                        })
                      }
                      className="text-gray-300 shrink-0 px-0.5"
                      title="休憩・有給・備考などを入力"
                    >
                      <ChevronDown size={16} />
                    </button>
                  )}
                </div>

                {/* たたんでいる時も、祝日・欠勤・手当があれば 1 行で見せる */}
                {!open && (holidayName || isCompanyHoliday || pay > 0 || (d?.absence_minutes ?? 0) > 0) && (
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] pl-12">
                    {(holidayName || isCompanyHoliday) && (
                      <span className="text-gray-400">{holidayName ?? "会社休日"}</span>
                    )}
                    {(d?.absence_minutes ?? 0) > 0 && (
                      <span className="text-red-500 font-medium">欠勤 {formatHM(d.absence_minutes)}</span>
                    )}
                    {pay > 0 && (
                      <span className="ml-auto tabular-nums text-emerald-700 font-medium">
                        ¥{pay.toLocaleString()}
                      </span>
                    )}
                  </div>
                )}

                {/* 詳細 (開いた時だけ) */}
                {open && (
                  <div className="mt-1 space-y-1 text-[11px]">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {(holidayName || isCompanyHoliday) && (
                        <span className="text-[10px] text-gray-400">{holidayName ?? "会社休日"}</span>
                      )}
                      <label className="flex items-center gap-1 text-gray-500">
                        休憩
                        <input
                          type="number"
                          min={0}
                          step={5}
                          value={r.break_minutes}
                          disabled={locked}
                          onChange={(e) =>
                            patchRow(i, { break_minutes: Math.max(0, parseInt(e.target.value, 10) || 0) })
                          }
                          className="w-12 border border-gray-200 rounded px-1 py-0.5 text-right disabled:bg-gray-50"
                        />
                        分
                      </label>
                      <select
                        value={r.paid_leave_type ?? ""}
                        disabled={locked}
                        onChange={(e) =>
                          patchRow(i, {
                            paid_leave_type: (e.target.value || null) as "full" | "half" | null,
                          })
                        }
                        className="border border-gray-200 rounded px-1 py-0.5 text-[11px] disabled:bg-gray-50"
                      >
                        <option value="">有給なし</option>
                        <option value="full">全有給</option>
                        <option value="half">半有給</option>
                      </select>
                      {isOfficeWorker && (
                        <label className="flex items-center gap-1 text-gray-500">
                          出張
                          <input
                            type="number"
                            min={0}
                            step={0.1}
                            value={r.business_trip_km}
                            disabled={locked}
                            onChange={(e) => patchRow(i, { business_trip_km: e.target.value })}
                            className="w-12 border border-gray-200 rounded px-1 py-0.5 text-right disabled:bg-gray-50"
                          />
                          km
                        </label>
                      )}
                      {(d?.absence_minutes ?? 0) > 0 && (
                        <span className="text-[10px] text-red-500 font-medium">
                          欠勤 {formatHM(d.absence_minutes)}
                        </span>
                      )}
                    </div>

                    <input
                      type="text"
                      placeholder="備考"
                      value={r.note}
                      disabled={locked}
                      onChange={(e) => patchRow(i, { note: e.target.value })}
                      className="w-full border border-gray-200 rounded px-1.5 py-0.5 text-[11px] disabled:bg-gray-50"
                    />

                    {isHonbu && (
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1 text-gray-500">
                          <input
                            type="checkbox"
                            checked={r.phone_duty}
                            disabled={locked}
                            onChange={(e) => patchRow(i, { phone_duty: e.target.checked })}
                            className="accent-emerald-600"
                          />
                          電話当番
                        </label>
                        <label className="flex items-center gap-1 text-gray-500">
                          土日祝
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={r.holiday_support_count}
                            disabled={locked}
                            onChange={(e) => patchRow(i, { holiday_support_count: e.target.value })}
                            className="w-11 border border-gray-200 rounded px-1 py-0.5 text-right disabled:bg-gray-50"
                          />
                          件
                        </label>
                        {pay > 0 && (
                          <span className="ml-auto tabular-nums text-emerald-700 font-medium">
                            ¥{pay.toLocaleString()}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* 保存・確定＆提出 (固定フッター) */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-3 z-20">
        {locked ? (
          <div className="text-center text-xs text-gray-500 py-1.5">
            <span className="inline-block px-2 py-1 rounded bg-emerald-100 text-emerald-700 font-medium">
              {monthStatus?.status === "approved" ? "承認済み" : "提出済み"}
            </span>
            <span className="ml-2">修正が必要な場合は管理者に連絡してください</span>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || dirtyCount === 0}
              className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              保存{dirtyCount > 0 ? ` (${dirtyCount} 日分)` : ""}
            </button>
            <button
              onClick={handleSubmitMonth}
              disabled={submitting || dirtyCount > 0}
              className="flex-1 py-2.5 rounded-xl border border-emerald-500 text-emerald-700 text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40"
              title={dirtyCount > 0 ? "先に保存してください" : "この月を確定して提出する"}
            >
              {submitting ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
              確定＆提出
            </button>
          </div>
        )}
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
