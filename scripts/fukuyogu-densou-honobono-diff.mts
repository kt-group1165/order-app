/**
 * 福祉用具 国保連伝送: order-app が DB から組む伝送 と ほのぼのの実伝送 (KK) の突合 — ★ READ ONLY
 *
 *   npx tsx scripts/fukuyogu-densou-honobono-diff.mts --kk <KK261004.CSV> [--month 2026-09]
 *        [--db-cache <json>] [--refresh] [--out <json>]
 *
 * ★ DB は一切書き換えない (service_role で SELECT するだけ)。全件読みは 1 回にして --db-cache に保存し再利用
 *   (既定 = OS の一時フォルダ。最新を読み直すときは --refresh)。
 *
 * ── 何を組むか ───────────────────────────────────────────────────────────
 *   請求画面 (app/[tenant]/BillingTab.tsx generateTransferData) と同じ条件で当月の対象を集め、
 *   **本物の buildFukuyoguDensou** (lib/kokuho-densou/build.ts) で KK 形式を作る。
 *   対象・単位数の判定は scripts/_honobono-sync-core.mts の buildBillingModel (BillingTab の書き写し。
 *   根拠の行番号は honobono-sync-diff.mts 冒頭) を使う。行の組み立ては BillingTab L756-858 と同じ:
 *     保険者・被保番・給付率 = clients の列 / 要介護度・認定期間 = 当月有効の認定 (cert-for-month.ts) / 居宅事業所 = clients.care_office_id /
 *     公費 = 当月有効な client_public_expenses の最初の 1 件 / 金額 = computeFukuyoguAmounts /
 *     月遅れ (認定 申請中・billing_late_flags) は除外 /
 *     貸与日数 = fukuyoguRentalDaysInMonth / 開始・中止 = fukuyoguServicePeriod (build.ts の本物)
 *
 * ── 突合のキー ────────────────────────────────────────────────────────────
 *   レセプト: (様式 7131/7132, 保険者番号 8 桁, 被保険者番号)
 *   明細    : (サービスコード, TAIS) の多重集合 (同じ用具 2 個は 2 行)
 *   書式 (引用符・0 埋め) の差は値の比較から外して 別に数える。
 *
 * ── 範囲外 ────────────────────────────────────────────────────────────────
 *   月遅れ分 KK261001〜003 (提供 2026-06〜08) は突合しない: DB は 2026-09 提供分に合わせただけで、
 *   過去月の貸与・認定・月遅れフラグは当時の状態を再現していない (同じ条件で組んでも比べる意味が無い)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROVIDER_BN, loadSnapshot, loadLibs, buildBillingModel, ymOf, readEnv, type ItemRow,
} from "./_honobono-sync-core.mjs";
import {
  buildFukuyoguDensou, fukuyoguRentalDaysInMonth,
  type FukuyoguSeikyuRow, type FukuyoguDetailLine,
} from "../lib/kokuho-densou/build";
import { pickCertForMonth, certFieldsForDensou } from "../lib/kokuho-densou/cert-for-month";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const KK = arg("--kk");
if (!KK) {
  console.error("usage: npx tsx scripts/fukuyogu-densou-honobono-diff.mts --kk <KK261004.CSV> [--month YYYY-MM]");
  process.exit(1);
}

// ── KK を読む (ASCII のみ。引用符は値の比較では外す) ─────────────────────
type Rec = { raw: string[]; v: string[] }; // raw = 引用符付きのまま / v = 外した値。どちらも「項1 = 交換情報識別番号」から
const unq = (s: string) => s.replace(/^"(.*)"$/, "$1");
function parseKk(text: string): { control: string[]; recs: Rec[] } {
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  const control = lines[0].split(",");
  const recs = lines.filter((l) => l.startsWith("2,")).map((l) => {
    const raw = l.split(",").slice(2);
    return { raw, v: raw.map(unq) };
  });
  return { control, recs };
}
type Receipt = { key: string; form: string; h: Rec; d: Rec[]; s: Rec | null };
function receipts(recs: Rec[]): { r7111: Rec[]; byKey: Map<string, Receipt> } {
  const r7111: Rec[] = [];
  const byKey = new Map<string, Receipt>();
  let cur: Receipt | null = null;
  for (const r of recs) {
    if (r.v[0] === "7111") { r7111.push(r); continue; }
    const key = `${r.v[0]}|${r.v[4]}|${r.v[5]}`;
    if (r.v[1] === "01") { cur = { key, form: r.v[0], h: r, d: [], s: null }; byKey.set(key, cur); }
    else if (cur && cur.key === key) { if (r.v[1] === "02") cur.d.push(r); else cur.s = r; }
    else throw new Error(`★ 01 の無い ${r.v[1]} レコード: ${key}`);
  }
  return { r7111, byKey };
}

// 項番 → 名前 (表示用)
const N01: Record<number, string> = { 5: "保険者番号", 6: "被保険者番号", 7: "公費1負担者", 8: "公費1受給者", 13: "生年月日", 14: "性別", 15: "要介護度", 17: "認定開始", 18: "認定終了", 19: "計画作成区分", 20: "居宅事業所番号", 21: "開始年月日", 22: "中止年月日", 23: "中止理由", 29: "保険給付率", 30: "公費1給付率", 33: "保険単位数", 34: "保険請求額", 35: "利用者負担", 39: "公費1単位数", 40: "公費1請求額", 41: "公費1本人負担" };
const N02: Record<number, string> = { 7: "種類", 8: "項目", 9: "単位数", 10: "日数", 11: "公費1日数", 14: "サービス単位数", 15: "公費1単位数", 18: "摘要(TAIS)" };
const N10: Record<number, string> = { 7: "種類", 8: "実日数", 9: "計画単位数", 10: "限度額管理対象", 11: "対象外", 14: "保険単位数", 15: "単価", 16: "保険請求額", 17: "利用者負担", 18: "公費1単位数", 19: "公費1請求額", 20: "公費1本人負担" };
const N7111: Record<number, string> = { 4: "保険公費区分", 5: "法別", 7: "件数", 8: "単位数", 9: "費用合計", 10: "保険請求額", 11: "公費請求額", 12: "利用者負担" };

class Buckets {
  m = new Map<string, unknown[]>();
  add(cat: string, ex: unknown) { if (!this.m.has(cat)) this.m.set(cat, []); this.m.get(cat)!.push(ex); }
  count(cat: string) { return this.m.get(cat)?.length ?? 0; }
  print(title: string) {
    console.log(`\n══ ${title} ══`);
    if (this.m.size === 0) console.log("  (差なし)");
    for (const [k, v] of [...this.m].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(v.length).padStart(5)}  ${k}`);
      for (const e of v.slice(0, 10)) console.log(`         - ${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
  }
  toJSON() { return Object.fromEntries([...this.m].map(([k, v]) => [k, { count: v.length, items: v }])); }
}

/** 2 つのファイルを突合して差を Buckets に積む。返り値 = 集計 */
function compare(hono: ReturnType<typeof receipts>, mine: ReturnType<typeof receipts>, nameOf: (key: string) => string) {
  const B = { rec: new Buckets(), f01: new Buckets(), f02: new Buckets(), f10: new Buckets(), f7111: new Buckets(), fmt: new Buckets() };
  const stat = { "7131-01": [0, 0], "7131-02": [0, 0], "7131-10": [0, 0], "7132-01": [0, 0], "7132-02": [0, 0], "7132-10": [0, 0], "7111": [0, 0] } as Record<string, [number, number]>;
  const fmtCheck = (a: Rec, b: Rec, kind: string) => {
    a.raw.forEach((x, i) => {
      const y = b.raw[i] ?? "";
      if (x === y) return;
      if (unq(x) === unq(y)) B.fmt.add(`${kind} 項${i + 1} 引用符の有無`, `ほ=${x} 新=${y}`);
      else if ((a.v[i] === "" && b.v[i] === "0") || (a.v[i] === "0" && b.v[i] === "")) B.fmt.add(`${kind} 項${i + 1} 空欄と 0`, `ほ=${x} 新=${y}`);
    });
  };
  const fieldDiff = (bk: Buckets, names: Record<number, string>, kind: string, a: Rec, b: Rec, ex: Record<string, unknown>) => {
    let same = true;
    const len = Math.max(a.v.length, b.v.length);
    if (a.v.length !== b.v.length) { bk.add(`${kind} 項目数`, { ...ex, ほ: a.v.length, 新: b.v.length }); same = false; }
    for (let i = 0; i < len; i++) {
      const x = a.v[i] ?? "", y = b.v[i] ?? "";
      if (x === y || (x === "" && y === "0") || (x === "0" && y === "")) continue;
      same = false;
      bk.add(`${kind} 項${i + 1} ${names[i + 1] ?? ""}`, { ...ex, ほ: x, 新: y });
    }
    fmtCheck(a, b, kind);
    return same;
  };

  // 7111
  for (const h of hono.r7111) {
    const m = mine.r7111.find((x) => x.v[3] === h.v[3] && x.v[4] === h.v[4]);
    stat["7111"][1]++;
    if (!m) { B.f7111.add("7111 新システムに無い", { 区分: h.v[3], 法別: h.v[4] }); continue; }
    if (fieldDiff(B.f7111, N7111, "7111", h, m, { 区分: h.v[3], 法別: h.v[4] })) stat["7111"][0]++;
  }
  for (const m of mine.r7111) if (!hono.r7111.some((x) => x.v[3] === m.v[3] && x.v[4] === m.v[4])) B.f7111.add("7111 ほのぼのに無い", { 区分: m.v[3], 法別: m.v[4] });

  const otherForm = (key: string) => key.startsWith("7131") ? key.replace("7131", "7132") : key.replace("7132", "7131");
  for (const [key, h] of hono.byKey) {
    const m = mine.byKey.get(key);
    const ex = { key, 氏名: nameOf(key) };
    stat[`${h.form}-01`][1]++; stat[`${h.form}-10`][1]++; stat[`${h.form}-02`][1] += h.d.length;
    if (!m) {
      const o = mine.byKey.get(otherForm(key));
      if (o) B.rec.add(`★ 様式違い (ほのぼの ${h.form} / 新システム ${o.form} = 要介護度の差)`, { ...ex, ほ要介護度: h.h.v[14], 新要介護度: o.h.v[14] });
      else B.rec.add("ほのぼのにだけあるレセプト", { ...ex, 単位数: h.h.v[32], 明細: h.d.length });
      continue;
    }
    if (fieldDiff(B.f01, N01, `${h.form}-01`, h.h, m.h, ex)) stat[`${h.form}-01`][0]++;
    if (h.s && m.s && fieldDiff(B.f10, N10, `${h.form}-10`, h.s, m.s, ex)) stat[`${h.form}-10`][0]++;
    // 明細: (コード, TAIS) で束ね、束の中は サービス単位数 の昇順で対にする
    const group = (ds: Rec[]) => {
      const g = new Map<string, Rec[]>();
      for (const d of ds) { const k = `${d.v[6]}${d.v[7]}|${d.v[17]}`; if (!g.has(k)) g.set(k, []); g.get(k)!.push(d); }
      for (const v of g.values()) v.sort((a, b) => Number(a.v[13]) - Number(b.v[13]) || Number(a.v[9]) - Number(b.v[9]));
      return g;
    };
    const gh = group(h.d), gm = group(m.d);
    for (const [k, hs] of gh) {
      const ms = gm.get(k) ?? [];
      hs.forEach((hd, i) => {
        const md = ms[i];
        if (!md) { B.f02.add(`${h.form}-02 ほのぼのにだけある明細`, { ...ex, コードTAIS: k, 日数: hd.v[9], 単位: hd.v[13] }); return; }
        if (fieldDiff(B.f02, N02, `${h.form}-02`, hd, md, { ...ex, コードTAIS: k })) stat[`${h.form}-02`][0]++;
      });
      for (const md of ms.slice(hs.length)) B.f02.add(`${h.form}-02 新システムにだけある明細`, { ...ex, コードTAIS: k, 日数: md.v[9], 単位: md.v[13] });
    }
    for (const [k, ms] of gm) if (!gh.has(k)) for (const md of ms) B.f02.add(`${h.form}-02 新システムにだけある明細`, { ...ex, コードTAIS: k, 日数: md.v[9], 単位: md.v[13] });
  }
  for (const [key, m] of mine.byKey) {
    if (hono.byKey.has(key) || hono.byKey.has(otherForm(key))) continue;
    B.rec.add("新システムにだけあるレセプト", { key, 氏名: nameOf(key), 単位数: m.h.v[32], 明細: m.d.length });
  }
  return { B, stat };
}

