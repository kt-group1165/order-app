// 出勤簿 自己入力 URL の個人トークン (server-only)
//
// 方式: DB にトークンを保存せず、HMAC-SHA256 署名で employee_id を自己証明させる。
//   version 1 (旧形式): base64url(employee_id) + "." + sig(employee_id)
//   version 2+:         base64url(employee_id) + "." + version + "." + sig(employee_id + ".v" + version)
//   ※ 旧形式を version 1 として残すことで、既存配布済み URL を壊さない。
//
// - 発行: 管理者 (authenticated) が /api/attendance-url で取得
// - 検証: /api/attendance-self が署名を timingSafeEqual で照合し、
//         attendance_url_settings (disabled / token_version) と突き合わせる
// - 失効:
//     個別 = attendance_url_settings.disabled (無効化) / token_version+1 (再発行)
//     全員一斉 = ATTENDANCE_FORM_SECRET のローテーション
//
// 注: この module は Route Handler 専用。"use client" から import しないこと。

import { createHmac, timingSafeEqual } from "node:crypto";

const SIG_BYTES = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AttendanceTokenPayload = {
  employeeId: string;
  version: number;
};

function getSecret(): string | null {
  return process.env.ATTENDANCE_FORM_SECRET || null;
}

/** 署名対象のメッセージ。version 1 は旧形式互換で employee_id のみ */
function messageOf(employeeId: string, version: number): string {
  return version <= 1 ? employeeId : `${employeeId}.v${version}`;
}

function sign(message: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(message)
    .digest()
    .subarray(0, SIG_BYTES)
    .toString("base64url");
}

/** employee_id + version から個人トークンを発行。secret 未設定なら null */
export function issueAttendanceToken(
  employeeId: string,
  version: number = 1,
): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const sig = sign(messageOf(employeeId, version), secret);
  const head = Buffer.from(employeeId).toString("base64url");
  return version <= 1 ? `${head}.${sig}` : `${head}.${version}.${sig}`;
}

/**
 * トークンを検証し、正当なら { employeeId, version } を返す。
 * 不正 / secret 未設定は null。
 * 呼出側は version を attendance_url_settings.token_version と突き合わせること。
 */
export function verifyAttendanceToken(
  token: string,
): AttendanceTokenPayload | null {
  const secret = getSecret();
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 && parts.length !== 3) return null;

  let employeeId: string;
  try {
    employeeId = Buffer.from(parts[0], "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!UUID_RE.test(employeeId)) return null;

  let version = 1;
  if (parts.length === 3) {
    if (!/^\d{1,6}$/.test(parts[1])) return null;
    version = parseInt(parts[1], 10);
    if (version < 2) return null; // version 1 は旧 2-part 形式のみ許可 (表現の一意性)
  }

  const expected = sign(messageOf(employeeId, version), secret);
  const got = parts[parts.length - 1];
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return { employeeId, version };
}
