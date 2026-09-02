/**
 * 上限価格の照合ハーネス (READ ONLY / DB 書換なし)
 *
 * 画面 (NewOrderModal) が使う判定器 `lib/ceilingCheck.ts` を、**実データ全件**に
 * 当てて超過を出す。画面と同じ関数を使うので、規則がずれることがない。
 *
 *   npx tsx scripts/ceiling-check.mts
 *
 * ⚠ この harness と画面で規則が違うと意味がないので、**必ず同じ関数を import する**
 *   (2026-09-03 に移動支援で「ハーネスが本番と別の表を検証していた」事故があった)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { indexCeilings, judgeCeiling, type CeilingRow } from "../lib/ceilingCheck";

const env: Record<string, string> = {};
// ⚠ order-app の .env.local は **anon key しか持たない**ので、そのまま読むと
//   RLS で 0 行になり「超過 0 件」と誤って言ってしまう (実際に一度そうなった)。
//   service_role を持つ kaigo-app 側も読んで、あれば優先する。
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let txt = "";
  try { txt = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ。");
  console.log("  anon key で走らせると RLS で 0 行になり『超過 0 件』と誤判定するため、");
  console.log("  **意図的に走らせない**。");
  process.exit(0);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

async function all<T>(table: string, select: string): Promise<T[]> {
  const out: T[] = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from(table).select(select).order("id").range(f, f + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) return out;
  }
}

type Item = { product_code: string; rental_price: number | null; status: string | null; cancelled_at: string | null; rental_start_date: string | null };
type Eq = { product_code: string; tais_code: string | null; name: string | null };

const items = await all<Item>("order_items", "id, product_code, rental_price, status, cancelled_at, rental_start_date");
const eq = await all<Eq>("equipment_master", "id, product_code, tais_code, name");
const ceil = await all<CeilingRow>("equipment_price_ceilings", "id, tais_code, effective_from, ceiling_price");
const eqByCode = new Map(eq.map((e) => [e.product_code, e]));
const index = indexCeilings(ceil);

const rentals = items.filter((i) => i.status !== "cancelled" && !i.cancelled_at && (i.rental_price ?? 0) > 0);
console.log(`【分母】order_items ${items.length} 行 → 有効な貸与 ${rentals.length} 行`);
console.log(`【分母】用具マスタ ${eq.length} 件 / 上限価格 ${ceil.length} 行 (TAIS ${index.size} 種)\n`);

const tally: Record<string, number> = {};
const over: string[] = [];
for (const i of rentals) {
  const e = eqByCode.get(i.product_code);
  const j = judgeCeiling(e?.tais_code, i.rental_price, i.rental_start_date ?? "1900-01-01", index);
  const key = j.kind === "unknown" ? `unknown:${j.reason}` : j.kind;
  tally[key] = (tally[key] ?? 0) + 1;
  if (j.kind === "over") {
    over.push(`${String(e?.name ?? i.product_code).slice(0, 26)} TAIS ${e?.tais_code} 貸与 ${i.rental_price?.toLocaleString()} > 上限 ${j.ceiling.toLocaleString()} (開始 ${i.rental_start_date} / 世代 ${j.effectiveFrom})`);
  }
}
const judged = (tally.ok ?? 0) + (tally.over ?? 0);
console.log("判定の内訳:");
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(22)} ${v} 行`);
console.log(`\n★ 判定できた ${judged} / ${rentals.length} 行 (${((judged / Math.max(1, rentals.length)) * 100).toFixed(0)}%) → 上限内 ${tally.ok ?? 0} / **超過 ${tally.over ?? 0}**`);
over.slice(0, 20).forEach((s) => console.log("   " + s));
if (judged === 0) console.log("⚠ 分母 0 — 判定できていない (合格とは言わない)");
process.exitCode = (tally.over ?? 0) > 0 ? 1 : 0;
