/**
 * 福祉用具の用具マスタを 事業所 (ほのぼのの FYGMST01) どうし・order-app の equipment_master と TAIS で突き合わせる — ★ READ ONLY
 * (用具マスタ統合の判断材料。2026-11-13 誉田の受入れで作成)
 *
 *   node scripts/fukuyogu-equipment-master-compare.mjs --db-cache <rebuild_rentals の --db-cache の json> [--areas ケアサポ,誉田] [--out <dir>]
 *
 * 入力:
 *   ・各事業所の 伝送データ/<area>/福祉用具/マスタ/FYGMST01_*.CSV (介護・予防。自費は TAIS が無いので比べない)
 *   ・equipment_master は DB を読まず、rebuild_rentals_from_teikyohyo.mjs の --db-cache の控え (equipment) を使う
 * 出力 (標準出力に件数、--out に CSV。既定 = OS の一時フォルダ/fukuyogu-equipment-compare):
 *   1 両方にあって 単位数が違う TAIS   2 両方にあって 商品名・略称が違う TAIS   3 片方にだけある TAIS
 *   4 equipment_master に無い TAIS     5 equipment_master の価格 (rental_price ÷ 10) と単位数が違う TAIS
 *   「使用中」= FYGMST01 の 中止 が 1 でない行。件数は 使用中 / 全行 の両方を出す
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const CACHE = opt("--db-cache");
if (!CACHE) { console.error("usage: node scripts/fukuyogu-equipment-master-compare.mjs --db-cache <json> [--areas ケアサポ,誉田] [--out <dir>]"); process.exit(1); }
const AREAS = (opt("--areas") ?? "ケアサポ,誉田").split(",");
const OUT = opt("--out") ?? join(tmpdir(), "fukuyogu-equipment-compare");
const nf = (s) => String(s ?? "").normalize("NFKC").trim();
const nTais = (s) => nf(s).toUpperCase().replace(/[‐－―ー–?]/g, "-");

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
/** FYGMST01 を読む (rebuild_rentals の readMaster と同じ列・同じ「型番に引用符なしのカンマ」の直し) */
function readMaster(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const col = (k) => { const i = head.indexOf(k); if (i < 0) throw new Error(`★ ${path} に列「${k}」が無い`); return i; };
  const H = Object.fromEntries(["中止", "福祉用具種目", "商品名称", "略称", "型番", "TAISコード等", "単位数"].map((k) => [k, col(k)]));
  const out = [];
  for (let r of lines.slice(1).map(parseCsvLine)) {
    if (r.length === head.length + 1) r = [...r.slice(0, H.型番), `${r[H.型番]},${r[H.型番 + 1]}`, ...r.slice(H.型番 + 2)];
    if (r.length !== head.length) throw new Error(`★ ${path}: 列数 ${r.length} ≠ ${head.length}`);
    const tais = nTais(r[H.TAISコード等]);
    if (!/^\d{5}-[0-9A-Z]{6}$/.test(tais)) continue; // TAIS の無い行 (自費・付属) は比べない
    out.push({ stop: r[H.中止] === "1", cat: nf(r[H.福祉用具種目]).replace(/^予防/, ""), name: nf(r[H.商品名称]), abbr: nf(r[H.略称]), model: nf(r[H.型番]), tais, units: r[H.単位数] === "" ? null : Number(r[H.単位数]) });
  }
  return out;
}

// 事業所ごとに TAIS → { units:Set, names:Set, abbrs:Set, active:boolean }
const byArea = {};
for (const area of AREAS) {
  const dir = join(HERE, "../../kaigo-app/伝送データ", area, "福祉用具", "マスタ");
  if (!existsSync(dir)) { console.log(`${area}: マスタが無い (${dir}) — 飛ばす`); continue; }
  const files = readdirSync(dir).filter((f) => /^FYGMST.*\.csv$/i.test(f) && !/自費/.test(f));
  const m = new Map();
  for (const f of files) for (const r of readMaster(join(dir, f))) {
    if (!m.has(r.tais)) m.set(r.tais, { units: new Set(), names: new Set(), abbrs: new Set(), cats: new Set(), active: false });
    const e = m.get(r.tais);
    if (r.units != null && !r.stop) e.units.add(r.units);
    e.names.add(r.name); if (r.abbr) e.abbrs.add(r.abbr); e.cats.add(r.cat);
    if (!r.stop) e.active = true;
  }
  // 使用中の単位が無い (全部中止) ときは 中止行の単位も見る
  for (const f of files) for (const r of readMaster(join(dir, f))) { const e = m.get(r.tais); if (!e.units.size && r.units != null) e.units.add(r.units); }
  byArea[area] = m;
  console.log(`${area}: ${files.join(" / ")} → TAIS ${m.size} 種 (使用中 ${[...m.values()].filter((e) => e.active).length})`);
}

