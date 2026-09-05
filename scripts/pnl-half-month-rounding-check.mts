/**
 * 月次損益(SalesReportTab)の半月按分が、福祉用具貸与の請求計算 (getUnits /
 * lib/half-month-units.ts) と**独立した第3の丸め方式**であることの記録
 * (DB不使用・分析のみ)
 *
 *   npx tsx scripts/pnl-half-month-rounding-check.mts
 *
 * ── 何が違うか ──────────────────────────────────────────────────────────
 *   請求 (8084f22で統一済み): 単位(=円/10 を round) の半分を round → ×10 して円に戻す
 *     halfMonthUnits(Math.round(price/10), ...) * 10
 *   月次損益 (BillingTab.tsx SalesReportTab, 約1997行): 円のまま half ? 0.5 : 1 を掛けて round
 *     Math.round(price * (half ? 0.5 : 1))
 *
 *   ★ price が 20 の倍数でないと、この2つは最大5円ずれる
 *     (単位への丸めと 円への丸め の「二重丸め」の違い)。
 *
 * ── これは直すべきバグか ──────────────────────────────────────────────
 *   ★ 断定しない。月次損益は「発生ベースの社内管理会計」、請求は
 *   「実際に国保連へ出す金額」で **目的が違う**。管理会計側が請求と
 *   1円まで一致している必要は制度上ない。ただし「同じ半月按分という
 *   概念を2箇所で別々に実装している」こと自体は記録しておく (規律3-14型)。
 *
 * ── 実データでの発生状況 (2026-09-05実測) ──────────────────────────────
 *   介護 order_items 4,669件中:
 *     開始日>=16 (SalesReportTabのhalf発火・開始側): 0件
 *     終了日<=15 (同・終了側): 1件 (rental_price=800円・mod20=0 → ★実際には発散していない)
 *   rental_price % 20 の分布: mod20=0が4,449件 / mod20=10が220件
 *     (mod20=10のものでhalf分岐が発火すれば5円の差が出るが、現状は0件)
 *   → 現時点の実害は0円。ただし220件が「いつ発火してもおかしくない」座席にいる。
 */
function halfMonthUnitsRounding(price: number): number {
  const units = Math.round(price / 10);
  return Math.round(units / 2) * 10;
}
function pnlRounding(price: number): number {
  return Math.round(price * 0.5);
}

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = actual === expected;
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(60)} ${ok ? "" : `実際=${actual} 期待=${expected}`}`);
}

console.log("══ mod20=0 の価格 → 両方式は一致する ══");
eq("800円 (実データで確認した唯一の実発火ケース)", pnlRounding(800), halfMonthUnitsRounding(800));
eq("3000円", pnlRounding(3000), halfMonthUnitsRounding(3000));

console.log("\n══ ★ mod20=10 の価格 → 5円ずれる (実データに220件存在) ══");
eq("★ 310円: 請求方式", halfMonthUnitsRounding(310), 160); // units=31→round(15.5)=16→160円
eq("★ 310円: 損益方式 (5円少ない)", pnlRounding(310), 155);
{
  n++;
  const diverge = halfMonthUnitsRounding(310) !== pnlRounding(310);
  if (diverge) console.log("  ✓ 実際に食い違うことを確認 (このテストは何かを検証している)");
  else { ng++; console.log("  ✗✗✗ 食い違わない — 負のコントロール失敗"); }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log("実データでの現状: 半月按分の発火自体が稀 (2026-09-05実測: 4,669件中1件のみ)。");
console.log("その1件はmod20=0で発散なし。→ 実害0円。修正は行わない (管理会計と請求の目的の違いは判断が要る)。");
if (ng > 0) process.exitCode = 1;
