/**
 * check:month-ready (order-app・福祉用具 ケアサポ) — その月の伝送を出す前に「材料が揃っているか」を並べる診断 (★ READ ONLY)
 *
 *   npm run check:month-ready -- --month 2026-11 [--refresh]
 *
 * ★ gate ではなく診断。基準値方式にもしない (check:all には入れない)。毎月 伝送の前に人が読む。
 *   常に exit 0 (読めない材料があれば ✗ と理由を出す)。
 *
 * 見るもの (2026-11-13 の 11 月 = 月途中の調査で「データ待ち」だったもの):
 *   ① 提供票   用具貸与期間_* /提供票_YYYYMM.csv の有無・実績行数・最終の印の日の分布 (末日まで = 確定 / それ以外が多い = 月途中)
 *   ② CM 指示  fukuyogu_cm_units の入力人数 / 請求対象人数 (未入力の人は請求画面で伝送から外れる)
 *   ③ 公費     その月にかかる公費 (生保の介護券は月 1 行) の人数 / 公費単独 (被保番 H) の人数 → 欠け
 *   ④ 認定     その月に認定がかかっていない or 申請中 で 月遅れになる請求対象の人数 / ほのぼの利用者マスタの最新出力日
 *   ⑤ 負担割合証 証が無く認定行の割合で請求する人数 (check:futan-period と同じ resolveBenefitForMonth の数え方)
 *   ⑥ 日割り表 order_item_proration が適用済みか
 *   最後に「伝送してよい / 待つべき理由」
 *
 * 請求対象・月遅れ・公費の選び方は scripts/_honobono-sync-core.mts の buildBillingModel (BillingTab の写し。honobono-diff と同じ)。
 * DB の全件読みは OS の一時フォルダに控える (月ごと。--refresh で読み直す)。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TENANT, loadSnapshot, loadLibs, buildBillingModel, readEnv } from "./_honobono-sync-core.mjs";
import { serviceClient, loadCertRows, loadBenefitCertsDbOrCsv } from "./_futan-period-core.mjs";
import { resolveBenefitForMonth } from "../lib/insurance/cert-month";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null; };
const MONTH = arg("--month") ?? (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; })();
if (!/^\d{4}-\d{2}$/.test(MONTH)) { console.error("--month は YYYY-MM"); process.exit(1); }
const REFRESH = process.argv.includes("--refresh");
const OFFICE = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a"; // 介護ショップ ケア・サポート千葉
const FY = "../kaigo-app/伝送データ/ケアサポ/福祉用具";
const [Y, M] = MONTH.split("-").map(Number);
const ND = new Date(Date.UTC(Y, M, 0)).getUTCDate();
const MS = `${MONTH}-01`, ME = `${MONTH}-${String(ND).padStart(2, "0")}`;
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();

/** ✓ = 揃っている / ✗ = 待つべき (データ待ち・取込漏れ) / ⚠ = 待たなくてよいが直すべき注意 / － = 参考 */
type Mark = "ok" | "wait" | "warn" | "info";
type Line = { mark: Mark; label: string; detail: string };
const lines: Line[] = [];
const waits: string[] = []; // 待つべき理由
const warns: string[] = []; // 注意 (伝送は止めない)
const add = (ok: boolean | null, label: string, detail: string, wait?: string) => {
  lines.push({ mark: ok === true ? "ok" : ok === false ? "wait" : "info", label, detail });
  if (wait) waits.push(wait);
};
const warn = (label: string, detail: string, why: string) => { lines.push({ mark: "warn", label, detail }); warns.push(why); };

const parse = (l: string) => { const o: string[] = []; let c = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } o.push(c); return o; };

console.log(`══ check:month-ready  提供月 ${MONTH} (ケアサポ)  実行日 ${today} ══\n`);

