// attendance-excel-import-check.mts
// ケアサポ出勤簿 Excel の解析 (lib/attendance/excelImport.ts) を実ファイルで検査する。DB 不要。
//
//   npx tsx scripts/attendance-excel-import-check.mts "<♦2024.3月～【出勤簿】.xls のパス>"
//
// 期待値は 2026-11-09 時点のファイル (シートは毎月上書きされる) を別経路 (xlrd) で
// 読んだ結果。ファイルが更新されたら期待値も変わるので、そのときは表を直すこと。
// 「入力日数」= 休暇理由 か 出社/退社 のある日。様式には 勤務時間 8.0 と走行距離が
// 先に印字されている日があり (川島・信田・橋元)、それは入力とみなさない
// (別経路の集計では 勤務時間 だけの日も数えていて 23/20/20 日になっていた)。
// 負のコントロール: 年月・氏名の位置を 1 列ずらした偽シートを読ませ、検査が落ちることを確認する。

import { readFileSync } from "node:fs";
import {
  readWorkbookSheets,
  parseWorkbookSheets,
  parseSheet,
  dayToPayload,
  diffPayload,
  defaultChecked,
  type ParsedSheet,
  type SheetRows,
} from "../lib/attendance/excelImport";

const path = process.argv[2];
if (!path) {
  console.error("使い方: npx tsx scripts/attendance-excel-import-check.mts <xlsのパス>");
  process.exit(1);
}

// [シート名, 年月, 氏名, 入力日数, 行27の残業合計(null=#VALUE!)]
const EXPECTED: [string, string, string, number, number | null][] = [
  ["泉", "2026-11", "泉　恵", 0, null],
  ["仲村", "2026-10", "仲村 美香", 21, 9.0],
  ["室橋", "2026-10", "室橋 香穂", 22, 5.0],
  ["小林", "2026-10", "小林　葵亜羅", 23, 9.5],
  ["堀口", "2026-07", "堀口　理奈", 1, 0.0],
  ["阿部", "2026-10", "阿部　由美子", 22, 15.0],
  ["髙橋", "2026-10", "髙橋 晴美", 22, 12.0],
  ["川島", "2026-11", "川島　大樹", 6, 7.0],
  ["清水", "2026-10", "清水　博美", 21, 16.0],
  ["信田", "2026-09", "信田　龍一", 15, 7.0],
  ["豊藏", "2026-10", "豊藏　梨絵", 22, 38.5],
  ["鈴木", "2026-10", "鈴木　謙", 21, 0.0],
  ["鎗田", "2026-11", "鎗田　秀記", 1, 0.0],
  ["綿貫", "2026-07", "綿貫　徳勇", 22, 0.0],
  ["田村", "2026-06", "田村 裕子", 22, 10.0],
  ["堀川", "2026-03", "堀川　貴子", 6, 15.5],
  ["橋元", "2025-12", "橋元 陽子", 8, 9.0],
  ["若月", "2024-07", "若月　文雄", 24, 15.5],
  ["天野", "2025-02", "天野　千鶴", 18, 2.5],
  ["積島", "2025-03", "積島　美和", 20, 29.5],
  ["門脇", "2025-06", "門脇　志帆", 21, 7.5],
  ["田仲", "2025-09", "田仲　麻里", 22, 19.5],
  ["小杉", "2025-08", "小杉　真穂", 20, 6.5],
];

let fail = 0;
let quiet = false;
const ng = (msg: string) => {
  fail++;
  if (!quiet) console.log(`  NG ${msg}`);
};

// 行27 の残業合計が 見えている日ごとの残業の合計と合わないシート (Excel 側の事情。参考表示なので直さない)
//   川島 日ごと 2.5 / 行27 7.0 (右ブロックの小計 4.5 が 入力の無い行から出ている)
//   橋元 日ごと 6.0 / 行27 9.0 (退社の無い日・残業の空の日がある)
const DAY_SUM_MISMATCH_KNOWN = new Set(["川島", "橋元"]);

function checkAgainstExpected(parsed: ParsedSheet[], label: string): number {
  const before = fail;
  const byName = new Map(parsed.map((p) => [p.sheetName, p]));
  if (parsed.length !== EXPECTED.length) ng(`${label}: シート数 ${parsed.length} (期待 ${EXPECTED.length})`);
  for (const [sheet, ym, name, days, total] of EXPECTED) {
    const p = byName.get(sheet);
    if (!p) {
      ng(`${label}: シート ${sheet} が読めない`);
      continue;
    }
    if (p.ym !== ym) ng(`${label}: ${sheet} 年月 ${p.ym} (期待 ${ym})`);
    if (p.fullName !== name) ng(`${label}: ${sheet} 氏名 ${p.fullName} (期待 ${name})`);
    if (p.days.length !== days) ng(`${label}: ${sheet} 入力日数 ${p.days.length} (期待 ${days})`);
    if (p.excelOvertimeTotal !== total) ng(`${label}: ${sheet} 残業合計 ${p.excelOvertimeTotal} (期待 ${total})`);
    // 日ごとの残業の合計 = 行27 (Excel 自身の整合)
    if (total !== null && !DAY_SUM_MISMATCH_KNOWN.has(sheet) && Math.abs(p.excelOvertimeDaySum - total) > 1e-9) {
      ng(`${label}: ${sheet} 日ごとの残業合計 ${p.excelOvertimeDaySum} ≠ 行27 ${total}`);
    }
  }
  return fail - before;
}

