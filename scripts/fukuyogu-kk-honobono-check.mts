/**
 * 福祉用具の伝送を ほのぼのの実伝送 (KK) と突合し、レコード種別ごとの一致数が基準値から下がっていないかを見る (★ READ ONLY)。
 *
 *   npm run check:kk-honobono                 # 突合して基準値と比べる (下がったら FAIL)
 *   npm run check:kk-honobono -- --update     # 基準値を今の一致数で書き直す (★ 下がった理由を確かめてから)
 *
 * 中身は scripts/fukuyogu-densou-honobono-diff.mts (本物の buildFukuyoguDensou + 請求画面と同じ組み立て) を --refresh で回し、
 * --out の JSON の stat (レコード種別 → [一致, ほのぼの件数]) を基準値と比べる。
 *   ・ほのぼの件数 (分母) が違う → 入力 (KK) が違う = FAIL (ファイルの取り違え)
 *   ・分母が同じで 一致が下がった → ★ 回帰 = FAIL
 *   ・一致が上がった → PASS (基準値を --update で上げるよう促す)
 * ⚠ DB は今の状態で組むので、データの是正・取込で一致数は動く。下がったら「何を変えたか」を先に確かめること
 *   (悪化したまま --update すると穴を焼き付ける)。
 * 対象: KK261004 (提供 2026-09)。月遅れ分 KK261001〜003 は範囲外 (diff script 冒頭の理由)。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "fukuyogu-kk-honobono-baseline.json");
const KK = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV");
const MONTH = "2026-09";
const UPDATE = process.argv.includes("--update");

if (!existsSync(KK)) {
  console.log(`KK が手元に無い (${KK}) — 測れていない (PASS ではない)`);
  process.exit(0);
}
const out = join(mkdtempSync(join(tmpdir(), "kk-check-")), "diff.json");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const r = spawnSync(process.execPath, [tsxCli, join(HERE, "fukuyogu-densou-honobono-diff.mts"),
  "--kk", KK, "--month", MONTH, "--refresh", "--out", out], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0 || !existsSync(out)) {
  console.error(r.stdout?.slice(-3000), r.stderr?.slice(-3000));
  console.error("✗ 突合 script が失敗した");
  process.exit(1);
}
const stat = (JSON.parse(readFileSync(out, "utf8")) as { stat: Record<string, [number, number]> }).stat;
// 負のコントロールが効いたかは diff script の出力で見る (検出できなければ 「NG」 と出る)
if (!/負のコントロール[\s\S]*OK \(検出できた\)/.test(r.stdout ?? "")) {
  console.error("✗ 突合 script の負のコントロールが OK にならなかった (検査が効いていない)");
  process.exit(1);
}
const rows = Object.entries(stat).map(([k, [m, n]]) => ({ k, m, n }));
for (const x of rows) console.log(`  ${x.k.padEnd(8)} 一致 ${String(x.m).padStart(5)} / ${String(x.n).padStart(5)}`);

if (UPDATE || !existsSync(BASELINE)) {
  writeFileSync(BASELINE, JSON.stringify({
    _readme: "check:kk-honobono の基準値。KK261004 (提供 2026-09) とのレコード種別ごとの [一致, ほのぼの件数]。"
      + " 2026-11-13 作成: 項21 開始年月日を貸与履歴から出した後・中島 紀久子の本人支払額を突合 script に渡した後の値。"
      + " 残りの差は 項22 中止年月日 (規則未特定)・提供票が請求後に変わった人・里 輝子の給付率・担当居宅 5 行 (是正 script 未実行) 等。"
      + " 一致が下がったら回帰。上がったら --update で焼き直す。",
    updatedAt: new Date().toISOString().slice(0, 10), stat,
  }, null, 2) + "\n");
  console.log(`基準値を書いた: ${BASELINE}`);
  process.exit(0);
}
const base = (JSON.parse(readFileSync(BASELINE, "utf8")) as { stat: Record<string, [number, number]> }).stat;
let fail = 0, up = 0;
for (const [k, [bm, bn]] of Object.entries(base)) {
  const cur = stat[k];
  if (!cur) { console.error(`✗ ${k}: 今回の結果に無い`); fail++; continue; }
  const [m, n] = cur;
  if (n !== bn) { console.error(`✗ ${k}: ほのぼの件数が違う (基準 ${bn} / 今回 ${n}) — KK の取り違え`); fail++; continue; }
  if (m < bm) { console.error(`✗ ${k}: 一致が下がった ${bm} → ${m} (★ 回帰。直前に変えたものを確かめる)`); fail++; }
  else if (m > bm) { console.log(`↑ ${k}: 一致が上がった ${bm} → ${m} (--update で基準値を上げる)`); up++; }
}
if (fail) { console.error(`\n✗ check:kk-honobono FAIL (${fail})`); process.exit(1); }
console.log(`\n✓ check:kk-honobono PASS${up ? ` (上がった ${up} 種別あり)` : ""}`);
