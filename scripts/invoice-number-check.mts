/**
 * 利用者請求書 (invoices) の 保存・採番を検証する
 *
 *   npx tsx scripts/invoice-number-check.mts              # 読むだけ (列の突合まで)
 *   npx tsx scripts/invoice-number-check.mts --execute    # サンプルで採番を試し ★ 最後に必ず消す
 *
 * ── 🔴 結論: この機能は **使われていない** のではなく **壊れている** ──────────
 *   `invoices` が 0 行なのは「まだ使っていない」からだと思って調べ始めたが、
 *   **保存そのものが必ず失敗する**状態だった (2026-09-03 実測)。
 *
 *     BillingTab.tsx の upsert が書いていた列  … issued_date / copay_amount
 *     ★ DB の実際の列は  **issue_date / total_amount**
 *       (`issued_date` は d が余分なタイプミス。`copay_amount` は名前ごと違う)
 *
 *   → 「保存」を押すと必ず catch に落ち、
 *     `alert("保存に失敗しました。invoices テーブルの作成状態を確認してください。")`
 *     が出る。**沈黙はしないが、原因が「テーブルの作成状態」と読めるので
 *     「列が足りない」に辿り着きにくい。**
 *
 * ── ★ だから最初に「コードが書く列が DB にあるか」を見る ─────────────────
 *   これを先にやらないと、後続の検査が **全部 42703 で落ちて意味を成さない**。
 *   (実際 1 度目の実行で「UNIQUE がある」と誤読しかけた。
 *    2 行目が弾かれた理由は unique 違反ではなく **列が無い** だった)
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const NUMS = ["ZC301", "ZC302"];

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

let n = 0, ng = 0;

const { count: cur, error: e0 } = await sb.from("invoices").select("*", { count: "exact", head: true });
if (e0) throw new Error(`invoices: ${e0.message}`);
console.log(`【分母】invoices ${cur} 行`);

// ══ ★ ① コードが読み書きする列が DB にあるか (これを最初にやる) ══════════
console.log(`\n══ ★ ① BillingTab が読み書きする列が DB にあるか ══`);
/** BillingTab.tsx:2807 (select) と :2904 (upsert) に出てくる列 */
const USED = [
  "tenant_id", "client_id", "billing_month", "invoice_number", "year_issued",
  "issue_date", "total_amount", "data",
];
const missing: string[] = [];
for (const c of USED) {
  const { error } = await sb.from("invoices").select(c).limit(1);
  if (error) missing.push(c);
  console.log(`  ${error ? "★ 無い" : "OK    "} ${c.padEnd(16)}${error ? `  (${error.code})` : ""}`);
}
n++;
if (missing.length) {
  ng++;
  console.log(`\n  🔴 **${missing.length} 列が DB に無い: ${missing.join(", ")}**`);
  console.log(`     → \`handleSave\` の upsert は **必ず失敗する**。`);
  console.log(`       「保存」を押すと毎回 alert("保存に失敗しました…") が出る。`);
  console.log(`     ⚠ alert の文面が「テーブルの作成状態を確認してください」なので、`);
  console.log(`       **列が足りない**という本当の原因に辿り着きにくい。`);
  console.log(`     ⚠ repo に \`invoices\` を作る SQL は無い (Supabase で直接作られている)。`);
  console.log(`       → **コードと DB がいつからずれたか追えない**。`);
} else {
  console.log(`\n  OK  コードが使う列はすべて DB にある`);
}

if (!EXECUTE) {
  console.log(`\n【読むだけ】--execute でサンプルを入れて採番を試す`);
  if (missing.length) {
    console.log(`⚠ ただし **列が足りないので採番の検査は意味を成さない**。`);
    console.log(`  先に列を足すこと。足してから --execute で:`);
    console.log(`    ・同時に 2 人が発行したとき番号が重複しないか`);
    console.log(`    ・再発行で番号が変わらないか`);
    console.log(`    ・年をまたぐと通し番号か / 年ごとに 1 からか`);
  }
  process.exit(0);
}

// ══ ②以降: 列が揃っている前提の検査 ═══════════════════════════════════
if (missing.length) {
  console.log(`\n🔴 列が足りないので採番の検査は **実行しない**。`);
  console.log(`   (無理に流すと 42703 で全部落ち、"弾かれた = UNIQUE がある" と誤読する)`);
  console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
  process.exit(ng ? 1 : 0);
}

