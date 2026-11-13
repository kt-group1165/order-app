// 提供票 FAX 照合 (READ ONLY・DB に触らない): 読み取り JSON (claude.json) × 新システム DB の控え (snapshot.mjs が作る)
// usage: node scripts/teikyohyo-fax/match.mjs <claude.json> --snapshot <snapshot.json> [--out <match_result.json>] [--ym 2026-09]
//   出力: match_result.json と 一覧 match_result.csv (Excel 用 UTF-8 BOM) / match_result.html
//   ★ 照合ロジックは ★福祉用具新ソフト セッションが作成 (2026-11-13)。判定は 3 段階 (✅確定 / ⚠要確認 / ❌該当なし) + 対象外
import fs from "node:fs";
import { dirname, join } from "node:path";
import { faxOffice } from "./_office.mjs";

const argOf = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const SRC = process.argv[2];
const YM = argOf("--ym");
const SNAP = argOf("--snapshot");
if (!SRC || !SNAP) { console.error("usage: node match.mjs <claude.json> --snapshot <snapshot.json> [--out <match_result.json>] [--ym YYYY-MM]"); process.exit(1); }
const OUTF = argOf("--out") ?? join(dirname(SRC), "match_result.json");
const snap = JSON.parse(fs.readFileSync(SNAP, "utf8"));
const doc = JSON.parse(fs.readFileSync(SRC, "utf8"));
// 対象の事業所 (--area / --office-bn。既定 ケアサポ 1272400050 = 引数化の前と同じ)
const FO = faxOffice(process.argv.slice(2));
const CS_NO = FO.bn;
const OFFICE_NAME_RE = FO.isDefault ? /サポート/ : FO.nameRe;
// 控え (snapshot.mjs) が別の事業所で取ったものなら止める (office の記録が無い古い控えは ケアサポで取ったもの)
const snapBn = snap.office?.bn ?? "1272400050";
if (snapBn !== FO.bn) { console.error(`★ 控え ${SNAP} は ${snap.office?.area ?? "ケアサポ"} (${snapBn}) のもの。照合の事業所 ${FO.area} (${FO.bn}) と違うので止める (snapshot.mjs に同じ --area を付けて取り直す)`); process.exit(1); }

// ---- 判定の閾値 (出力にも書く) ----
const TH = {
  nameSim: 0.6,      // 氏名 (見えている文字) の一致率の下限
  margin: 0.15,      // 1 位と 2 位の総合点の差の下限
  minScore: 0.55,    // これ未満は「該当なし」
};

// ---- 正規化 ----
const MASK = "●";
const nfkc = (s) => (s ?? "").normalize("NFKC");
const normName = (s) => nfkc(s).replace(/[\s　・]/g, "").replace(/様$/, "")
  .replace(/[髙]/g, "高").replace(/[﨑]/g, "崎").replace(/[邊邉]/g, "辺").replace(/[齋齊]/g, "斎").replace(/[澤]/g, "沢").replace(/[濱]/g, "浜");
const normKana = (s) => nfkc(s).replace(/[\s　・]/g, "").replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const normDigits = (s) => nfkc(s).replace(/[^0-9●]/g, "").replace(/○|〇/g, MASK);
const normOffice = (s) => nfkc(s).replace(/[\s　・()（）株式会社有限会社]/g, "");

// ● を含む文字列 a と b の一致率 (見えている文字だけで比べる。長さ違いは編集距離で)
function maskSim(a, b) {
  if (!a || !b) return 0;
  if (a.length === b.length) {
    let vis = 0, ok = 0;
    for (let i = 0; i < a.length; i++) { if (a[i] === MASK) continue; vis++; if (a[i] === b[i]) ok++; }
    return vis ? ok / vis : 0;
  }
  // 長さが違う: 編集距離 (● はどの文字とも一致)
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] || a[i - 1] === MASK ? 0 : 1));
  return Math.max(0, 1 - d[m][n] / Math.max(m, n));
}
const digitsMatch = (pat, val) => { // pat に ● 可。桁数も含めて一致すること
  if (!pat || !val) return null;
  const p = normDigits(pat), v = normDigits(val);
  if (p.length !== v.length) return false;
  for (let i = 0; i < p.length; i++) if (p[i] !== MASK && p[i] !== v[i]) return false;
  return true;
};
const visibleCount = (s) => [...(s ?? "")].filter((c) => c !== MASK).length;

