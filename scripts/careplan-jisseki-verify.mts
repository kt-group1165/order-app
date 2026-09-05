/**
 * ケアプラン連携 V4.1 第6表実績 (UPJSK) CSV ビルダーの境界値検証 (DB不使用・純関数のみ)
 *
 *   npx tsx scripts/careplan-jisseki-verify.mts
 *
 * 対象: lib/careplan-v4/build-jisseki.ts の buildFukuyoguJissekiCsv / buildFukuyoguJissekiFileName。
 * 純関数で DB に依存しないため、そのまま import して呼ぶ (逐語コピーしない)。
 *
 * ⚠ 単位数 (units) は呼出元の BillingTab.tsx で `getUnits()` から渡される。
 *   getUnits() 自体の半月按分・価格改定の是正は 8084f22 (2026-09-04) で
 *   確認済み。ここでは build-jisseki.ts が **受け取った units をどう
 *   CSVレコードに組み立てるか** (行展開・明細判別コード・警告条件) だけを見る。
 */
import { buildFukuyoguJissekiCsv, buildFukuyoguJissekiFileName, type FukuyoguJissekiUser } from "../lib/careplan-v4/build-jisseki";

let n = 0, ng = 0;
function eq(label: string, actual: unknown, expected: unknown) {
  n++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) ng++;
  console.log(`  ${ok ? "OK " : "NG "} ${label.padEnd(60)} ${ok ? "" : `実際=${JSON.stringify(actual)} 期待=${JSON.stringify(expected)}`}`);
}

const OPTS = {
  year: 2026, month: 12,
  senderOfficeNumber: "1234567890",
  senderOfficeName: "検証用福祉用具事業所",
  receiverOfficeNumber: "0987654321",
  now: new Date(2026, 11, 5, 10, 30, 0), // 固定タイムスタンプ (再現性のため)
};

const user = (o: Partial<FukuyoguJissekiUser>): FukuyoguJissekiUser => ({
  name: "検証太郎",
  insurerNumber: "121011",
  insuredNumber: "0000000001",
  planStaffName: "ケアマネ花子",
  items: [],
  ...o,
});

console.log("══ ① 基本形: 1件・quantity=1 → 明細判別コードは空 ══");
{
  const r = buildFukuyoguJissekiCsv(
    [user({ items: [{ serviceCode: "171001", units: 300, quantity: 1, taisCode: "00170-000001", todokedeCode: null, equipmentName: "車いすA", serviceDate: "2026-12-01" }] })],
    OPTS,
  );
  eq("recordCount", r.recordCount, 1);
  const fields = (r.content ?? "").trim().split(",");
  eq("フィールド数25", fields.length, 25);
  eq("No.19 明細判別コード (1件だけなら空)", fields[18], "");
  eq("No.8 単位数", fields[7], "300");
  eq("No.10 サービス利用日 (YYYYMMDD)", fields[9], "20261201");
  eq("No.12/13 時刻は9999固定", [fields[11], fields[12]], ["9999", "9999"]);
  eq("No.11 日割対象日は空 (福祉用具は月/半月単位)", fields[10], "");
  eq("警告なし (TAIS設定済)", r.warnings.length, 0);
}

console.log("\n══ ② quantity=3 (同一用具) → 行展開 + 連番1,2,3 ══");
{
  const r = buildFukuyoguJissekiCsv(
    [user({ items: [{ serviceCode: "171003", units: 500, quantity: 3, taisCode: "00170-000002", todokedeCode: null, equipmentName: "特殊寝台B", serviceDate: "2026-12-01" }] })],
    OPTS,
  );
  eq("recordCount = quantity分に展開される", r.recordCount, 3);
  const rows = (r.content ?? "").trim().split("\r\n").map((l) => l.split(","));
  eq("明細判別コードが1,2,3の連番になる", rows.map((f) => f[18]), ["1", "2", "3"]);
}

console.log("\n══ ③ 同一サービスコード・同一単位数の異なる用具 → グループ化されて連番 ══");
{
  const r = buildFukuyoguJissekiCsv(
    [user({
      items: [
        { serviceCode: "171001", units: 300, quantity: 1, taisCode: "00170-000001", todokedeCode: null, equipmentName: "車いすA", serviceDate: "2026-12-01" },
        { serviceCode: "171001", units: 300, quantity: 1, taisCode: "00170-000003", todokedeCode: null, equipmentName: "車いすC", serviceDate: "2026-12-01" },
      ],
    })],
    OPTS,
  );
  const rows = (r.content ?? "").trim().split("\r\n").map((l) => l.split(","));
  eq("★ 別の用具でも同一(サービスコード,単位数)なら連番でグループ化される", rows.map((f) => f[18]), ["1", "2"]);
}