// ── 診断: 開始年月日・中止年月日を DB の貸与履歴から決めたら ほのぼのとどれだけ合うか ──
//   (★ 請求画面は渡していない。order_items.rental_start_date が移行時の仮の日付のため。数字を残すための診断)
const monthBounds = (ym: string) => { const [y, m] = ym.split("-").map(Number); const l = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { first: `${ym}-01`, last: `${ym}-${String(l).padStart(2, "0")}` }; };
/**
 * 基本 (01) 項21 開始年月日 / 項22 中止年月日 を利用者の貸与履歴から決める。
 *   開始 = その利用者の最初の貸与開始日が当月内なら その日 (月途中から増えた用具は開始にしない)
 *   中止 = 当月に請求する用具が全部 当月内に終わる (翌月に続く用具が無い) なら 最後の終了日
 * @param allRentals その利用者の 介護保険の貸与 全部 (過去月の終了分も含む。キャンセルは除く)
 * @param monthRentals 当月に請求する貸与
 */
function derivePeriod(
  allRentals: { rentalStart: string | null; rentalEnd: string | null }[],
  monthRentals: { rentalStart: string | null; rentalEnd: string | null }[],
  ym: string,
): { startDate: string | null; stopDate: string | null } {
  const { first, last } = monthBounds(ym);
  const starts = allRentals.map((r) => r.rentalStart?.slice(0, 10)).filter((s): s is string => !!s).sort();
  const firstStart = starts[0] ?? null;
  const startDate = firstStart && firstStart >= first && firstStart <= last ? firstStart : null;
  const ends = monthRentals.map((r) => r.rentalEnd?.slice(0, 10) ?? null);
  const allEnd = ends.length > 0 && ends.every((e) => e != null && e >= first && e <= last);
  // 当月の用具は終わっても、別の貸与が翌月以降に続く (月末に入れ替え等) なら中止ではない
  const continues = allRentals.some((r) => {
    const s = r.rentalStart?.slice(0, 10) ?? null;
    const e = r.rentalEnd?.slice(0, 10) ?? null;
    return s != null && s <= last && (e == null || e > last);
  });
  const stopDate = allEnd && !continues ? (ends as string[]).sort()[ends.length - 1] : null;
  return { startDate, stopDate };
}

