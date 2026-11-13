/**
 * 福祉用具 伝送 基本 (01) 項21 開始年月日 を 利用者の貸与履歴から決める (純関数)。
 *
 *   開始 = 当月内に始まった貸与のうち、その前日に 他の介護保険の貸与が 1 台も無かった (= 新規 or 空白をはさんで再開) 最初の日。
 *     月途中に用具が増えただけ (前日に他の台が続いている) は開始にしない。
 *     ほのぼのも 再開を開始にしている (岸 敏子 8/28 で全部終了 → 9/9 再開 = 開始 9/9。KK261004 で 11 名確認)。
 *   ⚠ 移行の仮置き (2026-04-01 = 4/1 以前から借りている台) は本当の開始ではないので開始にしない。
 *
 * ⚠ 完全には再現できない: ほのぼのの開始年月日は 職員の入力値で、空白の長さでは決まっていない
 *   (加藤 春夫 8/24 終了→9/8 再開 = 開始あり / 森本 緑 8/21 終了→9/4 再開 = 開始なし)。
 *   毎月数日だけ借りる人 (ショートステイ前後等) も ほのぼのは開始にしない。
 *   KK261004 で: 規則なし 0 一致・食い違い 53 → 最初の開始のみ 38 一致・15 → 空白後の再開も開始 46 一致・7 (うち当方だけ 5)。
 * 2026-11-13: 貸与の開始日を ほのぼのの提供票 (日ごとの実績) から組み直したので使えるようになった。
 *   ほのぼの KK261004 (提供 2026-09) との突合: 一致 38 / 食い違い 0 / ほのぼのだけ 15 (scripts/fukuyogu-densou-honobono-diff.mts)。
 *   中止 (項22) は 一致 26 に対し「当方だけ」13 があるので まだ渡さない。
 */
export const FUKUYOGU_MIGRATION_START = "2026-04-01";

export type RentalSpan = { rentalStart: string | null | undefined; rentalEnd?: string | null | undefined };

export function fukuyoguServiceStartDate(allRentals: readonly RentalSpan[], ym: string): string | null {
  const first = `${ym}-01`;
  const [y, m] = ym.split("-").map(Number);
  const last = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const spans = allRentals
    .map((r) => ({ s: (r.rentalStart ?? "").slice(0, 10), e: (r.rentalEnd ?? "").slice(0, 10) || null }))
    .filter((r) => valid(r.s));
  const dayBefore = (d: string) => {
    const [yy, mm, dd] = d.split("-").map(Number);
    return new Date(Date.UTC(yy, mm - 1, dd) - 86400000).toISOString().slice(0, 10);
  };
  const candidates = [...new Set(spans.map((r) => r.s).filter((s) => s >= first && s <= last))].sort();
  for (const s of candidates) {
    if (s === FUKUYOGU_MIGRATION_START) continue;
    const prev = dayBefore(s);
    const activeBefore = spans.some((r) => r.s <= prev && (r.e == null || r.e >= prev));
    if (!activeBefore) return s;
  }
  return null;
}
