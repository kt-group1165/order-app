/**
 * 事業所ごとの用具の価格を ほのぼのの用具マスタ (FYGMST01) から作る案 — ★ DRY RUN 専用 (DB は読まない・書かない)
 * (2026-11-13 user 決定: (a) 価格は事業所ごとに履歴付きで持つ / (b) 新システムの用具マスタに無い品目は足してよい)
 *
 *   node migrations/import_office_prices_from_fygmst.mjs --area 誉田 --db-cache <rebuild の控え json> [--valid-from 2026-04-01] [--month 2026-11] [--out <dir>]
 *
 * 前提: equipment_price_history.office_id (migrations/equipment_price_history_office_id.sql) と、
 *   価格の決め方 = その事業所の行 → 共通の行 → equipment_master.rental_price (lib/equipment.ts getPriceForMonth)
 *
 * 作る案 (TAIS ごと。FYGMST01 の介護・予防。自費は TAIS が無いので外す):
 *   「今の価格」= その TAIS の 使用中 (中止=0) の行のうち
 *       ケアサポ: 名前が「●」で始まらない行 (● = 古い世代)。複数なら ID が最大の行
 *       それ以外 (誉田 等): 記号 (略称・商品名称の先頭) の優先 ★ > ☆ > (◎・◇・▲) > 無印。同じ記号なら ID が最大の行
 *         (2026-11-13 誉田の提供票 R8/5〜10 の新規開始で確認: 価格が複数ある品目の新規は ☆ 176 / 無印 64 (☆ の無い品目) / ★ 2 / ◎◇ 3。
 *          ★ は ☆ より新しく安い世代)。◎・◇・▲ や無印の古い価格は G (古い世代の品目の候補) に出る
 *   P1 用具マスタに無い TAIS → equipment_master に品目を足す (product_code = TAIS・rental_price = 今の価格)。事業所の行は作らない (共通 = その価格)
 *   P2 用具マスタにあり、共通の価格 (--valid-from の月初・今月 の両方) が今の価格と同じ → 何もしない
 *   P3 用具マスタにあり、共通の価格と違う → equipment_price_history に office_id = その事業所・valid_from = --valid-from の行 (その TAIS の品目コードごと)
 *      ★ ケアサポは作らない (2026-11-13 決定。共通の価格 = ケアサポの請求価格なので二重に持たせない) → J に出すだけ
 *   J  判断が要る (書かない): 用具マスタの同じ TAIS に価格の違う品目が複数 (世代が分かれている) / 共通の価格が無い
 *   G  使用中の価格が 2 通り以上ある TAIS は、今の価格のほかの価格を「古い世代の品目が要る候補」として出す
 *      (① の方針: 古い世代は別の product_code の品目にして、その価格で借りている明細をそちらに付ける。品目の作成・付け替えは別の手順)
 * ★ 影響: その事業所の注文で --valid-from 〜 --month に貸与していた明細が使っている品目は、事業所の行を作らず J に回す
 *   (過去の月を含め 今の請求額を変えない)
 * ★ --execute は未実装。件数を user が確認してから 書込み (data_import_batches / data_import_rows の作法) を足す。
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFukuyoguOffice } from "./_fukuyogu_office.mjs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (argv.includes("--execute")) { console.error("★ --execute は未実装 (DRY RUN 専用)。件数を user が確認してから書込みを足す"); process.exit(1); }
const CACHE = opt("--db-cache");
if (!CACHE) { console.error("usage: node migrations/import_office_prices_from_fygmst.mjs --area 誉田 --db-cache <json> [--valid-from 2026-04-01] [--month 2026-11]"); process.exit(1); }
const FO = resolveFukuyoguOffice(argv);
const VALID_FROM = opt("--valid-from") ?? "2026-04-01";
const MONTH = opt("--month") ?? new Date().toISOString().slice(0, 7);
const OUT = opt("--out") ?? join(tmpdir(), "office-prices-from-fygmst");
const IS_CARESAPO = FO.bn === "1272400050";
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
  const H = Object.fromEntries(["ID", "中止", "福祉用具種目", "商品名称", "略称", "型番", "TAISコード等", "単位数"].map((k) => [k, col(k)]));
  const out = [];
  for (let r of lines.slice(1).map(parseCsvLine)) {
    if (r.length === head.length + 1) r = [...r.slice(0, H.型番), `${r[H.型番]},${r[H.型番 + 1]}`, ...r.slice(H.型番 + 2)];
    if (r.length !== head.length) throw new Error(`★ ${path}: 列数 ${r.length} ≠ ${head.length}`);
    const tais = nTais(r[H.TAISコード等]);
    if (!isTais(tais) || r[H.単位数] === "") continue;
    out.push({ id: Number(r[H.ID]), stop: r[H.中止] === "1", cat: nf(r[H.福祉用具種目]).replace(/^予防/, ""), name: nf(r[H.商品名称]), abbr: nf(r[H.略称]), tais, units: Number(r[H.単位数]) });
  }
  return out;
}

const mdir = join(FO.dir, "マスタ");
if (!existsSync(mdir)) { console.log(`未着: ${mdir} が無い`); process.exit(0); }
const files = readdirSync(mdir).filter((f) => /^FYGMST.*\.csv$/i.test(f) && !/自費/.test(f));
const byTais = new Map();
for (const f of files) for (const r of readMaster(join(mdir, f))) { if (!byTais.has(r.tais)) byTais.set(r.tais, []); byTais.get(r.tais).push(r); }

const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const hist = snap.priceHist ?? [];
const commonPrice = (e, ym) => {
  const hs = hist.filter((h) => h.product_code === e.product_code && !h.office_id && h.valid_from <= `${ym}-01`).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
  return hs[0]?.rental_price ?? e.rental_price ?? null;
};
const eqByTais = new Map();
for (const e of snap.equipment ?? []) for (const t of new Set([nTais(e.tais_code), nTais(e.product_code)])) { if (!isTais(t)) continue; if (!eqByTais.has(t)) eqByTais.set(t, []); if (!eqByTais.get(t).includes(e)) eqByTais.get(t).push(e); }
const vfYm = VALID_FROM.slice(0, 7);

const R = { P1: [], P2: [], P3: [], J: [], G: [], diffFromIdMax: [] };
/** 誉田の世代の記号 (略称 → 商品名称 の先頭)。★ = 最新・最安 / ☆ = その前 / ◎◇▲ = ☆ より前 / 無印 = 古いか 世代の分かれていない品目 */
const genMark = (r) => ((r.abbr || r.name).match(/^[★☆◎◇▲●]/) ?? r.name.match(/^[★☆◎◇▲●]/) ?? [""])[0];
const genRank = (r) => ({ "★": 4, "☆": 3, "◎": 2, "◇": 2, "▲": 2 })[genMark(r)] ?? 1;
for (const [tais, rows] of byTais) {
  const act = rows.filter((r) => !r.stop);
  if (!act.length) continue; // 中止だけの品目は作らない
  const curCands = IS_CARESAPO ? act.filter((r) => !r.name.startsWith("●")) : act;
  const pool = curCands.length ? curCands : act;
  const byId = pool.reduce((a, b) => (b.id > a.id ? b : a));
  // ケアサポ: ● の無い行の ID 最大 / それ以外 (誉田): 記号の優先、同じ記号なら ID 最大
  const cur = IS_CARESAPO ? byId : pool.reduce((a, b) => (genRank(b) > genRank(a) || (genRank(b) === genRank(a) && b.id > a.id) ? b : a));
  if (!IS_CARESAPO && cur !== byId) R.diffFromIdMax.push({ TAIS: tais, 記号で選んだ行: `${cur.id} ${cur.abbr || cur.name} ${cur.units * 10}円`, ID最大の行: `${byId.id} ${byId.abbr || byId.name} ${byId.units * 10}円`, 価格が違う: cur.units !== byId.units });
  const price = cur.units * 10;
  const others = [...new Set(act.map((r) => r.units))].filter((u) => u !== cur.units);
  if (others.length) R.G.push({ TAIS: tais, 名前: cur.abbr || cur.name, 今の価格: price, 今の行ID: cur.id, ほかの使用中の価格: others.map((u) => u * 10).join(" / "), 行: act.map((r) => `${r.id}:${r.units}${r.name.startsWith("●") ? "●" : ""}`).join(" ") });
  const eqs = eqByTais.get(tais) ?? [];
  if (!eqs.length) { R.P1.push({ TAIS: tais, 名前: cur.abbr || cur.name, 種目: cur.cat, 価格: price }); continue; }
  const cps = [...new Set(eqs.map((e) => `${commonPrice(e, vfYm)}|${commonPrice(e, MONTH)}`))];
  if (cps.length > 1) { R.J.push({ TAIS: tais, 名前: cur.abbr || cur.name, 理由: "用具マスタの同じ TAIS に 価格の違う品目が複数 (世代が分かれている)", 品目: eqs.map((e) => `${e.product_code}=${commonPrice(e, MONTH)}`).join(" / "), 今の価格: price }); continue; }
  const [p0, p1] = cps[0].split("|").map((x) => (x === "null" ? null : Number(x)));
  if (p0 == null && p1 == null) { R.J.push({ TAIS: tais, 名前: cur.abbr || cur.name, 理由: "共通の価格が無い", 品目: eqs.map((e) => e.product_code).join(" / "), 今の価格: price }); continue; }
  if (p0 === price && p1 === price) { R.P2.push({ TAIS: tais }); continue; }
  // ★ ケアサポは 事業所の行を作らない (2026-11-13 決定: 共通の価格 = ケアサポで実際に請求してきた価格。二重に持たせない)
  if (IS_CARESAPO) { R.J.push({ TAIS: tais, 名前: cur.abbr || cur.name, 理由: "ケアサポは 事業所の行を作らない (共通の価格がケアサポの請求価格)。FYGMST01 の今の価格と共通の価格が違う", 品目: eqs.map((e) => e.product_code).join(" / "), 今の価格: price }); continue; }
  R.P3.push({ TAIS: tais, 名前: cur.abbr || cur.name, 品目コード: eqs.map((e) => e.product_code), 共通の価格: `${p0}→${p1}`, 事業所の価格: price, 差: price - (p1 ?? p0) });
}

