// 福祉用具貸与 (order-app) 請求ロジック網羅率向上のためのサンプル投入 (H割当・user承認済み・2026-09-05)
//
//   node migrations/seed_sample_fukuyogu_coverage_g.mjs              # DRY RUN
//   node migrations/seed_sample_fukuyogu_coverage_g.mjs --execute    # 投入
//   node migrations/seed_sample_fukuyogu_coverage_g.mjs --delete             # 撤去 DRY RUN
//   node migrations/seed_sample_fukuyogu_coverage_g.mjs --delete --execute   # 撤去
//
// ── 背景 ────────────────────────────────────────────────────────────────
//   scripts/fukuyogu-coverage-check.mts (2026-09-05) で判明した0件因子を
//   サンプルで通し、44.6% の網羅率を引き上げる。
//     半月按分       1/4 (0件: 前半のみ/後半のみ/該当なし)
//     入院による除外  1/2 (0件: 入院あり)
//     価格改定       1/2 (0件: 履歴あり)
//     公費           1/2 (0件: あり)
//     貸与期間の逆転  1/2 (0件: 逆転)
//     品目区分      13/14 (0件: 車椅子付属品/自動排泄処理装置)
//
// ── 品目区分の0件について (投入前に判明した注記) ──────────────────────────
//   「車椅子付属品」(漢字) は0件だが、同義の「車いす付属品」(ひらがな) は
//   実データに複数存在する (00206-000051 等)。★ これは真の網羅性ギャップではなく
//   fukuyogu-coverage-check.mts の values 配列に表記ゆれ2種を別値として
//   入れていたことによる重複計上。今回は追加投入しない (報告のみ)。
//   「自動排泄処理装置」は両表記(漢字/自動排せつ)とも equipment_master に
//   1件も存在しない = ★ このカテゴリの用具をそもそも扱っていない可能性がある。
//   サービスコード変換経路(fukuyoguServiceCode)自体は通すため、このscriptで
//   サンプル用具を1件だけ新設する (実務の裏付けでなく経路確認のためと明記)。
//
// ⚠ サンプルは 2026-12 のみ。2026-06/07 には触れない。
// ⚠ office は触らない。既存の福祉用具事業所 (花見川) を使う。
// ⚠ equipment_master の実在商品の価格履歴には一切触れない (価格改定検証は
//   サンプル専用の新規商品で行う。実商品の価格履歴を弄ると実際のレンタル中
//   利用者の将来請求に影響しうるため)。
// ⚠ 撤去は接頭辞+氏名マーカーの両方一致。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const l of readFileSync(join(__dirname, "..", "..", "kaigo-app", ".env.local"), "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY が無い。中止します");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const TAG = "g";
const MK = `[sample-${TAG}]`;
const TENANT = "kt-group";
const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");

// 花見川用具 (既存。実在。offices は変更しない)
const OFFICE_ID = "e1b7b604-a4fd-44d5-98d1-efcb440ba035";
// サンプル専用の新規商品コード (実商品には一切触れない)
const SAMPLE_PRODUCT_KAIGO_KOTEI = `SAMPLE-${TAG}-KOTEI`; // 価格改定あり検証用 (特殊寝台)
const SAMPLE_PRODUCT_HAISETSU = `SAMPLE-${TAG}-HAISETSU`; // 自動排泄処理装置の経路確認用

function userNumber(seq) { return `Z${TAG.toUpperCase()}${String(seq).padStart(3, "0")}`; }

async function insertRows(table, rows) {
  if (!EXECUTE) { console.log(`  [DRY] ${table} に ${rows.length} 行`); return rows.map((_, i) => `dry-${table}-${i}`); }
  const { data, error } = await sb.from(table).insert(rows).select("id");
  if (error) throw new Error(`${table} INSERT 失敗: ${error.message}`);
  if (!data || data.length !== rows.length) throw new Error(`${table}: ${rows.length}行送って${data?.length ?? 0}行しか返らない`);
  return data.map((d) => d.id);
}

