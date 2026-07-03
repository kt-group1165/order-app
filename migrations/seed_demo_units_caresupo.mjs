/**
 * ケアサポ デモ機管理表.xlsx から抽出した台帳 (_demo_units_caresupo.json) を
 * demo_units / demo_loans に初期取込する。
 *   - office = 介護ショップケア・サポート千葉 (1bfc0d57-9ee0-4ae2-baa5-80edb776290a)
 *   - 貸出中 (利用者名あり・返却日なし) は demo_loans に returned_date NULL で登録
 *   - 冪等: 同 office に同 unit_no が既に存在する行は skip
 *
 * Usage:
 *   node migrations/seed_demo_units_caresupo.mjs            # DRY RUN (JSON 集計のみ・DB 不要)
 *   node migrations/seed_demo_units_caresupo.mjs --execute  # 本番 (要 migration 適用済)
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path) {
  try {
    const env = readFileSync(path, "utf8");
    const vars = {};
    for (const line of env.split("\n")) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}

const TENANT_ID = "kt-group";
const OFFICE_ID = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a"; // ケア・サポート千葉
const EXECUTE = process.argv.includes("--execute");
const KNOWN_LOCS = new Set(["事務所", "利用者宅", "消毒庫", "社用車"]);

const units = JSON.parse(readFileSync(join(__dirname, "_demo_units_caresupo.json"), "utf8"));

console.log(`\n=== ケアサポ デモ機 初期取込 (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) ===`);
console.log(`JSON 台数: ${units.length}`);
const byCat = {};
for (const u of units) byCat[u.category] = (byCat[u.category] ?? 0) + 1;
console.log("カテゴリ内訳:", JSON.stringify(byCat));
const openLoans = units.filter((u) => u.client_name && !u.returned_date);
const closedLoans = units.filter((u) => u.client_name && u.returned_date);
console.log(`貸出中: ${openLoans.length} / 返却済み履歴: ${closedLoans.length}`);
const oddLocs = [...new Set(units.map((u) => u.storage_location).filter((l) => l && !KNOWN_LOCS.has(l)))];
if (oddLocs.length) console.log("既知外の保管場所 (そのまま登録):", oddLocs);

if (!EXECUTE) {
  console.log("\n(DRY RUN) --execute で投入 (migration add_demo_units.sql 適用後に)。");
  process.exit(0);
}

const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ env 読めません"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// 既存 unit_no (冪等 skip 用)
const { data: existing, error: exErr } = await sb
  .from("demo_units").select("unit_no").eq("tenant_id", TENANT_ID).eq("office_id", OFFICE_ID);
if (exErr) { console.error("❌ 既存確認失敗:", exErr.message); process.exit(1); }
const existingNos = new Set((existing ?? []).map((r) => r.unit_no));

let inserted = 0, skipped = 0, loansMade = 0;
for (let i = 0; i < units.length; i++) {
  const u = units[i];
  if (existingNos.has(u.unit_no)) { skipped++; continue; }
  const { data: unitRow, error: uErr } = await sb.from("demo_units").insert({
    tenant_id: TENANT_ID,
    office_id: OFFICE_ID,
    unit_no: u.unit_no,
    category: u.category ?? "",
    product_name: u.product_name,
    color: u.color ?? null,
    storage_location: u.storage_location && u.storage_location !== "保管場所" ? u.storage_location : "事務所",
    cleaned: !!u.cleaned,
    memo: u.memo ?? null,
    sort_order: (i + 1) * 10,
  }).select("id").single();
  if (uErr) { console.error(`❌ unit ${u.unit_no} 失敗:`, uErr.message); process.exit(1); }
  inserted++;

  // 貸出情報 (貸出中 or 返却済み履歴)
  if (u.client_name) {
    const { error: lErr } = await sb.from("demo_loans").insert({
      tenant_id: TENANT_ID,
      unit_id: unitRow.id,
      client_name: u.client_name,
      taken_date: u.taken_date ?? null,
      taken_by: u.taken_by ?? null,
      due_date: u.due_date ?? null,
      returned_date: u.returned_date ?? null,
      returned_by: u.returned_by ?? null,
      memo: u.memo ?? null,
    });
    if (lErr) { console.error(`❌ loan ${u.unit_no} 失敗:`, lErr.message); process.exit(1); }
    loansMade++;
  }
  if (inserted % 20 === 0) console.log(`  ${inserted}...`);
}

const { count: unitCount } = await sb.from("demo_units").select("*", { count: "exact", head: true })
  .eq("tenant_id", TENANT_ID).eq("office_id", OFFICE_ID);
const { count: openCount } = await sb.from("demo_loans").select("*", { count: "exact", head: true })
  .eq("tenant_id", TENANT_ID).is("returned_date", null);
console.log(`\n✅ 完了。units 追加 ${inserted} / skip ${skipped} / loans ${loansMade}`);
console.log(`検証: office の demo_units = ${unitCount} 件 / 貸出中 loans = ${openCount} 件`);
