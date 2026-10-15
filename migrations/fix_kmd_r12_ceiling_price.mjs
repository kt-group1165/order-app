/**
 * KMD-R12 (TAIS 00160-000347) を上限価格 12,850円 に直し、鴇田 八重子 の 2026-07〜09 提供分に過誤フラグを立てる
 * (DECISIONS_PENDING B-2i / user 判断 2026-10-15「上限価格に直して、過誤も進めて」)
 *
 *   node migrations/fix_kmd_r12_ceiling_price.mjs             DRY RUN
 *   node migrations/fix_kmd_r12_ceiling_price.mjs --execute   本番
 *
 * 背景:
 *   貸与開始 2026-04-01 (13,000円) の時点では上限が未公表。29回目公表 (2026-07-01 施行) で上限 12,850円 が付き、
 *   2026-07 から上限超過 = 月額全体が保険給付の対象外になりうる (返戻)。
 *
 * やること:
 *   1. equipment_price_history に 2 行足す
 *        2026-04-01 13,000円  ← これが無いと 4〜6 月も新しいマスタ価格 (12,850) で計算されてしまう
 *        2026-07-01 12,850円
 *      (BillingTab は 価格改定履歴 → 用具マスタ の順で価格を引く。KMD-R12 は履歴 0 行だった)
 *   2. equipment_master.rental_price を 12,850 に
 *   3. billing_rebill_flags に 過誤 を 3 行 (2026-07 / 08 / 09)。請求画面の「返戻過誤 伝送」に出るようになる
 *   order_items.rental_price (発注時の価格 13,000) は記録なので触らない。請求額には使われていない。
 *
 * 撤去したいとき: 退避 JSON (_backup_kmd_r12_ceiling_<日付>.json) の master 価格を戻し、
 *   ここで足した price_history 2 行・rebill_flags 3 行 (id を退避 JSON に控える) を消す。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const EXECUTE = process.argv.includes("--execute");
const TENANT = "kt-group";
const CODE = "00160-000347";
const OLD_PRICE = 13000;
const NEW_PRICE = 12850;
const CLIENT_ID = "ca3f417d-d9b5-465a-bded-9927b2573d44"; // 鴇田 八重子 (被保番 0000018675)
const ORDER_ITEM_ID = "51186b5c-9ae4-4794-bde3-7ee718d7b569";
const KAGO_MONTHS = ["2026-07", "2026-08", "2026-09"];
const HISTORY = [
  { valid_from: "2026-04-01", rental_price: OLD_PRICE },
  { valid_from: "2026-07-01", rental_price: NEW_PRICE },
];

const loadEnv = (p) => existsSync(p) ? Object.fromEntries(
  readFileSync(p, "utf8").split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
) : {};
const env = {
  ...loadEnv(join(APP, "..", "kaigo-app", ".env.local")),
  ...loadEnv(join(APP, "..", "calendar-app", ".env.local")),
  ...loadEnv(join(APP, ".env.local")),
};
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) { console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が見つかりません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function req(method, path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method, headers: { ...H, ...(method === "GET" ? {} : { Prefer: "return=representation" }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return j;
}

// ── 現状 ───────────────────────────────────────────────
const master = await req("GET", `equipment_master?select=id,product_code,name,rental_price&tenant_id=eq.${TENANT}&product_code=eq.${CODE}`);
const history = await req("GET", `equipment_price_history?select=id,valid_from,rental_price&tenant_id=eq.${TENANT}&product_code=eq.${CODE}&order=valid_from`);
const ceilings = await req("GET", `equipment_price_ceilings?select=*&tais_code=eq.${CODE}`);
const item = await req("GET", `order_items?select=id,product_code,rental_price,status,rental_start_date,rental_end_date&id=eq.${ORDER_ITEM_ID}`);
const flags = await req("GET", `billing_rebill_flags?select=id,month,flag_type&tenant_id=eq.${TENANT}&client_id=eq.${CLIENT_ID}`);
const renters = await req("GET", `order_items?select=id&product_code=eq.${CODE}&status=eq.rental_started`);

console.log("[現状]");
console.log(`  用具マスタ ${JSON.stringify(master)}`);
console.log(`  価格改定履歴 ${history.length} 行 ${JSON.stringify(history)}`);
console.log(`  上限マスタ ${JSON.stringify(ceilings.map((c) => ({ ...c, id: undefined })))}`);
console.log(`  鴇田 八重子 の貸与明細 ${JSON.stringify(item)}`);
console.log(`  この品目を貸与中の明細 ${renters.length} 口`);
console.log(`  鴇田 八重子 の返戻/過誤フラグ ${JSON.stringify(flags)}`);

const problems = [];
if (master.length !== 1) problems.push(`用具マスタが ${master.length} 行`);
else if (master[0].rental_price !== OLD_PRICE && master[0].rental_price !== NEW_PRICE) problems.push(`用具マスタの価格が想定外 ${master[0].rental_price}`);
if (item.length !== 1 || item[0].product_code !== CODE) problems.push("鴇田 八重子 の貸与明細が見つからない");
if (!ceilings.some((c) => Number(c.ceiling_price ?? c.price_ceiling ?? c.upper_limit ?? c.price) === NEW_PRICE)) {
  console.log(`  ⚠ 上限マスタに ${NEW_PRICE} 円の行が見当たらない (列名の違いかもしれないので上の生データを確認)`);
}
if (problems.length) { console.error("✗ 止めます:", problems.join(" / ")); process.exit(2); }

const addHistory = HISTORY.filter((h) => !history.some((x) => x.valid_from === h.valid_from));
const clash = HISTORY.filter((h) => history.some((x) => x.valid_from === h.valid_from && x.rental_price !== h.rental_price));
if (clash.length) { console.error("✗ 同じ日付で別の価格の履歴がある:", JSON.stringify(clash)); process.exit(2); }
const addFlags = KAGO_MONTHS.filter((m) => !flags.some((f) => f.month === m));
const otherFlags = flags.filter((f) => KAGO_MONTHS.includes(f.month) && f.flag_type !== "過誤");
if (otherFlags.length) { console.error("✗ 対象月に 過誤 以外のフラグがある:", JSON.stringify(otherFlags)); process.exit(2); }

console.log("\n[計画]");
console.log(`  価格改定履歴に追加 ${addHistory.length} 行 ${JSON.stringify(addHistory)}`);
console.log(`  用具マスタ ${master[0].rental_price} → ${NEW_PRICE}${master[0].rental_price === NEW_PRICE ? " (済)" : ""}`);
console.log(`  過誤フラグ追加 ${addFlags.length} 行 ${JSON.stringify(addFlags)}`);
console.log(`  金額: 7〜9 月 各 費用 13,000 → 12,850 / 保険 11,700 → 11,565 / 本人 1,300 → 1,285 (1 割の場合)`);

if (!EXECUTE) { console.log("\nDRY RUN — --execute で実行"); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const backupPath = join(HERE, `_backup_kmd_r12_ceiling_${stamp}.json`);
const backup = { master, history, flags, added: { history: [], flags: [] } };
writeFileSync(backupPath, JSON.stringify(backup, null, 2));

if (addHistory.length) {
  const rows = await req("POST", "equipment_price_history?select=id,valid_from,rental_price",
    addHistory.map((h) => ({ tenant_id: TENANT, product_code: CODE, ...h })));
  backup.added.history = rows.map((r) => r.id);
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
}
if (master[0].rental_price !== NEW_PRICE) {
  const rows = await req("PATCH", `equipment_master?id=eq.${master[0].id}&rental_price=eq.${master[0].rental_price}`, { rental_price: NEW_PRICE, updated_at: new Date().toISOString() });
  if (rows.length !== 1) { console.error(`✗ 用具マスタの更新が ${rows.length} 行 (想定 1)`); process.exit(1); }
}
if (addFlags.length) {
  const rows = await req("POST", "billing_rebill_flags?select=id,month",
    addFlags.map((m) => ({ tenant_id: TENANT, client_id: CLIENT_ID, month: m, flag_type: "過誤" })));
  backup.added.flags = rows.map((r) => r.id);
  writeFileSync(backupPath, JSON.stringify(backup, null, 2));
}

// ── 読み直し ───────────────────────────────────────────
const m2 = await req("GET", `equipment_master?select=rental_price&id=eq.${master[0].id}`);
const h2 = await req("GET", `equipment_price_history?select=valid_from,rental_price&tenant_id=eq.${TENANT}&product_code=eq.${CODE}&order=valid_from`);
const f2 = await req("GET", `billing_rebill_flags?select=month,flag_type&tenant_id=eq.${TENANT}&client_id=eq.${CLIENT_ID}&order=month`);
console.log(`\n退避: ${backupPath}`);
console.log(`確認: マスタ ${m2[0]?.rental_price} / 履歴 ${JSON.stringify(h2)} / フラグ ${JSON.stringify(f2)}`);
const ok = m2[0]?.rental_price === NEW_PRICE
  && HISTORY.every((h) => h2.some((x) => x.valid_from === h.valid_from && x.rental_price === h.rental_price))
  && KAGO_MONTHS.every((m) => f2.some((f) => f.month === m && f.flag_type === "過誤"));
console.log(ok ? "✓ 完了。npm run check:ceiling-rental で超過 0 口を確認し、基準値を --update すること" : "✗ 想定と違う");
process.exit(ok ? 0 : 1);
