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
 * ・buildFukuyoguDensou に組み込んだ結果: 外した人は 01/02/10 にも 7111 の件数・単位・金額にも入らず excluded に理由つきで出る /
 *   正常な人は 1 人も外れず 7111 に全員入る (逆向きの対照)
 */
import { densouExcludeReasons, densouLoadBlockers, summarizeExcluded, type DensouExcludeInput } from "../lib/kokuho-densou/densou-exclude";
import { computeFukuyoguAmounts, type KohiPiece } from "../lib/kokuho-densou/fukuyogu-amounts";
import { dateNum, isUnreadableDate } from "../lib/kokuho-densou/date-num";
import { buildFukuyoguDensou, type FukuyoguDetailLine, type FukuyoguSeikyuRow } from "../lib/kokuho-densou/build";

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
// 読めない日付 (2026-11-14 追加)。判定は date-num.ts の dateNum (= 伝送の項13・17・18 と同じ関数)
eq("★ 生年月日 \"S15.3.3\" (和暦) → birth_date_unreadable (「空」とは別の理由)", densouExcludeReasons(full({ birthDate: "S15.3.3" })), ["birth_date_unreadable"]);
eq("★ 生年月日 \"昭和15年3月3日\" → birth_date_unreadable", densouExcludeReasons(full({ birthDate: "昭和15年3月3日" })), ["birth_date_unreadable"]);
eq("★ 認定開始 \"R8/8/1\" → cert_period_unreadable", densouExcludeReasons(full({ certStart: "R8/8/1", certEnd: "2029-07-31" })), ["cert_period_unreadable"]);
eq("★ 認定終了だけ読めない (\"2029年7月31日\") → cert_period_unreadable", densouExcludeReasons(full({ certStart: "2026-08-01", certEnd: "2029年7月31日" })), ["cert_period_unreadable"]);
eq("外れない: 生年月日 \"1940/5/3\"・\"１９４０－０５－０３\" (全角)・\"1940-05-03 00:00:00\"", [
  densouExcludeReasons(full({ birthDate: "1940/5/3" })), densouExcludeReasons(full({ birthDate: "１９４０-０５-０３" })), densouExcludeReasons(full({ birthDate: "1940-05-03 00:00:00" }))], [[], [], []]);
eq("外れない: 認定期間が空 (従来どおり外さない) / \"2026/8/1\"〜\"2029/7/31\"", [
  densouExcludeReasons(full({ certStart: null, certEnd: "" })), densouExcludeReasons(full({ certStart: "2026/8/1", certEnd: "2029/7/31" }))], [[], []]);
eq("★ 判定と伝送が同じ関数: 読めない値は dateNum で空欄 / 読める値は 8 桁", [dateNum("S15.3.3"), dateNum("R8/8/1"), dateNum("1940/5/3"), isUnreadableDate(""), isUnreadableDate("S15.3.3")], ["", "", "19400503", false, true]);
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