// ---- DB の索引 ----
const certsByClient = new Map();
for (const r of snap.certs) { if (!certsByClient.has(r.client_id)) certsByClient.set(r.client_id, []); certsByClient.get(r.client_id).push(r); }
const careOfficeById = new Map(snap.care_offices.map((o) => [o.id, o]));
const cmById = new Map(snap.care_managers.map((m) => [m.id, m]));
const assigned = new Set(snap.assign.filter((a) => !a.end_date).map((a) => a.client_id));
const ordersByClient = new Map();
for (const o of snap.orders) { if (!ordersByClient.has(o.client_id)) ordersByClient.set(o.client_id, []); ordersByClient.get(o.client_id).push(o); }
const itemsByOrder = new Map();
for (const it of snap.items) { if (!itemsByOrder.has(it.order_id)) itemsByOrder.set(it.order_id, []); itemsByOrder.get(it.order_id).push(it); }
const eqByCode = new Map(snap.equipment.map((e) => [e.product_code, e]));
const benefitByClient = new Map();
for (const b of snap.benefit ?? []) { if (!benefitByClient.has(b.client_id)) benefitByClient.set(b.client_id, []); benefitByClient.get(b.client_id).push(b); }
const certRateById = new Map((snap.certRates ?? []).map((r) => [r.id, r]));
const clientRateById = new Map((snap.clientRates ?? []).map((r) => [r.id, r]));
const rateNum = (v) => { const m = nfkc(String(v ?? "")).match(/(\d+)/); return m ? Number(m[1]) : null; };
// 対象月の給付率 (負担割合証 > 認定 > 利用者マスタ の順)。order-app の resolveBenefitForMonth と同じ優先順
function benefitRateForMonth(clientId, ym, cert) {
  const first = `${ym}-01`, last = `${ym}-31`;
  const bc = (benefitByClient.get(clientId) ?? []).filter((b) => (b.kind ?? "負担割合") !== "給付制限" && (b.valid_from ?? "0000") <= last && (b.valid_to ?? "9999") >= first)
    .sort((a, b) => (b.valid_from ?? "").localeCompare(a.valid_from ?? ""))[0];
  if (bc && rateNum(bc.benefit_rate) != null) return { rate: rateNum(bc.benefit_rate), src: "負担割合証" };
  const cr = cert ? certRateById.get(cert.id) : null;
  if (cr && rateNum(cr.benefit_rate) != null) return { rate: rateNum(cr.benefit_rate), src: "認定" };
  const cl = clientRateById.get(clientId);
  if (cl && rateNum(cl.benefit_rate) != null) return { rate: rateNum(cl.benefit_rate), src: "利用者マスタ" };
  return { rate: null, src: null };
}

// 対象月に有効な認定 (ケアサポの行。無ければ clients の列)
function certForMonth(clientId, ym) {
  const first = `${ym}-01`, last = `${ym}-31`;
  const rows = (certsByClient.get(clientId) ?? []).filter((r) => (r.certification_start_date ?? "0000") <= last && (r.certification_end_date ?? "9999") >= first);
  rows.sort((a, b) => (b.effective_date ?? b.certification_start_date ?? "").localeCompare(a.effective_date ?? a.certification_start_date ?? ""));
  return rows[0] ?? null;
}
// 対象月に貸与中の用具 (ケアサポの発注)
function rentalsForMonth(clientId, ym) {
  const first = `${ym}-01`, last = `${ym}-31`, out = [];
  for (const o of ordersByClient.get(clientId) ?? []) for (const it of itemsByOrder.get(o.id) ?? []) {
    if (!it.rental_start_date || it.rental_start_date > last) continue;
    if (it.rental_end_date && it.rental_end_date < first) continue;
    if (["cancelled", "canceled"].includes(it.status)) continue;
    if (/自費/.test(o.payment_type ?? "")) continue; // 自費は提供票に載らない
    const eq = eqByCode.get(it.product_code);
    const tais = eq?.tais_code ?? (/^\d{5}-\d{6}$/.test(it.product_code) ? it.product_code : null);
    for (let q = 0; q < (it.quantity || 1); q++)
      out.push({ item_id: it.id, product_code: it.product_code, tais, name: eq?.name ?? null, units: eq?.rental_price != null ? Math.round(eq.rental_price / 10) : null, payment_type: o.payment_type, start: it.rental_start_date, end: it.rental_end_date });
  }
  return out;
}