// equipment_master (控え)
const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const eqByTais = new Map();
for (const e of snap.equipment ?? []) {
  for (const t of new Set([nTais(e.tais_code), nTais(e.product_code)])) {
    if (!/^\d{5}-[0-9A-Z]{6}$/.test(t)) continue;
    if (!eqByTais.has(t)) eqByTais.set(t, []);
    eqByTais.get(t).push(e);
  }
}
console.log(`equipment_master (控え ${snap.fetchedAt}): ${snap.equipment?.length ?? 0} 行 / TAIS ${eqByTais.size} 種`);

const [A, B] = AREAS;
const MA = byArea[A] ?? new Map(), MB = byArea[B] ?? new Map();
const fmt = (s) => [...s].join(" / ");
const T = { 単位数が違う: [], 名前が違う: [], [`${A}のみ`]: [], [`${B}のみ`]: [], equipment_masterに無い: [], equipment_masterと単位数が違う: [] };
for (const tais of new Set([...MA.keys(), ...MB.keys()])) {
  const a = MA.get(tais), b = MB.get(tais);
  const active = (a?.active ?? false) || (b?.active ?? false);
  const base = { TAIS: tais, 使用中: active ? "○" : "", 種目: fmt(new Set([...(a?.cats ?? []), ...(b?.cats ?? [])])) };
  if (a && b) {
    if (fmt(a.units) !== fmt(b.units)) T.単位数が違う.push({ ...base, [`${A}_単位数`]: fmt(a.units), [`${B}_単位数`]: fmt(b.units), [`${A}_商品名`]: fmt(a.names), [`${B}_商品名`]: fmt(b.names) });
    if (fmt(a.names) !== fmt(b.names) || fmt(a.abbrs) !== fmt(b.abbrs)) T.名前が違う.push({ ...base, [`${A}_商品名`]: fmt(a.names), [`${B}_商品名`]: fmt(b.names), [`${A}_略称`]: fmt(a.abbrs), [`${B}_略称`]: fmt(b.abbrs) });
  } else if (a) T[`${A}のみ`].push({ ...base, 単位数: fmt(a.units), 商品名: fmt(a.names), 略称: fmt(a.abbrs) });
  else T[`${B}のみ`].push({ ...base, 単位数: fmt(b.units), 商品名: fmt(b.names), 略称: fmt(b.abbrs) });
  const eq = eqByTais.get(tais);
  const units = new Set([...(a?.units ?? []), ...(b?.units ?? [])]);
  if (!eq) T.equipment_masterに無い.push({ ...base, 単位数: fmt(units), 商品名: fmt(new Set([...(a?.names ?? []), ...(b?.names ?? [])])), どこにある: [a && A, b && B].filter(Boolean).join("・") });
  else {
    const dbUnits = new Set(eq.map((e) => (e.rental_price == null ? null : Math.round(e.rental_price / 10))).filter((x) => x != null));
    if (dbUnits.size && units.size && ![...units].some((u) => dbUnits.has(u))) T.equipment_masterと単位数が違う.push({ ...base, DB_単位数: fmt(dbUnits), FYGMST01_単位数: fmt(units), DB_product_code: eq.map((e) => e.product_code).join(" / "), DB_行数: eq.length });
  }
}

mkdirSync(OUT, { recursive: true });
const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
console.log(`\n══ ${A} × ${B} × equipment_master (TAIS で突き合わせ) ══  件数 = 全体 (うち 使用中)`);
for (const [k, rows] of Object.entries(T)) {
  console.log(`  ${k.padEnd(28)} ${String(rows.length).padStart(5)} (使用中 ${rows.filter((r) => r.使用中).length})`);
  for (const r of rows.filter((x) => x.使用中).slice(0, Number(process.env.SHOW ?? 3))) console.log(`      - ${JSON.stringify(r).slice(0, 220)}`);
  if (!rows.length) continue;
  const cols = Object.keys(rows[0]);
  writeFileSync(join(OUT, `${k}.csv`), "﻿" + [cols.map(esc).join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n"));
}
console.log(`\n→ CSV: ${OUT}`);
