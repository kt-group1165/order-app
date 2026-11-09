/**
 * `lib/fukuyoguExceptionRules.ts` の境界値テスト (DB を触らない純関数テスト)
 *
 *   npm run check:exception-rules
 *
 * 見るもの: 軽度者 例外給付の 期限 (30 日前から橙・切れたら赤)・更新記録の連結・
 *   市町村ルール (期間が要るのに終了日が空 → 橙)・終了日の提案 (開始日 + N か月、民法 143 条)。
 * ★ 負のコントロール: 判定を わざと壊した版 (警告日数 0 / ルール無視 / 連結しない) で
 *   同じ期待値が **落ちる** ことを確かめる。全部通る検査は効いていない検査と区別が付かないため。
 * ⚠ 既存の check:keido-exception (実データ・基準値 125) とは別物。そちらの基準値は変えない。
 */
import {
  proposeValidEnd, judgeExceptionGrant, judgeClientExceptions, coverageEndOf, findInsurerRule,
  diffDaysYmd, addDaysYmd, worstLevel, type GrantLike, type ExceptionInsurerRule,
} from "../lib/fukuyoguExceptionRules";

let pass = 0;
const fails: string[] = [];
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`${label}\n      期待 ${w}\n      実際 ${g}`);
}

// ── 日付 ─────────────────────────────────────────────────────────
eq("addDays 月またぎ", addDaysYmd("2026-01-31", 1), "2026-02-01");
eq("addDays 閏年", addDaysYmd("2028-02-28", 1), "2028-02-29");
eq("diffDays", diffDaysYmd("2026-11-09", "2026-12-09"), 30);

// ── 終了日の提案 (民法 143 条: 応当日の前日 / 応当日が無ければ末日) ──
eq("4/1 + 12か月 → 翌3/31", proposeValidEnd("2026-04-01", 12), "2027-03-31");
eq("1/15 + 1か月 → 2/14", proposeValidEnd("2026-01-15", 1), "2026-02-14");
eq("1/31 + 1か月 → 2/28 (応当日なし=末日)", proposeValidEnd("2026-01-31", 1), "2026-02-28");
eq("1/31 + 1か月 閏年 → 2/29", proposeValidEnd("2028-01-31", 1), "2028-02-29");
eq("1/30 + 1か月 閏年 → 2/29 (応当日 2/30 なし)", proposeValidEnd("2028-01-30", 1), "2028-02-29");
eq("3/1 + 1か月 → 3/31", proposeValidEnd("2026-03-01", 1), "2026-03-31");
eq("11/10 + 6か月 → 翌5/9 (年またぎ)", proposeValidEnd("2026-11-10", 6), "2027-05-09");
eq("期間 0 → null", proposeValidEnd("2026-04-01", 0), null);
eq("期間 1.5 → null", proposeValidEnd("2026-04-01", 1.5), null);
eq("日付でない → null", proposeValidEnd("", 12), null);

// ── 判定 ─────────────────────────────────────────────────────────
const C = "c1", G = "特殊寝台系";
const g = (valid_from: string, valid_end: string | null, group = G, client_id = C): GrantLike => ({ client_id, restriction_group: group, valid_from, valid_end });
const REQ = { requires_period: true };
const NOREQ = { requires_period: false };
const D = "2026-11-09";

eq("記録なし → missing/danger", judgeExceptionGrant([], C, G, D, null), { group: G, kind: "missing", level: "danger" });
eq("別の区分だけ → missing", judgeExceptionGrant([g("2026-01-01", null, "車いす系")], C, G, D, null).kind, "missing");
eq("別の利用者だけ → missing", judgeExceptionGrant([g("2026-01-01", null, G, "c2")], C, G, D, null).kind, "missing");
eq("未来に始まる記録だけ → missing", judgeExceptionGrant([g("2026-12-01", null)], C, G, D, null).kind, "missing");
eq("昨日切れた → expired/danger",
  judgeExceptionGrant([g("2026-01-01", "2026-11-08")], C, G, D, null),
  { group: G, kind: "expired", level: "danger", lastEnded: "2026-11-08" });
eq("今日が終了日 → 有効 (expiring, 0日)",
  judgeExceptionGrant([g("2026-01-01", "2026-11-09")], C, G, D, null),
  { group: G, kind: "expiring", level: "warn", coverageEnd: "2026-11-09", daysLeft: 0 });
eq("ちょうど30日後に切れる → expiring",
  judgeExceptionGrant([g("2026-01-01", "2026-12-09")], C, G, D, null).kind, "expiring");
eq("31日後に切れる → ok",
  judgeExceptionGrant([g("2026-01-01", "2026-12-10")], C, G, D, null),
  { group: G, kind: "ok", level: "ok", coverageEnd: "2026-12-10", daysLeft: 31 });
