/**
 * 福祉用具貸与の単位数算定 (半月ルール) の検証 — 段1
 *
 *   npx tsx scripts/fukuyogu-units-check.mts
 *
 * 対象は `app/[tenant]/order-item-helpers.ts` の `calcMonthUnits`。
 * **画面と同じ関数をそのまま呼ぶ** (逐語コピーしない)。
 *
 * ── 半月ルール ──────────────────────────────────────────────────────────
 *   1〜15 日に 1 日でも貸与 → 半月分
 *   16〜末日に 1 日でも貸与 → 半月分
 *   両方にかかる → 満額
 *
 * ── ⚠ 端数の丸め (2026-09-04 是正: lib/half-month-units.ts に統一) ─────────
 *   「両方にかかれば満額 / 片方なら半月」という **枠組み**は制度どおり。
 *   端数 (単位が奇数) をどちらの半月に寄せるかは告示に明記が無い
 *   (web確認: 老企第36号を引く各自治体Q&A は「半月単位の計算方法で請求
 *   しても差し支えない」とのみ述べ、端数処理は事業所の運営規程・重要
 *   事項説明書で定める事項とされている。KT Group の重要事項説明書には
 *   記載が無い)。
 *
 *   以前は `calcMonthUnits` だけ 前半=floor・後半=ceil という**独自の**
 *   非対称ルールを持ち、`BillingTab.tsx` の `getUnits`/`computeUnitsForMonth`
 *   (= 実際に国保連へ伝送される計算) は前半・後半とも round という
 *   **別の実装**だった。同じ事実 (半月按分) を2か所で別々に持っていたため、
 *   前半のみ×単位が奇数の月だけ 請求書 (旧floor) と伝送 (round) が
 *   1 単位 (10円) 食い違っていた (規律3-14)。
 *
 *   → **`lib/half-month-units.ts` の `halfMonthUnits()` に統一**した
 *     (前半・後半とも round = 実際に伝送されていた側の挙動)。
 *   ⚠ 2026-09-04 実測: 実データ (order_items 4,669行) では半月按分が
 *     一度も発火しておらず (rental_start_date が全件「月の1日」、
 *     terminated は1件のみでその単位数は偶数だった)。この統一によって
 *     過去の請求書・伝送の実績値は 1 円も変わらない。
 *
 * DB は読まない (純関数のみ)。
 */
import { calcMonthUnits } from "../app/[tenant]/order-item-helpers";
import type { OrderItem } from "../lib/supabase";

