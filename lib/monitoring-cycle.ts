// 福祉用具 モニタリングの周期計算 (純関数のみ / DB・ブラウザ依存なし)
//
// ⚠ **画面 (app/[tenant]/MonitoringTab.tsx) から切り出した。**
//   component の中に置いたままだと、import しただけで supabase のブラウザ
//   クライアントが起動して Node で動かず、**検証ハーネスが呼べない**。
//   逐語コピーで検査を書くと片方だけ直したときに乖離するので
//   (2026-09-03 に移動支援で「ハーネスが本番と別の表を検証していた」事故があった)、
//   純関数を独立した module に出して **画面とハーネスが同じ関数を使う**。

/** モニタリングの周期 (ヶ月)。福祉用具貸与は 6 ヶ月に 1 回以上 */
export const MONITORING_INTERVAL_MONTHS = 6;

/**
 * モニタリングの次回予定月 = 基準月の 6 ヶ月後 ("YYYY-MM")。
 *
 * ⚠ 年またぎを月数の通算で扱う (Date を経由しない)。
 *   `new Date(y, m + 6)` はローカルタイムゾーンに依存し、月末日の繰り上がりも起きる。
 *
 * @example
 * calcNextDueMonth("2026-06") // "2026-12"
 * calcNextDueMonth("2026-07") // "2027-01"  (年またぎ)
 */
export function calcNextDueMonth(base: string): string {
  const [y, m] = base.split("-").map(Number);
  const total = y * 12 + m - 1 + MONITORING_INTERVAL_MONTHS;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}
