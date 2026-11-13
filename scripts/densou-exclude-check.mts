/**
 * check:densou-exclude — 福祉用具の伝送で「外す人・止める理由」の判定 (lib/kokuho-densou/densou-exclude.ts) を確かめる (DB 不要・2026-11-14 群1)
 *
 *   npm run check:densou-exclude
 *
 * 検査:
 *   ・正常な行 (1 割・2 割・3 割・公費あり・公費単独・CM 頭打ち) → 1 人も外れない   ★ 逆向きの対照 (判定が広すぎて全員外す実装でも PASS しないように)
 *   ・理由ごとに わざと壊した行 → その理由 1 つで外れる                             ★ 負のコントロール
 *   ・computeFukuyoguAmounts の benefitRateDefaulted が 未設定・読めない給付率で true / 正しい給付率と公費単独で false
 *   ・価格改定履歴の状態 loading / failed → 止める / ok → 止めない
 * ・群2 (返戻になる型): 生年月日・公費の負担者番号・明細と 01 の合計・桁あふれ・サービスコード — 正常な行で外れない / 壊した行で外れる
 * ⚠ 「外した人が 7111 から抜ける」は buildFukuyoguDensou に組み込んだあとに ここへ足す (組み込みは 着手前の人数測定のあと)。
 */
import { densouExcludeReasons, densouLoadBlockers, type DensouExcludeInput } from "../lib/kokuho-densou/densou-exclude";
import { computeFukuyoguAmounts, type KohiPiece } from "../lib/kokuho-densou/fukuyogu-amounts";
import type { FukuyoguDetailLine } from "../lib/kokuho-densou/build";

