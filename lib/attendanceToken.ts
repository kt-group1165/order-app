// 出勤簿 自己入力 URL の個人トークン (server-only)
//
// 方式: DB にトークンを保存せず、HMAC-SHA256 署名で employee_id を自己証明させる。
//   token = base64url(employee_id) + "." + base64url(HMAC(employee_id, secret) 先頭16byte)
//
// - 発行: 管理者 (authenticated) が /api/attendance-url で取得
// - 検証: /api/attendance-self が署名を timingSafeEqual で照合
// - 失効: ATTENDANCE_FORM_SECRET のローテーション (= 全員一斉。個別失効は不可。
//   個別失効が必要になったら token テーブル方式に移行する)
//
// 注: この module は Route Handler 専用。"use client" から import しないこと。

import { createHmac, timingSafeEqual } from "node:crypto";

const SIG_BYTES = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function getSecret(): string | null {
  return process.env.ATTENDANCE_FORM_SECRET || null;
}

function sign(employeeId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(employeeId)
    .digest()
    .subarray(0, SIG_BYTES)
    .toString("base64url");
}

/** employee_id から個人トークンを発行。secret 未設定なら null */
export function issueAttendanceToken(employeeId: string): string | null {
  const secret = getSecret();
  if (!secret) return null;
  return `${Buffer.from(employeeId).toString("base64url")}.${sign(employeeId, secret)}`;
}

/** トークンを検証し、正当なら employee_id を返す。不正 / secret 未設定は null */
export function verifyAttendanceToken(token: string): string | null {
  const secret = getSecret();
  if (!secret) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  let employeeId: string;
  try {
    employeeId = Buffer.from(token.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (!UUID_RE.test(employeeId)) return null;
  const expected = sign(employeeId, secret);
  const got = token.slice(dot + 1);
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  return employeeId;
}
