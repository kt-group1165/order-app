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
 *   分母は **その月に介護レンタルがある利用者**に絞る (請求に出ない人は今は関係ない)。
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

const clients = await all<Client>("clients", "id, name, benefit_rate, copay_rate, insured_number", "id");
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
const pct = (v: string | null) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n >= 1 ? n : n * 100; // "10"/"20"/"30" も 0.1 も受ける
};

const buckets = {
  mismatch: [] as string[],
  zeroNotTandoku: [] as string[],
  odd: [] as string[],
  missing: [] as string[],
  nan: [] as string[],
  tandokuOk: 0,
};
let yenAtRisk = 0;

for (const c of clients) {
  const a = active.get(c.id);
  if (!a) continue;
  const raw = c.benefit_rate;
  const b = raw == null ? null : parseInt(raw, 10);
  const p = pct(c.copay_rate);
  const where = `${c.name} (レンタル ${a.n} 件 / 貸与価格計 ¥${a.yen.toLocaleString()})`;

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

console.log(`\n✅ 公費単独 (H) で 給付率 0 — ${buckets.tandokuOk} 名 (**これは正常**)`);
console.log(`   ⚠ ここを分けないと「給付率 0 = 異常」で ${buckets.tandokuOk} 件の誤報になる`);
if (yenAtRisk !== 0) {
  console.log(`\n★ ① の金額規模: ¥${yenAtRisk.toLocaleString()}/月`);
  console.log(`   ⚠ 貸与価格 (rental_price × quantity) を元にした概算。`);
  console.log(`     実際の請求は単位数マスタから引くので端数が違う。**桁を見るための値**。`);
  console.log(`   ⚠ どちらが正かは **負担割合証**でしか決まらない。DB だけでは直せない。`);
}
