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
 * 群2 (返戻になる型。2026-11-14 ★居宅版チェック と合意して 同じ関数に入れた):
 *   birth_date_missing     … 生年月日が空 (01 項13 必須) → 返戻。7111 の件数・金額にも入っていた
 *   birth_date_unreadable  … 生年月日はあるが日付として読めない ("S15.3.3" 等。date-num.ts の dateNum が空欄にする) → 返戻
 *   cert_period_unreadable … 認定有効期間 (01 項17・18) が読めない (空は外さない) → 返戻
 *   kohi_futansha_missing  … 公費があるのに負担者番号が空 (公費単独 H で公費情報が無い場合も) → 返戻
 *   detail_sum_mismatch    … 明細 02 のサービス単位の合計 ≠ 限度額管理対象単位数 (10 項10) → 突合せず返戻
 *   kohi_detail_mismatch   … 明細 02 の公費対象単位の合計 ≠ 公費対象単位数 (01 項39) → 突合せず返戻 (頭打ちした人は除く = build.ts と同じ)
 *   unit_overflow          … 単位数 4 桁超 / サービス単位数 6 桁超 (IF の桁あふれ・伝送できない)
 *   service_code_invalid   … 17xxxx / 67xxxx 以外のサービスコード
 * ファイル単位 (densouLoadBlockers):
 *   ② price_history         … 価格改定の履歴を読めていない / 読み終わっていない。誉田などの事業所価格は履歴にしか無いので
 *                              用具マスタの価格で請求してしまう
 * 検査: npm run check:densou-exclude (DB 不要・負のコントロール付き)
 */

import type { FukuyoguSeikyuRow } from "./build";
import { fukuyoguLinePieces } from "./fukuyogu-amounts";
import { isUnreadableDate } from "./date-num";

export type DensouExcludeReason =
  | "benefit_rate_defaulted" | "kohi_units_over" | "billed_over_actual"
  | "birth_date_missing" | "birth_date_unreadable" | "cert_period_unreadable" | "kohi_futansha_missing" | "detail_sum_mismatch" | "kohi_detail_mismatch"
  | "unit_overflow" | "service_code_invalid";

export const DENSOU_EXCLUDE_LABEL: Record<DensouExcludeReason, string> = {
  benefit_rate_defaulted: "給付率が未設定・読めない (1 割で計算していた)",
  kohi_units_over: "公費対象単位数が保険の単位数を超えている",
  billed_over_actual: "保険請求の単位数が実績を超えている",
  birth_date_missing: "生年月日が未登録",
  birth_date_unreadable: "生年月日を日付として読めない (伝送では空欄になる)",
  cert_period_unreadable: "認定有効期間を日付として読めない (伝送では空欄になる)",
  kohi_futansha_missing: "公費の負担者番号が未登録",
  detail_sum_mismatch: "明細の単位の合計が限度額管理対象単位数と合わない",
  kohi_detail_mismatch: "明細の公費対象単位の合計が公費対象単位数と合わない",
  unit_overflow: "単位数が桁あふれ (4 桁 / 6 桁超)",
  service_code_invalid: "サービスコードが福祉用具貸与 (17/67) ではない",
};

/** 判定に使う項目 (FukuyoguSeikyuRow の一部)。群1 だけを見る呼び方 (details 等を省く) もできる */
export type DensouExcludeInput =
  Pick<FukuyoguSeikyuRow, "totalUnits" | "limitTargetUnits" | "kohiTandoku" | "kohiHobetsu" | "kohiUnits">
  & Partial<Pick<FukuyoguSeikyuRow, "birthDate" | "certStart" | "certEnd" | "kohiFutansha" | "details">>
  & {
    /** computeFukuyoguAmounts の benefitRateDefaulted をそのまま渡す */
    benefitRateDefaulted: boolean;
    /** 群2 も見るか (既定 true)。false = 群1 だけ (検査で群1 を単独に確かめるとき) */
    group2?: boolean;
  };

export function densouExcludeReasons(r: DensouExcludeInput): DensouExcludeReason[] {
  const out: DensouExcludeReason[] = [];
  if (!r.kohiTandoku && r.benefitRateDefaulted) out.push("benefit_rate_defaulted");
  const hasKohi = !!r.kohiTandoku || !!r.kohiHobetsu;
  const kohiUnits = r.kohiUnits ?? r.totalUnits;
  if (hasKohi && kohiUnits > r.totalUnits) out.push("kohi_units_over");
  const limitTarget = r.limitTargetUnits ?? r.totalUnits;
  if (r.totalUnits > limitTarget) out.push("billed_over_actual");
  if (r.group2 === false) return out;
  // ── 群2 ──
  if (!(r.birthDate ?? "").trim()) out.push("birth_date_missing");
  else if (isUnreadableDate(r.birthDate)) out.push("birth_date_unreadable");
  // 認定有効期間 (01 項17・18): 空は従来どおり (外さない)。値があるのに読めないときだけ外す
  if (isUnreadableDate(r.certStart) || isUnreadableDate(r.certEnd)) out.push("cert_period_unreadable");
  if (hasKohi && !(r.kohiFutansha ?? "").trim()) out.push("kohi_futansha_missing");
  const details = r.details ?? [];
  const detailSum = details.reduce((s, d) => s + d.units, 0);
  if (detailSum !== limitTarget) out.push("detail_sum_mismatch");
  if (hasKohi && limitTarget === r.totalUnits) {
    // build.ts の明細 02 項15 と同じ足し方: kohiPieces が行数と合えばその単位、合わなければ その行の単位
    let kohiDetailSum = 0;
    for (const d of details) {
      const lines = fukuyoguLinePieces(d);
      kohiDetailSum += d.kohiPieces && d.kohiPieces.length === lines.length
        ? d.kohiPieces.reduce((s, p) => s + p.units, 0)
        : lines.reduce((s, u) => s + u, 0);
    }
    if (kohiDetailSum !== kohiUnits) out.push("kohi_detail_mismatch");
  }
  if (details.some((d) => d.unitPer > 9999 || d.units > 999999)) out.push("unit_overflow");
  if (details.some((d) => !/^(17|67)\d{4}$/.test(d.serviceCode))) out.push("service_code_invalid");
  return out;
}

export type PriceHistoryLoadState = "loading" | "ok" | "failed";

/** ファイル単位で伝送を止める理由 (空配列 = 出してよい) */
export function densouLoadBlockers(s: { priceHistory: PriceHistoryLoadState }): string[] {
  if (s.priceHistory === "loading") return ["価格改定の履歴をまだ読み込み中です — 読み終わってから出力してください (事業所の価格は履歴にしか無いため)"];
  if (s.priceHistory === "failed") return ["価格改定の履歴を読み込めませんでした — 画面を読み直してください (このまま出すと 事業所の価格ではなく 用具マスタの価格で請求します)"];
  return [];
}

/**
 * 伝送から外した人の 1 行まとめ (人数・金額・理由ごとの人数)。外した人がいなければ null。
 * 請求画面の確認 (月次・返戻) の先頭に出す。1 人ずつの理由は buildFukuyoguDensou の warnings に別に出る
 */
export function summarizeExcluded(excluded: { reason: string; totalCost: number }[]): string | null {
  if (excluded.length === 0) return null;
  const byReason = new Map<string, number>();
  for (const e of excluded) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  const total = excluded.reduce((s, e) => s + e.totalCost, 0);
  const parts = [...byReason].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n} 名`);
  return `★ 伝送から外した人 ${excluded.length} 名・費用 計 ${total.toLocaleString()} 円 (${parts.join(" / ")}) — この人たちは このファイルでは請求されません`;
}
