/**
 * 用具マスタ EQ-000001 / EQ-000002 の桁違い価格を直す (DECISIONS_PENDING B-2i ①)
 *
 *   node migrations/fix_eq_typo_rental_price.mjs                    DRY RUN (既定・書込なし)
 *   node migrations/fix_eq_typo_rental_price.mjs --price 9500       DRY RUN (価格を指定して計画だけ見る)
 *   node migrations/fix_eq_typo_rental_price.mjs --price 9500 --execute   本番 (★ --price 必須)
 *
 * ── 何が壊れているか (2026-10-15 実測) ─────────────────────────────────────
 *   TAIS 00170-001300 (パラマウントベッド 楽匠プラス 2モーション) の旧コード 2 品目:
 *     EQ-000001 (91cm幅 KQ-A5322)  equipment_master 110,000円
 *        price_history 2020-01-01 11,000 / ★ 2026-02-01 110,000 / 2026-01-01 11,000 (04-20 に後から追加)
 *     EQ-000002 (83cm幅 KQ-A5122)  equipment_master 1,100,000円
 *        price_history 2020-01-01 11,000 / ★ 2026-03-01 1,100,000
 *   ★ の 2 行は 2026-03-29 05:58:48 / 05:59:13 (24 秒差) に入った。11,000 に 0 を 1 個 / 2 個足した形。
 *
 * ── 正しい値の材料 ────────────────────────────────────────────────────────
 *   候補 A  9,500円  ← 推奨
 *     ① 同じ TAIS の現行コード 00170-001300 (用具マスタ) が 9,500円
 *     ② その現行コードの介護貸与 13 口のうち 12 口が 9,500円 (残り 1 口は 4,750円)
 *     ③ 上限 9,540円 (2024-04-01 施行・20回目公表) の内側
 *   候補 B  11,000円 (桁違いになる前の値)
 *     ① 両品目の price_history 2020-01-01 (同じ取込バッチ) がどちらも 11,000円
 *     ② EQ-000001 には 2026-04-20 に 11,000円 (2026-01-01〜) が後から足されている
 *     ⚠ ただし 11,000円 は上限 9,540円 を超える (超過 1,460円)。直しても check:ceiling の②に残る
 *
 * ── 金額への影響 ─────────────────────────────────────────────────────────
 *   EQ-xxxxxx (旧コード 1,520 件) は order_items から 1 件も参照されていない (2026-10-15 実測)。
 *   請求・伝送の金額は変わらない。マスタと価格履歴の表示・発注入力時の既定価格だけが直る。
 *
 * ── 何をするか (--execute のとき) ─────────────────────────────────────────
 *   1. 対象 4 行 (master 2 行 + 桁違いの price_history 2 行) を
 *      migrations/_backup_eq_typo_rental_price_<yyyymmdd>.json に退避
 *   2. equipment_master.rental_price を --price に UPDATE (2 行)
 *   3. 桁違いの price_history 2 行の rental_price を --price に UPDATE (行は消さない)
 *   4. 読み直して件数・値を確認 (想定と違えば exit 1)
 *   ★ 退避した時点の値と DB の現在値が違う (他で直された) 場合は何もせず exit 2。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const priceArgIdx = process.argv.indexOf("--price");
const PRICE = priceArgIdx >= 0 ? Number(process.argv[priceArgIdx + 1]) : null;

const env = {};
for (const p of [join(__dirname, "../../kaigo-app/.env.local"), join(__dirname, "../.env.local")]) {
  let txt = "";
  try { txt = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of txt.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY が見つかりません (apps/kaigo-app/.env.local)");
  process.exit(1);
}
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function get(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function patch(path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { method: "PATCH", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`PATCH ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const TENANT = "kt-group";
const TAIS = "00170-001300";
// 期待する現在値 (ここから変わっていたら止める)
const EXPECT_MASTER = { "EQ-000001": 110000, "EQ-000002": 1100000 };
const EXPECT_HISTORY = {
  "810e5881-005e-4022-8331-299ab2382278": { product_code: "EQ-000001", valid_from: "2026-02-01", rental_price: 110000 },
  "832c9fb3-5696-465a-ae9d-3af534b7980d": { product_code: "EQ-000002", valid_from: "2026-03-01", rental_price: 1100000 },
};

console.log(EXECUTE ? "=== EXECUTE ===" : "=== DRY RUN (書込なし) ===");

const master = await get(`equipment_master?tenant_id=eq.${TENANT}&product_code=in.(EQ-000001,EQ-000002)&select=id,product_code,tais_code,name,rental_price,updated_at`);
const hist = await get(`equipment_price_history?id=in.(${Object.keys(EXPECT_HISTORY).join(",")})&select=*`);
const sameTais = await get(`equipment_master?tenant_id=eq.${TENANT}&tais_code=eq.${TAIS}&select=product_code,name,rental_price`);
const ceil = await get(`equipment_price_ceilings?tenant_id=eq.${TENANT}&tais_code=eq.${TAIS}&select=effective_from,ceiling_price,publication_label&order=effective_from`);
const liveItems = await get(`order_items?tenant_id=eq.${TENANT}&product_code=eq.${TAIS}&select=rental_price,status`);
const eqItems = await get(`order_items?tenant_id=eq.${TENANT}&product_code=in.(EQ-000001,EQ-000002)&select=id`);

console.log("\n[現在値]");
for (const m of master) console.log(`  equipment_master ${m.product_code} ${m.name} = ${m.rental_price.toLocaleString()}円`);
for (const h of hist) console.log(`  price_history    ${h.product_code} ${h.valid_from}〜 = ${h.rental_price.toLocaleString()}円 (id ${h.id})`);
console.log("\n[材料]");
console.log(`  上限 (TAIS ${TAIS}): ${ceil.map((c) => `${c.effective_from} ${c.ceiling_price.toLocaleString()}円 (${c.publication_label})`).join(" / ")}`);
console.log(`  同じ TAIS の用具マスタ: ${sameTais.map((x) => `${x.product_code}=${x.rental_price?.toLocaleString()}`).join(" / ")}`);
const live = {};
for (const i of liveItems) { const k = `${i.rental_price}円/${i.status}`; live[k] = (live[k] ?? 0) + 1; }
console.log(`  現行コード ${TAIS} の貸与明細: ${JSON.stringify(live)}`);
console.log(`  EQ-000001/002 を参照する order_items: ${eqItems.length} 件 (0 なら請求額は変わらない)`);

// 現在値が想定どおりか
const problems = [];
if (master.length !== 2) problems.push(`equipment_master が ${master.length} 行 (想定 2)`);
for (const m of master) if (m.rental_price !== EXPECT_MASTER[m.product_code]) problems.push(`${m.product_code} の現在価格が ${m.rental_price} (想定 ${EXPECT_MASTER[m.product_code]})`);
if (hist.length !== 2) problems.push(`price_history が ${hist.length} 行 (想定 2)`);
for (const h of hist) {
  const e = EXPECT_HISTORY[h.id];
  if (!e || h.product_code !== e.product_code || h.valid_from !== e.valid_from || h.rental_price !== e.rental_price) problems.push(`price_history ${h.id} が想定と違う: ${JSON.stringify(h)}`);
}
if (problems.length) {
  console.log("\n★ 現在値が想定と違うので何もしません (既に直された可能性):");
  problems.forEach((p) => console.log("   " + p));
  process.exit(2);
}

const latestCeil = ceil.length ? ceil[ceil.length - 1].ceiling_price : null;
const candidates = PRICE != null ? [PRICE] : [9500, 11000];
console.log("\n[計画]");
for (const p of candidates) {
  const over = latestCeil != null && p > latestCeil;
  console.log(`  --price ${p}: equipment_master 2 行 / price_history 2 行 を ${p.toLocaleString()}円 に UPDATE` +
    (over ? `  ⚠ 上限 ${latestCeil.toLocaleString()}円 を ${(p - latestCeil).toLocaleString()}円 超える (check:ceiling ②に残る)` : `  (上限 ${latestCeil?.toLocaleString()}円 以内)`));
}

if (!EXECUTE) {
  console.log("\nDRY RUN 終了。実行するには --price <円> --execute (価格は user が決める)。");
  process.exit(0);
}
if (PRICE == null || !Number.isInteger(PRICE) || PRICE <= 0) {
  console.error("\n--execute には --price <正の整数> が必須です (どちらの値にするかは user 判断)。");
  process.exit(1);
}

// 1. 退避
const d = new Date();
const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const backupPath = join(__dirname, `_backup_eq_typo_rental_price_${ymd}.json`);
writeFileSync(backupPath, JSON.stringify({ taken_at: d.toISOString(), equipment_master: master, equipment_price_history: hist }, null, 2) + "\n", "utf8");
console.log(`\n退避: ${backupPath}`);

// 2-3. 更新 (現在値も条件に入れて、他で変わっていたら 0 行になるようにする)
let updated = 0;
for (const m of master) {
  const r = await patch(`equipment_master?id=eq.${m.id}&rental_price=eq.${m.rental_price}`, { rental_price: PRICE, updated_at: new Date().toISOString() });
  updated += r.length;
}
for (const h of hist) {
  const r = await patch(`equipment_price_history?id=eq.${h.id}&rental_price=eq.${h.rental_price}`, { rental_price: PRICE });
  updated += r.length;
}
console.log(`UPDATE: ${updated} 行 (想定 4)`);

// 4. 読み直し
const m2 = await get(`equipment_master?tenant_id=eq.${TENANT}&product_code=in.(EQ-000001,EQ-000002)&select=product_code,rental_price`);
const h2 = await get(`equipment_price_history?id=in.(${Object.keys(EXPECT_HISTORY).join(",")})&select=id,rental_price`);
const ok = updated === 4 && m2.length === 2 && m2.every((x) => x.rental_price === PRICE) && h2.length === 2 && h2.every((x) => x.rental_price === PRICE);
console.log(`確認: master ${JSON.stringify(m2)} / history ${JSON.stringify(h2)}`);
if (!ok) {
  console.error(`★ 想定と違います。退避ファイル ${backupPath} から戻すか確認してください。`);
  process.exit(1);
}
console.log("✓ 完了。npm run check:ceiling を回し、①が 0 件になったことを確かめてから --update すること。");
