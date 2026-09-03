/**
 * 福祉用具の請求で使う 給付率 / 負担割合 の健全性を実データで点検する (READ ONLY)
 *
 *   MONTH=2026-06 npx tsx scripts/benefit-rate-check.mts
 *
 * ⚠ **`clients` は 給付率 (`benefit_rate`) と 負担割合 (`copay_rate`) を別々の列で持つ。**
 *   本来 給付率 + 負担割合 = 100 のはずだが、**2 つが独立に編集できる**ので食い違える。
 *   請求 (`BillingTab`) が使うのは **給付率のほう**なので、
 *   負担割合証が 3 割なのに給付率 90 のままだと **保険に 2 割ぶん過大請求**になる。
 *
 * ── ★ 負のコントロール (これが無いと 11 名の誤検出が出る) ────────────────
 *   **公費単独 (被保険者番号が H 始まり = みなし2号) は 給付率 0 が正しい。**
 *   保険は 1 円も出さず、公費が 10 割を負担する。
 *   実際 2026-06 の「給付率 0」11 名は **全員 H 番号**で、これは正常。
 *   ここを分けずに「給付率 0 = 異常」と出すと、**正しいデータを 11 件も誤報**する。
 *
 * ── 見るもの ──────────────────────────────────────────────────────────
 *   ① 給付率 + 負担割合 ≠ 100                    ← ★ どちらかが古い
 *   ② 給付率 0 なのに 公費単独 (H) でない
 *   ③ 給付率が 90/80/70/0 以外
 *   ④ 給付率が未設定 (BillingTab は 90 で計算し警告を出す)
 *   ⑤ 給付率が数値として読めない (parseInt が NaN)
 *   ⑥ ★ **`clients.benefit_rate` が 認定 (`client_insurance_records`) と食い違う**
 *      ← ①②③④⑤ より強い検査。認定は ほのぼの由来なので **こちらが正**。
 *        ①だけだと「clients の 2 列が揃って古い」ケースを取り逃がす。
 *   分母は **その月に介護レンタルがある利用者**に絞る (請求に出ない人は今は関係ない)。
 *
 * ── 認定を正とする根拠 (2026-09-03 実測) ────────────────────────────────
 *   ① で出た 2 名を認定と突き合わせたら、**認定側に負担割合証がそのまま入っていた**。
 *     髙畠 孝祐  認定 2025-08-01〜2028-07-31  copay_rate "3" / benefit_rate "70"
 *     村上 正幸  認定 2026-03-01〜2030-02-28  copay_rate "2" / benefit_rate "80"
 *                (負担割合証の期間 2025-08-01〜2026-07-31 も入っている)
 *   どちらも `clients.copay_rate` (30 / 20) とは一致し、
 *   **`clients.benefit_rate` の 90 だけが古い**。→ 請求は 90 を使うので過大請求。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const MONTH = process.env.MONTH ?? "2026-06";
const [Y, M] = MONTH.split("-").map(Number);
const MS = `${MONTH}-01`;
const ME = `${MONTH}-${String(new Date(Y, M, 0).getDate()).padStart(2, "0")}`;

const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (anon だと RLS で 0 行になり誤判定する)");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ⚠ PostgREST の既定 1000 行上限。clients は 9,000 名超なので必ずページングする
async function all<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type Client = { id: string; name: string; benefit_rate: string | null; copay_rate: string | null; insured_number: string | null };
type Order = { id: string; client_id: string; payment_type: string | null };
type Item = {
  order_id: string; status: string | null; payment_type: string | null;
  rental_start_date: string | null; rental_end_date: string | null;
  quantity: number | null; rental_price: number | null;
};

type Cert = {
  client_id: string; copay_rate: string | null; benefit_rate: string | null;
  certification_start_date: string | null; certification_end_date: string | null;
  effective_date: string | null;
};

const clients = await all<Client>("clients", "id, name, benefit_rate, copay_rate, insured_number", "id");
const certs = await all<Cert>(
  "client_insurance_records",
  "client_id, copay_rate, benefit_rate, certification_start_date, certification_end_date, effective_date",
  "id",
);
// 利用者ごとの「最新の認定終了日」(対象月に有効でなくてもよい)
const latestCertEnd = new Map<string, string>();
for (const r of certs) {
  const e = r.certification_end_date;
  if (!e) continue;
  const cur = latestCertEnd.get(r.client_id);
  if (!cur || e > cur) latestCertEnd.set(r.client_id, e);
}
// 対象月に有効な認定のうち effective_date 最新の 1 件
const certOf = new Map<string, Cert>();
for (const r of certs) {
  const s = r.certification_start_date ?? r.effective_date;
  const e = r.certification_end_date;
  if (s != null && s > ME) continue;
  if (e != null && e < MS) continue;
  const cur = certOf.get(r.client_id);
  if (!cur || (r.effective_date ?? "") > (cur.effective_date ?? "")) certOf.set(r.client_id, r);
}
const orders = await all<Order>("orders", "id, client_id, payment_type", "id");
const items = await all<Item>("order_items", "order_id, status, payment_type, rental_start_date, rental_end_date, quantity, rental_price", "id");

const payOf = new Map(orders.map((o) => [o.id, o.payment_type]));
const clOf = new Map(orders.map((o) => [o.id, o.client_id]));

// ⚠ 抽出条件は BillingTab の careItems と同じにする (ズレると分母が変わる)
const active = new Map<string, { n: number; yen: number }>();
for (const i of items) {
  if ((i.payment_type ?? payOf.get(i.order_id) ?? "介護") !== "介護") continue;
  if (!i.rental_start_date || i.rental_start_date > ME) continue;
  if (i.status === "terminated" && i.rental_end_date && i.rental_end_date < MS) continue;
  if (i.status !== "rental_started" && i.status !== "terminated") continue;
  const cid = clOf.get(i.order_id);
  if (!cid) continue;
  const cur = active.get(cid) ?? { n: 0, yen: 0 };
  cur.n++;
  cur.yen += Number(i.rental_price ?? 0) * Number(i.quantity ?? 1);
  active.set(cid, cur);
}

console.log(`══ 分母 (${MONTH}) ══`);
console.log(`  clients ${clients.length} 名 / うち **その月に介護レンタルがある** ${active.size} 名`);

const isTandoku = (c: Client) => /^[Hh]/.test((c.insured_number ?? "").trim());
/** `clients.copay_rate` は **percent 表記** ("10"/"20"/"30")。0.1 のような比率も受ける */
const pct = (v: string | null) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n >= 1 ? n : n * 100;
};
/**
 * ⚠ `client_insurance_records.copay_rate` は **割 表記** ("1"/"2"/"3")。
 *   `clients.copay_rate` (percent) と **同じ列名なのに単位が違う**。
 *   最初これを混同して `"1"` を 1% と読み、給付率 99 として
 *   **正常な 2 名を「認定と食い違う」と誤検出**した (2026-09-03)。
 *   1〜3 は割、それ以上は percent とみなす (実データは "1"/"2"/"3" のみ)。
 */