// 影響: この事業所の注文で 今月 貸与中の明細が P3 の品目コードを使っているか
const orders = new Map((snap.orders ?? []).map((o) => [o.id, o]));
const p3codes = new Map(R.P3.flatMap((x) => x.品目コード.map((c) => [c, x])));
// 影響を見る期間 = 事業所の行の valid_from 〜 --month の末 (過去の月の請求・再請求も変えない)
const ms = VALID_FROM, me = `${MONTH}-31`;
const hit = (snap.items ?? []).filter((it) => {
  const o = orders.get(it.order_id);
  if (!o || o.office_id !== FO.officeId || !p3codes.has(it.product_code)) return false;
  if (!["rental_started", "terminated"].includes(it.status) || it.cancelled_at) return false;
  return (it.rental_start_date ?? "9") <= me && (!it.rental_end_date || it.rental_end_date >= ms);
});
// ★ 今月 その事業所で貸与中の明細が使っている品目は 事業所の行を作らない (今の請求額を変えない)。判断が要るに回す
//   (ケアサポは 共通の価格 = ケアサポで実際に請求している価格。FYGMST01 の「今の価格」は 新しい世代の価格で、今の明細の価格ではない)
const hitCodes = new Set(hit.map((i) => i.product_code));
for (const x of [...R.P3]) {
  const used = x.品目コード.filter((c) => hitCodes.has(c));
  if (!used.length) continue;
  R.P3.splice(R.P3.indexOf(x), 1);
  R.J.push({ TAIS: x.TAIS, 名前: x.名前, 理由: `${VALID_FROM.slice(0, 7)}〜${MONTH} に 貸与していた明細 ${hit.filter((i) => used.includes(i.product_code)).length} 本が 共通の価格 (${x.共通の価格}) で請求されている → 事業所の行を作ると請求額が変わる (古い世代の品目にするかの判断が要る)`, 品目: used.join(" / "), 今の価格: x.事業所の価格 });
}

