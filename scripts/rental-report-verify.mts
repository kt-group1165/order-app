/**
 * 貸与報告書の判定 (lib/rentalReport.ts) の検証 (DB 不使用・純関数)
 *
 *   npm run check:rental-report
 *
 * 期待値は規則から手で出している (対象月 2026-09)。
 * 負のコントロール: hasMovementInMonth の解約日の判定を外すと「解約だけの月」が、
 * detectRentalUsage の remaining に月末後解約を含めないと「一部回収」が落ちることを 2026-10-17 に確認。
 */
import { detectRentalUsage, hasRentalInMonth, hasMovementInMonth, isReportItem, rentalReportTitle } from "../lib/rentalReport";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};
const it = (status: string, start: string | null, end: string | null = null) => ({ status, rental_start_date: start, rental_end_date: end });
const M = "2026-09";

// 貸与利用項目
eq("継続のみ", detectRentalUsage([it("rental_started", "2026-05-01")], M), ["継続"]);
eq("新規納品", detectRentalUsage([it("rental_started", "2026-09-10")], M), ["新規納品"]);
eq("追加納品 + 継続", detectRentalUsage([it("rental_started", "2026-05-01"), it("rental_started", "2026-09-10")], M), ["追加納品", "継続"]);
eq("一式回収", detectRentalUsage([it("terminated", "2026-05-01", "2026-09-20")], M), ["一式回収"]);
eq("一部回収 + 継続", detectRentalUsage([it("terminated", "2026-05-01", "2026-09-20"), it("rental_started", "2026-05-01")], M), ["一部回収", "継続"]);
// 月末より後に解約予定の明細は「まだ残っている」側
eq("一部回収 (残りは翌月解約)", detectRentalUsage([it("terminated", "2026-05-01", "2026-09-20"), it("terminated", "2026-05-01", "2026-10-05")], M), ["一部回収", "継続"]);
eq("取消は数えない", detectRentalUsage([it("cancelled", "2026-09-03"), it("rental_started", "2026-05-01")], M), ["継続"]);
eq("何も無い → 継続", detectRentalUsage([], M), ["継続"]);

// 対象月に貸与があるか
eq("対象 継続中", hasRentalInMonth([it("rental_started", "2026-05-01")], M), true);
eq("対象 月内に解約", hasRentalInMonth([it("terminated", "2026-05-01", "2026-09-01")], M), true);
eq("対象外 前月に解約", hasRentalInMonth([it("terminated", "2026-05-01", "2026-08-31")], M), false);
eq("対象外 翌月開始", hasRentalInMonth([it("rental_started", "2026-10-01")], M), false);
eq("対象外 発注のみ", hasRentalInMonth([it("ordered", null)], M), false);
eq("対象外 取消", hasRentalInMonth([it("cancelled", "2026-09-03")], M), false);

// 動きのあった人
eq("動き 開始", hasMovementInMonth([it("rental_started", "2026-09-30")], M), true);
eq("動き 解約だけの月", hasMovementInMonth([it("terminated", "2026-05-01", "2026-09-01")], M), true);
eq("動き無し 継続", hasMovementInMonth([it("rental_started", "2026-08-31")], M), false);
eq("動き無し 取消", hasMovementInMonth([it("cancelled", "2026-09-03")], M), false);

// 表に載る明細
eq("表 取消 (開始後)", isReportItem(it("cancelled", "2026-09-03")), true);
eq("表 取消 (開始前)", isReportItem(it("cancelled", null)), false);
eq("表 発注中", isReportItem(it("ordered", null)), false);

eq("題名 年またぎ", rentalReportTitle("2026-12"), "貸与報告書 2026年12月・2027年1月分");

console.log(`check:rental-report  ${pass} 件 合格 / ${fails.length} 件 不合格`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
