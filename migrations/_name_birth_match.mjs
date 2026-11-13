/**
 * 氏名だけで既存 client を引くとき・候補が複数のときの「生年月日で決める」決まり (2026-11-13 user 方針・★福祉用具新ソフト経由)。
 * rebuild_rentals_from_teikyohyo.mjs (引き当て) と create_missing_clients_from_teikyohyo.mjs (作る対象) が同じ判定を使う。
 *
 *   - 利用者マスタ (ほのぼの) と DB の両方に生年月日がそろっていて、一致する候補が 1 人だけ → その人 (pick)
 *   - 両方そろっていて、どの候補とも違う → 引かない。新規の候補 (new)
 *   - 利用者マスタ側の生年月日が無い / 仮 (2020 年以降 = 登録日) → 引かない。判断が要る (judge)
 *   - 一致する候補が無く、DB 側に生年月日が無い / 仮の候補がいる → 判断が要る (judge)
 *   - 生年月日まで同じ候補が 2 人以上 → 判断が要る (judge)
 * 背景: 誉田の DRY RUN で「氏名だけ (全利用者で一意)」で引いた 80 名のうち 20 名は生年月日が違う別人だった。
 */

/** ほのぼのの仮の生年月日 (自費だけの人は 登録日 が入る)。これ以降は生年月日として扱わない */
export const FAKE_BIRTH_FROM = "2020-01-01";

/** "YYYY-MM-DD" (先頭 10 文字) にそろえる。仮・空は null */
export function realBirth(b) {
  const s = String(b ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s < FAKE_BIRTH_FROM ? s : null;
}

/**
 * @param {{ id: string, birth_date?: string | null }[]} cands  候補 (削除済みは呼ぶ側で外す)
 * @param {string | null | undefined} masterBirth  利用者マスタの生年月日 (YYYY-MM-DD)
 * @returns {{ verdict: "pick" | "new" | "judge", client: any, reason: string }}
 */
export function decideByBirth(cands, masterBirth) {
  const mb = realBirth(masterBirth);
  if (!cands.length) return { verdict: "new", client: null, reason: "候補なし" };
  if (!mb) return { verdict: "judge", client: null, reason: masterBirth ? `利用者マスタの生年月日 ${masterBirth} が仮の値` : "利用者マスタに生年月日が無い" };
  const match = cands.filter((c) => realBirth(c.birth_date) === mb);
  if (match.length === 1) return { verdict: "pick", client: match[0], reason: "生年月日が一致" };
  if (match.length > 1) return { verdict: "judge", client: null, reason: `生年月日まで同じ候補が ${match.length} 人` };
  if (cands.every((c) => realBirth(c.birth_date))) return { verdict: "new", client: null, reason: `生年月日が違う (マスタ ${mb} / DB ${cands.map((c) => c.birth_date).join(",")})` };
  return { verdict: "judge", client: null, reason: `DB 側に生年月日が無い・仮の候補がいる (マスタ ${mb} / DB ${cands.map((c) => c.birth_date ?? "空").join(",")})` };
}
