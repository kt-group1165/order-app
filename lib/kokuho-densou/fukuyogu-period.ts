/**
 * 福祉用具 伝送 基本 (01) 項21 開始年月日 を 利用者の貸与履歴から決める (純関数)。
 *
 *   開始 = その利用者の介護保険の貸与のうち 最初の開始日 が当月内なら その日 (月途中から増えた用具は開始にしない)。
 *   ⚠ 移行の仮置き (2026-04-01 = 4/1 以前から借りている台) は本当の開始ではないので開始にしない。
 *
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
  const starts = allRentals.map((r) => (r.rentalStart ?? "").slice(0, 10)).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
  const firstStart = starts[0] ?? null;
  if (!firstStart || firstStart === FUKUYOGU_MIGRATION_START) return null;
  return firstStart >= first && firstStart <= last ? firstStart : null;
}
