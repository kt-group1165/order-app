/**
 * 介護請求明細ExcelファイルからDBへレンタル中用具を一括インポート
 *
 * 使い方:
 *   node import-rentals.mjs [Excelファイルパス] [テナントID]
 *
 * 例:
 *   node import-rentals.mjs "介護請求明細付R8.2.xlsx" care-chiba
 *
 * 既存のclient_rental_historyはクリアせず追記する（--clear オプションで削除してから実行）
 * 再実行時に重複しないよう source='import' の既存データを確認する
 */

import ExcelJS from 'exceljs';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 設定 ─────────────────────────────────────────────────────────────────────

// .env.local から SUPABASE_URL / ANON_KEY を読み込む
function loadEnv() {
  try {
    const env = readFileSync(join(__dirname, '.env.local'), 'utf8');
    const vars = {};
    for (const line of env.split('\n')) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim();
    }
    return vars;
  } catch {
    return {};
  }
}
const env = loadEnv();
const SUPABASE_URL  = env.NEXT_PUBLIC_SUPABASE_URL  || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY  || env.NEXT_PUBLIC_SUPABASE_ANON_KEY
                   || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_KEY が取得できませんでした');
  process.exit(1);
}

const EXCEL_FILE  = process.argv[2] || '介護請求明細付R8.2.xlsx';
const TENANT_ID   = process.argv[3] || 'care-chiba';
const EQ_TENANT   = 'default';          // equipment_master のテナント
const DRY_RUN     = process.argv.includes('--dry-run');
const CLEAR       = process.argv.includes('--clear');

// ── Excel 列インデックス（1始まり）────────────────────────────────────────────
const COL = {
  USER_NUMBER:      8,   // 利用者番号
  USER_NAME:        9,   // 利用者名
  SERVICE_TYPE:     59,  // サービス種類名称（福祉用具貸与 でフィルタ）
  SERVICE_MONTH:    5,   // 提供年月
  START_DATE:       55,  // サービス開始年月日
  END_DATE:         56,  // サービス中止年月日
  SERVICE_CONTENT:  132, // サービス内容（種目: 車いす等）
  TAIS_CODE:        137, // 摘要（TAISコード: 00066-000320形式）
  PRODUCT_NAME:     151, // 商品名
};

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function toDate(v) {
  if (!v) return null;
  try { return new Date(v).toISOString().split('T')[0]; } catch { return null; }
}

