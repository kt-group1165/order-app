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
 * ── ⚠ 期待値の出どころ ───────────────────────────────────────────────────
 *   「両方にかかれば満額 / 片方なら半月」という **枠組み**は制度どおり。
 *   ★ ただし **端数をどちらの半月に寄せるか**は告示の文言を確認していない。
 *     実装は floor を前半・ceil を後半に割り当てている:
 *       単位 301 → 前半のみ 150 / 後半のみ 151
 *     → **前半だけ借りた人のほうが 1 単位 (10 円) 少ない**。
 *     この非対称は制度由来か実装の都合か **未確認**。ここでは
 *     「実装がこう動く」ことを固定するだけで、**正しさは主張しない**。
 *   ⚠ ほのぼのの福祉用具伝送が手元に無いので突合もできない (3-5)。
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

console.log("\n══ ★ 端数の割り当て (単位 301 = 奇数) ══");
console.log("  ⚠ 告示の文言を確認していない。**実装がこう動く**ことを固定するだけ。");
eq("前半のみ (12/15 終了) → 150 (floor)",
  U({ status: "terminated", rental_price: 3005, rental_end_date: "2026-12-15" }), 150);
eq("★ 後半のみ (12/16 開始) → 151 (ceil)",
  U({ rental_price: 3005, rental_start_date: "2026-12-16" }), 151);
eq("前半 + 後半 = 満額 301 (端数が消えない)",
  (U({ status: "terminated", rental_price: 3005, rental_end_date: "2026-12-15" }) ?? 0) +
  (U({ rental_price: 3005, rental_start_date: "2026-12-16" }) ?? 0), 301);
console.log("  ⚠ **前半だけ借りた人のほうが 1 単位 (10 円) 少ない。**");
console.log("     制度由来か実装の都合かは未確認。告示を確認すること。");

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
console.log("  ⚠ `calcMonthUnits` の 61-63 行は `start > monthEnd && end <= monthEnd`、");
console.log("     つまり **終了日が開始日より前**のときしか通らない。正常データでは到達しない。");
console.log("     壊れたデータを黙って請求に載せるので、**null を返すか警告を出す**ほうが安全。");
console.log("     ★ 実データでの該当件数は別途要確認 (この harness は DB を読まない)。");

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log(`⚠ 「両方にかかれば満額 / 片方なら半月」の枠組みは制度どおりだが、`);
console.log(`  ★ **端数をどちらの半月に寄せるか**は告示未確認。ほのぼのの福祉用具伝送も手元に無い。`);
