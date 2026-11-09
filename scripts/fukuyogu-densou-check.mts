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
import { buildFukuyoguDensou, careLevelCodeForDensou, fukuyoguServiceCode, fukuyoguRentalDaysInMonth, isYoboCareLevel, type FukuyoguSeikyuRow } from "../lib/kokuho-densou/build";
import { pickCertForMonth, certFieldsForDensou } from "../lib/kokuho-densou/cert-for-month";
import { computeFukuyoguAmounts, normalizeCmUnits, normalizeSelfPay, kohiCoverageInMonth, KOHI_MONTH_MODE_DEFAULT, type FukuyoguAmounts, type KohiMonthMode } from "../lib/kokuho-densou/fukuyogu-amounts";
import { halfMonthFlags, halfMonthUnits, hospitalizationRanges } from "../lib/half-month-units";
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

  // ── ★ 休止 (order_item_pauses。2026-11-09 FY-PZ) ──────────────────────────────
  // 期待値 = ほのぼの福祉用具 提供票 (用具貸与期間_20261109/提供票_202609.csv) の実績の印の数 = KK261004 の 7131-02 項10
  //   山口 裕   印 9/1〜14・9/28〜30 → 休止 9/15〜9/27 → 17
  //   江藤 久美 印 9/1〜10・9/29〜30 → 休止 9/11〜9/28 → 12
  //   小川 幸江 印 9/1〜10・9/23〜30 → 休止 9/11〜9/22 → 18
  console.log("  ── 休止 ──");
  const yamaguchi = [{ from: "2026-09-15", to: "2026-09-27" }];
  eq("★ 休止 山口 裕 9/15〜9/27 → 17 (KK261004)", fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09", yamaguchi), 17);
  eq("★ 休止 江藤 久美 9/11〜9/28 → 12 (KK261004)", fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09", [{ from: "2026-09-11", to: "2026-09-28" }]), 12);
  eq("★ 休止 小川 幸江 9/11〜9/22 → 18 (KK261004)", fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09", [{ from: "2026-09-11", to: "2026-09-22" }]), 18);
  eq("★ 負のコントロール: 休止を渡さなければ 山口 裕 は 30 (=当方の旧出力)", fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09"), 30);
  eq("休止 2 回 (9/3〜9/5・9/20〜9/21) → 30−3−2 = 25",
    fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09", [{ from: "2026-09-03", to: "2026-09-05" }, { from: "2026-09-20", to: "2026-09-21" }]), 25);
  const cross = [{ from: "2026-08-20", to: "2026-09-05" }];
  eq("月をまたぐ休止 8/20〜9/5: 8 月 31−12 = 19 / 9 月 30−5 = 25",
    [fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-08", cross), fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09", cross)], [19, 25]);
  eq("休止が貸与期間の外にもかかる (9/9 開始・休止 9/1〜9/10) → 22−2 = 20",
    fukuyoguRentalDaysInMonth("2026-09-09", null, "2026-09", [{ from: "2026-09-01", to: "2026-09-10" }]), 20);
  eq("全月休止 → 0", fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09", [{ from: "2026-08-25", to: "2026-10-03" }]), 0);
  eq("★ 負のコントロール: 他の月の休止 (10 月) は 9 月の日数を変えない", fukuyoguRentalDaysInMonth("2026-04-01", null, "2026-09", [{ from: "2026-10-01", to: "2026-10-10" }]), 30);

  // 半月按分 (前半 1〜15日 / 後半 16日〜末日 に休止以外の貸与日があるか)
  //   提供票の休止のある実績行 279 行中 277 行で 日割区分 と一致 (lib/half-month-units.ts halfMonthFlags の注記)
  const units = (start: string | null, end: string | null, ym: string, ex: { from: string; to: string | null }[] = []) => {
    const f = halfMonthFlags(start, end, ym, ex);
    return halfMonthUnits(500, f.firstHalf, f.secondHalf);
  };
  eq("★ 月内の休止 (山口 裕) は満額のまま 500 (提供票 日割区分=全額)", units("2026-04-01", null, "2026-09", yamaguchi), 500);
  eq("★ 前半全部休止 (9/1〜9/15) で後半だけ → 半額 250", units("2026-04-01", null, "2026-09", [{ from: "2026-09-01", to: "2026-09-15" }]), 250);
  eq("★ 負のコントロール: 同じ台で休止を渡さなければ 満額 500", units("2026-04-01", null, "2026-09"), 500);
  eq("★ 後半全部休止 (9/16〜9/30) で前半だけ → 半額 250", units("2026-04-01", null, "2026-09", [{ from: "2026-09-16", to: "2026-09-30" }]), 250);
  eq("月をまたぐ休止 8/20〜9/20 → 9 月は後半だけ → 半額 250", units("2026-04-01", null, "2026-09", [{ from: "2026-08-20", to: "2026-09-20" }]), 250);
  eq("全月休止 → 0", units("2026-04-01", null, "2026-09", [{ from: "2026-09-01", to: "2026-09-30" }]), 0);
  eq("9/10 開始 + 9/10〜9/15 休止 → 後半だけ → 半額 250", units("2026-09-10", null, "2026-09", [{ from: "2026-09-10", to: "2026-09-15" }]), 250);
  // 小出 和子 2026-08: 印 8/1・8/19〜31 → 当方 満額 / ほのぼの 日割区分=半額 (休止のある 279 行中の例外 2 行の 1 つ。規則には入れない)
  eq("既知の例外 小出 和子 2026-08 (印 8/1・8/19〜31): 当方は満額 500 (ほのぼのは半額)", units("2026-04-01", null, "2026-08", [{ from: "2026-08-02", to: "2026-08-18" }]), 500);
  // 入院 (client_hospitalizations) は従来どおり半月の判定にだけ効く。退院日 null = 月末まで
  eq("入院 9/1〜9/15 → 後半だけ → 半額 250 (従来の BillingTab と同じ)",
    units("2026-04-01", null, "2026-09", hospitalizationRanges([{ admission_date: "2026-09-01", discharge_date: "2026-09-15" }])), 250);
  eq("入院 9/10〜(退院日なし) → 前半だけ → 半額 250",
    units("2026-04-01", null, "2026-09", hospitalizationRanges([{ admission_date: "2026-09-10", discharge_date: null }])), 250);
  eq("入院 9/1〜9/10 + 休止 9/11〜9/15 → 後半だけ → 半額 250",
    units("2026-04-01", null, "2026-09", [...hospitalizationRanges([{ admission_date: "2026-09-01", discharge_date: "2026-09-10" }]), { from: "2026-09-11", to: "2026-09-15" }]), 250);
  // 月途中の公費: 休止日は公費の判定でも貸与日に数えない (fukuyogu-amounts.ts kohiCoverageInMonth)
  const kc = (pauses: { from: string; to: string }[] | null) =>
    kohiCoverageInMonth([{ start: "2026-09-15", end: "2026-09-27" }], [{ unitPer: 500, count: 1, units: 500, rentalStart: "2026-04-01", rentalEnd: null, pauses }], "2026-09").covered;
  eq("★ 公費の期間 = 休止の期間 だけ → 公費がかからない (covered=false)", kc(yamaguchi), false);
  eq("★ 負のコントロール: 休止を渡さなければ covered=true", kc(null), true);
  const c1 = pickCertForMonth([
    { effective_date: "2025-09-01", certification_start_date: "2025-09-01", certification_end_date: "2026-08-31", care_level: "要介護1" },
    { effective_date: "2026-09-01", certification_start_date: "2026-09-01", certification_end_date: "2030-08-31", care_level: "要介護2" },
  ], "2026-09-01", "2026-09-30");
  eq("★ 当月有効の認定を選ぶ (更新後の 要介護2)", c1?.care_level, "要介護2");
  eq("★ 認定が無ければ clients の列",
    certFieldsForDensou({ care_level: "要支援1", certification_start_date: "2026-01-01", certification_end_date: null }, null).careLevel, "要支援1");

  // ★ 2026-11-09 (FY-C2) 被保番が一致する認定を優先 — 内海 淳 (122291 / 1000304436) の実データの形。
  //   旧被保番 H333010211 (生保単独の頃) の認定が当月に掛かったまま残り、正しい認定は effective_date が null
  const utsumi = [
    { id: "old-H", effective_date: "2024-05-01", insurer_number: "122291", insured_number: "H333010211", certification_start_date: "2024-05-01", certification_end_date: "2028-04-30", care_level: "要介護1" },
    { id: "right", effective_date: null, insurer_number: "122291", insured_number: "1000304436", certification_start_date: "2026-04-22", certification_end_date: "2026-10-31", care_level: "要介護1" },
    { id: "next", effective_date: "2026-11-01", insurer_number: "122291", insured_number: "1000304436", certification_start_date: "2026-11-01", certification_end_date: "2029-10-31", care_level: "要介護2" },
  ];
  eq("★ 被保番が一致する認定を優先 (内海 淳 → 2026-04-22〜10-31)",
    pickCertForMonth(utsumi, "2026-09-01", "2026-09-30", { insurerNumber: "122291", insuredNumber: "1000304436" })?.id, "right");
  eq("★ 負のコントロール: 番号を渡さないと 旧被保番の認定を選ぶ (直す前の挙動)",
    pickCertForMonth(utsumi, "2026-09-01", "2026-09-30")?.id, "old-H");
  eq("★ 番号は 全角・6 桁/8 桁 の違いを吸収 (００１２２２９１ / １０００３０４４３６)",
    pickCertForMonth(utsumi, "2026-09-01", "2026-09-30", { insurerNumber: "００１２２２９１", insuredNumber: "１０００３０４４３６" })?.id, "right");
  eq("★ 一致する認定が当月に無ければ 従来どおり当月に掛かる先頭",
    pickCertForMonth(utsumi, "2026-09-01", "2026-09-30", { insurerNumber: "122291", insuredNumber: "9999999999" })?.id, "old-H");
  eq("★ 保険者番号が違えば一致扱いにしない",
    pickCertForMonth(utsumi, "2026-09-01", "2026-09-30", { insurerNumber: "122192", insuredNumber: "1000304436" })?.id, "old-H");
  eq("★ 一致しても当月に掛からない認定は選ばない (11 月からの認定は 9 月に出ない)",
    pickCertForMonth(utsumi.slice(1), "2026-09-01", "2026-09-30", { insurerNumber: "122291", insuredNumber: "1000304436" })?.id, "right");
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

// ★ 2026-11-09 (FY-C2) 要介護度をコードにできない行は伝送から外す (保険者番号が無い行と同じ扱い)。
//   実例: 西野 規子(介) 1000062551 — 当月に有効な認定が無く 要介護度 0 の 7131 が出ていた (確実に返戻)
{
  const noLevel: FukuyoguSeikyuRow = { ...base, userName: "見本 要介護度なし", insuredNumber: "1000000003", careLevel: null };
  const r = buildFukuyoguDensou([base, noLevel, { ...noLevel, userName: "見本 非該当", insuredNumber: "1000000004", careLevel: "非該当" }],
    { officeNumber: "1270402124", year: 2026, month: 12 });
  const rc = r.content.split("\r\n").filter(Boolean).map(cols);
  eq("★ 要介護度なし・非該当 は 01 が出ない (残るのは 見本 太郎 だけ)",
    rc.filter((c) => (c[2] === "7131" || c[2] === "7132") && c[3] === "01").map((c) => c[7]), ["1000000001"]);
  eq("★ 7111 の件数・単位数にも入らない (1 件 / 1400)",
    (() => { const h = rc.find((c) => c[2] === "7111")!; return [h[8], h[9]]; })(), ["1", "1400"]);
  eq("★ 外したことを警告する (2 名)", r.warnings.filter((w) => w.includes("要介護度") && w.includes("除外")).length, 2);
  eq("★ 項15 が 0 の 01 は 1 行も無い", rc.filter((c) => c[3] === "01" && c[16] === "0").length, 0);
  const keep = buildFukuyoguDensou([base, { ...noLevel, careLevel: "要支援２" }], { officeNumber: "1270402124", year: 2026, month: 12 });
  eq("★ 負のコントロール: 全角 \"要支援２\" はコードにできる → 外さない (7131 1 + 7132 1)",
    keep.content.split("\r\n").filter(Boolean).map(cols).filter((c) => c[3] === "01").map((c) => c[2]), ["7131", "7132"]);
  eq("careLevelCodeForDensou: 要介護３→23 / 事業対象者→06 / null・非該当→\"\"",
    [careLevelCodeForDensou("要介護３"), careLevelCodeForDensou("事業対象者"), careLevelCodeForDensou(null), careLevelCodeForDensou("非該当")], ["23", "06", "", ""]);
}
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

console.log("\n══ ★ CM 指示単位数で頭打ち (2026-11-09・ほのぼの実伝送 KK261004 の 6 名と同じ値) ══");
{
  // [様式, 氏名, 給付率, 実績単位, CM 指示単位, 期待 保険請求, 期待 利用者負担] — 値は KK261004 の 01 項33-35 / 10 項9・10・14・16・17
  const CASES: [string, string, string, number, number, number, number][] = [
    ["7131", "正木 清", "90", 3010, 2048, 18432, 2048],
    ["7131", "髙畠 孝祐", "70", 3150, 1085, 7595, 3255],
    ["7131", "石原 照子", "90", 4630, 1221, 10989, 1221],
    ["7131", "露﨑 均", "90", 2290, 1598, 14382, 1598],
    ["7131", "中村 弘子", "90", 2250, 1757, 15813, 1757],
    ["7132", "石原 昌代", "90", 1970, 1858, 16722, 1858],
  ];
  const mkRow = (c: (typeof CASES)[number], i: number, amt: FukuyoguAmounts): FukuyoguSeikyuRow => ({
    ...base, userName: c[1], insuredNumber: `90000000${String(i).padStart(2, "0")}`, careLevel: c[0] === "7132" ? "要支援1" : "要介護3",
    details: [{ serviceCode: "171003", unitPer: c[3], count: 1, units: c[3], days: 30, taisCode: "00170-000892" }],
    copayRate: amt.copayRate, totalUnits: amt.billedUnits, limitTargetUnits: amt.actualUnits, planUnits: amt.planUnits,
    totalCost: amt.totalCost, insuranceAmount: amt.insuranceAmount, userAmount: amt.userAmount,
  });
  /** CM 指示を渡す (useCm) / 渡さない で組み、6 名の値がほのぼのと一致した数を返す */
  const run = (useCm: boolean) => {
    const amts = CASES.map((c) => computeFukuyoguAmounts({ benefitRateRaw: c[2], insuredNumber: "1", totalUnits: c[3], kohi: null, cmUnits: useCm ? c[4] : null }));
    const built = buildFukuyoguDensou(CASES.map((c, i) => mkRow(c, i, amts[i])), { officeNumber: "1272400050", year: 2026, month: 9 });
    const ls = built.content.split("\r\n").filter(Boolean).map(cols);
    let match = 0;
    const got: string[][] = [];
    CASES.forEach((c, i) => {
      const ins = `90000000${String(i).padStart(2, "0")}`;
      const h = ls.find((x) => x[2] === c[0] && x[3] === "01" && x[7] === ins)!;
      const t = ls.find((x) => x[2] === c[0] && x[3] === "10" && x[7] === ins)!;
      const ds = ls.filter((x) => x[2] === c[0] && x[3] === "02" && x[7] === ins);
      // 01: 33 単位 / 34 請求 / 35 本人  10: 9 計画 / 10 限度額管理対象 / 11 対象外 / 14 保険単位 / 16 請求 / 17 本人  02: 14 = 実績のまま
      const v = [h[34], h[35], h[36], t[10], t[11], t[12], t[15], t[17], t[18], ds.map((d) => d[15]).join("+")];
      const want = [String(c[4]), String(c[5]), String(c[6]), String(c[4]), String(c[3]), "0", String(c[4]), String(c[5]), String(c[6]), String(c[3])];
      got.push(v);
      if (JSON.stringify(v) === JSON.stringify(want)) match++;
    });
    const h7111 = ls.find((x) => x[2] === "7111" && x[5] === "1")!;
    return { match, got, amts, built, h7111 };
  };
  const on = run(true);
  CASES.forEach((c, i) => eq(`★ ${c[0]} ${c[1]} 01(33-35)/10(9,10,11,14,16,17)/02(14)`, on.got[i],
    [String(c[4]), String(c[5]), String(c[6]), String(c[4]), String(c[3]), "0", String(c[4]), String(c[5]), String(c[6]), String(c[3])]));
  eq("★ 7111 単位数 / 費用合計 / 保険請求 / 利用者負担 = 頭打ち後の合計",
    [on.h7111[9], on.h7111[10], on.h7111[11], on.h7111[13]],
    [String(CASES.reduce((a, c) => a + c[4], 0)), String(CASES.reduce((a, c) => a + c[4] * 10, 0)), String(CASES.reduce((a, c) => a + c[5], 0)), String(CASES.reduce((a, c) => a + c[6], 0))]);
  eq("★ 保険外 (全額自己負担) = 超過単位 × 10 円 (髙畠 2,065 単位 → 20,650 円)", [on.amts[1].overUnits, on.amts[1].outsideAmount, on.amts[1].capped], [2065, 20650, true]);
  eq("★ 警告「CM 指示単位数で頭打ち」が 6 名とも出る (金額計算 / 伝送)",
    [on.amts.filter((a) => a.warnings.some((w) => w.includes("CM 指示単位数で頭打ち"))).length, on.built.warnings.filter((w) => w.includes("CM 指示単位数で頭打ち")).length], [6, 6]);
  // 負のコントロール: 頭打ちを外すと 6 名とも ほのぼのと合わなくなる (= この節は頭打ちを本当に見ている)
  const off = run(false);
  eq("★ 負のコントロール: CM 指示を渡さないと 6 名とも不一致 / 警告も出ない", [off.match, off.built.warnings.filter((w) => w.includes("頭打ち")).length], [0, 0]);
  // 入力なし・実績以下・実績超え・0
  const a0 = computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1", totalUnits: 1400, kohi: null });
  eq("入力なし (cmUnits 省略) = 従来どおり (計画=実績=請求 1400 / 保険外 0)", [a0.planUnits, a0.actualUnits, a0.billedUnits, a0.outsideAmount, a0.insuranceAmount, a0.capped], [1400, 1400, 1400, 0, 12600, false]);
  const aOver = computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1", totalUnits: 1400, kohi: null, cmUnits: 2000 });
  eq("CM 指示が実績より多い = 実績で請求 (計画単位数だけ 2000)", [aOver.planUnits, aOver.billedUnits, aOver.overUnits, aOver.capped, aOver.warnings.length], [2000, 1400, 0, false, 0]);
  const aZero = computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1", totalUnits: 1400, kohi: null, cmUnits: 0 });
  eq("CM 指示 0 = 全額保険外 (保険 0 / 本人 0 / 保険外 14,000)", [aZero.billedUnits, aZero.insuranceAmount, aZero.userAmount, aZero.outsideAmount], [0, 0, 0, 14000]);
  const aKohi = computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1", totalUnits: 1400, kohi: { hobetsu: "12", futansha: "12123519", jukyusha: "0068742" }, cmUnits: 1000 });
  eq("生保併用 + 頭打ち: 公費は頭打ち後の本人分 (1,000) / 保険外 4,000", [aKohi.insuranceAmount, aKohi.kohiAmount, aKohi.userAmount, aKohi.outsideAmount], [9000, 1000, 0, 4000]);
  eq("入力値の読み (\"１,２００\"→1200 / 空・負・小数・文字 → 入力なし)",
    [normalizeCmUnits("１,２００"), normalizeCmUnits(""), normalizeCmUnits("-1"), normalizeCmUnits("1.5"), normalizeCmUnits("abc"), normalizeCmUnits(null), normalizeCmUnits(0)],
    [1200, null, null, null, null, null, 0]);
}

// ══ ★ 月途中の公費 (生保) の扱い none / daily / half (2026-11-09 user 要件) ══════════════
//   ⚠ 期待値は手計算 (ほのぼのの実伝送 KK261004 に月途中の公費の例は無い。IF 仕様と kaigo-app の式由来)。
//   2026-09 (30 日) / 給付率 90 / 用具 2 品目 (300 単位 × 1・101 単位 × 2 = 計 502 単位・費用 5,020・保険 4,518・本人 502)
//   101 は奇数で四捨五入の向きを見るため。
{
  console.log("\n══ ★ 月途中の公費 (生保) の扱い none / daily / half (手計算) ══");
  const YM = "2026-09";
  const KOHI = { hobetsu: "12", futansha: "12124517", jukyusha: "0024935" };
  const LINES = [
    { unitPer: 300, count: 1, units: 300, rentalStart: "2026-04-01", rentalEnd: null },
    { unitPer: 101, count: 2, units: 202, rentalStart: "2026-04-01", rentalEnd: null },
  ];
  const calc = (periods: { start: string | null; end: string | null }[] | undefined, mode: KohiMonthMode | null, extra: Partial<Parameters<typeof computeFukuyoguAmounts>[0]> = {}) =>
    computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1001328079", totalUnits: 502, kohi: { ...KOHI, periods, ...(extra.kohi ?? {}) }, month: YM, lines: LINES, kohiMode: mode, ...extra, ...(extra.kohi ? { kohi: { ...KOHI, periods, ...extra.kohi } } : {}) });
  const pieces = (a: FukuyoguAmounts) => (a.kohiPieces ?? []).map((ps) => ps.map((p) => `${p.days}/${p.units}`).join("+")).join(" | ");
  const sum = (a: FukuyoguAmounts) => [a.kohiPartial, a.kohiMode, a.kohiModeDefaulted, a.kohiUnits, a.kohiAmount, a.userAmount, a.insuranceAmount];

  // ── 開始 9/28 (飯村 昭 の実例と同じ形) ──
  const start28 = [{ start: "2026-09-28", end: "2026-09-30" }];
  const d0 = calc(start28, null);
  eq("開始9/28 未選択 = 既定 none (公費なし・本人 502・警告「未選択」)", [...sum(d0), d0.warnings.some((w) => w.includes("未選択"))], [true, KOHI_MONTH_MODE_DEFAULT, true, null, null, 502, 4518, true]);
  const dn = calc(start28, "none");
  eq("開始9/28 none = 公費なし (未選択の警告は出ない)", [...sum(dn), dn.warnings.some((w) => w.includes("未選択"))], [true, "none", false, null, null, 502, 4518, false]);
  const dd = calc(start28, "daily");
  // 300×3/30=30 / 101×3/30=10.1→10 ×2 = 50 単位 → 500 円 → 保険 450 → 公費 50 / 本人 5,020−4,518−50 = 452
  eq("開始9/28 daily = 公費対象 50 (30+10+10)・公費 50・本人 452", [...sum(dd), pieces(dd)], [true, "daily", false, 50, 50, 452, 4518, "3/30 | 3/10+3/10"]);
  const dh = calc(start28, "half");
  // 後半を公費: round(300/2)=150 / round(101/2)=51 ×2 = 252 → 2,520 円 → 保険 2,268 → 公費 252 / 本人 250。日数 = 16〜30 日 = 15
  eq("開始9/28 half = 後半を公費 252 (150+51+51)・公費 252・本人 250", [...sum(dh), pieces(dh)], [true, "half", false, 252, 252, 250, 4518, "15/150 | 15/51+15/51"]);

  // ── 終了 9/10 (生保が月の途中で終わる) ──
  const end10 = [{ start: "2026-08-01", end: "2026-09-10" }];
  const ed = calc(end10, "daily");
  // 300×10/30=100 / 101×10/30=33.67→34 ×2 = 168
  eq("終了9/10 daily = 公費対象 168 (100+34+34)・日数 10", [ed.kohiUnits, ed.kohiAmount, pieces(ed)], [168, 168, "10/100 | 10/34+10/34"]);
  const eh = calc(end10, "half");
  eq("終了9/10 half = 前半を公費 252・日数 15 (1〜15 日)", [eh.kohiUnits, pieces(eh)], [252, "15/150 | 15/51+15/51"]);

  // ── 境界: 1 日だけ / 15・16 日 ──
  const one = calc([{ start: "2026-09-30", end: "2026-09-30" }], "daily");
  eq("境界 1 日だけ (9/30) daily = 10+3+3 = 16・日数 1", [one.kohiUnits, pieces(one)], [16, "1/10 | 1/3+1/3"]);
  const oneH = calc([{ start: "2026-09-30", end: "2026-09-30" }], "half");
  eq("境界 1 日だけ (9/30) half = 後半 252 (CM の方針どおり半月)", [oneH.kohiUnits], [252]);
  const s16 = calc([{ start: "2026-09-16", end: null }], "daily");
  eq("境界 開始9/16 daily = 半分ちょうど 150+51+51 = 252・日数 15", [s16.kohiUnits, pieces(s16)], [252, "15/150 | 15/51+15/51"]);
  const s15 = calc([{ start: "2026-09-15", end: null }], "daily");
  eq("境界 開始9/15 daily = 160+54+54 = 268・日数 16", [s15.kohiUnits, pieces(s15)], [268, "16/160 | 16/54+16/54"]);
  const s15h = calc([{ start: "2026-09-15", end: null }], "half");
  eq("境界 開始9/15 half = 公費の日が多い後半 (15 対 1)・252・日数 15", [s15h.kohiUnits, pieces(s15h)], [252, "15/150 | 15/51+15/51"]);
  const e15h = calc([{ start: null, end: "2026-09-15" }], "half");
  const e16h = calc([{ start: null, end: "2026-09-16" }], "half");
  eq("境界 終了9/15・9/16 half = どちらも前半を公費 252・日数 15", [e15h.kohiUnits, pieces(e15h), e16h.kohiUnits, pieces(e16h)], [252, "15/150 | 15/51+15/51", 252, "15/150 | 15/51+15/51"]);

  // ── 公費が月の全期間 / 重ならない / 貸与が後半だけ ──
  const full = calc([{ start: "2026-09-01", end: "2026-09-30" }], "half");
  eq("全期間の公費 = 月途中ではない (扱いは無視・公費 502・pieces なし)", [full.kohiPartial, full.kohiMode, full.kohiUnits, full.kohiAmount, full.userAmount, full.kohiPieces], [false, null, 502, 502, 0, null]);
  const noOverlap = computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1", totalUnits: 300, kohi: { ...KOHI, periods: start28 }, month: YM,
    lines: [{ unitPer: 300, count: 1, units: 300, rentalStart: "2026-04-01", rentalEnd: "2026-09-10" }], kohiMode: "daily" });
  eq("公費の期間に貸与日が無い (9/10 撤去・9/28 生保) = 公費なし + 警告", [noOverlap.kohiAmount, noOverlap.userAmount, noOverlap.warnings.some((w) => w.includes("貸与日がありません"))], [null, 300, true]);
  const lateRent = (mode: KohiMonthMode) => computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1", totalUnits: 150, kohi: { ...KOHI, periods: [{ start: "2026-09-25", end: null }] }, month: YM,
    lines: [{ unitPer: 150, count: 1, units: 150, rentalStart: "2026-09-20", rentalEnd: null }], kohiMode: mode });
  // 貸与 9/20〜 (11 日・後半だけ = 半月按分済み 150)、生保 9/25〜 (6 日): daily = 150×6/11 = 81.8→82 / half = 公費の半月 (後半) に貸与が全部 → 150
  eq("貸与が後半だけ (9/20〜)・生保 9/25〜: daily 82・日数 6 / half 150 (全部)", [lateRent("daily").kohiUnits, pieces(lateRent("daily")), lateRent("half").kohiUnits], [82, "6/82", 150]);

  // ── 伝送: daily (開始9/28) の 02 項10・11・15 / 01 項35・39-41 / 10 項17-20 / 7111 公費分 ──
  const mkDetail = (a: FukuyoguAmounts | null) => [
    { serviceCode: "171001", unitPer: 300, count: 1, units: 300, days: 30, taisCode: "00066-000352", kohiPieces: a?.kohiPieces?.[0] },
    { serviceCode: "171007", unitPer: 101, count: 2, units: 202, days: 30, taisCode: "00254-000133", kohiPieces: a?.kohiPieces?.[1] },
  ];
  const mkKohiRow = (a: FukuyoguAmounts, withPieces = true): FukuyoguSeikyuRow => ({
    ...base, userName: "飯村 見本", insuredNumber: "1001328079", careLevel: "要介護2", details: mkDetail(withPieces ? a : null),
    copayRate: a.copayRate, totalUnits: a.billedUnits, totalCost: a.totalCost, insuranceAmount: a.insuranceAmount, userAmount: a.userAmount,
    kohiHobetsu: a.kohiHobetsu, kohiFutansha: a.kohiHobetsu ? KOHI.futansha : null, kohiJukyusha: a.kohiHobetsu ? KOHI.jukyusha : null,
    kohiAmount: a.kohiAmount, kohiUnits: a.kohiUnits, kohiTargetCost: a.kohiTargetCost, kohiHonninFutan: a.kohiHonninFutan,
  });
  const bd = buildFukuyoguDensou([mkKohiRow(dd)], { officeNumber: "1272400050", year: 2026, month: 9 });
  const bl = bd.content.split("\r\n").filter(Boolean).map(cols);
  const h01 = bl.find((x) => x[2] === "7131" && x[3] === "01")!;
  const t10 = bl.find((x) => x[2] === "7131" && x[3] === "10")!;
  const d02 = bl.filter((x) => x[2] === "7131" && x[3] === "02");
  const k7111 = bl.find((x) => x[2] === "7111" && x[5] === "2")!;
  eq("伝送 daily: 02 項10 日数 / 項11 公費日数 / 項14 / 項15 公費単位 (1 用具 1 行)", d02.map((d) => [d[11], d[12], d[15], d[16]].join("/")), ["30/3/300/30", "30/3/101/10", "30/3/101/10"]);
  eq("伝送 daily: 01 項33-35 / 39-41 = 502・4518・452 / 50・50・0", [h01[34], h01[35], h01[36], h01[40], h01[41], h01[42]], ["502", "4518", "452", "50", "50", "0"]);
  eq("伝送 daily: 10 項14・16・17 / 18-20 = 502・4518・452 / 50・50・0", [t10[15], t10[17], t10[18], t10[19], t10[20], t10[21]], ["502", "4518", "452", "50", "50", "0"]);
  eq("伝送 daily: 7111 公費分 件数・単位・費用・保険・公費・本人 = 1・50・500・0・50・0", [k7111[8], k7111[9], k7111[10], k7111[11], k7111[12], k7111[13]], ["1", "50", "500", "0", "50", "0"]);
  eq("伝送 daily: 突合の警告なし (Σ02 項15 = 01 項39)", bd.warnings.filter((w) => w.includes("公費対象")), []);
  const bn = buildFukuyoguDensou([mkKohiRow(d0)], { officeNumber: "1272400050", year: 2026, month: 9 });
  const bnl = bn.content.split("\r\n").filter(Boolean).map(cols);
  const n01 = bnl.find((x) => x[2] === "7131" && x[3] === "01")!;
  eq("伝送 none (未選択の既定): 公費欄なし (01 項7・30 空・39 0) / 7111 公費分なし", [n01[8], n01[31], n01[40], bnl.some((x) => x[2] === "7111" && x[5] === "2")], ["", "", "0", false]);
  // 負のコントロール (1): 明細に kohiPieces を付け忘れると 02 項15 が満額 (502) になり、突合の警告が鳴る
  const bneg = buildFukuyoguDensou([mkKohiRow(dd, false)], { officeNumber: "1272400050", year: 2026, month: 9 });
  eq("★ 負のコントロール: 明細の公費対象を付け忘れる → 警告「明細の公費対象単位数の合計 (502)」", bneg.warnings.some((w) => w.includes("明細の公費対象単位数の合計 (502)")), true);
  // 負のコントロール (2): 公費の期間を渡さないと月途中と判定されず 月全体を公費 (= 2026-11-09 以前の当方の挙動)
  const noPeriods = computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1", totalUnits: 502, kohi: KOHI, month: YM, lines: LINES, kohiMode: "daily" });
  eq("★ 負のコントロール: periods 無し → 月途中にならず公費 502 (旧挙動)", [noPeriods.kohiPartial, noPeriods.kohiUnits, noPeriods.kohiAmount], [false, 502, 502]);

  // ── 本人支払額 (中島 紀久子 KK261004 7132 と同じ値) ──
  console.log("\n══ ★ 生保の本人支払額 (ほのぼの KK261004 中島 紀久子 と同じ値) ══");
  const NAKA_LINES = [200, 100, 300, 300, 300].map((u) => ({ unitPer: u, count: 1, units: u, rentalStart: "2026-01-01", rentalEnd: null }));
  const naka = (selfPay: number | null) => computeFukuyoguAmounts({ benefitRateRaw: "90", insuredNumber: "1000063779", totalUnits: 1200,
    kohi: { hobetsu: "12", futansha: "12123519", jukyusha: "0197731", selfPay, periods: [{ start: "2026-09-01", end: "2026-09-30" }] }, month: YM, lines: NAKA_LINES });
  const nk = naka(1200);
  eq("本人支払額 1,200: 保険 10,800 / 公費 0 / 本人 1,200 (= 公費分本人負担)", [nk.insuranceAmount, nk.kohiAmount, nk.userAmount, nk.kohiHonninFutan, nk.kohiUnits], [10800, 0, 1200, 1200, 1200]);
  const mkNakaRow = (a: FukuyoguAmounts): FukuyoguSeikyuRow => ({
    ...base, userName: "中島 見本", insurerNumber: "122192", insuredNumber: "1000063779", careLevel: "要支援2", careOfficeNumber: "1202400014", carePlanKubun: "3",
    birthDate: "1942-02-15", gender: "女", certStart: "2023-06-01", certEnd: "2027-05-31",
    details: NAKA_LINES.map((l, i) => ({ serviceCode: i === 4 ? "171009" : "171007", unitPer: l.unitPer, count: 1, units: l.units, days: 30, taisCode: "x" })),
    copayRate: a.copayRate, totalUnits: a.billedUnits, totalCost: a.totalCost, insuranceAmount: a.insuranceAmount, userAmount: a.userAmount,
    kohiHobetsu: "12", kohiFutansha: "12123519", kohiJukyusha: "0197731", kohiAmount: a.kohiAmount, kohiUnits: a.kohiUnits, kohiTargetCost: a.kohiTargetCost, kohiHonninFutan: a.kohiHonninFutan,
  });
  // KK261004 の実レコード (01 項29-41 / 10 項14-20)
  //   01: …,90,100,,,1200,10800,0,0,0,0,1200,0,1200,…   10: …,1200,1000,10800,0,1200,0,1200,…
  const KK_01 = ["90", "100", "", "", "1200", "10800", "0", "0", "0", "0", "1200", "0", "1200"];
  const KK_10 = ["1200", "1000", "10800", "0", "1200", "0", "1200"];
  const nkB = (a: FukuyoguAmounts) => {
    const r = buildFukuyoguDensou([mkNakaRow(a)], { officeNumber: "1272400050", year: 2026, month: 9 });
    const ls = r.content.split("\r\n").filter(Boolean).map(cols);
    const h = ls.find((x) => x[2] === "7132" && x[3] === "01")!;
    const t = ls.find((x) => x[2] === "7132" && x[3] === "10")!;
    const k = ls.find((x) => x[2] === "7111" && x[5] === "2")!;
    const hk = ls.find((x) => x[2] === "7111" && x[5] === "1")!;
    return { h01: h.slice(30, 43), t10: t.slice(15, 22), k7111: [k[9], k[10], k[12], k[13]], hoken12: hk[13] };
  };
  const nb = nkB(nk);
  eq("★ 本人支払額: 7132-01 項29-41 = ほのぼの KK261004 と同じ", nb.h01, KK_01);
  eq("★ 本人支払額: 7132-10 項14-20 = ほのぼの KK261004 と同じ", nb.t10, KK_10);
  eq("本人支払額: 7111 公費分 単位・費用・公費・本人 = 1200・12000・0・0 / 保険分 利用者負担に 1,200 を含む", [...nb.k7111, nb.hoken12], ["1200", "12000", "0", "0", "1200"]);
  const nk500 = naka(500);
  eq("本人支払額 500 (< 本人分 1,200): 公費 700 / 本人 500 / 01 項35 0", [nk500.kohiAmount, nk500.userAmount, nk500.kohiHonninFutan, nkB(nk500).h01[6]], [700, 500, 500, "0"]);
  const nk9 = naka(5000);
  eq("本人支払額 5,000 (> 本人分): 本人は 1,200 で頭打ち・公費 0", [nk9.kohiAmount, nk9.userAmount, nk9.kohiHonninFutan], [0, 1200, 1200]);
  const ddSelf = calc(start28, "daily", { kohi: { ...KOHI, selfPay: 30 } });
  // daily 開始9/28: 公費対象の本人分 50 のうち 30 を本人 → 公費 20 / 本人 5,020−4,518−20 = 482 (01 項35 = 482−30 = 452)
  eq("月途中 daily + 本人支払額 30: 公費 20 / 本人 482 (うち公費分本人 30)", [ddSelf.kohiAmount, ddSelf.userAmount, ddSelf.kohiHonninFutan], [20, 482, 30]);
  const tandoku = computeFukuyoguAmounts({ benefitRateRaw: "0", insuredNumber: "H000000001", totalUnits: 1000, kohi: { ...KOHI, selfPay: 1500 } });
  eq("公費単独 (H) + 本人支払額 1,500: 保険 0 / 公費 8,500 / 本人 1,500", [tandoku.insuranceAmount, tandoku.kohiAmount, tandoku.userAmount, tandoku.kohiHonninFutan], [0, 8500, 1500, 1500]);
  eq("本人支払額の読み (\"１,２００円\"→1200 / 空・負・小数 → 0)", [normalizeSelfPay("１,２００円"), normalizeSelfPay(""), normalizeSelfPay(-5), normalizeSelfPay("1.5"), normalizeSelfPay(null)], [1200, 0, 0, 0, 0]);
  // 負のコントロール: 本人支払額を渡さないと ほのぼのと合わない (公費 1,200 / 項41 0 = 2026-11-09 以前の当方)
  const nk0 = naka(null);
  const nb0 = nkB(nk0);
  eq("★ 負のコントロール: 本人支払額なし → 01・10 とも KK261004 と不一致 (公費 1,200 / 項41 0)", [JSON.stringify(nb0.h01) === JSON.stringify(KK_01), JSON.stringify(nb0.t10) === JSON.stringify(KK_10), nk0.kohiAmount, nb0.h01[12]], [false, false, 1200, "0"]);
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