// ── ① 提供票 ────────────────────────────────────────────────────────────
{
  const dirs = existsSync(FY) ? readdirSync(FY).filter((d) => /^用具貸与期間_/.test(d)).sort() : [];
  const hits = dirs.map((d) => join(FY, d, `提供票_${MONTH.replace("-", "")}.csv`)).filter((p) => existsSync(p));
  if (!hits.length) add(false, "① 提供票", `提供票_${MONTH.replace("-", "")}.csv が 用具貸与期間_* に無い`, "提供票が無い (貸与の開始・終了・休止を組み直せない)");
  else {
    const p = hits[hits.length - 1];
    const L = new TextDecoder("shift-jis").decode(readFileSync(p)).split(/\r?\n/).filter(Boolean);
    const h = parse(L[0]); const iP = h.indexOf("予定／実績"), i1 = h.indexOf("1日");
    const rows = L.slice(1).map(parse).filter((r) => r[iP] === "実績");
    const last = new Map<number, number>();
    for (const r of rows) { let lastDay = 0; for (let d = 0; d < ND; d++) if ((r[i1 + d] ?? "").normalize("NFKC") === "1") lastDay = d + 1; last.set(lastDay, (last.get(lastDay) ?? 0) + 1); }
    const live = rows.length - (last.get(0) ?? 0);
    const toEnd = last.get(ND) ?? 0;
    const pct = live ? Math.round((toEnd / live) * 100) : 0;
    const monthDone = ME < today;
    const dist = [...last].filter(([d]) => d > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d, n]) => `${d}日 ${n}`).join(" / ");
    add(true, "① 提供票", `${p.replace(FY + "/", "")}: 実績 ${rows.length} 行 (印あり ${live}) / 最終の印が末日 ${toEnd} 行 (${pct}%) [${dist}]`);
    if (!monthDone) add(false, "   └ 月の状態", `提供月がまだ終わっていない (${ME} > 今日 ${today}) = 月途中の提供票 (予定の写し)。終了・休止は確定していない`, "提供月が終わっていない (提供票が月途中の写し)");
    else add(true, "   └ 月の状態", "提供月は終わっている (確定版の提供票か、出力日を確認)");
  }
}

// ── 請求モデル (請求対象・月遅れ・公費) ──────────────────────────────────
const libs = await loadLibs();
const snap = await loadSnapshot(MONTH, join(tmpdir(), `month-ready-snapshot-${MONTH}.json`), REFRESH);
const perOfficeIds = snap.offices.filter((o) => (o as { insurance_scope?: string }).insurance_scope === "per_office").map((o) => o.id);
const perOffice = perOfficeIds.includes(OFFICE);
const model = buildBillingModel(snap, MONTH, OFFICE, libs, new Map(), { perOffice, perOfficeIds });
const targets = model.dbTargets;
console.log(`\n請求対象 (当月に介護保険の貸与があり明細が乗る利用者): ${targets.length} 名 / 保険の持ち方: ${perOffice ? "事業所別 (per_office)" : "共有 (shared)"}\n`);

