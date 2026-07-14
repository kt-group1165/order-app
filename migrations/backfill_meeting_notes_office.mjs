/**
 * service_meeting_notes の office_id NULL レコードを手当てする。
 *   - 山下泰弘 / 葛田しげ  → ケア・サポート千葉 (caresupo) に紐付け
 *   - テスト               → 削除 (捨てデータ)
 *
 * client_id 未連動 (利用者名は手入力) のため自動判別は不可。
 * 対象は client_name 完全一致 + office_id IS NULL の行のみ (誤爆防止)。
 *
 * Usage:
 *   node migrations/backfill_meeting_notes_office.mjs            # DRY RUN
 *   node migrations/backfill_meeting_notes_office.mjs --execute  # 本番 (backup JSON 保存後に実行)
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
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
  } catch { return {}; }
}
const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const TENANT_ID = "kt-group";
const EXECUTE = process.argv.includes("--execute");

const CARESUPO = { id: "1bfc0d57-9ee0-4ae2-baa5-80edb776290a", label: "介護ショップケア・サポート千葉" };
// client_name (完全一致) → アクション
const ASSIGN_TO_CARESUPO = ["山下　泰弘", "葛田　しげ"]; // 全角スペース区切りに注意
const DELETE_NAMES = ["テスト"];

// NULL レコードを取得
const { data: nulls, error } = await sb
  .from("service_meeting_notes")
  .select("id, client_name, office_id, office_label, meeting_date, created_date, created_at")
  .eq("tenant_id", TENANT_ID)
  .is("office_id", null);
if (error) { console.error("ERR fetch:", error.message); process.exit(1); }

console.log(`office_id NULL: ${nulls.length} 件\n`);

const toAssign = [];
const toDelete = [];
const unmatched = [];
for (const r of nulls) {
  const name = (r.client_name || "").trim();
  if (ASSIGN_TO_CARESUPO.includes(name)) toAssign.push(r);
  else if (DELETE_NAMES.includes(name)) toDelete.push(r);
  else unmatched.push(r);
}

console.log("── ケアサポに紐付け ──");
for (const r of toAssign) console.log(`  UPDATE ${r.client_name} (${r.id}) → office=${CARESUPO.label}`);
console.log("── 削除 ──");
for (const r of toDelete) console.log(`  DELETE ${r.client_name} (${r.id})`);
if (unmatched.length) {
  console.log("── 対象外 (名前一致せず・手動確認) ──");
  for (const r of unmatched) console.log(`  SKIP ${r.client_name} (${r.id})`);
}

if (!EXECUTE) {
  console.log("\n[DRY RUN] --execute で実行します。");
  process.exit(0);
}

// backup
const backupPath = join(__dirname, `_backup_meeting_notes_null.json`);
writeFileSync(backupPath, JSON.stringify(nulls, null, 2), "utf8");
console.log(`\nbackup 保存: ${backupPath}`);

let assigned = 0, deleted = 0;
for (const r of toAssign) {
  const { error: e } = await sb
    .from("service_meeting_notes")
    .update({ office_id: CARESUPO.id, office_label: CARESUPO.label, updated_at: new Date().toISOString() })
    .eq("id", r.id)
    .is("office_id", null); // 二重防御: まだ NULL の行のみ
  if (e) { console.error(`  UPDATE 失敗 ${r.client_name}:`, e.message); process.exit(1); }
  assigned++;
}
for (const r of toDelete) {
  const { error: e } = await sb.from("service_meeting_notes").delete().eq("id", r.id);
  if (e) { console.error(`  DELETE 失敗 ${r.client_name}:`, e.message); process.exit(1); }
  deleted++;
}
console.log(`\n✅ 完了: UPDATE ${assigned} 件 / DELETE ${deleted} 件`);

// 検証
const { data: after } = await sb
  .from("service_meeting_notes")
  .select("id, client_name, office_label")
  .eq("tenant_id", TENANT_ID)
  .is("office_id", null);
console.log(`残り office_id NULL: ${after?.length ?? "?"} 件`);
