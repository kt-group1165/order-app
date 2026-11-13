// 精度測定: 読み取り (claude.json) と照合結果 (match_result.json) を 正解 (gt.json) と比べる
// usage: node scripts/teikyohyo-fax/eval.mjs <claude.json> --gt <gt.json> --snapshot <snapshot.json> [--match <match_result.json>]
//   ★ 正解データ gt.json は個人情報 (目で読んだ氏名・番号) なので repo に入れない。--gt で外から渡す
import fs from "node:fs";
import { dirname, join } from "node:path";
const argOf = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const [READ] = process.argv.slice(2);
if (!READ || !argOf("--gt") || !argOf("--snapshot")) { console.error("usage: node eval.mjs <claude.json> --gt <gt.json> --snapshot <snapshot.json> [--match <match_result.json>]"); process.exit(1); }
const gt = JSON.parse(fs.readFileSync(argOf("--gt"), "utf8"));
const rd = JSON.parse(fs.readFileSync(READ, "utf8"));
const mr = JSON.parse(fs.readFileSync(argOf("--match") ?? join(dirname(READ), "match_result.json"), "utf8"));
const snap = JSON.parse(fs.readFileSync(argOf("--snapshot"), "utf8"));
const N = (s) => (s ?? "").normalize("NFKC").replace(/[\s　・]/g, "").replace(/様$/, "").replace(/[齋齊]/g, "斎");
const pages = new Map((rd.pages ?? rd).map((p) => [p.page, p]));

// 1) ページの種類
const want = {};
for (const [k, list] of Object.entries(gt.pages)) for (const p of list) want[p] = k;
const kindMap = { teikyo: "teikyo", beppyo: "beppyo", jisseki_back: "other", own_report: "other", blank: "blank" };
let kOk = 0, kTot = 0; const kNg = [];
for (const [p, k] of Object.entries(want)) {
  const got = pages.get(Number(p))?.kind; kTot++;
  const exp = kindMap[k];
  if (got === exp || (exp === "other" && got !== "teikyo" && got !== "beppyo" && got !== "blank")) kOk++; else kNg.push(`p${p}: 正=${k} 読=${got ?? "なし"}`);
}

// 2) 欄ごとの読み取り
const fields = ["insurer_no", "insured_no", "name", "care_level", "kyotaku", "cm", "gender", "birth"];
const f = Object.fromEntries(fields.map((k) => [k, { ok: 0, n: 0, ng: [] }]));
const unitsStat = { ok: 0, n: 0, ng: [] };
for (const g of gt.people) {
  const t = pages.get(g.teikyo_page)?.teikyo ?? {};
  const got = { insurer_no: t.insurer_no, insured_no: t.insured_no, name: t.name, care_level: t.care_level, kyotaku: t.kyotaku_name, cm: t.cm_name, gender: t.gender, birth: t.birth ?? null };
  for (const k of fields) {
    if (k === "birth" && g.birth == null) continue;
    f[k].n++;
    const a = N(String(got[k] ?? "")), b = N(String(g[k] ?? ""));
    const ok = k === "kyotaku" || k === "cm" ? a.replace(/株式会社|有限会社/g, "") === b.replace(/株式会社|有限会社/g, "") : a === b;
    if (ok) f[k].ok++; else f[k].ng.push(`${g.name}: 正=${g[k]} 読=${got[k] ?? "null"}`);
  }
  if (g.units) {
    const rows = g.beppyo_pages.flatMap((p) => pages.get(p)?.beppyo?.rows ?? []).filter((r) => N(r.office_no) === "1272400050" && /^\d{6}$/.test(N(r.service_code)));
    const num = (v) => { const n = Number(String(v ?? "").normalize("NFKC").replace(/[(),（）\s]/g, "")); return n > 0 ? n : null; };
    const got = rows.flatMap((r) => { const c = num(r.count) ?? 1; const u = num(r.units) ?? (num(r.service_units) ? Math.round(num(r.service_units) / c) : 0); return Array(c).fill(u); }).sort((a, b) => a - b);
    const exp = [...g.units].sort((a, b) => a - b);
    unitsStat.n++;
    if (JSON.stringify(got) === JSON.stringify(exp)) unitsStat.ok++; else unitsStat.ng.push(`${g.name}: 正=${exp} 読=${got}`);
  }
}

