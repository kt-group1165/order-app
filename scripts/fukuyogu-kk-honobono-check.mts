/**
 * 福祉用具の伝送を ほのぼのの実出力と突合し、一致数が基準値から下がっていないかを見る (★ READ ONLY)。
 *
 *   npm run check:kk-honobono                 # 突合して基準値と比べる (下がったら FAIL)
 *   npm run check:kk-honobono -- --update     # 基準値を今の一致数で書き直す (★ 下がった理由を確かめてから)
 *
 * 中身は scripts/fukuyogu-densou-honobono-diff.mts (本物の buildFukuyoguDensou + 請求画面と同じ組み立て) を回し、
 * --out の JSON の stat (種別 → [一致, ほのぼの件数]) を 対象ごとの基準値と比べる。
 *   ・ほのぼの件数 (分母) が違う → 入力が違う = FAIL (ファイルの取り違え)
 *   ・分母が同じで 一致が下がった → ★ 回帰 = FAIL
 *   ・一致が上がった → PASS (基準値を --update で上げるよう促す)
 * ⚠ DB は今の状態で組むので、データの是正・取込で一致数は動く。下がったら「何を変えたか」を先に確かめること
 *   (悪化したまま --update すると穴を焼き付ける)。
 *
 * 対象 (TARGETS):
 *   2026-09-KK  … KK261004 (提供 2026-09 の実伝送)。01/02/10/7111 + 金額明細
 *   2026-10-KDS … 明細書明細付 KDS0031 処理R8-10 (10 月の KK はほのぼので未確定のためのつなぎ)。01/02 + 金額明細
 *                 ★ 10 月の KK が届いたら KK 版に差し替える (KDS に無い 10 集計・7111 も測れるようになる)
 *   金額明細 = 利用者ごとに 給付率・保険単位/請求/負担・公費1 単位/請求/本人負担 + 明細 (コード,TAIS,日数,単位) が全部一致した数
 * 全件読みは 1 本目 (--refresh) だけ。2 本目は その控えを --db-base で使い回す (月で絞る 2 表だけ読み直す)。
 * 月遅れ分 (KK261001〜003 / KDS の提供月以外の行) は範囲外 (diff script 冒頭の理由)。
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "fukuyogu-kk-honobono-baseline.json");
const DENSOU_OF = (area: string) => join(HERE, "../../kaigo-app/伝送データ", area, "福祉用具");
// ★ 2026-11-13: 事業所ごとに期待値 (ほのぼのの実出力) を持てる形にした。請求の事業所番号は 実際に貸した事業所 (居宅の給付管理票 KY で確認)
//   なので、誉田・高品・花見川・茂原 の KK / KDS0031 が届いたら その事業所の行を足す (置き場 伝送データ/<拠点>/福祉用具/<YYYYMM>/ほのぼのから/)。
//   ケアサポの基準値のキー ("2026-09-KK" 等) は 引数化の前と同じ。ほかの事業所は "<拠点>:<キー>"。
//   その事業所の貸与が order-app に入っていない間は 一致が低いので、足すのは 取込のあと。
const TARGETS_BY_AREA: Record<string, { key: string; month: string; flag: "--kk" | "--kds"; file: string }[]> = {
  ケアサポ: [
    { key: "2026-09-KK", month: "2026-09", flag: "--kk", file: join(DENSOU_OF("ケアサポ"), "202609/ほのぼのから/KK261004.CSV") },
    { key: "2026-10-KDS", month: "2026-10", flag: "--kds", file: join(DENSOU_OF("ケアサポ"), "202610/ほのぼのから/KDS0031_明細書明細付_処理R8-10.CSV") },
  ],
  誉田: [], // 例 { key: "誉田:2026-10-KDS", month: "2026-10", flag: "--kds", file: join(DENSOU_OF("誉田"), "202610/ほのぼのから/KDS0031_….CSV") }
  高品: [],
  花見川: [],
  茂原: [],
};
// --area <拠点> で 1 事業所だけ回せる (既定 = 全事業所の行)
const AREA_ARG = (() => { const i = process.argv.indexOf("--area"); return i >= 0 ? process.argv[i + 1] : null; })();
const TARGETS = Object.entries(TARGETS_BY_AREA)
  .filter(([area]) => !AREA_ARG || area === AREA_ARG)
  .flatMap(([area, ts]) => ts.map((t) => ({ ...t, area })));
const UPDATE = process.argv.includes("--update");

type Stat = Record<string, [number, number]>;
const dir = mkdtempSync(join(tmpdir(), "kk-check-"));
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const results: Record<string, Stat> = {};
let baseCache: string | null = null; // 1 本目の DB 控え (同じ事業所の 2 本目で使い回す)
let baseArea: string | null = null;
for (const t of TARGETS) {
  if (!existsSync(t.file)) {
    console.log(`${t.key}: 入力が手元に無い (${t.file}) — 測れていない (PASS ではない)`);
    continue;
  }
  const out = join(dir, `${t.key.replace(/[:\/]/g, "_")}.json`); // キーの「:」は Windows のファイル名に使えない
  const cache = join(dir, `db-${t.area}-${t.month}.json`);
  // 事業所ごとに 突合 script を その事業所で回す (ケアサポは引数なし = 引数化の前と同じ呼び方)。DB の控えは事業所ごとに別
  const areaArgs = t.area === "ケアサポ" ? [] : ["--area", t.area];
  const baseOk = baseCache && baseArea === t.area;
  const args = [tsxCli, join(HERE, "fukuyogu-densou-honobono-diff.mts"), t.flag, t.file, "--month", t.month, "--db-cache", cache, "--out", out, ...areaArgs,
    ...(baseOk ? ["--db-base", baseCache!] : ["--refresh"])];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !existsSync(out)) {
    console.error(r.stdout?.slice(-3000), r.stderr?.slice(-3000));
    console.error(`✗ ${t.key}: 突合 script が失敗した`);
    process.exit(1);
  }
  // 負のコントロールが効いたかは diff script の出力で見る (検出できなければ 「NG」 と出る)
  if (!/負のコントロール[\s\S]*OK \(検出できた\)/.test(r.stdout ?? "")) {
    console.error(`✗ ${t.key}: 突合 script の負のコントロールが OK にならなかった (検査が効いていない)`);
    process.exit(1);
  }
  if (!baseCache || baseArea !== t.area) { baseCache = cache; baseArea = t.area; }
  results[t.key] = (JSON.parse(readFileSync(out, "utf8")) as { stat: Stat }).stat;
  console.log(`── ${t.key}`);
  for (const [k, [m, n]] of Object.entries(results[t.key])) console.log(`  ${k.padEnd(8)} 一致 ${String(m).padStart(5)} / ${String(n).padStart(5)}`);
}

const README = "check:kk-honobono の基準値。対象ごと (提供月-入力) に 種別 → [一致, ほのぼの件数]。金額明細 = 利用者ごとに金額 (給付率・保険/公費の単位・請求・負担) と明細 (コード,TAIS,日数,単位) が全部一致した数 (分母 = ほのぼののレセプト数)。"
  + " 一致が下がったら回帰。上がったら --update で焼き直す。"
  + " [2026-09-KK] KK261004。残りの差は 項22 中止年月日 (規則未特定)・提供票が請求後に変わった人・里 輝子の給付率 等。担当居宅の是正 (batch f6769da4・5 行) 後の値。"
  + " [2026-10-KDS] 明細書明細付 処理R8-10 (10 月の KK が届いたら KK 版に差し替える)。2026-11-13 時点の残りの差:"
  + " 中止年月日 28 (請求画面は渡していない・中止理由が決まらないので保留) / 開始年月日 9 (貸与日付のデータ差) /"
  + " 居宅事業所 8・計画作成区分 5 (7132 の包括・自己作成の扱いと担当居宅。データ差) / 生年月日 2 (瀬尾 安信・村上 義雄。ほのぼの側で確認待ち) /"
  + " 明細 8 名 (金額は一致。日数は貸与日付・休止の入力差。青柳 操子は ほのぼのが手で半額を選んだ既知の例外 = lib/half-month-units.ts の注記) /"
  + " 新のみ 3 (野口 英雄・鳥飼 恒博・濱口 亮。9 月まで毎月請求・10 月だけほのぼのに無い。ほのぼの側で確認待ち)。";

const prev = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")) as { targets?: Record<string, Stat> }) : {};
if (UPDATE || !prev.targets) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: README, updatedAt: new Date().toISOString().slice(0, 10), targets: { ...(prev.targets ?? {}), ...results } }, null, 2) + "\n");
  console.log(`基準値を書いた: ${BASELINE}`);
  process.exit(0);
}
let fail = 0, up = 0;
for (const [tk, base] of Object.entries(prev.targets)) {
  const stat = results[tk];
  if (!stat) {
    const tkArea = tk.includes(":") ? tk.slice(0, tk.indexOf(":")) : "ケアサポ";
    if (AREA_ARG && tkArea !== AREA_ARG) continue; // --area で回していない事業所
    console.log(`${tk}: 今回は測れていない (入力が無い) — PASS ではない`); continue;
  }
  for (const [k, [bm, bn]] of Object.entries(base)) {
    const cur = stat[k];
    if (!cur) { console.error(`✗ ${tk} ${k}: 今回の結果に無い`); fail++; continue; }
    const [m, n] = cur;
    if (n !== bn) { console.error(`✗ ${tk} ${k}: ほのぼの件数が違う (基準 ${bn} / 今回 ${n}) — 入力ファイルの取り違え`); fail++; continue; }
    if (m < bm) { console.error(`✗ ${tk} ${k}: 一致が下がった ${bm} → ${m} (★ 回帰。直前に変えたものを確かめる)`); fail++; }
    else if (m > bm) { console.log(`↑ ${tk} ${k}: 一致が上がった ${bm} → ${m} (--update で基準値を上げる)`); up++; }
  }
}
for (const tk of Object.keys(results)) if (!prev.targets[tk]) console.log(`${tk}: 基準値が無い (--update で足す)`);
if (fail) { console.error(`\n✗ check:kk-honobono FAIL (${fail})`); process.exit(1); }
console.log(`\n✓ check:kk-honobono PASS${up ? ` (上がった ${up} 種別あり)` : ""}`);
