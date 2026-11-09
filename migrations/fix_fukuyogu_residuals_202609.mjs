/**
 * 福祉用具 (ケアサポ) 提供 2026-09 の残差を個別に直す (FY-D2 / user 承認 2026-11-09)
 *
 *   node migrations/fix_fukuyogu_residuals_202609.mjs                    # DRY RUN (既定)
 *   node migrations/fix_fukuyogu_residuals_202609.mjs --execute          # 本番
 *   node migrations/fix_fukuyogu_residuals_202609.mjs --revert <batch_id> [--execute]
 *   node migrations/fix_fukuyogu_residuals_202609.mjs --cleanup-batch <batch_id> [--execute]
 *     (--revert / --cleanup-batch は sync_fukuyogu_from_honobono.mjs の汎用処理に渡す。data_import_rows の before/after で戻す)
 *
 * ── やること ───────────────────────────────────────────────────────────────
 *   A 担当居宅: 共有の利用者 11 名の clients.care_office_id を KK261004 の 7131/7132 基本 (01) 項20 に合わせる
 *     (9 月分のつなぎ。kaigo の請求は認定行を使うので影響しない)。番号 → care_offices.id は tenant kt-group で 1 件に決まるものだけ
 *   B 縁側よいしょ (care_offices df775cf7) の office_number 1273400398 → 1293400048
 *     ★ kaigo-app 伝送データ (福祉用具以外) に 1273400398 が出てくれば止める (= 書かない)
 *   C ほのぼのにだけある当月の貸与 (6 名) を order_items に追加。開始日 = 月初 + (月の日数 - KDS 日数) (同期と同じ規則)
 *   D 萱野 富美 歩行器 00110-000103 (数量 2・4/1〜) を「1 台 4/1〜」+「1 台 9/17〜」に分ける
 *   E rental_price が null の明細を 当月の単価 (価格履歴 → 用具マスタ) で埋める
 *
 * ── 止める条件 (その件は書かない) ─────────────────────────────────────────
 *   利用者が (tenant, 被保番) で 1 名に決まらない / 氏名が想定と違う / KK・KDS の値が想定と違う /
 *   追加する用具が既に DB にある / 用具マスタに無い / 当月の単価 ×1/10 が KDS の単位と違う
 *
 * ── 書込みの作法 ───────────────────────────────────────────────────────────
 *   update は読んだときの値を条件に付け (eq / is null)、更新件数 1 を確認。insert は表ごとに同じキー集合。
 *   data_import_batches → 各書込みの直後に data_import_rows (before/after)。変更前の行は migrations/_backup_fyd2_*.json にも保存。
 *   order_items の追加・数量変更で trigger が作る doc_tasks / care_plan_elements は、参照先がこの batch で触った行のものだけ消す
 *   (同期 script と同じ掃除。op=delete で記録)。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (opt("--revert") || opt("--cleanup-batch")) {
  const r = spawnSync(process.execPath, [join(HERE, "sync_fukuyogu_from_honobono.mjs"), ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...argv], { stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" } });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
const { C, TENANT, PROVIDER_BN, readKds0031, readEnv, parseCsvLine, nfkc, nName, nInsured, toInt, ymOf, daysIn } = core;
const { getPriceForMonth } = await import("../lib/equipment");

const EXECUTE = argv.includes("--execute");
const MONTH = "2026-09";
const MARK = "[honobono-sync-202609]";
const MDAYS = daysIn(MONTH);
const MONTH_START = `${MONTH}-01`;
const REPO_ROOT = resolve(HERE, "../../..");
const DENSOU_ROOT = join(HERE, "../../kaigo-app/伝送データ");
const DIR = join(DENSOU_ROOT, "ケアサポ/福祉用具/202609/ほのぼのから");
const KK_PATH = join(DIR, "KK261004.CSV");
const KDS_PATH = join(DIR, "KDS0031_明細書明細付_処理R8-09.CSV");
const SCRIPT_REL = "apps/order-app/migrations/fix_fukuyogu_residuals_202609.mjs";
const STEP = "fyd2-residuals";

// ── 定義 (user 承認 2026-11-09) ─────────────────────────────────────────────
const CARE_OFFICE_FIX = [
  ["清田 安江", "1000057101", "1272400837"], ["櫻田 數枝", "1000064916", "1272400837"], ["桐ケ谷 幸子", "1000100109", "1272401876"],
  ["髙橋 和子", "1000065231", "1272400506"], ["菊池 龍也", "1000151805", "1272400506"], ["加藤 慶子", "1000057373", "1202400014"],
  ["伊藤 やゑ", "2290147624", "1203400013"], ["髙畠 孝祐", "1000041985", "1272400506"], ["鈴木 ひろみ", "1000101163", "1272400506"],
  ["加藤 清美", "0000064383", "1271101287"], ["福田 麗子", "2290076039", "1273401073"],
].map(([name, insured, no]) => ({ name, insured, no }));
const YOISHO = { id: "df775cf7-b23a-4a59-b5eb-53743da3df08", from: "1273400398", to: "1293400048", client: { name: "岸 きみ", insured: "2290095260" } };
// tais / KDS の単位 (月額) / 台数 / KDS の日数
const RENTALS = [
  { name: "岸 敏子", insured: "0000006103", items: [["00254-000190", 450, 1, 22], ["00254-000095", 470, 1, 22]] },
  { name: "小島 京子", insured: "1000151480", items: [["00200-000496", 530, 1, 7], ["00254-000369", 120, 1, 18]] },
  { name: "三澤 八重子", insured: "1000152461", items: [["00066-000333", 700, 1, 16]] },
  { name: "大平 睦子", insured: "1000153460", items: [["00254-000412", 350, 1, 27]] },
  { name: "鈴木 忠", insured: "1000062732", items: [["00160-000288", 400, 1, 22], ["00020-000055", 3000, 1, 22], ["00066-000218", 100, 2, 22]] },
  { name: "大沢 淑子", insured: "0000036996", items: [["01265-000307", 640, 1, 23]] },
].map((p) => ({ ...p, items: p.items.map(([tais, units, qty, days]) => ({ tais, units, qty, days })) }));
const KAYANO = { name: "萱野 富美", insured: "1000047823", tais: "00110-000103", days: [30, 14] };

// ── 小道具 ────────────────────────────────────────────────────────────────
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const countBy = (a, f) => { const m = {}; for (const x of a) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const relPath = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const log = (...a) => console.log(a.join(" "));

const env = readEnv();
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
async function selectAll(table, select, build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function selectIn(table, select, col, ids, extra = (q) => q) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll(table, select, (q) => extra(q.in(col, c))));
  return out;
}

// ── 入力ファイル ──────────────────────────────────────────────────────────
const kkRecs = readFileSync(KK_PATH, "latin1").split(/\r\n|\n/).filter(Boolean).map(parseCsvLine);
const kkBase = new Map(); // 被保番 → 項20 (基本 01 レコード)
for (const r of kkRecs) if (r[0] === "2" && ["7131", "7132"].includes(r[2]) && r[3] === "01" && r[4] === MONTH.replace("-", "")) {
  const k = nInsured(r[7]); if (!kkBase.has(k)) kkBase.set(k, new Set()); kkBase.get(k).add(nfkc(r[21]));
}
const { rows: kdsAll } = readKds0031(KDS_PATH);
const kds = kdsAll.filter((r) => ymOf(r[C.SVC_MONTH]) === MONTH);
const kdsLines = (insured, tais) => kds.filter((r) => nInsured(r[C.INSURED]) === insured && nfkc(r[C.TAIS]) === tais).map((r) => ({ days: toInt(r[C.DAYS]), units: toInt(r[C.SVC_UNITS]) }));
const sourceFiles = [
  { path: relPath(KK_PATH), sha256: sha256(KK_PATH), rows: kkRecs.length, kind: "国保連伝送 KK261004 (提供 2026-09・ほのぼの)" },
  { path: relPath(KDS_PATH), sha256: sha256(KDS_PATH), rows: kdsAll.length, kind: "KDS0031 明細書明細付 (提供 2026-09)" },
];

// ── DB (対象分だけ。--execute でも毎回読み直す) ─────────────────────────────
const office = (await selectAll("offices", "id,name,business_number", (q) => q.eq("tenant_id", TENANT))).find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
if (!office) throw new Error(`offices に ${PROVIDER_BN} が無い`);
const OFFICE = office.id;
const careOffices = await selectAll("care_offices", "id,office_number,name", (q) => q.eq("tenant_id", TENANT));
const coById = new Map(careOffices.map((c) => [c.id, c]));
async function clientOf(name, insured) {
  const cs = (await selectAll("clients", "id,name,user_number,office_id,care_office_id,insured_number,deleted_at", (q) => q.eq("tenant_id", TENANT).eq("insured_number", insured))).filter((c) => !c.deleted_at);
  if (cs.length !== 1) return { why: `clients (被保番 ${insured}) が ${cs.length} 名` };
  if (nName(cs[0].name) !== nName(name)) return { why: `氏名が想定と違う (DB ${cs[0].name})` };
  return { c: cs[0] };
}

const ops = []; // { part, table, action, id, before, patch, row, cond, why, key, ref }
const stopped = [];
const notes = [];

// A 担当居宅
for (const f of CARE_OFFICE_FIX) {
  const { c, why } = await clientOf(f.name, f.insured);
  if (!c) { stopped.push(`A ${f.name}: ${why}`); continue; }
  const kk = kkBase.get(f.insured);
  if (!kk || kk.size !== 1 || !kk.has(f.no)) { stopped.push(`A ${f.name}: KK の項20 が ${kk ? [...kk].join("/") : "無い"} (想定 ${f.no})`); continue; }
  const cos = careOffices.filter((x) => nfkc(x.office_number) === f.no);
  if (cos.length !== 1) { stopped.push(`A ${f.name}: care_offices に ${f.no} が ${cos.length} 件`); continue; }
  if (c.care_office_id === cos[0].id) { notes.push(`A ${f.name}: 既に ${f.no}`); continue; }
  const cur = coById.get(c.care_office_id);
  ops.push({ part: "A", table: "clients", action: "update", id: c.id, cond: { care_office_id: c.care_office_id }, before: { care_office_id: c.care_office_id }, patch: { care_office_id: cos[0].id },
    why: "担当居宅を KK261004 の項20 に (共有の利用者・9 月分のつなぎ)", key: `KK261004|${f.insured}|項20:${f.no}`,
    ref: { 氏名: f.name, 被保番: f.insured, 旧: `${cur?.office_number ?? "-"} ${cur?.name ?? c.care_office_id ?? "なし"}`, 新: `${f.no} ${cos[0].name}` } });
}

// B 縁側よいしょ
{
  const hits = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) { if (n !== "福祉用具") walk(p); } else if (/\.csv$/i.test(n) && readFileSync(p, "latin1").includes(YOISHO.from)) hits.push(relPath(p)); } };
  walk(DENSOU_ROOT);
  const refs = {};
  for (const [t, col] of [["clients", "care_office_id"], ["client_insurance_records", "care_office_id"], ["care_managers", "care_office_id"], ["renovation_projects", "care_office_id"]]) {
    const { count, error } = await sb.from(t).select("id", { count: "exact", head: true }).eq(col, YOISHO.id);
    if (error) throw new Error(`${t}: ${error.message}`);
    refs[`${t}.${col}`] = count;
  }
  const { data: fd, error: fe } = await sb.from("facility_designations").select("id,service_category,service_category_name").eq("business_number", YOISHO.from);
  if (fe) throw new Error(`facility_designations: ${fe.message}`);
  notes.push(`B 参照: ${JSON.stringify(refs)} / facility_designations(${YOISHO.from}) ${JSON.stringify(fd)}`);
  const { c } = await clientOf(YOISHO.client.name, YOISHO.client.insured);
  notes.push(`B ${YOISHO.client.name}: clients.care_office_id = ${c?.care_office_id ?? "?"}${c?.care_office_id === YOISHO.id ? " (既にこの事業所)" : ""} / KK 項20 = ${[...(kkBase.get(YOISHO.client.insured) ?? [])].join("/")}`);
  if (hits.length) stopped.push(`B 縁側よいしょ: kaigo-app 伝送データ (福祉用具以外) に ${YOISHO.from} が出る → 書かない: ${hits.join(", ")}`);
  else {
    const co = coById.get(YOISHO.id);
    if (co?.office_number !== YOISHO.from) stopped.push(`B 縁側よいしょ: 現在の office_number が ${co?.office_number}`);
    else ops.push({ part: "B", table: "care_offices", action: "update", id: YOISHO.id, cond: { office_number: YOISHO.from }, before: { office_number: YOISHO.from }, patch: { office_number: YOISHO.to }, why: "ほのぼの・国保連に送っている番号", key: `KK261004|${YOISHO.client.insured}|項20:${YOISHO.to}`, ref: { name: co.name } });
  }
}

// C / D / E 共通: 用具マスタと価格
const eqRows = await selectAll("equipment_master", "id,product_code,rental_price", (q) => q.eq("tenant_id", TENANT));
const eqByCode = new Map(eqRows.map((e) => [e.product_code, e]));
const hist = await selectAll("equipment_price_history", "id,product_code,rental_price,valid_from", (q) => q.eq("tenant_id", TENANT));
const priceOf = (code) => getPriceForMonth(hist, code, MONTH) ?? eqByCode.get(code)?.rental_price ?? null;
async function itemsOfClient(cid) {
  const orders = await selectAll("orders", "id,office_id,status,payment_type", (q) => q.eq("client_id", cid));
  const items = orders.length ? await selectIn("order_items", "id,order_id,product_code,quantity,status,rental_start_date,rental_end_date,rental_price,cancelled_at,payment_type", "order_id", orders.map((o) => o.id)) : [];
  return { orders, items };
}

// C ほのぼのにだけある貸与
for (const p of RENTALS) {
  const { c, why } = await clientOf(p.name, p.insured);
  if (!c) { stopped.push(`C ${p.name}: ${why}`); continue; }
  const { orders, items } = await itemsOfClient(c.id);
  const ord = orders.filter((o) => o.office_id === OFFICE && o.status !== "cancelled" && (o.payment_type ?? "介護") === "介護");
  if (ord.length !== 1) { stopped.push(`C ${p.name}: ケアサポの介護の注文が ${ord.length} 件`); continue; }
  for (const it of p.items) {
    const label = `C ${p.name} ${it.tais}`;
    const ls = kdsLines(p.insured, it.tais);
    if (ls.length !== it.qty || ls.some((l) => l.days !== it.days || l.units !== it.units)) { stopped.push(`${label}: KDS が想定と違う ${JSON.stringify(ls)}`); continue; }
    const dup = items.filter((x) => x.product_code === it.tais && !x.cancelled_at && x.status !== "cancelled");
    if (dup.length) { stopped.push(`${label}: DB に既にある ${JSON.stringify(dup)}`); continue; }
    if (!eqByCode.has(it.tais)) { stopped.push(`${label}: 用具マスタに無い`); continue; }
    const price = priceOf(it.tais);
    if (price !== it.units * 10) { stopped.push(`${label}: 当月単価 ${price} ≠ KDS ${it.units}×10`); continue; }
    const start = addDays(MONTH_START, MDAYS - it.days);
    ops.push({ part: "C", table: "order_items", action: "insert", cid: c.id, why: "ほのぼのにだけある当月の貸与", key: `KDS0031|122xxx|${p.insured}|TAIS:${it.tais}`, ref: { 氏名: p.name, 明細: ls },
      row: { tenant_id: TENANT, order_id: ord[0].id, product_code: it.tais, quantity: it.qty, status: "rental_started", payment_type: "介護", rental_start_date: start, rental_end_date: null, cancelled_at: null, rental_price: price, notes: MARK } });
  }
}

// D 萱野 富美 歩行器を 2 明細に
{
  const { c, why } = await clientOf(KAYANO.name, KAYANO.insured);
  if (!c) stopped.push(`D ${KAYANO.name}: ${why}`);
  else {
    const { items } = await itemsOfClient(c.id);
    const its = items.filter((x) => x.product_code === KAYANO.tais && !x.cancelled_at);
    const ls = kdsLines(KAYANO.insured, KAYANO.tais);
    const days = ls.map((l) => l.days).sort((a, b) => b - a);
    if (JSON.stringify(days) !== JSON.stringify(KAYANO.days)) stopped.push(`D ${KAYANO.name}: KDS の日数が ${JSON.stringify(days)}`);
    else if (its.length !== 1 || its[0].quantity !== 2 || its[0].rental_start_date !== "2026-04-01" || its[0].rental_end_date || its[0].status !== "rental_started") stopped.push(`D ${KAYANO.name}: DB の明細が想定と違う ${JSON.stringify(its)}`);
    else {
      const it = its[0];
      const start2 = addDays(MONTH_START, MDAYS - KAYANO.days[1]);
      ops.push({ part: "D", table: "order_items", action: "update", id: it.id, cid: c.id, cond: { quantity: 2 }, before: { quantity: 2 }, patch: { quantity: 1 }, why: "2 台のうち 1 台は 9/17〜 (KDS 日数 30 + 14)", key: `KDS0031|${KAYANO.insured}|TAIS:${KAYANO.tais}`, ref: { 明細: ls } });
      ops.push({ part: "D", table: "order_items", action: "insert", cid: c.id, why: "2 台目 (車いすと同日 9/17〜)", key: `KDS0031|${KAYANO.insured}|TAIS:${KAYANO.tais}|2台目`, ref: { 明細: ls, 元明細: it.id },
        row: { tenant_id: TENANT, order_id: it.order_id, product_code: KAYANO.tais, quantity: 1, status: "rental_started", payment_type: it.payment_type ?? "介護", rental_start_date: start2, rental_end_date: null, cancelled_at: null, rental_price: it.rental_price, notes: MARK } });
    }
  }
}

// E rental_price null
{
  const nulls = await selectAll("order_items", "id,order_id,product_code,quantity,status,rental_start_date,cancelled_at", (q) => q.eq("tenant_id", TENANT).is("rental_price", null));
  notes.push(`E rental_price が null の明細 ${nulls.length} 行`);
  const ords = nulls.length ? await selectIn("orders", "id,client_id,office_id", "id", nulls.map((x) => x.order_id)) : [];
  const cl = ords.length ? await selectIn("clients", "id,name,insured_number", "id", ords.map((o) => o.client_id).filter(Boolean)) : [];
  for (const it of nulls) {
    const o = ords.find((x) => x.id === it.order_id), c = cl.find((x) => x.id === o?.client_id);
    const label = `E ${c?.name ?? "?"} ${it.product_code}`;
    const price = priceOf(it.product_code);
    const ls = c ? kdsLines(nInsured(c.insured_number), it.product_code) : [];
    if (price == null) { stopped.push(`${label}: 単価が引けない`); continue; }
    if (ls.length && ls.some((l) => l.units * 10 !== price)) { stopped.push(`${label}: 単価 ${price} が KDS ${JSON.stringify(ls)} と合わない`); continue; }
    ops.push({ part: "E", table: "order_items", action: "update", id: it.id, cid: c?.id, cond: { rental_price: null }, before: { rental_price: null }, patch: { rental_price: price }, why: "rental_price null を当月の単価で埋める", key: `equipment:${it.product_code}|${MONTH}`, ref: { 氏名: c?.name, KDS: ls, 単価の出どころ: getPriceForMonth(hist, it.product_code, MONTH) != null ? "価格履歴" : "用具マスタ" } });
  }
}

// ── 出力 ──────────────────────────────────────────────────────────────────
log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} / 提供 ${MONTH} / 事業所 ${office.name}`);
for (const o of ops) log(`  [${o.part}] ${o.table} ${o.action} ${o.action === "insert" ? JSON.stringify(o.row) : `${o.id} ${JSON.stringify(o.before)} → ${JSON.stringify(o.patch)}`} ${JSON.stringify(o.ref)}`);
for (const s of notes) log(`  参考: ${s}`);
for (const s of stopped) log(`  ★ 止めた: ${s}`);
log(`合計 ${ops.length} 件 ${JSON.stringify(countBy(ops, (o) => `${o.part} ${o.table} ${o.action}`))} / 止めた ${stopped.length}`);
const ks = new Set(ops.filter((o) => o.action === "insert").map((o) => `${o.table}:${Object.keys(o.row).sort().join(",")}`));
log(`insert のキー集合 ${ks.size} 種`);
if (!EXECUTE) { log("DRY RUN — DB は書き換えていない"); process.exit(0); }
for (const t of ["data_import_batches", "data_import_rows"]) { const { error } = await sb.from(t).select("id").limit(1); if (error) { console.error(`★ ${t}: ${error.message}`); process.exit(2); } }

// ── 本番 ──────────────────────────────────────────────────────────────────
const DERIVED = [["doc_tasks", "trigger_ref_id"], ["care_plan_elements", "ref_id"]];
const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
  tenant_id: TENANT, source_system: "honobono-fukuyogu", source_files: sourceFiles, script: SCRIPT_REL, args: argv.join(" "), step: STEP, status: "running",
  notes: `提供 ${MONTH} / FY-D2 残差の個別是正 (担当居宅・貸与追加・萱野 分割・単価 null) user 承認 2026-11-09`,
}).select("id").single();
if (bErr) throw new Error(`data_import_batches: ${bErr.message}`);
const BATCH = batch.id;
log(`batch ${BATCH}`);
const fail = async (msg) => { const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `提供 ${MONTH} / FY-D2 失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH); if (error) console.error(error.message); throw new Error(msg); };
const record = async (recs) => { for (const c of chunks(recs, 100)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); } };
const srcRef = (o) => ({ file: o.part === "A" || o.part === "B" ? relPath(KK_PATH) : relPath(KDS_PATH), part: o.part, why: o.why, ...o.ref });
const beforeRows = {};
for (const o of ops.filter((x) => x.action === "update")) {
  const { data, error } = await sb.from(o.table).select("*").eq("id", o.id).single();
  if (error) await fail(`${o.table} ${o.id}: ${error.message}`);
  beforeRows[`${o.table}:${o.id}`] = data;
}
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const bpath = join(HERE, `_backup_fyd2_residuals_202609_${ts}.json`);
writeFileSync(bpath, JSON.stringify({ batch: BATCH, before: beforeRows }, null, 2));
log(`バックアップ ${bpath}`);
const cids = [...new Set(ops.filter((o) => o.table === "order_items").map((o) => o.cid).filter(Boolean))];
const beforeDerived = {};
for (const [t] of DERIVED) beforeDerived[t] = new Set((await selectIn(t, "id", "client_id", cids, (q) => q.eq("tenant_id", TENANT))).map((r) => r.id));
const touched = new Set();
try {
  for (const o of ops.filter((x) => x.action === "update")) {
    let q = sb.from(o.table).update(o.patch, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
    for (const [k, v] of Object.entries(o.cond)) q = v == null ? q.is(k, null) : q.eq(k, v);
    const { error, count } = await q;
    if (error) await fail(`update ${o.table} ${o.id}: ${error.message}`);
    if (count !== 1) await fail(`update ${o.table} ${o.id}: 更新件数 ${count} (読んだ後に変わった?)`);
    await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "update", source_key: o.key, source_ref: srcRef(o), before: beforeRows[`${o.table}:${o.id}`], after: o.patch }]);
    touched.add(o.id);
    const oid = beforeRows[`${o.table}:${o.id}`]?.order_id; if (oid) touched.add(oid);
  }
  for (const o of ops.filter((x) => x.action === "insert")) {
    const { data, error } = await sb.from(o.table).insert(o.row).select("id").single();
    if (error) await fail(`insert ${o.table}: ${error.message}`);
    await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: data.id, op: "insert", source_key: o.key, source_ref: srcRef(o), before: null, after: o.row }]);
    touched.add(data.id); touched.add(o.row.order_id);
  }
} finally {
  // trigger が作った行の掃除 (参照先がこの batch で触った行のものだけ)
  for (const [t, refCol] of DERIVED) {
    const rows = await selectIn(t, "*", "client_id", cids, (q) => q.eq("tenant_id", TENANT));
    const fresh = rows.filter((r) => !beforeDerived[t].has(r.id));
    const mine = fresh.filter((r) => touched.has(r[refCol]));
    for (const c of chunks(mine.map((r) => r.id), 150)) {
      const { error, count } = await sb.from(t).delete({ count: "exact" }).in("id", c);
      if (error || count !== c.length) await fail(`掃除 ${t}: ${error?.message ?? `削除 ${count} ≠ ${c.length}`}`);
    }
    await record(mine.map((r) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger", source_ref: { cleanup: true, 理由: "FY-D2 の書込みで trigger が作った行" }, before: r, after: null })));
    log(`  掃除 ${t}: 消した ${mine.length} / 参照先が違うので残した新しい行 ${fresh.length - mine.length}`);
  }
}
const { count } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
log(`完了 batch ${BATCH} / data_import_rows ${count} 行。取り消しは --revert ${BATCH}`);
