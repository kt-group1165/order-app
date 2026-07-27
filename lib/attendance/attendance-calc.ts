// attendance-calc.ts
// 出勤簿 残業計算ロジック (汎用 / 日本労基準拠 pure-function 集)
//
// 設計方針:
//   - 居宅介護支援ケアマネを主想定としつつ、訪問介護等の他職種でも流用できる汎用設計
//   - 純粋関数のみ (副作用なし / testable)
//   - 本 lib は「時間 (分) の集計」に責任を持ち、割増率の適用 (×1.25 / ×1.35 等) は呼出側で行う
//
// 日本労基準拠:
//   - 法定労働時間: 1 日 8 時間 / 1 週 40 時間 (労基法 §32)
//   - 深夜時間帯: 22:00 - 翌 5:00 (労基法 §37④)
//   - 法定休日: 週 1 日 (労基法 §35) — シフト上の休日 (= 所定休日) と区別する
//     法定休日労働は ×1.35、所定休日労働は通常の残業扱い
//   - 日次残業 (8h 超) と週次残業 (週 40h 超) は重複しないよう、週次は日次超過分を差し引く
//   - 深夜割増は他の割増と独立して上乗せされるため、本 lib では別 field で集計
//
// 入出力単位は分 (minute)。出力 field は全て非負整数を期待する。

import { isJapaneseHoliday } from "./japan-holidays";

// =====================================================================
// Type 定義
// =====================================================================

export type AttendanceRecord = {
  /** 勤務日 (YYYY-MM-DD) */
  work_date: string;
  /** 出勤時刻 (HH:mm)。null なら未出勤扱い */
  start_time: string | null;
  /** 退勤時刻 (HH:mm)。null なら未出勤扱い。end < start の場合は翌日跨ぎとして +24h */
  end_time: string | null;
  /** 休憩時間 (分) */
  break_minutes: number;
  /** 法定休日労働か (= シフト上の所定休日とは区別)。true なら全労働時間が holiday_work に積まれる */
  is_legal_holiday: boolean;
  /**
   * 有給休暇取得日種別:
   *   null = 有給なし
   *   "full" = 全有給 (月集計に +1 日、所定労働日扱いから外れる)
   *   "half" = 半有給 (月集計に +0.5 日、所定労働時間が 4h に減る)
   */
  paid_leave_type: "full" | "half" | null;
  /**
   * 振替元日付 (YYYY-MM-DD)。null = 振替ではない通常の出勤。
   * NOT NULL の場合、この record の work_date が振替出勤日 (= 所定労働日)、
   * substitute_for_date は振替先の休日 (= 所定労働日でなくなる)。
   */
  substitute_for_date: string | null;
};

export type DailyCalc = {
  work_date: string;
  /** 実労働時間 (休憩除く、分) */
  work_minutes: number;
  /** 日次残業 (1 日 8h 超過、分)。法定休日労働日は 0 (= holiday_work で別計上) */
  daily_overtime: number;
  /**
   * 週次残業 按分 (週 40h 超過のうち、この日に按分される分、分)。
   * calcDaily 単独では 0、calcDailyListWithWeekly() を使うと週累積で計算される。
   * 日次残業との二重計上は無し (非 OT 基準時間に対してのみ累積判定)。
   */
  weekly_overtime: number;
  /** 深夜残業 (22:00 - 翌 05:00 の労働、分) */
  midnight_overtime: number;
  /** 法定休日労働 (is_legal_holiday=true なら work_minutes 全部、分) */
  holiday_work: number;
  /**
   * 欠勤時間 (分)。所定労働時間に対する不足分。
   * calcDaily 単独では 0、calcDailyListWithWeekly() を使うと
   * 全月の振替先判定 + 祝日判定で計算される。
   */
  absence_minutes: number;
  /** その日の所定労働時間 (分)。0 なら所定労働日でない */
  scheduled_minutes: number;
};