const certCopayPct = (v: string | null) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 3) return n * 10; // "1"/"2"/"3" = 1割/2割/3割
  return n >= 1 ? n : n * 100;
};

const buckets = {
  mismatch: [] as string[],
  zeroNotTandoku: [] as string[],
  odd: [] as string[],
  missing: [] as string[],
  nan: [] as string[],
  vsCert: [] as string[],
  certExpired: [] as { line: string; end: string; yen: number }[],
  tandokuOk: 0,
  noCert: 0,
};
let yenAtRisk = 0;
let yenVsCert = 0;

for (const c of clients) {
  const a = active.get(c.id);
  if (!a) continue;
  const raw = c.benefit_rate;
  const b = raw == null ? null : parseInt(raw, 10);
  const p = pct(c.copay_rate);
  const where = `${c.name} (レンタル ${a.n} 件 / 貸与価格計 ¥${a.yen.toLocaleString()})`;

  // ⑥ ★ 認定 (ほのぼの由来 = 正) と突き合わせる。①より強い
  const cert = certOf.get(c.id);
  if (!cert) {
    buckets.noCert++;
    // 公費単独は認定が無くても正常 (保険を使わない)
    if (!isTandoku(c)) {
      const last = latestCertEnd.get(c.id);
      buckets.certExpired.push({
        line: `${where} — 最新の認定は ${last ?? "(1 件も無い)"} まで`,
        end: last ?? "(無)",
        yen: a.yen,
      });
    }
  } else {
    // 認定の給付率。無ければ 認定の負担割合から導く (copay "1"/"2"/"3" = 割)
    const cb = cert.benefit_rate != null && Number.isFinite(parseInt(cert.benefit_rate, 10))
      ? parseInt(cert.benefit_rate, 10)
      : (() => { const p = certCopayPct(cert.copay_rate); return p == null ? null : 100 - p; })();
    const mine = raw == null ? null : parseInt(raw, 10);
    if (cb != null && mine != null && Number.isFinite(mine) && cb !== mine) {
      const ins = Math.floor(a.yen * mine / 100);
      const ins2 = Math.floor(a.yen * cb / 100);
      yenVsCert += ins - ins2;
      buckets.vsCert.push(
        `${where}\n     clients=${mine} / 認定=${cb} (認定の負担割合 ${JSON.stringify(cert.copay_rate)} 給付率 ${JSON.stringify(cert.benefit_rate)} ${cert.certification_start_date ?? "?"}〜${cert.certification_end_date ?? "?"})` +
        `\n     clients どおり 保険 ¥${ins.toLocaleString()} / 認定どおり 保険 ¥${ins2.toLocaleString()} → ★ 差 ¥${(ins - ins2).toLocaleString()}/月`,
      );
    }
  }

  if (raw == null) { buckets.missing.push(`${where} — 給付率 未設定 → BillingTab は 90 で計算する`); continue; }
  if (b == null || !Number.isFinite(b)) { buckets.nan.push(`${where} — 給付率 ${JSON.stringify(raw)} が数値として読めない`); continue; }

  if (b === 0) {
    if (isTandoku(c)) { buckets.tandokuOk++; continue; } // ★ 負のコントロール: これは正常
    buckets.zeroNotTandoku.push(`${where} — 給付率 0 だが 被保番 ${c.insured_number ?? "(無)"} は H で始まらない`);
    continue;
  }
  if (![90, 80, 70].includes(b)) {
    buckets.odd.push(`${where} — 給付率 ${b} が 90/80/70 以外`);
    continue;
  }
  if (p != null && Math.round(b + p) !== 100) {
    const ins = Math.floor(a.yen * b / 100);
    const ins2 = Math.floor(a.yen * (100 - p) / 100);
    yenAtRisk += ins - ins2;
    buckets.mismatch.push(
      `${where}\n     給付率 ${b} / 負担割合 ${c.copay_rate} (合計 ${b + p})` +
      `\n     給付率どおり 保険 ¥${ins.toLocaleString()} / 負担割合どおり 保険 ¥${ins2.toLocaleString()} → ★ 差 ¥${(ins - ins2).toLocaleString()}/月`,
    );
  }
}