async function main() {
  const libs = await loadLibs();
  const kkText = readFileSync(KK!, "latin1"); // ASCII のみ (漢字を含まない)
  const hk = parseKk(kkText);
  const MONTH = arg("--month") ?? ymOf(`${hk.recs[0].v[1].slice(0, 4)}-${hk.recs[0].v[1].slice(4, 6)}`);
  const CACHE = arg("--db-cache") ?? join(tmpdir(), `fukuyogu-densou-db-${MONTH}.json`);
  console.log(`ほのぼの: ${KK}\n  提供年月 ${MONTH} / データ ${hk.recs.length} レコード / コントロール ${hk.control.join(",")}`);
  const snap = await loadSnapshot(MONTH, CACHE, process.argv.includes("--refresh"));
  const office = snap.offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
  if (!office) throw new Error(`offices に business_number=${PROVIDER_BN} が無い`);
  const model = buildBillingModel(snap, MONTH, office.id, libs);
  const { clientById, careOfficeNo, dbLines, isLate, pickKohi, ordersById } = model;
  const itemById = new Map(snap.items.map((i) => [i.id, i]));
  // 計画作成区分 (care_offices.plan_kubun。migrations/care_offices_plan_kubun.sql)。スナップショットに無い列なので都度読む。
  //   列が未適用ならその旨を出して全件 "1" 扱い (BillingTab と同じ)
  const planKubunById = new Map<string, string>();
  {
    const env = readEnv();
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/care_offices?select=id,plan_kubun&plan_kubun=eq.3`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (res.ok) for (const r of (await res.json()) as { id: string; plan_kubun: string }[]) planKubunById.set(r.id, r.plan_kubun);
    else console.log(`  ⚠ care_offices.plan_kubun を読めない (${res.status} ${(await res.text()).slice(0, 120)}) — 列が未適用なら全件 区分1 扱い`);
  }
  // 開始年月日のため 利用者ごとの 介護保険の貸与 全部 (過去月の終了分も)
  const rentalsByClient = new Map<string, ItemRow[]>();
  for (const it of snap.items) {
    const o = ordersById.get(it.order_id);
    if (!o?.client_id) continue;
    if ((it.payment_type ?? o.payment_type ?? "介護") !== "介護") continue;
    if (it.status !== "rental_started" && it.status !== "terminated") continue;
    if (!rentalsByClient.has(o.client_id)) rentalsByClient.set(o.client_id, []);
    rentalsByClient.get(o.client_id)!.push(it);
  }
  const toP = (it: ItemRow) => ({ rentalStart: it.rental_start_date, rentalEnd: it.rental_end_date });

  const rows: FukuyoguSeikyuRow[] = [];
  const nameByKey = new Map<string, string>();
  let lateCount = 0;
  const periodByKey = new Map<string, { startDate: string | null; stopDate: string | null }>();
  for (const [cid, lines] of dbLines) {
    if (isLate(cid)) { lateCount++; continue; }
    const c = clientById.get(cid)!;
    const details: FukuyoguDetailLine[] = [];
    const billed: ItemRow[] = [];
    let totalUnits = 0;
    for (const l of lines) {
      const it = itemById.get(l.itemId)!;
      details.push({
        serviceCode: l.code!, unitPer: l.unitPer, count: l.count, units: l.units,
        days: fukuyoguRentalDaysInMonth(it.rental_start_date, it.rental_end_date, MONTH),
        taisCode: model.eqByCode.get(it.product_code)?.tais_code ?? null,
      });
      billed.push(it);
      totalUnits += l.units;
    }
    const k = pickKohi(cid);
    const kohi = k ? { hobetsu: k.hohei_code!, futansha: k.futan_sha_number, jukyusha: k.jukyu_sha_number } : null;
    const amt = libs.computeFukuyoguAmounts({ benefitRateRaw: c.benefit_rate, insuredNumber: c.insured_number, totalUnits, kohi });
    periodByKey.set(`${(c.insurer_number ?? "").trim().padStart(8, "0")}|${(c.insured_number ?? "").trim()}`, derivePeriod((rentalsByClient.get(cid) ?? []).map(toP), billed.map(toP), MONTH));
    rows.push({
      userName: c.name, insurerNumber: c.insurer_number, insuredNumber: c.insured_number ?? null,
      birthDate: c.birth_date, gender: c.gender,
      // 要介護度・認定期間 = 当月に有効な認定レコード優先 (BillingTab と同じ lib/kokuho-densou/cert-for-month.ts)
      ...certFieldsForDensou(c, pickCertForMonth(model.insByClient.get(cid) ?? [], model.monthStartS, model.monthEndS)),
      careOfficeNumber: c.care_office_id ? (careOfficeNo.get(c.care_office_id) || null) : null,
      carePlanKubun: c.care_office_id ? planKubunById.get(c.care_office_id) ?? null : null,
      copayRate: amt.copayRate, details, totalUnits, totalCost: amt.totalCost,
      insuranceAmount: amt.insuranceAmount, userAmount: amt.userAmount,
      kohiHobetsu: amt.kohiHobetsu, kohiFutansha: kohi?.futansha ?? null, kohiJukyusha: kohi?.jukyusha ?? null,
      kohiAmount: amt.kohiAmount, kohiTandoku: amt.kohiTandoku,
      // 開始・中止は渡さない (BillingTab と同じ)
    });
    const ins8 = (c.insurer_number ?? "").trim().padStart(8, "0");
    for (const f of ["7131", "7132"]) nameByKey.set(`${f}|${ins8}|${(c.insured_number ?? "").trim()}`, `${c.name}`);
  }
  const [Y, M] = MONTH.split("-").map(Number);
  const built = buildFukuyoguDensou(rows, { officeNumber: PROVIDER_BN, year: Y, month: M });
  const mk = parseKk(built.content);
  console.log(`新システム: 対象 ${rows.length} 名 (月遅れで除外 ${lateCount} 名) / データ ${mk.recs.length} レコード / 警告 ${built.warnings.length} 件`);

  const hono = receipts(hk.recs), mine = receipts(mk.recs);
  const nameOf = (key: string) => nameByKey.get(key) ?? "(DB に無い)";
  const { B, stat } = compare(hono, mine, nameOf);

  console.log("\n══ コントロールレコード ══");
  const cDiff = hk.control.map((x, i) => (x === mk.control[i] ? null : `項${i + 1} ほ=${x} 新=${mk.control[i]}`)).filter(Boolean);
  console.log(cDiff.length ? `  差: ${cDiff.join(" / ")}` : "  一致");

  console.log("\n══ レコード種別ごとの一致 (ほのぼの側の件数が分母。書式差は無視して値で比較) ══");
  const cnt = (rs: ReturnType<typeof receipts>, f: string, t: string) =>
    t === "02" ? [...rs.byKey.values()].filter((r) => r.form === f).reduce((s, r) => s + r.d.length, 0) : [...rs.byKey.values()].filter((r) => r.form === f).length;
  for (const [k, [ok, all]] of Object.entries(stat)) {
    const [f, t] = k.split("-");
    const mineN = f === "7111" ? mine.r7111.length : cnt(mine, f, t);
    const hoN = f === "7111" ? hono.r7111.length : cnt(hono, f, t);
    console.log(`  ${k.padEnd(8)} 一致 ${String(ok).padStart(5)} / ${String(all).padStart(5)} (${all ? ((ok / all) * 100).toFixed(1) : "-"}%)   件数 ほ=${hoN} 新=${mineN}`);
  }
  B.rec.print("レセプト単位 (ほのぼのにだけ / 新システムにだけ / 様式違い)");
  B.f7111.print("7111 請求書 項目の差");
  B.f01.print("基本 (01) 項目の差 (件数 = レセプト数)");
  B.f02.print("明細 (02) 項目の差 (件数 = 明細行数)");
  B.f10.print("集計 (10) 項目の差 (件数 = レセプト数)");
  B.fmt.print("書式の差 (値は同じ。引用符・0 埋め)");

  // ── 原因の切り分け (診断) ──────────────────────────────────────────────
  const why = new Buckets();
  const nIns = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/\D/g, "").padStart(8, "0");
  const nId = (s: string | null | undefined) => (s ?? "").normalize("NFKC").trim().toUpperCase();
  const clientsByKey = new Map<string, string[]>();
  const addK = (a: string | null, b: string | null, cid: string) => {
    if (!a || !b) return; const k = `${nIns(a)}|${nId(b)}`;
    if (!clientsByKey.has(k)) clientsByKey.set(k, []); if (!clientsByKey.get(k)!.includes(cid)) clientsByKey.get(k)!.push(cid);
  };
  for (const c of snap.clients) addK(c.insurer_number, c.insured_number, c.id);
  for (const r of snap.ins) addK(r.insurer_number, r.insured_number, r.client_id);
  const otherFormKey = (key: string) => key.slice(5);
  for (const [key, h] of hono.byKey) {
    if (mine.byKey.has(key) || mine.byKey.has((key.startsWith("7131") ? "7132" : "7131") + key.slice(4))) continue;
    const cids = clientsByKey.get(otherFormKey(key)) ?? [];
    const ex = { key, 単位数: h.h.v[32] };
    if (cids.length === 0) { why.add("ほのぼのだけ: DB に (保険者, 被保番) が一致する利用者がいない", ex); continue; }
    const c = clientById.get(cids[0])!;
    const exn = { ...ex, 氏名: c.name, client_id: c.id };
    if (c.deleted_at) why.add("ほのぼのだけ: 利用者が削除済み", exn);
    else if (c.office_id !== office.id) why.add("ほのぼのだけ: clients.office_id が別事業所", { ...exn, office_id: c.office_id });
    else if (isLate(c.id)) why.add("ほのぼのだけ: 月遅れ扱い (認定 申請中 / 月遅れフラグ) で伝送から外れる", exn);
    else if (model.dbSkipped.has(c.id) && !dbLines.has(c.id)) why.add("ほのぼのだけ: 貸与はあるが請求に乗らない (単位 0 / サービスコード不明)", { ...exn, 理由: model.dbSkipped.get(c.id)!.map((l) => l.skipped) });
    else if (model.activeOtherScope.has(c.id)) why.add("ほのぼのだけ: 当月の貸与が別事業所の発注 (orders.office_id)", { ...exn, 例: model.activeOtherScope.get(c.id)![0].why });
    else if (cids.length > 1) why.add("ほのぼのだけ: 同じ (保険者, 被保番) の利用者が複数 (請求に乗る側の番号が違う)", { ...exn, 候補: cids.length });
    else if (c.insurer_number && nIns(c.insurer_number) + "|" + nId(c.insured_number) !== otherFormKey(key)) why.add("ほのぼのだけ: clients の番号がほのぼのと違う (認定履歴にだけ一致)", { ...exn, DB: `${c.insurer_number}|${c.insured_number}` });
    else why.add("ほのぼのだけ: 当月に有効な介護保険の貸与が DB に無い", exn);
  }
  // 金額の差 (01 項33-35) の原因
  for (const [key, h] of hono.byKey) {
    const m = mine.byKey.get(key);
    if (!m) continue;
    if (h.h.v[32] === m.h.v[32] && h.h.v[33] === m.h.v[33] && h.h.v[34] === m.h.v[34]) continue;
    const ex = { key, 氏名: nameOf(key), ほ: `${h.h.v[32]}単位/${h.h.v[33]}/${h.h.v[34]}`, 新: `${m.h.v[32]}単位/${m.h.v[33]}/${m.h.v[34]}` };
    const hSum = h.d.reduce((s, d) => s + Number(d.v[13]), 0), mSum = m.d.reduce((s, d) => s + Number(d.v[13]), 0);
    if (h.s && h.s.v[8] !== h.s.v[9]) why.add("金額差: ほのぼのは 計画単位数 (給付管理) で頭打ち。超過分は保険外 (DB に計画単位数が無い)", { ...ex, 計画: h.s.v[8], 実績: h.s.v[9] });
    else if (hSum !== mSum) why.add("金額差: 明細の単位数合計が違う (用具・単位数の差)", { ...ex, 明細合計: `ほ${hSum}/新${mSum}` });
    else if (h.h.v[28] !== m.h.v[28]) why.add("金額差: 保険給付率が違う (clients.benefit_rate)", { ...ex, 給付率: `ほ${h.h.v[28]}/新${m.h.v[28]}` });
    else if (h.h.v[6] !== m.h.v[6]) why.add("金額差: 公費の有無が違う", { ...ex, 公費: `ほ${h.h.v[6]}/新${m.h.v[6]}` });
    else why.add("金額差: その他", ex);
  }
  // 開始・中止を DB の貸与履歴から決めた場合 (請求画面は渡していない)
  for (const [key, h] of hono.byKey) {
    if (!mine.byKey.has(key)) continue;
    const p = periodByKey.get(key.slice(5));
    const ds = (s: string | null | undefined) => (s ?? "").replaceAll("-", "");
    for (const [i, name, val] of [[20, "開始", p?.startDate], [21, "中止", p?.stopDate]] as const) {
      const hv = h.h.v[i], dv = ds(val);
      why.add(`開始・中止の導出 (診断): ${name} ${hv === dv ? (hv ? "一致" : "両方空") : hv ? (dv ? "日付違い" : "ほのぼのだけ") : "DB から導出しただけ (ほのぼの空)"}`, { key, ほ: hv, 導出: dv });
    }
  }
  why.print("原因の切り分け (診断)");

  // ── 負のコントロール: 新システム側を 1 か所わざと壊して検出できるか ──
  console.log("\n══ 負のコントロール ══");
  const broken = parseKk(built.content);
  const firstDetail = broken.recs.find((r) => r.v[1] === "02" && r.v[0] !== "7111");
  const firstHead = broken.recs.find((r) => r.v[1] === "01" && r.v[0] !== "7111");
  let ncOk = true;
  if (firstDetail && firstHead) {
    const before = compare(hono, receipts(mk.recs), nameOf);
    firstDetail.v[13] = String(Number(firstDetail.v[13]) + 1);
    firstHead.v[14] = firstHead.v[14] === "21" ? "22" : "21";
    const after = compare(hono, receipts(broken.recs), nameOf);
    const d02 = [...after.B.f02.m.values()].reduce((s, v) => s + v.length, 0) - [...before.B.f02.m.values()].reduce((s, v) => s + v.length, 0);
    const d01 = after.B.f01.count(`${firstHead.v[0]}-01 項15 要介護度`) - before.B.f01.count(`${firstHead.v[0]}-01 項15 要介護度`);
    ncOk = d02 >= 1 && d01 === 1;
    console.log(`  明細のサービス単位数を +1 → 明細差 +${d02} / 要介護度を書き換え → 基本差 +${d01}  ${ncOk ? "OK (検出できた)" : "★ NG 検出できない = この突合は壊れている"}`);
  } else { ncOk = false; console.log("  ★ NG 壊す対象が無い"); }

  const out = arg("--out");
  if (out) {
    writeFileSync(out, JSON.stringify({ month: MONTH, stat, warnings: built.warnings, rec: B.rec, f7111: B.f7111, f01: B.f01, f02: B.f02, f10: B.f10, fmt: B.fmt }, null, 1));
    console.log(`\n→ ${out}`);
  }
  console.log(`\n⚠ 月遅れ分 (KK261001〜003 = 提供 2026-06〜08) は範囲外 (DB は 2026-09 提供分に合わせただけ)。`);
  if (!ncOk) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
