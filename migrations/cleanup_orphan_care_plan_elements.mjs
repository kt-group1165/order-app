/**
 * 孤児 care_plan_elements のクリーンアップ。
 *   ref_table='order_items' の要素で、参照先 order_items が既に存在しないもの
 *   (発注の作成→削除→再作成の名残) を削除する。
 *   契約書/計画書の「発生要因」に亡霊行として出てくる問題の解消。
 *
 * Usage:
 *   node migrations/cleanup_orphan_care_plan_elements.mjs            # DRY RUN
 *   node migrations/cleanup_orphan_care_plan_elements.mjs --execute  # 本番 (backup 後 DELETE)
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
if (!SB_URL || !SB_KEY) { console.error("❌ env 読めません"); process.exit(1); }
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const EXECUTE = process.argv.includes("--execute");

async function fetchAll(table, columns, applyFilter) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(columns).range(from, from + PAGE - 1);
    if (applyFilter) q = applyFilter(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function main() {
  console.log(`\n=== 孤児 care_plan_elements クリーンアップ (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) ===`);

  // order_items 参照の要素を全取得
  const els = await fetchAll("care_plan_elements", "id, client_id, element_type, occurred_at, ref_id, status, created_at",
    (q) => q.eq("ref_table", "order_items"));
  console.log(`ref_table='order_items' の要素: ${els.length} 件`);

  // 実在する order_items id 集合
  const itemIds = new Set((await fetchAll("order_items", "id")).map((r) => r.id));
  console.log(`order_items 実在: ${itemIds.size} 件`);

  const orphans = els.filter((e) => !itemIds.has(e.ref_id));
  console.log(`孤児 (参照先が存在しない): ${orphans.length} 件`);

  // client 別サマリ
  const byClient = new Map();
  for (const o of orphans) byClient.set(o.client_id, (byClient.get(o.client_id) ?? 0) + 1);
  console.log(`影響 client 数: ${byClient.size}`);
  const statusCount = {};
  for (const o of orphans) statusCount[o.status] = (statusCount[o.status] ?? 0) + 1;
  console.log("status 内訳:", JSON.stringify(statusCount));
  console.log("例 (先頭10件):");
  orphans.slice(0, 10).forEach((o) =>
    console.log(`  - ${o.occurred_at} | ${o.element_type} | status=${o.status} | client=${o.client_id.slice(0, 8)} | created=${o.created_at?.slice(0, 19)}`));

  if (!EXECUTE) {
    console.log("\n(DRY RUN) --execute で削除。completed の孤児も削除対象 (参照先が無い以上、済み判定の根拠も消えているため)。");
    return;
  }

  const backupPath = join(__dirname, "_backup_orphan_care_plan_elements_20260702.json");
  writeFileSync(backupPath, JSON.stringify(orphans, null, 2));
  console.log(`\nbackup: ${backupPath}`);

  const ids = orphans.map((o) => o.id);
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { error } = await sb.from("care_plan_elements").delete().in("id", slice);
    if (error) { console.error(`❌ batch ${i} 失敗:`, error.message); process.exit(1); }
    done += slice.length;
    console.log(`  DELETE ${done}/${ids.length}`);
  }

  // 検証
  const remain = (await fetchAll("care_plan_elements", "id, ref_id", (q) => q.eq("ref_table", "order_items")))
    .filter((e) => !itemIds.has(e.ref_id)).length;
  console.log(`\n✅ 完了。残存孤児: ${remain} 件 (期待: 0)`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
