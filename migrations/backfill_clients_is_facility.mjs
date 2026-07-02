/**
 * 名前が明らかに事業所・施設である clients に is_facility=true を一括セットする。
 * (ソートロジックは実装済みだがフラグ未設定の事業所が157+件あり、
 *  名前順リストで個人利用者に混ざって表示される問題の解消)
 *
 * 判定: 事業所特有の複合語 (含有) + 「園/苑」(末尾一致のみ = 園田さん等の誤爆回避)
 * 既に is_facility=true の行は対象外。deleted_at 付きも対象外。
 *
 * Usage:
 *   node migrations/backfill_clients_is_facility.mjs            # DRY RUN (全対象を表示)
 *   node migrations/backfill_clients_is_facility.mjs --execute  # 本番 (backup JSON 保存後 UPDATE)
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
  } catch {
    return {};
  }
}
const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SB_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) { console.error("❌ SUPABASE_URL / SERVICE_ROLE_KEY が読めません"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const TENANT_ID = "kt-group";
const EXECUTE = process.argv.includes("--execute");

// 含有でマッチ (事業所特有の複合語のみ。単字・一般語は使わない)
const CONTAINS = [
  "事業所", "ケアプラン", "ケアマネ", "相談室", "センター", "ステーション",
  "グループホーム", "老人ホーム", "デイサービス", "デイケア", "ショートステイ",
  "訪問看護", "訪問介護", "居宅介護", "小規模多機能", "サービス付き高齢者",
  "病院", "クリニック", "医院", "薬局", "社会福祉", "福祉会", "福祉用具",
  "ケアサービス", "ケアサポート", "ケアハウス", "介護支援", "支援ハウス",
  "株式会社", "有限会社", "合同会社", "（株）", "(株)",
];
// 末尾一致のみ (「園田 花子」等の姓への誤爆を防ぐ)
const ENDSWITH = ["園", "苑", "ホーム", "の家", "の里", "荘"];

const isFacilityName = (name) => {
  const n = (name ?? "").trim();
  if (!n) return false;
  if (CONTAINS.some((w) => n.includes(w))) return true;
  if (ENDSWITH.some((w) => n.endsWith(w))) return true;
  return false;
};

async function fetchAll() {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from("clients")
      .select("id, name, furigana, is_facility")
      .eq("tenant_id", TENANT_ID)
      .is("deleted_at", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  console.log(`\n=== clients.is_facility backfill (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) ===`);
  const clients = await fetchAll();
  const already = clients.filter((c) => c.is_facility);
  const targets = clients.filter((c) => !c.is_facility && isFacilityName(c.name));
  console.log(`active clients: ${clients.length} / 既に is_facility=true: ${already.length} / 新たに true にする対象: ${targets.length}\n`);
  console.log("対象一覧 (全件):");
  targets.forEach((c) => console.log(`  - ${c.name}`));

  if (!EXECUTE) {
    console.log("\n(DRY RUN) 個人名の誤爆がないか一覧を確認のうえ --execute で反映。");
    return;
  }

  // backup (id, name, is_facility 変更前)
  const backupPath = join(__dirname, "_backup_clients_is_facility_20260702.json");
  writeFileSync(backupPath, JSON.stringify(targets.map((c) => ({ id: c.id, name: c.name, is_facility: c.is_facility ?? false })), null, 2));
  console.log(`\nbackup: ${backupPath}`);

  const ids = targets.map((c) => c.id);
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { error } = await sb.from("clients").update({ is_facility: true }).in("id", slice);
    if (error) { console.error(`❌ batch ${i} 失敗:`, error.message); process.exit(1); }
    done += slice.length;
    console.log(`  UPDATE ${done}/${ids.length}`);
  }

  const { count: after } = await sb.from("clients").select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID).eq("is_facility", true).is("deleted_at", null);
  console.log(`\n✅ 完了。is_facility=true 合計: ${after} 件 (期待: ${already.length + targets.length})`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
