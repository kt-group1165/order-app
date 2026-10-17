/**
 * 住宅改修の書類の計算 (lib/renovationDocs.ts) の検証 (DB 不使用・純関数)
 *
 *   npm run check:renovation-docs
 *
 * 期待値は ★ 実装の出力ではなく、旧 Excel と規則から手で出している。
 *   ① 横山様 2026-07 見積 (旧 Excel): 手すり 2 箇所 × (丸棒 0.9m×4,400 + ブラケット 2×2,100 + 施工費 8,500)
 *      小計 16,660 × 2 = 工事費用計 33,320 / 諸経費 10% 3,332 / 合計 36,652
 *      ★ 消費税は旧 Excel が手入力 3,653 だったが、正しくは floor(36,652 × 10%) = 3,665 → 総合計 40,317
 *   ② 0.9 × 4,400 は浮動小数で 3960.0000000000005 になる。floor しても 3,960 (3,961 にしない)
 *   ③ 自己負担: 1 割 40,317 → 保険 floor(40,317 × 0.9) = 36,285 / 本人 4,032
 *   ④ 20 万円超: 総合計 250,000 1 割 → 保険 180,000 / 本人 70,000
 *   ⑤ 領収書の内訳: 4,032 円 → 消費税 floor(4,032 × 10/110) = 366 / 対象 3,666
 *
 * 負のコントロール: 消費税を Math.round にすると ⑥ が、round6 を外すと ⑤ (11,000 円の内訳) が落ちることを 2026-10-15 に確認。
 * 取込・掛け率 (2026-10-17 追加): salePriceFromCost の round6 を外すと「掛け率 浮動小数」が落ちることを確認。
 */
