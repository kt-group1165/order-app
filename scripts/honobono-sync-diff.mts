/**
 * ほのぼの福祉用具 (KDS0031 明細書明細付 CSV) と order-app DB の差分レポート — ★ READ ONLY
 *
 *   npx tsx scripts/honobono-sync-diff.mts --csv <KDS0031_R8-09.CSV> [--month 2026-09] [--out <json>]
 *                                          [--db-cache <json>] [--refresh]
 *
 * ★ DB は一切書き換えない (service_role で SELECT するだけ)。
 * ★ 重い全件読みは 1 回だけにする: DB の読み込み結果を --db-cache (既定 = CSV と同じフォルダの
 *   db_snapshot.json) に保存し、2 回目以降はそれを読む。最新を読み直すときは --refresh。
 *
 * ── 何と何を比べるか ─────────────────────────────────────────────────────
 *   CSV: ほのぼの 国保請求 → CSV → 明細書明細付 (SJIS / 76 列 / 1 行 = 1 明細行。
 *        基本情報・合計情報は各行に重複して付く)。
 *   DB : order-app の **伝送を組む処理と同じ条件** で当月の請求対象を組み直したもの。
 *        根拠 = app/[tenant]/BillingTab.tsx (2026-11-09 時点)
 *          - 読込      L359-375  clients は clients.office_id = 事業所 & deleted_at null (getClients)
 *                               orders は orders.office_id = 事業所 (getAllOrders。cancelled も含む)
 *          - 当月有効  L439-458  activeRentals: payment_type (明細 → 発注 → "介護") = 介護 /
 *                               rental_start_date <= 月末 / status ∈ {rental_started, terminated} /
 *                               ★ 終了日は status=terminated のときだけ見る
 *          - 利用者束ね L461-480  clientGroups: order.client_id が上の clients にいるもの
 *          - 月遅れ    L417-436 + L702-706  認定 certification_status=申請中 / billing_late_flags は伝送から外す
 *          - 単位数    L542-573  getUnits: billing_unit_overrides(当月, order_item_id) が最優先、
 *                               無ければ 価格履歴(当月) → equipment_master.rental_price を round(/10)、
 *                               入院・貸与期間で半月按分 (lib/half-month-units.ts)
 *          - 明細      L756-786  units = unitPer × quantity / units<=0 は出さない /
 *                               サービスコード = fukuyoguServiceCode(equipment.category) (null は出さない)
 *          - 金額      L820-829  computeFukuyoguAmounts (lib/kokuho-densou/fukuyogu-amounts.ts)
 *          - 公費      L712-723  client_public_expenses: hohei_code あり & 有効期間が当月に掛かる最初の 1 件
 *          - 7131 基本 L833-858  ★ 保険者・被保番・要介護度・認定期間・給付率 は **clients の列** を使う
 *                               (client_insurance_records ではない)。居宅事業所番号は clients.care_office_id
 *   ⚠ lib/ceilingCheck.ts の isCareRentalInMonth は rental_started でも終了日を見るので BillingTab と違う。
 *     伝送は BillingTab 側なのでこちらに合わせ、食い違う行数は別掲する。
 *
 * ── 利用者の突合キー ─────────────────────────────────────────────────────
 *   第一 (保険者番号, 被保険者番号)。被保番は保険者の中でしか一意でない。clients と
 *   client_insurance_records の両方から引く。複数一致は 当月請求対象 → 生年月日 → 利用者番号 で絞る。
 *   0 件のときだけ 補助: 利用者番号+生年月日 → 氏名+生年月日。user_number 単独では信用しない。
 *
 * ★ CSV の読み方・当月有効・単位数・突合は scripts/_honobono-sync-core.mts に切り出してある
 *   (migrations/sync_fukuyogu_from_honobono.mjs と同じ判定を使うため。2026-11-09)。
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  C, PROVIDER_BN, readKds0031, loadSnapshot, loadLibs, buildBillingModel, groupCsvUsers, repReceipt, buildMatchIndex, matchCsvUser,
  nfkc, nName, nKana, nInsurer, nInsured, nCare, nDate, nRate, nGender, toInt, ymOf, daysIn,
  type EqRow,
} from "./_honobono-sync-core.mjs";

// ── 引数 ──────────────────────────────────────────────────────────────────
function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const CSV_PATH = arg("--csv");
if (!CSV_PATH) {
  console.error("usage: npx tsx scripts/honobono-sync-diff.mts --csv <KDS0031.CSV> [--month YYYY-MM]");
  process.exit(1);
}
const OUT_PATH = arg("--out") ?? join(dirname(resolve(CSV_PATH)), "diff_report.json");
const CACHE_PATH = arg("--db-cache") ?? join(dirname(resolve(CSV_PATH)), "db_snapshot.json");
const REFRESH = process.argv.includes("--refresh");

// ── 例の収集 ──────────────────────────────────────────────────────────────
class Buckets {
  private m = new Map<string, unknown[]>();
  add(cat: string, ex: unknown) { if (!this.m.has(cat)) this.m.set(cat, []); this.m.get(cat)!.push(ex); }
  touch(cat: string) { if (!this.m.has(cat)) this.m.set(cat, []); }
  toJSON() { return Object.fromEntries([...this.m].map(([k, v]) => [k, { count: v.length, items: v }])); }
  print(title: string) {
    console.log(`\n══ ${title} ══`);
    for (const [k, v] of this.m) {
      console.log(`  ${String(v.length).padStart(5)}  ${k}`);
      for (const e of v.slice(0, 10)) console.log(`         - ${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const libs = await loadLibs();
  const { computeFukuyoguAmounts, fukuyoguServiceCode, getPriceForMonth } = libs;

  // CSV
  const { rows, monthCount } = readKds0031(CSV_PATH!);
  const MONTH = arg("--month") ?? [...monthCount].sort((a, b) => b[1] - a[1])[0][0];
  const providers = new Set(rows.map((r) => r[C.PROVIDER]));
  console.log(`CSV: ${CSV_PATH}\n  ${rows.length} 行 / 提供年月 ${[...monthCount].map(([k, v]) => `${k}:${v}`).join(" ")} / 事業所 ${[...providers].join(",")}`);
  console.log(`比較する提供月: ${MONTH}`);
  const mRows = rows.filter((r) => ymOf(r[C.SVC_MONTH]) === MONTH);

  const snap = await loadSnapshot(MONTH, CACHE_PATH, REFRESH);
  const office = snap.offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
  if (!office) throw new Error(`offices に business_number=${PROVIDER_BN} が無い`);
  console.log(`事業所: ${office.name} (${office.id})`);

  const model = buildBillingModel(snap, MONTH, office.id, libs);
  const { clientById, careOfficeNo, lateFlag, monthEndS, pickIns, pickKohi, officeClients, dbLines, dbSkipped, activeOtherScope, activeCount, ceilingCheckDiffers, autoLate, isLate, dbTargets } = model;

  const csvUsers = groupCsvUsers(mRows);

  // ── 突合 ─────────────────────────────────────────────────────────────
  const idx = buildMatchIndex(snap);
  const B_user = new Buckets(), B_ins = new Buckets(), B_items = new Buckets(), B_tot = new Buckets(), B_eq = new Buckets();
  const matched = new Map<string, string>(); // csv key → client_id
  const matchMethod = new Map<string, number>();
  const bump = (k: string) => matchMethod.set(k, (matchMethod.get(k) ?? 0) + 1);

  for (const u of csvUsers.values()) {
    const ex = { 保険者: u.insurer, 被保番: u.insured, 利用者番号: u.userNo, 氏名: u.name, 生年月日: u.birth };
    const mr = matchCsvUser(u, idx, clientById, (cid) => dbLines.has(cid) || dbSkipped.has(cid));
    if (mr.status === "ambiguous") {
      B_user.add("★ 保険者+被保番で複数の client に一致 (絞り切れず比較対象外)", { ...ex, 候補: mr.cands.map((c) => `${c.name}/${c.user_number}/${c.birth_date}/${c.id}${c.deleted_at ? "(削除)" : ""}`) });
      bump("複数一致");
      continue;
    }
    if (mr.status === "none") {
      B_user.add("CSV にいて DB にいない (保険者+被保番 0 件・補助キーでも一意に引けない)", { ...ex, 同じ利用者番号のDB: mr.hint, 氏名生年月日一致数: mr.nbCount });
      bump("0 件");
      continue;
    }
    const c = mr.client;
    const method = mr.method;
    if (mr.viaAux) B_user.add(`保険者+被保番では 0 件、${method.split(" ")[0]} で一致 (= DB の保険者/被保番がほのぼのと違う)`, { ...ex, DB: `${c.name}/${c.insurer_number}|${c.insured_number}/${c.id}` });
    bump(method);
    matched.set(u.key, c.id);
    if (c.deleted_at) B_user.add("一致した client が削除済み (deleted_at あり)", { ...ex, client_id: c.id });
    // 1. 属性
    if (nName(c.name) !== nName(u.name)) B_user.add("氏名の差", { ...ex, DB: c.name });
    if (nKana(c.furigana) !== nKana(u.kana)) B_user.add(c.furigana ? "フリガナの差" : "フリガナ DB 空", { ...ex, CSV: u.kana, DB: c.furigana });
    if (nDate(c.birth_date) !== u.birth) B_user.add("生年月日の差", { ...ex, DB: c.birth_date });
    if (nGender(c.gender) !== u.gender) B_user.add("性別の差", { ...ex, CSV: u.gender, DB: c.gender });
    if (u.receipts.size > 1) B_user.add("同月に複数レセプト (要支援↔要介護の切替等。代表 = 月末有効の認定)", { ...ex, 番号: [...u.receipts.keys()] });

    // 2. 保険 (clients = 伝送が使う列 / 認定 = 当月有効の client_insurance_records)
    const rr = repReceipt(u, monthEndS);
    const want = {
      要介護度: nCare(rr[C.CARE_LEVEL]), 認定開始: nDate(rr[C.CERT_START]), 認定終了: nDate(rr[C.CERT_END]),
      保険者: nInsurer(rr[C.INSURER]), 被保番: nInsured(rr[C.INSURED]), 給付率: nRate(rr[C.BENEFIT]), 居宅事業所: nfkc(rr[C.CARE_OFFICE]),
    };
    const fromClient = {
      要介護度: nCare(c.care_level), 認定開始: nDate(c.certification_start_date), 認定終了: nDate(c.certification_end_date),
      保険者: nInsurer(c.insurer_number), 被保番: nInsured(c.insured_number), 給付率: nRate(c.benefit_rate),
      居宅事業所: c.care_office_id ? careOfficeNo.get(c.care_office_id) ?? "" : "",
    };
    const ir = pickIns(c.id);
    for (const f of Object.keys(want) as (keyof typeof want)[]) {
      if (fromClient[f] !== want[f]) B_ins.add(`clients.${f} の差 (★ 伝送はこの列を使う)`, { ...ex, CSV: want[f], DB: fromClient[f] });
    }
    if (!ir) B_ins.add("当月有効な client_insurance_records が無い", ex);
    else {
      const fromIns = {
        要介護度: nCare(ir.care_level), 認定開始: nDate(ir.certification_start_date), 認定終了: nDate(ir.certification_end_date),
        保険者: nInsurer(ir.insurer_number), 被保番: nInsured(ir.insured_number), 給付率: nRate(ir.benefit_rate),
        居宅事業所: nfkc(ir.care_office_number) || (ir.care_office_id ? careOfficeNo.get(ir.care_office_id) ?? "" : ""),
      };
      for (const f of Object.keys(want) as (keyof typeof want)[]) {
        if (fromIns[f] !== want[f]) B_ins.add(`認定(client_insurance_records).${f} の差`, { ...ex, CSV: want[f], DB: fromIns[f], record_id: ir.id });
      }
    }
    // 公費
    const fut = nfkc(rr[C.FUTAN1]);
    const juk = nfkc(rr[C.JUKYU1]);
    const k = pickKohi(c.id);
    if (fut && !k) B_ins.add("公費: CSV にあり DB (client_public_expenses 当月有効) に無い", { ...ex, 法別: fut.slice(0, 2), 負担者: fut, 受給者: juk });
    else if (!fut && k) B_ins.add("公費: DB にあり CSV に無い", { ...ex, DB: `${k.hohei_code}/${k.futan_sha_number}/${k.jukyu_sha_number}` });
    else if (fut && k) {
      if (nfkc(k.hohei_code) !== fut.slice(0, 2)) B_ins.add("公費: 法別の差", { ...ex, CSV: fut.slice(0, 2), DB: k.hohei_code });
      if (nfkc(k.futan_sha_number) !== fut) B_ins.add("公費: 負担者番号の差", { ...ex, CSV: fut, DB: k.futan_sha_number });
      if (nfkc(k.jukyu_sha_number) !== juk) B_ins.add("公費: 受給者番号の差", { ...ex, CSV: juk, DB: k.jukyu_sha_number });
    }

    // 3. 貸与用具
    const dl = dbLines.get(c.id) ?? [];
    const skipped = dbSkipped.get(c.id) ?? [];
    if (dl.length === 0) {
      const other = activeOtherScope.get(c.id);
      const why = other ? `当月有効な介護の明細はあるが請求範囲外 (${[...new Set(other.map((o) => o.why))].join(" / ")})` :
        skipped.length ? `有効明細はあるが全部請求に乗らない (${[...new Set(skipped.map((s) => s.skipped))].join(" / ")})` :
          "当月有効な介護の貸与明細が DB に 1 行も無い";
      B_user.add(`DB に居るが当月の請求対象でない — ${why.split(" (")[0]}`, { ...ex, client_id: c.id, 理由: why });
    }
    if (isLate(c.id)) B_user.add("DB では月遅れ扱い (申請中 / 月遅れフラグ) で伝送から外れる", { ...ex, client_id: c.id, 申請中: autoLate.has(c.id), フラグ: lateFlag.has(c.id) });
    for (const s of skipped) B_items.add(`DB 有効明細が請求に乗らない — ${s.skipped!.split(" (")[0]}`, { ...ex, TAIS: s.tais, 理由: s.skipped });
    if (dl.length === 0 && !activeOtherScope.has(c.id) && skipped.length === 0) {
      // 用具差分は「DB に 1 行も無い」でまとめて出す (行ごとには出さない)
    }
    const group = <T,>(arr: T[], key: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of arr) { const kk = key(x); if (!m.has(kk)) m.set(kk, []); m.get(kk)!.push(x); } return m; };
    const cg = group(u.lines, (l) => l.tais);
    const dg = group(dl, (l) => l.tais);
    for (const [tais, cl] of cg) {
      const d = dg.get(tais);
      const cUnits = cl.reduce((s, l) => s + l.units, 0);
      if (!d) {
        B_items.add(dl.length === 0 ? "CSV のみの用具 (DB に請求対象の明細が 1 行も無い利用者)" : "CSV のみの用具 (DB の請求明細に無い TAIS)", { ...ex, TAIS: tais, コード: cl.map((l) => l.code), 単位: cUnits, 日数: cl.map((l) => l.days) });
        continue;
      }
      const dUnits = d.reduce((s, l) => s + l.units, 0);
      const dCount = d.reduce((s, l) => s + l.count, 0);
      if (cl.length !== dCount) B_items.add("同じ TAIS の数量の差 (CSV 行数 vs DB quantity 合計)", { ...ex, TAIS: tais, CSV: cl.length, DB: dCount });
      if (cUnits !== dUnits) B_items.add("単位数の差", { ...ex, TAIS: tais, CSV: cUnits, DB: dUnits, CSV日数: cl.map((l) => l.days), DB上書き: d.some((x) => x.overridden), DB半月: d.some((x) => x.half) });
      const cItems = new Set(cl.map((l) => l.item));
      const dItems = new Set(d.map((l) => (l.code ?? "").slice(2)));
      if ([...cItems].join() !== [...dItems].join()) B_items.add("サービス項目コード(下4桁)の差", { ...ex, TAIS: tais, CSV: cl.map((l) => l.code), DB: d.map((l) => l.code) });
      const cKinds = new Set(cl.map((l) => l.kind));
      const dKinds = new Set(d.map((l) => (l.code ?? "").slice(0, 2)));
      if ([...cKinds].join() !== [...dKinds].join()) B_items.add("サービス種類の差 (CSV 67=予防 / DB は種目から常に 17)", { ...ex, TAIS: tais, CSV: [...cKinds], DB: [...dKinds], 要介護度: want.要介護度 });
    }
    for (const [tais, d] of dg) {
      if (!cg.has(tais)) B_items.add("DB のみの用具 (CSV に無い TAIS)", { ...ex, TAIS: tais, 単位: d.reduce((s, l) => s + l.units, 0), item_ids: d.map((l) => l.itemId) });
    }

    // 4. 合計 (CSV はレセプトごとに重複して付くので 番号で 1 回ずつ足す)
    if (dl.length > 0) {
      let cu = 0, ci = 0, cs = 0, ck = 0;
      for (const r of u.receipts.values()) { cu += toInt(r[C.TOT_UNITS]); ci += toInt(r[C.TOT_INS]); cs += toInt(r[C.TOT_USER]); ck += toInt(r[C.K1_CLAIM]); }
      const totalUnits = dl.reduce((s, l) => s + l.units, 0);
      const kk = pickKohi(c.id);
      const amt = computeFukuyoguAmounts({
        benefitRateRaw: c.benefit_rate, insuredNumber: c.insured_number, totalUnits,
        kohi: kk ? { hobetsu: kk.hohei_code!, futansha: kk.futan_sha_number, jukyusha: kk.jukyu_sha_number } : null,
      });
      const dk = amt.kohiAmount ?? 0;
      const diffs: string[] = [];
      if (cu !== totalUnits) diffs.push("単位数");
      if (ci !== amt.insuranceAmount) diffs.push("保険請求額");
      if (cs !== amt.userAmount) diffs.push("利用者負担");
      if (ck !== dk) diffs.push("公費請求額");
      const exT = { ...ex, CSV: { 単位: cu, 保険: ci, 本人: cs, 公費: ck }, DB: { 単位: totalUnits, 保険: amt.insuranceAmount, 本人: amt.userAmount, 公費: dk }, 月遅れ: isLate(c.id) };
      if (diffs.length === 0) B_tot.add("一致", null);
      else if (!diffs.includes("単位数")) B_tot.add("単位数は一致・金額だけ差 (給付率 / 公費の差)", { ...exT, 差: diffs });
      else B_tot.add("単位数の差 (金額も連動)", { ...exT, 差: diffs });
    }
  }

  // DB 当月請求対象なのに CSV にいない
  const matchedIds = new Set(matched.values());
  for (const cid of dbTargets) {
    if (matchedIds.has(cid)) continue;
    const c = clientById.get(cid)!;
    // 月遅れ (8・7・6 月提供) で請求されていれば別掲
    const keyc = `${nInsurer(c.insurer_number)}|${nInsured(c.insured_number)}`;
    const otherMonth = rows.filter((r) => `${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}` === keyc).map((r) => ymOf(r[C.SVC_MONTH]));
    const lines = dbLines.get(cid)!;
    B_user.add(isLate(cid) ? "DB 当月請求対象 (DB でも月遅れ扱い) で CSV の当月にいない" : "★ DB 当月請求対象なのに CSV の当月にいない",
      { 氏名: c.name, 利用者番号: c.user_number, 保険者: c.insurer_number, 被保番: c.insured_number, client_id: cid, 明細数: lines.length, 単位: lines.reduce((s, l) => s + l.units, 0), CSVの他月: [...new Set(otherMonth)] });
  }

  // ── 用具マスタ (CSV 全月) ─────────────────────────────────────────────
  const eqByTais = new Map<string, EqRow[]>();
  for (const e of snap.equipment) {
    for (const k of new Set([e.tais_code, e.product_code].filter((x): x is string => !!x).map(nfkc))) {
      if (!eqByTais.has(k)) eqByTais.set(k, []);
      eqByTais.get(k)!.push(e);
    }
  }
  type TaisAgg = { items: Set<string>; kinds: Set<string>; names: Set<string>; full: Map<number, number>; rows: number; users: Set<string> };
  const taisAgg = new Map<string, TaisAgg>();
  for (const r of rows) {
    const t = nfkc(r[C.TAIS]);
    if (!t) continue;
    let a = taisAgg.get(t);
    if (!a) { a = { items: new Set(), kinds: new Set(), names: new Set(), full: new Map(), rows: 0, users: new Set() }; taisAgg.set(t, a); }
    a.rows++;
    a.users.add(r[C.USER_NO]);
    a.items.add(nfkc(r[C.SVC_ITEM]).padStart(4, "0"));
    a.kinds.add(nfkc(r[C.SVC_KIND]).slice(0, 2));
    a.names.add(nfkc(r[C.SVC_NAME]));
    // 月を通して貸与 (日数 = その月の日数) の行だけ = 半月按分されていない 月額相当
    if (toInt(r[C.DAYS]) === daysIn(ymOf(r[C.SVC_MONTH]))) { const u = toInt(r[C.SVC_UNITS]); a.full.set(u, (a.full.get(u) ?? 0) + 1); }
  }
  for (const [t, a] of taisAgg) {
    const ex = { TAIS: t, サービス項目: [...a.names], コード: [...a.kinds].flatMap((k) => [...a.items].map((i) => k + i)), 行数: a.rows, 利用者数: a.users.size };
    const es = eqByTais.get(t) ?? [];
    if (es.length === 0) { B_eq.add(t.includes("-Z") ? "equipment_master に無い (Z 付き = TAIS 未登録の独自コード)" : "equipment_master に無い TAIS", ex); continue; }
    if (es.length > 1) B_eq.add("equipment_master に同じ TAIS が複数行", { ...ex, DB: es.map((e) => `${e.product_code}/${e.category}/${e.rental_price}/${e.kind}`) });
    // 請求 (BillingTab) は order_items.product_code = TAIS で equipment_master.product_code を引くので、その行を優先
    const e = es.find((x) => x.product_code === t) ?? es[0];
    if (e.product_code !== t) B_eq.add("product_code = TAIS の行が無い (tais_code だけ一致。請求の単価引きは product_code)", { ...ex, DB: es.map((x) => x.product_code) });
    const code = fukuyoguServiceCode(e.category);
    if (!code) B_eq.add("種目 (category) からサービスコードが引けない", { ...ex, category: e.category, kind: e.kind });
    else if (!a.items.has(code.slice(2)) || a.items.size > 1) B_eq.add("種目 (category) とサービス項目コードが合わない", { ...ex, category: e.category, DBコード: code });
    if (a.items.size > 1) B_eq.add("CSV 内で同じ TAIS に複数のサービス項目コード", ex);
    if (a.full.size === 0) { B_eq.touch("価格: 月を通した行が無く比較できない"); B_eq.add("価格: 月を通した行が無く比較できない", { TAIS: t }); continue; }
    const mode = [...a.full].sort((x, y) => y[1] - x[1])[0][0];
    if (a.full.size > 1) B_eq.add("価格: CSV 内で同じ TAIS の月額単位が複数 (利用者ごとに違う)", { ...ex, 単位と件数: Object.fromEntries(a.full) });
    const master = e.rental_price != null ? Math.round(e.rental_price / 10) : null;
    const eff = getPriceForMonth(snap.priceHist as never, e.product_code, MONTH);
    const effU = eff != null ? Math.round(eff / 10) : master;
    if (master !== mode) B_eq.add("価格: equipment_master.rental_price/10 と CSV 月額単位 (最頻) が違う", { ...ex, CSV単位: mode, DB単位: master, DB価格: e.rental_price, 履歴の当月価格: eff });
    if (effU !== mode && eff != null) B_eq.add(`価格: 当月有効価格 (価格履歴優先 = 請求が使う値) と CSV が違う`, { ...ex, CSV単位: mode, DB単位: effU });
  }
  B_eq.add("※ 商品名は KDS0031 に無い (列74 はサービス項目名のみ)。名前の突合には ほのぼのの用具マスタ CSV が別途要る", null);

  // ── 出力 ─────────────────────────────────────────────────────────────
  const csvTotalRows = mRows.length;
  const denom = {
    CSV: { 全行: rows.length, 当月行: csvTotalRows, 当月利用者_保険者被保番: csvUsers.size, 当月利用者番号: new Set(mRows.map((r) => r[C.USER_NO])).size, 当月レセプト: new Set(mRows.map((r) => r[C.RECEIPT_NO])).size, TAIS種類_全月: taisAgg.size },
    DB: {
      clients_tenant全体: snap.clients.length, clients_事業所かつ未削除: officeClients.size, 認定行: snap.ins.length, 公費行: snap.kohi.length,
      order_items: snap.items.length, 当月有効の介護明細_全事業所: activeCount, 当月請求対象の利用者: dbTargets.length,
      当月請求明細: [...dbLines.values()].reduce((s, l) => s + l.length, 0), うち月遅れで伝送から外れる利用者: dbTargets.filter(isLate).length,
      単位上書き_当月: snap.overrides.length, equipment_master: snap.equipment.length,
      ceilingCheck版の有効判定と食い違う行: ceilingCheckDiffers,
    },
    突合方法: Object.fromEntries(matchMethod),
  };
  console.log("\n══ 分母 ══");
  console.log(JSON.stringify(denom, null, 2));
  B_user.print("1. 利用者");
  B_ins.print("2. 保険・公費");
  B_items.print("3. 貸与用具 (当月)");
  B_tot.print("4. 合計 (利用者ごとの単位数・保険請求額・利用者負担・公費請求額)");
  B_eq.print("5. 用具マスタ (CSV 全月の TAIS)");
  const report = { generatedAt: new Date().toISOString(), csv: CSV_PATH, month: MONTH, office, dbFetchedAt: snap.fetchedAt, denom,
    users: B_user.toJSON(), insurance: B_ins.toJSON(), items: B_items.toJSON(), totals: B_tot.toJSON(), equipment: B_eq.toJSON() };
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n詳細: ${OUT_PATH}`);
  console.log("★ READ ONLY。DB は書き換えていない。");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