// 伏字入りの生年月日 (例「昭13年●●月15日」「●●年2月6日」) を、見えている部分 (元号+年・月・日) だけで比べる
const ERA = { 明: 1867, 大: 1911, 昭: 1925, 平: 1988, 令: 2018 };
function birthVisibleMatch(raw, iso) {
  const s = nfkc(raw).replace(/〇|○/g, MASK);
  const m = s.match(/(明|大|昭|平|令)?\D*?([0-9●]{1,2})年([0-9●]{1,2})月([0-9●]{1,2})日/);
  if (!m) return null;
  const [y, mo, d] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)].map(Number);
  let seen = 0;
  if (m[1] && /^\d+$/.test(m[2])) { seen++; if (ERA[m[1]] + Number(m[2]) !== y) return false; }
  if (/^\d+$/.test(m[3])) { seen++; if (Number(m[3]) !== mo) return false; }
  if (/^\d+$/.test(m[4])) { seen++; if (Number(m[4]) !== d) return false; }
  return seen >= 2 ? true : null; // 見えている部分が 2 つ以上一致したら一致とみなす
}

// ---- 利用者の特定 (3 段階) ----
function identify(t) {
  const ins = normDigits(t.insurer_no), insd = normDigits(t.insured_no);
  const nm = normName(t.name), kn = normKana(t.kana);
  const masked = insd.includes(MASK);
  const scored = [];
  for (const c of snap.clients) {
    const certs = certsByClient.get(c.id) ?? [];
    const pairs = [[c.insurer_number, c.insured_number], ...certs.map((r) => [r.insurer_number, r.insured_number])];
    const numHit = pairs.some(([a, b]) => (!ins || normDigits(a) === ins) && digitsMatch(insd, b));
    const nameS = Math.max(maskSim(nm, normName(c.name)), kn ? maskSim(kn, normKana(c.furigana)) : 0);
    if (!numHit && nameS < TH.nameSim) continue;
    let birthOk = null;
    if (t.birth && c.birth_date) birthOk = t.birth === c.birth_date;
    else if (t.birth_raw && c.birth_date) birthOk = birthVisibleMatch(t.birth_raw, c.birth_date);
    const genderOk = t.gender && c.gender ? nfkc(c.gender).startsWith(t.gender) : null;
    // 総合点: 番号 0.5 (伏字なら見えている桁の比率で割引) + 氏名 0.3 + 生年月日 0.15 + 性別 0.05
    const numW = numHit ? (masked ? 0.5 * visibleCount(insd) / insd.length : 0.5) : 0;
    const score = numW + 0.3 * nameS + (birthOk === true ? 0.15 : 0) + (genderOk === true ? 0.05 : 0) - (birthOk === false ? 0.2 : 0);
    scored.push({ c, numHit, nameS, birthOk, genderOk, score, isCS: assigned.has(c.id) || ordersByClient.has(c.id) });
  }
  scored.sort((a, b) => b.score - a.score);
  const [b1, b2] = scored;
  const cand = scored.slice(0, 3).map((s) => ({ id: s.c.id, name: s.c.name, birth: s.c.birth_date, score: +s.score.toFixed(2), num: s.numHit, nameS: +s.nameS.toFixed(2), birth_ok: s.birthOk, cs: s.isCS }));
  if (!b1 || b1.score < TH.minScore) return { verdict: "none", reason: "番号・氏名とも十分に近い利用者がいない", cand };
  const ambiguous = b2 && b1.score - b2.score < TH.margin;
  const strong = b1.numHit && !masked && (b1.nameS >= TH.nameSim || b1.birthOk === true);
  const strongMasked = b1.numHit && masked && b1.nameS >= TH.nameSim && b1.birthOk === true && !ambiguous;
  if ((strong || strongMasked) && !ambiguous && b1.birthOk !== false) return { verdict: "ok", client: b1.c, cand };
  const why = [];
  if (!b1.numHit) why.push("番号が一致しない (氏名だけで近い)");
  if (b1.numHit && b1.nameS < TH.nameSim) why.push(`番号は ${b1.c.name} さんだが記載氏名は「${t.name}」`);
  if (masked && !strongMasked) why.push("番号に伏字があり、氏名と生年月日で絞り切れない");
  if (b1.birthOk === false) why.push("生年月日が違う");
  if (ambiguous) why.push(`候補が近い (${b1.c.name} / ${b2.c.name})`);
  return { verdict: "check", reason: why.join(" / "), client: b1.c, cand };
}