import {
  computeEstimate, estimateCopay, splitTaxIncluded, cityOf, defaultAddressee, toWareki, warekiLabel, ageAt,
  salePriceFromCost, detectEstimateColumns, parseNum, rowsToEstimateLines,
  normalizeDocs, type EstimateGroup,
} from "../lib/renovationDocs";

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else fails.push(`${label}: got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);
};

const handrail = (photo: string, place: string): EstimateGroup => ({
  kind: 1, photo_no: photo, place, part: "動線", photos: { before: null, after: null },
  lines: [
    { name: "アッシュ丸棒", spec: "マツ六 BD-112", qty: 0.9, unit: "ｍ", unit_price: 4400, basis: "" },
    { name: "エンドブラケット", spec: "マツ六 BD-08", qty: 2, unit: "個", unit_price: 2100, basis: "" },
    { name: "上記施工費", spec: "", qty: 1, unit: "式", unit_price: 8500, basis: "" },
  ],
});

// ① 横山様
const t1 = computeEstimate({ groups: [handrail("①", "廊下"), handrail("②", "玄関")], overhead_rate: 0.1, tax_rate: 0.1 });
eq("① 行金額", t1.lineAmounts[0], [3960, 4200, 8500]);
eq("① 小計", t1.groupSubtotals, [16660, 16660]);
eq("① 工事費用計/諸経費/合計", [t1.workTotal, t1.overhead, t1.subtotal], [33320, 3332, 36652]);
eq("① 消費税/総合計", [t1.tax, t1.grandTotal], [3665, 40317]);

// ② 浮動小数
eq("② 0.9×4400", computeEstimate({ groups: [{ ...handrail("①", ""), lines: [handrail("", "").lines[0]] }], overhead_rate: 0, tax_rate: 0 }).workTotal, 3960);

// 数量・単価が空の行は 0 として足さず、行金額は null
const t2 = computeEstimate({ groups: [{ ...handrail("①", ""), lines: [{ name: "x", spec: "", qty: null, unit: "", unit_price: 100, basis: "" }] }], overhead_rate: 0.1, tax_rate: 0.1 });
eq("空欄行", [t2.lineAmounts[0][0], t2.grandTotal], [null, 0]);

// ③④ 自己負担
eq("③ 1割", estimateCopay(40317, "1割"), 4032);
eq("③ 2割", estimateCopay(40317, "2割"), 40317 - Math.floor(40317 * 0.8));
eq("③ 自費", estimateCopay(40317, "自費"), 40317);
eq("③ 不明", estimateCopay(40317, null), 40317);
eq("④ 20万超 1割", estimateCopay(250000, "1割"), 70000);

// ⑤ 領収書の内訳
eq("⑤ 4,032", splitTaxIncluded(4032), { base: 3666, tax: 366 });
eq("⑤ 11,000", splitTaxIncluded(11000), { base: 10000, tax: 1000 });
// ⑥ 消費税は切り捨て (36,655 × 10% = 3,665.5 → 3,665)
eq("⑥ 消費税切捨て", computeEstimate({ groups: [{ ...handrail("", ""), lines: [{ name: "", spec: "", qty: 1, unit: "", unit_price: 33323, basis: "" }] }], overhead_rate: 0.1, tax_rate: 0.1 }).tax, 3665);

// 市区町村・宛先
eq("市原市", cityOf("千葉県市原市姉崎東2丁目2番地6"), { city: "市原市", ward: null });
eq("千葉市中央区", cityOf("千葉市中央区千葉港1-1"), { city: "千葉市", ward: "中央区" });
eq("袖ケ浦市", cityOf("袖ケ浦市奈良輪1"), { city: "袖ケ浦市", ward: null });
eq("長南町 (郡)", cityOf("千葉県長生郡長南町長南"), { city: "長南町", ward: null });
eq("市川市", cityOf("市川市八幡1"), { city: "市川市", ward: null });
eq("宛先 木更津", defaultAddressee("木更津市下烏田232-1"), "木更津市長");
eq("宛先 千葉市", defaultAddressee("千葉市花見川区幕張町"), "千葉市花見川区長");
eq("宛先 空", defaultAddressee(null), "");

// 和暦・年齢
eq("令和8", warekiLabel("2026-07-06"), "令和8年7月6日");
eq("令和元", warekiLabel("2019-05-01"), "令和元年5月1日");
eq("平成31", warekiLabel("2019-04-30"), "平成31年4月30日");
eq("昭和", toWareki("1940-03-15"), { era: "昭和", year: 15, month: 3, day: 15 });
eq("年齢 誕生日前", ageAt("1940-07-07", "2026-07-06"), 85);
eq("年齢 誕生日当日", ageAt("1940-07-06", "2026-07-06"), 86);

// 古いデータ・空でも落ちない
const n = normalizeDocs({ estimate: { groups: [{ kind: 2, lines: [{ name: "a" }] }] } }, { clientAddress: "市原市" });
eq("normalize 補完 (工事場所は住所で埋める)", [n.estimate.groups[0].kind, n.estimate.groups[0].lines[0].qty, n.estimate.site, n.reason.activities.bathing.actions], [2, null, "市原市", []]);
eq("normalize null", normalizeDocs(null, { clientAddress: "市原市" }).estimate.site, "市原市");

// ─── 施工会社の見積の取込・利益の乗せ方 (2026-10-17 追加) ───
// 単価: 仕入 4,400 × 1.25 = 5,500 / 仕入 2,100 × 1.25 = 2,625 → 10 円単位に切り上げ 2,630
eq("掛け率 5500", salePriceFromCost(4400, "unit", 0.25), 5500);
eq("掛け率 切上げ", salePriceFromCost(2100, "unit", 0.25), 2630);
eq("掛け率 0", salePriceFromCost(2100, "unit", 0), 2100);
eq("諸経費に乗せる = 仕入のまま", salePriceFromCost(2105, "overhead", 0.25), 2105);
// 浮動小数: 100 × 1.1 / 10 = 11.000000000000002 → そのまま切り上げると 120 になる (正しくは 110)
eq("掛け率 浮動小数", salePriceFromCost(100, "unit", 0.1), 110);

eq("列の推定", detectEstimateColumns(["No", "品名", "規格・寸法", "数量", "単位", "単価", "金額"]), { name: 1, spec: 2, qty: 3, unit: 4, price: 5 });
eq("列の推定 無い列は -1", detectEstimateColumns(["工事内容", "金額"]).price, -1);
eq("数値 全角・カンマ・円", [parseNum("１，２３４円"), parseNum("0.9"), parseNum(""), parseNum("一式")], [1234, 0.9, null, null]);

const map = { name: 1, spec: 2, qty: 3, unit: 4, price: 5 };
const lines = rowsToEstimateLines([
  ["1", "アッシュ丸棒", "BD-112", "0.9", "ｍ", "4,400", "3,960"],
  ["", "", "", "", "", "", ""],
  ["2", "エンドブラケット", "BD-08", "2", "個", "2100", "4200"],
  ["", "小計", "", "", "", "", "8,160"],
  ["3", "取付工事", "", "", "", "8500", ""],
  ["", "消費税", "", "", "", "816", ""],
], map, { mode: "unit", rate: 0.25 });
eq("取込 行数 (空行・小計・消費税を除く)", lines.length, 3);
eq("取込 1 行目", [lines[0].name, lines[0].qty, lines[0].cost_price, lines[0].unit_price], ["アッシュ丸棒", 0.9, 4400, 5500]);
eq("取込 数量・単位が空 → 1 式", [lines[2].qty, lines[2].unit], [1, "式"]);

// 仕入計: floor(0.9×4400)=3960 + 2×2100=4200 + 8500 = 16,660 / 税込 floor(16660×1.1)=18,326
const tc = computeEstimate({ groups: [{ kind: 1, photo_no: "", place: "", part: "", lines, photos: { before: null, after: null } }], overhead_rate: 0.1, tax_rate: 0.1 });
eq("仕入計", [tc.costSubtotal, tc.costTotal], [16660, 18326]);
// 仕入単価の無い行は仕入に数えない
eq("仕入なしの行", computeEstimate({ groups: [handrail("①", "")], overhead_rate: 0.1, tax_rate: 0.1 }).costSubtotal, 0);

console.log(`check:renovation-docs  ${pass} 件 合格 / ${fails.length} 件 不合格`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exit(fails.length ? 1 : 0);
