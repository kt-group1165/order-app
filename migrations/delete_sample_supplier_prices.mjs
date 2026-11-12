/**
 * 卸別仕入価格 (equipment_prices) のサンプル行を削除する。
 *
 *   node migrations/delete_sample_supplier_prices.mjs            # DRY RUN (件数と内訳を出すだけ)
 *   node migrations/delete_sample_supplier_prices.mjs --execute  # 本番 (バックアップ JSON を保存してから DELETE)
 *
 * 背景 (2026-11-12 user 承認「サンプルなら削除していい」):
 *   seed_fake_supplier_prices.mjs が入れた 2,556 行 (レンタル価格の 40〜50% をランダム・valid_from 2026-07-01)。
 *   マーカー supplier_product_code = 'SAMPLE-40-50pct'。実単価は 0 行。
 *   残しておくと 発注画面 (NewOrderModal / order/page.tsx) で卸を選んだとき この架空の単価が
 *   order_items.purchase_price (発注時スナップ) に写り、売上帳票の経費に架空の値が入る。
 *
 * 対象: supplier_product_code が 'SAMPLE-' で始まる行だけ。それ以外が 1 行でも混ざっていたら止める。
 * 戻し方: バックアップ JSON (migrations/_backup_sample_supplier_prices_<時刻>.json) を insert し直す。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXECUTE = process.argv.includes("--execute");
const env = Object.fromEntries(
  readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }),
);
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) { console.error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const MARK = "SAMPLE-";

async function selectAll(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/equipment_prices?${query}&order=id`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    const j = await r.json();
    if (!r.ok || !Array.isArray(j)) throw new Error(`select 失敗: ${r.status} ${JSON.stringify(j)}`);
    out.push(...j);
    if (j.length < 1000) return out;
  }
}
async function count(query) {
  const r = await fetch(`${SB_URL}/rest/v1/equipment_prices?select=id&${query}`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  if (!r.ok) throw new Error(`count 失敗: ${r.status} ${await r.text()}`);
  return Number((r.headers.get("content-range") ?? "*/0").split("/")[1]);
}

const all = await selectAll("select=*");
const sample = all.filter((p) => (p.supplier_product_code ?? "").startsWith(MARK));
const real = all.filter((p) => !(p.supplier_product_code ?? "").startsWith(MARK));
const by = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}: equipment_prices 全 ${all.length} 行 / サンプル ${sample.length} 行 / それ以外 ${real.length} 行`);
console.log("  サンプルの内訳 (supplier_product_code):", by(sample, (p) => p.supplier_product_code));
console.log("  サンプルの内訳 (valid_from):", by(sample, (p) => p.valid_from));
console.log("  サンプルの内訳 (tenant):", by(sample, (p) => p.tenant_id));
if (!sample.length) { console.log("削除対象なし"); process.exit(0); }

if (!EXECUTE) { console.log(`\nDRY RUN: ${sample.length} 行を削除する予定 (--execute で実行)`); process.exit(0); }

const backup = join(HERE, `_backup_sample_supplier_prices_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(backup, JSON.stringify(sample, null, 1));
console.log(`バックアップ: ${backup} (${sample.length} 行)`);

let deleted = 0;
const ids = sample.map((p) => p.id);
for (let i = 0; i < ids.length; i += 150) {
  const chunk = ids.slice(i, i + 150);
  // id で絞った上で マーカーも条件に入れる (万一 id がずれても サンプル以外は消えない)
  const r = await fetch(`${SB_URL}/rest/v1/equipment_prices?id=in.(${chunk.join(",")})&supplier_product_code=like.${MARK}*`, {
    method: "DELETE", headers: { ...H, Prefer: "return=representation" },
  });
  const body = await r.text();
  if (!r.ok) { console.error(`DELETE 失敗 (${deleted} 行削除済みで停止): ${r.status} ${body}`); process.exit(1); }
  const n = JSON.parse(body).length;
  if (n !== chunk.length) { console.error(`★ 削除件数 ${n} ≠ ${chunk.length} (${deleted + n} 行削除済みで停止)`); process.exit(1); }
  deleted += n;
}
const leftSample = await count(`supplier_product_code=like.${MARK}*`);
const leftAll = await count("id=not.is.null");
console.log(`削除 ${deleted} 行。残り: サンプル ${leftSample} 行 / 全体 ${leftAll} 行 (サンプル以外は ${real.length} 行のはず)`);
if (leftSample !== 0 || leftAll !== real.length) { console.error("★ 件数が想定と違う"); process.exit(1); }