async function doDelete() {
  console.log(`=== 撤去 (tag=${TAG} / ${MK}) ===`);
  const { data: cs, error } = await sb.from("clients").select("id,name,user_number").like("user_number", `Z${TAG.toUpperCase()}%`);
  if (error) throw new Error(`clients取得失敗: ${error.message}`);
  const mine = (cs ?? []).filter((c) => String(c.name ?? "").includes(MK));
  console.log(`撤去対象 clients: ${mine.length} 名`);
  const ids = mine.map((c) => c.id);

  if (!EXECUTE) {
    console.log(`  [DRY] order_items / client_office_assignments / client_insurance_records /`);
    console.log(`        client_hospitalizations / client_public_expenses / clients を削除`);
    console.log(`  [DRY] equipment_price_history / equipment_master (サンプル専用商品) を削除`);
    return;
  }

  if (ids.length > 0) {
    // order_items は order_id 経由で orders に紐付く。まず orders を特定
    const { data: orders } = await sb.from("orders").select("id").in("client_id", ids);
    const orderIds = (orders ?? []).map((o) => o.id);
    if (orderIds.length > 0) {
      const { error: e0 } = await sb.from("order_items").delete().in("order_id", orderIds);
      if (e0) throw new Error(`order_items DELETE失敗: ${e0.message}`);
      const { error: e0b } = await sb.from("orders").delete().in("id", orderIds);
      if (e0b) throw new Error(`orders DELETE失敗: ${e0b.message}`);
      console.log(`  order_items / orders 削除完了 (${orderIds.length} 件の発注)`);
    }
    for (const [table, key] of [
      ["client_office_assignments", "client_id"],
      ["client_insurance_records", "client_id"],
      ["client_hospitalizations", "client_id"],
      ["client_public_expenses", "client_id"],
    ]) {
      const { error: e1 } = await sb.from(table).delete().in(key, ids);
      if (e1) throw new Error(`${table} DELETE失敗: ${e1.message}`);
      console.log(`  ${table} 削除完了`);
    }
    const { error: e2 } = await sb.from("clients").delete().in("id", ids);
    if (e2) throw new Error(`clients DELETE失敗: ${e2.message}`);
  }

  // サンプル専用equipment (実商品には触れない)
  const { error: e3 } = await sb.from("equipment_price_history").delete().in("product_code", [SAMPLE_PRODUCT_KAIGO_KOTEI]);
  if (e3) throw new Error(`equipment_price_history DELETE失敗: ${e3.message}`);
  const { error: e4 } = await sb.from("equipment_master").delete().in("product_code", [SAMPLE_PRODUCT_KAIGO_KOTEI, SAMPLE_PRODUCT_HAISETSU]);
  if (e4) throw new Error(`equipment_master DELETE失敗: ${e4.message}`);
  console.log(`  equipment_price_history / equipment_master (サンプル専用商品) 削除完了`);

  // 0件確認
  const { data: left } = await sb.from("clients").select("id,name").like("user_number", `Z${TAG.toUpperCase()}%`);
  const leftMine = (left ?? []).filter((c) => String(c.name ?? "").includes(MK));
  if (leftMine.length !== 0) throw new Error(`撤去したのに ${leftMine.length} 行残っている`);
  const { data: leftEq } = await sb.from("equipment_master").select("product_code").in("product_code", [SAMPLE_PRODUCT_KAIGO_KOTEI, SAMPLE_PRODUCT_HAISETSU]);
  if ((leftEq ?? []).length !== 0) throw new Error(`equipment_masterのサンプル商品が残っている`);
  console.log(`✅ 撤去完了。残 0 件を確認`);
}

