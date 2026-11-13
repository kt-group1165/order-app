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

/**
 * 福祉用具 伝送 基本 (01) 項22 中止年月日 の案 (純関数)。★ 2026-11-13 時点で 請求画面には渡していない (項23 中止理由が決められないため)。
 *
 *   中止 = 当月に貸与がある人で、その貸与が全部 当月内に終わり、月末を越えて続く台が無く、
 *          翌月に新しく始まる台も無い (= 一時中断して翌月に再開する人は中止にしない) なら 最後の終了日。
 *
 * ほのぼの KK261004 (提供 2026-09・01 レコード 1,116 件・中止あり 27 件) との突合:
 *   旧案 (翌月の開始を見ない)  一致 26 / 当方だけ 13 / ほのぼのだけ 1
 *   この案                    一致 24 / 当方だけ  5 / ほのぼのだけ 3
 *   当方だけ 5 (田近 康雄・勝畑 百里子・小川 敏江・鈴木 道子・加藤 春夫): ほのぼのの明細の日数が終了日まで切れていない
 *     (= ほのぼのが請求した時点では まだ終了になっていなかった。終了を後から入れた)。規則の外。
 *   ほのぼのだけ 3: 菊池 龍也・河名 公平 (理由 3 = 入院。翌月に再開しても中止にしている) /
 *     河田 都美子 (理由 1。認定の終了日 9/30 を中止にしている。ただし 9 月に認定が終わる 35 名のうち中止は この 1 名だけ)。
 * ⚠ 項23 中止理由 (1 / 3 入院 / 4 死亡 / 5 その他。27 件の内訳 1:5 / 3:7 / 4:7 / 5:8) は 当方に材料が無い
 *   (client_hospitalizations は 0 行・死亡日も持っていない)。中止年月日だけ入れて理由を空にはできないので、
 *   使うなら 理由を人が選ぶ欄が要る。調査: 診断 scripts/fukuyogu-densou-honobono-diff.mts。
 */
export function fukuyoguServiceStopDate(allRentals: readonly RentalSpan[], ym: string): string | null {
  const [y, m] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const last = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const nextYm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  const spans = allRentals
    .map((r) => ({ s: (r.rentalStart ?? "").slice(0, 10), e: (r.rentalEnd ?? "").slice(0, 10) || null }))
    .filter((r) => valid(r.s));
  const inMonth = spans.filter((r) => r.s <= last && (r.e == null || r.e >= first));
  if (inMonth.length === 0) return null;
  if (!inMonth.every((r) => r.e != null && r.e <= last)) return null;
  if (spans.some((r) => r.s <= last && (r.e == null || r.e > last))) return null;
  if (spans.some((r) => r.s.slice(0, 7) === nextYm)) return null;
  return inMonth.map((r) => r.e as string).sort().at(-1) ?? null;
}