eq("今日から開始 → 有効", judgeExceptionGrant([g("2026-11-09", "2027-11-08")], C, G, D, null).kind, "ok");
eq("期限なし・ルール未設定 → ok", judgeExceptionGrant([g("2026-01-01", null)], C, G, D, null).kind, "ok");
eq("期限なし・期間不要 → ok", judgeExceptionGrant([g("2026-01-01", null)], C, G, D, NOREQ).kind, "ok");
eq("期限なし・期間が要る → period_required_no_end/warn",
  judgeExceptionGrant([g("2026-01-01", null)], C, G, D, REQ),
  { group: G, kind: "period_required_no_end", level: "warn", coverageEnd: null });
eq("終了日あり・期間が要る → 期限で判定 (ok)", judgeExceptionGrant([g("2026-01-01", "2027-03-31")], C, G, D, REQ).kind, "ok");

// 更新の連結
eq("切れる直前に翌日開始の更新あり → 先まで有効 (ok)",
  judgeExceptionGrant([g("2026-01-01", "2026-11-20"), g("2026-11-21", "2027-11-20")], C, G, D, null),
  { group: G, kind: "ok", level: "ok", coverageEnd: "2027-11-20", daysLeft: 376 });
eq("更新が重なって始まる → 連結", coverageEndOf([g("2026-01-01", "2026-11-20"), g("2026-11-01", "2027-03-31")], D), "2027-03-31");
eq("更新との間に 1 日空き → 連結しない (expiring)",
  judgeExceptionGrant([g("2026-01-01", "2026-11-20"), g("2026-11-22", "2027-11-20")], C, G, D, null).kind, "expiring");
eq("3 本連結", coverageEndOf([g("2026-01-01", "2026-11-20"), g("2026-11-21", "2026-12-31"), g("2027-01-01", "2027-12-31")], D), "2027-12-31");
eq("更新が期限なし → null", coverageEndOf([g("2026-01-01", "2026-11-20"), g("2026-11-21", null)], D), null);
eq("有効なし → undefined", coverageEndOf([], D), undefined);

// 利用者まとめ
const multi = judgeClientExceptions([g("2026-01-01", null, "車いす系")], C, ["車いす系", G, G], D, null);
eq("まとめ: 重複区分は 1 回・最悪は danger (並びは区分名の文字コード順: 特 < 車)", [multi.level, multi.items.map((i) => i.kind)], ["danger", ["missing", "ok"]]);
eq("worstLevel", [worstLevel([]), worstLevel(["ok", "warn"]), worstLevel(["warn", "danger", "ok"])], ["ok", "warn", "danger"]);

// 市町村ルール
const rules: ExceptionInsurerRule[] = [
  { id: "r1", tenant_id: "t", insurer_number: "122069", insurer_name: "木更津市", requires_period: true, period_months: 12, notes: null },
];
eq("ルール: 番号一致", findInsurerRule(rules, "122069")?.id, "r1");
eq("ルール: 全角・空白は正規化して一致", findInsurerRule(rules, " １２２０６９ ")?.id, "r1");
eq("ルール: 無い番号 → null", findInsurerRule(rules, "122192"), null);
eq("ルール: 空 → null", findInsurerRule(rules, null), null);

// ── 負のコントロール: わざと壊した判定で 同じ期待値が落ちること ────────
let negCaught = 0;
const negCases: { label: string; broken: () => unknown; want: unknown }[] = [
  { label: "警告日数 0 だと 30日後の期限を見逃す", broken: () => judgeExceptionGrant([g("2026-01-01", "2026-12-09")], C, G, D, null, 0).kind, want: "expiring" },
  { label: "ルールを渡さないと 期間要の終了日空を見逃す", broken: () => judgeExceptionGrant([g("2026-01-01", null)], C, G, D, null).kind, want: "period_required_no_end" },
  { label: "更新記録を渡さないと 連結されず期限扱い", broken: () => judgeExceptionGrant([g("2026-01-01", "2026-11-20")], C, G, D, null).kind, want: "ok" },
  { label: "基準日を 1 日ずらすと 終了日当日が切れ扱い", broken: () => judgeExceptionGrant([g("2026-01-01", "2026-11-09")], C, G, addDaysYmd(D, 1), null).kind, want: "expiring" },
  { label: "応当日の前日を取らないと 1 日ずれる", broken: () => addDaysYmd(proposeValidEnd("2026-04-01", 12)!, 1), want: "2027-03-31" },
];
for (const n of negCases) {
  const got = JSON.stringify(n.broken()), want = JSON.stringify(n.want);
  if (got !== want) negCaught++;
  else fails.push(`負のコントロールが鳴らない: ${n.label} (壊した版でも ${got})`);
}

console.log(`例外給付 判定テスト: ${pass} 件合格 / 失敗 ${fails.length} 件 (負のコントロールの不発を含む)`);
console.log(`負のコントロール: ${negCaught}/${negCases.length} 件で 壊した判定が期待値から外れることを確認`);
if (fails.length > 0) {
  console.log("\nFAIL:");
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log("PASS");
