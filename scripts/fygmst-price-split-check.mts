/**
 * ほのぼのの用具マスタ (FYGMST01) で 同じ TAIS の使用中の価格が 5 倍以上割れている品目を数える (★ DB を使わない・ファイルだけ)
 *
 *   npm run check:fygmst-split               基準値と比べる (増えたら FAIL)
 *   npm run check:fygmst-split -- --update   基準値を今の件数で書き直す (★ 増えた品目を読んでから)
 *   npm run check:fygmst-split -- --list     品目を全部出す
 *
 * 発端 (2026-11-14): 誉田の FYGMST01 に 楽起 縦型 (01339-000007) が 2,000・2,000・20,000 (記号なし) の 3 行あり、
 *   価格取込 (migrations/import_office_prices_from_fygmst.mjs) の「同じ記号なら ID 最大」で 打ち間違いの 20,000 を拾った (上限 2,330)。
 *   取込側は「上限の 2 倍以上の行は候補にしない」に直したが、上限マスタに無い TAIS には効かない。
 *   なので 価格の割れそのものを 事業所ごとに数えて、増えたら人に見せる (基準値方式。0 は目指さない — 別の型番を同じ TAIS で登録しているものもある)。
 * 数え方: 中止=0 の行で 単位数 > 0 のもの (0 円の付属品は外す)。自費のマスタは TAIS が無いので外す。
 * 負のコントロール: 毎回 1 行を 10 倍にした写しを作って数え、1 件増えることを確かめる (増えなければ検査が効いていない = FAIL)。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "fygmst-price-split-baseline.json");
const UPDATE = process.argv.includes("--update");
const LIST = process.argv.includes("--list");
const RATIO = 5;
const AREAS = ["ケアサポ", "誉田", "高品", "花見川", "茂原"];
const dirOf = (area: string) => join(HERE, "../../kaigo-app/伝送データ", area, "福祉用具", "マスタ");
const nf = (s: unknown) => String(s ?? "").normalize("NFKC").trim();

function parseCsvLine(line: string) {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
type Row = { id: number; name: string; tais: string; units: number };
function readArea(area: string): { files: string[]; rows: Row[] } | null {
  const d = dirOf(area);
  if (!existsSync(d)) return null;
  const files = readdirSync(d).filter((f) => /^FYGMST.*\.csv$/i.test(f) && !/自費/.test(f));
  const rows: Row[] = [];
  for (const f of files) {
    const lines = new TextDecoder("shift-jis").decode(readFileSync(join(d, f))).split(/\r\n|\n/).filter((l) => l.length > 0);
    const head = parseCsvLine(lines[0]);
    const ix = (k: string) => { const i = head.indexOf(k); if (i < 0) throw new Error(`★ ${area}/${f} に列「${k}」が無い`); return i; };
    const [cId, cStop, cName, cAbbr, cModel, cTais, cUnits] = ["ID", "中止", "商品名称", "略称", "型番", "TAISコード等", "単位数"].map(ix);
    for (let r of lines.slice(1).map(parseCsvLine)) {
      if (r.length === head.length + 1) r = [...r.slice(0, cModel), `${r[cModel]},${r[cModel + 1]}`, ...r.slice(cModel + 2)];
      if (r.length !== head.length) throw new Error(`★ ${area}/${f}: 列数 ${r.length} ≠ ${head.length}`);
      const tais = nf(r[cTais]).toUpperCase().replace(/[‐－―ー–?]/g, "-");
      const units = Number(r[cUnits] || 0);
      if (!/^\d{5}-[0-9A-Z]{6}$/.test(tais) || r[cStop] === "1" || !(units > 0)) continue;
      rows.push({ id: Number(r[cId]), name: nf(r[cAbbr]) || nf(r[cName]), tais, units });
    }
  }
  return { files, rows };
}
function splits(rows: Row[]) {
  const by = new Map<string, Row[]>();
  for (const r of rows) { if (!by.has(r.tais)) by.set(r.tais, []); by.get(r.tais)!.push(r); }
  const out: { tais: string; ratio: number; rows: string }[] = [];
  for (const [t, rs] of by) {
    const us = rs.map((r) => r.units);
    const ratio = Math.max(...us) / Math.min(...us);
    if (ratio >= RATIO) out.push({ tais: t, ratio, rows: rs.map((r) => `${r.id}:${r.name}:${r.units * 10}円`).join(" ") });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

const results: Record<string, { files: string[]; total: number; items: string[] }> = {};
let negFail = 0;
for (const area of AREAS) {
  const got = readArea(area);
  if (!got) { console.log(`${area}: FYGMST01 が手元に無い — 測れていない (PASS ではない)`); continue; }
  const sp = splits(got.rows);
  results[area] = { files: got.files, total: sp.length, items: sp.map((x) => x.tais) };
  console.log(`${area}: 使用中の行 ${got.rows.length} / 5 倍以上割れている TAIS ${sp.length}`);
  for (const x of LIST ? sp : sp.slice(0, 5)) console.log(`    ${x.tais} ${x.ratio.toFixed(1)} 倍  ${x.rows.slice(0, 200)}`);
  // 負のコントロール: 割れていない TAIS の行を 1 つ選び、10 倍の行を足すと 1 件増えること
  const split = new Set(sp.map((x) => x.tais));
  const victim = got.rows.find((r) => !split.has(r.tais));
  if (victim) {
    const n = splits([...got.rows, { ...victim, id: -1, units: victim.units * 10 }]).length;
    if (n !== sp.length + 1) { console.error(`  ✗ 負のコントロール: 10 倍の行を足しても ${sp.length} → ${n} (検査が効いていない)`); negFail++; }
  }
}

const README = "check:fygmst-split の基準値。事業所ごとに ほのぼの用具マスタ FYGMST01 で 同じ TAIS の使用中の価格 (単位数 > 0) が 5 倍以上割れている TAIS の数。増えたら FAIL。"
  + " 2026-11-14 の初期値: ケアサポ・誉田 の中身は items を見ること。誉田の 01339-000007 楽起 縦型 (2,000 / 20,000) は 打ち間違い (価格取込は上限の 2 倍以上を外すので 2,000 を使う)。"
  + " 誉田の 00187-000111 (EWB101S バスリフト 15,000 / EWBP107 500) は 別の型番を同じ TAIS で登録しているとみられる (誉田に確認・docs/homda-office-prices-2026-11.md §6)。"
  + " 誉田の 00170-000553 は KS-126C (1本 300・2本 500) と KS-096B 2,000 が同じ TAIS (価格取込は KS-096B 2,000 を拾い check:ceiling ② に出ている・誉田に確認)。"
  + " ケアサポの 3 件 (00187-000176 アームレスト乗越キット 500 / 背あてボード 18,000・00200-Z00278 FB-Jネオ 8,000 / SE-07JN 1,000・00254-000017 ベストポジション 500〜3,000) も 別の品目を同じ TAIS で登録しているとみられる。"
  + " ほのぼの側が直したら件数が下がる → --update で下げる。";
const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
if (negFail) { console.error(`\n✗ check:fygmst-split FAIL (負のコントロール ${negFail})`); process.exit(1); }
if (UPDATE || !prev) {
  writeFileSync(BASELINE, JSON.stringify({ _readme: README, updatedAt: new Date().toISOString().slice(0, 10), areas: results }, null, 2) + "\n");
  console.log(`\n基準値を書いた: ${BASELINE}`);
  process.exit(0);
}
let fail = 0;
for (const [area, cur] of Object.entries(results)) {
  const base = prev.areas?.[area];
  if (!base) { console.log(`${area}: 基準値が無い (--update で足す)`); continue; }
  const added = cur.items.filter((t) => !base.items.includes(t));
  if (added.length) { console.error(`✗ ${area}: 割れている TAIS が増えた ${base.total} → ${cur.total} (新しく: ${added.join(", ")})`); fail++; }
  else if (cur.total < base.total) console.log(`↓ ${area}: ${base.total} → ${cur.total} (直った。--update で下げる)`);
}
if (fail) { console.error(`\n✗ check:fygmst-split FAIL (${fail})`); process.exit(1); }
console.log("\n✓ check:fygmst-split PASS");
