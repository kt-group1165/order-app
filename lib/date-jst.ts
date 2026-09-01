/**
 * 日付を「暦の日付」として扱うためのヘルパ。
 *
 * ── なぜ要るか ──────────────────────────────────────────────────────────
 *   `new Date(y, m, 0).toISOString()` は **必ず 1 日ズレる**。
 *
 *     new Date(2026, 6, 0)            ローカル時刻の 2026-06-30 00:00 を作る
 *     .toISOString()                  それを UTC に直す = 2026-06-29T15:00:00Z
 *     .slice(0, 10)                   → "2026-06-29"   ← 6 月末のつもりが 29 日
 *
 *   JST は UTC+9 なので、ローカル 0 時は UTC では前日 15 時になる。
 *   **時刻に関係なく 24 時間ずっとズレる**（0〜9 時だけの問題ではない）。
 *
 *   これが動くのはブラウザなので、**Vercel のサーバ TZ が UTC かどうかは無関係**。
 *   利用者の PC が JST である限り必ずズレる。
 *
 *   実害: 月末日ちょうどに始まる認定・公費・入院が対象月から漏れる。
 *         2026-08-31 時点で **月末開始の認定が 38 件**あった。
 *
 * ── 使い方 ──────────────────────────────────────────────────────────────
 *     monthEndYmd("2026-06")   → "2026-06-30"
 *     monthEndYmd(2026, 6)     → "2026-06-30"
 *     todayYmd()               → 実行した人の暦での今日
 *
 * ⚠ `toISOString()` を日付文字列を作る目的で使わないこと。UTC に変換されるため。
 *   日付が欲しいときは Date.UTC で組むか、この module を使う。
 */

/** 数値を 2 桁 0 埋め */
const p2 = (n: number): string => String(n).padStart(2, "0");

/**
 * 対象月の末日を "YYYY-MM-DD" で返す。
 *
 *   monthEndYmd("2026-06")  monthEndYmd(2026, 6)  どちらでもよい
 *
 * ⚠ Date.UTC で組むので TZ に影響されない。month は 1〜12（0 始まりではない）。
 */
export function monthEndYmd(ym: string): string;
export function monthEndYmd(year: number, month: number): string;
export function monthEndYmd(a: string | number, b?: number): string {
  let year: number;
  let month: number;
  if (typeof a === "string") {
    const [y, m] = a.split("-").map(Number);
    year = y; month = m;
  } else {
    year = a; month = b as number;
  }
  // Date.UTC(y, month, 0) = その月の 0 日目 = 前月の末日。month は 0 始まりなので
  // 1〜12 をそのまま渡すと「対象月の末日」になる。
  const d = new Date(Date.UTC(year, month, 0));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** 対象月の初日 "YYYY-MM-01"。対称性のために置く。 */
export function monthStartYmd(ym: string): string {
  return `${ym}-01`;
}

/**
 * 「今日」を暦の日付で返す。
 *
 * ⚠ `new Date().toISOString().slice(0,10)` は JST の 0〜9 時に前日を返す。
 *   納品日・レンタル開始日をそれで書くと、朝 7:30 の操作が前日付になり、
 *   福祉用具は月額なので 1 ヶ月分の誤請求につながる。
 */
export function todayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

/**
 * "YYYY-MM-DD" に日数を足す（負数で引く）。
 *
 * ⚠ `new Date(t + n*86400000)` をローカル Date でやると夏時間のある地域でズレる。
 *   Date.UTC で組めば 1 日は必ず 86400000ms なので安全。
 */
export function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

/** Date を和暦の「令和N年N月N日」表記に変換 (帳票の日付表示用)。 */
export function toJapaneseEra(date: Date): string {
  if (isNaN(date.getTime())) return "";
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  if (y > 2019 || (y === 2019 && m >= 5)) return `令和${y - 2018}年${m}月${d}日`;
  if (y > 1989 || (y === 1989 && m >= 1 && d >= 8)) return `平成${y - 1988}年${m}月${d}日`;
  return `${y}年${m}月${d}日`;
}

/** 年月を和暦の「令和N年N月」表記に変換。 */
export function toJapaneseEraYM(year: number, month: number): string {
  if (year > 2019 || (year === 2019 && month >= 5)) return `令和${year - 2018}年${month}月`;
  if (year > 1989) return `平成${year - 1988}年${month}月`;
  return `${year}年${month}月`;
}
