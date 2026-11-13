/**
 * 福祉用具の伝送で「この利用者を出してよいか」を決める純関数 (2026-11-14 群1)。
 *
 * 発端: order-app の「警告して続行」の棚卸し (92 箇所) で、続行すると金額が静かにずれる (返戻にならず気づけない) ものが
 *   警告だけで伝送ファイルを作っていた。保険者番号欠落 (build.ts 冒頭) と同じく「その人だけ外して警告」にそろえる。
 *   ファイル全体は止めない (1 人のために全員の請求を止めない)。外した人は 件数と理由の内訳を 画面と出力に出す
 *   (静かに外すと 今度は請求漏れを作るため)。
 *
 * 人ごとの理由 (densouExcludeReasons):
 *   ① benefit_rate_defaulted … 給付率が未設定・読めず 既定 1 割 (90) で計算した。2・3 割の人を 1 割で請求しても返戻にならない
 *   ③ kohi_units_over       … 公費対象単位数 > 保険の単位数 (呼出側の計算不整合 = 公費の過大請求)
 *   ④ billed_over_actual    … 保険請求の単位数 > 実績 (限度額管理対象単位数) (計算不整合 = 過大請求)
 * ファイル単位 (densouLoadBlockers):
 *   ② price_history         … 価格改定の履歴を読めていない / 読み終わっていない。誉田などの事業所価格は履歴にしか無いので
 *                              用具マスタの価格で請求してしまう
 * 検査: npm run check:densou-exclude (DB 不要・負のコントロール付き)
 */

export type DensouExcludeReason = "benefit_rate_defaulted" | "kohi_units_over" | "billed_over_actual";

export const DENSOU_EXCLUDE_LABEL: Record<DensouExcludeReason, string> = {
  benefit_rate_defaulted: "給付率が未設定・読めない (1 割で計算していた)",
  kohi_units_over: "公費対象単位数が保険の単位数を超えている",
  billed_over_actual: "保険請求の単位数が実績を超えている",
};

/** 判定に使う項目 (FukuyoguSeikyuRow の一部) */
export interface DensouExcludeInput {
  totalUnits: number;
  limitTargetUnits?: number | null;
  kohiTandoku?: boolean;
  kohiHobetsu?: string | null;
  kohiUnits?: number | null;
  /** computeFukuyoguAmounts の benefitRateDefaulted をそのまま渡す */
  benefitRateDefaulted: boolean;
}

export function densouExcludeReasons(r: DensouExcludeInput): DensouExcludeReason[] {
  const out: DensouExcludeReason[] = [];
  if (!r.kohiTandoku && r.benefitRateDefaulted) out.push("benefit_rate_defaulted");
  const hasKohi = !!r.kohiTandoku || !!r.kohiHobetsu;
  const kohiUnits = r.kohiUnits ?? r.totalUnits;
  if (hasKohi && kohiUnits > r.totalUnits) out.push("kohi_units_over");
  const limitTarget = r.limitTargetUnits ?? r.totalUnits;
  if (r.totalUnits > limitTarget) out.push("billed_over_actual");
  return out;
}

export type PriceHistoryLoadState = "loading" | "ok" | "failed";

/** ファイル単位で伝送を止める理由 (空配列 = 出してよい) */
export function densouLoadBlockers(s: { priceHistory: PriceHistoryLoadState }): string[] {
  if (s.priceHistory === "loading") return ["価格改定の履歴をまだ読み込み中です — 読み終わってから出力してください (事業所の価格は履歴にしか無いため)"];
  if (s.priceHistory === "failed") return ["価格改定の履歴を読み込めませんでした — 画面を読み直してください (このまま出すと 事業所の価格ではなく 用具マスタの価格で請求します)"];
  return [];
}