// ── ② CM 指示 ──────────────────────────────────────────────────────────
{
  const env = readEnv();
  const cm = new Set<string>();
  let readErr: string | null = null;
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/fukuyogu_cm_units?select=client_id&tenant_id=eq.${TENANT}&office_id=eq.${OFFICE}&service_month=eq.${MONTH}&order=id&offset=${from}&limit=1000`,
      { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
    if (!res.ok) { readErr = `${res.status} ${(await res.text()).slice(0, 100)}`; break; }
    const rows = (await res.json()) as { client_id: string }[];
    rows.forEach((r) => cm.add(r.client_id));
    if (rows.length < 1000) break;
  }
  if (readErr) add(false, "② CM 指示 (月次情報)", `fukuyogu_cm_units を読めない (${readErr})`, "CM 指示単位数を読めない");
  else {
    const inT = targets.filter((c) => cm.has(c)).length;
    const pct = targets.length ? Math.round((inT / targets.length) * 100) : 0;
    const ok = cm.size > 0 && pct >= 90;
    add(ok, "② CM 指示 (月次情報)", `入力 ${cm.size} 名 / 請求対象のうち入力あり ${inT} / ${targets.length} 名 (${pct}%)`,
      cm.size === 0 ? "その月の月次情報 (CM 指示単位数) が未取込 (頭打ち・未入力の除外が効かない)" : !ok ? `月次情報の入力が請求対象の ${pct}% だけ (未入力の人は伝送から外れる)` : undefined);
  }
}

// ── ③ 公費 ─────────────────────────────────────────────────────────────
{
  const withKohi = targets.filter((c) => model.pickKohi(c)).length;
  const hOnly = targets.filter((c) => /^[Hh]/.test((model.clientById.get(c)?.insured_number ?? "").trim()));
  const hMissing = hOnly.filter((c) => !model.pickKohi(c));
  // 先月の公費の人数 (落ち込みの目安)
  const prevM = M === 1 ? `${Y - 1}-12` : `${Y}-${String(M - 1).padStart(2, "0")}`;
  const prevMs = `${prevM}-01`, prevMe = `${prevM}-${String(new Date(Date.UTC(Number(prevM.slice(0, 4)), Number(prevM.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  const kohiPrev = new Set(snap.kohi.filter((k) => (perOffice ? k.office_id === OFFICE : true) && k.hohei_code && !(k.valid_start && k.valid_start > prevMe) && !(k.valid_end && k.valid_end < prevMs)).map((k) => k.client_id));
  const prevInT = targets.filter((c) => kohiPrev.has(c)).length;
  const drop = prevInT > 0 && withKohi < prevInT * 0.8;
  const kohiDetail = `その月にかかる公費あり ${withKohi} 名 (同じ請求対象で先月 ${prevM} は ${prevInT} 名) / 公費単独 (H) ${hOnly.length} 名のうち公費なし ${hMissing.length} 名${hMissing.length ? ` (${hMissing.slice(0, 8).map((c) => model.clientById.get(c)?.name).join("・")}${hMissing.length > 8 ? " 他" : ""})` : ""}`;
  if (drop) add(false, "③ 公費 (生保の介護券は月 1 行)", kohiDetail, `その月の公費 (介護券) が未取込の可能性 (先月 ${prevInT} 名 → ${withKohi} 名)`);
  else if (hMissing.length) warn("③ 公費 (生保の介護券は月 1 行)", kohiDetail, `公費単独 (H) なのに公費が無い ${hMissing.length} 名 (請求画面の警告と同じ。個別に確認)`);
  else add(true, "③ 公費 (生保の介護券は月 1 行)", kohiDetail);
}

// ── ④ 認定 (月遅れ) と 利用者マスタの出力日 ───────────────────────────────
{
  const late = targets.filter((c) => model.autoLate.has(c));
  const applying = late.filter((c) => model.pickIns(c)?.certification_status === "申請中").length;
  const noCert = late.filter((c) => !model.pickIns(c)).length;
  const masterDirs = existsSync(FY) ? readdirSync(FY).map((d) => /^利用者マスタ_(?:全件_)?(\d{8})$/.exec(d)?.[1]).filter(Boolean).sort() as string[] : [];
  const latest = masterDirs.at(-1);
  const latestYmd = latest ? `${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}` : null;
  const stale = !latestYmd || latestYmd < ME; // 提供月の末日より前の出力 = その月の更新認定が入っていない可能性
  // 月遅れの人を ほのぼの利用者マスタ (最新出力・登録有/無の両方) と照合: マスタにはその月にかかる認定がある = 当方の取込漏れ
  const masterCover = new Set<string>(); // "no:利用者番号" / "ins:被保番" (その月にかかる 要介護度ありの認定がある)
  const ymdOf = (v: string) => { const m = (v ?? "").normalize("NFKC").match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : ""; };
  if (latest) for (const d of readdirSync(FY).filter((x) => x === `利用者マスタ_${latest}` || x === `利用者マスタ_全件_${latest}`)) {
    for (const f of readdirSync(join(FY, d)).filter((x) => /^介護保険_.*\.csv$/i.test(x))) {
      const L = new TextDecoder("shift-jis").decode(readFileSync(join(FY, d, f))).split(/\r?\n/).filter(Boolean);
      const h = parse(L[0]);
      const iS = h.indexOf("認定有効期間－開始日"), iE = h.indexOf("認定有効期間－終了日"), iLv = h.indexOf("要介護度"), iIns = h.indexOf("被保険者番号");
      for (const r of L.slice(1).map(parse)) {
        const st = ymdOf(r[iS]), en = ymdOf(r[iE]);
        if (!st || st > ME || (en && en < MS) || !(r[iLv] ?? "").trim()) continue;
        masterCover.add(`no:${(r[0] ?? "").trim()}`);
        masterCover.add(`ins:${(r[iIns] ?? "").normalize("NFKC").trim()}`);
      }
    }
  }
  const missed = late.filter((c) => {
    const cl = model.clientById.get(c);
    return masterCover.has(`no:${cl?.user_number ?? ""}`) || masterCover.has(`ins:${(cl?.insured_number ?? "").normalize("NFKC").trim()}`);
  });
  const lateDetail = `${late.length} 名 (その月にかかる認定なし ${noCert} / 申請中 ${applying} / 要介護度なし 他 ${late.length - noCert - applying}) — うち ほのぼの利用者マスタ (${latestYmd ?? "なし"}) には認定がある = 当方の取込漏れ ${missed.length} 名${missed.length ? ` (${missed.slice(0, 8).map((c) => model.clientById.get(c)?.name).join("・")})` : ""}`;
  if (missed.length) add(false, "④ 認定 (月遅れになる請求対象)", lateDetail, `ほのぼのにある認定が当方に無い ${missed.length} 名 (利用者マスタの取込が要る)`);
  else if (late.length && stale) add(false, "④ 認定 (月遅れになる請求対象)", lateDetail, `月遅れになる ${late.length} 名の更新認定が、利用者マスタ (${latestYmd ?? "未取得"} 出力) にまだ入っていない可能性 (出し直し推奨)`);
  else add(late.length ? null : true, "④ 認定 (月遅れになる請求対象)", `${lateDetail}${late.length ? " → ほのぼのにも認定が無い = 請求外で正しい" : ""}`);
  add(stale ? null : true, "   └ ほのぼの利用者マスタの最新出力", latestYmd ? `${latestYmd} (利用者マスタ_${latest})${stale ? ` — 提供月の末日 ${ME} より前。★ 出し直し推奨 (その月の更新認定が入っていない)` : ""}` : "利用者マスタ_* フォルダが無い");
}

// ── ⑤ 負担割合証 ────────────────────────────────────────────────────────
{
  const sb = await serviceClient(["../kaigo-app/.env.local", ".env.local"]);
  if (!sb) add(null, "⑤ 負担割合証", "SUPABASE_SERVICE_ROLE_KEY が無いので数えられない");
  else {
    const K = "../kaigo-app";
    // 認定行は 請求と同じ範囲に絞る (事業所別 = この事業所の行だけ。buildBillingModel の insByClient と同じ行)。
    //   絞らないと 他事業所の行 (給付率なし) が選ばれて「割合なし」に数えてしまう (上村 亮子 2026-10 で実測)
    const scopedIds = new Set([...model.insByClient.values()].flat().map((r) => r.id));
    const rowsAll = await loadCertRows(sb, targets);
    const rowsBy = new Map([...rowsAll].map(([cid, rs]) => [cid, rs.filter((r) => r.id != null && scopedIds.has(r.id))]));
    const b = await loadBenefitCertsDbOrCsv(sb, targets, [
      { label: "ケアサポ 20261109", futan: join(K, "伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/負担割合証等_全件.CSV"), ins: [join(K, "伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/介護保険_全件_保険と認定.CSV")] },
      { label: "全社 20260830", futan: join(K, "利用者データ/全社_R8-08/負担割合証等1.CSV"), ins: [join(K, "利用者データ/全社_R8-08/介護保険1.CSV")] },
    ]);
    let withCert = 0, rowOnly = 0;
    const noneNames: string[] = [];
    for (const c of targets) {
      const r = resolveBenefitForMonth(rowsBy.get(c) ?? [], b.byClient.get(c) ?? [], MS, ME);
      if (r.source === "certificate") withCert++; else if (r.source === "cert_row") rowOnly++; else noneNames.push(model.clientById.get(c)?.name ?? c);
    }
    const futanDetail = `証あり ${withCert} 名 / 証なしで認定行の割合 ${rowOnly} 名 / 割合なし ${noneNames.length} 名${noneNames.length ? ` (${noneNames.slice(0, 5).join("・")})` : ""} (出どころ ${b.source}。check:futan-period と同じ数え方)`;
    if (noneNames.length) warn("⑤ 負担割合証", futanDetail, `給付率が決まらない請求対象 ${noneNames.length} 名 (請求画面は 90 で計算し警告)`);
    else add(true, "⑤ 負担割合証", futanDetail);
  }
}

// ── ⑥ 日割り表 ──────────────────────────────────────────────────────────
{
  const env = readEnv();
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/order_item_proration?select=id&limit=1`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  if (res.ok) {
    const cnt = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/order_item_proration?select=id&month=eq.${MONTH}`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact", Range: "0-0" } });
    add(true, "⑥ 日割り表 (order_item_proration)", `適用済み / その月の日割り ${cnt.headers.get("content-range")?.split("/")[1] ?? "?"} 件`);
  } else {
    add(null, "⑥ 日割り表 (order_item_proration)", `未適用 (${res.status}) — 全件 半月按分の自動で計算される (日割りを使わないなら問題なし)`);
  }
}

// ── 出力 ────────────────────────────────────────────────────────────────
const MARK: Record<Mark, string> = { ok: "✓", wait: "✗", warn: "⚠", info: "－" };
for (const l of lines) console.log(`${MARK[l.mark]} ${l.label.padEnd(22)} ${l.detail}`);
console.log("\n══ 判定 ══");
if (!waits.length) console.log("✓ 伝送してよい (データ待ち・取込漏れは見つからなかった。請求画面の伝送の警告も確認すること)");
else {
  console.log(`✗ 待つべき (${waits.length} 件):`);
  for (const w of waits.slice(0, 3)) console.log(`  - ${w}`);
  if (waits.length > 3) console.log(`  … 他 ${waits.length - 3} 件 (上の ✗ の行)`);
}
if (warns.length) {
  console.log(`⚠ 伝送は止めないが確認すること (${warns.length} 件):`);
  for (const w of warns) console.log(`  - ${w}`);
}
console.log("\n(診断。gate ではない・常に exit 0。check:all には入れていない)");
