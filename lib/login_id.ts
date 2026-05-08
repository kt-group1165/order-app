// calendar-app の lib/login_id.ts と同じ。order-app login で login_id 受付を
// 可能にするため移植 (4 app で同一 ロジック)。詳細はそちら参照。

const SYNTHETIC_EMAIL_DOMAIN = "kt-staff.invalid";

export const LOGIN_ID_REGEX = /^[a-z][a-z0-9.\-]{3,23}$/;

export function isValidLoginId(loginId: string): boolean {
  return LOGIN_ID_REGEX.test(loginId);
}

export function loginIdToSyntheticEmail(loginId: string): string {
  if (!isValidLoginId(loginId)) {
    throw new Error(`invalid login_id: ${loginId}`);
  }
  return `${loginId}@${SYNTHETIC_EMAIL_DOMAIN}`;
}