const cleanup = async () => {
  const { data: cl } = await sb.from("clients").select("id").in("user_number", NUMS);
  const ids = (cl ?? []).map((c) => c.id);
  if (ids.length) {
    await sb.from("invoices").delete().in("client_id", ids);
    await sb.from("clients").delete().in("id", ids);
  }
  const { data: left } = await sb.from("clients").select("id").in("user_number", NUMS);
  const { count: invLeft } = await sb.from("invoices").select("*", { count: "exact", head: true });
  console.log(`\n  ★ 撤去: サンプル利用者 残り ${(left ?? []).length} 件 / invoices 全体 ${invLeft} 行`);
  return (left ?? []).length === 0;
};
await cleanup();

const { data: ins, error: e1 } = await sb.from("clients").insert(
  NUMS.map((num, i) => ({
    tenant_id: TENANT, user_number: num, name: `請求書見本${i + 1} [sample-c]`,
    furigana: "セイキュウショミホン", gender: "男", birth_date: "1940-01-01", status: "active",
  })),
).select("id, user_number");
if (e1) { console.error(`✗ clients: ${e1.message}`); process.exit(1); }
const [c1, c2] = ins;

const mk = (clientId: string, month: string, number: number, year: number) => ({
  tenant_id: TENANT, client_id: clientId, billing_month: month,
  invoice_number: number, year_issued: year, issue_date: "2026-12-31",
  total_amount: 1000, data: { _sample_marker: "sample-c" },
});

try {
  console.log(`\n══ ★ ② 同時に 2 人が発行したら (本命) ══`);
  await sb.from("invoices").insert(mk(c1.id, "2026-10", 500, 2026));
  const issueLikeUi = async (clientId: string, month: string) => {
    const { data: mx } = await sb.from("invoices")
      .select("invoice_number").eq("tenant_id", TENANT)
      .order("invoice_number", { ascending: false }).limit(1);
    const next = ((mx?.[0]?.invoice_number as number) ?? 0) + 1;
    const { error } = await sb.from("invoices").upsert(
      mk(clientId, month, next, 2026), { onConflict: "tenant_id,client_id,billing_month" });
    return { next, error: error?.message ?? null };
  };
  const [r1, r2] = await Promise.all([
    issueLikeUi(c1.id, "2026-11"), issueLikeUi(c2.id, "2026-11"),
  ]);
  console.log(`  1 人目: 番号 ${r1.next} / ${r1.error ?? "成功"}`);
  console.log(`  2 人目: 番号 ${r2.next} / ${r2.error ?? "成功"}`);
  n++;
  if (r1.next === r2.next && !r1.error && !r2.error) {
    ng++;
    console.log(`  NG  ★ **2 人が同じ番号 ${r1.next} で発行できた** = 同番号の請求書が 2 通出る`);
  } else if (r1.next === r2.next) {
    console.log(`  OK  同じ番号を取ったが片方が DB に弾かれた (${r1.error ?? r2.error})`);
  } else {
    console.log(`  OK  別々の番号になった (${r1.next} / ${r2.next})`);
  }

  console.log(`\n══ ★ ③ 採番は 年ごとにリセットか / 通し番号か ══`);
  // ★ UNIQUE に year_issued が入っているかで **設計が決まる**。
  //   入っていない = 年をまたいでも番号は一意でなければならない = ★ 通し番号が正しい
  //   入っている   = 年ごとに 1 から振り直してよい
  // 同じ番号を **違う年**で入れて、通るかどうかで判定する。
  const { data: exist } = await sb.from("invoices").select("invoice_number")
    .eq("tenant_id", TENANT).order("invoice_number", { ascending: false }).limit(1);
  const someNumber = (exist?.[0]?.invoice_number as number) ?? 501;
  const { error: yErr } = await sb.from("invoices").insert(mk(c2.id, "2025-11", someNumber, 2025));
  n++;
  if (yErr) {
    console.log(`  OK  ★ 同じ番号 ${someNumber} を違う年 (2025) で入れると弾かれる (${yErr.code})`);
    console.log(`      → UNIQUE に year_issued は **入っていない** = 番号は tenant で通し`);
    console.log(`      → ★ max を年で絞らない今の実装が **正しい**。`);
    console.log(`        年ごとに 1 から振り直すと衝突するので、そう直してはいけない。`);
  } else {
    ng++;
    console.log(`  NG  ★ 同じ番号を違う年で入れられた = UNIQUE に year_issued が入っている`);
    console.log(`      → 年ごとに振り直す設計。max を年で絞らない今の実装は **バグ**`);
  }
  console.log(`  ⚠ 表示の \`year\` は **表示のためだけ**に持っている、という読みになる。`);
} finally {
  const okClean = await cleanup();
  n++;
  if (!okClean) { ng++; console.log(`  NG  ★ サンプルが残った。手で消すこと`); }
  else console.log(`  OK  ★ サンプルを残さず消した`);
}

console.log(`\n══ 検査 ${n} 件 / NG ${ng} 件 ══`);