export type MonthlySummary = {
  /** 月合計 実労働 (分) */
  total_work: number;
  /** 月合計 日次残業 (分) */
  total_daily_overtime: number;
  /**
   * 月合計 週次残業 (週 40h 超過、分)。
   * 日次残業と二重計上しないよう、各週で「週合計 - 週内日次残業合計」が 40h を超えた分のみ。
   */
  total_weekly_overtime: number;
  /** 月合計 深夜残業 (分) */
  total_midnight: number;
  /** 月合計 法定休日労働 (分) */
  total_holiday: number;
  /** 月合計 欠勤時間 (分) */
  total_absence: number;
  /** 有給日数 (全=1 / 半=0.5 で合算)。0.5 刻みの小数を含む */
  total_paid_leave_days: number;
};

// =====================================================================
// 定数
// =====================================================================

const MIN_PER_HOUR = 60;
const LEGAL_DAILY_LIMIT = 8 * MIN_PER_HOUR; // 480
const LEGAL_WEEKLY_LIMIT = 40 * MIN_PER_HOUR; // 2400
const MIDNIGHT_START_HOUR = 22; // 22:00
const MIDNIGHT_END_HOUR = 5; // 翌 05:00
const MIDNIGHT_START_MIN = MIDNIGHT_START_HOUR * MIN_PER_HOUR; // 1320
const MIDNIGHT_END_MIN = MIDNIGHT_END_HOUR * MIN_PER_HOUR; // 300
const DAY_MIN = 24 * MIN_PER_HOUR; // 1440

// =====================================================================
// 補助関数
// =====================================================================

/**
 * "HH:mm" / "H:m" を { hour, minute } に分解。
 * 不正値 (範囲外 / 形式不一致) は null。
 *
 * @example
 * parseTime("09:00")  // => { hour: 9, minute: 0 }
 * parseTime("9:5")    // => { hour: 9, minute: 5 }
 * parseTime("24:00")  // => null  (hour は 0-23)
 * parseTime("abc")    // => null
 */
export function parseTime(
  s: string,
): { hour: number; minute: number } | null {
  if (typeof s !== "string") return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(s.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/**
 * "HH:mm" の start と end の間の分数。end < start の場合は翌日跨ぎとして +24h 補正。
 * パース失敗時は 0。
 *
 * @example
 * minutesBetween("09:00", "18:00")  // => 540
 * minutesBetween("22:00", "05:00")  // => 420 (翌日 5:00 まで = 7h)
 * minutesBetween("18:00", "18:00")  // => 0
 */
export function minutesBetween(start: string, end: string): number {
  const a = parseTime(start);
  const b = parseTime(end);
  if (!a || !b) return 0;
  const s = a.hour * MIN_PER_HOUR + a.minute;
  let e = b.hour * MIN_PER_HOUR + b.minute;
  if (e < s) e += DAY_MIN;
  return e - s;
}

/**
 * 分を "H:MM" 形式に整形。負値は "-" prefix。
 *
 * @example
 * formatHM(510)   // => "8:30"
 * formatHM(60)    // => "1:00"
 * formatHM(0)     // => "0:00"
 * formatHM(-90)   // => "-1:30"
 */
export function formatHM(minutes: number): string {
  if (!Number.isFinite(minutes)) return "0:00";
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minutes));
  const h = Math.floor(abs / MIN_PER_HOUR);
  const m = abs % MIN_PER_HOUR;
  return `${sign}${h}:${String(m).padStart(2, "0")}`;
}

/**
 * 月 (YYYY-MM) に対し、月跨ぎ週も完全に含めた拡張日付範囲を返す。
 *
 * - start: 月初日が属する週の起算日 (前月にまたがる場合あり)
 * - end:   月末日が属する週の終了日 (翌月にまたがる場合あり)
 *
 * 週次残業の月跨ぎ計算で extended records を取得する用途。
 *
 * @example
 * extendedMonthRange("2025-02", 0)  // Feb1=土 → start=2025-01-26(日), end=2025-03-01(土)
 * extendedMonthRange("2025-01", 0)  // Jan1=水 → start=2024-12-29(日), end=2025-02-01(土)
 */
