/**
 * 用具マスタ「楽起 縦型」(01339-000007) の価格 20,000 → 2,000 (2026-11-14 user 決定)
 *
 *   node migrations/fix_homda_rakki_price_typo.mjs                       DRY RUN (今の DB を読む。READ ONLY)
 *   node migrations/fix_homda_rakki_price_typo.mjs --execute --expect 1  本番
 *   node migrations/fix_homda_rakki_price_typo.mjs --revert <batch_id> [--execute]   取り消し (sync_fukuyogu_from_honobono.mjs の汎用処理)
 *
 * 事情: 誉田の価格取込 (batch bf1fcae2・import_office_prices_from_fygmst.mjs) で 用具マスタに無かった TAIS を品目として足したとき、
 *   誉田の ほのぼの用具マスタ FYGMST01 に この TAIS の行が 2,000・2,000・20,000 (記号なし) の 3 つあり、決め方 (同じ記号なら ID 最大) で
 *   20,000 を拾った。上限 2,330 (2024-04〜) の 8.6 倍で check:ceiling ① に出た。提供票 (2026-05〜11) に請求は無く、明細も 0 本。
 *   20,000 は 2,000 の桁の打ち間違いとみる (docs/homda-office-prices-2026-11.md)。
 * 直すもの: equipment_master.rental_price (product_code = 01339-000007・今 20,000 の行だけ)。
 *   その品目の価格履歴 (共通・事業所) や 貸与中の明細があれば 止める (この script の想定外)。
 * --execute: 直す前の行を migrations/_backup_rakki_price_<YYYYMMDD-HHmmss-SSS>.json に退避し、data_import_batches / data_import_rows に記録。
 *   「今の価格が 20,000」を条件に update して 更新件数 1 を確かめる。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { execLockStart, execLockAcquire } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (opt("--revert")) { const r = spawnSync(process.execPath, [join(HERE, "sync_fukuyogu_from_honobono.mjs"), ...argv], { stdio: "inherit" }); process.exit(r.status ?? 1); }
const EXECUTE = argv.includes("--execute");
if (EXECUTE && opt("--expect") !== "1") { console.error("★ --execute には --expect 1 が要る"); process.exit(1); }
const TENANT = "kt-group";
const CODE = "01339-000007", FROM = 20000, TO = 2000;
const SCRIPT_REL = "apps/order-app/migrations/fix_homda_rakki_price_typo.mjs";

const txt = readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8");
const E = Object.fromEntries(txt.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const sb = createClient(E.NEXT_PUBLIC_SUPABASE_URL, E.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const stop = (m) => { console.error(`★ ${m}`); process.exit(2); };
const lock = EXECUTE ? await execLockStart(sb, { script: SCRIPT_REL, argv }) : null;

const { data: eq, error: e1 } = await sb.from("equipment_master").select("*").eq("tenant_id", TENANT).or(`product_code.eq.${CODE},tais_code.eq.${CODE},parent_product_code.eq.${CODE}`);
if (e1) stop(`equipment_master: ${e1.message}`);
const { data: hist, error: e2 } = await sb.from("equipment_price_history").select("id,product_code,office_id,valid_from,rental_price").eq("tenant_id", TENANT).eq("product_code", CODE);
if (e2) stop(`equipment_price_history: ${e2.message}`);
const { data: its, error: e3 } = await sb.from("order_items").select("id,status,payment_type").eq("product_code", CODE);
if (e3) stop(`order_items: ${e3.message}`);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} / 用具マスタ ${eq.length} 行: ${eq.map((e) => `${e.product_code} ${e.name} ${e.rental_price} (親 ${e.parent_product_code ?? "-"})`).join(" / ")}`);
console.log(`  価格履歴 ${hist.length} 行 / 明細 ${its.length} 本`);
const target = eq.filter((e) => e.product_code === CODE && !e.parent_product_code && e.rental_price === FROM);
if (eq.length !== 1) stop(`用具マスタに ${CODE} に関わる行が ${eq.length} 行 (1 行の想定)`);
if (hist.length) stop(`価格履歴がある (${hist.map((h) => `${h.office_id ?? "共通"} ${h.valid_from}=${h.rental_price}`).join(" / ")}) → 用具マスタだけ直しても効かない`);
if (its.length) stop(`明細が ${its.length} 本ある → 請求額が変わる。止める`);
if (target.length !== 1) stop(`直す行 (価格 ${FROM}) が ${target.length} 行 (既に直っている?)`);
console.log(`\n書込みの見込み: equipment_master update 1 行 (${CODE} rental_price ${FROM} → ${TO})`);
if (!EXECUTE) { console.log("DRY RUN — DB は書き換えていない。--execute --expect 1 で本番"); process.exit(0); }

const d = new Date();
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}-${String(d.getMilliseconds()).padStart(3, "0")}`;
const bpath = join(HERE, `_backup_rakki_price_${stamp}.json`);
writeFileSync(bpath, JSON.stringify({ taken_at: d.toISOString(), rows: target }, null, 2) + "\n");
console.log(`退避: ${bpath}`);
const batch = await execLockAcquire(sb, lock, { tenant_id: TENANT, source_system: "honobono-fukuyogu", source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "rakki-price-typo", notes: `楽起 縦型 ${CODE} の価格 ${FROM}→${TO} (FYGMST01 の桁違いの行を拾った。batch bf1fcae2 の直し・user 決定 2026-11-14)` });
const fail = async (m) => { await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${m}` }).eq("id", batch.id); stop(m); };
const { data: up, error: e4 } = await sb.from("equipment_master").update({ rental_price: TO }).eq("id", target[0].id).eq("rental_price", FROM).select("id");
if (e4) await fail(`update: ${e4.message}`);
if (up?.length !== 1) await fail(`更新件数 ${up?.length}`);
const { error: e5 } = await sb.from("data_import_rows").insert({ batch_id: batch.id, tenant_id: TENANT, table_name: "equipment_master", row_id: target[0].id, op: "update", source_key: `価格|${CODE}`, source_ref: { 理由: "FYGMST01 の 20,000 は 2,000 の桁違い (提供票に請求なし・上限 2,330)" }, before: target[0], after: { rental_price: TO } });
if (e5) await fail(`data_import_rows: ${e5.message}`);
const { error: e6 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", batch.id);
if (e6) stop(`batch を executed にできない: ${e6.message}`);
console.log(`完了: 1 行。batch ${batch.id}。取り消しは --revert ${batch.id}`);