// 2b) 認定状態・給付率
const extra = { cert_status: { ok: 0, n: 0, ng: [] }, benefit_rate: { ok: 0, n: 0, ng: [] } };
for (const g of gt.people) {
  const t = pages.get(g.teikyo_page)?.teikyo ?? {};
  if (g.cert_status) { extra.cert_status.n++; const got = t.cert_status ?? null; if (got && got.startsWith("認定") === g.cert_status.startsWith("認定")) extra.cert_status.ok++; else extra.cert_status.ng.push(`${g.name}: 正=${g.cert_status} 読=${got}`); }
  if (g.benefit_rate != null) {
    extra.benefit_rate.n++;
    const rows = g.beppyo_pages.flatMap((p) => pages.get(p)?.beppyo?.rows ?? []).filter((r) => N(r.office_no) === "1272400050");
    const got = rows.map((r) => Number(r.benefit_rate)).find((x) => x > 0) ?? null;
    if (got === g.benefit_rate) extra.benefit_rate.ok++; else extra.benefit_rate.ng.push(`${g.name}: 正=${g.benefit_rate} 読=${got}`);
  }
}
// 3) 照合 (利用者の特定): 正解の人 = DB で (保険者, 被保番) が一致する人 (伏字は見えている桁 + 氏名で手で確定したもの)
const truthClient = (g) => {
  const re = new RegExp("^" + N(g.insured_no).replace(/●/g, ".") + "$");
  const hits = snap.clients.filter((c) => re.test(N(c.insured_number)) && (!g.insurer_no || N(c.insurer_number) === g.insurer_no || true));
  const byName = hits.filter((c) => { const a = N(g.name), b = N(c.name); let ok = 0, v = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] === "●") continue; v++; if (a[i] === b[i]) ok++; } return v && ok / v >= 0.6; });
  return (byName.length === 1 ? byName : hits.length === 1 ? hits : [])[0] ?? null;
};
const idStat = { 確定_正しい: 0, 確定_別人: 0, 要確認: 0, 該当なし: 0, 対象外: 0, DBに居ない: 0 };
const idRows = [];
for (const g of gt.people) {
  const truth = truthClient(g);
  const rec = mr.records.find((r) => r.pages.includes(g.teikyo_page));
  const v = rec?.verdict ?? "なし";
  let cls;
  if (!truth) cls = "DBに居ない";
  else if (v === "ok") cls = rec.client?.id === truth.id ? "確定_正しい" : "確定_別人";
  else cls = { check: "要確認", none: "該当なし", out: "対象外" }[v] ?? "該当なし";
  idStat[cls]++;
  idRows.push(`${cls.padEnd(6)} ${g.name} → ${rec?.client?.name ?? "-"} (DB正解 ${truth?.name ?? "なし"}) ${rec?.reason ?? ""}`);
}
// 4) 照合結果の食い違い (確定のもの)
const mism = mr.records.filter((r) => r.verdict === "ok").flatMap((r) => (r.checks ?? []).filter((c) => c.ok === false).map((c) => `${r.name}: ${c.item} FAX=${c.fax ?? c.fax_rows} DB=${c.db ?? c.db_rows}${c.db_only?.length ? " DBのみ=" + c.db_only.map((x) => x.name + ":" + x.units).join(",") : ""}`));

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + "%" : "-");
console.log(`■ ページ種類  ${kOk}/${kTot} (${pct(kOk, kTot)})`); kNg.forEach((x) => console.log("   ✗ " + x));
console.log("■ 欄ごとの読み取り (提供票 " + gt.people.length + " 名)");
for (const k of fields) { console.log(`   ${k.padEnd(11)} ${f[k].ok}/${f[k].n} (${pct(f[k].ok, f[k].n)})`); f[k].ng.forEach((x) => console.log("      ✗ " + x)); }
console.log(`   用具の単位数(別表) ${unitsStat.ok}/${unitsStat.n} (${pct(unitsStat.ok, unitsStat.n)})`); unitsStat.ng.forEach((x) => console.log("      ✗ " + x));
for (const [k, v] of Object.entries(extra)) { console.log(`   ${k.padEnd(11)} ${v.ok}/${v.n}`); v.ng.forEach((x) => console.log("      ✗ " + x)); }
console.log("■ 利用者の特定", JSON.stringify(idStat)); idRows.forEach((x) => console.log("   " + x));
console.log("■ 確定した人の項目の食い違い " + mism.length + " 件"); mism.forEach((x) => console.log("   " + x));
console.log("■ 費用", JSON.stringify(rd.summary ?? {}));
