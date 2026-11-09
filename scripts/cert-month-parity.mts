/**
 * check:cert-month-parity — 負担割合を月ごとに解決する純関数の検査 (DB なし・★ 0 を目指す検査)
 *
 *   npm run check:cert-month-parity
 *
 * ① 2 ファイルが同一
 *      正本 apps/order-app/lib/insurance/cert-month.ts
 *      写し apps/kaigo-app/src/lib/insurance/cert-month.ts   (片方だけ直すと乖離する → バイト比較で落とす)
 * ② 固定データで期待値
 *      ★ 期待値の根拠 = ほのぼのは「提供月に掛かる負担割合証」で給付率を出し分けている (2026-11-09 実測):
 *        ケアサポ 福祉用具 KDS0031 (処理 R8/4〜R8/9) で、8/1 に割合が変わる 17 名とも
 *        提供 7 月 = 旧い証 / 提供 8 月 = 新しい証 (最終的に)。月遅れ (関 貞雄: 提供 7 月を処理 R8/9) も旧い証の 70。
 *        石渡 増男 / 小山 勝治 は処理 R8/8 に 8 月を旧い 90 で出し、処理 R8/9 に新しい 80 で出し直している。
 *      柳樂 邦博型 (認定期間の途中の 8/1 で切替) / 認定をまたぐ証 / 証なし / 同着 / 月途中の切替 /
 *      給付制限 / 事業所の絞り込み / 認定行の選び方 (kaigo の規則) / 期限の印 / kaigo の copay 置き換え
 * ③ 負のコントロール: わざと壊した実装・データで ② が鳴ることを確かめる
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as M from "../lib/insurance/cert-month";
import type { BenefitCertRow, CertRowForBenefit } from "../lib/insurance/cert-month";
import * as KaigoCert from "../../kaigo-app/src/lib/cert-for-month";

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0, pass = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const eq = (name: string, got: unknown, want: unknown) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} / want ${JSON.stringify(want)}`);

// ── ① 2 ファイルが同一 ────────────────────────────────────────────────────
const A = join(HERE, "../lib/insurance/cert-month.ts");
const B = join(HERE, "../../kaigo-app/src/lib/insurance/cert-month.ts");
const same = (a: string, b: string) => readFileSync(a).equals(readFileSync(b));
console.log("① 2 ファイルが同一");
ok("order と kaigo の cert-month.ts がバイト単位で同じ", same(A, B), `${A} ≠ ${B}`);
// 負のコントロール: 1 バイト違えば鳴る比較であること
ok("[負のコントロール] 1 バイト違う内容は同一と判定しない", !Buffer.from(readFileSync(A).toString() + " ").equals(readFileSync(B)));

// ── ② 固定データ ──────────────────────────────────────────────────────────
const F = (kind: string, rate: number | null, from: string, to: string | null, extra: Partial<BenefitCertRow> = {}): BenefitCertRow =>
  ({ kind, benefit_rate: rate, valid_from: from, valid_to: to, ...extra });
const FUTAN = M.BENEFIT_CERT_KIND_FUTAN, SEIGEN = M.BENEFIT_CERT_KIND_SEIGEN;
const row = (start: string | null, end: string | null, x: Partial<CertRowForBenefit> = {}): CertRowForBenefit =>
  ({ certification_start_date: start, certification_end_date: end, effective_date: start, ...x });
type Case = { name: string; run: (impl: typeof M.resolveBenefitForMonth) => boolean };

const yagira = { rows: [row("2025-04-01", "2028-03-31", { copay_rate: "1", benefit_rate: "90" })],
  certs: [F(FUTAN, 90, "2025-08-01", "2026-07-31"), F(FUTAN, 80, "2026-08-01", "2027-07-31")] };
const cases: Case[] = [
  { name: "柳樂型: 提供 7 月は旧い証 90", run: (r) => { const x = r(yagira.rows, yagira.certs, "2026-07-01", "2026-07-31"); return x.benefitRate === 90 && x.source === "certificate" && x.copayWari === 1; } },
  { name: "柳樂型: 提供 8 月は新しい証 80 (認定行は 90 のまま)", run: (r) => { const x = r(yagira.rows, yagira.certs, "2026-08-01", "2026-08-31"); return x.benefitRate === 80 && x.copayWari === 2 && x.periodFrom === "2026-08-01"; } },
  { name: "柳樂型: 月遅れで後から出しても提供月の証 (処理月は関係ない)", run: (r) => r(yagira.rows, yagira.certs, "2026-07-01", "2026-07-31").benefitRate === 90 },
  { name: "認定をまたぐ証: 旧認定の月も新認定の月も同じ証 70", run: (r) => {
    const rows = [row("2024-03-01", "2026-02-28", { copay_rate: "1" }), row("2026-03-01", "2029-02-28", { copay_rate: "1" })];
    const certs = [F(FUTAN, 70, "2025-08-01", "2026-07-31")];
    return r(rows, certs, "2026-02-01", "2026-02-28").benefitRate === 70 && r(rows, certs, "2026-03-01", "2026-03-31").benefitRate === 70;
  } },
  { name: "証なし: 認定行の benefit_rate (80) + 警告 + source=cert_row", run: (r) => {
    const x = r([row("2026-01-01", null, { benefit_rate: "80", copay_rate: "1" })], [], "2026-08-01", "2026-08-31");
    return x.source === "cert_row" && x.benefitRate === 80 && x.warnings.some((w) => w.includes("負担割合証がありません")) && x.blockDensou === M.BLOCK_DENSOU_WITHOUT_BENEFIT_CERT;
  } },
  { name: "証なし: benefit_rate が無ければ copay_rate (割) から 2 割 → 80", run: (r) => r([row("2026-01-01", null, { copay_rate: "2" })], [], "2026-08-01", "2026-08-31").benefitRate === 80 },
  { name: "証なし・認定行の割合もなし: source=none", run: (r) => { const x = r([row("2026-01-01", null)], [], "2026-08-01", "2026-08-31"); return x.source === "none" && x.benefitRate === null; } },
  { name: "証の期間外 (月に掛からない) は使わない", run: (r) => r([row("2026-01-01", null, { copay_rate: "1" })], [F(FUTAN, 70, "2025-08-01", "2026-07-31")], "2026-08-01", "2026-08-31").source === "cert_row" },
  { name: "同着 (同じ開始日・同じ終了日で 90/80): 給付率の低い 80 + 警告", run: (r) => {
    const x = r([], [F(FUTAN, 90, "2026-08-01", "2027-07-31"), F(FUTAN, 80, "2026-08-01", "2027-07-31")], "2026-08-01", "2026-08-31");
    return x.benefitRate === 80 && x.warnings.some((w) => w.includes("同じ開始日"));
  } },
  { name: "同着 (同じ開始日・終了違い): 終了の遅いほう", run: (r) => r([], [F(FUTAN, 80, "2026-08-01", "2026-12-31"), F(FUTAN, 90, "2026-08-01", "2027-07-31")], "2026-09-01", "2026-09-30").benefitRate === 90 },
  { name: "同じ証が 2 行 (事業所違いの取込): 警告なし", run: (r) => { const x = r([], [F(FUTAN, 80, "2026-08-01", "2027-07-31", { office_id: "a" }), F(FUTAN, 80, "2026-08-01", "2027-07-31", { office_id: "b" })], "2026-08-01", "2026-08-31"); return x.benefitRate === 80 && x.warnings.length === 0; } },
  { name: "月の途中で切替: 開始が最新 (80) + splitInMonth + 警告", run: (r) => {
    const x = r([], [F(FUTAN, 90, "2025-08-16", "2026-08-15"), F(FUTAN, 80, "2026-08-16", "2027-08-15")], "2026-08-01", "2026-08-31");
    return x.benefitRate === 80 && x.splitInMonth && x.warnings.some((w) => w.includes("月の途中"));
  } },
  { name: "給付制限は別項目 (給付率は証のまま 90)", run: (r) => {
    const x = r([], [F(FUTAN, 90, "2026-08-01", "2027-07-31"), F(SEIGEN, 70, "2026-08-01", "2026-12-31", { restriction: "給付額の減額" })], "2026-09-01", "2026-09-30");
    return x.benefitRate === 90 && x.restriction?.benefitRate === 70 && x.restriction.content === "給付額の減額";
  } },
  { name: "事業所の絞り込み: officeId を渡すとその事業所の行だけ", run: (r) => {
    const certs = [F(FUTAN, 90, "2026-08-01", null, { office_id: "A" }), F(FUTAN, 70, "2026-08-01", null, { office_id: "B" })];
    return r([], certs, "2026-08-01", "2026-08-31", { officeId: "A" }).benefitRate === 90 && r([], certs, "2026-08-01", "2026-08-31", { officeId: "B" }).benefitRate === 70;
  } },
  { name: "期限なし (valid_to NULL) の証は以後ずっと有効", run: (r) => r([], [F(FUTAN, 70, "2020-08-01", null)], "2030-01-01", "2030-01-31").benefitRate === 70 },
];
console.log("② 固定データ (resolveBenefitForMonth)");
for (const c of cases) ok(c.name, c.run(M.resolveBenefitForMonth));

// pickCertForMonth (kaigo の規則)
console.log("② 固定データ (pickCertForMonth = kaigo src/lib/cert-for-month.ts と同じ規則)");
{
  const r1 = M.pickCertForMonth([row("2025-01-01", "2026-02-28", { id: "old" }), row("2026-03-01", "2029-02-28", { id: "new" })], "2026-03-01", "2026-03-31");
  eq("月に有効な行のうち開始が最新", r1?.row.id, "new");
  const r2 = M.pickCertForMonth([row("2026-03-01", null, { id: "blank" }), row("2026-03-01", null, { id: "full", copay_rate: "2" })], "2026-08-01", "2026-08-31");
  eq("同着は copay_rate が入っている行", r2?.row.id, "full");
  const r3 = M.pickCertForMonth([row("2020-01-01", "2021-01-31", { id: "a" }), row("2022-01-01", "2023-01-31", { id: "b" })], "2026-08-01", "2026-08-31");
  eq("該当なしは最新 1 件 + isFallback", [r3?.row.id, r3?.isFallback], ["b", true]);
  eq("行なしは null", M.pickCertForMonth([], "2026-08-01", "2026-08-31"), null);
}
// 変換
console.log("② 固定データ (変換)");
eq("copay '1' → 90", M.benefitRateFromCopay("1"), 90);
eq("copay '3' → 70", M.benefitRateFromCopay("3"), 70);
eq("copay 0.2 → 80", M.benefitRateFromCopay(0.2), 80);
eq("copay '0' → null (既定に倒さない)", M.benefitRateFromCopay("0"), null);
eq("給付率 80 → 2 割", M.copayWariFromBenefitRate(80), 2);
eq("給付率 '１００' (全角) → 100", M.parseBenefitRate("１００"), 100);
eq("給付率 101 → null", M.parseBenefitRate(101), null);
// 期限の印
console.log("② 固定データ (judgeBenefitCertAlert)");
eq("証が 1 枚も無い → missing", M.judgeBenefitCertAlert([], "2026-11-09").level, "missing");
eq("今日有効な証が無い → expired", M.judgeBenefitCertAlert([F(FUTAN, 90, "2025-08-01", "2026-07-31")], "2026-11-09").level, "expired");
eq("30 日以内に切れる・次なし → expiring (残 22 日)", (() => { const a = M.judgeBenefitCertAlert([F(FUTAN, 90, "2025-08-01", "2026-07-31")], "2026-07-09"); return [a.level, a.daysLeft]; })(), ["expiring", 22]);
eq("30 日以内に切れるが翌日からの証あり → ok", M.judgeBenefitCertAlert([F(FUTAN, 90, "2025-08-01", "2026-07-31"), F(FUTAN, 80, "2026-08-01", "2027-07-31")], "2026-07-09").level, "ok");
eq("31 日先 → ok", M.judgeBenefitCertAlert([F(FUTAN, 90, "2025-08-01", "2026-07-31")], "2026-06-30").level, "ok");
eq("給付制限だけ → missing (負担割合証ではない)", M.judgeBenefitCertAlert([F(SEIGEN, 70, "2026-01-01", null)], "2026-11-09").level, "missing");
// 止める切替は今は false
eq("BLOCK_DENSOU_WITHOUT_BENEFIT_CERT は今は false (user 合意 2026-11-09)", M.BLOCK_DENSOU_WITHOUT_BENEFIT_CERT, false);

// kaigo: cert-for-month.ts の copay 置き換え (applyBenefitCertsToCert)
console.log("② 固定データ (kaigo src/lib/cert-for-month.ts の copay_rate 置き換え)");
{
  const mk = (copay: string | null): KaigoCert.CertForMonth => ({
    insurer_number: null, insurer_name: null, insured_number: null, care_level: "要介護2", copay_rate: copay,
    certification_start_date: "2025-04-01", certification_end_date: "2028-03-31", certification_status: null, service_limit_amount: 19705,
    limit_period_start: null, limit_period_end: null, care_office_id: null, care_office_number: null, care_office_name: null,
    effective_date: "2025-04-01", isFallback: false,
  });
  const rows = [{ certification_start_date: "2025-04-01", certification_end_date: "2028-03-31", effective_date: "2025-04-01", copay_rate: "1", care_level: "要介護2", service_limit_amount: 19705 }];
  const c7 = mk("1"); KaigoCert.applyBenefitCertsToCert(c7, rows, yagira.certs, "2026-07-01", "2026-07-31");
  eq("7 月: 証 90 → copay '1' のまま", [c7.copay_rate, c7.benefit?.source], ["1", "certificate"]);
  const c8 = mk("1"); KaigoCert.applyBenefitCertsToCert(c8, rows, yagira.certs, "2026-08-01", "2026-08-31");
  eq("8 月: 証 80 → copay '2' (元 '1' を控える)", [c8.copay_rate, c8.copay_rate_cert_row], ["2", "1"]);
  const cn = mk("1"); KaigoCert.applyBenefitCertsToCert(cn, [{ ...rows[0], copay_rate: "1" }], [], "2026-08-01", "2026-08-31");
  eq("証なし: copay は認定行のまま (金額を動かさない)", [cn.copay_rate, cn.benefit?.source], ["1", "cert_row"]);
  const c100 = mk("1"); KaigoCert.applyBenefitCertsToCert(c100, rows, [F(FUTAN, 100, "2026-08-01", null)], "2026-08-01", "2026-08-31");
  eq("証 100 (0 割) は置き換えず警告", [c100.copay_rate, c100.benefit?.warnings.some((w) => w.includes("1〜3 割"))], ["1", true]);
}

// ── ③ 負のコントロール ───────────────────────────────────────────────────
console.log("③ 負のコントロール (壊した実装で ② が鳴るか)");
const brokenImpls: { name: string; impl: typeof M.resolveBenefitForMonth }[] = [
  { name: "開始が最古の証を採る", impl: (rows, certs, ms, me, o) => M.resolveBenefitForMonth(rows, certs.slice().sort((a, b) => ((a.valid_from ?? "") < (b.valid_from ?? "") ? -1 : 1)).map((c, i, arr) => (i === 0 ? c : { ...c, valid_from: arr[0].valid_from })), ms, me, o) },
  { name: "負担割合証を見ずに認定行だけ", impl: (rows, _certs, ms, me, o) => M.resolveBenefitForMonth(rows, [], ms, me, o) },
  { name: "処理月 (= 月末の翌月) で証を選ぶ", impl: (rows, certs, ms, me, o) => { const [y, m] = ms.split("-").map(Number); const n = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; return M.resolveBenefitForMonth(rows, certs, `${n}-01`, `${n}-28`, o); } },
  { name: "給付制限を給付率に混ぜる", impl: (rows, certs, ms, me, o) => M.resolveBenefitForMonth(rows, certs.map((c) => (c.kind === SEIGEN ? { ...c, kind: FUTAN, valid_from: "2026-08-02" } : c)), ms, me, o) },
];
for (const b of brokenImpls) {
  const caught = cases.filter((c) => { try { return !c.run(b.impl); } catch { return true; } }).length;
  ok(`[負のコントロール] 「${b.name}」は ② で ${caught} 件鳴る (1 件以上)`, caught > 0);
}

console.log(`\n${fail === 0 ? "✓ PASS" : "★ FAIL"} — ${pass} 件合格 / ${fail} 件失敗`);
process.exit(fail === 0 ? 0 : 1);