export function extendedMonthRange(
  monthYM: string,
  weekStartDay: number = 0,
): { start: string; end: string } {
  const m = /^(\d{4})-(\d{1,2})$/.exec(monthYM);
  if (!m) return { start: "", end: "" };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const monthStart = new Date(Date.UTC(y, mo - 1, 1));
  const monthEnd = new Date(Date.UTC(y, mo, 0)); // 月末日
  // 月初が属する週の起算日: 月初 dow からの差分日数だけ巻き戻す
  const startDow = monthStart.getUTCDay();
  const daysBack = (startDow - weekStartDay + 7) % 7;
  const extStart = new Date(monthStart.getTime() - daysBack * DAY_MIN * 60 * 1000);
  // 月末が属する週の終了日: 週末 dow = (weekStartDay + 6) % 7
  const endDow = monthEnd.getUTCDay();
  const weekEndDow = (weekStartDay + 6) % 7;
  const daysFwd = (weekEndDow - endDow + 7) % 7;
  const extEnd = new Date(monthEnd.getTime() + daysFwd * DAY_MIN * 60 * 1000);
  const ymd = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  return { start: ymd(extStart), end: ymd(extEnd) };
}

/**
 * 指定日が週初日か判定。weekStartDay は 0=日曜 / 1=月曜 / ... / 6=土曜 (Date.getDay() に同じ)。
 * デフォルトは 0 (日曜起算)。
 *
 * @example
 * isWeekStart("2025-01-05")     // => true  (日曜)
 * isWeekStart("2025-01-06", 1)  // => true  (月曜)
 * isWeekStart("2025-01-05", 1)  // => false
 */
export function isWeekStart(date: string, weekStartDay: number = 0): boolean {
  const dt = parseDateUTC(date);
  if (!dt) return false;
  return dt.getUTCDay() === weekStartDay;
}

/**
 * YYYY-MM-DD を UTC Date に。不正値は null。
 * (TZ ずれを避けるため UTC 基準で内部処理する。曜日判定は UTC.getUTCDay() で OK)
 */
function parseDateUTC(date: string): Date | null {
  if (typeof date !== "string") return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // 月跨ぎ正規化チェック (例: "2025-02-30" は別の月に流れる)
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt;
}

/**
 * 指定日の「週キー」(= 週の起算日 YYYY-MM-DD) を返す。
 * weekStartDay: 0=日曜 / 1=月曜 / ...
 */
