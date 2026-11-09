// overtime-limit.ts
// 月間残業枠 (自社基準 35h) と、法定休日・深夜の「通常残業への換算」。
// 出勤簿の入力画面 (AttendanceTab) と 残業集計 (AttendanceSummaryView) で同じ値を使うため切り出した。

import type { MonthlySummary } from "./attendance-calc";

// 月間の時間外 上限 (自社基準)。36協定の法定上限 45h より手前に置いた運用ライン。
// 「通常残業を何時間できるか」を基準にした枠。
export const MONTHLY_OVERTIME_LIMIT_HOURS = 35;
export const MONTHLY_OVERTIME_LIMIT_MIN = MONTHLY_OVERTIME_LIMIT_HOURS * 60;

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
export function holidayToOvertimeEquiv(min: number): number {
  return Math.round(min * (RATE_HOLIDAY / RATE_OVERTIME));
}

/** 深夜労働の分数を、上乗せぶんだけ通常残業の分数に換算 */
export function midnightToOvertimeEquiv(min: number): number {
  return Math.round(min * (RATE_MIDNIGHT_EXTRA / RATE_OVERTIME));
}

export type OvertimeConsumption = {
  /** 通常残業 (1日8h超 + 週40h超) の実時間 (分) */
  overtime: number;
  holidayEquiv: number;
  midnightEquiv: number;
  /** 35h 枠の消費合計 (通常残業換算・分) */
  consumed: number;
  /** あと何分 通常残業できるか (負 = 超過) */
  remaining: number;
  overLimit: boolean;
  /** 80% 以上 (超過は含まない) */
  nearLimit: boolean;
  /** 消費率 0〜1 */
  ratio: number;
};

export function overtimeConsumption(summary: MonthlySummary): OvertimeConsumption {
  const overtime = summary.total_daily_overtime + summary.total_weekly_overtime;
  const holidayEquiv = holidayToOvertimeEquiv(summary.total_holiday);
  const midnightEquiv = midnightToOvertimeEquiv(summary.total_midnight);
  const consumed = overtime + holidayEquiv + midnightEquiv;
  const remaining = MONTHLY_OVERTIME_LIMIT_MIN - consumed;
  const overLimit = remaining < 0;
  const ratio = Math.min(1, consumed / MONTHLY_OVERTIME_LIMIT_MIN);
  return {
    overtime,
    holidayEquiv,
    midnightEquiv,
    consumed,
    remaining,
    overLimit,
    nearLimit: !overLimit && ratio >= 0.8,
    ratio,
  };
}
