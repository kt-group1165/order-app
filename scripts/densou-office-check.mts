/**
 * check:densou-office — 福祉用具の伝送を「実際に貸した事業所 (orders.office_id) の番号」で出せているか (2026-11-13 追加)
 *
 *   npm run check:densou-office            純関数の検査 + DB の検査 (orders / order_items / offices を READ ONLY で 1 回ずつ)
 *   npm run check:densou-office -- --no-db 純関数の検査だけ (DB を読まない)
 *   npm run check:densou-office -- --update 基準値 (scripts/densou-office-baseline.json) を今の値で書き直す (★ 増えた理由を確かめてから)
 *
 * 検査:
 *   ④ (本命・DB 不要) lib/kokuho-densou/densou-office.ts planDensouOffice が
 *      事業所未選択・番号が 10 桁でない → 止める / 注文の事業所が空 → 外す / 他の事業所 → 外す / 選んだ事業所 → その番号
 *      負のコントロール: 直す前の決め方 (テナントの番号に落とし、警告だけで続ける) だと 未選択で ファイルが作られてしまうことも示す
 *   ① orders.office_id が NULL の注文 (伝送に入れられない)            基準値 0
 *   ② 同じ人・同じ月に 2 事業所から介護で借りている組 (月遅れのフラグ billing_late_flags は事業所を持たないので 伝染する) 基準値 = 実測
 *   ③ 福祉用具事業所 (_fukuyogu_office.mjs の 5 つ) の offices.business_number が 10 桁でない  基準値 0
 *   ★ ① の負のコントロール: 架空の NULL 注文を 1 件足すと ① が増えて鳴ることを確かめる
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planDensouOffice } from "../lib/kokuho-densou/densou-office";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(HERE, "densou-office-baseline.json");
const argv = process.argv.slice(2);
const NO_DB = argv.includes("--no-db");
const UPDATE = argv.includes("--update");

let pass = 0;
const fails: string[] = [];
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  OK  ${label}`); } else { fails.push(`${label}\n      期待 ${w}\n      実際 ${g}`); console.log(`  NG  ${label}`); }
};

console.log("══ ④ planDensouOffice (伝送の事業所の決め方・DB 不要) ══");
const OFF = [
  { id: "A", business_number: "1272400050", name: "ケアサポ" },
  { id: "B", business_number: "1270502097", name: "誉田" },
  { id: "C", business_number: "", name: "番号なし" },
];
const lines = [
  { itemId: "a1", orderOfficeId: "A" }, { itemId: "a2", orderOfficeId: "A" },
  { itemId: "b1", orderOfficeId: "B" }, { itemId: "n1", orderOfficeId: null },
];
{
  const p = planDensouOffice(lines, "A", OFF);
  eq("ケアサポを選ぶ → ケアサポの番号・ケアサポの明細だけ", [p.officeNumber, p.included], ["1272400050", ["a1", "a2"]]);
  eq("誉田の明細は 外す (other_office)", p.excluded.filter((e) => e.reason === "other_office").map((e) => e.itemId), ["b1"]);
  eq("★ 注文の事業所が空の明細は 外して警告 (どの事業所の伝送にも入れない)", [p.excluded.filter((e) => e.reason === "office_null").map((e) => e.itemId), p.warnings.length], [["n1"], 1]);
  eq("止めない", p.blockers.length, 0);
}
{
  const p = planDensouOffice(lines, "B", OFF);
  eq("誉田を選ぶ → 誉田の番号・誉田の明細だけ", [p.officeNumber, p.included], ["1270502097", ["b1"]]);
}
{
  const p = planDensouOffice(lines, null, OFF);
  eq("★ 事業所未選択 (全事業所) → 止める (番号なし・明細なし)", [p.blockers.length, p.officeNumber, p.included.length], [1, null, 0]);
}
{
  const p = planDensouOffice(lines, "C", OFF);
  eq("★ 事業所番号が 10 桁でない → 止める", [p.blockers.length, p.officeNumber], [1, null]);
}
// 負のコントロール: 直す前の決め方 (BillingTab generateTransferData 2026-11-13 まで)。未選択で テナントの番号 (kt-group は空) に落とし、
//   build.ts は「10 桁の数字ではありません」を警告に積むだけで ファイルを作る → 全事業所の明細が 番号空の 1 本に入る
{
  const tenantNumber = ""; // tenants.business_number (kt-group は空。_dump_parts 9/30 の写しで確認)
  const oldPlan = (selected: string | null) => {
    const cur = OFF.find((o) => o.id === selected);
    const num = (cur?.business_number || tenantNumber).replace(/-/g, "");
    const blocked = !!selected && !cur?.business_number; // 選んだ事業所に番号が無いときだけ止めていた
    const items = lines.filter((l) => !selected || !l.orderOfficeId || l.orderOfficeId === selected).map((l) => l.itemId);
    const warnings = /^\d{10}$/.test(num) ? [] : [`事業所番号が 10 桁の数字ではありません ("${num}")`];
    return { blocked, num, items, fileMade: !blocked && items.length > 0, warnings };
  };
  const o = oldPlan(null);
  eq("負のコントロール: 直す前は 未選択でも止まらず ファイルを作っていた (番号空・全事業所 4 明細・警告 1)", [o.fileMade, o.num, o.items.length, o.warnings.length], [true, "", 4, 1]);
  const o2 = oldPlan("A");
  eq("負のコントロール: 直す前は ケアサポを選んでも 事業所が空の注文 (n1) が入っていた", o2.items.includes("n1"), true);
  eq("負のコントロール: 新しい決め方と違う (= 検査が効いている)", JSON.stringify(o.items) !== JSON.stringify(planDensouOffice(lines, null, OFF).included), true);
}

type Baseline = { _readme: string[]; asOf: string; officeNull: number; multiOfficePairs: number; badBusinessNumber: number };

async function dbChecks() {
  const { resolveFukuyoguOffice, FUKUYOGU_OFFICES } = await import("../migrations/_fukuyogu_office.mjs");
  void resolveFukuyoguOffice;
  const envTxt = readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8");
  const env = Object.fromEntries(envTxt.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
  const H = { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` };
  // 直列・1 本ずつ・5xx/HTML で止める (リトライしない)
  const all = async <T,>(table: string, sel: string, filter = ""): Promise<T[]> => {
    const out: T[] = [];
    for (let o = 0; ; o += 1000) {
      const r = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${table}?select=${sel}${filter}&order=id&limit=1000&offset=${o}`, { headers: H });
      const t = await r.text();
      if (!r.ok || t.startsWith("<")) throw new Error(`STOP (リトライしない) ${r.status} ${table} ${t.slice(0, 120)}`);
      const j = JSON.parse(t) as T[];
      out.push(...j);
      if (j.length < 1000) break;
    }
    return out;
  };
  type Ord = { id: string; client_id: string | null; office_id: string | null; payment_type: string | null };
  type Item = { id: string; order_id: string; status: string; payment_type: string | null; rental_start_date: string | null; rental_end_date: string | null; cancelled_at: string | null };
  const orders = await all<Ord>("orders", "id,client_id,office_id,payment_type", "&tenant_id=eq.kt-group");
  const items = await all<Item>("order_items", "id,order_id,status,payment_type,rental_start_date,rental_end_date,cancelled_at", "&tenant_id=eq.kt-group");
  const offices = await all<{ id: string; name: string; business_number: string | null }>("offices", "id,name,business_number");
  console.log(`\nDB (READ ONLY): orders ${orders.length} / order_items ${items.length} / offices ${offices.length}`);

  const countNull = (os: Ord[]) => os.filter((o) => !o.office_id).length;
  const officeNull = countNull(orders);
  // 負のコントロール: 架空の NULL 注文を足すと増える
  eq("① 負のコントロール: 架空の NULL 注文を 1 件足すと ① が 1 増える", countNull([...orders, { id: "x", client_id: "x", office_id: null, payment_type: "介護" }]) - officeNull, 1);

  // ② 同じ人・同じ月に 2 事業所から介護で借りている組 (直近 12 か月)
  const ordById = new Map(orders.map((o) => [o.id, o]));
  const months: string[] = [];
  const now = new Date();
  for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); months.push(d.toISOString().slice(0, 7)); }
  const offByClientMonth = new Map<string, Set<string>>();
  for (const it of items) {
    if (!["rental_started", "terminated"].includes(it.status) || it.cancelled_at || !it.rental_start_date) continue;
    const o = ordById.get(it.order_id);
    if (!o?.client_id || !o.office_id) continue;
    if ((it.payment_type ?? o.payment_type ?? "介護") !== "介護") continue;
    for (const ym of months) {
      if (it.rental_start_date > `${ym}-31` || (it.rental_end_date && it.rental_end_date < `${ym}-01`)) continue;
      const k = `${o.client_id}|${ym}`;
      if (!offByClientMonth.has(k)) offByClientMonth.set(k, new Set());
      offByClientMonth.get(k)!.add(o.office_id);
    }
  }
  const multi = [...offByClientMonth].filter(([, s]) => s.size >= 2);
  // ③ 福祉用具事業所の番号
  const bad = (FUKUYOGU_OFFICES as { officeId: string; area: string }[]).filter((f) => !/^\d{10}$/.test(String(offices.find((o) => o.id === f.officeId)?.business_number ?? "").replace(/-/g, "")));

  console.log(`① 注文の事業所が空: ${officeNull} 件`);
  console.log(`② 同じ人・同じ月に 2 事業所から介護で借りている組 (直近 12 か月): ${multi.length}${multi.length ? ` (例 ${multi.slice(0, 5).map(([k]) => k).join(", ")})` : ""}`);
  console.log(`③ 事業所番号が 10 桁でない福祉用具事業所: ${bad.length}${bad.length ? ` (${bad.map((b) => b.area).join(", ")})` : ""}`);
  return { officeNull, multiOfficePairs: multi.length, badBusinessNumber: bad.length };
}

async function main() {
  let cur: { officeNull: number; multiOfficePairs: number; badBusinessNumber: number } | null = null;
  if (!NO_DB) cur = await dbChecks();
  console.log(`\n══ 純関数の検査: ${pass} 件 OK / ${fails.length} 件 NG ══`);
  for (const f of fails) console.log("  ✗ " + f);
  if (fails.length) { process.exitCode = 1; return; }
  if (!cur) { console.log("(--no-db: ①②③ は見ていない)"); return; }
  const base: Baseline | null = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
  if (UPDATE || !base) {
    const out: Baseline = {
      _readme: [
        "check:densou-office の基準値。増えたら FAIL。",
        "officeNull: orders.office_id が NULL の注文 (伝送に入れられない)。2026-11-13 時点 0 (注文 1,621 件すべてケアサポ)。",
        "multiOfficePairs: 同じ人・同じ月に 2 事業所から介護で借りている組 (billing_late_flags が事業所を持たないので 月遅れが伝染する)。実測値。",
        "badBusinessNumber: 福祉用具 5 事業所のうち offices.business_number が 10 桁でないもの。0 であること。",
        "増えた理由を確かめずに --update しないこと。",
      ],
      asOf: new Date().toISOString().slice(0, 10),
      ...cur,
    };
    writeFileSync(BASELINE, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`基準値を書きました: ${JSON.stringify(cur)}`);
    return;
  }
  const worse = (["officeNull", "multiOfficePairs", "badBusinessNumber"] as const).filter((k) => cur![k] > base[k]);
  console.log(`基準値 (${base.asOf}): ${JSON.stringify({ officeNull: base.officeNull, multiOfficePairs: base.multiOfficePairs, badBusinessNumber: base.badBusinessNumber })} / 今回: ${JSON.stringify(cur)}`);
  if (worse.length) { console.log(`★ FAIL — 増えた: ${worse.join(", ")}`); process.exitCode = 1; return; }
  console.log("✓ PASS");
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