/** 群1 だけを見る (details 等を持たない行で 群1 の判定を単独に確かめる) */
const g1 = (r: DensouExcludeInput) => densouExcludeReasons({ ...r, group2: false });

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  OK  ${label}`); } else { fails.push(`${label}\n      期待 ${w}\n      実際 ${g}`); console.log(`  NG  ${label}`); }
};

console.log("══ computeFukuyoguAmounts の benefitRateDefaulted ══");
const amt = (raw: string | null, insured = "0000123456") => computeFukuyoguAmounts({ benefitRateRaw: raw, insuredNumber: insured, totalUnits: 1000, kohi: null, cmUnits: null });
eq("給付率 90 → false", amt("90").benefitRateDefaulted, false);
eq("給付率 80 → false", amt("80").benefitRateDefaulted, false);
eq("給付率 70 → false", amt("70").benefitRateDefaulted, false);
eq("★ 給付率 未設定 → true (1 割で計算)", [amt(null).benefitRateDefaulted, amt(null).benefitRate], [true, 90]);
eq("★ 給付率 空文字 → true", amt("").benefitRateDefaulted, true);
eq("★ 給付率 読めない (\"二割\") → true", amt("二割").benefitRateDefaulted, true);
eq("★ 給付率 0 → true (0 は読めない扱いで 90 になる)", amt("0").benefitRateDefaulted, true);
eq("公費単独 (H) は 給付率が空でも false (給付率を使わない)", amt(null, "H123456789").benefitRateDefaulted, false);

console.log("══ densouExcludeReasons — 正常な行は 1 人も外れない (逆向きの対照) ══");
const ok: Record<string, DensouExcludeInput> = {
  "1 割・公費なし": { totalUnits: 1000, limitTargetUnits: 1000, benefitRateDefaulted: false },
  "limitTargetUnits 省略": { totalUnits: 1000, benefitRateDefaulted: false },
  "CM 頭打ち (実績 1200 → 請求 1000)": { totalUnits: 1000, limitTargetUnits: 1200, benefitRateDefaulted: false },
  "公費 (生保) 月全体": { totalUnits: 1000, limitTargetUnits: 1000, kohiHobetsu: "12", kohiUnits: 1000, benefitRateDefaulted: false },
  "公費 月途中 (公費 400 / 保険 1000)": { totalUnits: 1000, limitTargetUnits: 1000, kohiHobetsu: "12", kohiUnits: 400, benefitRateDefaulted: false },
  "公費単独 (H)・給付率なし": { totalUnits: 1000, kohiTandoku: true, kohiHobetsu: "12", kohiUnits: 1000, benefitRateDefaulted: true },
  "公費なしで kohiUnits が大きい値でも (公費が無ければ見ない)": { totalUnits: 1000, kohiUnits: 5000, benefitRateDefaulted: false },
};
for (const [k, r] of Object.entries(ok)) eq(`外れない: ${k}`, g1(r), []);
// 実際の金額計算の結果からも 外れないこと (正しい給付率)
for (const raw of ["90", "80", "70"]) {
  const a = amt(raw);
  eq(`外れない: computeFukuyoguAmounts(給付率 ${raw}) の結果そのまま`, g1({ totalUnits: a.billedUnits, limitTargetUnits: a.actualUnits, kohiTandoku: a.kohiTandoku, kohiHobetsu: a.kohiHobetsu, kohiUnits: a.kohiUnits, benefitRateDefaulted: a.benefitRateDefaulted }), []);
}

console.log("══ densouExcludeReasons — わざと壊した行は その理由で外れる (負のコントロール) ══");
{
  const a = amt(null);
  eq("★ ① 給付率 未設定 (computeFukuyoguAmounts の結果) → benefit_rate_defaulted", g1({ totalUnits: a.billedUnits, limitTargetUnits: a.actualUnits, kohiTandoku: a.kohiTandoku, kohiHobetsu: a.kohiHobetsu, kohiUnits: a.kohiUnits, benefitRateDefaulted: a.benefitRateDefaulted }), ["benefit_rate_defaulted"]);
}
eq("★ ③ 公費対象 1200 > 保険 1000 → kohi_units_over", g1({ totalUnits: 1000, limitTargetUnits: 1000, kohiHobetsu: "12", kohiUnits: 1200, benefitRateDefaulted: false }), ["kohi_units_over"]);
eq("★ ③ 公費単独でも 公費対象 > 保険 → kohi_units_over", g1({ totalUnits: 1000, kohiTandoku: true, kohiUnits: 1001, benefitRateDefaulted: false }), ["kohi_units_over"]);
eq("★ ④ 請求 1000 > 実績 900 → billed_over_actual", g1({ totalUnits: 1000, limitTargetUnits: 900, benefitRateDefaulted: false }), ["billed_over_actual"]);
eq("★ 境界: 請求 = 実績 は外れない / 1 単位超で外れる", [g1({ totalUnits: 900, limitTargetUnits: 900, benefitRateDefaulted: false }), g1({ totalUnits: 901, limitTargetUnits: 900, benefitRateDefaulted: false })], [[], ["billed_over_actual"]]);
eq("★ 理由が重なれば 全部出す", g1({ totalUnits: 1000, limitTargetUnits: 900, kohiHobetsu: "12", kohiUnits: 1100, benefitRateDefaulted: true }), ["benefit_rate_defaulted", "kohi_units_over", "billed_over_actual"]);

console.log("══ 群2 — 正常な行 (明細つき) は 1 人も外れない (逆向きの対照) ══");
const det = (code: string, unitPer: number, count = 1, extra: Partial<FukuyoguDetailLine> = {}): FukuyoguDetailLine =>
  ({ serviceCode: code, unitPer, count, units: unitPer * count, taisCode: "00170-000001", ...extra });
const full = (over: Partial<DensouExcludeInput> = {}): DensouExcludeInput => {
  const details = over.details ?? [det("171001", 600), det("171003", 200, 2)]; // 1000 単位
  const sum = details.reduce((s, d) => s + d.units, 0);
  return { totalUnits: sum, limitTargetUnits: sum, birthDate: "1940-01-01", details, benefitRateDefaulted: false, ...over };
};
const okFull: Record<string, DensouExcludeInput> = {
  "公費なし・明細 2 種 (2 個の行あり)": full(),
  "要支援 (67xxxx)": full({ details: [det("671001", 600)] }),
  "公費 (生保) 月全体・負担者番号あり": full({ kohiHobetsu: "12", kohiFutansha: "12123456", kohiUnits: 1000 }),
  "公費単独 (H)・負担者番号あり": full({ kohiTandoku: true, kohiHobetsu: "12", kohiFutansha: "12123456", kohiUnits: 1000 }),
  "公費 月途中 (kohiPieces 400 = kohiUnits 400)": full({ kohiHobetsu: "12", kohiFutansha: "12123456", kohiUnits: 400,
    details: [det("171001", 600, 1, { kohiPieces: [{ days: 10, units: 200 } as KohiPiece] }), det("171003", 200, 2, { kohiPieces: [{ days: 10, units: 100 } as KohiPiece, { days: 10, units: 100 } as KohiPiece] })] }),
  "CM 頭打ち (実績 1000 → 請求 800・公費 800)": { ...full({ kohiHobetsu: "12", kohiFutansha: "12123456", kohiUnits: 800 }), totalUnits: 800 },
  "単位数 9999 / サービス単位 999999 ちょうど": full({ details: [det("171001", 9999), det("171002", 9999, 1, { units: 999999 })] }),
};
for (const [k, r] of Object.entries(okFull)) eq(`外れない: ${k}`, densouExcludeReasons(r), []);

console.log("══ 群2 — わざと壊した行は その理由で外れる (負のコントロール) ══");
eq("★ 生年月日が空 → birth_date_missing", densouExcludeReasons(full({ birthDate: null })), ["birth_date_missing"]);
eq("★ 生年月日が空白だけ → birth_date_missing", densouExcludeReasons(full({ birthDate: "  " })), ["birth_date_missing"]);
eq("★ 公費あり・負担者番号が空 → kohi_futansha_missing", densouExcludeReasons(full({ kohiHobetsu: "12", kohiFutansha: null, kohiUnits: 1000 })), ["kohi_futansha_missing"]);
eq("★ 公費単独 (H) で公費情報なし → kohi_futansha_missing (fukuyogu-amounts:345 の型)", densouExcludeReasons(full({ kohiTandoku: true, kohiHobetsu: "12", kohiFutansha: "", kohiUnits: 1000 })), ["kohi_futansha_missing"]);
eq("★ 明細の合計 1000 ≠ 限度額管理対象 1100 → detail_sum_mismatch", densouExcludeReasons({ ...full(), limitTargetUnits: 1100, totalUnits: 1100 }), ["detail_sum_mismatch"]);
eq("★ 明細の公費対象の合計 300 ≠ 公費対象 400 → kohi_detail_mismatch", densouExcludeReasons(full({ kohiHobetsu: "12", kohiFutansha: "12123456", kohiUnits: 400,
  details: [det("171001", 600, 1, { kohiPieces: [{ days: 10, units: 200 } as KohiPiece] }), det("171003", 200, 2, { kohiPieces: [{ days: 5, units: 50 } as KohiPiece, { days: 5, units: 50 } as KohiPiece] })] })), ["kohi_detail_mismatch"]);
eq("★ 単位数 10000 (4 桁超) → unit_overflow", densouExcludeReasons(full({ details: [det("171001", 10000)] })), ["unit_overflow"]);
eq("★ サービス単位 1000000 (6 桁超) → unit_overflow", densouExcludeReasons(full({ details: [det("171001", 5000, 1, { units: 1000000 })] })), ["unit_overflow"]);
eq("★ サービスコード 111111 (訪問介護) → service_code_invalid", densouExcludeReasons(full({ details: [det("111111", 600)] })), ["service_code_invalid"]);
eq("★ サービスコード 5 桁 → service_code_invalid", densouExcludeReasons(full({ details: [det("17100", 600)] })), ["service_code_invalid"]);
eq("★ 群1 と群2 が重なれば 両方出す", densouExcludeReasons(full({ birthDate: null, benefitRateDefaulted: true })), ["benefit_rate_defaulted", "birth_date_missing"]);

console.log("══ densouLoadBlockers (価格改定の履歴) ══");
eq("ok → 止めない", densouLoadBlockers({ priceHistory: "ok" }).length, 0);
eq("★ loading → 止める (読み終わる前の出力)", densouLoadBlockers({ priceHistory: "loading" }).length, 1);
eq("★ failed → 止める (読込失敗)", densouLoadBlockers({ priceHistory: "failed" }).length, 1);

console.log(`\n${fails.length ? "✗" : "✓"} check:densou-exclude ${fails.length ? "FAIL" : "PASS"} (OK ${pass} / NG ${fails.length})`);
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1); }
