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

/**
 * kind
 *   "strict"   ★ 0 を目指す。壊れたら (=差が出たら) 落ちる
 *   "baseline" ★ 既知の差を基準値として許容したうえでの PASS。0件PASSではない
 * knownDiff — baseline のとき、現在許容している既知差の件数 (2026-09-05 時点)。
 *   ★ 数える単位がscriptごとに違う (件数/バイト差など) ものは undefined にして
 *   「baseline だが合計には含めない」ことを明示する (異なる単位を混ぜて合算しない)。
 */
type Check = { name: string; script: string; why: string; slow?: boolean; kind?: "strict" | "baseline"; knownDiff?: number };

/** ★ 落ちたら金額か返戻に効くものだけ */
const CHECKS: Check[] = [
  { name: "ceiling-boundary", script: "check:ceiling-boundary", why: "上限価格判定 (純関数・境界値)" },
  { name: "fukuyogu-amounts", script: "check:fukuyogu-amounts", why: "★ 保険請求額・本人負担・公費 (公費単独 H は保険0・公費10割)" },
  { name: "fukuyogu-units", script: "check:fukuyogu-units", why: "福祉用具貸与の半月按分ルール" },
  // ★ 2026-11-12 新設。DB は読まない (提供票 CSV のみ)。提供票が無い環境では「測れていない」で exit 0 (合格ではない)
  { name: "proration", script: "check:proration", why: "★ 月の算定 (半月按分の自動 / 日割り) を ほのぼのの提供票 (実績行) と突合。日割は全一致・全額/半額は既知の食い違い89行が基準値 (負のコントロール付き)",
    kind: "baseline" },
  { name: "fukuyogu-rounding", script: "check:fukuyogu-rounding", why: "福祉用具の価格丸め (過去月に現在価格を使わないか)" },
  { name: "fukuyogu-densou", script: "check:fukuyogu-densou", why: "福祉用具伝送の仕様書突合 (ほのぼの実出力は未入手)",
    kind: "baseline", knownDiff: 1 }, // formatRecordLikeHonobono 未使用 (既知・B-2t/B-2x)
  { name: "densou-builder-diff", script: "check:densou-builder-diff", why: "★ 福祉用具⇔訪問介護の伝送ビルダー クロス突合 (kaigo-app側の実体を呼ぶ)",
    kind: "baseline", knownDiff: 3 }, // 公費0円行/番号欠損行の除外差/NFKC (既知・B-2t)
  { name: "invoice-number", script: "check:invoice-number", why: "利用者請求書の保存・採番 (列の突合まで。--executeはしない)" },
  // ★ 2026-09-05 新設 (B-6d)。★ テーブル未適用の間は 基準値比較をスキップして exit 0 になる。
  //   ★ 「合格」ではなく「まだ測れていない」なので 出力本文を読むこと。
  { name: "keido-exception", script: "check:keido-exception", why: "★ 軽度者(要支援1・2/要介護1)への原則対象外品目 — 例外給付の記録なし件数 (基準値125件・MONTH=2026-06・要介護度は当月の認定で判定)" },
  // ★ 2026-11-09 新設。例外給付の期限 (30日前=橙/切れ=赤)・市町村ルール (期間要なのに終了日空)・終了日の提案。
  //   純関数 + 負のコントロール。期限切れの見逃しは返戻に効くので入れる。
  { name: "exception-rules", script: "check:exception-rules", why: "★ 軽度者 例外給付の期限・市町村ルール判定 (純関数・境界値・負のコントロール付き)" },
  // ★ 2026-09-05 新設 (B-6g)。★ 貸与期間が壊れていると 国保連 0 円 / 利用者請求書 満額 に割れる。
  //   ★ 実データは 0 件だが ★ 壊れたデータは 増えてはいけないので ★ 0 を維持する検査。
  { name: "order-items-integrity", script: "check:order-items-integrity", why: "★ order_items の壊れたデータ 5 種 (期間の逆転・開始日null・未来すぎ・価格0・数量0)" },
  // ★ 2026-11-09 新設 (FY-H)。負担割合を月ごとに解決する純関数 (order/kaigo の 2 ファイル同一・固定データ・負のコントロール)。
  { name: "insurance-office", script: "check:insurance-office", why: "★ 事業所別保険: per_office は自事業所の認定・公費だけ / shared は per_office の行を外す (純関数・負のコントロール付き。実データの「自事業所の行なし」は一覧のみ)" },
  // ★ 2026-11-13 新設。DB を読まない純関数 + migrations の逐語コピー検知。破ると 当方だけ月遅れにして請求を止める
  { name: "cert-status", script: "check:cert-status", why: "★ 認定状況の規則 (申請中+要介護度→認定済み / 認定済みを申請中に下げない。境界値・負のコントロール・migrations の逐語コピー検知)" },
  { name: "cert-month-parity", script: "check:cert-month-parity", why: "★ 負担割合の月ごとの解決 (負担割合証の期間・認定行への fallback・kaigo の copay 置き換え。純関数・DB なし)" },
  // ★ 2026-11-09 新設 (FY-H)。表が未作成の間は ほのぼの CSV をメモリ上で見込みとして数える (出どころ=csv)。
  { name: "futan-period", script: "check:futan-period", why: "★ 負担割合証の期間と月ごとの給付率 (食い違い・証なしで請求。基準値方式)", slow: true,
    kind: "baseline" }, // 2026-09: 証なし 426 名 / 食い違い 8 名 (区分ごとなので合計に含めない)
  { name: "benefit-rate", script: "check:benefit-rate", why: "★ 給付率/負担割合の食い違い・認定なし請求 (基準値方式。B-2w=user判断待ちのまま増減だけ見る)", slow: true,
    kind: "baseline" }, // 件数は7区分に分かれるため合計には含めない (2026-11-09 基準値: certExpired 8名・他0)
  { name: "attendance-parity", script: "check:attendance-parity", why: "★ 出勤簿計算 (attendance-calc.ts) が kaigo/payroll/order の3app間で食い違わないか (実データ。期待値は常に差0)", slow: true },
  { name: "ceiling", script: "check:ceiling", why: "上限価格超過の回帰 (実データ + 基準値)", slow: true,
    kind: "baseline" }, // 基準値=現状の超過件数。0件を目指す検査ではない (改定のたび増える構造。B-2i)
  // ★ 2026-10-15 新設 (B-2i)。check:ceiling はマスタ全件 (269件の大半は請求に乗らない旧EQ-コード) を
  //   見るので、★ 実際に請求に乗る貸与 (前月・当月・未施行の上限世代) だけをここで見る。
  //   伝送・請求画面は上限を見ていないので、返戻になる明細はここでしか気づけない。
  { name: "ceiling-rental", script: "check:ceiling-rental", why: "★ 請求に乗る貸与の上限超過 (前月/当月/改定前の見込み。基準値=超過明細のid集合)", slow: true,
    kind: "baseline", knownDiff: 1 }, // KMD-R12 1口 (2026-07 施行の初公表上限 12,850 < 13,000。user判断待ち)
];

