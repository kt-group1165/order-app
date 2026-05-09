// Phase 9-5: スタッフ招待のサーバ側ヘルパー (calendar-app/lib/invitations.ts 移植)。
//
// scrypt によるパスワード hash、ランダムトークン / 初期パスワード生成。
// node:crypto のみ使用 (zero-dep)。
//
// 注: この module は Server Component / Route Handler 専用。
//     "use client" コンポーネントから import しないこと。

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

// scrypt パラメータ。N=2^14 は OWASP 2023 推奨の最低ライン。
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_LEN = 16;

// initial password 用の文字集合 (目視紛らわしい文字を除外)。
const PASSWORD_ALPHABET =
  "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PASSWORD_LENGTH = 12;

// URL 用招待トークン。32 bytes = 43 chars base64url。
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

// 初期パスワード生成 (plaintext)。発行直後に 1 回だけ表示する用途。
export function generateInitialPassword(): string {
  const bytes = randomBytes(PASSWORD_LENGTH * 2);
  let out = "";
  let i = 0;
  while (out.length < PASSWORD_LENGTH && i < bytes.length) {
    const b = bytes[i++];
    if (b < Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length) {
      out += PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length];
    }
  }
  if (out.length < PASSWORD_LENGTH) {
    while (out.length < PASSWORD_LENGTH) {
      out += PASSWORD_ALPHABET[randomBytes(1)[0] % PASSWORD_ALPHABET.length];
    }
  }
  return out;
}

// password を hash 化。staff_invitations.initial_password_hash 形式: `<saltHex>:<hashHex>`
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_LEN);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

// stored hash と入力値の照合 (timingSafeEqual)。
export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  if (salt.length !== SCRYPT_SALT_LEN || expected.length !== SCRYPT_KEYLEN) {
    return false;
  }

  const actual = await scrypt(password, salt, SCRYPT_KEYLEN);
  return timingSafeEqual(actual, expected);
}
