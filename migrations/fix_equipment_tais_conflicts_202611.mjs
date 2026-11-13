/**
 * 同じ TAIS で中身が食い違う 2 組を直す (2026-11-13 user 承認。テクノエイド協会 TAIS で確認済み)
 *   build_equipment_variants.mjs の「M 判断が要る」2 組。これを先に流すと、まとめの対象に入る。
 *
 *   ① 00170-000969 (product_code 00170-000969) の種目 特殊寝台付属品 → 床ずれ防止用具
 *      TAIS: パラマウントベッド エバープラウド（ドライタイプ）KE-624UQ・種目 床ずれ防止用具 (830mm 幅・1,800mm)
 *   ② EQ-000957「オアシスポジティブ OS-12TRSP …エレベーティング＆スイング機構（左右）」車いす 1,000 を削除
 *      TAIS 00066-000297 は 松永 樹脂製スイングアウト＆エレベーティングユニット (車いす付属品) = EQ-000360 が正しい行。
 *      EQ-000957 は同じユニットを車いすとして登録した重複 (本体 OS-12TRSP は 00066-000296 で 別の行が既にある)。発注なし。
 *      どこかの表から参照されていたら 消さずに止める。
 *
 *   node migrations/fix_equipment_tais_conflicts_202611.mjs            DRY RUN (DB を読むだけ)
 *   node migrations/fix_equipment_tais_conflicts_202611.mjs --execute  書く (書く前の行を _backup_equipment_tais_conflicts_<時刻>.json に退避)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execLockStart, execLockRun } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REL = "apps/order-app/migrations/fix_equipment_tais_conflicts_202611.mjs";
const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");

const env = Object.fromEntries(readFileSync(join(HERE, "..", "..", "kaigo-app", ".env.local"), "utf8").split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CAT_CODE = "00170-000969", CAT_FROM = "特殊寝台付属品", CAT_TO = "床ずれ防止用具";
const DEL_CODE = "EQ-000957", DEL_TAIS = "00066-000297";
// product_code で品目を指しうる表 (列が無い表は 42703 で飛ばす)
const REF_TABLES = [
  ["order_items", "product_code"], ["client_rental_history", "product_code"], ["equipment_prices", "product_code"],
  ["equipment_price_history", "product_code"], ["equipment_office_prices", "product_code"], ["equipment_set_items", "set_product_code"],
  ["equipment_set_items", "component_product_code"], ["care_plan_elements", "product_code"], ["demo_units", "product_code"],
  ["sales_records", "product_code"], ["order_item_proration", "product_code"],
];

const lock = EXECUTE ? await execLockStart(sb, { script: SCRIPT_REL, argv }) : null;
const { data: rows, error } = await sb.from("equipment_master").select("*").in("product_code", [CAT_CODE, DEL_CODE]);
if (error) throw new Error(`equipment_master: ${error.message}`);
const cat = rows.find((r) => r.product_code === CAT_CODE);
const del = rows.find((r) => r.product_code === DEL_CODE);
const stop = (m) => { console.error(`★ 止めた: ${m}`); process.exit(2); };

console.log(`① ${CAT_CODE}「${cat?.name}」 種目 ${cat?.category}`);
const doCat = cat?.category === CAT_FROM;
if (!cat) stop(`${CAT_CODE} が無い`);
if (!doCat && cat.category !== CAT_TO) stop(`種目が想定外 (${cat.category})`);
console.log(doCat ? `   → ${CAT_TO} に直す` : "   → 既に直っている (何もしない)");

console.log(`② ${DEL_CODE}「${del?.name ?? "(無い)"}」 TAIS ${del?.tais_code ?? "-"} 種目 ${del?.category ?? "-"} 単位数 ${del?.rental_price ?? "-"}`);
let doDel = !!del;
let ownHist = []; // EQ-000957 自身の価格履歴 (品目と一緒に消す。発注・計画書などの参照ではない)
if (del) {
  if (del.tais_code !== DEL_TAIS || del.category !== "車いす") stop("削除する行の中身が想定と違う");
  const refs = [];
  {
    const { data: h, error: he } = await sb.from("equipment_price_history").select("*").eq("product_code", DEL_CODE);
    if (he) throw new Error(`equipment_price_history: ${he.message}`);
    ownHist = h ?? [];
    console.log(`   自身の価格履歴 ${ownHist.length} 行 (${ownHist.map((x) => `${x.valid_from}:${x.rental_price}${x.office_id ? "@" + x.office_id : ""}`).join(" ")}) → 品目と一緒に消す`);
  }
  for (const [t, col] of REF_TABLES.filter(([t]) => t !== "equipment_price_history")) {
    // head:true だと 列が無いときのエラーが空になる (本文が無い) ので 1 行だけ実際に取る
    const { data: hit, error: e } = await sb.from(t).select(col).eq(col, DEL_CODE).limit(1);
    const count = hit?.length ?? 0;
    if (e) { console.log(`   (${t}.${col}: ${e.code} ${e.message.slice(0, 60)} → 飛ばす)`); if (e.code === "42703" || e.code === "42P01" || /does not exist|schema cache/.test(e.message)) continue; throw new Error(`${t}.${col}: ${e.message}`); }
    if (count) refs.push(`${t}.${col} あり`);
  }
  const { data: cmp, error: ce } = await sb.from("equipment_master").select("product_code").contains("comparison_product_codes", [DEL_CODE]);
  if (ce) throw new Error(`comparison_product_codes: ${ce.message}`);
  if (cmp?.length) refs.push(`equipment_master.comparison_product_codes ${cmp.length} 行`);
  console.log(`   参照: ${refs.length ? refs.join(" / ") : "なし"}`);
  if (refs.length) stop("参照があるので消さない");
  console.log("   → 削除する");
} else console.log("   → 既に無い (何もしない)");

if (!EXECUTE) { console.log("DRY RUN (書いていない)"); process.exit(0); }
if (!doCat && !doDel) { console.log("何もすることが無い"); process.exit(0); }
const bk = join(HERE, `_backup_equipment_tais_conflicts_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(bk, JSON.stringify({ createdAt: new Date().toISOString(), rows, priceHistory: ownHist }, null, 2));
console.log(`退避: ${bk}`);
await execLockRun(sb, lock, { tenant_id: "kt-group", source_system: "order-app", source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "fix-tais-conflicts", notes: `${CAT_CODE} 種目→${CAT_TO} / ${DEL_CODE} 削除` }, async () => {
  if (doCat) {
    const { data, error: e } = await sb.from("equipment_master").update({ category: CAT_TO, updated_at: new Date().toISOString() }).eq("id", cat.id).eq("category", CAT_FROM).select("id");
    if (e || data?.length !== 1) throw new Error(`①: ${e?.message ?? `更新 ${data?.length} 件`}`);
    console.log("① 直した");
  }
  if (doDel) {
    for (const h of ownHist) {
      const { data: d, error: he } = await sb.from("equipment_price_history").delete().eq("id", h.id).eq("product_code", DEL_CODE).select("id");
      if (he || d?.length !== 1) throw new Error(`② 価格履歴 ${h.id}: ${he?.message ?? `削除 ${d?.length} 件`}`);
    }
    const { data, error: e } = await sb.from("equipment_master").delete().eq("id", del.id).select("id");
    if (e || data?.length !== 1) throw new Error(`②: ${e?.message ?? `削除 ${data?.length} 件`}`);
    console.log(`② 削除した (価格履歴 ${ownHist.length} 行も)`);
  }
});
