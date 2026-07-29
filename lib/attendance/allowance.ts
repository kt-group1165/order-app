// 統括営業本部の出勤簿手当 (電話当番・土日祝対応)。
//
// 仕様 (2026-07-29 user 確定、従来 Excel 出勤簿の踏襲):
//   - 電話当番: 1回あたりの単価は職員ごと (payroll_employees.phone_duty_pay、既定 3,000 円)。
//     村上 3,000 円 / 安川・三枝 1,500 円。将来的に揃える方針だが当面は職員別。
//   - 土日祝対応: 件数入力。1件 6,000 円 / 2件以上 10,000 円 (全員共通)
//   - 併給しない: 両方該当の日は土日祝対応のみ (Excel も 電話○+土日祝2 → 10,000)
//
// 入力 UI・計算とも office_type='本社' の事業所でのみ有効。

/** 電話当番の既定単価 (職員に設定が無い場合) */
export const DEFAULT_PHONE_DUTY_PAY = 3000;
export const HOLIDAY_SUPPORT_PAY_1 = 6000;
export const HOLIDAY_SUPPORT_PAY_2PLUS = 10000;

/**
 * 1日ぶんの手当額 (円)。併給しない = 土日祝対応があれば電話当番は加算しない。
 * @param phoneDutyPay 電話当番の単価 (職員ごと)。省略時は既定 3,000 円
 */
export function calcDailyAllowance(
  phoneDuty: boolean,
  holidaySupportCount: number,
  phoneDutyPay: number = DEFAULT_PHONE_DUTY_PAY,
): number {
  if (holidaySupportCount >= 2) return HOLIDAY_SUPPORT_PAY_2PLUS;
  if (holidaySupportCount === 1) return HOLIDAY_SUPPORT_PAY_1;
  if (phoneDuty) return phoneDutyPay;
  return 0;
}

export type AllowanceSummary = {
  /** 電話当番の回数 (土日祝対応と重なった日も回数には数える) */
  phoneDutyDays: number;
  /** 土日祝対応の合計件数 */
  holidaySupportTotal: number;
  /** 土日祝対応があった日数 */
  holidaySupportDays: number;
  /** 手当合計 (円) */
  totalPay: number;
};

export function summarizeAllowance(
  rows: { phone_duty: boolean; holiday_support_count: number }[],
  phoneDutyPay: number = DEFAULT_PHONE_DUTY_PAY,
): AllowanceSummary {
  const s: AllowanceSummary = {
    phoneDutyDays: 0,
    holidaySupportTotal: 0,
    holidaySupportDays: 0,
    totalPay: 0,
  };
  for (const r of rows) {
    if (r.phone_duty) s.phoneDutyDays++;
    if (r.holiday_support_count > 0) {
      s.holidaySupportDays++;
      s.holidaySupportTotal += r.holiday_support_count;
    }
    s.totalPay += calcDailyAllowance(r.phone_duty, r.holiday_support_count, phoneDutyPay);
  }
  return s;
}
