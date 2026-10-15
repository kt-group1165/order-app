/**
 * 上限価格超過 — ★ 実際に請求に乗る貸与だけを見る (npm run check:ceiling-rental)
 *
 * ■ なぜ要るか (2026-10-15 / B-2i)
 *   check:ceiling は用具マスタ全 2,159 件を見ていて、超過は 269 件 (①2 + ②267)。
 *   ところが 2026-10-15 に実測すると、そのうち 268 件は旧コード (EQ-xxxxxx, 1,520 件) で
 *   **order_items から 1 件も参照されていない**。請求に乗る超過は 1 口だけだった。
 *   マスタの件数だけ見ていると、本当に返戻になる 1 口が 269 に埋もれて見えない。
 *
 *   上限を超えた価格の貸与は ★ 保険給付の対象外 (超過分だけでなく月額全体)。
 *   伝送・請求画面は上限を一切見ていない (2026-10-15 時点・警告も無い) ので、ここで見張る。
 *
 * ■ 何を見るか
 *   その月に介護保険で請求される貸与の明細 (isCareRentalInMonth) を、
 *   請求画面と同じ価格 (価格改定履歴 → 無ければ用具マスタの現在価格。BillingTab getUnits と同じ)
 *   で、その月に効く上限と比べる。
 *     ・前月 (今月 10 日に伝送するサービス月)
 *     ・当月
 *     ・★ 取込済みで まだ施行されていない上限の世代ごと (= 改定前の「超過見込み」)
 *
 * ■ 判定 (基準値方式)
 *   超過している明細の id 集合を基準値に持ち、★ 基準値に無い id が 1 つでも出たら FAIL。
 *   件数ではなく集合で比べる (1 件直って 1 件増えても件数は変わらないため。SESSION_START ⑲)。
 *   基準値から消えたものは PASS のまま知らせる (--update で基準値から外してよい)。
 *
 * ■ 負のコントロール
 *   毎回、実在の上限に「上限 + 1 円」の架空明細を足して検出できることを確かめる。
 *   検出できなければ FAIL (判定が効いていない)。DB には何も書かない。
 *
 *   npm run check:ceiling-rental
 *   npm run check:ceiling-rental -- --update   基準値を置き直す (悪化していないことを確かめてから)
 *
 * DB は読むだけ (SELECT のみ)。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://dummy.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "dummy";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(__dirname, "ceiling-rental-baseline.json");
const UPDATE = process.argv.includes("--update");

type BaselineEntry = { id: string; label: string; price: number; ceiling: number; effectiveFrom: string };
type Baseline = { _readme: string[]; asOf: string; over: BaselineEntry[] };

async function main() {
  const { createClient } = await import("@supabase/supabase-js");
  const { indexCeilings, isCareRentalInMonth, findRentalOverruns, futureEffectiveDates } = await import("../lib/ceilingCheck");
  const { getPriceForMonth } = await import("../lib/equipment");

  const env: Record<string, string> = {};
  for (const p of [join(__dirname, "../../kaigo-app/.env.local"), join(__dirname, "../.env.local")]) {
    let txt = "";
    try { txt = readFileSync(p, "utf8"); } catch { continue; }
    for (const l of txt.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    // anon key だと RLS で 0 行になり「超過 0」と誤って言うので走らせない
    console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (合格ではない)。");
    process.exit(0);
  }
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  async function all<T>(table: string, select: string): Promise<T[]> {
    const out: T[] = [];
    for (let f = 0; ; f += 1000) {
      const { data, error } = await sb.from(table).select(select).order("id").range(f, f + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...((data ?? []) as T[]));
      if ((data ?? []).length < 1000) return out;
    }
  }

  type Item = { id: string; order_id: string; product_code: string; status: string | null; cancelled_at: string | null; rental_start_date: string | null; rental_end_date: string | null; payment_type: string | null; quantity: number | null };
  type Ord = { id: string; client_id: string | null; office_id: string | null; payment_type: string | null };
  type EM = { product_code: string; tais_code: string | null; name: string; rental_price: number | null };
  type Hist = { id: string; tenant_id: string; product_code: string; rental_price: number; valid_from: string; created_at: string };
  type Ceil = { tais_code: string; effective_from: string; ceiling_price: number };
  type Named = { id: string; name: string | null };
  type Off = { id: string; name: string | null; short_name: string | null };

  const [items, orders, em, hist, ceil, offices] = await Promise.all([
    all<Item>("order_items", "id, order_id, product_code, status, cancelled_at, rental_start_date, rental_end_date, payment_type, quantity"),
    all<Ord>("orders", "id, client_id, office_id, payment_type"),
    all<EM>("equipment_master", "id, product_code, tais_code, name, rental_price"),
    all<Hist>("equipment_price_history", "id, tenant_id, product_code, rental_price, valid_from, created_at"),
    all<Ceil>("equipment_price_ceilings", "id, tais_code, effective_from, ceiling_price"),
    all<Off>("offices", "id, name, short_name"),
  ]);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const emByCode = new Map(em.map((e) => [e.product_code, e]));
  const offById = new Map(offices.map((o) => [o.id, o]));
  const idx = indexCeilings(ceil);

  // ⚠ toISOString() は UTC なので JST 深夜に前日へずれる。ローカル日付で組む。
  const now = new Date();
  const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const todayIso = `${ym(now)}-${String(now.getDate()).padStart(2, "0")}`;
  const prevYm = ym(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const curYm = ym(now);
  const futures = futureEffectiveDates(idx, todayIso);

  const targets: { label: string; ym: string; onDate: string }[] = [
    { label: `前月 ${prevYm} (今月伝送するサービス月)`, ym: prevYm, onDate: `${prevYm}-01` },
    { label: `当月 ${curYm}`, ym: curYm, onDate: `${curYm}-01` },
    ...futures.map((d) => ({ label: `★ 見込み ${d} 施行の世代 (未施行)`, ym: d.slice(0, 7), onDate: d })),
  ];

  // 利用者名は表示用にだけ引く (超過した明細の分だけ)
  const clientName = new Map<string, string>();
  async function loadClientNames(ids: string[]) {
    const need = ids.filter((id) => id && !clientName.has(id));
    for (let i = 0; i < need.length; i += 150) {
      const { data, error } = await sb.from("clients").select("id, name").in("id", need.slice(i, i + 150));
      if (error) throw new Error(`clients: ${error.message}`);
      for (const c of (data ?? []) as Named[]) clientName.set(c.id, c.name ?? "(名前なし)");
    }
  }

  const overAll = new Map<string, BaselineEntry>();
  console.log(`【分母】order_items ${items.length} / 用具マスタ ${em.length} / 価格改定履歴 ${hist.length} / 上限価格 ${ceil.length} 行 (TAIS ${idx.size} 種) / 基準日 ${todayIso}`);
  if (futures.length === 0) console.log("   (未施行の上限世代は取込まれていない → 見込みの判定は無し)");

  let negativeControlOk = true;
  for (const t of targets) {
    const lines = [];
    let unknownTais = 0;
    for (const i of items) {
      const o = orderById.get(i.order_id);
      if (!o) continue;
      if (!isCareRentalInMonth(i, i.payment_type ?? o.payment_type, t.ym)) continue;
      const e = emByCode.get(i.product_code);
      // BillingTab getUnits と同じ価格の取り方 (月初時点の改定履歴 → 用具マスタ)
      const price = getPriceForMonth(hist, i.product_code, t.ym) ?? e?.rental_price ?? 0;
      if (!e?.tais_code || !idx.has(e.tais_code.trim())) unknownTais++;
      lines.push({ id: i.id, taisCode: e?.tais_code, price, quantity: i.quantity });
    }
    const overs = findRentalOverruns(lines, t.onDate, idx);
    await loadClientNames(overs.map((ov) => orderById.get(items.find((x) => x.id === ov.id)!.order_id)?.client_id ?? ""));
    const monthTotal = overs.reduce((s, ov) => s + ov.price * ov.quantity, 0);
    const monthExcess = overs.reduce((s, ov) => s + ov.excess * ov.quantity, 0);
    console.log(`\n■ ${t.label}`);
    console.log(`   請求対象の貸与 ${lines.length} 口 (上限マスタで判定できない ${unknownTais} 口) → ★ 超過 ${overs.length} 口`);
    if (overs.length) console.log(`   給付対象外になりうる月額 ¥${monthTotal.toLocaleString()} (うち上限を超えた分 ¥${monthExcess.toLocaleString()})`);
    for (const ov of overs) {
      const it = items.find((x) => x.id === ov.id)!;
      const o = orderById.get(it.order_id);
      const e = emByCode.get(it.product_code);
      const off = o?.office_id ? offById.get(o.office_id) : undefined;
      const label = `${clientName.get(o?.client_id ?? "") ?? "?"} / ${off?.short_name ?? off?.name ?? "?"} / ${e?.name ?? it.product_code} (${it.product_code})`;
      console.log(`   ・${label} 価格 ${ov.price.toLocaleString()} > 上限 ${ov.ceiling.toLocaleString()} (${ov.effectiveFrom} 施行) 超過 ${ov.excess.toLocaleString()}円 × ${ov.quantity} / 貸与開始 ${it.rental_start_date}`);
      if (!overAll.has(ov.id)) overAll.set(ov.id, { id: ov.id, label, price: ov.price, ceiling: ov.ceiling, effectiveFrom: ov.effectiveFrom });
    }

    // 負のコントロール: 実在の上限に +1 円の架空明細を足すと必ず鳴るはず
    const probe = lines.find((l) => l.taisCode && idx.has(String(l.taisCode).trim()));
    if (probe) {
      const gens = idx.get(String(probe.taisCode).trim())!.filter((g) => g.effective_from.slice(0, 10) <= t.onDate);
      if (gens.length) {
        const c = gens[gens.length - 1].ceiling_price;
        const hit = findRentalOverruns([{ id: "__probe__", taisCode: probe.taisCode, price: c + 1 }], t.onDate, idx);
        if (hit.length !== 1) negativeControlOk = false;
      }
    }
  }

  console.log(`\n負のコントロール (上限 + 1 円の架空明細): ${negativeControlOk ? "検出できた" : "★ 検出できなかった"}`);
  if (!negativeControlOk) {
    console.log("★ FAIL — 判定が効いていない");
    process.exitCode = 1;
    return;
  }

  const current = Array.from(overAll.values()).sort((a, b) => a.id.localeCompare(b.id));
  let baseline: Baseline | null = null;
  if (existsSync(BASELINE)) baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

  if (UPDATE || !baseline) {
    const out: Baseline = {
      _readme: [
        "npm run check:ceiling-rental の基準値。請求に乗る貸与明細のうち上限を超えている order_items.id の集合。",
        "基準値に無い id が出たら FAIL (件数ではなく集合で比べる)。",
        "2026-10-15 時点: 1 口 = 00160-000347 モダンリッチスタイル KMD-R12 (13,000円)。",
        "  2026-04-01 貸与開始時は上限が未公表、29回目公表 (2026-07-01 施行) で上限 12,850円 が初めて付いた。",
        "  価格を直すか (過誤含む) は user 判断待ち (DECISIONS_PENDING B-2i)。直ったら --update で外す。",
        "悪化 (新しい id) があるのに --update すると見張りが効かなくなる。必ず中身を読んでから。",
      ],
      asOf: todayIso,
      over: current,
    };
    writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`\n--update: 基準値を書きました (${current.length} 口)`);
    return;
  }

  const baseIds = new Set(baseline.over.map((b) => b.id));
  const curIds = new Set(current.map((c) => c.id));
  const added = current.filter((c) => !baseIds.has(c.id));
  const removed = baseline.over.filter((b) => !curIds.has(b.id));
  console.log(`\n基準値 (${baseline.asOf}): ${baseline.over.length} 口 / 今回: ${current.length} 口`);
  for (const r of removed) console.log(`   ○ 解消 (基準値から外してよい): ${r.label}`);
  if (added.length === 0) {
    console.log("✓ PASS (基準値に無い超過は無い)");
    return;
  }
  console.log(`★ FAIL — 基準値に無い超過が ${added.length} 口:`);
  for (const a of added) console.log(`   ・${a.label} 価格 ${a.price} > 上限 ${a.ceiling} (${a.effectiveFrom})`);
  console.log("  上限の新しい公表を取り込んだ直後なら、施行日までに価格の見直しが要る品目です。");
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