// ---- 項目の照合 ----
function compare(c, t, bRows, ym) {
  const res = [];
  const cert = certForMonth(c.id, ym);
  const lvlDb = nfkc(cert?.care_level ?? c.care_level ?? "");
  const lvlFax = nfkc(t.care_level ?? "");
  res.push({ item: "要介護度", fax: t.care_level, db: cert?.care_level ?? c.care_level, ok: lvlFax && lvlDb ? lvlFax.replace(/\s/g, "") === lvlDb.replace(/\s/g, "") : null });
  const coId = cert?.care_office_id ?? c.care_office_id;
  const co = coId ? careOfficeById.get(coId) : null;
  // 居宅: 委託元 (認定の担当居宅) か 委託先 (担当ケアマネの所属居宅) の どちらかと合えば一致
  const cmRow = c.care_manager_id ? cmById.get(c.care_manager_id) : null;
  const co2 = cmRow?.care_office_id ? careOfficeById.get(cmRow.care_office_id) : null;
  const strip = (s) => normOffice(s).replace(/^予防/, "").replace(/ＫＴ|KT/g, "KT");
  const simA = co && t.kyotaku_name ? maskSim(strip(t.kyotaku_name), strip(co.name)) : 0;
  const simB = co2 && t.kyotaku_name ? maskSim(strip(t.kyotaku_name), strip(co2.name)) : 0;
  const kySim = Math.max(simA, simB);
  res.push({ item: "居宅", fax: t.kyotaku_name, db: co?.name ?? null, db_itakusaki: co2?.name ?? null,
    via: simB > simA ? "委託先(担当ケアマネの所属)" : "認定の担当居宅", ok: (co || co2) && t.kyotaku_name ? kySim >= 0.6 : null, sim: +kySim.toFixed(2) });
  const cmDb = (c.care_manager_id && cmById.get(c.care_manager_id)?.name) || c.care_manager || null;
  const cmSim = cmDb && t.cm_name ? maskSim(normName(t.cm_name), normName(cmDb)) : 0;
  res.push({ item: "ケアマネ", fax: t.cm_name, db: cmDb, ok: cmDb && t.cm_name ? cmSim >= 0.6 : null, sim: +cmSim.toFixed(2) });
  // 認定状態: 提供票左上の 認定済・申請中 (丸の付いたほう) と DB の対象月の認定の状態
  const stFax = t.cert_status ? (/申請/.test(nfkc(t.cert_status)) ? "申請中" : /認定/.test(nfkc(t.cert_status)) ? "認定済み" : null) : null;
  const stDbRaw = cert?.certification_status ?? null;
  const stDb = stDbRaw ? (/申請/.test(stDbRaw) ? "申請中" : /認定/.test(stDbRaw) ? "認定済み" : stDbRaw) : null;
  res.push({ item: "認定状態", fax: stFax, db: stDb, ok: stFax && stDb ? stFax === stDb : null,
    note: stFax === "申請中" && stDb === "認定済み" ? "提供票は申請中。新しい認定 (更新・区分変更) の結果待ちの可能性" : undefined });
  // 負担割合: 別表のケアサポ合計行 (予) 福祉用具合計) の 給付率 と DB の対象月の給付率
  const csTotal = (bRows ?? []).find((r) => normDigits(r.office_no) === CS_NO && rateNum(r.benefit_rate ?? r.kyufu_rate) != null);
  const faxRate = csTotal ? rateNum(csTotal.benefit_rate ?? csTotal.kyufu_rate) : rateNum(t.benefit_rate);
  const br = benefitRateForMonth(c.id, ym, cert);
  if (/^H/i.test(nfkc(t.insured_no ?? "")) && br.rate === 0) {
    // 生保単独 (H 番号・介護扶助): 請求は 保険 0%・公費 100%。居宅のソフトは 90% + 公費 10% と印字することがあるので、利用者負担 0 円 で判定
    const burden = csTotal ? Number(nfkc(String(csTotal.user_burden ?? "")).replace(/[^0-9]/g, "")) : NaN;
    res.push({ item: "負担割合", fax: `給付率${faxRate ?? "?"}% / 利用者負担 ${Number.isFinite(burden) ? burden : "?"}円`, db: "生保単独 (保険0%・公費100%)", ok: Number.isFinite(burden) ? burden === 0 : null, note: "H 番号 = 生保単独。本人負担 0 なら一致" });
  } else
  res.push({ item: "負担割合", fax: faxRate != null ? `給付率${faxRate}% (${(100 - faxRate) / 10}割)` : null, db: br.rate != null ? `給付率${br.rate}% (${(100 - br.rate) / 10}割・${br.src})` : null,
    ok: faxRate != null && br.rate != null ? faxRate === br.rate : null });
  // 用具: 別表のケアサポの行 (合計行を除く) と 貸与中の品目
  const rentAll = rentalsForMonth(c.id, ym);
  const rent = rentAll.filter((x) => x.tais); // TAIS の無い品目 (自費の付属など) は提供票に載らないので比べない
  const noTais = rentAll.filter((x) => !x.tais).map((x) => x.name);
  const toNum = (v) => { const n = Number(nfkc(String(v ?? "")).replace(/[(),（）\s]/g, "")); return Number.isFinite(n) && n > 0 ? n : null; };
  const fx = (bRows ?? []).filter((r) => normDigits(r.office_no) === CS_NO && r.service_code && /^\d{6}$/.test(nfkc(r.service_code)))
    .flatMap((r) => { const cnt = toNum(r.count) ?? 1; const u = toNum(r.units) ?? (toNum(r.service_units) ? Math.round(toNum(r.service_units) / cnt) : null);
      return Array.from({ length: cnt }, () => ({ ...r, units: u, count: 1 })); });
  const used = new Set(), pairs = [];
  for (const r of fx) {
    let k = rent.findIndex((x, i) => !used.has(i) && r.tais && x.tais === nfkc(r.tais));
    if (k < 0) k = rent.findIndex((x, i) => !used.has(i) && x.units === Number(r.units));
    if (k >= 0) used.add(k);
    pairs.push({ fax: { code: r.service_code, tais: r.tais, units: r.units, count: r.count, name: r.service_name }, db: k >= 0 ? rent[k] : null });
  }
  const dbOnly = rent.filter((_, i) => !used.has(i));
  if (!bRows.length) { res.push({ item: "用具・単位数", ok: null, note: "別表が無い (照合できない)", db_rows: rent.length }); return res; }
  const unitsOk = pairs.every((p) => p.db && p.db.units === Number(p.fax.units));
  res.push({ item: "用具・単位数", ok: fx.length ? pairs.length === rent.length && unitsOk && !dbOnly.length : (rent.length ? false : null),
    fax_rows: fx.length, db_rows: rent.length, pairs: pairs.map((p) => ({ fax: p.fax, db: p.db && { tais: p.db.tais, name: p.db.name, units: p.db.units } })), db_only: dbOnly.map((x) => ({ tais: x.tais, name: x.name, units: x.units })), skipped_no_tais: noTais });
  return res;
}

