/**
 * 事業所別保険 (DESIGN_INSURANCE_PER_OFFICE.md §7.4) — check:insurance-office
 *
 *   npx tsx scripts/insurance-office-check.mts [--month 2026-09] [--no-db]
 *
 * ① 純関数 (DB なし・gate): lib/insurance/office-scope.ts の rowsForOffice
 *    - per_office の事業所 → 自事業所の行だけ (他事業所・事業所未定は外れる)
 *    - shared の事業所 → per_office の事業所の行だけ外す (事業所未定・shared の行は残る)
 *    - per_office が 0 → 素通し (今の動き)
 *    負のコントロール: わざと規則を壊した実装で同じ検査が NG になることを確かめる
 * ② 実データ (service_role で読むだけ): per_office の事業所ごとに、その月に貸与 (介護) があるのに
 *    自事業所の当月有効な認定行が無い利用者を数えて列挙する (= 切替後に「認定なし」で伝送から外れる人)。
 *    ★ これは 0 を目指す数ではなく「切替前に複写/入力が要る人の一覧」。合否は ① だけで決める。
 */
import { readFileSync } from "node:fs";
import { rowsForOffice, isPerOffice } from "../lib/insurance/office-scope-rules";

let ng = 0;
const ok = (cond: boolean, label: string) => { console.log(`  ${cond ? "✓" : "✗ NG"} ${label}`); if (!cond) ng++; };

type R = { id: string; office_id: string | null };
const A = "office-A", B = "office-B", C = "office-C";
const rows: R[] = [
  { id: "a1", office_id: A }, { id: "b1", office_id: B }, { id: "c1", office_id: C }, { id: "n1", office_id: null },
];
const ids = (xs: R[]) => xs.map((r) => r.id).sort().join(",");

function run(impl: typeof rowsForOffice, label: string): number {
  const before = ng;
  console.log(`== ${label}`);
  ok(ids(impl(rows, A, [])) === "a1,b1,c1,n1", "per_office が 0 件 → 素通し");
  ok(ids(impl(rows, A, [A])) === "a1", "A が per_office → A の行だけ (他事業所・事業所未定は使わない)");
  ok(ids(impl(rows, B, [A])) === "b1,c1,n1", "B は shared・A が per_office → A の行だけ外す");
  ok(ids(impl(rows, null, [A])) === "b1,c1,n1", "事業所未選択 (全事業所表示) → per_office の行は外す");
  ok(ids(impl(rows, A, [A, B])) === "a1", "A・B とも per_office → A は A の行だけ");
  ok(ids(impl(rows, C, [A, B])) === "c1,n1", "C は shared → A・B の行を外す");
  ok(isPerOffice(A, [A]) && !isPerOffice(B, [A]) && !isPerOffice(null, [A]), "isPerOffice");
  return ng - before;
}

console.log("① 純関数 rowsForOffice");
run(rowsForOffice, "本物");
// 負のコントロール (NG が出ることを確かめたら ng から差し引く)
const broken1: typeof rowsForOffice = (r, o, p) => (p.length && p.includes(o ?? "") ? r.filter((x) => x.office_id === o || !x.office_id) : rowsForOffice(r, o, p));
const broken2: typeof rowsForOffice = (r) => r;
for (const [impl, label] of [[broken1, "負のコントロール: per_office で事業所未定の行を混ぜる"], [broken2, "負のコントロール: 何も絞らない"]] as const) {
  const n = run(impl, label);
  if (n > 0) { ng -= n; console.log(`  → 期待どおり NG ${n} 件 (検査が効いている)`); }
  else { console.log("  ✗ NG 負のコントロールで NG が出ない = 検査が効いていない"); ng++; }
}

// ② 実データ
const argv = process.argv.slice(2);
const MONTH = argv.includes("--month") ? argv[argv.indexOf("--month") + 1] : new Date().toISOString().slice(0, 7);
if (!argv.includes("--no-db")) {
  const env = Object.fromEntries(readFileSync(new URL("../../kaigo-app/.env.local", import.meta.url), "utf8").split(/\r?\n/)
    .filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]));
  const h = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  const all = async <T,>(q: string): Promise<T[]> => {
    const out: T[] = [];
    for (let f = 0; ; f += 1000) {
      const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${q}&order=id&offset=${f}&limit=1000`, { headers: h });
      if (!r.ok) throw new Error(`${q.split("?")[0]}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const d = (await r.json()) as T[];
      out.push(...d);
      if (d.length < 1000) return out;
    }
  };
  const [y, m] = MONTH.split("-").map(Number);
  const ms = `${MONTH}-01`, me = `${MONTH}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;
  const offices = await all<{ id: string; name: string }>("offices?select=id,name&insurance_scope=eq.per_office");
  console.log(`\n② 実データ (${MONTH}) — per_office の事業所 ${offices.length}`);
  for (const o of offices) {
    const orders = await all<{ id: string; client_id: string | null }>(`orders?select=id,client_id&office_id=eq.${o.id}`);
    const cidByOrder = new Map(orders.filter((x) => x.client_id).map((x) => [x.id, x.client_id!]));
    type It = { order_id: string; rental_start_date: string | null; rental_end_date: string | null; status: string; payment_type: string | null };
    const items: It[] = [];
    const oids = [...cidByOrder.keys()];
    for (let i = 0; i < oids.length; i += 150) items.push(...await all<It>(`order_items?select=id,order_id,rental_start_date,rental_end_date,status,payment_type&order_id=in.(${oids.slice(i, i + 150).join(",")})`));
    const targets = new Set(items.filter((it) => (it.payment_type ?? "介護") === "介護" && (it.status === "rental_started" || it.status === "terminated")
      && it.rental_start_date && it.rental_start_date <= me && (!it.rental_end_date || it.rental_end_date >= ms)).map((it) => cidByOrder.get(it.order_id)!));
    const tids = [...targets];
    const own = new Set<string>();
    for (let i = 0; i < tids.length; i += 150) {
      const recs = await all<{ client_id: string; certification_start_date: string | null; certification_end_date: string | null }>(
        `client_insurance_records?select=id,client_id,certification_start_date,certification_end_date&office_id=eq.${o.id}&client_id=in.(${tids.slice(i, i + 150).join(",")})`);
      for (const r of recs) if ((r.certification_start_date ?? "") <= me && (!r.certification_end_date || r.certification_end_date >= ms)) own.add(r.client_id);
    }
    const missing = tids.filter((c) => !own.has(c));
    console.log(`  ${o.name}: 当月の貸与 (介護) ${tids.length} 名 / 自事業所の当月有効な認定行なし ${missing.length} 名`);
    if (missing.length) {
      const cs = await all<{ id: string; name: string; user_number: string | null }>(`clients?select=id,name,user_number&id=in.(${missing.slice(0, 150).join(",")})`);
      for (const c of cs.slice(0, 40)) console.log(`     - ${c.name} (${c.user_number ?? "-"})`);
      if (cs.length > 40) console.log(`     … ほか ${cs.length - 40} 名`);
    }
  }
}

console.log(`\n${ng === 0 ? "PASS" : `FAIL — NG ${ng} 件`} (合否は ① の純関数だけ。② は切替前に複写/入力が要る人の一覧)`);
process.exit(ng === 0 ? 0 : 1);
