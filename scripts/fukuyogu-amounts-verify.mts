/**
 * 福祉用具の 保険請求額・利用者負担・公費請求額 (computeFukuyoguAmounts) の検証 (DB 不使用・純関数)
 *
 *   npm run check:fukuyogu-amounts
 *
 * 期待値は ★ 実装の出力ではなく、規則から手で出している。
 *   通常      保険 = floor(費用総額 × 給付率 / 100) / 本人 = 残り
 *   生保併用  本人負担を公費へ振替 (本人 0・公費 = 本来の本人負担)
 *   公費単独 (被保険者番号 H)  ★ 保険 0・公費 = 費用総額の全額・本人 0 (給付率 "0" が正しい)
 *     2026-10-15 まで "0" を 1 割 (90) に倒していた = 保険資格の無い人に 9 割を保険請求していた
 *
 * 負のコントロール: 公費単独の判定を外すと ③④⑤ が落ちることを 2026-10-15 に確認。
 */
import { computeFukuyoguAmounts, type FukuyoguKohi } from "../lib/kokuho-densou/fukuyogu-amounts";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};
const SEIHO: FukuyoguKohi = { hobetsu: "12", futansha: "12123519", jukyusha: "0105262" };
const pick = (a: ReturnType<typeof computeFukuyoguAmounts>) =>
  [a.insuranceAmount, a.userAmount, a.kohiAmount, a.kohiTandoku];

// ① 1 割 (給付率 90)  720 単位 = 7,200 円 → 保険 6,480 / 本人 720
eq("① 1割", pick(computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "0001234567", totalUnits: 720, kohi: null })), [6480, 720, null, false]);
// ② 2 割
eq("② 2割", pick(computeFukuyoguAmounts({ benefitRateRaw: "80", insuredNumber: "0001234567", totalUnits: 720, kohi: null })), [5760, 1440, null, false]);
// ③ ★ 公費単独 (H・給付率 0・生保あり) → 保険 0 / 本人 0 / 公費 7,200
eq("③ 公費単独", pick(computeFukuyoguAmounts({ benefitRateRaw: "0", insuredNumber: "H351000485", totalUnits: 720, kohi: SEIHO })), [0, 0, 7200, true]);
// ④ ★ 公費単独 の小文字 h・給付率が誤って 90 でも 保険では請求しない (警告は出る)
const a4 = computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: " h100000001", totalUnits: 100, kohi: SEIHO });
eq("④ 公費単独 給付率90でも保険0", pick(a4), [0, 0, 1000, true]);
eq("④ 警告あり", a4.warnings.length, 1);
// ⑤ ★ 公費単独 なのに公費未登録 → 金額は 10 割公費で出し、法別は 12 に倒し、警告を出す
const a5 = computeFukuyoguAmounts({ benefitRateRaw: "0", insuredNumber: "H000012345", totalUnits: 300, kohi: null });
eq("⑤ 公費未登録でも保険0", pick(a5), [0, 0, 3000, true]);
eq("⑤ 法別 12", a5.kohiHobetsu, "12");
eq("⑤ 警告あり", a5.warnings.length, 1);
// ⑥ 生保併用 (H でない) → 本人負担を公費へ振替
eq("⑥ 生保併用", pick(computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "0001234567", totalUnits: 720, kohi: SEIHO })), [6480, 0, 720, false]);
// ⑦ H でない人の給付率 "0" は 従来どおり 1 割に倒して警告 (挙動を変えていない)
const a7 = computeFukuyoguAmounts({ benefitRateRaw: "0", insuredNumber: "0001234567", totalUnits: 720, kohi: null });
eq("⑦ 非H の 0 は1割+警告", [a7.insuranceAmount, a7.warnings.length], [6480, 1]);
// ⑧ 未設定 → 1 割 + 警告
const a8 = computeFukuyoguAmounts({ benefitRateRaw: null, insuredNumber: "0001234567", totalUnits: 720, kohi: null });
eq("⑧ 未設定は1割+警告", [a8.insuranceAmount, a8.warnings.length], [6480, 1]);
// ⑨ 端数: 333 単位 3 割 = 3,330 円 → 保険 floor(2331) / 本人 999
eq("⑨ 端数切捨て", pick(computeFukuyoguAmounts({ benefitRateRaw: "70", insuredNumber: "0001234567", totalUnits: 333, kohi: null })), [2331, 999, null, false]);

console.log(`check:fukuyogu-amounts  ${pass} 件 合格 / ${fails.length} 件 不合格`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