// ---- ページをまとめる: 提供票の後ろに続く別表を同じ人とする (氏名で確認) ----
const pages = doc.pages ?? doc;
const docs = [];
for (const p of pages) {
  if (p.kind === "teikyo") docs.push({ teikyo: p, beppyo: [] });
  else if (p.kind === "beppyo") {
    const last = docs[docs.length - 1];
    const sim = last ? maskSim(normName(p.beppyo?.name), normName(last.teikyo.teikyo?.name)) : 0;
    if (last && (sim >= 0.5 || !p.beppyo?.name)) last.beppyo.push(p);
    else docs.push({ teikyo: null, beppyo: [p] });
  }
}
const out = [];
for (const d of docs) {
  const t = d.teikyo?.teikyo ?? null;
  const ym = YM ?? t?.ym ?? d.beppyo[0]?.beppyo?.ym;
  const bRows = d.beppyo.flatMap((p) => p.beppyo?.rows ?? []);
  const hasCS = bRows.some((r) => normDigits(r.office_no) === CS_NO) || (t?.rows ?? []).some((r) => OFFICE_NAME_RE.test(nfkc(r.office)));
  const rec = { pages: [d.teikyo?.page, ...d.beppyo.map((p) => p.page)].filter(Boolean), name: t?.name ?? d.beppyo[0]?.beppyo?.name, ym };
  if (!hasCS) { out.push({ ...rec, verdict: "out", reason: `${FO.area}の行が無い (宛先違いの可能性)` }); continue; }
  if (!t) {
    const bt = d.beppyo[0]?.beppyo ?? {};
    const id = identify({ name: bt.name, insured_no: bt.insured_no, insurer_no: null });
    out.push({ ...rec, verdict: id.verdict === "ok" ? "check" : id.verdict, reason: "提供票が無く別表だけ。" + (id.reason ?? ""), cand: id.cand });
    continue;
  }
  const id = identify(t);
  const r = { ...rec, verdict: id.verdict, reason: id.reason, cand: id.cand };
  if (id.client) { r.client = { id: id.client.id, name: id.client.name, user_number: id.client.user_number }; r.checks = compare(id.client, t, bRows, ym); }
  out.push(r);
}
const cnt = (v) => out.filter((x) => x.verdict === v).length;
const ngItems = out.filter((x) => x.verdict === "ok").flatMap((x) => x.checks.filter((c) => c.ok === false).map((c) => c.item));
const result = { thresholds: TH, source: SRC, snapshotAt: snap.takenAt, counts: { 確定: cnt("ok"), 要確認: cnt("check"), 該当なし: cnt("none"), 対象外: cnt("out") }, mismatches: ngItems.reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {}), records: out };
fs.writeFileSync(OUTF, JSON.stringify(result, null, 1));
writeList(result, OUTF.replace(/\.json$/, ""));
console.log(JSON.stringify({ counts: result.counts, mismatches: result.mismatches }, null, 1));
for (const r of out) {
  const mark = { ok: "✅", check: "⚠", none: "❌", out: "－" }[r.verdict];
  const ng = (r.checks ?? []).filter((c) => c.ok === false).map((c) => `${c.item}: FAX=${c.fax ?? c.fax_rows} / DB=${c.db ?? c.db_rows}`);
  console.log(`${mark} p${r.pages.join(",")} ${r.name ?? ""} → ${r.client?.name ?? ""} ${r.reason ?? ""} ${ng.length ? "| 食い違い " + ng.join(" ; ") : ""}`);
}

