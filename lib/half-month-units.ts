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
