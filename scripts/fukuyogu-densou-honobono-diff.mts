/**
 * 福祉用具 国保連伝送: order-app が DB から組む伝送 と ほのぼのの実伝送 (KK) の突合 — ★ READ ONLY
 *
 *   npx tsx scripts/fukuyogu-densou-honobono-diff.mts --kk <KK261004.CSV> [--month 2026-09]
 *        [--db-cache <json>] [--refresh] [--out <json>] [--benefit-from-csv] [--pauses-from-notes | --no-pauses]
 *   npx tsx scripts/fukuyogu-densou-honobono-diff.mts --kds <KDS0031_明細書明細付.CSV> [--month 2026-10] …
 *   [--db-base <別の月の控え json>] … 全件読みをせず、月で絞る 2 表 (単位上書き・月遅れフラグ) だけ読み直して使い回す
 *
 *   ★ --kds (2026-11-13): KK がまだ出せない月 (ほのぼので未確定) は 明細書明細付 KDS0031 を答えにする。
 *   KDS の行から 7131/7132 のレセプト (01 基本 + 02 明細) を組み、KK と同じ比較の口に乗せる。
 *   KDS に無い項目 (10 集計・7111・明細の 単位数/公費 2-3 等) は 両側とも空にして比べない (= 投影)。
 *   比べる項目: 01 = 保険者/被保番/公費1 負担者・受給者/生年月日/性別/要介護度/認定期間/計画作成区分/居宅事業所/
 *   開始・中止年月日/保険給付率/公費1給付率/保険単位数・請求額・利用者負担/公費1 単位数・請求額・本人負担、
 *   02 = 種類・項目/日数/公費1日数/サービス単位数/公費1単位数/摘要(TAIS)。提供年月 = 当月の行だけ (月遅れ行は外す)。
 *
 *   休止 (2026-11-09 FY-PZ): 貸与の休止期間 order_item_pauses (migrations/order_item_pauses.sql) を読み、
 *   BillingTab と同じく 明細 項10 日数 と 半月按分の判定 から休止日を除く。表が未作成なら警告して休止なし。
 *   --pauses-from-notes を付けると、表が未作成でも order_items.notes の "[休止 YYYY-MM-DD〜YYYY-MM-DD]" を
 *   メモリ上で表の代わりにする (投入後の見込みを測る)。--no-pauses は休止を一切使わない (投入前の比較用)。
 *
 *   給付率 (2026-11-09 FY-H): BillingTab と同じく「提供月に掛かる負担割合証 → 無ければ認定行」
 *   (lib/insurance/cert-month.ts の resolveBenefitForMonth)。表 client_benefit_certificates が未作成なら
 *   BillingTab と同じく clients.benefit_rate。--benefit-from-csv を付けると、表が未作成でも
 *   ほのぼのの負担割合証等 CSV (ケアサポ + 全社) をメモリ上で表の代わりにする (取込後の見込みを測る)。
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
 *     貸与日数 = fukuyoguRentalDaysInMonth / 開始・中止 = fukuyoguServicePeriod (build.ts の本物) /
 *     ★ CM 指示単位数 = fukuyogu_cm_units (その月・その事業所。請求画面と同じ。表が未適用なら警告して全員 入力なし)
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
  PROVIDER_BN, TENANT, loadSnapshot, rebaseSnapshot, loadLibs, buildBillingModel, ymOf, readEnv, readKds0031, C, type ItemRow,
} from "./_honobono-sync-core.mjs";
import {
  buildFukuyoguDensou, fukuyoguRentalDaysInMonth, careLevelCodeForDensou,
  type FukuyoguSeikyuRow, type FukuyoguDetailLine,
} from "../lib/kokuho-densou/build";
import { densouExcludeReasons, DENSOU_EXCLUDE_LABEL, type DensouExcludeReason } from "../lib/kokuho-densou/densou-exclude";
import { certFieldsForDensou } from "../lib/kokuho-densou/cert-for-month";
import { fukuyoguServiceStartDate, fukuyoguServiceStopDate } from "../lib/kokuho-densou/fukuyogu-period";
import { resolveBenefitForMonth, type BenefitCertRow } from "../lib/insurance/cert-month";
import { serviceClient, loadBenefitCertsDbOrCsv } from "./_futan-period-core.mjs";
import { resolveFukuyoguOffice, latestUserMasterDate } from "../migrations/_fukuyogu_office.mjs";
/** 対象事業所 (既定 ケアサポ。--area / --office-bn)。PROVIDER_BN (core) と同じ引数から決まる */
const FO = resolveFukuyoguOffice(process.argv.slice(2));
const UMD = latestUserMasterDate(FO.area);

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const KK = arg("--kk");
const KDS = arg("--kds");
if (!KK === !KDS) {
  console.error("usage: npx tsx scripts/fukuyogu-densou-honobono-diff.mts (--kk <KK261004.CSV> | --kds <KDS0031.CSV>) [--month YYYY-MM]");
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

// ── KDS0031 (明細書明細付) → KK と同じ形のレセプト ─────────────────────────
//   v の位置は KK の「項1 = 交換情報識別番号」から (項番 - 1)。KDS に無い項目は空。
const KEEP01 = [0, 1, 4, 5, 6, 7, 12, 13, 14, 16, 17, 18, 19, 20, 21, 28, 29, 32, 33, 34, 38, 39, 40];
const KEEP02 = [0, 1, 4, 5, 6, 7, 9, 10, 13, 14, 17];
const LEN01 = 41, LEN02 = 18;
const mkRec = (len: number, set: Record<number, string>): Rec => {
  const v = Array.from({ length: len }, (_, i) => set[i] ?? "");
  return { raw: v, v };
};
/** KK のレコードを KDS にある項目だけに絞る (無い項目は空)。書式差は見ない (raw = 値) */
const proj = (r: Rec, keep: number[], len: number): Rec => mkRec(len, Object.fromEntries(keep.map((i) => [i, r.v[i] ?? ""])));
function projectReceipts(rs: ReturnType<typeof receipts>): ReturnType<typeof receipts> {
  const byKey = new Map<string, Receipt>();
  for (const [k, r] of rs.byKey) byKey.set(k, { key: k, form: r.form, h: proj(r.h, KEEP01, LEN01), d: r.d.map((d) => proj(d, KEEP02, LEN02)), s: null });
  return { r7111: [], byKey };
}
const kdsDate = (s: string) => { const m = (s ?? "").trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/); return m ? `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : ""; };
const kdsCare = (s: string) => {
  const t = (s ?? "").normalize("NFKC").trim();
  let m = t.match(/^要介護度?(\d)$/); if (m) return `2${m[1]}`;
  m = t.match(/^要支援度?(\d)$/); if (m) return `1${Number(m[1]) + 1}`;
  if (t) throw new Error(`★ KDS 要介護状態区分 を読めない: ${t}`);
  return "";
};
const KDS_PLAN: Record<string, string> = { "指定居宅介護支援事業所作成": "1", "自己作成": "2", "介護予防支援事業所・地域包括支援センター作成": "3" };
const KDS_FORM: Record<string, string> = { "様式2": "7131", "様式2-2": "7132" };
function kdsReceipts(rows: string[][], month: string): { r: ReturnType<typeof receipts>; dupKeys: string[]; nameByKey: Map<string, string> } {
  const byKey = new Map<string, Receipt>();
  const noByKey = new Map<string, string>();
  const nameByKey = new Map<string, string>();
  const dup = new Set<string>();
  for (const r of rows) {
    if (ymOf(r[C.SVC_MONTH]) !== month) continue;
    const form = KDS_FORM[r[C.FORM].trim()];
    if (!form) throw new Error(`★ KDS 様式 を読めない: ${r[C.FORM]}`);
    const ins8 = r[C.INSURER].replace(/\D/g, "").padStart(8, "0");
    const insured = r[C.INSURED].trim();
    const key = `${form}|${ins8}|${insured}`;
    const no = r[C.RECEIPT_NO];
    let rc = byKey.get(key);
    if (!rc) {
      const plan = r[C.PLAN_KUBUN].trim();
      if (plan && !KDS_PLAN[plan]) throw new Error(`★ KDS 計画作成区分 を読めない: ${plan}`);
      const g = r[C.GENDER].trim();
      rc = {
        key, form, d: [], s: null,
        h: mkRec(LEN01, {
          0: form, 1: "01", 4: ins8, 5: insured, 6: r[C.FUTAN1].trim(), 7: r[C.JUKYU1].trim(),
          12: kdsDate(r[C.BIRTH]), 13: g.startsWith("男") ? "1" : g.startsWith("女") ? "2" : g,
          14: kdsCare(r[C.CARE_LEVEL]), 16: kdsDate(r[C.CERT_START]), 17: kdsDate(r[C.CERT_END]),
          18: KDS_PLAN[plan] ?? "", 19: r[C.CARE_OFFICE].trim(), 20: kdsDate(r[25]), 21: kdsDate(r[26]),
          28: r[C.BENEFIT].trim(), 29: r[C.KOHI1_RATE].trim(),
          32: r[C.TOT_UNITS].trim(), 33: r[C.TOT_INS].trim(), 34: r[C.TOT_USER].trim(),
          38: r[C.K1_UNITS].trim(), 39: r[C.K1_CLAIM].trim(), 40: r[C.K1_SELF].trim(),
        }),
      };
      byKey.set(key, rc); noByKey.set(key, no); nameByKey.set(key, r[C.NAME]);
    } else if (noByKey.get(key) !== no) { dup.add(key); continue; } // 同じキーで別のレセプト番号 = 2 本目は比べない (別掲)
    rc.d.push(mkRec(LEN02, {
      0: form, 1: "02", 4: ins8, 5: insured, 6: r[C.SVC_KIND].split(".")[0].trim(), 7: r[C.SVC_ITEM].trim(),
      9: r[C.DAYS].trim(), 10: r[66].trim(), 13: r[C.SVC_UNITS].trim(), 14: r[70].trim(), 17: r[C.TAIS].trim(),
    }));
  }
  return { r: { r7111: [], byKey }, dupKeys: [...dup], nameByKey };
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
      for (const e of v.slice(0, Number(process.env.DIFF_SHOW ?? 10))) console.log(`         - ${typeof e === "string" ? e : JSON.stringify(e)}`);
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
//   開始・中止とも lib/kokuho-densou/fukuyogu-period.ts の本物 (2026-11-13 に 逐語の derivePeriod から寄せた)。
//   ★ 請求画面が渡しているのは 開始だけ。中止は 項23 中止理由 が決められないので 案のまま (lib の注記を参照)

/**
 * 貸与の休止期間 (order_item_id → 期間)。★ READ ONLY。
 *   既定 = 表 order_item_pauses。未作成なら警告して空 (--pauses-from-notes なら notes を代わりに読む)。--no-pauses = 空
 */
async function loadPauses(): Promise<Map<string, { from: string; to: string | null }[]>> {
  const out = new Map<string, { from: string; to: string | null }[]>();
  const add = (id: string, from: string, to: string) => { if (!out.has(id)) out.set(id, []); out.get(id)!.push({ from, to }); };
  if (process.argv.includes("--no-pauses")) { console.log("  休止: 使わない (--no-pauses)"); return out; }
  const env = readEnv();
  const h = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  const pageAll = async <T,>(path: string): Promise<{ ok: true; rows: T[] } | { ok: false; status: number; text: string }> => {
    const rows: T[] = [];
    for (let from = 0; ; from += 1000) {
      const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}&order=id&limit=1000&offset=${from}`, { headers: h });
      if (!res.ok) return { ok: false, status: res.status, text: (await res.text()).slice(0, 160) };
      const page = (await res.json()) as T[];
      rows.push(...page);
      if (page.length < 1000) return { ok: true, rows };
    }
  };
  const t = await pageAll<{ order_item_id: string; pause_from: string; pause_to: string }>(`order_item_pauses?select=order_item_id,pause_from,pause_to&tenant_id=eq.${TENANT}`);
  if (t.ok && !process.argv.includes("--pauses-from-notes")) {
    for (const r of t.rows) add(r.order_item_id, r.pause_from, r.pause_to);
    console.log(`  休止: order_item_pauses ${t.rows.length} 期間 / 明細 ${out.size}`);
    return out;
  }
  if (!process.argv.includes("--pauses-from-notes")) {
    console.log(`  ⚠ order_item_pauses を読めない (${t.ok ? "" : `${t.status} ${t.text}`}) — 表が未適用なら 休止なし (貸与期間の全日) で組む。投入後の見込みは --pauses-from-notes`);
    return out;
  }
  const n = await pageAll<{ id: string; notes: string | null }>(`order_items?select=id,notes&tenant_id=eq.${TENANT}&notes=like.*${encodeURIComponent("休止")}*`);
  if (!n.ok) throw new Error(`order_items (notes) を読めない: ${n.status} ${n.text}`);
  let periods = 0;
  for (const r of n.rows) for (const m of (r.notes ?? "").matchAll(/\[休止 (\d{4}-\d{2}-\d{2})〜(\d{4}-\d{2}-\d{2})\]/g)) { add(r.id, m[1], m[2]); periods++; }
  console.log(`  休止: ★ order_items.notes の [休止 …] をメモリ上で使う (--pauses-from-notes) ${periods} 期間 / 明細 ${out.size}`);
  return out;
}

