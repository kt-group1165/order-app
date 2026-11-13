/**
 * 用具の価格を「事業所ごと」に持つための取込案 — ★ DRY RUN (READ ONLY・DB は控えだけ)
 * (2026-11-13 user 決定「用具の価格は事業所ごとに持つ。事業所によって違うのだから当たり前」)
 *
 *   node scripts/fukuyogu-office-price-plan.mjs --db-cache <rebuild_rentals の控え json> [--area 誉田] [--month 2026-11] [--out <dir>]
 *
 * 案 (仕組み): 品目 (equipment_master: TAIS・名前・種目) は 1 行のまま。価格は
 *   equipment_price_history に office_id (NULL = 全事業所共通 = 今の行) を足し、事業所の行があればそれを、無ければ共通の行を使う。
 *   → 改定日 (valid_from) を事業所ごとに持てる。ケアサポは今の共通の行のまま (★ 請求額は 1 円も変わらない)。
 * この script は「その事業所の FYGMST01 の単位数」と「今の共通の価格 (その月の価格履歴 → 用具マスタ)」を比べて、
 *   A 事業所の行が要る品目 (単位数が違う)   B 同じなので行は要らない   C 用具マスタに無い TAIS (品目を足す)
 *   D 判断が要る (その事業所の FYGMST01 で 使用中の単位数が 2 通り以上 / 用具マスタの同じ TAIS に価格の違う行が複数)
 * を出す。CSV は --out (既定 OS の一時フォルダ/fukuyogu-office-price-plan)。
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFukuyoguOffice } from "../migrations/_fukuyogu_office.mjs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const CACHE = opt("--db-cache");
if (!CACHE) { console.error("usage: node scripts/fukuyogu-office-price-plan.mjs --db-cache <json> [--area 誉田] [--month YYYY-MM]"); process.exit(1); }
const FO = resolveFukuyoguOffice(argv.includes("--area") || argv.includes("--office-bn") ? argv : ["--area", "誉田"]);
const MONTH = opt("--month") ?? new Date().toISOString().slice(0, 7);
const OUT = opt("--out") ?? join(tmpdir(), "fukuyogu-office-price-plan");
const nf = (s) => String(s ?? "").normalize("NFKC").trim();
const nTais = (s) => nf(s).toUpperCase().replace(/[‐－―ー–?]/g, "-");
const isTais = (t) => /^\d{5}-[0-9A-Z]{6}$/.test(t);

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
function readMaster(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const col = (k) => { const i = head.indexOf(k); if (i < 0) throw new Error(`★ ${path} に列「${k}」が無い`); return i; };
  const H = Object.fromEntries(["中止", "福祉用具種目", "商品名称", "型番", "TAISコード等", "単位数"].map((k) => [k, col(k)]));
  const out = [];
  for (let r of lines.slice(1).map(parseCsvLine)) {
    if (r.length === head.length + 1) r = [...r.slice(0, H.型番), `${r[H.型番]},${r[H.型番 + 1]}`, ...r.slice(H.型番 + 2)];
    if (r.length !== head.length) throw new Error(`★ ${path}: 列数 ${r.length} ≠ ${head.length}`);
    const tais = nTais(r[H.TAISコード等]);
    if (!isTais(tais)) continue;
    out.push({ stop: r[H.中止] === "1", cat: nf(r[H.福祉用具種目]).replace(/^予防/, ""), name: nf(r[H.商品名称]), tais, units: r[H.単位数] === "" ? null : Number(r[H.単位数]) });
  }
  return out;
}

// その事業所の FYGMST01 (介護・予防。自費は TAIS が無いので外す)
const mdir = join(FO.dir, "マスタ");
if (!existsSync(mdir)) { console.log(`未着: ${mdir} が無い`); process.exit(0); }
const files = readdirSync(mdir).filter((f) => /^FYGMST.*\.csv$/i.test(f) && !/自費/.test(f));
const fy = new Map(); // TAIS → { units:Set(使用中), names:Set, cat }
for (const f of files) for (const r of readMaster(join(mdir, f))) {
  if (!fy.has(r.tais)) fy.set(r.tais, { units: new Set(), allUnits: new Set(), names: new Set(), cat: r.cat, active: false });
  const e = fy.get(r.tais);
  if (r.units != null) { e.allUnits.add(r.units); if (!r.stop) e.units.add(r.units); }
  e.names.add(r.name); if (!r.stop) e.active = true;
}

// 今の共通の価格 (請求画面と同じ: その月の月初時点の価格履歴 → 用具マスタ.rental_price)
const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const histBy = new Map();
for (const h of snap.priceHist ?? []) { if (!histBy.has(h.product_code)) histBy.set(h.product_code, []); histBy.get(h.product_code).push(h); }
const monthStart = `${MONTH}-01`;
const priceOf = (e) => {
  const hs = (histBy.get(e.product_code) ?? []).filter((h) => h.valid_from <= monthStart).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
  return hs[0]?.rental_price ?? e.rental_price ?? null;
};
const eqByTais = new Map();
for (const e of snap.equipment ?? []) for (const t of new Set([nTais(e.tais_code), nTais(e.product_code)])) {
  if (!isTais(t)) continue;
  if (!eqByTais.has(t)) eqByTais.set(t, []);
  eqByTais.get(t).push(e);
}

const R = { A: [], B: [], C: [], D: [] };
for (const [tais, e] of fy) {
  if (!e.active) continue; // 中止だけの品目は 価格を作らない
  const units = [...e.units];
  const base = { TAIS: tais, 種目: e.cat, 商品名: [...e.names].join(" / ") };
  const eqs = eqByTais.get(tais);
  if (units.length !== 1) { R.D.push({ ...base, 理由: `${FO.area} の使用中の単位数が ${units.length} 通り`, 単位数: units.join(" / ") }); continue; }
  const u = units[0];
  if (!eqs) { R.C.push({ ...base, [`${FO.area}_単位数`]: u, 作る価格_円: u * 10 }); continue; }
  const prices = [...new Set(eqs.map(priceOf).filter((p) => p != null))];
  if (prices.length > 1) { R.D.push({ ...base, 理由: "用具マスタの同じ TAIS に価格の違う行が複数", 今の価格_円: prices.join(" / "), [`${FO.area}_単位数`]: u, product_code: eqs.map((x) => x.product_code).join(" / ") }); continue; }
  const now = prices[0] ?? null;
  const row = { ...base, product_code: eqs.map((x) => x.product_code).join(" / "), 今の共通の価格_円: now, [`${FO.area}_単位数`]: u, [`${FO.area}_価格_円`]: u * 10 };
  if (now == null || now !== u * 10) R.A.push({ ...row, 差_円: now == null ? "" : u * 10 - now });
  else R.B.push(row);
}

mkdirSync(OUT, { recursive: true });
const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const label = { A: "A_事業所の行が要る (単位数が違う)", B: "B_同じ (行は要らない)", C: "C_用具マスタに無い (品目を足す)", D: "D_判断が要る" };
console.log(`事業所: ${FO.area} ${FO.bn} / FYGMST01 ${files.join(" / ")} (使用中 TAIS ${[...fy.values()].filter((e) => e.active).length})`);
console.log(`共通の価格 = ${MONTH} 月初の価格履歴 → 用具マスタ (控え ${snap.fetchedAt})\n`);
for (const k of ["A", "B", "C", "D"]) {
  const xs = R[k];
  console.log(`  ${label[k].padEnd(30)} ${String(xs.length).padStart(5)}`);
  for (const x of xs.slice(0, Number(process.env.SHOW ?? 3))) console.log(`      - ${JSON.stringify(x).slice(0, 230)}`);
  if (!xs.length) continue;
  const cols = Object.keys(xs[0]);
  writeFileSync(join(OUT, `${FO.area}_${label[k]}.csv`), "﻿" + [cols.map(esc).join(","), ...xs.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n"));
}
const up = R.A.filter((x) => typeof x.差_円 === "number" && x.差_円 > 0).length, down = R.A.filter((x) => typeof x.差_円 === "number" && x.差_円 < 0).length;
console.log(`\n  A の内訳: ${FO.area} の方が高い ${up} / 安い ${down} / 今の価格なし ${R.A.length - up - down}`);
console.log(`\n書込みの見込み (承認後): equipment_price_history に office_id=${FO.area} の行 ${R.A.length} 行 (+ C を品目として足すなら ${R.C.length} 品目と その価格行)。ケアサポの行は作らない (今の共通の行のまま)`);
console.log(`→ CSV: ${OUT}`);
