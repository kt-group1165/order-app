/**
 * `lib/ceilingCheck.ts` の境界値テスト (DB を触らない純関数テスト)
 *
 *   npx tsx scripts/ceiling-boundary-test.mts
 *
 * なぜ DB でなくここで見るか:
 *   judgeCeiling は純関数なので、境界値 (超過 / ちょうど / 下回る) は
 *   **サンプルデータを DB に入れなくても全部通せる**。しかも再実行できる。
 *   DB を触らないと確かめられないもの (RLS・trigger・集計 SQL) だけを
 *   実データのハーネス (scripts/ceiling-check.mts) に残す。
 *
 * ⚠ 期待値はコメントからではなく **この規則そのもの**から書いている。
 *   ceilingCheck.ts のコメントの数字 (「世代が無い行が 7 件」) は
 *   ハーネスの基準日 (rental_start_date ?? "1900-01-01") 由来で、
 *   基準日を変えると変わる。**数え方が違うだけで、どちらも間違いではない。**
 */
import { indexCeilings, judgeCeiling, type CeilingRow } from "../lib/ceilingCheck";

let pass = 0;
const fails: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${label}\n      期待 ${w}\n      実際 ${g}`);
}

// 2 世代を持つ TAIS。境界がどちらの世代を選ぶかも見る。
const rows: CeilingRow[] = [
  { tais_code: "T-1", effective_from: "2025-04-01", ceiling_price: 10000 },
  { tais_code: "T-1", effective_from: "2026-04-01", ceiling_price: 9000 },
];
const idx = indexCeilings(rows);
const D = "2026-06-01"; // 新世代 (9000) が効く日

// ── 境界値: 超過 / ちょうど / 下回る ────────────────────────────────
eq("上限を1円超える → over",
  judgeCeiling("T-1", 9001, D, idx), { kind: "over", ceiling: 9000, effectiveFrom: "2026-04-01", excess: 1 });
eq("上限ちょうど → ok (超過にしない)",
  judgeCeiling("T-1", 9000, D, idx), { kind: "ok", ceiling: 9000, effectiveFrom: "2026-04-01" });
eq("上限を1円下回る → ok",
  judgeCeiling("T-1", 8999, D, idx), { kind: "ok", ceiling: 9000, effectiveFrom: "2026-04-01" });

// ── 世代の選び方 ──────────────────────────────────────────────────
// ★ 施行日ちょうどはその世代が効く (<=)。実データで 6 行がこの日に当たる。
eq("基準日 = 施行日 → その世代が効く",
  judgeCeiling("T-1", 9500, "2026-04-01", idx), { kind: "over", ceiling: 9000, effectiveFrom: "2026-04-01", excess: 500 });
eq("施行日の前日 → 1 つ前の世代",
  judgeCeiling("T-1", 9500, "2026-03-31", idx), { kind: "ok", ceiling: 10000, effectiveFrom: "2025-04-01" });
// ★ 最古世代より前は「未来の上限と比べる」誤検出を避けるため unknown。
//   ここを fallback にすると 2026-09-03 に実際に起きた誤報が再発する。
eq("最古世代より前 → unknown (最古へ fallback しない)",
  judgeCeiling("T-1", 9500, "2020-01-01", idx), { kind: "unknown", reason: "no_generation" });

// ── 判定できない側 ────────────────────────────────────────────────
eq("TAIS が無い",   judgeCeiling(null, 9000, D, idx), { kind: "unknown", reason: "no_tais" });
eq("TAIS が空白のみ", judgeCeiling("  ", 9000, D, idx), { kind: "unknown", reason: "no_tais" });
eq("上限マスタに無い", judgeCeiling("T-X", 9000, D, idx), { kind: "unknown", reason: "no_master" });
eq("価格が null",   judgeCeiling("T-1", null, D, idx), { kind: "unknown", reason: "no_price" });
eq("価格が 0",      judgeCeiling("T-1", 0, D, idx), { kind: "unknown", reason: "no_price" });
eq("価格が負",      judgeCeiling("T-1", -1, D, idx), { kind: "unknown", reason: "no_price" });
eq("基準日が不正",   judgeCeiling("T-1", 9000, "2026/06/01", idx), { kind: "unknown", reason: "no_generation" });

// ★ ハーネスが null の貸与開始日に入れている値。実データで 1 行がこれに当たり、
//   「世代が無い」7 件 と 6 件 の差はこの 1 行だった。
eq("1900-01-01 (貸与開始日 null のときハーネスが入れる値) → unknown",
  judgeCeiling("T-1", 9000, "1900-01-01", idx), { kind: "unknown", reason: "no_generation" });

// ── indexCeilings ────────────────────────────────────────────────
eq("空白の TAIS は捨てる", indexCeilings([{ tais_code: " ", effective_from: "2026-04-01", ceiling_price: 1 }]).size, 0);
eq("入力が降順でも昇順に並べ替える",
  indexCeilings([rows[1], rows[0]]).get("T-1")!.map((r) => r.effective_from), ["2025-04-01", "2026-04-01"]);

console.log(`\n上限価格 判定器の境界値テスト: ${pass} 件 PASS / ${fails.length} 件 FAIL`);
for (const f of fails) console.log("  ✗ " + f);
if (fails.length) process.exitCode = 1;
else console.log("✓ すべて通りました (DB は触っていません)");
