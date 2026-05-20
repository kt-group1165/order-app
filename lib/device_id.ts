// Phase 11c: 端末を一意に識別する client cookie。
//
// 仕様:
//   - cookie 名 kt_device_id (HttpOnly=false / Path=/ / Max-Age=2 年)
//   - 値は UUIDv4 (browser crypto.randomUUID で生成)
//   - 初回 access 時に未設定なら生成
//   - サーバ API には body の device_id フィールドで送る
//
// 注意:
//   - 完全な端末固有 ID ではなく「同一ブラウザ profile での永続 ID」
//   - cookie 消去すると新規 device 扱いになり再承認必要
//   - 1 端末で複数 user が使う場合も同じ device_id を共有 (= admin が user 別に承認)

const COOKIE_NAME = "kt_device_id";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2; // 2 年

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function writeCookie(name: string, value: string): void {
  if (typeof document === "undefined") return;
  // Secure flag は https 配信前提 (Vercel)
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; Secure; SameSite=Lax`;
}

/**
 * 現在のブラウザに紐づく device_id を返す。未設定なら生成して cookie に保存。
 */
export function ensureDeviceId(): string {
  const existing = readCookie(COOKIE_NAME);
  if (existing) return existing;
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? (crypto as Crypto).randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeCookie(COOKIE_NAME, uuid);
  return uuid;
}

/**
 * UA から人間に読みやすい label を生成。"iPhone Safari" / "Windows Chrome" 等。
 * 完全な端末識別子ではないが、admin が「どの端末か」目視確認する用。
 */
export function detectDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Unknown";
  const ua = navigator.userAgent || "";
  const platform =
    /iPhone/i.test(ua)
      ? "iPhone"
      : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
      ? "Android"
      : /Macintosh/i.test(ua)
      ? "Mac"
      : /Windows/i.test(ua)
      ? "Windows"
      : /Linux/i.test(ua)
      ? "Linux"
      : "Unknown";
  const browser = /Edg\//i.test(ua)
    ? "Edge"
    : /Chrome\//i.test(ua) && !/Edg\//i.test(ua)
    ? "Chrome"
    : /Firefox\//i.test(ua)
    ? "Firefox"
    : /Safari\//i.test(ua)
    ? "Safari"
    : "Browser";
  return `${platform} ${browser}`;
}