let n = 0, ng = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  n++;
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(50)} ${ok ? "" : `実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`}`);
};

/** 2026-12 は 31 日。貸与価格 3,000 円 → 300 単位 (単価 10 円固定) */
const item = (o: Partial<OrderItem>): OrderItem =>
  ({
    id: "x", order_id: "o", tenant_id: "kt-group", product_code: "P1",
    supplier_id: null, purchase_price: null, rental_price: 3000,
    status: "rental_started", rental_start_date: "2026-11-01", rental_end_date: null,
    quantity: 1, payment_type: "介護", ...o,
  }) as OrderItem;

const U = (o: Partial<OrderItem>, price?: number) => calcMonthUnits(item(o), 2026, 12, price);

console.log("══ 満額 / 半月 (貸与価格 3,000 円 = 300 単位) ══");
eq("前月から継続 (月末まで) → 満額", U({}), 300);
eq("12/01 開始 → 満額", U({ rental_start_date: "2026-12-01" }), 300);
eq("★ 12/15 開始 (前半に 1 日だけ) → 満額", U({ rental_start_date: "2026-12-15" }), 300);
eq("★ 12/16 開始 (後半のみ) → 半月 150", U({ rental_start_date: "2026-12-16" }), 150);
eq("12/31 開始 (後半のみ) → 半月 150", U({ rental_start_date: "2026-12-31" }), 150);
eq("★ 12/15 終了 (前半のみ) → 半月 150",
  U({ status: "terminated", rental_end_date: "2026-12-15" }), 150);
eq("★ 12/16 終了 (後半に 1 日) → 満額",
  U({ status: "terminated", rental_end_date: "2026-12-16" }), 300);
eq("12/01 終了 (前半のみ) → 半月 150",
  U({ status: "terminated", rental_end_date: "2026-12-01" }), 150);
eq("12/16 開始 12/31 終了 (後半のみ) → 半月 150",
  U({ status: "terminated", rental_start_date: "2026-12-16", rental_end_date: "2026-12-31" }), 150);
eq("★ 12/10 開始 12/20 終了 (両方にかかる) → 満額",
  U({ status: "terminated", rental_start_date: "2026-12-10", rental_end_date: "2026-12-20" }), 300);

console.log("\n══ 対象月の外 ══");
eq("★ 先月末で終了 → 0", U({ status: "terminated", rental_end_date: "2026-11-30" }), 0);
eq("★ 翌月開始 → null (請求対象外。0 ではない)", U({ rental_start_date: "2027-01-01" }), null);
eq("キャンセル → 0", U({ status: "cancelled" }), 0);
eq("★ 発注済 → null (まだ貸与していない)", U({ status: "ordered" }), null);
eq("★ 納品済 → null (貸与開始前)", U({ status: "delivered" }), null);
eq("試用中 (旧 trial) → null", U({ status: "trial" }), null);
eq("★ 貸与価格 0 → null (単位数を推測しない)", U({ rental_price: 0 }), null);
eq("★ 貸与価格 null → null", U({ rental_price: null as never }), null);

console.log("\n══ 単位数の丸め ══");
eq("3,000 円 → 300 単位", U({}), 300);
eq("3,004 円 → 300 単位 (round)", U({ rental_price: 3004 }), 300);
eq("★ 3,005 円 → 301 単位 (JS の round は 0.5 を切り上げ)", U({ rental_price: 3005 }), 301);
eq("2,995 円 → 300 単位 (299.5 → 300)", U({ rental_price: 2995 }), 300);
eq("priceOverride が rental_price より優先", U({ rental_price: 3000 }, 5000), 500);

console.log("\n══ 端数の丸め (単位 301 = 奇数。前半・後半とも round に統一済み) ══");
eq("前半のみ (12/15 終了) → 151 (round。旧実装は floor で 150 だった)",
  U({ status: "terminated", rental_price: 3005, rental_end_date: "2026-12-15" }), 151);
eq("後半のみ (12/16 開始) → 151 (round)",
  U({ rental_price: 3005, rental_start_date: "2026-12-16" }), 151);
eq("前半・後半で単位が対称になった (以前は 150 vs 151 で非対称だった)",
  U({ status: "terminated", rental_price: 3005, rental_end_date: "2026-12-15" }),
  U({ rental_price: 3005, rental_start_date: "2026-12-16" }));

// ★ 負のコントロール: 丸めを壊したら NG になることを確認してから常設にする。
//   (「通るだけで何も検証していないテスト」になっていないかの確認。3-9)
{
  const before = ng;
  const savedRound = Math.round;
  // round を floor に差し替えて、本来 151 になるべき値が 150 に壊れることを確認する。
  Math.round = Math.floor;
  const broken = U({ status: "terminated", rental_price: 3005, rental_end_date: "2026-12-15" });
  Math.round = savedRound;
  if (broken === 151) {
    console.log("  ✗✗✗ 負のコントロール失敗: round を floor に壊しても 151 のまま (このテストは丸めを検証できていない)");
    ng++;
  } else {
    console.log(`  ✓ 負のコントロール OK (round を floor に壊すと ${broken} になり、151 との差が検出できる)`);
  }
  n++;
  if (ng !== before + (broken === 151 ? 1 : 0)) { /* 型チェック用の到達不能ガードではなく単なる説明 */ }
}

console.log("\n══ 月の長さ ══");
// 2 月 (28 日) でも 15/16 で切る
const feb = (o: Partial<OrderItem>) => calcMonthUnits(item(o), 2026, 2);
eq("2月 2/16 開始 (後半のみ) → 150", feb({ rental_start_date: "2026-02-16" }), 150);
eq("2月 2/28 終了 → 満額 (前半から継続)", feb({ status: "terminated", rental_end_date: "2026-02-28" }), 300);
eq("★ 2月 2/15 終了 (前半のみ) → 150", feb({ status: "terminated", rental_end_date: "2026-02-15" }), 150);
// ⚠ 2026 は閏年でないので 2/29 は存在しない。`new Date("2026-02-29T00:00:00")` は
//   **3/1 に繰り上がる**。前半から継続していれば下半期にもかかる扱いになる。
eq("★ 2026-02-29 (存在しない日) 終了 → 満額 (Date が 3/1 に繰り上がる)",
  feb({ status: "terminated", rental_start_date: "2026-02-01", rental_end_date: "2026-02-29" }), 300);

console.log("\n══ ⚠ 到達しない分岐 (実装の指摘) ══");
// status=terminated / start が月末より後 / end が月末以内 → end < start でないと成立しない
const weird = U({ status: "terminated", rental_start_date: "2027-01-05", rental_end_date: "2026-12-20" });
eq("★ 開始 > 終了 の壊れたデータでも **満額が出る** (弾かれない)", weird, 300);
console.log("  ⚠ `calcMonthUnits` の該当分岐は `start > monthEnd && end <= monthEnd`、");
console.log("     つまり **終了日が開始日より前**のときしか通らない。正常データでは到達しない。");
console.log("     壊れたデータを黙って請求に載せるので、**null を返すか警告を出す**ほうが安全。");
console.log("     ★ 実データでの該当件数は別途要確認 (この harness は DB を読まない)。");

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log(`「両方にかかれば満額 / 片方なら半月」の枠組みは制度どおり。`);
console.log(`端数の丸めは lib/half-month-units.ts の halfMonthUnits() に統一済み`);
console.log(`(実際に伝送されていた round 方式。実データへの影響は 0 円で確認済み)。`);
if (ng > 0) process.exitCode = 1;
