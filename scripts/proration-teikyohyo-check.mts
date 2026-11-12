/**
 * 福祉用具貸与の月の算定 (半月按分の自動 / 日割り) を ほのぼのの提供票と突合する (READ ONLY・DB を読まない)
 *
 *   npm run check:proration              # 基準値と比べる (食い違いが増えたら FAIL)
 *   npm run check:proration -- --update  # 基準値を書き直す (★ 悪化したまま更新すると穴を焼き付ける)
 *
 * 対象: lib/half-month-units.ts の rentalMonthUnits (請求・伝送・利用請求の画面がすべて通す関数)。逐語コピーしない。
 * 入力: apps/kaigo-app/伝送データ/ケアサポ/福祉用具/用具貸与期間_20261109/提供票_YYYYMM.csv の実績行
 *   (ほのぼの福祉用具の入力側。1〜31日 の印 / 日割区分 = 全額・半額・日割(NN日) / 概算単位数)
 *
 * ── 判定 ─────────────────────────────────────────────────────────────────
 *   行の印から 貸与の最初・最後の日 と 月内の休止 (印の無い日) を作り、
 *     全額 / 半額 の行 → rentalMonthUnits(月額, …, "auto")  が 概算単位数 と一致するか
 *     日割(NN日) の行  → rentalMonthUnits(月額, …, "daily") が 概算単位数 と一致するか
 *   月額 (満額の単位数) = その行が全額ならその値 / それ以外は 同じ利用者・同じサービス内容の 全額 行 (別の月) /
 *   無ければ 用具マスタ (FYGMST01) の略称が 1 つに決まるときの単位数。決まらない行は「月額不明」として数えるだけ。
 *
 * ── 基準値 (scripts/proration-check-baseline.json) ───────────────────────
 *   日割の行は 全一致 (森 早百合 2026-05 の 14 行で式を決めた)。
 *   全額/半額 は 印と日割区分が食い違う行が既知 (half-month-units.ts のコメント: 手で日割区分を選んだと思われる 124 行程度)。
 *   その食い違いの行の集合を基準値にし、★ 新しい食い違いが出たら FAIL・消えたら報告 (基準値の更新を促す)。
 *
 * ── 負のコントロール (毎回走らせる) ───────────────────────────────────────
 *   日割を floor に、半月を ceil に わざと変えた式でも同じ突合をし、日割・半月の両方で食い違いが出ること (= この検査が効いていること) を確かめる。
 *   出なければ FAIL (検査が効いていない)。
 *
 * 提供票が無い環境では「提供票が無いので測れていない」と出して exit 0 (★ 合格ではない)。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { rentalMonthUnits, type DateRange } from "../lib/half-month-units";

const UPDATE = process.argv.includes("--update");
const BASELINE = "scripts/proration-check-baseline.json";
const FUKUYOGU = "../kaigo-app/伝送データ/ケアサポ/福祉用具";
const TEIKYO_DIR = join(FUKUYOGU, "用具貸与期間_20261109");
const MASTER_DIR = join(FUKUYOGU, "マスタ");

const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC").trim();
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function readSjis(path: string) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const col = (name: string) => { const i = head.indexOf(name); if (i < 0) throw new Error(`★ ${path} に列「${name}」が無い`); return i; };
  return { head, rows: lines.slice(1).map(parseCsvLine), col };
}
const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

if (!existsSync(TEIKYO_DIR)) {
  console.log(`⚠ 提供票のフォルダが無い (${TEIKYO_DIR}) → 測れていない (★ 合格ではない)`);
  process.exit(0);
}

// ── 提供票 (実績行) ─────────────────────────────────────────────────────────
type Row = { id: string; ym: string; userNo: string; svc: string; item: string; kind: string; hiwari: string; units: number; marks: number[] };
const rows: Row[] = [];
for (const f of readdirSync(TEIKYO_DIR).filter((x) => /^提供票_\d{6}\.csv$/i.test(x)).sort()) {
  const T = readSjis(join(TEIKYO_DIR, f));
  const c = { pa: T.col("予定／実績"), ym: T.col("提供年月"), user: T.col("利用者番号"), svc: T.col("サービス内容"), hi: T.col("日割区分"), units: T.col("概算単位数"), d1: T.col("1日") };
  for (const r of T.rows) {
    if (r[c.pa] !== "実績") continue;
    const ym = nfkc(r[c.ym]).replace("/", "-");
    const marks = r.slice(c.d1, c.d1 + daysIn(ym)).map((v) => (nfkc(v) === "1" ? 1 : 0));
    if (!marks.includes(1)) continue; // 印 0 日の行は算定対象外
    const svc = r[c.svc];
    const m = svc.match(/^(.*?)貸与[（(](.*)[)）]$/);
    rows.push({
      // 行の並びに依らない識別子 (同じ利用者・同じ用具・同じ印が 2 行あれば 同じ id → 件数で数える)
      id: `${ym}|${nfkc(r[c.user])}|${nfkc(svc)}|${nfkc(r[c.hi])}|${nfkc(r[c.units])}|${marks.join("")}`,
      ym, userNo: nfkc(r[c.user]), svc: nfkc(svc), item: nfkc(m ? m[2] : svc).replace(/\s/g, ""), kind: nfkc(m ? m[1] : "").replace(/^予防/, ""),
      hiwari: nfkc(r[c.hi]), units: Number(r[c.units] || 0), marks,
    });
  }
}
if (!rows.length) { console.log("⚠ 提供票の実績行が 0 → 測れていない (★ 合格ではない)"); process.exit(0); }

// ── 月額 (満額の単位数) ─────────────────────────────────────────────────────
const fullByUserSvc = new Map<string, Set<number>>();
for (const r of rows) if (r.hiwari === "全額") {
  const k = `${r.userNo}|${r.svc}`;
  if (!fullByUserSvc.has(k)) fullByUserSvc.set(k, new Set());
  fullByUserSvc.get(k)!.add(r.units);
}
const masterUnits = new Map<string, Set<number>>(); // `${種目}|${略称}` → 単位数
if (existsSync(MASTER_DIR)) {
  for (const f of readdirSync(MASTER_DIR).filter((x) => /^FYGMST.*\.csv$/i.test(x))) {
    const M = readSjis(join(MASTER_DIR, f));
    const ab = M.head.indexOf("略称"), kind = M.head.indexOf("福祉用具種目"), un = M.head.indexOf("単位数");
    if (ab < 0 || kind < 0 || un < 0) continue;
    for (const r of M.rows) {
      if (r[un] === "" || r[un] == null) continue;
      const k = `${nfkc(r[kind]).replace(/^予防/, "")}|${nfkc(r[ab]).replace(/\s/g, "")}`;
      if (!masterUnits.has(k)) masterUnits.set(k, new Set());
      masterUnits.get(k)!.add(Number(r[un]));
    }
  }
}
function fullOf(r: Row): { full: number | null; from: string } {
  if (r.hiwari === "全額") return { full: r.units, from: "その行 (全額)" };
  const s = fullByUserSvc.get(`${r.userNo}|${r.svc}`);
  if (s && s.size === 1) return { full: [...s][0], from: "同じ利用者・同じ用具の全額行" };
  const ms = masterUnits.get(`${r.kind}|${r.item.replace(/^予/, "")}`) ?? masterUnits.get(`${r.kind}|${r.item}`);
  if (ms && ms.size === 1) return { full: [...ms][0], from: "用具マスタ" };
  return { full: null, from: s && s.size > 1 ? "全額行の単位が複数" : "決まらない" };
}

// ── 印 → 貸与の最初・最後の日 と 月内の休止 ────────────────────────────────
function datesOf(r: Row): { start: string; end: string; gaps: DateRange[] } {
  const first = r.marks.indexOf(1) + 1, last = r.marks.lastIndexOf(1) + 1;
  const gaps: DateRange[] = [];
  for (let d = first; d <= last; d++) {
    if (r.marks[d - 1]) continue;
    let e = d;
    while (e + 1 <= last && !r.marks[e]) e++;
    gaps.push({ from: `${r.ym}-${pad(d)}`, to: `${r.ym}-${pad(e)}` });
    d = e;
  }
  return { start: `${r.ym}-${pad(first)}`, end: `${r.ym}-${pad(last)}`, gaps };
}

type Calc = (full: number, r: Row) => number;
const realCalc: Calc = (full, r) => {
  const { start, end, gaps } = datesOf(r);
  return rentalMonthUnits(full, start, end, r.ym, gaps, r.hiwari.startsWith("日割") ? "daily" : "auto");
};
// 負のコントロール: 日割を floor / 半月を ceil にした式 (わざと壊したもの)
const brokenCalc: Calc = (full, r) => {
  const days = r.marks.filter(Boolean).length, n = r.marks.length;
  if (r.hiwari.startsWith("日割")) return days >= n ? full : Math.floor((full * days) / n);
  const fh = r.marks.slice(0, 15).includes(1), sh = r.marks.slice(15).includes(1);
  return fh && sh ? full : Math.ceil(full / 2) + 1; // 半月は +1 してでも必ず食い違わせる (偶数でも鳴るように)
};

function run(calc: Calc) {
  const res = { 全額: { ok: 0, ng: 0 }, 半額: { ok: 0, ng: 0 }, 日割: { ok: 0, ng: 0 }, 月額不明: 0 };
  const ng = new Map<string, number>();
  const ex: string[] = [];
  for (const r of rows) {
    const { full } = fullOf(r);
    if (full == null) { res.月額不明++; continue; }
    const cat = r.hiwari.startsWith("日割") ? "日割" : r.hiwari === "半額" ? "半額" : "全額";
    const got = calc(full, r);
    if (got === r.units) res[cat].ok++;
    else {
      res[cat].ng++;
      ng.set(r.id, (ng.get(r.id) ?? 0) + 1);
      if (ex.length < 8) ex.push(`${r.ym} ${r.userNo} ${r.svc} ${r.hiwari} 提供票 ${r.units} / 当方 ${got} (月額 ${full}) 印 ${r.marks.join("")}`);
    }
  }
  return { res, ng, ex };
}

const real = run(realCalc);
const neg = run(brokenCalc);
console.log(`提供票の実績行 ${rows.length} 行 (印 0 日を除く)・月額不明 ${real.res.月額不明} 行 (突合しない)`);
for (const k of ["全額", "半額", "日割"] as const) console.log(`  ${k}: 一致 ${real.res[k].ok} / 食い違い ${real.res[k].ng}`);
if (real.ex.length) { console.log("  食い違いの例:"); for (const e of real.ex) console.log(`    - ${e}`); }

let fail = false;
// 負のコントロール
const negDaily = neg.res.日割.ng, negHalf = neg.res.半額.ng;
console.log(`\n負のコントロール (日割=floor / 半月=ceil+1 にわざと壊す): 日割の食い違い ${negDaily} / 半額の食い違い ${negHalf}`);
if (real.res.日割.ok + real.res.日割.ng > 0 && negDaily === 0) { console.log("  ★ FAIL: 日割の式を壊しても鳴らない (検査が効いていない)"); fail = true; }
if (real.res.半額.ok + real.res.半額.ng > 0 && negHalf === 0) { console.log("  ★ FAIL: 半月の式を壊しても鳴らない (検査が効いていない)"); fail = true; }

// 日割は 全一致が期待値 (基準値に入れない)
if (real.res.日割.ng > 0) { console.log(`★ FAIL: 日割の行が ${real.res.日割.ng} 行 食い違う (期待値は全一致)`); fail = true; }

// 全額/半額の食い違いは 基準値方式
const now: Record<string, number> = Object.fromEntries([...real.ng].filter(([id]) => !id.split("|")[3].startsWith("日割")).sort());
if (UPDATE) {
  writeFileSync(BASELINE, JSON.stringify({
    _readme: [
      "npm run check:proration の基準値 = 提供票 (実績行) で 日割区分 (全額/半額) と rentalMonthUnits(auto) が食い違う行の集合。",
      "印と日割区分が食い違う行 (ほのぼので手で日割区分を選んだと思われる行。lib/half-month-units.ts の halfMonthFlags のコメント参照) が既知。",
      "★ 新しい食い違いが出たら FAIL。--update は 原因を確かめてから (悪化したまま更新すると穴を焼き付ける)。",
      `更新: ${new Date().toISOString().slice(0, 10)} / 行 ${rows.length} / 全額 食い違い ${real.res.全額.ng} / 半額 食い違い ${real.res.半額.ng} / 日割 食い違い ${real.res.日割.ng}`,
    ],
    mismatches: now,
  }, null, 1) + "\n");
  console.log(`\n基準値を書き直した: ${BASELINE} (${Object.keys(now).length} 種)`);
} else if (!existsSync(BASELINE)) {
  console.log(`\n★ FAIL: 基準値 ${BASELINE} が無い (初回は -- --update)`); fail = true;
} else {
  const base: Record<string, number> = JSON.parse(readFileSync(BASELINE, "utf8")).mismatches ?? {};
  const added = Object.entries(now).filter(([id, n]) => n > (base[id] ?? 0));
  const gone = Object.entries(base).filter(([id, n]) => (now[id] ?? 0) < n);
  console.log(`\n基準値との比較: 基準 ${Object.values(base).reduce((s, n) => s + n, 0)} 行 / 今回 ${Object.values(now).reduce((s, n) => s + n, 0)} 行`);
  if (added.length) {
    console.log(`★ FAIL: 新しい食い違い ${added.length} 種`);
    for (const [id] of added.slice(0, 10)) console.log(`    + ${id}`);
    fail = true;
  }
  if (gone.length) {
    console.log(`  解消した食い違い ${gone.length} 種 (原因を確かめて -- --update):`);
    for (const [id] of gone.slice(0, 10)) console.log(`    - ${id}`);
  }
}
console.log(fail ? "\n✗ check:proration FAIL" : "\n✓ check:proration PASS");
process.exit(fail ? 1 : 0);
