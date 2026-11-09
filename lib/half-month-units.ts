/**
 * 福祉用具貸与の半月按分ルール (端数の丸め)。
 *
 * 月の前半 (1〜15日) にしか貸与日が無い、または後半 (16〜末日) にしか
 * 貸与日が無いときは、所定単位数の半分を算定する。両方にかかれば満額、
 * どちらにもかからなければ 0。
 *
 * ⚠ 端数 (単位が奇数) をどちらの半月に寄せるかは、告示に明記が無い
 *   (2026-09-04 web確認: 老企第36号を引用する各自治体Q&A は「日割り計算
 *   または半月単位の計算方法で請求しても差し支えない」とのみ述べ、
 *   端数処理そのものは事業所の運営規程・重要事項説明書に定める事項と
 *   されている)。KT Group の重要事項説明書 (ContractDocumentsModal.tsx)
 *   には端数処理の記載が無い。
 *   → **どちらが制度上「正しい」かは主張しない。**
 *     「1 か所にまとめて、どこを見ても同じ値になる」ことだけを保証する。
 *
 * ⚠ 2026-09-04 実測: 実データでは半月按分そのものが**一度も発火していない**
 *   (order_items 4,669 行のうち rental_start_date が全件 "月の1日"、
 *   terminated も 1 件のみでその貸与単位数は偶数 (80 単位) だったため、
 *   floor/ceil/round のどれでも同じ値になっていた)。
 *   → 以前は前半=floor・後半=ceil (order-item-helpers.ts の calcMonthUnits)
 *     と、前半=後半=round (BillingTab.tsx の getUnits 等) の 2 系統が
 *     混在しており、月途中の搬入・撤去を記録した瞬間に不一致が起きる
 *     状態だった (現在は本関数に統一。round 系統を残した — 実際に
 *     国保連へ伝送される計算がこちらだったため)。
 */
export function halfMonthUnits(fullUnits: number, firstHalf: boolean, secondHalf: boolean): number {
  if (firstHalf && secondHalf) return fullUnits;
  if (!firstHalf && !secondHalf) return 0;
  return Math.round(fullUnits / 2);
}

// ── 休止・入院を除いた「貸与日」(2026-11-09 FY-PZ) ────────────────────────────
/**
 * 日付の範囲 (両端含む "YYYY-MM-DD")。to = null は月末まで (終わりが未定の入院 等)。
 * 休止 (order_item_pauses) と入院 (client_hospitalizations) の両方をこの形で渡す。
 */
export interface DateRange {
  from: string;
  to: string | null;
}

const daysOfYm = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * 当月の日 (1..N) のうち「貸与日」の印 (index 0 は使わない)。純関数。
 *   貸与日 = 貸与開始日〜終了日 (両端含む。null = 制限なし) に入り、excluded (休止・入院) のどれにも入らない日。
 * 日付は "YYYY-MM-DD" の文字列比較で判定する (Date を作らない = タイムゾーンで 1 日ずれない)。
 */
export function rentalDayMask(
  rentalStart: string | null | undefined,
  rentalEnd: string | null | undefined,
  ym: string,
  excluded: readonly DateRange[] = [],
): boolean[] {
  const n = daysOfYm(ym);
  const s = (rentalStart ?? "").slice(0, 10);
  const e = (rentalEnd ?? "").slice(0, 10);
  const ex = excluded.map((r) => ({ from: (r.from ?? "").slice(0, 10), to: (r.to ?? "").slice(0, 10) }));
  const mask = Array.from({ length: n + 1 }, () => false);
  for (let d = 1; d <= n; d++) {
    const day = `${ym}-${String(d).padStart(2, "0")}`;
    if (s && day < s) continue;
    if (e && day > e) continue;
    if (ex.some((r) => (!r.from || day >= r.from) && (!r.to || day <= r.to))) continue;
    mask[d] = true;
  }
  return mask;
}

/**
 * 半月按分の判定 (前半 1〜15日 / 後半 16日〜末日 にそれぞれ貸与日があるか)。純関数。
 * halfMonthUnits(base, firstHalf, secondHalf) にそのまま渡す。
 *
 * ⚠ 休止日は貸与日に数えない。ほのぼの福祉用具の提供票 (2026-04〜10・実績行) で確認 (2026-11-09):
 *   月の途中に印の無い日がある (休止) 行 279 行のうち 277 行で、日割区分 (全額/半額) が
 *   「印のある日だけで前半・後半を判定」した結果と一致 (全額 259 / 半額 18)。
 *   例外 2 行は 半額 なのに両方の半月に印がある (小出 和子 2026-08: 1日 と 19〜31日 / 青栁 操子 2026-10: 1〜3日 と 28〜31日)。
 *   休止の無い行でも 42,800 行中 124 行は日割区分が印と食い違う (手で日割区分を選んだ行と思われる) ので、
 *   この 2 行もそれと同じ扱いで、規則には入れない。
 * ⚠ 休止が月の中だけ (貸与の最初と最後の日に印がある) なら、休止を除いても除かなくても判定は変わらない。
 *   変わるのは 休止が月初または月末にかかる台 (例 前月から借りていて 9/1〜9/20 休止 → 後半だけ → 半額)。
 */
export function halfMonthFlags(
  rentalStart: string | null | undefined,
  rentalEnd: string | null | undefined,
  ym: string,
  excluded: readonly DateRange[] = [],
): { firstHalf: boolean; secondHalf: boolean } {
  const mask = rentalDayMask(rentalStart, rentalEnd, ym, excluded);
  let firstHalf = false;
  let secondHalf = false;
  for (let d = 1; d < mask.length; d++) {
    if (!mask[d]) continue;
    if (d <= 15) firstHalf = true;
    else secondHalf = true;
  }
  return { firstHalf, secondHalf };
}

/** 入院記録 (client_hospitalizations の行) を DateRange にする。discharge_date = null は月末まで */
export function hospitalizationRanges(hs: readonly { admission_date: string; discharge_date: string | null }[]): DateRange[] {
  return hs.map((h) => ({ from: h.admission_date, to: h.discharge_date }));
}