export function weekKeyOf(date: string, weekStartDay: number): string | null {
  const dt = parseDateUTC(date);
  if (!dt) return null;
  const dow = dt.getUTCDay();
  const diff = (dow - weekStartDay + 7) % 7;
  const start = new Date(dt.getTime() - diff * DAY_MIN * 60 * 1000);
  const y = start.getUTCFullYear();
  const mo = String(start.getUTCMonth() + 1).padStart(2, "0");
  const d = String(start.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/**
 * 指定の労働区間 [startMin, endMin) が深夜帯 (22:00-翌05:00) と重なる分数を計算。
 * endMin は startMin より大きい (翌日跨ぎは呼出側で +1440 済み)。
 * 深夜帯 = [1320, 1440) ∪ [1440, 1740) (= 翌 05:00 = 1440+300)
 *
 * 連勤 (24h 超) はこの簡易ロジックでは扱わない (= 1 日 1 record 前提)。
 */
function midnightOverlap(startMin: number, endMin: number): number {
  if (endMin <= startMin) return 0;

  // 深夜帯を 2 区間に展開して overlap を取る
  // 区間 1: [22:00, 24:00) = [1320, 1440)
  // 区間 2: [24:00, 29:00) = [1440, 1740)  ← 翌 05:00
  // 翌々日まで跨ぐ場合は更に [1320+1440, 1440+1440)... も考慮すべきだが、
  // 1 日 1 record 前提なので 1 日跨ぎまでの範囲で十分。

  let overlap = 0;

  // 当日 22:00 - 24:00
  overlap += Math.max(
    0,
    Math.min(endMin, MIDNIGHT_START_MIN + (DAY_MIN - MIDNIGHT_START_MIN)) -
      Math.max(startMin, MIDNIGHT_START_MIN),
  );
  // ↑ = min(endMin, 1440) - max(startMin, 1320) の正値部分

  // 翌日 00:00 - 05:00
  overlap += Math.max(
    0,
    Math.min(endMin, DAY_MIN + MIDNIGHT_END_MIN) - Math.max(startMin, DAY_MIN),
  );

  // 前日 22:00 起算で深夜にかかる開始 (= startMin が 0-5h 帯) を扱うケースもあるが、
  // start_time は HH:mm 由来で 0-23h 内、end_time のみ +24h されるため不要。

  return overlap;
}

// =====================================================================
// 主要 API
// =====================================================================

/**
 * 1 日分の attendance record から労働時間 / 残業 / 深夜 / 法定休日労働を計算。
 *
 * @example
 * calcDaily({
 *   work_date: "2025-01-15",
 *   start_time: "09:00",
 *   end_time: "20:30",
 *   break_minutes: 60,
 *   is_legal_holiday: false,
 *   paid_leave_type: null,
 * })
 * // => { work_date: "2025-01-15", work_minutes: 630, daily_overtime: 150, midnight_overtime: 0, holiday_work: 0 }
 *
 * @example
 * // 深夜跨ぎ: 22:00 - 翌 06:00、休憩 60 分
 * calcDaily({
 *   work_date: "2025-01-15",
 *   start_time: "22:00",
 *   end_time: "06:00",
 *   break_minutes: 60,
 *   is_legal_holiday: false,
 *   paid_leave_type: null,
 * })
 * // work_minutes = 480 - 60 = 420
 * // daily_overtime = 0 (8h 以内)
 * // midnight_overtime = 7h = 420 (22:00-05:00)
 */
export function calcDaily(record: AttendanceRecord): DailyCalc {
  const base: DailyCalc = {
    work_date: record.work_date,
    work_minutes: 0,
    daily_overtime: 0,
    weekly_overtime: 0,
    midnight_overtime: 0,
    holiday_work: 0,
    absence_minutes: 0,
    scheduled_minutes: 0,
  };

  if (record.start_time === null || record.end_time === null) return base;

  const a = parseTime(record.start_time);
  const b = parseTime(record.end_time);
  if (!a || !b) return base;

  const startMin = a.hour * MIN_PER_HOUR + a.minute;
  let endMin = b.hour * MIN_PER_HOUR + b.minute;
  if (endMin < startMin) endMin += DAY_MIN;

  const grossMinutes = endMin - startMin;
  const breakMin = Math.max(0, Math.floor(record.break_minutes ?? 0));
  const workMinutes = Math.max(0, grossMinutes - breakMin);

  // 深夜時間: 労働区間 ∩ 深夜帯。休憩を一律按分すると複雑なので、
  // 「労働時間帯と深夜帯の overlap」から、休憩中に深夜帯と重なる分を差し引く簡易ロジックは
  // 採らず、本 lib では「拘束時間 (= 区間) と深夜帯の overlap」を深夜時間とみなす。
  // (実務上、休憩を深夜帯に固定で配置するケースは稀。厳密化が必要なら呼出側で記録)
  const midnight = midnightOverlap(startMin, endMin);

  if (record.is_legal_holiday) {
    // 法定休日労働は work_minutes 全部を holiday_work に。daily_overtime は 0。
    return {
      work_date: record.work_date,
      work_minutes: workMinutes,
      daily_overtime: 0,
      weekly_overtime: 0,
      midnight_overtime: midnight,
      holiday_work: workMinutes,
      absence_minutes: 0,
      scheduled_minutes: 0,
    };
  }

  const dailyOvertime = Math.max(0, workMinutes - LEGAL_DAILY_LIMIT);

  return {
    work_date: record.work_date,
    work_minutes: workMinutes,
    daily_overtime: dailyOvertime,
    weekly_overtime: 0,
    midnight_overtime: midnight,
    holiday_work: 0,
    absence_minutes: 0,
    scheduled_minutes: 0,
  };
}

/**
 * 月内 record 配列を順次処理し、各日に week 累積を基に weekly_overtime を按分する。
 * UI で行ごとに「週次残業」を表示するために使用。
 *
 * アルゴリズム:
 *   - 各週 (weekStartDay 起算) について、日付昇順に iterate
 *   - 法定休日 auto-detect (労基 §35): 1 週間に休み (work_minutes=0) が 1 日も無い場合、
 *     その週の最終日を法定休日労働扱いにする (work_minutes 全部を holiday_work に移動)。
 *     月跨ぎ週 (record < 7 件) は保守的にスキップ。ユーザー manual で is_legal_holiday=true
 *     済みの場合は manual 指定を優先 (auto は何もしない)。
 *   - 各日の「非日次残業基準時間」(= min(work_minutes, 8h) — 法定休日除く) を累積
 *   - 累積 > 40h になった日に、その超過分を weekly_overtime として加算
 *   - 同日に既に daily_overtime がある場合は、その分は週次累積に含めない (= 二重計上回避)
 *   - 欠勤 (per-day raw): max(0, 所定 - 実労働)。所定は曜日 / 祝日 / 振替 / 有給 で判定
 *   - 欠勤 (週次調整): min(Σ raw 欠勤, max(0, 40h - Σ min(work, 8h)))
 *     週合計が40hに達していれば、early-week の欠勤は補填されて 0 に引き下げる。
 *     1日8h超の daily OT 分は補填プールに含まれない (法休 work は含む)。
 *
 * @param weekStartDay 0=日曜起算 / 1=月曜起算 / ... / 6=土曜起算 (payroll_offices.work_week_start)
 * @returns calcDaily と同じ順序 (= records の元順序) で結果配列を返す
 */
export function calcDailyListWithWeekly(
  records: AttendanceRecord[],
  weekStartDay: number = 0,
  companyHolidayDates?: Set<string>,
): DailyCalc[] {
  // 元順を保持するため index 付き
  // autoLegalHoliday: 週内に休み無し → 自動で法定休日扱いになった日 (manual 指定とは別 flag)
  const items = records.map((r, idx) => ({
    idx,
    r,
    daily: calcDaily(r),
    autoLegalHoliday: false,
  }));

  // 週ごとに分類
  const weekGroups = new Map<string, typeof items>();
  for (const it of items) {
    const wk = weekKeyOf(it.r.work_date, weekStartDay);
    if (!wk) continue;
    if (!weekGroups.has(wk)) weekGroups.set(wk, []);
    weekGroups.get(wk)!.push(it);
  }

  // 振替先 (= 他の日から休日を振り替えられた日) を pre-build (per-week 処理で必要)
  const substituteTargetDates = new Set<string>();
  for (const it of items) {
    if (it.r.substitute_for_date) {
      substituteTargetDates.add(it.r.substitute_for_date);
    }
  }

  for (const list of weekGroups.values()) {
    list.sort((a, b) => a.r.work_date.localeCompare(b.r.work_date));

    // ─── 法定休日労働 auto-detect (労基 §35) ───
    // 7 日揃った週で全日 work_minutes>0 (= 休み無し) なら、最終日を法定休日労働扱いに。
    // ユーザーが既に該当日を manual 法休指定済みの場合は何もしない (manual 優先)。
    if (list.length === 7 && list.every((it) => it.daily.work_minutes > 0)) {
      const last = list[list.length - 1];
      if (!last.r.is_legal_holiday) {
        // holiday_work に work_minutes 全部を移動、日次/週次残業はリセット
        // (calcDaily の is_legal_holiday=true と同じ扱い。深夜は別割増として残す)
        last.daily = {
          ...last.daily,
          holiday_work: last.daily.work_minutes,
          daily_overtime: 0,
          weekly_overtime: 0,
        };
        last.autoLegalHoliday = true;
      }
    }

    // ─── 週次残業按分 (週 40h 超過分を該当日に分配) ───
    let cumulativeBase = 0; // 週累積 (基準時間、日次OT除く、法定休日除く)
    for (const it of list) {
      // 法定休日 (manual or auto) は週累積に含めない
      if (it.r.is_legal_holiday || it.autoLegalHoliday) continue;
      const baseHours = Math.max(0, it.daily.work_minutes - it.daily.daily_overtime);
      const newCumulative = cumulativeBase + baseHours;
      if (newCumulative > LEGAL_WEEKLY_LIMIT) {
        const excess = newCumulative - LEGAL_WEEKLY_LIMIT;
        // この日の baseHours のうち、超過した分が weekly_overtime
        it.daily.weekly_overtime = Math.min(baseHours, excess);
      }
      cumulativeBase = newCumulative;
    }

    // ─── 欠勤 (raw per-day) ───
    // 所定労働日の判定:
    //   - 平日 (月-金) かつ 祝日でない → 所定日 (= 8h)
    //   - 振替出勤日 (substitute_for_date が set) → 強制で所定日 (= 8h)
    //   - 振替先 (= 他の record の substitute_for_date が この日) → 所定日でなくなる (= 0h)
    //   - 全有給 → 所定日でなくなる (= 0h)
    //   - 半有給 → 所定時間 4h
    //   - 法定休日労働日 (manual/auto) → 所定日でない (= 0h)、欠勤判定対象外
    // raw 欠勤時間 = max(0, scheduled_minutes - work_minutes)
    for (const it of list) {
      if (it.r.is_legal_holiday || it.autoLegalHoliday) {
        it.daily.scheduled_minutes = 0;
        it.daily.absence_minutes = 0;
        continue;
      }
      if (it.r.paid_leave_type === "full") {
        it.daily.scheduled_minutes = 0;
        it.daily.absence_minutes = 0;
        continue;
      }
      if (substituteTargetDates.has(it.r.work_date)) {
        it.daily.scheduled_minutes = 0;
        it.daily.absence_minutes = 0;
        continue;
      }
      const isSubstituteWorkDay = it.r.substitute_for_date !== null;
      const dt = parseDateUTC(it.r.work_date);
      const dow = dt ? dt.getUTCDay() : 0;
      const isWeekday = dow >= 1 && dow <= 5;
      const isHoliday =
        isJapaneseHoliday(it.r.work_date) ||
        (companyHolidayDates?.has(it.r.work_date) ?? false);
      const isScheduledDay = isSubstituteWorkDay || (isWeekday && !isHoliday);
      if (!isScheduledDay) {
        it.daily.scheduled_minutes = 0;
        it.daily.absence_minutes = 0;
        continue;
      }
      const scheduled = it.r.paid_leave_type === "half" ? 4 * MIN_PER_HOUR : LEGAL_DAILY_LIMIT;
      it.daily.scheduled_minutes = scheduled;
      it.daily.absence_minutes = Math.max(0, scheduled - it.daily.work_minutes);
    }

    // ─── 欠勤 週次調整 ───
    // 週の欠勤 = min(
    //   Σ raw 欠勤,
    //   max(0, 40h - 効果労働時間)
    // )
    //   効果労働時間 = Σ work_minutes (uncapped、残業分も含む)
    //                + Σ 有給 credit (full=8h, half=4h)
    //   = 「結果としてその週 40h（有給での調整後）が確保されているか」を 1 つの数値で表現。
    // 残業時間も補填源として扱う (= ユーザ運用ポリシー: その週 40h が結果として確保されていれば
    //   欠勤として警告しない)。
    // 法休 work は仕様により効果労働時間に含める。
    // 補填があれば日付昇順で raw 欠勤を 0 まで引き下げる (sum=月計と一致)。
    const rawAbsSum = list.reduce((s, it) => s + it.daily.absence_minutes, 0);
    const workSum = list.reduce((s, it) => s + it.daily.work_minutes, 0);
    const paidLeaveCreditSum = list.reduce((s, it) => {
      if (it.r.paid_leave_type === "full") return s + LEGAL_DAILY_LIMIT;
      if (it.r.paid_leave_type === "half") return s + 4 * MIN_PER_HOUR;
      return s;
    }, 0);
    const effectiveWorkSum = workSum + paidLeaveCreditSum;
    const weeklyShortfall = Math.max(0, LEGAL_WEEKLY_LIMIT - effectiveWorkSum);
    const weeklyAbsence = Math.min(rawAbsSum, weeklyShortfall);
    if (weeklyAbsence < rawAbsSum) {
      let reductionNeeded = rawAbsSum - weeklyAbsence;
      for (const it of list) {
        if (reductionNeeded <= 0) break;
        if (it.daily.absence_minutes <= 0) continue;
        const reduce = Math.min(it.daily.absence_minutes, reductionNeeded);
        it.daily.absence_minutes -= reduce;
        reductionNeeded -= reduce;
      }
    }
  }

  // 元順に戻して返す
  return items
    .sort((a, b) => a.idx - b.idx)
    .map((it) => it.daily);
}

/**
 * 月内 record 配列から MonthlySummary を計算。
 * calcDailyListWithWeekly に集計を委ねるため、法定休日 auto-detect (労基 §35)
 * と週次残業按分は行ごとの計算と完全に一致する。
 *
 * weekStartDay は 0=日曜起算 (デフォルト)。
 *
 * 月跨ぎ週の対応:
 *   - 呼出側が extended range (月またぎ週の前後を含む records) を渡す場合、
 *     第 3 引数 monthFilter ("YYYY-MM") を指定すると、当該月の record のみを
 *     summary に積算する。週次残業按分は extended records 全体で正しく計算され、
 *     当該月に該当する日の weekly_overtime のみが total に乗る。
 *   - monthFilter を省略すると従来通り (records 全部を summary に積算)。
 *
 * @example
 * calcMonthlySummary([
 *   { work_date: "2025-01-06", start_time: "09:00", end_time: "18:00", break_minutes: 60, is_legal_holiday: false, paid_leave_type: null }, // 月 8h
 *   { work_date: "2025-01-07", start_time: "09:00", end_time: "18:00", break_minutes: 60, is_legal_holiday: false, paid_leave_type: null }, // 火 8h
 *   { work_date: "2025-01-08", start_time: "09:00", end_time: "20:00", break_minutes: 60, is_legal_holiday: false, paid_leave_type: null }, // 水 10h (日残 2h)
 *   { work_date: "2025-01-09", start_time: "09:00", end_time: "18:00", break_minutes: 60, is_legal_holiday: false, paid_leave_type: null }, // 木 8h
 *   { work_date: "2025-01-10", start_time: "09:00", end_time: "18:00", break_minutes: 60, is_legal_holiday: false, paid_leave_type: null }, // 金 8h
 * ])
 * // 週合計 42h、日残 2h、週次残業 = max(0, 42-2-40) = 0h
 */
export function calcMonthlySummary(
  records: AttendanceRecord[],
  weekStartDay: number = 0,
  monthFilter?: string,
  companyHolidayDates?: Set<string>,
): MonthlySummary {
  const summary: MonthlySummary = {
    total_work: 0,
    total_daily_overtime: 0,
    total_weekly_overtime: 0,
    total_midnight: 0,
    total_holiday: 0,
    total_absence: 0,
    total_paid_leave_days: 0,
  };

  // calcDailyListWithWeekly 経由で集計 — 法定休日 auto-detect + 週次按分が
  // 行表示と一致する。月跨ぎ週の正しい按分のため、records は extended 範囲で
  // 渡される想定でも OK (monthFilter で当該月の day だけ積算)。
  const dailies = calcDailyListWithWeekly(records, weekStartDay, companyHolidayDates);

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (monthFilter && !r.work_date.startsWith(monthFilter)) continue;
    const d = dailies[i];
    if (r.paid_leave_type === "full") summary.total_paid_leave_days += 1;
    else if (r.paid_leave_type === "half") summary.total_paid_leave_days += 0.5;
    summary.total_work += d.work_minutes;
    summary.total_daily_overtime += d.daily_overtime;
    summary.total_weekly_overtime += d.weekly_overtime;
    summary.total_midnight += d.midnight_overtime;
    summary.total_holiday += d.holiday_work;
    summary.total_absence += d.absence_minutes;
  }

  return summary;
}
