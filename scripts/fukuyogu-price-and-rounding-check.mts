/**
 * 福祉用具貸与 2 件の是正の境界値検証 (DB 不使用・純関数のみ)
 *
 *   npx tsx scripts/fukuyogu-price-and-rounding-check.mts
 *
 * ① 半月按分の丸めを 1 か所 (lib/half-month-units.ts) に統一した
 * ② 伝送の単位数計算 (BillingTab.tsx の getUnits / computeUnitsForMonth /
 *    computeMonthlyUnits) が equipment.rental_price (現在価格) を直参照
 *    していて、価格改定後に過去月を組むと現在価格になっていたのを是正
 *
 * ②の day-loop 自体は BillingTab.tsx の非公開クロージャなので直接呼べない。
 * ここでは②の要 (「過去月には過去の価格を使う」) を担っている
 * `lib/equipment.ts` の `getPriceForMonth` を検証する。BillingTab.tsx 側は
 * `getPriceForMonth(priceHistory, code, ym) ?? eq?.rental_price ?? 0` という
 * 1 行に集約したので、この関数さえ正しければ伝送側の穴は塞がっている。
 *
 * ⚠ `lib/equipment.ts` は `lib/supabase.ts` (ブラウザ client) を経由 import
 *   しており、そちらは env 未設定だと即エラーになる。ここは getPriceForMonth
 *   の**計算だけ**を見たいので、ダミー値を設定してから動的 import する
 *   (実際に Supabase へは繋がない。ネットワークは一切使わない)。
 */
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://dummy.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "dummy";

import { halfMonthUnits } from "../lib/half-month-units";
import type { EquipmentPriceHistory } from "../lib/supabase";
const { getPriceForMonth } = await import("../lib/equipment");

let n = 0, ng = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  n++;
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(60)} ${ok ? "" : `実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`}`);
};

console.log("══ ① halfMonthUnits ══");
eq("両方にかかる → 満額", halfMonthUnits(301, true, true), 301);
eq("どちらにもかからない → 0", halfMonthUnits(301, false, false), 0);
eq("前半のみ・偶数 → ちょうど半分", halfMonthUnits(300, true, false), 150);
eq("後半のみ・偶数 → ちょうど半分", halfMonthUnits(300, false, true), 150);
eq("★ 前半のみ・奇数 → round (301→151。旧実装は floor で150だった)", halfMonthUnits(301, true, false), 151);
eq("★ 後半のみ・奇数 → round (301→151)", halfMonthUnits(301, false, true), 151);
eq("前半・後半で対称 (差が無い)", halfMonthUnits(301, true, false), halfMonthUnits(301, false, true));
eq("0単位 → 0", halfMonthUnits(0, true, false), 0);

console.log("\n══ ② getPriceForMonth (過去月には過去の価格を使う) ══");
const hist: EquipmentPriceHistory[] = [
  { product_code: "P1", rental_price: 3000, valid_from: "2026-01-01" } as EquipmentPriceHistory,
  { product_code: "P1", rental_price: 3500, valid_from: "2026-06-01" } as EquipmentPriceHistory,
];
eq("改定前月 (2026-03) → 旧価格 3000", getPriceForMonth(hist, "P1", "2026-03"), 3000);
eq("改定月 (2026-06) → 新価格 3500 (施行月から適用)", getPriceForMonth(hist, "P1", "2026-06"), 3500);
eq("改定後 (2026-08) → 新価格 3500", getPriceForMonth(hist, "P1", "2026-08"), 3500);
eq("★ 改定より前の月 (2025-12) → 履歴無し = null (最古へ fallback しない)",
  getPriceForMonth(hist, "P1", "2025-12"), null);
eq("該当 product_code が無い → null", getPriceForMonth(hist, "P9", "2026-06"), null);
eq("履歴が空 → null", getPriceForMonth([], "P1", "2026-06"), null);
eq("履歴の並び順に依存しない (逆順で渡しても同じ)",
  getPriceForMonth([...hist].reverse(), "P1", "2026-03"), 3000);

// ★ 負のコントロール: 「常に最新価格を返す」(= 是正前の bug と同じ挙動) に
//   壊したら NG になることを確認する。
{
  const buggyGetPrice = (h: EquipmentPriceHistory[], code: string) => {
    const rows = h.filter((r) => r.product_code === code).sort((a, b) => b.valid_from.localeCompare(a.valid_from));
    return rows[0]?.rental_price ?? null; // ym を無視して常に最新
  };
  const before = ng;
  const buggyResult = buggyGetPrice(hist, "P1"); // 常に 3500 (最新)
  n++;
  if (buggyResult === 3000) {
    console.log("  ✗✗✗ 負のコントロール失敗: 意図的に壊した「常に最新価格」関数が過去月と一致してしまった");
    ng++;
  } else {
    console.log(`  ✓ 負のコントロール OK (「常に最新価格」に壊すと過去月(3000)に対し ${buggyResult} を返し、不一致を検出できる)`);
  }
  void before;
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log("★ 実データでの影響: order_items 4,669行 中、実在する価格改定 (equipment_price_history");
console.log("  に履歴2件以上) は 2 品目のみ、かつどちらも参照する order_items は 0 行 (2026-09-04実測)。");
console.log("  → 是正による過去の請求書・伝送額への影響は 0 円。この2品目自体は現在価格が");
console.log("    11,000円→110,000円/1,100,000円 と桁違いで、価格改定というより入力ミスの疑いがある");
console.log("    (特殊寝台の月額レンタルとしては現実的でない額)。★ 別件として報告する。");
if (ng > 0) process.exitCode = 1;
