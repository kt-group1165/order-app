/**
 * 古い未消化 (pending) の保険系 発生要因を削除する。
 *   対象: care_plan_elements の element_type IN (plan_renewal, plan_change, care_office_change)
 *         かつ status='pending' かつ occurred_at < CUTOFF (直近13ヶ月より古い)
 *   背景: 2026-05 の backfill が過去の保険履歴全行 (最古2000年) から要素を生成し、
 *         書類作成画面の「発生要因」に何年も前のプラン更新等がノイズとして並ぶ。
 *   completed (書類作成済みの記録) は残す。order_items 系 (納品/回収) も対象外。
 *
 * Usage:
 *   node migrations/cleanup_stale_insurance_elements.mjs            # DRY RUN
 *   node migrations/cleanup_stale_insurance_elements.mjs --execute  # 本番 (backup 後 DELETE)
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
const CUTOFF = "2025-06-01"; // 直近13ヶ月より古い occurred_at を削除
const TYPES = ["plan_renewal", "plan_change", "care_office_change"];

async function fetchAll(table, cols, f) {
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(cols).range(from, from + PAGE - 1);
    if (f) q = f(q);
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
  console.log(`\n=== 古い保険系 発生要因の削除 (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) — CUTOFF: ${CUTOFF} ===`);
  const targets = await fetchAll(
    "care_plan_elements",
    "id, client_id, element_type, occurred_at, status, created_at",
    (q) => q.eq("status", "pending").in("element_type", TYPES).lt("occurred_at", CUTOFF)
  );
  console.log(`削除対象 (pending / 保険系 / occurred_at < ${CUTOFF}): ${targets.length} 件`);
  const byType = {};
  for (const t of targets) byType[t.element_type] = (byType[t.element_type] ?? 0) + 1;
  console.log("type 内訳:", JSON.stringify(byType));
  const clients = new Set(targets.map((t) => t.client_id));
  console.log(`影響 client 数: ${clients.size}`);

  // 残る側の確認
  const { count: remainAfter } = await sb.from("care_plan_elements")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending").in("element_type", TYPES).gte("occurred_at", CUTOFF);
  console.log(`残す側 (>= ${CUTOFF} の pending 保険系): ${remainAfter} 件`);

  if (!EXECUTE) { console.log("\n(DRY RUN) --execute で削除。"); return; }

  const backupPath = join(__dirname, "_backup_stale_insurance_elements_20260702.json");
  writeFileSync(backupPath, JSON.stringify(targets, null, 2));
  console.log(`\nbackup: ${backupPath}`);

  const ids = targets.map((t) => t.id);
  const BATCH = 200;
  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { error } = await sb.from("care_plan_elements").delete().in("id", slice);
    if (error) { console.error(`❌ batch ${i} 失敗:`, error.message); process.exit(1); }
    done += slice.length;
    if (done % 1000 === 0 || done === ids.length) console.log(`  DELETE ${done}/${ids.length}`);
  }

  const { count: remain } = await sb.from("care_plan_elements")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending").in("element_type", TYPES).lt("occurred_at", CUTOFF);
  console.log(`\n✅ 完了。残存 (期待 0): ${remain} 件`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
