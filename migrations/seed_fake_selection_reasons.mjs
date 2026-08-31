/**
 * equipment_master.selection_reason にサンプル文を一括投入する。
 *   - 対象: selection_reason が NULL または空 の行のみ (既存の本物は上書きしない)
 *   - 文面: category のキーワードに応じたテンプレ + 汎用テンプレをランダム割当
 *   - 目印 (UI では不可視):
 *       1) 文末にゼロ幅スペース U+200B を付与 → SQL で判別可能:
 *          SELECT count(*) FROM equipment_master WHERE selection_reason LIKE '%' || E'​';
 *       2) 投入した id 一覧を _seeded_selection_reason_ids_20260702.json に保存 (本命の台帳)
 *   - 削除/復元:
 *       UPDATE equipment_master SET selection_reason = NULL
 *       WHERE selection_reason LIKE '%' || E'​';
 *
 * Usage:
 *   node migrations/seed_fake_selection_reasons.mjs            # DRY RUN
 *   node migrations/seed_fake_selection_reasons.mjs --execute  # 本番
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

const TENANT_ID = "kt-group";
const EXECUTE = process.argv.includes("--execute");
const MARK = "​"; // ゼロ幅スペース (不可視マーカー)

// カテゴリキーワード → テンプレ群
const TEMPLATES = [
  { kw: ["寝台", "ベッド"], texts: [
    "起き上がり・立ち上がり動作に介助を要するため、背上げ・高さ調整機能により自立動作を支援し、介護者の負担軽減を図る。",
    "夜間の起居動作が不安定であり、ベッドの高さ調整と背上げ機能により安全な起居動作を確保する。",
    "自力での起き上がりが困難なため、背上げ機能を活用し残存機能の維持と褥瘡予防を図る。",
  ]},
  { kw: ["車いす", "車イス"], texts: [
    "長距離の歩行が困難であり、外出・移動手段の確保と行動範囲の拡大のため選定。",
    "下肢筋力の低下により歩行が不安定なため、安全な移動手段として選定。体格に合わせた座幅で座位保持も良好。",
  ]},
  { kw: ["つえ", "杖"], texts: [
    "歩行時のふらつきがあり、支持基底面を広げて安定した歩行を確保するため選定。",
    "屋外歩行時の転倒リスクが高く、歩行バランスの補助として選定。",
  ]},
  { kw: ["手すり", "手摺"], texts: [
    "立ち上がり・移動時の支えが必要であり、住環境を変更せず設置できる据置型手すりにより転倒予防を図る。",
    "玄関・廊下での伝い歩きが不安定なため、動線上に手すりを設置し安全な移動を確保する。",
    "トイレ・居室間の移動時にふらつきがあり、転倒予防と自立移動の継続のため選定。",
  ]},
  { kw: ["スロープ", "段差"], texts: [
    "玄関等の段差により出入りが困難なため、段差解消により安全な外出動線を確保する。",
    "車いすでの外出時に段差が障壁となっており、介助者の負担軽減と安全確保のため選定。",
  ]},
  { kw: ["床ずれ", "マットレス", "マット"], texts: [
    "自力での体位変換が困難であり、体圧分散により褥瘡発生リスクの軽減を図る。",
    "臥床時間が長く仙骨部に発赤が見られるため、体圧分散マットレスにより褥瘡予防を図る。",
  ]},
  { kw: ["歩行器", "歩行車"], texts: [
    "独歩では転倒リスクが高く、フレームの支持により安定した歩行と活動範囲の維持を図る。",
    "歩行耐久性が低下しており、休憩用の座面付き歩行車により外出機会の継続を支援する。",
  ]},
  { kw: ["リフト"], texts: [
    "移乗動作が全介助であり、介護者の腰痛予防と安全な移乗のため選定。",
  ]},
];
const GENERIC = [
  "身体状況および住環境を踏まえ、残存機能の活用と介護者の負担軽減を目的として選定。",
  "日常生活動作の自立支援と転倒等の事故予防を目的として選定。",
  "本人の身体機能と生活動線を評価し、安全な在宅生活の継続に必要と判断し選定。",
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const reasonFor = (category, name) => {
  const key = `${category ?? ""} ${name ?? ""}`;
  for (const t of TEMPLATES) if (t.kw.some((k) => key.includes(k))) return pick(t.texts);
  return pick(GENERIC);
};

async function main() {
  console.log(`\n=== 選定理由サンプル投入 (${EXECUTE ? "本番 EXECUTE" : "DRY RUN"}) ===`);
  const PAGE = 1000;
  const all = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb.from("equipment_master")
      .select("id, name, category, selection_reason")
      .eq("tenant_id", TENANT_ID)
      .order("id").range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  const targets = all.filter((e) => !e.selection_reason || !e.selection_reason.trim());
  console.log(`equipment: ${all.length} 件 / 選定理由が空 (対象): ${targets.length} 件 / 既存あり (対象外): ${all.length - targets.length} 件`);

  const plans = targets.map((e) => ({ id: e.id, name: e.name, reason: reasonFor(e.category, e.name) + MARK }));
  console.log("例 (先頭5件):");
  plans.slice(0, 5).forEach((p) => console.log(`  - ${p.name}: ${p.reason.replace(MARK, "")}`));

  if (!EXECUTE) { console.log("\n(DRY RUN) --execute で投入。"); return; }

  const ledgerPath = join(__dirname, "_seeded_selection_reason_ids_20260702.json");
  writeFileSync(ledgerPath, JSON.stringify(plans.map((p) => p.id), null, 2));
  console.log(`\n台帳 (目印): ${ledgerPath}`);

  let done = 0;
  for (const p of plans) {
    const { error } = await sb.from("equipment_master")
      .update({ selection_reason: p.reason })
      .eq("id", p.id);
    if (error) { console.error(`❌ ${p.name} 失敗:`, error.message); process.exit(1); }
    done++;
    if (done % 100 === 0 || done === plans.length) console.log(`  UPDATE ${done}/${plans.length}`);
  }

  const { count } = await sb.from("equipment_master")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .like("selection_reason", `%${MARK}`);
  console.log(`\n✅ 完了。ゼロ幅マーカー付き行: ${count} 件 (期待: ${plans.length})`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
