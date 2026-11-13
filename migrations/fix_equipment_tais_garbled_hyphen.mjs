/**
 * 用具マスタ (equipment_master.tais_code) の ハイフンが化けた TAIS コード (「00167?Z00091」等) を直す
 * (2026-11-13。上限チェックは normalizeTais で引けるようにしたが、マスタの値そのものも直す)
 *
 *   node migrations/fix_equipment_tais_garbled_hyphen.mjs --db-cache <json>        DRY RUN (控え)
 *   node migrations/fix_equipment_tais_garbled_hyphen.mjs --live                   DRY RUN (今の DB を読む。READ ONLY)
 *   node migrations/fix_equipment_tais_garbled_hyphen.mjs --live --execute --expect 4   本番 (★ user 承認後)
 *     控え json = { fetchedAt, equipment: [{id, product_code, name, tais_code, parent_product_code?}], ceilings: [{tais_code}] }
 *
 * 直す案:
 *   tais_code の 6 文字目 (5 桁の後) が「?」「？」や 全角・ダッシュ系の文字で、それを「-」にすると 5桁-6桁 の形になる行だけ (一律の置換はしない)
 *   全角の英数字は NFKC でそろえる。用具マスタの子 (parent_product_code あり) は対象外 (統合で 親の TAIS に直している)
 *   A 直す … 直した TAIS が 上限価格マスタ (equipment_price_ceilings) に実在し、同じ TAIS の品目がほかに無い
 *   B 判断が要る (書かない) … 直した TAIS が 上限マスタに無い (実在しない番号を作ると 上限チェックが静かに素通りするため) /
 *     同じ TAIS を 別の品目が既に持っている (重複 = 統合の対象)
 * --execute: 書込み前の行を migrations/_backup_tais_fix_<YYYYMMDD-HHmmss-SSS>.json に退避 (ミリ秒まで = 続けて回しても上書きしない) し、
 *   1 行ずつ「今の tais_code が DRY RUN のときと同じ」を条件に update して 更新件数 1 を確かめる。--expect で A の件数を固定 (違えば止める)。
 *   5xx・HTML が返ったら止める (リトライしない)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const LIVE = argv.includes("--live");
const CACHE = opt("--db-cache");
if (!LIVE && !CACHE) { console.error("usage: --db-cache <json> | --live [--execute --expect N]"); process.exit(1); }
if (EXECUTE && !LIVE) { console.error("★ --execute は --live (今の DB) と一緒に"); process.exit(1); }
if (EXECUTE && opt("--expect") == null) { console.error("★ --execute には --expect <直す件数> が要る (DRY RUN の A の件数)"); process.exit(1); }

const TAIS = /^\d{5}-[0-9A-Z]{6}$/;
const GARBLED = /^(\d{5})[?？‐－―ー–—](.{6})$/;
const fixOf = (raw) => {
  const nfkc = raw.normalize("NFKC").toUpperCase();
  const m = nfkc.match(GARBLED) ?? raw.toUpperCase().match(GARBLED);
  return TAIS.test(nfkc) ? nfkc : m ? `${m[1]}-${m[2]}` : null;
};

let E, H;
async function rest(method, path, body) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(`${E.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`, { method, headers: { ...H, "Content-Type": "application/json", Prefer: "return=representation" }, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const t = await r.text();
    if (!r.ok || t.startsWith("<")) throw new Error(`STOP (リトライしない) ${r.status} ${method} ${path.slice(0, 80)} ${t.slice(0, 160)}`);
    return t ? JSON.parse(t) : null;
  } finally { clearTimeout(tm); }
}

let snap;
if (LIVE) {
  const txt = readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8");
  E = Object.fromEntries(txt.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
  H = { apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_ROLE_KEY}` };
  const equipment = [];
  for (let o = 0; ; o += 1000) {
    const j = await rest("GET", `equipment_master?select=id,product_code,name,tais_code,parent_product_code&tenant_id=eq.kt-group&order=id&limit=1000&offset=${o}`);
    equipment.push(...j); if (j.length < 1000) break;
  }
  // 上限マスタは 直した候補の TAIS だけ引く (全件は読まない)
  const cands = [...new Set(equipment.map((e) => String(e.tais_code ?? "").trim()).filter((t) => t && !TAIS.test(t)).map(fixOf).filter((t) => t && TAIS.test(t)))];
  const ceilings = cands.length ? await rest("GET", `equipment_price_ceilings?select=tais_code&tais_code=in.(${cands.map((t) => `"${t}"`).join(",")})`) : [];
  snap = { fetchedAt: `今の DB (${new Date().toISOString()})`, equipment, ceilings };
} else snap = JSON.parse(readFileSync(CACHE, "utf8"));

const ceilTais = new Set((snap.ceilings ?? []).map((c) => String(c.tais_code ?? "").trim()));
const owners = new Map();
for (const e of snap.equipment ?? []) { const t = String(e.tais_code ?? "").trim(); if (TAIS.test(t)) { if (!owners.has(t)) owners.set(t, []); owners.get(t).push(e); } }

const R = { A: [], B: [], other: [], child: [] };
for (const e of snap.equipment ?? []) {
  const raw = String(e.tais_code ?? "").trim();
  if (!raw || TAIS.test(raw)) continue;
  const fixed = fixOf(raw);
  const row = { id: e.id, product_code: e.product_code, 名前: e.name, 今: raw, 直した: fixed };
  if (e.parent_product_code) { R.child.push({ ...row, 理由: `用具マスタの子 (親 ${e.parent_product_code})。統合で扱う` }); continue; }
  if (!fixed || !TAIS.test(fixed)) { R.other.push({ ...row, 理由: "5桁-6桁 の形にならない (触らない)" }); continue; }
  const dup = (owners.get(fixed) ?? []).filter((x) => x.id !== e.id);
  if (!ceilTais.has(fixed)) R.B.push({ ...row, 理由: "直した TAIS が 上限マスタに無い" + (dup.length ? ` / 同じ TAIS の品目が既にある (${dup.map((x) => x.product_code).join(", ")})` : "") });
  else if (dup.length) R.B.push({ ...row, 理由: `同じ TAIS の品目が既にある (${dup.map((x) => x.product_code).join(", ")}) → 直すと重複 (統合の対象)` });
  else R.A.push(row);
}
console.log(`${snap.fetchedAt} / 用具マスタ ${(snap.equipment ?? []).length} 品目 / 上限マスタ (候補の TAIS) ${ceilTais.size} 種`);
for (const [k, t] of [["A", "直す (上限マスタに実在・重複なし)"], ["B", "★ 判断が要る (書かない)"], ["other", "形にならない (触らない)"], ["child", "用具マスタの子 (触らない)"]]) {
  console.log(`\n${k} ${t}: ${R[k].length}`);
  for (const x of R[k]) console.log(`  - ${JSON.stringify(x)}`);
}

if (!EXECUTE) {
  console.log(`\n書込みの見込み (承認後): equipment_master update ${R.A.length} 行 (tais_code)。--live --execute --expect ${R.A.length}`);
  console.log("DRY RUN — DB は書き換えていない");
  process.exit(0);
}
const expect = Number(opt("--expect"));
if (R.A.length !== expect) { console.error(`★ 直す件数 ${R.A.length} が --expect ${expect} と違う。止める (DRY RUN をやり直して確かめる)`); process.exit(2); }
const d = new Date();
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}-${String(d.getMilliseconds()).padStart(3, "0")}`;
const backup = join(HERE, `_backup_tais_fix_${stamp}.json`);
writeFileSync(backup, JSON.stringify({ taken_at: d.toISOString(), rows: R.A.map((x) => ({ id: x.id, product_code: x.product_code, tais_code: x.今 })) }, null, 2) + "\n");
console.log(`\n退避: ${backup}`);
let done = 0;
for (const x of R.A) {
  const res = await rest("PATCH", `equipment_master?id=eq.${x.id}&tais_code=eq.${encodeURIComponent(x.今)}`, { tais_code: x.直した });
  if (!Array.isArray(res) || res.length !== 1) { console.error(`★ ${x.product_code}: 更新件数が 1 でない (${Array.isArray(res) ? res.length : "?"})。ここで止める。済んだのは ${done} 件 (退避から戻せる)`); process.exit(1); }
  done++;
  console.log(`  ✓ ${x.product_code} ${x.今} → ${x.直した}`);
}
console.log(`\n完了: ${done} 件。確認: --live の DRY RUN で A が 0 になること`);