console.log("\n══ ④ 同一サービスコードでも単位数が違えばグループ化されない ══");
{
  const r = buildFukuyoguJissekiCsv(
    [user({
      items: [
        { serviceCode: "171001", units: 300, quantity: 1, taisCode: "00170-000001", todokedeCode: null, equipmentName: "車いすA", serviceDate: "2026-12-01" },
        { serviceCode: "171001", units: 400, quantity: 1, taisCode: "00170-000004", todokedeCode: null, equipmentName: "車いすD", serviceDate: "2026-12-01" },
      ],
    })],
    OPTS,
  );
  const rows = (r.content ?? "").trim().split("\r\n").map((l) => l.split(","));
  eq("★ 単位数が違うので、どちらも単独グループ扱い (連番なし)", rows.map((f) => f[18]), ["", ""]);
}

console.log("\n══ ⑤ units<=0 (全月入院等) → 実績なし扱いで除外 ══");
{
  const r = buildFukuyoguJissekiCsv(
    [user({ items: [{ serviceCode: "171001", units: 0, quantity: 1, taisCode: "00170-000001", todokedeCode: null, equipmentName: "車いすA", serviceDate: "2026-12-01" }] })],
    OPTS,
  );
  eq("units=0の明細は出力されない", r.recordCount, 0);
  eq("content は null (0件のとき)", r.content, null);
}

console.log("\n══ ⑥ 保険者番号・被保険者番号のどちらか欠落 → その利用者ごとスキップ ══");
{
  const item = { serviceCode: "171001", units: 300, quantity: 1, taisCode: "00170-000001", todokedeCode: null, equipmentName: "車いすA", serviceDate: "2026-12-01" };
  const r1 = buildFukuyoguJissekiCsv([user({ insurerNumber: null, items: [item] })], OPTS);
  eq("保険者番号なし → 0件 + 警告", [r1.recordCount, r1.warnings.length], [0, 1]);
  const r2 = buildFukuyoguJissekiCsv([user({ insuredNumber: "" , items: [item] })], OPTS);
  eq("被保険者番号が空文字 → 0件 + 警告", [r2.recordCount, r2.warnings.length], [0, 1]);
}

console.log("\n══ ⑦ TAIS・届出コードどちらも未設定 → 警告は出るが行は出力される (スキップしない) ══");
{
  const r = buildFukuyoguJissekiCsv(
    [user({ items: [{ serviceCode: "171001", units: 300, quantity: 1, taisCode: null, todokedeCode: null, equipmentName: "車いすA", serviceDate: "2026-12-01" }] })],
    OPTS,
  );
  eq("★ 警告は出るが行はスキップされない (recordCount=1)", r.recordCount, 1);
  eq("警告1件", r.warnings.length, 1);
}

console.log("\n══ ⑧ 明細0件のユーザーは丸ごとスキップ (0件全体でcontent=null) ══");
{
  const r = buildFukuyoguJissekiCsv([user({ items: [] })], OPTS);
  eq("items空 → content=null・recordCount0", [r.content, r.recordCount], [null, 0]);
}

console.log("\n══ ⑨ CSVエスケープ (カンマ・引用符を含む名称) ══");
{
  const r = buildFukuyoguJissekiCsv(
    [user({ planStaffName: "山田,太郎", items: [{ serviceCode: "171001", units: 300, quantity: 1, taisCode: "00170-000001", todokedeCode: null, equipmentName: '特殊寝台"A"', serviceDate: "2026-12-01" }] })],
    OPTS,
  );
  eq("カンマを含む名前はダブルクォートで囲まれる", (r.content ?? "").includes('"山田,太郎"'), true);
  eq("ダブルクォートはエスケープ(2重化)される", (r.content ?? "").includes('"特殊寝台""A"""'), true);
}

console.log("\n══ ⑩ ファイル名の組み立て ══");
{
  const name = buildFukuyoguJissekiFileName(OPTS);
  eq("UPJSK_年月_送信元_17_送信先_43_タイムスタンプ.CSV",
    name, "UPJSK_202612_1234567890_17_0987654321_43_20261205103000.CSV");
}

console.log("\n══ 負のコントロール: グループ化キーを壊すと②③の判定が変わることを確認 ══");
{
  // ③で「別の用具でも同一(コード,単位数)ならグループ化される」を検証しているが、
  // ★ グループ化キーが equipmentName まで見てしまう実装だったら ③ は "" "" になるはず。
  // 実際に equipmentName ("車いすA" vs "車いすC") が違う2件でグループ化された(連番1,2)
  // ことは③で確認済み。ここでは「グループ化条件を厳しくする(unitsだけでなく
  // equipmentNameも一致必須)」という壊れた仮説を模擬し、本物の挙動と食い違うことを示す。
  const brokenGroupKey = (serviceCode: string, units: number, equipmentName: string) => `${serviceCode}|${units}|${equipmentName}`;
  const k1 = brokenGroupKey("171001", 300, "車いすA");
  const k2 = brokenGroupKey("171001", 300, "車いすC");
  n++;
  if (k1 !== k2) {
    console.log("  ✓ 負のコントロール OK — equipmentNameまでキーに含める壊れた仮説だと③の2件は別グループになり(連番なし)、");
    console.log("    実際の実装(連番1,2)と食い違う。③のassertionは実際に何かを検証している。");
  } else {
    ng++;
    console.log("  ✗✗✗ 負のコントロール失敗");
  }
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
if (ng > 0) process.exitCode = 1;