/** ★ この一覧が見ていないもの。緑でも安心しないための明示 */
const NOT_COVERED = [
  // 2026-11-12: 半月按分・日割りの単位は check:proration で ほのぼのの提供票 (入力側) と突合するようになった
  "福祉用具の伝送 (TAIS・項10 日数・公費按分) の実出力照合 — ほのぼの福祉用具伝送 KK は ケアサポ 2026-09 分のみ手作業で突合 (常設の検査は無い)",
  "日割り × 入院 / 日割り × 月途中の公費 — ほのぼのの実例が無い (伝送時に警告だけ出す)",
  "住宅改修 — 請求の実装が存在しない",
  "移動支援 (千葉市) — 伝送に乗らず市へExcel直接請求のため国保連系チェックの対象外",
  "kaigo-app / payroll-app の集計 — 別アプリ。各app側で回す",
];

const results: { name: string; ok: boolean; ms: number; skipped?: boolean; out?: string; kind: "strict" | "baseline"; knownDiff?: number }[] = [];
for (const c of CHECKS) {
  const kind = c.kind ?? "strict";
  if (FAST && c.slow) { results.push({ name: c.name, ok: true, ms: 0, skipped: true, kind, knownDiff: c.knownDiff }); continue; }
  process.stdout.write(`\n${"=".repeat(70)}\n▶ ${c.name}  — ${c.why}\n${"=".repeat(70)}\n`);
  const t = Date.now();
  // stdio:"inherit" だと tail 等に通したとき子の出力だけ落ちる (kaigo-app check-all.mts と同じ教訓)。
  const r = spawnSync("npm", ["run", c.script], { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(out);
  results.push({ name: c.name, ok: r.status === 0, ms: Date.now() - t, out, kind, knownDiff: c.knownDiff });
}

console.log(`\n${"=".repeat(70)}\n結果\n${"=".repeat(70)}`);
for (const r of results) {
  const mark = r.skipped ? "－ skip" : r.ok ? "  PASS" : "★ FAIL";
  const kindTag = r.kind === "baseline" ? " [基準値]" : "";
  console.log(`${mark}  ${r.name.padEnd(24)} ${r.skipped ? "" : `${(r.ms / 1000).toFixed(1)}s`}${kindTag}`);
}
const failed = results.filter((r) => !r.ok);
console.log("");
console.log("⚠ この一覧が ★ 見ていないもの:");
for (const n of NOT_COVERED) console.log(`   ${n}`);
console.log("");

// ★ [基準値] は「0件PASS」ではない。既知の差を許容している検査を一覧化する
// (2026-09-05 claude-06 指摘: PASSの中に2種類が混ざっていて出力から区別が付かなかった)。
const baselineChecks = results.filter((r) => r.kind === "baseline" && !r.skipped);
if (baselineChecks.length) {
  console.log("★ 基準値方式の検査 (既知の差を許容したうえでのPASS。0件PASSではない):");
  for (const r of baselineChecks) {
    console.log(`   ${r.name.padEnd(24)} ${r.knownDiff != null ? `既知 ${r.knownDiff} 件` : "(件数は出力本文を参照)"}`);
  }
  const summable = baselineChecks.filter((r) => r.knownDiff != null);
  const total = summable.reduce((s, r) => s + (r.knownDiff ?? 0), 0);
  console.log(`   → 合計 (同一単位=既知差件数で数えられるもののみ): ${total} 件 (${summable.map((r) => r.name).join(" + ")})`);
  console.log("");
}
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
