"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronLeft, ChevronRight, Loader2, Save, AlertTriangle, Download, Upload, Printer, Link2, Copy, Check, X, Users, CheckCircle2, RotateCcw, FolderOpen } from "lucide-react";
import {
  getAttendanceOffices,
  getAttendanceEmployees,
  getAttendanceRecords,
  upsertAttendanceRecords,
  deleteAttendanceRecords,
  getCompanyHolidays,
  getMonthStatus,
  submitMonth,
  approveMonth,
  reopenMonth,
  toUiTime,
  type MonthStatus,
  type AttendanceOffice,
  type AttendanceEmployee,
  type AttendanceDbRow,
} from "@/lib/attendance";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
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
import {
  calcDailyAllowance,
  summarizeAllowance,
  DEFAULT_PHONE_DUTY_PAY,
} from "@/lib/attendance/allowance";
import {
  isFolderSaveSupported,
  getSavedFolderName,
  pickFolder,
  saveToFolder,
  downloadBlob,
} from "@/lib/attendance/save-folder";

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
// 各月は自分の月の日付だけを編集する (前月の日は前月ページで編集する)。
// 月跨ぎ週の 40h 判定は、DB から隣接月 record を読んで計算にだけ使う。
const FIRST_MONTH = "2026-06";

// 拘束 6 時間以上の日に自動で入れる休憩 (労基法 §34 は 6h 超で 45 分・8h 超で 60 分だが、
// 運用上は 6 時間以上なら一律 60 分を既定値にする)。手入力済みの行は上書きしない。
const DEFAULT_BREAK_THRESHOLD_MIN = 6 * 60;
const DEFAULT_BREAK_MINUTES = 60;

// 法定休日 = 日曜で固定 (KT Group の運用。実際に休むことが最も多い曜日)。
// 手動チェックは持たず自動判定する。週の起算曜日 (work_week_start) とは独立。
// 振替は「代休の日に元出勤日を書く」方式 (Excel 踏襲) なので日曜側の例外は無い。
const LEGAL_HOLIDAY_DOW = 0; // 0 = 日曜
function isLegalHolidayRow(r: { dow: number }): boolean {
  return r.dow === LEGAL_HOLIDAY_DOW;
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
  /** 出張距離 (事務員のみ)。文字列保持で空入力を許す */
  business_trip_km: string;
  /** 振替・代休元 1 (この日の休みの元になった出勤日)。set = 代休で休み扱い */
  substitute_for_date: string;
  /** 振替・代休元 2 (半日出勤×2 を 1 日の代休に組み合わせる用) */
  substitute_for_date2: string;
  note: string;
  /** 電話当番 (本社のみ表示・保存) */
  phone_duty: boolean;
  /** 土日祝対応 件数 (本社のみ表示・保存)。文字列保持で空入力を許す */
  holiday_support_count: string;
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
    business_trip_km: "",
    substitute_for_date: "",
    substitute_for_date2: "",
    note: "",
    phone_duty: false,
    holiday_support_count: "",
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
    !r.business_trip_km.trim() &&
    !r.substitute_for_date &&
    !r.substitute_for_date2 &&
    !r.note.trim() &&
    !r.phone_duty &&
    !parseHolidayCount(r.holiday_support_count)
  );
}

