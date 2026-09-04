/**
 * ★ 金額に効く検査をまとめて回す (push 前のゲート)
 *
 *   npm run check:all              全部
 *   npm run check:all -- --fast    ★ 遅いもの (DB実データ突合) を飛ばす
 *
 * ── なぜ要るか ───────────────────────────────────────────────────────────
 *   kaigo-app の scripts/check-all.mts と同じ形。order-app 側にはまだ
 *   「何を回せばいいか」の入口が無かった。
 *
 * ⚠ ★ 「全部緑」は「正しい」ではありません。何を ★ 見ていないかは下の一覧に書きます。
 * ⚠ ここに無い check も価値はあります。★ 落ちても金額が動かないものは外しています。
 * ⚠ 4アプリを1コマンドで回す入口は作りません (ルート非git・アプリごとに別リポジトリ・
 *   別Vercelのため、アプリ単位で完結させるのが正しい形)。
 */
import { spawnSync } from "node:child_process";

const FAST = process.argv.includes("--fast");

type Check = { name: string; script: string; why: string; slow?: boolean };

/** ★ 落ちたら金額か返戻に効くものだけ */
const CHECKS: Check[] = [
  { name: "ceiling-boundary", script: "check:ceiling-boundary", why: "上限価格判定 (純関数・境界値)" },
  { name: "fukuyogu-units", script: "check:fukuyogu-units", why: "福祉用具貸与の半月按分ルール" },
  { name: "fukuyogu-rounding", script: "check:fukuyogu-rounding", why: "福祉用具の価格丸め (過去月に現在価格を使わないか)" },
  { name: "fukuyogu-densou", script: "check:fukuyogu-densou", why: "福祉用具伝送の仕様書突合 (ほのぼの実出力は未入手)" },
  { name: "densou-builder-diff", script: "check:densou-builder-diff", why: "★ 福祉用具⇔訪問介護の伝送ビルダー クロス突合 (kaigo-app側の実体を呼ぶ)" },
  { name: "invoice-number", script: "check:invoice-number", why: "利用者請求書の保存・採番 (列の突合まで。--executeはしない)" },
  { name: "ceiling", script: "check:ceiling", why: "上限価格超過の回帰 (実データ + 基準値)", slow: true },
];

/** ★ この一覧が見ていないもの。緑でも安心しないための明示 */
const NOT_COVERED = [
  "★ benefit-rate-check.mts — 現状 process.exit(0) 固定で常にPASS扱い (exit codeに反映されていない)。" +
    "2026-06実データで ¥10,133/月 (給付率と負担割合の食い違い) + ¥706,170/月 (認定の裏付け無し請求) を検出済み。" +
    "gateに入れる前に「どのbucketで落とすか」の設計判断が要るため今回は含めていない (user/リーダー判断待ち)",
  "★ attendance-calc-parity.mts — 3app(kaigo/payroll/order)横断の出勤簿計算突合。" +
    "現状レポート専用でPASS/FAIL閾値が無く exit codeが常に0。2026-06時点で実害は無いと報告済みだが、" +
    "同じ理由でgateには未編入",
  "福祉用具のTAISコード・貸与期間・半月按分そのものの実出力照合 — ほのぼの福祉用具伝送が未入手",
  "住宅改修 — 請求の実装が存在しない",
  "移動支援 (千葉市) — 伝送に乗らず市へExcel直接請求のため国保連系チェックの対象外",
  "kaigo-app / payroll-app の集計 — 別アプリ。各app側で回す",
];

const results: { name: string; ok: boolean; ms: number; skipped?: boolean; out?: string }[] = [];
for (const c of CHECKS) {
  if (FAST && c.slow) { results.push({ name: c.name, ok: true, ms: 0, skipped: true }); continue; }
  process.stdout.write(`\n${"=".repeat(70)}\n▶ ${c.name}  — ${c.why}\n${"=".repeat(70)}\n`);
  const t = Date.now();
  // stdio:"inherit" だと tail 等に通したとき子の出力だけ落ちる (kaigo-app check-all.mts と同じ教訓)。
  const r = spawnSync("npm", ["run", c.script], { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  results.push({ name: c.name, ok: r.status === 0, ms: Date.now() - t, out });
}

console.log(`\n${"=".repeat(70)}\n結果\n${"=".repeat(70)}`);
for (const r of results) {
  const mark = r.skipped ? "－ skip" : r.ok ? "  PASS" : "★ FAIL";
  console.log(`${mark}  ${r.name.padEnd(24)} ${r.skipped ? "" : `${(r.ms / 1000).toFixed(1)}s`}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("⚠ この一覧が ★ 見ていないもの:");
for (const n of NOT_COVERED) console.log(`   ${n}`);
console.log("");
if (failed.length) {
  const bar = "=".repeat(70);
  for (const f of failed) {
    console.log(`\n${bar}\n★ FAIL の再掲 — ${f.name}\n${bar}`);
    console.log((f.out ?? "").split("\n").slice(-40).join("\n"));
  }
  console.log(`\n★ FAIL ${failed.length} 件: ${failed.map((f) => f.name).join(" / ")}`);
  process.exit(1);
}
console.log(`PASS — ${results.filter((r) => !r.skipped).length} 本${FAST ? " (★ --fast: 実データ突合を飛ばしています)" : ""}`);
