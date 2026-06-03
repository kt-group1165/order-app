/**
 * 介護保険(5.14).csv (利用者マスタ SJIS 47列) で clients テーブルの
 * address / postal_code / phone を補正するスクリプト。
 *
 * 背景:
 *   2026-05-09 の R8_4kaigo.CSV 取込で column 38 を address として読んだが、
 *   実際は事業所住所 (= 千葉県市原市姉崎323番地) だったため、1065 件の
 *   clients.address が office address で埋まる事故が発生。
 *
 *   今回 介護保険(5.14).csv (= 利用者マスタ) を入手したので、
 *   被保険者番号で照合し、address (= 本物の自宅住所) で上書きする。
 *
 * ポリシー (P2 + B 推奨):
 *   - 既存 clients.address = '千葉県市原市姉崎323番地' の行のみを更新対象とする
 *     (= 手動修正済みの clients は保護)
 *   - 更新項目: address, postal_code, phone (= column 13, 12, 14)
 *   - 空欄は skip (= 既存値維持)
 *
 * Usage:
 *   node migrations/update_clients_address_from_master_csv.mjs           # DRY RUN
 *   node migrations/update_clients_address_from_master_csv.mjs --execute # 本番
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

// CSV path (ユーザーの Downloads フォルダ)
const CSV_PATH = "C:/Users/domen-PC/Downloads/介護保険（5.14）.csv";
const BAD_ADDRESS = "千葉県市原市姉崎323番地";
const TENANT_ID = "kt-group";
const EXECUTE = process.argv.includes("--execute");

// ── CSV ヘッダー (0-indexed, 利用者マスタ format) ────────────────────────────

const C = {
  USER_NUMBER: 0,
  USER_NAME_FULL: 3,
  FURIGANA_FULL: 6,
  GENDER: 8,
  BIRTH_DATE: 11,
  POSTAL_CODE: 12,
  ADDRESS: 13,
  PHONE: 14,
  MOBILE: 15,
  INSURED_NUMBER: 24,
  CERT_START: 33,
  CERT_END: 34,
  CARE_OFFICE_NAME_FULL: 46,
};

// ── CSV parser ───────────────────────────────────────────────────────────────

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

function pick(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

// ── メイン ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== ${EXECUTE ? "本番実行" : "DRY RUN"} ===`);
  console.log(`CSV: ${CSV_PATH}`);
  console.log(`対象: clients.address = '${BAD_ADDRESS}' の行のみ\n`);

  // 1) CSV 読み込み
  const { header, rows } = readCsv();
  console.log(`CSV 行数: ${rows.length}`);
  console.log(`列数: ${header.length}`);
  console.log(`想定 column 24 (被保険者番号) = "${header[24]}"`);
  console.log(`想定 column 13 (住所) = "${header[13]}"`);
  console.log(`想定 column 12 (郵便番号) = "${header[12]}"`);
  console.log(`想定 column 14 (電話番号) = "${header[14]}"`);

  // 2) CSV から被保険者番号→マスタ値の map
  const masterByInsured = new Map();
  let csvWithInsured = 0;
  for (const r of rows) {
    const insured = pick(r[C.INSURED_NUMBER]);
    if (!insured) continue;
    csvWithInsured++;
    masterByInsured.set(insured, {
      address: pick(r[C.ADDRESS]),
      postal_code: pick(r[C.POSTAL_CODE]),
      phone: pick(r[C.PHONE]),
      user_name: pick(r[C.USER_NAME_FULL]),
    });
  }
  console.log(`CSV 内 被保険者番号付き行: ${csvWithInsured} / ユニーク件数: ${masterByInsured.size}\n`);

  // 3) DB から「BAD_ADDRESS のままの clients」を取得
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const PAGE = 1000;
  const badClients = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, user_number, name, insured_number, address, postal_code, phone")
      .eq("tenant_id", TENANT_ID)
      .eq("address", BAD_ADDRESS)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    badClients.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`DB 内 address='${BAD_ADDRESS}' の clients: ${badClients.length} 件\n`);

  // 4) マッチング & 更新計画作成
  const updates = [];
  const noMatch = [];
  const noAddressInCsv = [];

  for (const c of badClients) {
    if (!c.insured_number) {
      noMatch.push({ ...c, reason: "client.insured_number 空" });
      continue;
    }
    const m = masterByInsured.get(c.insured_number);
    if (!m) {
      noMatch.push({ ...c, reason: "CSV 内に該当被保険者番号 無し" });
      continue;
    }
    if (!m.address) {
      noAddressInCsv.push({ ...c, csv_name: m.user_name });
      continue;
    }
    const update = { address: m.address };
    if (m.postal_code) update.postal_code = m.postal_code;
    if (m.phone) update.phone = m.phone;
    updates.push({
      id: c.id,
      name: c.name,
      insured_number: c.insured_number,
      before: { address: c.address, postal_code: c.postal_code, phone: c.phone },
      after: update,
    });
  }

  console.log(`=== マッチング結果 ===`);
  console.log(`✓ 更新可能: ${updates.length} 件`);
  console.log(`× CSV 内に被保番無 or client.insured_number 空: ${noMatch.length} 件`);
  console.log(`△ CSV にあるが address 空: ${noAddressInCsv.length} 件\n`);

  if (updates.length > 0) {
    console.log(`=== 更新例 (先頭 3 件) ===`);
    for (const u of updates.slice(0, 3)) {
      console.log(`\n[${u.name} / 被保番 ${u.insured_number}]`);
      console.log(`  address: "${u.before.address}" → "${u.after.address}"`);
      if (u.after.postal_code) console.log(`  postal:  "${u.before.postal_code ?? ""}" → "${u.after.postal_code}"`);
      if (u.after.phone) console.log(`  phone:   "${u.before.phone ?? ""}" → "${u.after.phone}"`);
    }
  }

  if (noMatch.length > 0 && noMatch.length <= 20) {
    console.log(`\n=== 未マッチ詳細 ===`);
    for (const m of noMatch.slice(0, 20)) {
      console.log(`  ${m.name} (被保番: ${m.insured_number ?? "<空>"}) — ${m.reason}`);
    }
  } else if (noMatch.length > 20) {
    console.log(`\n=== 未マッチ サマリ (${noMatch.length} 件) ===`);
    const reasons = {};
    for (const m of noMatch) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
    for (const [r, n] of Object.entries(reasons)) console.log(`  ${r}: ${n} 件`);
  }

  // 5) 実行
  if (!EXECUTE) {
    console.log(`\n⏸  DRY RUN モード。実行するには --execute を付けてください。`);
    return;
  }

  console.log(`\n🚀  本番実行開始...`);
  let ok = 0;
  let fail = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("clients")
      .update(u.after)
      .eq("id", u.id);
    if (error) {
      console.error(`  ✗ ${u.name}: ${error.message}`);
      fail++;
    } else {
      ok++;
    }
  }
  console.log(`\n=== 結果 ===`);
  console.log(`  成功: ${ok} 件`);
  console.log(`  失敗: ${fail} 件`);
}

main().catch((e) => {
  console.error("\n💥 例外:", e);
  process.exit(1);
});