const sheets = await readWorkbookSheets(readFileSync(path));
const parsed = parseWorkbookSheets(sheets);

console.log("=== 1. シートごとの 年月・氏名・入力日数・残業合計 ===");
checkAgainstExpected(parsed, "実ファイル");
for (const p of parsed) {
  console.log(
    `  ${p.sheetName.padEnd(4, "　")} ${p.ym} ${p.fullName.padEnd(8, "　")} ${String(p.days.length).padStart(2)}日 ` +
      `残業 Excel=${p.excelOvertimeTotal ?? "—"} 列7=${p.col7Header}${p.warnings.length ? ` ⚠${p.warnings.length}` : ""}`,
  );
}

console.log("=== 2. 個別の日 (解釈の確認) ===");
const kob = parsed.find((p) => p.sheetName === "小林")!;
const d31 = kob.days.find((d) => d.work_date === "2026-10-31");
if (!d31 || d31.end !== "20:35" || !d31.endShifted12h) ng(`小林 10/31 退社 08:35→20:35 の解釈 (実際 ${d31?.end})`);
if (kob.col7IsKm) ng("小林 の列7 は交通費なので km 扱いしない");
const half = kob.days.find((d) => d.work_date === "2026-10-14")!;
const hp = dayToPayload(half, { col7IsKm: kob.col7IsKm, importedOn: "2026-11-09" });
if (hp.paid_leave_type !== "half" || hp.break_minutes !== 0 || hp.start_time !== "08:49:00" || hp.business_km !== null) {
  ng(`小林 10/14 半休 → ${JSON.stringify(hp)}`);
}
const naka = parsed.find((p) => p.sheetName === "仲村")!;
const n1 = dayToPayload(naka.days[0], { col7IsKm: naka.col7IsKm, importedOn: "2026-11-09" });
if (n1.start_time !== "08:42:00" || n1.end_time !== "18:08:00" || n1.break_minutes !== 60 || n1.business_km !== 38) {
  ng(`仲村 10/01 → ${JSON.stringify(n1)}`);
}
const abe = parsed.find((p) => p.sheetName === "阿部")!;
const yu = abe.days.find((d) => d.reason === "有休")!;
const yp = dayToPayload(yu, { col7IsKm: true, importedOn: "2026-11-09" });
if (yp.paid_leave_type !== "full" || yp.start_time !== null || !yp.is_paid_leave) ng(`阿部 有休 → ${JSON.stringify(yp)}`);
const muro = parsed.find((p) => p.sheetName === "室橋")!;
const fk = muro.days.find((d) => d.reason === "振替")!;
const fp = dayToPayload(fk, { col7IsKm: true, importedOn: "2026-11-09" });
if (fp.paid_leave_type !== null || !fp.note.startsWith("振替 / Excel反映") || fp.substitute_for_date !== null) {
  ng(`室橋 振替 → ${JSON.stringify(fp)}`);
}

console.log("=== 3. 冪等 (同じ値なら変更なし・日付だけ違う備考も変更なし) ===");
const asExisting = { ...n1, note: n1.note.replace("2026-11-09", "2026-10-01") };
const again = diffPayload(n1, asExisting);
if (again.status !== "same") ng(`同じ値で status=${again.status} ${JSON.stringify(again.changes)}`);
const changed = diffPayload(n1, { ...asExisting, end_time: "18:30:00" });
if (changed.status !== "changed" || changed.changes[0]?.field !== "退社") ng("退社が違うのに changed にならない");
if (diffPayload(n1, null).status !== "new") ng("既存なしで new にならない");

console.log("=== 4. 既定チェック (今月 2026-11 のシートだけ) ===");
const checked = parsed.filter((p) => defaultChecked(p, "2026-11")).map((p) => p.sheetName);
// 泉 は入力 0 日なので選べない
if (checked.join(",") !== "川島,鎗田") ng(`既定チェック ${checked.join(",")} (期待 川島,鎗田)`);
console.log(`  既定チェック: ${checked.join(", ")}`);

console.log("=== 5. 負のコントロール (年月・氏名を 1 列ずらした偽ファイル) ===");
const shifted: SheetRows[] = sheets.map((s) => ({
  name: s.name,
  rows: s.rows.map((r, i) => (i === 3 ? [null, ...r] : r)),
}));
const failBefore = fail;
quiet = true;
const caught = checkAgainstExpected(parseWorkbookSheets(shifted), "偽");
quiet = false;
fail = failBefore; // 偽ファイルでの NG は「鳴ったこと」の確認なので合否に入れない
if (caught === 0) {
  fail++;
  console.log("  NG 負のコントロール: ずらしても検査が鳴らない (検査が効いていない)");
} else {
  console.log(`  OK 偽ファイルで ${caught} 件 鳴った`);
}
// 様式でないシートは読まない
if (parseSheet({ name: "x", rows: [["a"]] }) !== null) {
  fail++;
  console.log("  NG 様式でないシートを職員シートとして読んだ");
}

console.log(fail === 0 ? "\nPASS" : `\nFAIL ${fail} 件`);
process.exit(fail === 0 ? 0 : 1);
