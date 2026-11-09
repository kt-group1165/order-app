/**
 * 福祉用具貸与の伝送 (7111 請求書 / 7131 明細書) 様式検証 — 段2
 *
 *   npx tsx scripts/fukuyogu-densou-check.mts
 *
 * ★ 2026-11-09: ほのぼの福祉用具の実伝送 (ケアサポ 1272400050 / KK261004 = 提供 2026-09) を入手。
 *   明細 (02) の 単位数 0・日数 = 貸与日数・1 用具 1 行・摘要 TAIS、集計 (10) の実日数、
 *   要支援の 7132 / 67 の期待値を実伝送に合わせて書き換えた。DB 実データでの突合は
 *   scripts/fukuyogu-densou-honobono-diff.mts。以下の注記は入手前の記録。
 *
 * ⚠⚠ **期待値の出どころに注意 (3-5)**
 *   ほのぼのの **福祉用具の伝送は手元に 1 本も無い** (2026-09-03 実測。
 *   福祉用具 5 事業所の番号 1272400050 / 1270402124 / 1270502097 / 1271502500 /
 *   1270204132 を `伝送データ/` の 7131 に出る 19 事業所と照合して 1 つも無い)。
 *   → **突合ができないので、期待値は仕様書 `_if_svc.txt` と手計算から作っている。**
 *   仕様書は「許容される形」しか書いておらず、ベンダはその一部しか使わない。
 *   ★ **ほのぼのの福祉用具伝送が手に入ったら、必ず突合し直すこと。**
 *
 * ── ただし 1 つだけ ほのぼのの実出力を根拠にできる ─────────────────────
 *   福祉用具の伝送は 訪問介護と **同じレコード種別** (7111 / 7131-01 / 02 / 10) を使う。
 *   ほのぼの書式 (どの項に引用符を付け、どの項の空欄を 0 で埋めるか) は
 *   `kaigo-app/src/lib/kokuho-densou/honobono-format.ts` に
 *   **ほのぼのの実伝送から機械的に抽出**してある。レコード種別が同じなら流用できる。
 *   → ★ この harness は order-app の出力を **その書式に照らして**検査する。
 *
 * DB は読まない (純関数のみ)。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildFukuyoguDensou, fukuyoguServiceCode, fukuyoguRentalDaysInMonth, isYoboCareLevel, type FukuyoguSeikyuRow } from "../lib/kokuho-densou/build";
import { pickCertForMonth, certFieldsForDensou } from "../lib/kokuho-densou/cert-for-month";
import { formatRecordLikeHonobono } from "../../kaigo-app/src/lib/kokuho-densou/honobono-format";

const BASELINE = "scripts/fukuyogu-densou-check-baseline.json";
const UPDATE = process.argv.includes("--update");

let n = 0, ng = 0;
const eq = (label: string, a: unknown, b: unknown) => {
  n++;
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(52)} ${ok ? "" : `実際=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`}`);
};

// ══ 手計算 ══════════════════════════════════════════════════════════════
// 車いす 171001 300単位 × 1 / 特殊寝台 171003 900単位 × 1 / 手すり 171007 100単位 × 2
//   合計単位 = 300 + 900 + 200 = 1,400
//   単価 10.00 円固定 (福祉用具貸与は地域区分の対象外)
//   費用総額 = 1400 × 10 = 14,000
//   1 割: 保険 = floor(14000 × 9 / 10) = 12,600 / 本人 = 14,000 − 12,600 = 1,400
//   3 割: 保険 = floor(14000 × 7 / 10) =  9,800 / 本人 = 4,200
const detail = [
  { serviceCode: "171001", unitPer: 300, count: 1, units: 300, days: 30, taisCode: "00066-000352" },
  { serviceCode: "171003", unitPer: 900, count: 1, units: 900, days: 22, taisCode: "00170-001265" },
  { serviceCode: "171007", unitPer: 100, count: 2, units: 200, days: 30, taisCode: "00254-000133" },
];
const base: FukuyoguSeikyuRow = {
  userName: "見本 太郎", insurerNumber: "122192", insuredNumber: "1000000001",
  birthDate: "1940-05-03", gender: "男", careLevel: "要介護3",
  certStart: "2026-04-01", certEnd: "2029-03-31", careOfficeNumber: "1272401876",
  copayRate: 0.1, details: detail,
  totalUnits: 1400, totalCost: 14000, insuranceAmount: 12600, userAmount: 1400,
};
const kohi: FukuyoguSeikyuRow = {
  ...base, userName: "見本 花子", insuredNumber: "1000000002", careLevel: "要介護1",
  // 生保: 本人負担 1,400 を公費へ振替 → 本人 0
  userAmount: 0, kohiHobetsu: "12", kohiFutansha: "12123519", kohiJukyusha: "0068742", kohiAmount: 1400,
};

const res = buildFukuyoguDensou([base, kohi], { officeNumber: "1270402124", year: 2026, month: 12 });
const lines = res.content.split("\r\n").filter((l) => l !== "");
// ★ 2026-11-09: build.ts がほのぼの書式 (引用符) で出すようになったので、値を見るときは引用符を外す
const unq = (v: string) => v.replace(/^"(.*)"$/, "$1");
const cols = (l: string) => l.split(",").map(unq);
const rawCols = (l: string) => l.split(",");
const pick = (form: string, kind: string | null) =>
  lines.filter((l) => {
    const c = cols(l);
    return c[0] === "2" && c[2] === form && (kind == null || c[3] === kind);
  }).map(cols);

console.log("══ サービスコードの引き当て (告示の福祉用具貸与 17xxxx) ══");
eq("車いす → 171001", fukuyoguServiceCode("車いす"), "171001");
eq("特殊寝台付属品 → 171004", fukuyoguServiceCode("特殊寝台付属品"), "171004");
eq("認知症老人徘徊感知機器 → 171011", fukuyoguServiceCode("認知症老人徘徊感知機器"), "171011");
eq("自動排せつ処理装置 → 171013 (送り仮名ゆれ)", fukuyoguServiceCode("自動排せつ処理装置"), "171013");
eq("★ 存在しない種目は null (推測で埋めない)", fukuyoguServiceCode("歩行補助つえ(多点)"), null);
eq("★ 空文字は null", fukuyoguServiceCode(""), null);

console.log("\n══ ファイル構造 ══");
eq("先頭はコントロールレコード (種別1)", cols(lines[0])[0], "1");
eq("末尾はエンドレコード (種別3)", cols(lines[lines.length - 1])[0], "3");
eq("データ件数がコントロールと一致", Number(cols(lines[0])[3]), res.dataRecordCount);
eq("★ 媒体区分 7 (インターネット伝送)", cols(lines[0])[9], "7");
eq("★ 処理対象年月 = 審査月 (提供 202612 → 202701)", cols(lines[0])[10], "202701");
eq("レコード番号が 1 から連番", lines.map((l) => cols(l)[1]).join(","),
  lines.map((_, i) => String(i + 1)).join(","));
eq("ファイル名", res.fileName, "F202612.CSV");
eq("★ 改行は CRLF", res.content.includes("\r\n"), true);

console.log("\n══ 7111 請求書 ══");
const r7111 = pick("7111", null);
eq("保険請求分 1 + 公費請求分 1 = 2 レコード", r7111.length, 2);
const hoken = r7111.find((c) => c[5] === "1")!;
const kohiRec = r7111.find((c) => c[5] === "2")!;
eq("保険分 件数", hoken[8], "2");
eq("保険分 単位数 (1400 × 2)", hoken[9], "2800");
eq("保険分 費用合計 (14000 × 2)", hoken[10], "28000");
eq("保険分 保険請求額 (12600 × 2)", hoken[11], "25200");
// ★ 2026-10-15 訂正: 期待値を "0" にしていたのは誤り。ほのぼの実伝送 (姉ム 訪問介護 KK260704) の
//   7111 保険分レコード 項11 = 56,227 = 公費分レコードの公費請求額と同額で、0 ではない。
//   kaigo-app build.ts:153 も公費請求額の合計を入れておりバイト一致済み。order-app も同じに揃えた。
eq("★ 保険分の公費請求額 = 公費併用分の公費請求額の合計 (1400)", hoken[12], "1400");
eq("保険分 利用者負担 (1400 + 0)", hoken[13], "1400");
eq("公費分 法別番号", kohiRec[6], "12");
eq("★ 公費分の保険請求額は 0 (再掲しない = 二重計上の防止)", kohiRec[11], "0");
eq("公費分 公費請求額", kohiRec[12], "1400");
eq("★ 公費分の利用者負担は 0", kohiRec[13], "0");
eq("★ 保険分 + 公費分を足すと二重計上になる (単位数が両方 1400 出る)",
  Number(hoken[9]) + Number(kohiRec[9]), 4200);

console.log("\n══ 7131-01 基本情報 ══");
const b = pick("7131", "01");
eq("利用者数ぶん出る", b.length, 2);
eq("★ 証記載保険者番号は 8 桁 0 埋め (122192 → 00122192)", b[0][6], "00122192");
eq("被保険者番号", b[0][7], "1000000001");
eq("生年月日 (YYYYMMDD)", b[0][14], "19400503");
eq("性別コード 男=1", b[0][15], "1");
eq("要介護3 → 区分コード 23", b[0][16], "23");
eq("認定有効期間 開始/終了", [b[0][18], b[0][19]], ["20260401", "20290331"]);
eq("居宅サービス計画作成区分 (事業所番号あり → 1)", b[0][20], "1");
eq("担当居宅介護支援事業所番号", b[0][21], "1272401876");
eq("★ 保険給付率 1割 → 90", b[0][30], "90");
eq("合計 単位数 / 請求額 / 利用者負担", [b[0][34], b[0][35], b[0][36]], ["1400", "12600", "1400"]);
eq("公費なしの人は公費欄が空", [b[0][8], b[0][9], b[0][31]], ["", "", ""]);
eq("★ 開始・中止年月日は渡さなければ空", [b[0][22], b[0][23], b[0][24]], ["", "", ""]);
eq("★ 公費ありの人は 負担者/受給者番号が出る", [b[1][8], b[1][9]], ["12123519", "0068742"]);
eq("★ 公費1給付率 100", b[1][31], "100");
eq("公費1 合計 (単位数 / 請求額 / 本人負担)", [b[1][40], b[1][41], b[1][42]], ["1400", "1400", "0"]);
eq("★ 公費ありの人は 利用者負担 0 (公費へ振替済み)", b[1][36], "0");

console.log("\n══ 7131-02 明細 ══");
const d = pick("7131", "02");
// ★ 2026-11-09 期待値を ほのぼの実伝送 (ケアサポ KK261004) に合わせた。旧期待値は仕様書由来で
//   [単位数, 回数] = [300, 1] / 個数 2 は 1 行 (100 × 2) だったが、ほのぼのは
//   項9 単位数 = 0 / 項10 = 当月の貸与日数 / 1 用具 1 行 (同じ用具 2 個は 2 行) / 項18 摘要 = TAIS
eq("★ 明細は 1 用具 1 行 (個数 2 は 2 行) → (3 + 1) × 2 名 = 8 行", d.length, 8);
eq("★ サービス種類コードは 17 (福祉用具貸与)", d[0][8], "17");
eq("サービス項目コード (171001 → 1001)", d[0][9], "1001");
eq("★ 単位数 0 / 日数 = 貸与日数 30 / サービス単位数 300", [d[0][10], d[0][11], d[0][15]], ["0", "30", "300"]);
eq("★ 月途中から (22 日) の用具は 日数 22", [d[1][11], d[1][15]], ["22", "900"]);
eq("★ 個数 2 は 100 単位の行が 2 本", [d[2][15], d[3][15], d[2][9], d[3][9]], ["100", "100", "1007", "1007"]);
eq("★ 摘要 (項18) = TAIS コード (引用符付き)", [d[0][19], rawCols(lines.find((l) => cols(l)[3] === "02")!)[19]], ["00066-000352", `"00066-000352"`]);
eq("公費なしは 公費1対象 が 0 (ほのぼの書式の 0 埋め)", [d[0][12], d[0][16]], ["0", "0"]);
eq("★ 公費ありは 公費1対象 = 保険と同値 (日数・単位)", [d[4][12], d[4][16]], ["30", "300"]);

console.log("\n══ 7131-10 集計 ══");
const s = pick("7131", "10");
eq("利用者ごとに 1 行", s.length, 2);
eq("サービス種類コード 17", s[0][8], "17");
// ★ 2026-11-09: 旧期待値 0 は仕様書の読み違い (※6 は 明細の単位数 の注記)。ほのぼのは明細の貸与日数の最大を入れる
eq("★ サービス実日数 = 明細の貸与日数の最大 (30)", s[0][9], "30");
eq("計画単位数 / 限度額管理対象 / 対象外", [s[0][10], s[0][11], s[0][12]], ["1400", "1400", "0"]);
eq("★ 単位数単価は 1000 (= 10.00円。地域区分の対象外で固定)", s[0][16], "1000");
eq("保険 単位数合計 / 請求額 / 利用者負担", [s[0][15], s[0][17], s[0][18]], ["1400", "12600", "1400"]);
eq("公費1 (単位数 / 請求額 / 本人負担)", [s[1][19], s[1][20], s[1][21]], ["1400", "1400", "0"]);

console.log("\n══ ★ 介護予防 (要支援 → 7132 / サービス種類 67) — ほのぼの実伝送 KK261004 と同じ形 ══");
eq("要支援2 の種目コード → 671007", fukuyoguServiceCode("手すり", "要支援２"), "671007");
eq("要介護1 の種目コード → 171007", fukuyoguServiceCode("手すり", "要介護1"), "171007");
eq("★ isYoboCareLevel (要支援1/2 のみ。事業対象者・要介護は false)",
  [isYoboCareLevel("要支援1"), isYoboCareLevel("要支援２"), isYoboCareLevel("事業対象者"), isYoboCareLevel("要介護1"), isYoboCareLevel(null)],
  [true, true, false, false, false]);
{
  // 17 のコードのまま渡しても 要介護度で 67 に直る (BillingTab は種目からのコードを 17 で渡す)
  const yobo: FukuyoguSeikyuRow = {
    ...base, userName: "見本 予防", insurerNumber: "122069", insuredNumber: "0000000009", careLevel: "要支援2",
    details: [{ serviceCode: "171007", unitPer: 300, count: 1, units: 300, days: 7, taisCode: "00254-000416" }],
    totalUnits: 300, totalCost: 3000, insuranceAmount: 2700, userAmount: 300,
    serviceStartDate: "2026-12-08", serviceStopDate: "2026-12-14", stopReason: "3",
  };
  const yr = buildFukuyoguDensou([yobo, base, { ...base, insuredNumber: "0000000001" }], { officeNumber: "1270402124", year: 2026, month: 12 });
  const yLines = yr.content.split("\r\n").filter(Boolean);
  const yl = yLines.map(cols).filter((c) => c[0] === "2" && c[2] !== "7111");
  eq("★ 要支援は 7132 で 01/02/10", yl.filter((c) => c[2] === "7132").map((c) => c[3]), ["01", "02", "10"]);
  eq("★ 並び順: 7131 を (保険者+被保番) 昇順で全部 → 7132",
    yl.filter((c) => c[3] === "01").map((c) => `${c[2]}|${c[6]}|${c[7]}`),
    ["7131|00122192|0000000001", "7131|00122192|1000000001", "7132|00122069|0000000009"]);
  const y1 = yl.find((c) => c[2] === "7132" && c[3] === "01")!;
  const y2 = yl.find((c) => c[2] === "7132" && c[3] === "02")!;
  const y10 = yl.find((c) => c[2] === "7132" && c[3] === "10")!;
  eq("★ 7132-02 サービス種類 67 / 項目 1007 / 日数 7", [y2[8], y2[9], y2[11]], ["67", "1007", "7"]);
  eq("★ 7132-10 サービス種類 67 / 実日数 7 / 単価 1000", [y10[8], y10[9], y10[16]], ["67", "7", "1000"]);
  eq("★ 7132-01 要介護度 13 / 開始 20261208 / 中止 20261214 / 理由 3", [y1[16], y1[22], y1[23], y1[24]], ["13", "20261208", "20261214", "3"]);
  const yh = yLines.map(cols).find((c) => c[2] === "7111" && c[5] === "1")!;
  eq("★ 7111 の件数・単位数は 7131 と 7132 の合計 (3 件 / 1400+1400+300)", [yh[8], yh[9]], ["3", "3100"]);
  // KK261004 の 7132-02 の実レコードと同じ形 (引用符・0 埋めまで)
  eq("★ 7132-02 の書式は ほのぼの実伝送と同じ", rawCols(yLines.find((l) => l.includes(`"7132",02`))!).slice(2).join(","),
    `"7132",02,202612,1270402124,00122069,"0000000009",67,1007,0,7,0,0,0,300,0,0,0,"00254-000416"`);
}

console.log("\n══ ★ 日付・貸与日数・認定の選び方 (2026-11-09 実データで見つかったもの) ══");
{
  const sl = buildFukuyoguDensou([{ ...base, certStart: "2026/2/19", certEnd: "2027/2/28" }], { officeNumber: "1270402124", year: 2026, month: 12 });
  const sb = sl.content.split("\r\n").filter(Boolean).map(cols).find((c) => c[3] === "01")!;
  eq("★ 認定期間 \"2026/2/19\" 形式も YYYYMMDD に直る", [sb[18], sb[19]], ["20260219", "20270228"]);
  eq("貸与日数 通月 (2026-09)", fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09"), 30);
  eq("貸与日数 9/9 開始 → 22", fukuyoguRentalDaysInMonth("2026-09-09", null, "2026-09"), 22);
  eq("貸与日数 9/22 終了 → 22", fukuyoguRentalDaysInMonth("2026-04-01", "2026-09-22", "2026-09"), 22);
  eq("貸与日数 9/30 開始 → 1 / 9/11〜9/27 → 17",
    [fukuyoguRentalDaysInMonth("2026-09-30", null, "2026-09"), fukuyoguRentalDaysInMonth("2026-09-11", "2026-09-27", "2026-09")], [1, 17]);
  eq("★ 負のコントロール: 当月に掛からない貸与は 0", fukuyoguRentalDaysInMonth("2026-10-01", null, "2026-09"), 0);
  const c1 = pickCertForMonth([
    { effective_date: "2025-09-01", certification_start_date: "2025-09-01", certification_end_date: "2026-08-31", care_level: "要介護1" },
    { effective_date: "2026-09-01", certification_start_date: "2026-09-01", certification_end_date: "2030-08-31", care_level: "要介護2" },
  ], "2026-09-01", "2026-09-30");
  eq("★ 当月有効の認定を選ぶ (更新後の 要介護2)", c1?.care_level, "要介護2");
  eq("★ 認定が無ければ clients の列",
    certFieldsForDensou({ care_level: "要支援1", certification_start_date: "2026-01-01", certification_end_date: null }, null).careLevel, "要支援1");
}

console.log("\n══ 金額の丸め (国保連は 円未満切り捨て) ══");
// 端数が出る組み合わせ: 1,401 単位 = 14,010 円 / 2割 → floor(14010 × 8/10) = 11,208
const odd = buildFukuyoguDensou([{
  ...base, copayRate: 0.2, totalUnits: 1401, totalCost: 14010,
  insuranceAmount: Math.floor(14010 * 8 / 10), userAmount: 14010 - Math.floor(14010 * 8 / 10),
  details: [{ serviceCode: "171001", unitPer: 1401, count: 1, units: 1401 }],
}], { officeNumber: "1270402124", year: 2026, month: 12 });
const ob = odd.content.split("\r\n").filter(Boolean).map(cols).find((c) => c[2] === "7131" && c[3] === "01")!;
eq("★ 保険給付率 2割 → 80", ob[30], "80");
eq("保険請求額 = floor(14010 × 8 / 10)", ob[35], "11208");
eq("★ 端数は利用者負担に寄る (14010 − 11208)", ob[36], "2802");
eq("★ 保険 + 利用者 = 費用総額 (恒等式)", Number(ob[35]) + Number(ob[36]), 14010);

console.log("\n══ 異常系 ══");
const bad = buildFukuyoguDensou([{ ...base, insurerNumber: null, insuredNumber: "" }],
  { officeNumber: "127040211", year: 2026, month: 12 });
eq("★ 事業所番号が 10 桁でないと警告", bad.warnings.some((w) => w.includes("10 桁")), true);
eq("★ 保険者番号が無いと警告", bad.warnings.some((w) => w.includes("保険者番号")), true);
eq("★ 被保険者番号が無いと警告", bad.warnings.some((w) => w.includes("被保険者番号")), true);
eq("利用者 0 名でもファイルは組める", buildFukuyoguDensou([], { officeNumber: "1270402124", year: 2026, month: 12 })
  .content.split("\r\n").filter(Boolean).length, 3); // control + 7111 + end

console.log("\n══ ★ ほのぼの書式との差 (レコード種別が同じなので流用できる唯一の実出力根拠) ══");
console.log("  kaigo-app の honobono-format.ts は **ほのぼのの実伝送から機械的に抽出**した");
console.log("  「どの項に引用符を付け / どの項の空欄を 0 で埋めるか」を持つ。");
console.log("  福祉用具も同じ 7111 / 7131-01・02・10 を使うので、そのまま当てられる。");
let fmtDiff = 0;
for (const l of lines) {
  const c = cols(l);
  if (c[0] !== "2") continue;
  // 書式は引用符付きのまま見る (cols は引用符を外すので rawCols)。7132 は kaigo-app に規則が無いので素通り
  const parts = rawCols(l).slice(2);
  const want = formatRecordLikeHonobono(parts);
  if (JSON.stringify(parts) !== JSON.stringify(want)) {
    if (fmtDiff < 3) {
      console.log(`   実際: ${parts.slice(0, 12).join(",")}`);
      console.log(`   書式: ${want.slice(0, 12).join(",")}`);
    }
    fmtDiff++;
  }
}
n++;
if (fmtDiff === 0) {
  console.log(`  OK  ほのぼの書式と一致`);
} else {
  ng++;
  console.log(`  NG  ★ ${fmtDiff} / ${lines.filter((l) => cols(l)[0] === "2").length} レコードが ほのぼの書式と違う`);
  console.log(`      order-app は formatRecordLikeHonobono を通していない (kaigo-app は通している)。`);
  console.log(`      ⚠ 国保連が受け付けるかは別問題だが、**ほのぼのが通っている形に揃える**のが安全。`);
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
console.log(`⚠ この検査の期待値は 仕様書 _if_svc.txt と手計算 から作り、2026-11-09 に`);
console.log(`  ほのぼの福祉用具の実伝送 (ケアサポ KK261004) で明細・集計・7132 の形を突合し直した。`);
console.log(`  実データでの突合は scripts/fukuyogu-densou-honobono-diff.mts (DB を読む。手で回す)。`);

// =====================================================================
// 基準値方式 (2026-09-05 / DECISIONS_PENDING.md B-2t・B-2x)
//   ★ 「既知だから緑にする」のではなく「既知の件数を固定して、それ以上を検出する」。
//   fixture ベースの純関数テストなので (DBの実データに依存しない)、指紋は持たない —
//   このファイル自体が変われば git diff でわかる。
// =====================================================================
type Baseline = { _readme: string[]; asOf: string; ng: number };

let baseline: Baseline | null = null;
if (existsSync(BASELINE)) baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

if (UPDATE || !baseline) {
  const out: Baseline = {
    _readme: [
      "npm run check:fukuyogu-densou の基準値。",
      "",
      "■ なぜ 1 件なのか",
      "  order-app の build.ts (buildFukuyoguDensou) が formatRecordLikeHonobono を",
      "  通していない (kaigo-app の build.ts は通している)。ほのぼの福祉用具の実出力が",
      "  手元に無いため、この書式差自体を『直すべきか』は未確定 — 通せば 0 になるはず",
      "  だが、それが国保連の取込仕様として正しいかは実出力入手まで断定できない。",
      "  (DECISIONS_PENDING.md B-2t / B-2x)",
      "",
      "■ 0件を目指さない (今は)",
      "  user 判断 (formatRecordLikeHonobono を通すか) が決まるまでは 1 件のまま。",
      "  0 になったら基準値を更新すること。",
    ],
    asOf: new Date().toISOString().slice(0, 10),
    ng,
  };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n--update: 基準値を書きました (${BASELINE})`);
  process.exit(0);
}

console.log(`\n基準値 (${baseline.asOf} 時点): NG ${baseline.ng} 件`);
if (ng > baseline.ng) {
  console.log(`★ FAIL — NGが基準値 (${baseline.ng}件) より増えた (現在 ${ng}件)。新しい乖離を確認すること。`);
  process.exit(1);
}
if (ng < baseline.ng) {
  console.log(`✓ PASS — NGが基準値 (${baseline.ng}件) より減った (現在 ${ng}件)。改善している。--update で基準値を下げてよい。`);
  process.exit(0);
}
console.log(`✓ PASS — 基準値どおり ${ng} 件 (既知・DECISIONS_PENDING.md B-2t/B-2x で user 判断待ち)。`);
