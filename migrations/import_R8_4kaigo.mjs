/**
 * R8_4kaigo.CSV (国保請求 SJIS 143列) を order-app の現行 DB に反映するスクリプト。
 *
 * 流れ:
 *   1. WIPE 対象 table を全削除 (tenant_id = 'kt-group') ※ clients は除く
 *   2. CSV を SJIS デコード + パース
 *   3. clients を UPSERT (user_number 一致で UPDATE / なければ INSERT)
 *      ※ 既存 id を温存 → calendar-app の events.assignees 参照が壊れない
 *   4. care_offices を office_number で UPSERT
 *   5. equipment を tais_code で UPSERT
 *   6. client_insurance_records を (client_id, certification_start_date) で INSERT
 *   7. orders を client_id ごとに 1 件作成、order_items を (client_id × TAIS) で 1 件
 *   8. billing_unit_overrides を (client_id × month × order_item) で INSERT (CSV の 単位数 column 131 を反映)
 *
 * Usage:
 *   node migrations/import_R8_4kaigo.mjs              # DRY RUN (件数表示のみ)
 *   node migrations/import_R8_4kaigo.mjs --execute    # 本番実行 (wipe + import)
 *   node migrations/import_R8_4kaigo.mjs --execute --skip-wipe  # import のみ
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 設定 ─────────────────────────────────────────────────────────────────────

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
// order-app の .env.local に service_role_key が無いため、calendar-app の env もフォールバック参照
const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envCal = loadEnvFile(join(__dirname, "..", "..", "calendar-app", ".env.local"));
const SUPABASE_URL =
  envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が読めません (.env.local 確認)");
  process.exit(1);
}

const CSV_PATH = join(__dirname, "..", "R8_4kaigo.CSV");
const TENANT_ID = "kt-group";
const PROVIDER_OFFICE_NUMBER = "1272400050"; // CSV の 事業所番号 column 2 (全行同じ前提)

const EXECUTE = process.argv.includes("--execute");
const SKIP_WIPE = process.argv.includes("--skip-wipe");

// ── CSV ヘッダー定義 (0-indexed) ────────────────────────────────────────────

const C = {
  PROVIDER_NUMBER: 2,
  PROVIDER_NAME: 3,
  SERVICE_MONTH: 4,           // 提供年月 "2025/11"
  BILLING_MONTH: 5,           // 請求年月 "2026/04"
  USER_NUMBER: 7,
  USER_NAME: 8,
  INSURED_NUMBER: 9,
  STATE: 10,                  // 国保対象 / 取下対象 等
  REBILL_KIND: 13,            // 過誤再請求 / 返戻再請求 等
  LATE_FLAG: 14,              // 月遅
  INSURER_NUMBER: 30,
  FURIGANA: 31,
  BIRTH_DATE: 32,             // "1947/11/15"
  GENDER: 33,                 // 男 / 女
  CARE_LEVEL: 34,             // 要介護度２
  CERT_START: 35,             // "2025/09/01"
  CERT_END: 36,               // "2029/08/31"
  ZIP: 37,
  ADDRESS: 38,
  PHONE: 39,
  CREATION_CATEGORY: 40,      // 居宅介護支援事業者作成 / 自己作成
  CARE_OFFICE_NUMBER: 41,
  CARE_OFFICE_NAME: 42,
  SERVICE_TYPE_CODE: 57,      // 17 = 福祉用具貸与
  SERVICE_TYPE_NAME: 58,
  UNIT_PRICE: 63,             // 単位数単価 (保険分)
  BENEFIT_RATE: 64,           // 70 / 80 / 90
  SERVICE_LIMIT_MANAGED: 61,  // 限度額管理対象単位数
  SERVICE_CONTENT: 131,       // サービス内容
  ITEM_UNIT_PRICE: 132,       // 行の単位数単価
  ITEM_COUNT: 133,            // 回数 (日数)
  ITEM_UNITS: 134,            // 単位数
  SERVICE_CODE: 135,          // サービスコード
  TAIS_CODE: 136,             // 摘要 (TAIS code)
  PRODUCT_NAME: 150,          // 商品名
};

// ── CSV parser (SJIS + quoted) ───────────────────────────────────────────────

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = false; }
      } else { cur += ch; }
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function readCsv() {
  const buf = readFileSync(CSV_PATH);
  const dec = new TextDecoder("shift-jis");
  const text = dec.decode(buf);
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { header, rows };
}

function toIsoDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return null;
}
function toIsoMonth(s) {
  if (!s) return null;
  const m = s.match(/^(\d{4})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}`;
  return null;
}
function normalizeCareLevel(s) {
  if (!s) return null;
  // 要介護度２ → 要介護2
  const z2h = { "０":"0","１":"1","２":"2","３":"3","４":"4","５":"5","６":"6","７":"7","８":"8","９":"9" };
  return s.replace(/[０-９]/g, (c) => z2h[c]).replace("要介護度", "要介護").replace("要支援度", "要支援");
}
function pickFirst(s) {
  return s && s.length > 0 ? s : null;
}
function toIntOrNull(s) {
  if (!s || s === "") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

// ── ページング取得 ──────────────────────────────────────────────────────────

async function fetchAll(sb, table, select, eqCol, eqVal) {
  const all = [];
  let from = 0;
  while (true) {
    let q = sb.from(table).select(select).range(from, from + 999);
    if (eqCol && eqVal !== undefined) q = q.eq(eqCol, eqVal);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

// ── メイン ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📂 CSV: ${CSV_PATH}`);
  console.log(`🏢 tenant_id = ${TENANT_ID}`);
  console.log(`🏪 provider office number = ${PROVIDER_OFFICE_NUMBER}`);
  console.log(EXECUTE ? "⚠️  EXECUTE MODE (実書き込み)" : "🔍 DRY RUN (件数のみ)");
  if (EXECUTE && SKIP_WIPE) console.log("🚫 SKIP WIPE (削除フェーズ省略)");
  console.log("");

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── CSV パース ─────────────────────────────────────────────
  console.log("📊 CSV 解析中...");
  const { header, rows } = readCsv();
  console.log(`   header 列数: ${header.length}`);
  console.log(`   data 行数: ${rows.length}`);

  // ── office_id 解決 (offices.business_number = '1272400050') ─
  const officeRows = await fetchAll(sb, "offices", "id, name, business_number", "tenant_id", TENANT_ID);
  const providerOffice = officeRows.find(
    (o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_OFFICE_NUMBER
  );
  if (!providerOffice) {
    console.error(`❌ offices に business_number=${PROVIDER_OFFICE_NUMBER} が見つかりません`);
    console.error(`   候補: ${officeRows.map((o) => `${o.name}(${o.business_number ?? "-"})`).join(", ")}`);
    process.exit(1);
  }
  console.log(`   provider office: ${providerOffice.name} (${providerOffice.id})`);

  // ── 集約 ─────────────────────────────────────────────────
  // CSV を (利用者 × 提供月 × TAIS) で 1 行ある形式。
  const clientMap = new Map();      // user_number → 利用者属性 (最新行から)
  const careOfficeMap = new Map();  // care_office_number → { name }
  const equipmentMap = new Map();   // tais_code → { name, content, unitPriceLatest }
  const insuranceMap = new Map();   // user_number + cert_start → 認定属性
  // orderItem key: user_number + tais_code → { earliestServiceMonth, unitPriceLatest }
  const orderItemKey = (un, tais) => `${un}|${tais}`;
  const orderItemMap = new Map();
  // unit override: user_number + service_month + tais → units (dedup by key、最新を採用)
  const unitOverrideMap = new Map(); // key: un|month|tais → units

  for (const r of rows) {
    const un = (r[C.USER_NUMBER] ?? "").trim();
    if (!un) continue;
    const tais = (r[C.TAIS_CODE] ?? "").trim();
    const svcMonth = toIsoMonth(r[C.SERVICE_MONTH]);
    if (!svcMonth) continue;

    // client
    if (!clientMap.has(un)) {
      clientMap.set(un, {
        user_number: un,
        name: (r[C.USER_NAME] ?? "").trim(),
        furigana: pickFirst((r[C.FURIGANA] ?? "").trim()),
        birth_date: toIsoDate(r[C.BIRTH_DATE]),
        gender: pickFirst((r[C.GENDER] ?? "").trim()),
        care_level: normalizeCareLevel(r[C.CARE_LEVEL]),
        address: pickFirst((r[C.ADDRESS] ?? "").trim()),
        phone: pickFirst((r[C.PHONE] ?? "").trim()),
        insured_number: pickFirst((r[C.INSURED_NUMBER] ?? "").trim()),
        insurer_number: pickFirst((r[C.INSURER_NUMBER] ?? "").trim()),
        benefit_rate: pickFirst((r[C.BENEFIT_RATE] ?? "").trim()),
        certification_start_date: toIsoDate(r[C.CERT_START]),
        certification_end_date: toIsoDate(r[C.CERT_END]),
        care_office_number: pickFirst((r[C.CARE_OFFICE_NUMBER] ?? "").trim()),
      });
    }

    // care_office
    const careOfficeNo = (r[C.CARE_OFFICE_NUMBER] ?? "").trim();
    const careOfficeName = (r[C.CARE_OFFICE_NAME] ?? "").trim();
    if (careOfficeNo && careOfficeName && !careOfficeMap.has(careOfficeNo)) {
      careOfficeMap.set(careOfficeNo, { name: careOfficeName });
    }

    // insurance record (per cert period)
    const certStart = toIsoDate(r[C.CERT_START]);
    const certEnd = toIsoDate(r[C.CERT_END]);
    if (certStart) {
      const key = `${un}|${certStart}`;
      if (!insuranceMap.has(key)) {
        insuranceMap.set(key, {
          user_number: un,
          certification_start_date: certStart,
          certification_end_date: certEnd,
          insured_number: pickFirst((r[C.INSURED_NUMBER] ?? "").trim()),
          insurer_number: pickFirst((r[C.INSURER_NUMBER] ?? "").trim()),
          care_level: normalizeCareLevel(r[C.CARE_LEVEL]),
          benefit_rate: pickFirst((r[C.BENEFIT_RATE] ?? "").trim()),
          care_office_number: careOfficeNo || null,
        });
      }
    }

    // equipment
    if (tais) {
      const unitPrice = toIntOrNull(r[C.ITEM_UNIT_PRICE]);
      const content = (r[C.SERVICE_CONTENT] ?? "").trim();
      const prodName = (r[C.PRODUCT_NAME] ?? "").trim();
      if (!equipmentMap.has(tais)) {
        equipmentMap.set(tais, {
          tais_code: tais,
          product_code: tais,
          name: prodName || content || tais,
          category: content || null,
          rental_price: unitPrice ? unitPrice * 10 : null,
        });
      }

      // order item
      const oik = orderItemKey(un, tais);
      if (!orderItemMap.has(oik)) {
        orderItemMap.set(oik, {
          user_number: un,
          tais_code: tais,
          earliest_service_month: svcMonth,
          product_name: prodName,
          rental_price: unitPrice ? unitPrice * 10 : null,
        });
      } else {
        const ex = orderItemMap.get(oik);
        if (svcMonth < ex.earliest_service_month) ex.earliest_service_month = svcMonth;
      }

      // unit override (per service month, per item) — 同 key の重複行 (過誤再請求等) は後勝ち
      const units = toIntOrNull(r[C.ITEM_UNITS]);
      if (units != null) {
        unitOverrideMap.set(`${un}|${svcMonth}|${tais}`, { user_number: un, service_month: svcMonth, tais_code: tais, units });
      }
    }
  }

  console.log(`   利用者: ${clientMap.size} 名`);
  console.log(`   居宅事業所: ${careOfficeMap.size} 件`);
  console.log(`   用具マスタ: ${equipmentMap.size} 件 (TAIS あり)`);
  console.log(`   保険記録: ${insuranceMap.size} 件`);
  console.log(`   注文明細 (利用者×TAIS): ${orderItemMap.size} 件`);
  console.log(`   月次単位上書き: ${unitOverrideMap.size} 件 (dedup 後)`);
  console.log(`   提供月レンジ: ${[...new Set(rows.map((r) => toIsoMonth(r[C.SERVICE_MONTH])).filter(Boolean))].sort().join(", ")}`);

  if (!EXECUTE) {
    console.log("\n✅ DRY RUN 完了。--execute を付けて再実行で本番反映。");
    console.log("\nサンプル client (最初の 3):");
    [...clientMap.values()].slice(0, 3).forEach((c) => console.log(JSON.stringify(c, null, 2)));
    return;
  }

  // ── WIPE ────────────────────────────────────────────────────
  if (!SKIP_WIPE) {
    console.log("\n🗑  WIPE 対象 table を削除中 (tenant_id=kt-group)...");
    const wipeTables = [
      "billing_user_payments",            // FK 子から
      "billing_user_invoice_items",
      "billing_user_invoices",
      "billing_unit_overrides",
      "billing_late_flags",
      "billing_rebill_flags",
      "order_items",
      "orders",
      "client_hospitalizations",
      "client_insurance_records",
      "doc_tasks",
      "client_documents",
      "client_office_assignments",
      "equipment_price_history",
      "equipment_master",
      // care_offices / care_managers は clients FK 由来で wipe 出来ないため、
      // care_offices は UPSERT、care_managers は既存維持で対応。
    ];
    for (const t of wipeTables) {
      const { error } = await sb.from(t).delete().eq("tenant_id", TENANT_ID);
      if (error && !error.message.includes("does not exist")) {
        // 一部 table は tenant_id を持たない可能性 (FK で消えるので fall-through OK)
        console.warn(`   ⚠️  ${t}: ${error.message}`);
      } else {
        console.log(`   ${t} cleared`);
      }
    }
  }

  // ── 1. clients UPSERT ─────────────────────────────────────
  console.log("\n👤 clients UPSERT...");
  const existingClients = await fetchAll(sb, "clients", "id, user_number", "tenant_id", TENANT_ID);
  const clientIdMap = new Map(); // user_number → id
  existingClients.forEach((c) => { if (c.user_number) clientIdMap.set(c.user_number, c.id); });

  let updated = 0, inserted = 0;
  for (const c of clientMap.values()) {
    const existingId = clientIdMap.get(c.user_number);
    const payload = {
      tenant_id: TENANT_ID,
      office_id: providerOffice.id,
      user_number: c.user_number,
      name: c.name,
      furigana: c.furigana,
      birth_date: c.birth_date,
      gender: c.gender,
      care_level: c.care_level,
      address: c.address,
      phone: c.phone,
      insured_number: c.insured_number,
      insurer_number: c.insurer_number,
      benefit_rate: c.benefit_rate,
      certification_start_date: c.certification_start_date,
      certification_end_date: c.certification_end_date,
      is_facility: false,
      is_provisional: false,
      deleted_at: null,
    };
    if (existingId) {
      const { error } = await sb.from("clients").update(payload).eq("id", existingId);
      if (error) console.warn(`   ⚠️  update ${c.user_number}: ${error.message}`);
      else updated++;
    } else {
      const { data, error } = await sb.from("clients").insert(payload).select("id").single();
      if (error) console.warn(`   ⚠️  insert ${c.user_number}: ${error.message}`);
      else { clientIdMap.set(c.user_number, data.id); inserted++; }
    }
  }
  console.log(`   updated=${updated} / inserted=${inserted}`);

  // ── 2. care_offices UPSERT (既存 office_number と照合、不足分のみ INSERT) ─
  console.log("\n🏥 care_offices UPSERT (既存と merge)...");
  const careOfficeIdMap = new Map(); // office_number → id
  const existingCareOffices = await fetchAll(sb, "care_offices", "id, name, office_number", "tenant_id", TENANT_ID);
  existingCareOffices.forEach((co) => {
    if (co.office_number) careOfficeIdMap.set(co.office_number, co.id);
  });
  // name 重複対策: 同名 existing があれば office_number を update して紐付け
  const existingByName = new Map(existingCareOffices.map((co) => [co.name, co]));
  let coInserted = 0, coMatched = 0;
  for (const [no, v] of careOfficeMap) {
    if (careOfficeIdMap.has(no)) { coMatched++; continue; }
    // 同 name の既存が居れば office_number を埋める
    const sameName = existingByName.get(v.name);
    if (sameName) {
      const { error } = await sb.from("care_offices").update({ office_number: no }).eq("id", sameName.id);
      if (!error) { careOfficeIdMap.set(no, sameName.id); coMatched++; }
      else console.warn(`   ⚠️  update office_number ${no}: ${error.message}`);
      continue;
    }
    const { data, error } = await sb.from("care_offices").insert({
      tenant_id: TENANT_ID,
      name: v.name,
      office_number: no,
    }).select("id").single();
    if (error) console.warn(`   ⚠️  insert ${no}: ${error.message}`);
    else { careOfficeIdMap.set(no, data.id); coInserted++; }
  }
  console.log(`   matched=${coMatched} / inserted=${coInserted}`);

  // ── 3. clients に care_office_id を埋める ─────────────────
  console.log("\n🔗 clients.care_office_id 更新...");
  let linkedCO = 0;
  for (const c of clientMap.values()) {
    if (!c.care_office_number) continue;
    const cid = clientIdMap.get(c.user_number);
    const coid = careOfficeIdMap.get(c.care_office_number);
    if (!cid || !coid) continue;
    const { error } = await sb.from("clients").update({ care_office_id: coid }).eq("id", cid);
    if (!error) linkedCO++;
  }
  console.log(`   linked=${linkedCO}`);

  // ── 4. client_insurance_records INSERT ────────────────────
  console.log("\n📋 client_insurance_records INSERT...");
  let insIns = 0;
  for (const ins of insuranceMap.values()) {
    const cid = clientIdMap.get(ins.user_number);
    if (!cid) continue;
    const coid = ins.care_office_number ? careOfficeIdMap.get(ins.care_office_number) ?? null : null;
    const { error } = await sb.from("client_insurance_records").insert({
      tenant_id: TENANT_ID,
      client_id: cid,
      effective_date: ins.certification_start_date,
      certification_start_date: ins.certification_start_date,
      certification_end_date: ins.certification_end_date,
      insured_number: ins.insured_number,
      insurer_number: ins.insurer_number,
      care_level: ins.care_level,
      benefit_rate: ins.benefit_rate,
      certification_status: "認定済み",
      care_office_id: coid,
    });
    if (error) console.warn(`   ⚠️  ${ins.user_number}: ${error.message}`);
    else insIns++;
  }
  console.log(`   inserted=${insIns}`);

  // ── 5. equipment INSERT (equipment_master) ────────────────
  console.log("\n📦 equipment_master INSERT...");
  const eqIdMap = new Map(); // tais_code → equipment.id (もし order_items が equipment_id を要求するなら)
  let eqIns = 0;
  for (const eq of equipmentMap.values()) {
    const { data, error } = await sb.from("equipment_master").insert({
      tenant_id: TENANT_ID,
      product_code: eq.product_code,
      tais_code: eq.tais_code,
      name: eq.name,
      category: eq.category,
      rental_price: eq.rental_price,
    }).select("id").single();
    if (error) console.warn(`   ⚠️  ${eq.tais_code}: ${error.message}`);
    else { eqIdMap.set(eq.tais_code, data.id); eqIns++; }
  }
  console.log(`   inserted=${eqIns}`);

  // ── 6. orders + order_items INSERT ─────────────────────────
  console.log("\n📑 orders + order_items INSERT...");
  // 1 client = 1 order (継続レンタル)
  const orderIdMap = new Map(); // user_number → order.id
  let ordIns = 0, itemIns = 0;
  for (const un of clientMap.keys()) {
    const cid = clientIdMap.get(un);
    if (!cid) continue;
    const items = [...orderItemMap.values()].filter((oi) => oi.user_number === un);
    if (items.length === 0) continue;
    const earliestStart = items.reduce((min, oi) => (oi.earliest_service_month < min ? oi.earliest_service_month : min), items[0].earliest_service_month);
    const startDate = `${earliestStart}-01`;
    const { data: ord, error: ordErr } = await sb.from("orders").insert({
      tenant_id: TENANT_ID,
      client_id: cid,
      office_id: providerOffice.id,
      payment_type: "介護",
      ordered_at: `${startDate}T00:00:00Z`,
      delivery_date: startDate,
      delivery_type: "直納",
      attendance_required: false,
      attendee_ids: [],
      email_sent_count: 0,
      merged_from_order_ids: [],
      status: "completed",
    }).select("id").single();
    if (ordErr) { console.warn(`   ⚠️  order ${un}: ${ordErr.message}`); continue; }
    orderIdMap.set(un, ord.id);
    ordIns++;
    for (const oi of items) {
      const { data: it, error: itErr } = await sb.from("order_items").insert({
        tenant_id: TENANT_ID,
        order_id: ord.id,
        product_code: oi.tais_code,
        quantity: 1,
        rental_price: oi.rental_price,
        payment_type: "介護",
        rental_start_date: `${oi.earliest_service_month}-01`,
        rental_end_date: null,
        status: "rental_started",
      }).select("id").single();
      if (itErr) console.warn(`   ⚠️  item ${un}/${oi.tais_code}: ${itErr.message}`);
      else { oi.item_id = it.id; itemIns++; }
    }
  }
  console.log(`   orders=${ordIns} / items=${itemIns}`);

  // ── 7. billing_unit_overrides INSERT (CSV の正確な単位数を月別に保存) ─
  console.log("\n🔢 billing_unit_overrides INSERT...");
  let ovIns = 0;
  const BATCH = 200;
  const ovPayloads = [];
  for (const u of unitOverrideMap.values()) {
    const cid = clientIdMap.get(u.user_number);
    if (!cid) continue;
    const oi = orderItemMap.get(orderItemKey(u.user_number, u.tais_code));
    if (!oi?.item_id) continue;
    ovPayloads.push({
      tenant_id: TENANT_ID,
      client_id: cid,
      month: u.service_month,
      order_item_id: oi.item_id,
      units_override: u.units,
    });
  }
  for (let i = 0; i < ovPayloads.length; i += BATCH) {
    const batch = ovPayloads.slice(i, i + BATCH);
    const { error } = await sb.from("billing_unit_overrides").insert(batch);
    if (error) console.warn(`   ⚠️  batch ${i}: ${error.message}`);
    else ovIns += batch.length;
  }
  console.log(`   inserted=${ovIns}`);

  console.log("\n✅ 完了\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
