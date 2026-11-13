/**
 * 用具マスタ (equipment_master.tais_code) の ハイフンが化けた TAIS コード (「00167?000197」等) を直す案 — ★ DRY RUN 専用 (DB は読まない・書かない)
 * (2026-11-13。上限チェック lib/ceilingCheck.ts は TAIS を正規化せずに引くので、化けた品目は 上限を超えても黙って素通りする)
 *
 *   node migrations/fix_equipment_tais_garbled_hyphen.mjs --db-cache <json>
 *     json = { fetchedAt, equipment: [{id, product_code, name, tais_code}], ceilings: [{tais_code, effective_from, ceiling_price}] }
 *
 * 直す案:
 *   tais_code の 6 文字目 (5 桁の後) が「?」「？」や 全角・ダッシュ系の文字で、それを「-」にすると 5桁-6桁 の形になる行だけ (一律の置換はしない)
 *   A 直す … 直した TAIS が 上限価格マスタ (equipment_price_ceilings) に実在する
 *   B 判断が要る (書かない) … 直した TAIS が 上限マスタに無い (実在しない番号を作ると 上限チェックが静かに素通りするため) /
 *     同じ TAIS を 別の品目が既に持っている (重複になる)
 * ★ --execute は未実装。書くときは 書込み前の行を退避 (ファイル名はミリ秒まで: _backup_tais_fix_<YYYYMMDD-HHmmss-SSS>.json) し、
 *   1 行ずつ update して件数 1 を確かめる。DB が落ちているときは回さない。
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (argv.includes("--execute")) { console.error("★ --execute は未実装 (DRY RUN 専用)"); process.exit(1); }
const CACHE = opt("--db-cache");
if (!CACHE) { console.error("usage: node migrations/fix_equipment_tais_garbled_hyphen.mjs --db-cache <json>"); process.exit(1); }
const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const TAIS = /^\d{5}-[0-9A-Z]{6}$/;
const GARBLED = /^(\d{5})[?？‐－―ー–—](.{6})$/;
const ceilTais = new Set((snap.ceilings ?? []).map((c) => String(c.tais_code ?? "").trim()));
const owners = new Map();
for (const e of snap.equipment ?? []) { const t = String(e.tais_code ?? "").trim(); if (TAIS.test(t)) { if (!owners.has(t)) owners.set(t, []); owners.get(t).push(e); } }

const R = { A: [], B: [], other: [] };
for (const e of snap.equipment ?? []) {
  const raw = String(e.tais_code ?? "").trim();
  if (!raw || TAIS.test(raw)) continue;
  // 全角の英数字 (「00122-Ｚ00017」) は NFKC でそろえるだけで直る。ハイフンの化けは その 1 文字だけを「-」に
  const nfkc = raw.normalize("NFKC").toUpperCase();
  const m = nfkc.match(GARBLED) ?? raw.toUpperCase().match(GARBLED);
  const fixed = TAIS.test(nfkc) ? nfkc : m ? `${m[1]}-${m[2]}` : null;
  const row = { id: e.id, product_code: e.product_code, 名前: e.name, 今: raw, 直した: fixed };
  if (!fixed || !TAIS.test(fixed)) { R.other.push({ ...row, 理由: "5桁-6桁 の形にならない (触らない)" }); continue; }
  const dup = (owners.get(fixed) ?? []).filter((x) => x.id !== e.id);
  if (!ceilTais.has(fixed)) R.B.push({ ...row, 理由: "直した TAIS が 上限マスタに無い" + (dup.length ? ` / 同じ TAIS の品目が既にある (${dup.map((x) => x.product_code).join(", ")})` : "") });
  else if (dup.length) R.B.push({ ...row, 理由: `同じ TAIS の品目が既にある (${dup.map((x) => x.product_code).join(", ")}) → 直すと重複` });
  else R.A.push(row);
}
console.log(`控え ${snap.fetchedAt} / 用具マスタ ${(snap.equipment ?? []).length} 品目 / 上限マスタ ${(snap.ceilings ?? []).length} 行 (TAIS ${ceilTais.size} 種)`);
for (const [k, t] of [["A", "直す (上限マスタに実在)"], ["B", "★ 判断が要る (書かない)"], ["other", "形にならない (触らない)"]]) {
  console.log(`\n${k} ${t}: ${R[k].length}`);
  for (const x of R[k]) console.log(`  - ${JSON.stringify(x)}`);
}
console.log(`\n書込みの見込み (承認後): equipment_master update ${R.A.length} 行 (tais_code)`);
console.log("DRY RUN — DB は読んでいない・書き換えていない (--execute は未実装)");