async function doSeed() {
  console.log(`=== サンプル投入 (tag=${TAG} / ${MK} / MONTH=2026-12・DRY=${!EXECUTE}) ===`);

  const off = await sb.from("offices").select("id,name").eq("id", OFFICE_ID).maybeSingle();
  if (!off.data) throw new Error(`事業所 ${OFFICE_ID} が実在しない`);
  console.log(`事業所: ${off.data.name}`);

  // ── サンプル専用equipment (実商品は一切触らない) ──
  await insertRows("equipment_master", [
    {
      tenant_id: TENANT, product_code: SAMPLE_PRODUCT_KAIGO_KOTEI,
      name: `サンプル特殊寝台 ${MK}`, category: "特殊寝台", kind: "single",
      rental_price: 12000, // 「現在価格」(2026-12時点でこれとは別の履歴価格が有効なことを検証する)
    },
    {
      tenant_id: TENANT, product_code: SAMPLE_PRODUCT_HAISETSU,
      name: `サンプル自動排泄処理装置 ${MK}`, category: "自動排泄処理装置", kind: "single",
      rental_price: 15000,
    },
  ]);
  // 価格改定: 2026-11-15付けで11,000円に改定されている想定 (2026-12時点の実効価格は11,000円)
  await insertRows("equipment_price_history", [
    { tenant_id: TENANT, product_code: SAMPLE_PRODUCT_KAIGO_KOTEI, rental_price: 10000, valid_from: "2024-01-01" },
    { tenant_id: TENANT, product_code: SAMPLE_PRODUCT_KAIGO_KOTEI, rental_price: 11000, valid_from: "2026-11-15" },
  ]);

  // ── クライアント (6名。1名1シナリオ) ──
  const clients = [
    { seq: 1, name: `サンプル1 前半のみ ${MK}`, careLevel: "要介護2" },
    { seq: 2, name: `サンプル2 後半のみ ${MK}`, careLevel: "要介護3" },
    { seq: 3, name: `サンプル3 入院で該当なし ${MK}`, careLevel: "要介護1" },
    { seq: 4, name: `サンプル4 価格改定 ${MK}`, careLevel: "要介護2" },
    { seq: 5, name: `サンプル5 公費あり ${MK}`, careLevel: "要支援2" },
    { seq: 6, name: `サンプル6 貸与期間逆転 ${MK}`, careLevel: "要介護1" },
    { seq: 7, name: `サンプル7 自動排泄処理装置 ${MK}`, careLevel: "要介護4" },
    { seq: 8, name: `サンプル8 貸与期間逆転翌月開始 ${MK}`, careLevel: "要介護1" },
  ].map((c) => ({
    tenant_id: TENANT, user_number: userNumber(c.seq), name: c.name, furigana: "サンプル",
    care_level: c.careLevel, benefit_rate: "90", status: "active",
    insurer_number: "121012", insured_number: `Z${TAG}${String(c.seq).padStart(8, "0")}`.slice(0, 10),
    birth_date: "1940-01-01", is_facility: false, is_provisional: false,
  }));
  const clientIds = await insertRows("clients", clients);
  const [c1, c2, c3, c4, c5, c6, c7, c8] = EXECUTE ? clientIds : clients.map((_, i) => `dry-c${i + 1}`);

  await insertRows("client_office_assignments", [c1, c2, c3, c4, c5, c6, c7, c8].map((id) => ({
    tenant_id: TENANT, client_id: id, office_id: OFFICE_ID, start_date: "2026-04-01",
  })));

  // 入院 (クライアント3: 12月まるごと入院)
  await insertRows("client_hospitalizations", [
    { tenant_id: TENANT, client_id: c3, admission_date: "2026-11-20", discharge_date: "2027-01-10", notes: `${MK} 12月まるごと入院検証` },
  ]);

  // 公費 (クライアント5)
  await insertRows("client_public_expenses", [
    { tenant_id: TENANT, client_id: c5, hohei_code: "12", futan_sha_number: "12123519", jukyu_sha_number: "0000099", valid_start: "2026-04-01", valid_end: "2027-03-31" },
  ]);

  // ── orders + order_items ──
  // 既存の実在商品 (車いす) を使い回す。価格改定・自動排泄はサンプル専用商品を使う
  const REAL_WHEELCHAIR = "00206-000051"; // 車いす付属品カテゴリの実商品 (マイクッション)。ここでは通常の車いす貸与として使わず単に「実在する軽量な商品」として利用
  const { data: realEq } = await sb.from("equipment_master").select("product_code,category").eq("category", "特殊寝台").limit(1).maybeSingle();
  const REAL_TOKUSHU_SHINDAI = realEq?.product_code ?? REAL_WHEELCHAIR;

  const orderRows = [c1, c2, c3, c4, c5, c6, c7, c8].map((clientId) => ({
    tenant_id: TENANT, client_id: clientId, ordered_at: "2026-11-25T00:00:00+09:00",
    status: "completed", payment_type: "介護", delivery_type: "自社納品",
  }));
  const orderIds = await insertRows("orders", orderRows);
  const [o1, o2, o3, o4, o5, o6, o7, o8] = EXECUTE ? orderIds : orderRows.map((_, i) => `dry-o${i + 1}`);

  const itemRows = [
    // C1: 前半のみ (12/1開始・12/15終了)
    { tenant_id: TENANT, order_id: o1, product_code: REAL_TOKUSHU_SHINDAI, status: "terminated", quantity: 1, rental_start_date: "2026-12-01", rental_end_date: "2026-12-15" },
    // C2: 後半のみ (12/16開始・継続中)
    { tenant_id: TENANT, order_id: o2, product_code: REAL_TOKUSHU_SHINDAI, status: "rental_started", quantity: 1, rental_start_date: "2026-12-16", rental_end_date: null },
    // C3: 全月レンタルだが入院で「該当なし」(11月開始・継続中)
    { tenant_id: TENANT, order_id: o3, product_code: REAL_TOKUSHU_SHINDAI, status: "rental_started", quantity: 1, rental_start_date: "2026-11-01", rental_end_date: null },
    // C4: 価格改定検証 (サンプル専用商品。11月開始・継続中で12月は改定後価格が適用されるべき)
    { tenant_id: TENANT, order_id: o4, product_code: SAMPLE_PRODUCT_KAIGO_KOTEI, status: "rental_started", quantity: 1, rental_start_date: "2026-11-01", rental_end_date: null },
    // C5: 公費あり (全月)
    { tenant_id: TENANT, order_id: o5, product_code: REAL_TOKUSHU_SHINDAI, status: "rental_started", quantity: 1, rental_start_date: "2026-11-01", rental_end_date: null },
    // C6: 貸与期間の逆転 (同月内で開始>終了。fukuyogu-coverage-check.mtsのactiveRentals判定に
    //     乗る=「逆転」因子としてカウントされる形。この形だとcalcMonthUnits/BillingTab側とも0を返す)
    { tenant_id: TENANT, order_id: o6, product_code: REAL_TOKUSHU_SHINDAI, status: "terminated", quantity: 1, rental_start_date: "2026-12-20", rental_end_date: "2026-12-05" },
    // C7: 自動排泄処理装置カテゴリの経路確認 (全月)
    { tenant_id: TENANT, order_id: o7, product_code: SAMPLE_PRODUCT_HAISETSU, status: "rental_started", quantity: 1, rental_start_date: "2026-11-01", rental_end_date: null },
    // C8: 貸与期間の逆転(開始が翌月・終了が当月)。★ activeRentalsのフィルタでは12月請求対象から
    //     除外される(start>当月末のため)が、calcMonthUnits(利用者請求書側)の「start>当月末かつ
    //     end<=当月末」満額分岐だけは別経路で発火することを確認するための専用ケース
    { tenant_id: TENANT, order_id: o8, product_code: REAL_TOKUSHU_SHINDAI, status: "terminated", quantity: 1, rental_start_date: "2027-01-10", rental_end_date: "2026-12-20" },
  ];
  await insertRows("order_items", itemRows);

  console.log(EXECUTE ? "✅ 投入完了" : "【DRY RUN】--execute で実際に投入します");
  if (EXECUTE) {
    console.log(`C1(前半のみ)=${c1} C2(後半のみ)=${c2} C3(入院/該当なし)=${c3}`);
    console.log(`C4(価格改定)=${c4} C5(公費あり)=${c5} C6(貸与期間逆転)=${c6} C7(自動排泄)=${c7} C8(逆転翌月開始)=${c8}`);
    console.log(`使用した実商品(特殊寝台): ${REAL_TOKUSHU_SHINDAI}`);
    console.log(`次: npx tsx scripts/fukuyogu-coverage-check.mts と scripts/fukuyogu-coverage-sample-verify.mts`);
  }
}

(DELETE ? doDelete() : doSeed()).catch((e) => { console.error("✗ " + e.message); process.exit(1); });