// ---- 一覧 (CSV / HTML) ----
function writeList(result, base) {
  const MARK = { ok: "✅ 確定", check: "⚠ 要確認", none: "❌ 該当なし", out: "－ 対象外" };
  const rows = result.records.map((r) => {
    const ng = (r.checks ?? []).filter((c) => c.ok === false);
    const unk = (r.checks ?? []).filter((c) => c.ok === null).map((c) => c.item);
    return {
      判定: MARK[r.verdict] ?? r.verdict, ページ: r.pages.join(","), 提供月: r.ym ?? "", FAXの氏名: r.name ?? "",
      DBの利用者: r.client ? `${r.client.name} (${r.client.user_number ?? ""})` : "", 理由: r.reason ?? "",
      食い違い: ng.map((c) => `${c.item}: FAX=${c.fax ?? c.fax_rows ?? ""} / DB=${c.db ?? c.db_rows ?? ""}${c.note ? ` (${c.note})` : ""}`).join(" ; "),
      判定できない項目: unk.join(","),
    };
  });
  const cols = Object.keys(rows[0] ?? { 判定: "" });
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  fs.writeFileSync(`${base}.csv`, "\ufeff" + [cols.map(esc).join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\r\n"));
  const h = (v) => String(v ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const th = result.thresholds ? Object.entries(result.thresholds).map(([k, v]) => `${k}=${v}`).join(" / ") : "";
  fs.writeFileSync(`${base}.html`, `<!doctype html><meta charset="utf-8"><title>提供票FAX 照合</title>
<style>body{font-family:sans-serif;margin:16px}table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #ccc;padding:4px 6px;vertical-align:top}th{background:#f3f3f3}.ng{color:#b00}</style>
<h1>提供票 FAX 照合</h1><p>${h(result.source)} / DB 控え ${h(result.snapshotAt)} / ${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join("・")}</p>
<p>閾値: ${h(th)}</p>
<table><tr>${cols.map((c) => `<th>${h(c)}</th>`).join("")}</tr>
${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c === "食い違い" && r[c] ? "ng" : ""}">${h(r[c])}</td>`).join("")}</tr>`).join("\n")}
</table>`);
  console.log(`一覧: ${base}.csv / ${base}.html`);
}
