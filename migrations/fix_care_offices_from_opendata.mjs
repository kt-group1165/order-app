/**
 * 居宅マスタ (care_offices。kaigo-app と共有) を 介護サービス情報公表のオープンデータ (care_offices_opendata) で直す案 — ★ DRY RUN 専用
 * (2026-11-13。誉田の受け入れで「居宅を名前で引いた番号」と「KDS の居宅番号」が食い違った件から)
 *
 *   node migrations/fix_care_offices_from_opendata.mjs --db-cache <json>
 *     json = { fetchedAt, careOffices: [{id,name,office_number}], opendata: [{office_number,name,address,corp_name,service_type}],
 *              refs: { <care_office_id>: { clients, certClients } } (任意・件数の表示だけ) }
 *
 * 出す案:
 *   A 番号が空の行に、オープンデータの番号を入れる … 名前 (法人名・空白・中黒を除く) がオープンデータの 1 件と一致し、その番号を ほかの行が使っていないもの
 *   B オープンデータの番号で 行を足す … --add <番号,…> で指定した番号 (KDS に出たが care_offices に無い番号) のうち オープンデータにあるもの
 *   C 判断が要る … 名前の一致が複数・その番号を別の行が使用中 (「予防〜」の行 等)・名前と番号の組がオープンデータと違う行
 *     ★ オープンデータは 居宅介護支援だけ。12001… / 12005… のような 予防支援 (包括) の番号は載っていないので「オープンデータに無い」に出る
 * ★ DB は読まない・書かない。--execute は未実装 (care_offices は kaigo-app と共有。user の承認のあとで足す)。
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (argv.includes("--execute")) { console.error("★ --execute は未実装 (DRY RUN 専用)。care_offices は kaigo-app と共有なので user の承認のあとで足す"); process.exit(1); }
const CACHE = opt("--db-cache");
if (!CACHE) { console.error("usage: node migrations/fix_care_offices_from_opendata.mjs --db-cache <json> [--add 1270502113,1270400078]"); process.exit(1); }
const ADD = (opt("--add") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const nf = (s) => String(s ?? "").normalize("NFKC").trim();
const norm = (s) => nf(s).replace(/(株式会社|有限会社|合同会社|一般社団法人|社会福祉法人|医療法人社団|医療法人|特定非営利活動法人|NPO法人|\(株\)|\(有\))/g, "").replace(/[\s・･\-ー‐]/g, "");
const od = snap.opendata ?? [];
const odByName = new Map(); for (const r of od) { const k = norm(r.name); if (!odByName.has(k)) odByName.set(k, []); odByName.get(k).push(r); }
const odByNo = new Map(od.map((r) => [nf(r.office_number), r]));
const used = new Map(); for (const c of snap.careOffices) if (nf(c.office_number)) used.set(nf(c.office_number), c);
const refs = (id) => snap.refs?.[id] ? ` (clients ${snap.refs[id].clients} / 認定の人 ${snap.refs[id].certClients})` : "";

const R = { A: [], B: [], C: [] };
for (const c of snap.careOffices) {
  const no = nf(c.office_number);
  if (no) {
    const o = odByNo.get(no);
    const byName = odByName.get(norm(c.name)) ?? [];
    if (o && norm(o.name) !== norm(c.name) && byName.length === 1 && nf(byName[0].office_number) !== no)
      R.C.push(`名前と番号の組がオープンデータと違う: ${c.name} ${no}${refs(c.id)} / オープンデータ: ${no}=${o.name}・「${c.name}」=${byName[0].office_number}`);
    else if (!o && byName.length === 1 && nf(byName[0].office_number) !== no)
      R.C.push(`この番号はオープンデータに無く、同じ名前の事業所は別の番号: ${c.name} ${no}${refs(c.id)} / オープンデータ: ${byName[0].office_number} ${byName[0].name} ${byName[0].address ?? ""} (${byName[0].corp_name ?? ""}) → 番号の付け替え・旧番号・名前の付け違いのどれか`);
    continue;
  }
  const hit = odByName.get(norm(c.name)) ?? [];
  if (hit.length !== 1) { R.C.push(`番号が空・名前の一致 ${hit.length} 件: ${c.name}${refs(c.id)}`); continue; }
  const n = nf(hit[0].office_number);
  if (used.has(n)) { R.C.push(`番号が空・その番号 ${n} は別の行「${used.get(n).name}」が使用中: ${c.name}${refs(c.id)}`); continue; }
  R.A.push({ id: c.id, 名前: c.name, 入れる番号: n, オープンデータ: `${hit[0].name} ${hit[0].address ?? ""} (${hit[0].corp_name ?? ""})`, 件数: refs(c.id).trim() });
}
for (const n of ADD) {
  if (used.has(n)) { R.C.push(`--add ${n} は既に care_offices にある (${used.get(n).name})`); continue; }
  const fill = R.A.find((x) => x.入れる番号 === n);
  if (fill) { R.C.push(`--add ${n} は A で 番号が空の行「${fill.名前}」に入れるので 足さない`); continue; }
  const o = odByNo.get(n);
  if (!o) { R.C.push(`--add ${n} はオープンデータ (居宅介護支援) に無い → 足さない (別サービスの番号・書き違いの可能性)`); continue; }
  R.B.push({ 番号: n, 名前: o.name, 住所: o.address, 法人: o.corp_name });
}
console.log(`控え ${snap.fetchedAt} / care_offices ${snap.careOffices.length} 行 (番号が空 ${snap.careOffices.filter((c) => !nf(c.office_number)).length}) / オープンデータ ${od.length} 件`);
for (const [k, t] of [["A", "番号が空の行に番号を入れる"], ["B", "行を足す"], ["C", "★ 判断が要る (触らない)"]]) {
  console.log(`\n${k} ${t}: ${R[k].length}`);
  for (const x of R[k]) console.log(`  - ${typeof x === "string" ? x : JSON.stringify(x)}`);
}
console.log(`\n書込みの見込み (承認後): care_offices update ${R.A.length} 行 (office_number) / insert ${R.B.length} 行`);
console.log("DRY RUN — DB は読んでいない・書き換えていない (--execute は未実装)");