// ── メイン ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📂 ファイル: ${EXCEL_FILE}`);
  console.log(`🏢 テナント: ${TENANT_ID}`);
  if (DRY_RUN) console.log('🔍 DRY RUN モード（DBには書き込みません）');
  console.log('');

  const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ── 1. クリアオプション ─────────────────────────────────────────────────────
  if (CLEAR && !DRY_RUN) {
    console.log('🗑  既存インポートデータを削除中...');
    const { error } = await sb.from('client_rental_history')
      .delete()
      .eq('tenant_id', TENANT_ID)
      .eq('source', 'import');
    if (error) { console.error('削除エラー:', error.message); process.exit(1); }
    console.log('   削除完了');
  }

  // ── 2. DBマスタ読み込み ─────────────────────────────────────────────────────
  console.log('📡 DBデータ読み込み中...');

  // clients（利用者番号 → id）
  const clientMap = new Map(); // user_number → client.id
  let from = 0;
  while (true) {
    const { data, error } = await sb.from('clients')
      .select('id, user_number')
      .eq('tenant_id', TENANT_ID)
      .range(from, from + 999);
    if (error) { console.error('clients取得エラー:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    data.forEach(c => clientMap.set(c.user_number, c.id));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`   利用者: ${clientMap.size}名`);

  // equipment_master（TAISコード → rental_price）
  const eqMap = new Map(); // tais_code → { product_code, rental_price, name }
  from = 0;
  while (true) {
    const { data, error } = await sb.from('equipment_master')
      .select('product_code, tais_code, name, rental_price')
      .eq('tenant_id', EQ_TENANT)
      .range(from, from + 999);
    if (error) { console.error('equipment_master取得エラー:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;
    data.forEach(e => { if (e.tais_code && !eqMap.has(e.tais_code)) eqMap.set(e.tais_code, e); });
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`   用具マスタ: ${eqMap.size}件（TAISコードあり）`);

  // ── 3. Excel読み込み・重複除去 ─────────────────────────────────────────────
  console.log('\n📊 Excelファイル解析中...');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_FILE);
  const sheet = wb.getWorksheet(1);

  const itemMap = new Map(); // key: userNum|taisCode|productName
  let totalRows = 0;

  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const v = row.values;
    if (v[COL.SERVICE_TYPE] !== '福祉用具貸与') return;
    totalRows++;

    const userNum      = String(v[COL.USER_NUMBER] ?? '').trim();
    const taisCode     = String(v[COL.TAIS_CODE] ?? '').trim();
    const productName  = String(v[COL.PRODUCT_NAME] ?? '').trim();
    const serviceContent = String(v[COL.SERVICE_CONTENT] ?? '').trim();
    const startDate    = toDate(v[COL.START_DATE]);
    const endDate      = toDate(v[COL.END_DATE]);
    const serviceMonth = toDate(v[COL.SERVICE_MONTH]);

    if (!userNum || !productName) return;
    const key = `${userNum}|${taisCode}|${productName}`;

    if (!itemMap.has(key)) {
      itemMap.set(key, { userNum, productName, taisCode, serviceContent, startDate, endDate: null, latestMonth: serviceMonth });
    }
    const ex = itemMap.get(key);
    // 最も古い開始日を使用
    if (startDate && (!ex.startDate || startDate < ex.startDate)) ex.startDate = startDate;
    // 最新提供月のendDateを保持（null = まだ使用中）
    if (!ex.latestMonth || (serviceMonth && serviceMonth >= ex.latestMonth)) {
      ex.latestMonth = serviceMonth;
      ex.endDate = endDate;
    }
  });

  const activeItems = [...itemMap.values()].filter(i => i.endDate === null);
  console.log(`   福祉用具貸与行数: ${totalRows}`);
  console.log(`   重複除去後: ${itemMap.size}件`);
  console.log(`   現在レンタル中（解約なし）: ${activeItems.length}件`);

  // ── 4. マッピングとデータ組み立て ──────────────────────────────────────────
  console.log('\n🔗 データ照合中...');

  const records = [];
  const unmatchedClients = new Set();
  let priceMatched = 0, priceUnmatched = 0;

  for (const item of activeItems) {
    const clientId = clientMap.get(item.userNum);
    if (!clientId) {
      unmatchedClients.add(item.userNum);
      continue;
    }

    const eq = eqMap.get(item.taisCode);
    const rentalPrice = eq?.rental_price ?? null;
    if (rentalPrice) priceMatched++; else priceUnmatched++;

    records.push({
      tenant_id:      TENANT_ID,
      client_id:      clientId,
      equipment_name: item.productName,
      model_number:   item.taisCode || null,  // TAISコードをmodel_numberに格納
      start_date:     item.startDate,
      end_date:       null,
      monthly_price:  rentalPrice,
      notes:          item.serviceContent || null,  // 種目（車いす等）
      source:         'import',
    });
  }

  console.log(`   インポート対象: ${records.length}件`);
  console.log(`   うちrental_price取得: ${priceMatched}件`);
  console.log(`   うちrental_price未設定: ${priceUnmatched}件`);
  if (unmatchedClients.size > 0) {
    console.log(`   ⚠️  利用者DBに未登録の利用者番号: ${unmatchedClients.size}名`);
    if (unmatchedClients.size <= 20) console.log(`      番号: ${[...unmatchedClients].join(', ')}`);
  }

  if (DRY_RUN) {
    console.log('\n✅ DRY RUN完了。--dry-runを外して再実行するとDBに書き込みます。');
    console.log('\nサンプル（最初の3件）:');
    records.slice(0, 3).forEach(r => console.log(JSON.stringify(r)));
    return;
  }

  // ── 5. Supabaseへ一括挿入（100件ずつバッチ）──────────────────────────────
  console.log('\n💾 DBへ書き込み中...');
  const BATCH = 100;
  let inserted = 0, errors = 0;

  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    const { error } = await sb.from('client_rental_history').insert(batch);
    if (error) {
      console.error(`  バッチ ${i}-${i + batch.length} エラー:`, error.message);
      errors += batch.length;
    } else {
      inserted += batch.length;
      process.stdout.write(`\r  進捗: ${inserted}/${records.length}件`);
    }
  }

  console.log(`\n\n✅ 完了！`);
  console.log(`   挿入成功: ${inserted}件`);
  if (errors > 0) console.log(`   ❌ エラー: ${errors}件`);
}

main().catch(e => { console.error('予期せぬエラー:', e); process.exit(1); });