mkdirSync(OUT, { recursive: true });
const esc = (v) => `"${String(Array.isArray(v) ? v.join(" / ") : v ?? "").replace(/"/g, '""')}"`;
const label = { P1: "P1_品目を足す", P2: "P2_同じ_何もしない", P3: "P3_事業所の価格の行を作る", J: "J_判断が要る", G: "G_古い世代の品目が要る候補" };
console.log(`事業所 ${FO.area} ${FO.bn} / FYGMST01 ${files.join(" / ")} / 使用中の TAIS ${[...byTais.values()].filter((rs) => rs.some((r) => !r.stop)).length}`);
console.log(`控え ${snap.fetchedAt} / 事業所の行の valid_from ${VALID_FROM} / 影響を見る月 ${MONTH}${IS_CARESAPO ? " / 今の価格 = 中止=0 で ● の無い行 (複数なら ID 最大)" : " / 今の価格 = 中止=0 の行で 記号 ★ > ☆ > ◎◇▲ > 無印 (同じ記号なら ID 最大)"}\n`);
for (const k of ["P1", "P2", "P3", "J", "G"]) {
  const xs = R[k];
  console.log(`  ${label[k].padEnd(28)} ${String(xs.length).padStart(5)}`);
  for (const x of k === "P2" ? [] : xs.slice(0, Number(process.env.SHOW ?? 3))) console.log(`      - ${JSON.stringify(x).slice(0, 240)}`);
  if (!xs.length || k === "P2") continue;
  const cols = Object.keys(xs[0]);
  writeFileSync(join(OUT, `${FO.area}_${label[k]}.csv`), "﻿" + [cols.map(esc).join(","), ...xs.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n"));
}
const p3rows = R.P3.reduce((s, x) => s + x.品目コード.length, 0);
if (!IS_CARESAPO) {
  console.log(`\n  記号の優先で選んだ行が ID 最大の行と違う TAIS: ${R.diffFromIdMax.length} (うち価格も違う ${R.diffFromIdMax.filter((x) => x.価格が違う).length})`);
  for (const x of R.diffFromIdMax.slice(0, Number(process.env.SHOW_DIFF ?? 10))) console.log(`      - ${JSON.stringify(x)}`);
}
console.log(`\n  P3 の内訳: 事業所の方が高い ${R.P3.filter((x) => x.差 > 0).length} / 安い ${R.P3.filter((x) => x.差 < 0).length}`);
console.log(`★ ${VALID_FROM.slice(0, 7)}〜${MONTH} に ${FO.area} の注文で貸与していた明細が使っていた品目 ${hitCodes.size} (明細 ${hit.length} 本) は P3 から外して J に回した → P3 で請求額が変わる明細は 0 本`);
console.log(`\n書込みの見込み (承認後): equipment_master insert ${R.P1.length} 品目 / equipment_price_history insert ${p3rows} 行 (office_id=${FO.area}・valid_from ${VALID_FROM})。J・G は書かない`);
console.log(`→ CSV: ${OUT}`);
console.log("DRY RUN — DB は読んでいない・書き換えていない (--execute は未実装)");