const show = (title: string, list: string[], note?: string) => {
  console.log(`\n${list.length ? "★ " : "OK "}${title} — ${list.length} 名`);
  if (note && list.length) console.log(`   ${note}`);
  for (const l of list.slice(0, 20)) console.log(`   ${l}`);
  if (list.length > 20) console.log(`   … 他 ${list.length - 20} 名`);
};

show("① 給付率 + 負担割合 ≠ 100", buckets.mismatch,
  "請求が使うのは **給付率のほう**。負担割合証が正なら保険への過大請求になる");
show("② 給付率 0 なのに 公費単独 (H) でない", buckets.zeroNotTandoku,
  "保険 0 円・全額 本人負担で請求される");
show("③ 給付率が 90/80/70/0 以外", buckets.odd);
show("④ 給付率が未設定", buckets.missing, "BillingTab は 90 で計算し警告を出す (2割/3割なら過大請求)");
show("⑤ 給付率が数値として読めない", buckets.nan);
show("⑥ ★ clients.benefit_rate が 認定と食い違う", buckets.vsCert,
  "認定は ほのぼの由来 = **こちらが正**。請求は clients のほうを使うので差額がそのまま誤請求");
// ⑦ 対象月に有効な認定が無いまま保険請求されている
console.log(`
${buckets.certExpired.length ? "★ " : "OK "}⑦ 対象月に有効な認定が無いのに保険で請求している — ${buckets.certExpired.length} 名`);
if (buckets.certExpired.length) {
  const byEnd: Record<string, number> = {};
  for (const x of buckets.certExpired) byEnd[x.end.slice(0, 7)] = (byEnd[x.end.slice(0, 7)] ?? 0) + 1;
  const yen = buckets.certExpired.reduce((s2, x) => s2 + x.yen, 0);
  console.log(`   最新の認定終了年月: ${JSON.stringify(Object.fromEntries(Object.entries(byEnd).sort()))}`);
  console.log(`   ⚠ **対象月の直前に固まっている = 更新の取込が追いついていない**可能性が高い`);
  console.log(`     (本当に失効しているなら終了月はもっとばらける)`);
  console.log(`   貸与価格計 ¥${yen.toLocaleString()}/月 が **認定の裏付け無しに給付率90 で請求**されている`);
  console.log(`   ⚠ ただし請求は \`clients.benefit_rate\` を使い認定を見ないので、**止まらない**。`);
  console.log(`     更新で負担割合が変わっていた人だけが誤請求になる (人数は認定を入れ直さないと分からない)。`);
  for (const x of buckets.certExpired.slice(0, 15)) console.log(`   ${x.line}`);
  if (buckets.certExpired.length > 15) console.log(`   … 他 ${buckets.certExpired.length - 15} 名`);
}
console.log(`   (公費単独 ${buckets.tandokuOk} 名は認定が無くても正常なので ⑦ から除外)`);

console.log(`\n✅ 公費単独 (H) で 給付率 0 — ${buckets.tandokuOk} 名 (**これは正常**)`);
console.log(`   ⚠ ここを分けないと「給付率 0 = 異常」で ${buckets.tandokuOk} 件の誤報になる`);
if (yenAtRisk !== 0) {
  console.log(`\n★ ① の金額規模: ¥${yenAtRisk.toLocaleString()}/月`);
  console.log(`   ⚠ 貸与価格 (rental_price × quantity) を元にした概算。`);
  console.log(`     実際の請求は単位数マスタから引くので端数が違う。**桁を見るための値**。`);
  console.log(`   ⚠ ①だけでは どちらが正か決まらない。⑥ (認定との突合) を見ること。`);
}
if (yenVsCert !== 0) {
  console.log(`\n★ ⑥ の金額規模: ¥${yenVsCert.toLocaleString()}/月 (認定を正としたときの 保険への過大請求)`);
  console.log(`   ⚠ 貸与価格 (rental_price × quantity) を元にした概算。桁を見るための値。`);
  console.log(`   ★ 直すなら **clients.benefit_rate を認定から導出する**のが本筋`);
  console.log(`     (2 つの列を人が両方正しく保つ運用は必ず破れる)。`);
}