async function main() {
  const libs = await loadLibs();
  const hk = KK ? parseKk(readFileSync(KK, "latin1")) : null; // KK は ASCII のみ (漢字を含まない)
  const kds = KDS ? readKds0031(KDS) : null;
  const MONTH = arg("--month") ?? (hk
    ? ymOf(`${hk.recs[0].v[1].slice(0, 4)}-${hk.recs[0].v[1].slice(4, 6)}`)
    : [...kds!.monthCount].sort((a, b) => b[1] - a[1])[0][0]);
  const CACHE = arg("--db-cache") ?? join(tmpdir(), `fukuyogu-densou-db-${MONTH}.json`);
  if (hk) console.log(`ほのぼの: ${KK}\n  提供年月 ${MONTH} / データ ${hk.recs.length} レコード / コントロール ${hk.control.join(",")}`);
  else console.log(`ほのぼの (明細書明細付): ${KDS}\n  ${kds!.rows.length} 行 / 提供年月 ${[...kds!.monthCount].map(([k, v]) => `${k}:${v}`).join(" ")} → 比べるのは ${MONTH} の行だけ (月遅れ行は外す)\n  ★ KDS にある項目だけを比べる (10 集計・7111 は比べない。冒頭の注記)`);
  // --db-base <json>: 別の月の控えを使い回す (月で絞る 2 表だけ読み直す。check:kk-honobono で全件読みを 1 回にする)
  const DB_BASE = arg("--db-base");
  const snap = DB_BASE ? await rebaseSnapshot(DB_BASE, MONTH, CACHE) : await loadSnapshot(MONTH, CACHE, process.argv.includes("--refresh"));
  const office = snap.offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
  if (!office) throw new Error(`offices に business_number=${PROVIDER_BN} が無い`);
  const pausesByItem = await loadPauses();
  // ★ 2026-11-11 事業所別保険: --as-per-office で「この事業所を per_office に切り替えたら」を模擬する
  //   (offices.insurance_scope が per_office ならそれだけで per_office として組む)
  const perOffice = process.argv.includes("--as-per-office") || (office as { insurance_scope?: string }).insurance_scope === "per_office";
  const perOfficeIds = snap.offices.filter((o) => (o as { insurance_scope?: string }).insurance_scope === "per_office").map((o) => o.id);
  if (perOffice) console.log("  ★ 事業所別保険: per_office として組む (認定・公費・負担割合証は office_id = この事業所の行だけ。clients の列は使わない)");
  const model = buildBillingModel(snap, MONTH, office.id, libs, pausesByItem, { perOffice, perOfficeIds });
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
  // ★ CM 指示単位数 (fukuyogu_cm_units。migrations/fukuyogu_cm_units.sql)。請求画面と同じく その月・その事業所の値。
  //   スナップショットに無い表なので都度読む。表が未適用・読めないなら警告して全員「入力なし」(実績で請求)
  const cmUnitsByClient = new Map<string, number>();
  {
    const env = readEnv();
    // ★ 2026-11-11: 1000 行で切れていた (PostgREST の上限)。order=id で全ページ読む
    for (let from = 0; ; from += 1000) {
      const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/fukuyogu_cm_units?select=client_id,units&tenant_id=eq.${TENANT}&office_id=eq.${office.id}&service_month=eq.${MONTH}&order=id&offset=${from}&limit=1000`, {
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
      });
      if (!res.ok) { console.log(`  ⚠ fukuyogu_cm_units を読めない (${res.status} ${(await res.text()).slice(0, 120)}) — 表が未適用なら CM 指示単位数は全員 入力なし (実績で請求) として組む`); cmUnitsByClient.clear(); break; }
      const rows = (await res.json()) as { client_id: string; units: number }[];
      for (const r of rows) cmUnitsByClient.set(r.client_id, r.units);
      if (rows.length < 1000) break;
    }
    console.log(`  CM 指示単位数: ${cmUnitsByClient.size} 名 (${MONTH})`);
  }
  // ★ 負担割合証 (FY-H)。表があれば表、無ければ BillingTab と同じく clients.benefit_rate (--benefit-from-csv で CSV を代わりに)
  let benefitBy: Map<string, BenefitCertRow[]> | null = null;
  {
    const sb = await serviceClient(["../kaigo-app/.env.local", ".env.local"]);
    const K = "../kaigo-app";
    if (sb) {
      const b = await loadBenefitCertsDbOrCsv(sb, [...dbLines.keys()], [
        // 事業所の利用者マスタ (最新の 利用者マスタ_YYYYMMDD。引数化の前は ケアサポ 20261109 に固定 = 今は同じもの)
        ...(UMD ? [{ label: `${FO.area} ${UMD}`, futan: join(K, `伝送データ/${FO.area}/福祉用具/利用者マスタ_${UMD}/負担割合証等_全件.CSV`), ins: [join(K, `伝送データ/${FO.area}/福祉用具/利用者マスタ_${UMD}/介護保険_全件_保険と認定.CSV`)] }] : []),
        { label: "全社 20260830", futan: join(K, "利用者データ/全社_R8-08/負担割合証等1.CSV"), ins: [join(K, "利用者データ/全社_R8-08/介護保険1.CSV")] },
      ]);
      if (b.source === "db" || process.argv.includes("--benefit-from-csv")) benefitBy = b.byClient;
      console.log(`  給付率: ${benefitBy ? `負担割合証 (${b.note}) → 無ければ認定行` : "clients.benefit_rate (表が未作成。--benefit-from-csv で CSV の見込み)"}`);
    }
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
  // 伝送の除外見込み (2026-11-14 群1+群2・READ ONLY の数え上げ。出力・判定は変えない): 行ごとの benefitRateDefaulted
  const defaultedByRow = new Map<FukuyoguSeikyuRow, boolean>();
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
        days: fukuyoguRentalDaysInMonth(it.rental_start_date, it.rental_end_date, MONTH, model.pausesOf(it.id)),
        taisCode: model.eqByCode.get(it.product_code)?.tais_code ?? null,
      });
      billed.push(it);
      totalUnits += l.units;
    }
    const k = pickKohi(cid);
    // 本人支払額 (介護券) も BillingTab (lib/fukuyoguKohiMonth.ts) と同じく渡す (2026-11-13: 渡しておらず 中島 紀久子 で 1,200 円ずれていた)
    const kohi = k ? { hobetsu: k.hohei_code!, futansha: k.futan_sha_number, jukyusha: k.jukyu_sha_number, selfPay: k.self_pay_amount ?? null } : null;
    const certsOf = (xs: BenefitCertRow[]) => perOffice ? xs.filter((x) => (x as { office_id?: string | null }).office_id === office.id) : xs;
    const benefitRaw = benefitBy
      ? (() => { const r = resolveBenefitForMonth(model.insByClient.get(cid) ?? [], certsOf(benefitBy.get(cid) ?? []), model.monthStartS, model.monthEndS); return r.benefitRate != null ? String(r.benefitRate) : (perOffice ? null : c.benefit_rate); })()
      : c.benefit_rate;
    // BillingTab の densouCertOf と同じ: per_office は自事業所の認定行だけ (番号・担当居宅も)。shared は clients の列
    const rec = model.pickIns(cid);
    const dc = perOffice
      ? { ...certFieldsForDensou({ care_level: null, certification_start_date: null, certification_end_date: null }, rec),
          insurerNumber: rec?.insurer_number ?? null, insuredNumber: rec?.insured_number ?? null, careOfficeId: rec?.care_office_id ?? null }
      : { ...certFieldsForDensou(c, rec), insurerNumber: c.insurer_number, insuredNumber: c.insured_number ?? null, careOfficeId: c.care_office_id };
    const amt = libs.computeFukuyoguAmounts({ benefitRateRaw: benefitRaw, insuredNumber: c.insured_number, totalUnits, kohi, cmUnits: cmUnitsByClient.get(cid) ?? null });
    periodByKey.set(`${(c.insurer_number ?? "").trim().padStart(8, "0")}|${(c.insured_number ?? "").trim()}`, { startDate: fukuyoguServiceStartDate((rentalsByClient.get(cid) ?? []).map(toP), MONTH), stopDate: fukuyoguServiceStopDate((rentalsByClient.get(cid) ?? []).map(toP), MONTH) });
    rows.push({
      userName: c.name, insurerNumber: dc.insurerNumber, insuredNumber: dc.insuredNumber,
      birthDate: c.birth_date, gender: c.gender,
      // 要介護度・認定期間 = 当月に有効な認定レコード優先 (BillingTab と同じ lib/kokuho-densou/cert-for-month.ts)
      careLevel: dc.careLevel, certStart: dc.certStart, certEnd: dc.certEnd,
      careOfficeNumber: dc.careOfficeId ? (careOfficeNo.get(dc.careOfficeId) || null) : null,
      carePlanKubun: dc.careOfficeId ? planKubunById.get(dc.careOfficeId) ?? null : null,
      copayRate: amt.copayRate, details,
      totalUnits: amt.billedUnits, limitTargetUnits: amt.actualUnits, planUnits: amt.planUnits, totalCost: amt.totalCost,
      cmMissing: cmUnitsByClient.size > 0 && !cmUnitsByClient.has(cid),
      insuranceAmount: amt.insuranceAmount, userAmount: amt.userAmount,
      kohiHobetsu: amt.kohiHobetsu, kohiFutansha: kohi?.futansha ?? null, kohiJukyusha: kohi?.jukyusha ?? null,
      kohiAmount: amt.kohiAmount, kohiTandoku: amt.kohiTandoku,
      // BillingTab と同じ (公費の対象単位・費用・本人負担。本人負担は 01 項41 / 10 項20 に出る)
      kohiUnits: amt.kohiUnits, kohiTargetCost: amt.kohiTargetCost, kohiHonninFutan: amt.kohiHonninFutan,
      benefitRateDefaulted: amt.benefitRateDefaulted,
      // 開始年月日は BillingTab と同じく 貸与履歴から (lib/kokuho-densou/fukuyogu-period.ts)。中止は渡さない
      serviceStartDate: fukuyoguServiceStartDate((rentalsByClient.get(cid) ?? []).map(toP), MONTH),
    });
    defaultedByRow.set(rows[rows.length - 1], amt.benefitRateDefaulted);
    const ins8 = (c.insurer_number ?? "").trim().padStart(8, "0");
    for (const f of ["7131", "7132"]) nameByKey.set(`${f}|${ins8}|${(c.insured_number ?? "").trim()}`, `${c.name}`);
  }
  const [Y, M] = MONTH.split("-").map(Number);
  const built = buildFukuyoguDensou(rows, { officeNumber: PROVIDER_BN, year: Y, month: M });
  const mk = parseKk(built.content);
  {
    // build の既存の除外 4 種 (保険者・被保番 / 要介護度 / CM 0 / CM 未入力) を通った人だけを数える (= 新しく外れる人)
    const reach = rows.filter((r) => (r.insurerNumber ?? "").trim() && (r.insuredNumber ?? "").trim() && careLevelCodeForDensou(r.careLevel)
      && (r.kohiTandoku || r.planUnits !== 0) && (r.kohiTandoku || !r.cmMissing));
    const byReason = new Map<DensouExcludeReason, string[]>();
    let n = 0;
    for (const r of reach) {
      const rs = densouExcludeReasons({ ...r, benefitRateDefaulted: defaultedByRow.get(r) ?? false });
      if (rs.length) n++;
      for (const x of rs) { if (!byReason.has(x)) byReason.set(x, []); byReason.get(x)!.push(`${r.userName} ${r.totalCost.toLocaleString()}円`); }
    }
    console.log(`伝送の除外見込み (群1+群2): 既存の除外を通った ${reach.length} 名のうち ${n} 名`);
    for (const x of Object.keys(DENSOU_EXCLUDE_LABEL) as DensouExcludeReason[]) {
      const ns = byReason.get(x) ?? [];
      console.log(`  ${x} (${DENSOU_EXCLUDE_LABEL[x]}): ${ns.length} 名${ns.length ? ` — ${ns.slice(0, 20).join(" / ")}${ns.length > 20 ? " …" : ""}` : ""}`);
    }
  }
  console.log(`新システム: 対象 ${rows.length} 名 (月遅れで除外 ${lateCount} 名) / データ ${mk.recs.length} レコード / 警告 ${built.warnings.length} 件`);

  const P = (rs: ReturnType<typeof receipts>) => (kds ? projectReceipts(rs) : rs);
  const kr = kds ? kdsReceipts(kds.rows, MONTH) : null;
  const hono = kr ? kr.r : receipts(hk!.recs), mine = P(receipts(mk.recs));
  const nameOf = (key: string) => nameByKey.get(key) ?? kr?.nameByKey.get(key) ?? "(DB に無い)";
  const { B, stat } = compare(hono, mine, nameOf);

  if (hk) {
    console.log("\n══ コントロールレコード ══");
    const cDiff = hk.control.map((x, i) => (x === mk.control[i] ? null : `項${i + 1} ほ=${x} 新=${mk.control[i]}`)).filter(Boolean);
    console.log(cDiff.length ? `  差: ${cDiff.join(" / ")}` : "  一致");
  }
  if (kr?.dupKeys.length) console.log(`\n  ⚠ KDS: 同じ (様式, 保険者, 被保番) に別のレセプト番号 ${kr.dupKeys.length} 件 (2 本目以降は比べない): ${kr.dupKeys.slice(0, 5).join(" / ")}`);

  // ── レセプト単位の金額一致 (KK 版・KDS 版で同じ物差し。給付率・保険単位/請求/負担・公費1 単位/請求/本人負担 + 明細の (コード,TAIS,日数,単位) 多重集合) ──
  //   --out の stat に "金額明細": [一致, ほのぼののレセプト数] として載せる (check:kk-honobono の基準値)
  let receiptAmt: [number, number] = [0, 0];
  {
    const AMT = [28, 32, 33, 34, 38, 39, 40];
    const z = (x: string | undefined) => (x ?? "") === "0" ? "" : (x ?? "");
    const det = (r: Receipt) => r.d.map((d) => `${d.v[6]}${d.v[7]}|${d.v[17]}|${z(d.v[9])}|${z(d.v[13])}`).sort().join(";");
    let both = 0, same = 0;
    const ng: string[] = [];
    for (const [key, h] of hono.byKey) {
      const m = mine.byKey.get(key);
      if (!m) continue;
      both++;
      const amt = AMT.filter((i) => z(h.h.v[i]) !== z(m.h.v[i]));
      if (amt.length === 0 && det(h) === det(m)) { same++; continue; }
      ng.push(`${nameOf(key)} ${key} ${amt.map((i) => `項${i + 1}${N01[i + 1] ?? ""} ほ${h.h.v[i]}/新${m.h.v[i]}`).join(" ")}${det(h) === det(m) ? "" : " 明細が違う"}`);
    }
    console.log(`\n══ レセプト単位 金額+明細の一致 ══\n  一致 ${same} / 両方にある ${both} (ほのぼの ${hono.byKey.size} / 新 ${mine.byKey.size})`);
    for (const x of ng.slice(0, Number(process.env.DIFF_SHOW ?? 10))) console.log(`    - ${x}`);
    receiptAmt = [same, hono.byKey.size];
  }

  console.log("\n══ レコード種別ごとの一致 (ほのぼの側の件数が分母。書式差は無視して値で比較) ══");
  const cnt = (rs: ReturnType<typeof receipts>, f: string, t: string) =>
    t === "02" ? [...rs.byKey.values()].filter((r) => r.form === f).reduce((s, r) => s + r.d.length, 0) : [...rs.byKey.values()].filter((r) => r.form === f).length;
  for (const [k, [ok, all]] of Object.entries(stat)) {
    const [f, t] = k.split("-");
    if (kds && (t === "10" || f === "7111")) { console.log(`  ${k.padEnd(8)} (KDS に無い項目なので比べない)`); continue; }
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
    else if (!model.officeClients.has(c.id)) why.add("ほのぼのだけ: clients.office_id が別事業所で割当も無い", { ...exn, office_id: c.office_id });
    else if (model.noCareLevel.has(c.id)) why.add("ほのぼのだけ: 新システムは要介護度をコードにできず (当月に有効な認定なし 等) 月遅れ扱いで伝送から外す", exn);
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
    // 頭打ち: KK は 10 集計の 計画単位数 ≠ 限度額管理対象。KDS は 10 が無いので 明細合計 > 保険単位数 で見る
    if (h.s ? h.s.v[8] !== h.s.v[9] : hSum > Number(h.h.v[32])) why.add("金額差: ほのぼのは 計画単位数 (給付管理) で頭打ち。超過分は保険外 (請求画面の CM 指示単位数が未入力 or 値違い)", { ...ex, 計画: h.s ? h.s.v[8] : h.h.v[32], 実績: h.s ? h.s.v[9] : hSum });
    else if (hSum !== mSum) why.add("金額差: 明細の単位数合計が違う (用具・単位数の差)", { ...ex, 明細合計: `ほ${hSum}/新${mSum}` });
    else if (h.h.v[28] !== m.h.v[28]) why.add(benefitBy ? "金額差: 保険給付率が違う (負担割合証 → 認定行)" : "金額差: 保険給付率が違う (clients.benefit_rate)", { ...ex, 給付率: `ほ${h.h.v[28]}/新${m.h.v[28]}` });
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

  // ── 残差の型分け (2026-11-14): レセプト 1 本に型を 1 つだけ付け、型ごとの件数と 保険請求額の向き・合計を出す ──
  //   「一致率 95%」の残りが何かを 1 本ずつ言えるようにする (介護保険 7131 の残差の型分けと同じ形)。
  //   型は上から順に最初に当たったもの。金額 = 01 項34 保険請求額 (新 − ほのぼの。+ = 当方が多い = 過大の向き)。
  {
    const AMT = [28, 32, 33, 34, 38, 39, 40];
    const z = (x: string | undefined) => (x ?? "") === "0" ? "" : (x ?? "");
    const det = (r: Receipt) => r.d.map((d) => `${d.v[6]}${d.v[7]}|${d.v[17]}|${z(d.v[9])}|${z(d.v[13])}`).sort().join(";");
    const yen = (r: Receipt | undefined) => Number(r?.h.v[33] ?? 0) || 0;
    type T = { n: number; plus: number; minus: number; ex: string[] };
    const types = new Map<string, T>();
    const put = (t: string, diff: number, ex: string) => {
      const x = types.get(t) ?? { n: 0, plus: 0, minus: 0, ex: [] };
      x.n++; if (diff > 0) x.plus += diff; else x.minus += diff; if (x.ex.length < 5) x.ex.push(ex);
      types.set(t, x);
    };
    const swap = (key: string) => (key.startsWith("7131") ? "7132" : "7131") + key.slice(4);
    const keys = new Set([...hono.byKey.keys(), ...mine.byKey.keys()]);
    let total = 0;
    for (const key of keys) {
      const h = hono.byKey.get(key), m = mine.byKey.get(key);
      const nm = nameOf(key);
      total++;
      if (h && m) {
        const amt = AMT.filter((i) => z(h.h.v[i]) !== z(m.h.v[i]));
        const d = yen(m) - yen(h);
        const ex = `${nm} ${key} 保険請求 ほ${h.h.v[33]}/新${m.h.v[33]}`;
        if (amt.length === 0 && det(h) === det(m)) { put("一致 (金額・明細とも)", 0, ex); continue; }
        const hSum = h.d.reduce((s, x) => s + Number(x.v[13]), 0), mSum = m.d.reduce((s, x) => s + Number(x.v[13]), 0);
        if (h.s ? h.s.v[8] !== h.s.v[9] : hSum > Number(h.h.v[32])) put("両方: ほのぼのは計画単位数で頭打ち (CM 指示単位数)", d, ex);
        else if (hSum !== mSum) put("両方: 明細の単位数合計が違う (用具・台数・日割)", d, `${ex} 明細合計 ほ${hSum}/新${mSum}`);
        else if (h.h.v[28] !== m.h.v[28]) put("両方: 保険給付率が違う (負担割合)", d, `${ex} 給付率 ほ${h.h.v[28]}/新${m.h.v[28]}`);
        else if (h.h.v[6] !== m.h.v[6] || amt.some((i) => i >= 38)) put("両方: 公費が違う (有無・単位・本人負担)", d, ex);
        else if (amt.length) put("両方: 金額項目だけ違う (その他)", d, `${ex} 項${amt.map((i) => i + 1).join(",")}`);
        else put("両方: 金額は同じで明細の書き方だけ違う (コード・TAIS・日数)", d, ex);
        continue;
      }
      if (h && !m) {
        if (mine.byKey.has(swap(key))) { put("様式違い (7131↔7132。ほのぼの側の行)", 0, `${nm} ${key}`); continue; }
        put("ほのぼのだけ (当方に請求が無い。理由は上の「原因の切り分け」)", -yen(h), `${nm} ${key} 保険請求 ${h.h.v[33]}`);
        continue;
      }
      if (m && !h) {
        if (hono.byKey.has(swap(key))) { put("様式違い (7131↔7132。当方側の行)", 0, `${nm} ${key}`); continue; }
        put("当方だけ (ほのぼのは請求していない)", yen(m), `${nm} ${key} 保険請求 ${m.h.v[33]}`);
      }
    }
    console.log(`\n══ 残差の型分け (レセプト ${total} 本 = ほのぼの ${hono.byKey.size} ∪ 当方 ${mine.byKey.size}。1 本に型 1 つ) ══`);
    console.log("  ★ 前提: 貸与は 2026-11-14 に 提供票 (入力側) から組み直した値。それより前の一致率は 請求の出力 (KDS0031) から作った貸与で測っていて循環していた。");
    console.log("  ★ 比べているのは 計算規則 (半月按分・給付率・公費・頭打ち・7131/7132) と 入力 (利用者・保険・貸与) の一致。");
    console.log("    品目を請求の出力で決めた台 (notes [品目は請求の出力で特定]) と 暫定で継続にした台 ([暫定: …]) を含む。");
    console.log("  金額 = 01 項34 保険請求額の差 (当方 − ほのぼの)。+ = 当方が多い (過大の向き) / − = 当方が少ない (不足の向き)");
    for (const [t, x] of [...types].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${String(x.n).padStart(5)}  ${t}${x.plus || x.minus ? `   過大 +${x.plus.toLocaleString()} 円 / 不足 ${x.minus.toLocaleString()} 円` : ""}`);
      if (!t.startsWith("一致")) for (const e of x.ex) console.log(`           - ${e}`);
    }
  }

  // ── 負のコントロール: 新システム側を 1 か所わざと壊して検出できるか ──
  console.log("\n══ 負のコントロール ══");
  const broken = parseKk(built.content);
  // ★ 2026-11-14: 壊す対象は ほのぼのにもある (比べられる) レセプトから選ぶ。
  //   先頭の 1 本が「当方だけ」だと比べる相手が無く、壊しても差が 0 で NG と誤って出る (誉田 2026-10 で起きた)
  const inHono = (r: Rec) => hono.byKey.has(`${r.v[0]}|${r.v[4]}|${r.v[5]}`);
  const firstDetail = broken.recs.find((r) => r.v[1] === "02" && r.v[0] !== "7111" && inHono(r));
  const firstHead = broken.recs.find((r) => r.v[1] === "01" && r.v[0] !== "7111" && inHono(r));
  let ncOk = true;
  if (firstDetail && firstHead) {
    const before = compare(hono, P(receipts(mk.recs)), nameOf);
    firstDetail.v[13] = String(Number(firstDetail.v[13]) + 1);
    firstHead.v[14] = firstHead.v[14] === "21" ? "22" : "21";
    const after = compare(hono, P(receipts(broken.recs)), nameOf);
    const d02 = [...after.B.f02.m.values()].reduce((s, v) => s + v.length, 0) - [...before.B.f02.m.values()].reduce((s, v) => s + v.length, 0);
    const d01 = after.B.f01.count(`${firstHead.v[0]}-01 項15 要介護度`) - before.B.f01.count(`${firstHead.v[0]}-01 項15 要介護度`);
    ncOk = d02 >= 1 && d01 === 1;
    console.log(`  明細のサービス単位数を +1 → 明細差 +${d02} / 要介護度を書き換え → 基本差 +${d01}  ${ncOk ? "OK (検出できた)" : "★ NG 検出できない = この突合は壊れている"}`);
  } else { ncOk = false; console.log("  ★ NG 壊す対象が無い"); }

  const out = arg("--out");
  if (out) {
    // KDS 版は 10 集計・7111 を比べていないので stat から外す (0 / n が基準値に焼き付かないように)
    const outStat: Record<string, [number, number]> = Object.fromEntries(Object.entries(stat).filter(([k]) => !(kds && (k === "7111" || k.endsWith("-10")))));
    outStat["金額明細"] = receiptAmt;
    writeFileSync(out, JSON.stringify({ month: MONTH, source: kds ? "KDS" : "KK", stat: outStat, warnings: built.warnings, rec: B.rec, f7111: B.f7111, f01: B.f01, f02: B.f02, f10: B.f10, fmt: B.fmt }, null, 1));
    console.log(`\n→ ${out}`);
  }
  console.log(kds
    ? `\n⚠ KDS の月遅れ行 (提供 ${MONTH} 以外) は範囲外。10 集計・7111 は KDS に無いので比べていない。`
    : `\n⚠ 月遅れ分 (KK261001〜003 = 提供 2026-06〜08) は範囲外 (DB は 2026-09 提供分に合わせただけ)。`);
  if (!ncOk) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