console.log("══ buildFukuyoguDensou — 外した人は 7111 からも抜ける / 正常な人は抜けない ══");
{
  const row = (name: string, insured: string, over: Partial<FukuyoguSeikyuRow> = {}): FukuyoguSeikyuRow => ({
    userName: name, insurerNumber: "122192", insuredNumber: insured, birthDate: "1940-05-03", gender: "男",
    careLevel: "要介護3", certStart: "2026-04-01", certEnd: "2029-03-31", careOfficeNumber: "1272401876",
    copayRate: 0.1, details: [det("171001", 600), det("171003", 200, 2)],
    totalUnits: 1000, limitTargetUnits: 1000, planUnits: 1000, totalCost: 10000, insuranceAmount: 9000, userAmount: 1000,
    benefitRateDefaulted: false, ...over,
  });
  const cols = (l: string) => l.split(",").map((v) => v.replace(/^"|"$/g, ""));
  const recs = (content: string) => content.split(/\r?\n/).filter(Boolean).map(cols);
  const t7111 = (content: string) => { const r = recs(content).find((x) => x[2] === "7111" && x[5] === "1"); return r ? [r[8], r[9], r[10], r[11]] : null; }; // 7111 項7 件数・8 単位・9 費用・10 保険請求 (行頭に "2,連番," があるので 項k = x[k+1])
  const insuredIn01 = (content: string) => recs(content).filter((x) => x[3] === "01").map((x) => x[7]); // 01 項6 被保険者番号
  const goodRows = [row("正常 一郎", "1000000001"), row("正常 二郎", "1000000002", { copayRate: 0.2, insuranceAmount: 8000, userAmount: 2000 }),
    row("正常 三郎", "1000000003", { kohiHobetsu: "12", kohiFutansha: "12123519", kohiJukyusha: "0068742", kohiUnits: 1000, kohiAmount: 1000, userAmount: 0 })];
  const good = buildFukuyoguDensou(goodRows, { officeNumber: "1272400050", year: 2026, month: 9 });
  eq("正常な 3 名 → excluded 0 / 01 に 3 名 / 7111 保険分 件数 3・単位 3000・費用 30000・保険 26000", [good.excluded.length, insuredIn01(good.content).length, t7111(good.content)], [0, 3, ["3", "3000", "30000", "26000"]]);
  const broken: [string, Partial<FukuyoguSeikyuRow>, string][] = [
    ["給付率を既定 1 割", { benefitRateDefaulted: true }, "給付率"],
    ["公費対象 > 保険", { kohiHobetsu: "12", kohiFutansha: "12123519", kohiUnits: 1200 }, "公費対象単位数が保険"],
    ["請求 > 実績", { limitTargetUnits: 900 }, "実績を超えて"],
    ["生年月日が空", { birthDate: null }, "生年月日"],
    ["公費の負担者番号が空", { kohiHobetsu: "12", kohiFutansha: null, kohiUnits: 1000 }, "負担者番号"],
    ["桁あふれ", { details: [det("171001", 10000)], totalUnits: 10000, limitTargetUnits: 10000, planUnits: 10000, totalCost: 100000, insuranceAmount: 90000, userAmount: 10000 }, "桁あふれ"],
    ["サービスコード違い", { details: [det("111111", 600), det("171003", 200, 2)] }, "サービスコード"],
  ];
  for (const [label, over, word] of broken) {
    const res = buildFukuyoguDensou([...goodRows, row("壊れ 太郎", "1000000099", over)], { officeNumber: "1272400050", year: 2026, month: 9 });
    eq(`★ ${label} → 1 名外れ (理由に「${word}」) / 01 に出ない / 7111 は正常 3 名ぶんのまま`,
      [res.excluded.map((e) => e.userName), res.excluded[0]?.reason.includes(word), insuredIn01(res.content).includes("1000000099"), t7111(res.content)],
      [["壊れ 太郎"], true, false, t7111(good.content)]);
  }
  const oldExcl = buildFukuyoguDensou([...goodRows, row("番号 無し", "")], { officeNumber: "1272400050", year: 2026, month: 9 });
  eq("既存の除外 (被保険者番号が空) も excluded に載る", oldExcl.excluded.map((e) => [e.userName, e.reason]), [["番号 無し", "被保険者番号が未登録"]]);

  // 請求画面の確認の先頭に出す 1 行 (summarizeExcluded)
  eq("まとめ: 外した人がいなければ null (確認に余計な行を出さない)", summarizeExcluded(good.excluded), null);
  const two = buildFukuyoguDensou([...goodRows, row("壊れ 甲", "1000000098", { birthDate: null }), row("番号 無し", "")], { officeNumber: "1272400050", year: 2026, month: 9 });
  const sm = summarizeExcluded(two.excluded) ?? "";
  eq("★ まとめ: 2 名・費用 計 20,000 円・理由ごとの人数 (生年月日 1 / 被保険者番号 1)",
    [sm.includes("外した人 2 名"), sm.includes("計 20,000 円"), sm.includes("生年月日が未登録 1 名"), sm.includes("被保険者番号が未登録 1 名")], [true, true, true, true]);
}

console.log("══ densouLoadBlockers (価格改定の履歴) ══");
eq("ok → 止めない", densouLoadBlockers({ priceHistory: "ok" }).length, 0);
eq("★ loading → 止める (読み終わる前の出力)", densouLoadBlockers({ priceHistory: "loading" }).length, 1);
eq("★ failed → 止める (読込失敗)", densouLoadBlockers({ priceHistory: "failed" }).length, 1);

console.log(`\n${fails.length ? "✗" : "✓"} check:densou-exclude ${fails.length ? "FAIL" : "PASS"} (OK ${pass} / NG ${fails.length})`);
if (fails.length) { for (const f of fails) console.error(`  ✗ ${f}`); process.exit(1); }