/** 土日祝対応 件数の入力文字列 → 0 以上の整数 (空・不正は 0) */
function parseHolidayCount(s: string): number {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toAttendanceRecord(r: RowState): AttendanceRecord {
  return {
    work_date: r.work_date,
    start_time: r.start_time || null,
    end_time: r.end_time || null,
    break_minutes: r.break_minutes,
    is_legal_holiday: isLegalHolidayRow(r),
    paid_leave_type: r.paid_leave_type,
    substitute_for_date: r.substitute_for_date || r.substitute_for_date2 || null,
  };
}

// =====================================================================
// 本体
// =====================================================================

export default function AttendanceTab({
  tenantId,
  currentOfficeId,
  onDirtyChange,
}: {
  tenantId: string;
  /** app 全体で選択中の共通 office id。出勤簿タブ内 dropdown の初期選択にだけ使う */
  currentOfficeId: string | null;
  /** 未保存の入力件数を親に通知 (タブ離脱時の警告に使う) */
  onDirtyChange?: (count: number) => void;
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
  // 振替・代休元の入力欄を開いている行 (work_date)。値が空でも欄を出し続けるため
  const [subEditing, setSubEditing] = useState<Set<string>>(() => new Set());
  // 2 つ目 (半日×2 の組合せ用) を開いている行。1 つ目を入れただけでは出さない
  const [sub2Editing, setSub2Editing] = useState<Set<string>>(() => new Set());
  // 月次ステータス (null = 未提出)
  const [monthStatus, setMonthStatus] = useState<MonthStatus | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [pdfFolder, setPdfFolder] = useState<string | null>(null);
  const [isMaster, setIsMaster] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  // 管理モーダルを閉じた時に事業所・職員一覧を再読込するためのカウンタ
  const [adminRefresh, setAdminRefresh] = useState(0);

  const office = officeList.find((o) => o.id === payrollOfficeId) ?? null;
  const weekStart = office?.work_week_start ?? 0;
  const employeeName = employees.find((e) => e.id === employeeId)?.name ?? "";
  /** 統括営業本部 (本社)。電話当番・土日祝対応の入力と手当計算はここだけ */
  const isHonbu = office?.office_type === "本社";
  /** 選択職員の電話当番単価 (職員ごとに異なる。既定 3,000 円) */
  const phoneDutyPay =
    employees.find((e) => e.id === employeeId)?.phone_duty_pay ?? DEFAULT_PHONE_DUTY_PAY;
  /** 事務員か (true なら通勤距離に加えて出張距離の列も出す) */
  const isOfficeWorker = employees.find((e) => e.id === employeeId)?.is_office_worker === true;

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

  // ─── PDF 保存先フォルダ (端末ごとに記憶) ────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const name = await getSavedFolderName();
      if (!cancelled) setPdfFolder(name);
    })();
    return () => { cancelled = true; };
  }, []);

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
  // 表示・編集するのは当月の日付だけ。隣接月の record は週 40h 計算のためだけに
  // 読み込み、グリッドには出さない (前月分は前月ページで編集する)。
  const load = useCallback(async () => {
    const days = daysOfMonth(month);
    if (!employeeId) {
      setRows(days.map(emptyRow));
      setNeighbors([]);
      setMonthStatus(null);
      return;
    }
    setLoading(true);
    try {
      const [res, holidays, status] = await Promise.all([
        getAttendanceRecords(employeeId, month, weekStart),
        getCompanyHolidays(tenantId, month, weekStart),
        getMonthStatus(employeeId, month),
      ]);
      setMonthStatus(status);
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
            paid_leave_type:
              db.paid_leave_type === "full" || db.paid_leave_type === "half"
                ? db.paid_leave_type
                : db.is_paid_leave
                  ? "full"
                  : null,
            business_km: db.business_km === null || db.business_km === undefined ? "" : String(db.business_km),
            business_trip_km:
              db.business_trip_km === null || db.business_trip_km === undefined
                ? ""
                : String(db.business_trip_km),
            substitute_for_date: db.substitute_for_date ?? "",
            substitute_for_date2: db.substitute_for_date2 ?? "",
            note: db.note ?? "",
            phone_duty: db.phone_duty === true,
            holiday_support_count:
              db.holiday_support_count && db.holiday_support_count > 0
                ? String(db.holiday_support_count)
                : "",
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

  /** 本社手当 (電話当番・土日祝対応) の月集計。当月分の行のみ */
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

  /** 通勤距離の月合計 (km) */
  const kmTotal = rows.reduce((a, r) => a + (parseFloat(r.business_km) || 0), 0);
  /** 出張距離の月合計 (km、事務員のみ) */
  const tripKmTotal = rows.reduce((a, r) => a + (parseFloat(r.business_trip_km) || 0), 0);
  /** 出勤日数 (実労働が 1 分でもある日) */
  const workDays = dailies.filter((d) => d.work_minutes > 0).length;

  const dirtyCount = rows.filter((r) => r.dirty).length;

  // ─── 確定＆提出 / 承認 / 差し戻し ────────────────────────────────────
  const runStatusAction = async (
    action: () => Promise<void>,
    confirmMsg?: string,
  ) => {
    if (!employeeId) return;
    if (dirtyCount > 0) {
      alert(`保存していない変更が ${dirtyCount} 件あります。先に保存してください。`);
      return;
    }
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setStatusBusy(true);
    try {
      await action();
      setMonthStatus(await getMonthStatus(employeeId, month));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusBusy(false);
    }
  };

  /**
   * 確定した月の PDF をサーバーで生成し、登録済みフォルダに直接保存する。
   * フォルダ未設定なら選択を促し、非対応ブラウザ (スマホ等) はダウンロードに落とす。
   */
  const savePdf = async (): Promise<void> => {
    const res = await fetch(
      `/api/attendance-pdf?employee_id=${encodeURIComponent(employeeId)}&month=${month}`,
    );
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(`PDF の生成に失敗しました: ${j.error ?? res.status}`);
      return;
    }
    const blob = await res.blob();
    const safeName = (employeeName || "職員").replace(/[\/:*?"<>|]/g, "_");
    const fileName = `出勤簿_${safeName}_${month}.pdf`;

    if (!isFolderSaveSupported()) {
      downloadBlob(fileName, blob);
      return;
    }
    let result = await saveToFolder(fileName, blob);
    if (!result.ok && result.reason === "no-folder") {
      if (window.confirm("PDF の保存先フォルダが未設定です。今すぐ選びますか？\n(この端末に記憶され、次回から自動保存されます)")) {
        try {
          const name = await pickFolder();
          setPdfFolder(name);
          result = await saveToFolder(fileName, blob);
        } catch {
          downloadBlob(fileName, blob);
          return;
        }
      } else {
        downloadBlob(fileName, blob);
        return;
      }
    }
    if (!result.ok) {
      alert(`フォルダへの保存ができなかったため、ダウンロードします。\n${result.error ?? ""}`);
      downloadBlob(fileName, blob);
      return;
    }
    alert(`PDF を保存しました\n${result.folder} / ${result.fileName}`);
  };

  const handleSubmitMonth = () =>
    runStatusAction(
      async () => {
        await submitMonth(tenantId, employeeId, month, employeeName || null);
        await savePdf();
      },
      `${month.replace("-", "年")}月分を確定して提出しますか？\n提出後、本人の入力画面からは編集できなくなります。`,
    );

  const handleApproveMonth = () =>
    runStatusAction(() => approveMonth(tenantId, employeeId, month, "管理者"));

  const handleReopenMonth = () =>
    runStatusAction(
      () => reopenMonth(employeeId, month),
      "差し戻して未提出に戻しますか？\n本人が再び入力できるようになります。",
    );

  /**
   * 未保存の変更があるとき確認を出す。OK なら true (= 操作を続行してよい)。
   * 月・事業所・職員の切替や CSV 取込など、入力内容が失われる操作の前に必ず通す。
   */
  const confirmIfDirty = (): boolean => {
    if (dirtyCount === 0) return true;
    return window.confirm(
      `保存していない変更が ${dirtyCount} 件あります。
破棄して移動しますか？`,
    );
  };

  // 未保存件数を親に通知 (タブ切替の警告用)
  useEffect(() => {
    onDirtyChange?.(dirtyCount);
  }, [dirtyCount, onDirtyChange]);

  // タブを閉じる・リロードする時のブラウザ標準警告
  useEffect(() => {
    if (dirtyCount === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 一部ブラウザは returnValue が必要 (文言はブラウザ既定になる)
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirtyCount]);

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
        alert(`${r.work_date} の通勤距離が数値ではありません`);
        return;
      }
      const tripKm = r.business_trip_km.trim();
      const tripKmNum = tripKm === "" ? null : Number(tripKm);
      if (tripKmNum !== null && !Number.isFinite(tripKmNum)) {
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
        // 出張距離は事務員のみ。列未適用の環境を壊さないよう対象外では送らない
        ...(isOfficeWorker ? { business_trip_km: tripKmNum } : {}),
        substitute_for_date: r.substitute_for_date || null,
        substitute_for_date2: r.substitute_for_date2 || null,
        // 電話当番・土日祝対応は本社のみ。列未適用の環境を壊さないよう本社以外では送らない
        ...(isHonbu
          ? {
              phone_duty: r.phone_duty,
              holiday_support_count: parseHolidayCount(r.holiday_support_count),
            }
          : {}),
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
        rows: rows.map((r) => ({
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
  // document.title が「PDF として保存」の既定ファイル名になるため、
  // 印刷の間だけ 出勤簿_氏名_YYYY-MM に差し替える。
  const printWithFileName = () => {
    const original = document.title;
    const safeName = (employeeName || "職員").replace(/[\/:*?"<>|]/g, "_");
    document.title = `出勤簿_${safeName}_${month}`;
    try {
      window.print();
    } finally {
      document.title = original;
    }
  };

  const handlePrint = () => {
    if (!employeeId) {
      alert("職員を選択してください");
      return;
    }
    printWithFileName();
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
            onClick={() => {
              if (!confirmIfDirty()) return;
              setMonth((m) => (shiftMonth(m, -1) < FIRST_MONTH ? m : shiftMonth(m, -1)));
            }}
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
            onChange={(e) => {
              if (!confirmIfDirty()) return;
              setMonth(e.target.value < FIRST_MONTH ? FIRST_MONTH : e.target.value);
            }}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          />
          <button
            onClick={() => {
              if (!confirmIfDirty()) return;
              setMonth((m) => shiftMonth(m, 1));
            }}
            className="p-1 rounded hover:bg-gray-100 text-gray-500"
            title="次月"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <select
          value={payrollOfficeId}
          onChange={(e) => {
            if (!confirmIfDirty()) return;
            setPayrollOfficeId(e.target.value);
          }}
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
          onChange={(e) => {
            if (!confirmIfDirty()) return;
            setEmployeeId(e.target.value);
          }}
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
            onClick={() => {
              if (!confirmIfDirty()) return;
              csvInputRef.current?.click();
            }}
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
          {isFolderSaveSupported() && (
            <button
              onClick={async () => {
                try {
                  const name = await pickFolder();
                  setPdfFolder(name);
                } catch {
                  /* ユーザーがキャンセルした */
                }
              }}
              className="text-xs px-2.5 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1"
              title={
                pdfFolder
                  ? `確定＆提出時の PDF 保存先: ${pdfFolder} (クリックで変更)`
                  : "確定＆提出時に PDF を自動保存するフォルダを選ぶ"
              }
            >
              <FolderOpen size={14} />
              {pdfFolder ? `保存先: ${pdfFolder}` : "PDF 保存先"}
            </button>
          )}
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
          {/* 確定＆提出 / 承認 / 差し戻し */}
          {employeeId && (
            monthStatus === null ? (
              <button
                onClick={handleSubmitMonth}
                disabled={statusBusy || dirtyCount > 0}
                className="text-xs px-2.5 py-1.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 inline-flex items-center gap-1 disabled:opacity-40"
                title={dirtyCount > 0 ? "先に保存してください" : "この月を確定して提出する (本人は編集できなくなります)"}
              >
                <CheckCircle2 size={14} />
                確定＆提出
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <span
                  className={`text-[11px] px-2 py-1 rounded ${
                    monthStatus.status === "approved"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-sky-100 text-sky-700"
                  }`}
                  title={
                    monthStatus.status === "approved"
                      ? `承認 ${monthStatus.approved_at?.slice(0, 16).replace("T", " ") ?? ""}`
                      : `提出 ${monthStatus.submitted_at?.slice(0, 16).replace("T", " ") ?? ""}`
                  }
                >
                  {monthStatus.status === "approved" ? "承認済み" : "提出済み"}
                </span>
                {monthStatus.status === "submitted" && (
                  <button
                    onClick={handleApproveMonth}
                    disabled={statusBusy}
                    className="text-xs px-2.5 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
                    title="管理者として承認する"
                  >
                    <CheckCircle2 size={14} />
                    承認
                  </button>
                )}
                <button
                  onClick={handleReopenMonth}
                  disabled={statusBusy}
                  className="text-xs px-2 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1 disabled:opacity-40"
                  title="未提出に戻す (本人が再び入力できるようになります)"
                >
                  <RotateCcw size={13} />
                  差し戻し
                </button>
              </div>
            )
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
            {isHonbu && (
              <span title={`電話当番 ${allowance.phoneDutyDays} 回・土日祝対応 ${allowance.holidaySupportTotal} 件 (併給なし)`}>
                手当 <span className="text-gray-700 font-medium">¥{allowance.totalPay.toLocaleString()}</span>
              </span>
            )}
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
        // padding を付けると sticky ヘッダー/フッターの外側に行が透けるので余白なし
        <div className="flex-1 overflow-auto">
          <table className="w-full min-w-[1300px] text-sm bg-white">
            <thead className="bg-gray-50 text-xs text-gray-600 sticky top-0 z-10">
              <tr>
                <th className="text-left px-2 py-2 w-24">日付</th>
                <th className="text-left px-2 py-2 w-24">出勤</th>
                <th className="text-left px-2 py-2 w-24">退勤</th>
                <th className="text-left px-2 py-2 w-20">休憩(分)</th>
                <th className="text-left px-2 py-2 w-20">有給</th>
                <th className="text-left px-2 py-2 w-20" title="自宅⇔事業所の通勤距離 (km)">通勤km</th>
                {isOfficeWorker && (
                  <th className="text-left px-2 py-2 w-20" title="出張の走行距離 (km)。事務員のみ">出張km</th>
                )}
                {isHonbu && (
                  <>
                    <th className="text-center px-2 py-2 w-12" title={`電話当番 (1回 ${phoneDutyPay.toLocaleString()}円。土日祝対応がある日は併給されません)`}>電話</th>
                    <th className="text-right px-2 py-2 w-16" title="土日祝対応 件数 (1件 6,000円 / 2件以上 10,000円)">土日祝</th>
                    <th className="text-right px-2 py-2 w-20">手当</th>
                  </>
                )}
                <th className="text-left px-2 py-2 w-[14rem]" title="代休の日に、元になった出勤日を入れる (最大2つ。半日出勤×2の組合せ可)。入れた日は休み扱いで欠勤になりません">振替・代休元</th>
                <th className="text-left px-2 py-2 min-w-[10rem]">備考</th>
                <th className="text-right px-2 py-2 w-20">実労働</th>
                <th className="text-right px-2 py-2 w-20">時間外</th>
                <th className="text-right px-2 py-2 w-20">深夜</th>
                <th className="text-right px-2 py-2 w-20" title="所定労働時間 − 実労働。土日祝・会社休日・全有給は対象外。週40時間を確保した週は補填されて消えます">欠勤</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const d = dailies[i];
                const holidayName = getJapaneseHolidayName(r.work_date);
                const isCompanyHoliday = companyHolidays.has(r.work_date);
                const isRed = r.dow === 0 || isJapaneseHoliday(r.work_date);
                // 公休 (土日祝・会社休日) はグレーで区別
                const isRestDay = r.dow === 0 || r.dow === 6 || isJapaneseHoliday(r.work_date) || isCompanyHoliday;
                const overtime = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
                return (
                  <tr
                    key={r.work_date}
                    className={`border-b border-gray-100 ${r.dirty ? "bg-emerald-50/60" : isRestDay ? "bg-gray-100/70" : "hover:bg-gray-50"}`}
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
                    {isOfficeWorker && (
                      <td className="px-2 py-1">
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={r.business_trip_km}
                          onChange={(e) => patchRow(i, { business_trip_km: e.target.value })}
                          className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-right"
                        />
                      </td>
                    )}
                    {isHonbu && (
                      <>
                        <td className="px-2 py-1 text-center">
                          <input
                            type="checkbox"
                            checked={r.phone_duty}
                            onChange={(e) => patchRow(i, { phone_duty: e.target.checked })}
                            className="accent-emerald-600"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            min={0}
                            step={1}
                            value={r.holiday_support_count}
                            onChange={(e) => patchRow(i, { holiday_support_count: e.target.value })}
                            className="w-full border border-gray-200 rounded px-1 py-0.5 text-xs text-right"
                          />
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-gray-600">
                          {(() => {
                            const pay = calcDailyAllowance(r.phone_duty, parseHolidayCount(r.holiday_support_count), phoneDutyPay);
                            return pay > 0 ? `¥${pay.toLocaleString()}` : "";
                          })()}
                        </td>
                      </>
                    )}
                    <td className="px-2 py-1">
                      {r.substitute_for_date || r.substitute_for_date2 || subEditing.has(r.work_date) ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="date"
                            value={r.substitute_for_date}
                            onChange={(e) => patchRow(i, { substitute_for_date: e.target.value })}
                            className="w-[6.5rem] shrink-0 border border-gray-200 rounded px-0.5 py-0.5 text-[11px]"
                            title="この休みの元になった出勤日 (1つ目)"
                          />
                          {r.substitute_for_date2 || sub2Editing.has(r.work_date) ? (
                            <input
                              type="date"
                              value={r.substitute_for_date2}
                              onChange={(e) => patchRow(i, { substitute_for_date2: e.target.value })}
                              className="w-[6.5rem] shrink-0 border border-gray-200 rounded px-0.5 py-0.5 text-[11px]"
                              title="元になった出勤日 (2つ目。半日×2 の組合せ用)"
                            />
                          ) : (
                            r.substitute_for_date && (
                              <button
                                type="button"
                                onClick={() =>
                                  setSub2Editing((prev) => {
                                    const next = new Set(prev);
                                    next.add(r.work_date);
                                    return next;
                                  })
                                }
                                className="text-[11px] text-gray-300 hover:text-emerald-600 px-1 shrink-0"
                                title="元になった出勤日をもう 1 つ追加 (半日×2 の組合せ用)"
                              >
                                ＋
                              </button>
                            )
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setSubEditing((prev) => {
                              const next = new Set(prev);
                              next.add(r.work_date);
                              return next;
                            })
                          }
                          className="text-[11px] text-gray-300 hover:text-emerald-600 px-1"
                          title="代休の元になった出勤日を入れる"
                        >
                          ＋
                        </button>
                      )}
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
                    <td className="px-2 py-1 text-right tabular-nums text-red-500 font-medium">
                      {(d?.absence_minutes ?? 0) > 0 ? formatHM(d.absence_minutes) : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 text-xs font-medium text-gray-700 sticky bottom-0">
              <tr>
                <td className="px-2 py-2" colSpan={isHonbu ? 6 : 6}>
                  月合計
                  {isHonbu && allowance.totalPay > 0 && (
                    <span className="ml-3 font-normal text-gray-500">
                      手当 ¥{allowance.totalPay.toLocaleString()} (電話当番 {allowance.phoneDutyDays} 回・土日祝 {allowance.holidaySupportTotal} 件)
                    </span>
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums" title="通勤距離の月合計">
                  {kmTotal > 0 ? `${kmTotal.toFixed(1)} km` : ""}
                </td>
                {isOfficeWorker && (
                  <td className="px-2 py-2 text-right tabular-nums" title="出張距離の月合計">
                    {tripKmTotal > 0 ? `${tripKmTotal.toFixed(1)} km` : ""}
                  </td>
                )}
                <td className="px-2 py-2" colSpan={isHonbu ? 4 : 1} />
                <td className="px-2 py-2 text-right tabular-nums">{formatHM(summary.total_work)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${overLimit ? "text-red-600" : "text-amber-600"}`}>
                  {formatHM(overtimeTotal)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{formatHM(summary.total_midnight)}</td>
                <td className={`px-2 py-2 text-right tabular-nums ${summary.total_absence > 0 ? "text-red-500" : ""}`}>
                  {summary.total_absence > 0 ? formatHM(summary.total_absence) : ""}
                </td>
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
              <th>通勤(km)</th>
              {isOfficeWorker && <th>出張(km)</th>}
              {isHonbu && <th>手当(円)</th>}
              <th className="print-note">備考</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const d = dailies[i];
              const overtime = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
              const worked = (d?.work_minutes ?? 0) > 0;
              const isRestDay =
                r.dow === 0 ||
                r.dow === 6 ||
                isJapaneseHoliday(r.work_date) ||
                companyHolidays.has(r.work_date);
              return (
                <tr key={r.work_date} className={isRestDay ? "print-rest" : undefined}>
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
                  {isOfficeWorker && <td>{r.business_trip_km}</td>}
                  {isHonbu && (
                    <td>
                      {(() => {
                        const pay = calcDailyAllowance(r.phone_duty, parseHolidayCount(r.holiday_support_count), phoneDutyPay);
                        return pay > 0 ? pay.toLocaleString() : "";
                      })()}
                    </td>
                  )}
                  <td className="print-note">
                    {[
                      r.note,
                      // 振替・代休元は専用列を持たず備考にまとめる (印刷のみ)
                      [r.substitute_for_date, r.substitute_for_date2]
                        .filter(Boolean)
                        .map((d) => (d as string).replace(/-/g, "/"))
                        .join("・"),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </td>
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
              <td>{kmTotal > 0 ? kmTotal.toFixed(1) : ""}</td>
              {isOfficeWorker && <td>{tripKmTotal > 0 ? tripKmTotal.toFixed(1) : ""}</td>}
              {isHonbu && <td>{allowance.totalPay > 0 ? allowance.totalPay.toLocaleString() : ""}</td>}
              <td className="print-note" />
            </tr>
          </tfoot>
        </table>

        {/* 集計は 2 つの小表に分けて並べる (文章羅列だと読みにくいため) */}
        <div className="print-summary">
          <table className="print-sum-box">
            <caption>勤務の集計</caption>
            <tbody>
              <tr>
                <th>実労働 合計</th>
                <td>{formatHM(summary.total_work)}</td>
              </tr>
              <tr>
                <th>出勤日数</th>
                <td>{workDays} 日</td>
              </tr>
              <tr>
                <th>有給</th>
                <td>{summary.total_paid_leave_days} 日</td>
              </tr>
              <tr>
                <th>通勤距離</th>
                <td>{kmTotal.toFixed(1)} km</td>
              </tr>
              {isOfficeWorker && (
                <tr>
                  <th>出張距離</th>
                  <td>{tripKmTotal.toFixed(1)} km</td>
                </tr>
              )}
            </tbody>
          </table>

          <table className="print-sum-box">
            <caption>時間外の集計</caption>
            <tbody>
              <tr>
                <th>通常残業</th>
                <td>{formatHM(overtimeTotal)}</td>
              </tr>
              <tr>
                <th>法定休日</th>
                <td>{formatHM(summary.total_holiday)}</td>
              </tr>
              <tr>
                <th>深夜</th>
                <td>{formatHM(summary.total_midnight)}</td>
              </tr>
              {summary.total_absence > 0 && (
                <tr>
                  <th>欠勤</th>
                  <td>{formatHM(summary.total_absence)}</td>
                </tr>
              )}
            </tbody>
          </table>

          {isHonbu && (
            <table className="print-sum-box">
              <caption>調整手当</caption>
              <tbody>
                <tr>
                  <th>電話当番</th>
                  <td>
                    {allowance.phoneDutyDays} 回 × {phoneDutyPay.toLocaleString()}円
                  </td>
                </tr>
                <tr>
                  <th>土日祝対応</th>
                  <td>{allowance.holidaySupportTotal} 件</td>
                </tr>
                <tr className="sum">
                  <th>合計</th>
                  <td>¥{allowance.totalPay.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>

        <p className="print-foot print-note-small">
          通常残業 = 1日8時間超 + 週40時間超。
          {isHonbu && " 土日祝対応は 1件 6,000円 / 2件以上 10,000円、電話当番とは併給しない。"}
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
