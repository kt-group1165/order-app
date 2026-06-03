/**
 * 介護保険(5.14).csv を マスター扱いし、全 client の address / postal_code / phone を
 * 被保険者番号で照合して上書きする。
 *
 * 方針:
 *   - CSV にある全 client (= 被保番付き 1443 件) を対象
 *   - CSV の address / postal_code / phone で上書き
 *   - CSV の値が空欄なら既存値維持
 *   - 「姉崎323番地」filter は **外す** (= 全マッチ対象に処理)
 *
 * Usage:
 *   node migrations/sync_clients_from_master_csv.mjs           # DRY RUN
 *   node migrations/sync_clients_from_master_csv.mjs --execute # 本番
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const SUPABASE_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が読めません");
  process.exit(1);
}

const CSV_PATH = "C:/Users/domen-PC/Downloads/介護保険（5.14）.csv";
const TENANT_ID = "kt-group";
const EXECUTE = process.argv.includes("--execute");

const C = {
  USER_NAME_FULL: 3,
  POSTAL_CODE: 12,
  ADDRESS: 13,
  PHONE: 14,
  INSURED_NUMBER: 24,
};

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
  return { header: parseCsvLine(lines[0]), rows: lines.slice(1).map(parseCsvLine) };
}

function pick(s) {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > 0 ? t : null;
}

// 被保険者番号正規化: 先頭ゼロを除去
// 例: "0000230599" → "230599", "1000080478" → "1000080478" (変化なし)
function normInsured(s) {
  if (!s) return null;
  const t = String(s).trim().replace(/^0+/, "");
  return t.length > 0 ? t : null;
}

async function main() {
  console.log(`\n=== ${EXECUTE ? "本番実行" : "DRY RUN"} ===`);
  console.log(`方針: CSV をマスター扱い、全 client の address/postal/phone を上書き\n`);

  const { rows } = readCsv();
  // 正規化キー (先頭ゼロ除去) でマップ作成 → DB 側の zero-padded 被保番にもマッチ
  const masterByInsured = new Map();
  for (const r of rows) {
    const insured = normInsured(r[C.INSURED_NUMBER]);
    if (!insured) continue;
    masterByInsured.set(insured, {
      address: pick(r[C.ADDRESS]),
      postal_code: pick(r[C.POSTAL_CODE]),
      phone: pick(r[C.PHONE]),
      user_name: pick(r[C.USER_NAME_FULL]),
    });
  }
  console.log(`CSV: ユニーク被保番 (正規化後) ${masterByInsured.size} 件\n`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const PAGE = 1000;
  const allClients = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, insured_number, address, postal_code, phone")
      .eq("tenant_id", TENANT_ID)
      .not("insured_number", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    allClients.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`DB: 被保番付き clients ${allClients.length} 件\n`);

  const updates = [];
  let identical = 0;
  let noMatch = 0;
  for (const c of allClients) {
    // DB 側の被保番も正規化してから lookup
    const m = masterByInsured.get(normInsured(c.insured_number));
    if (!m) { noMatch++; continue; }

    const u = {};
    let changes = 0;
    if (m.address && m.address !== c.address) { u.address = m.address; changes++; }
    if (m.postal_code && m.postal_code !== c.postal_code) { u.postal_code = m.postal_code; changes++; }
    if (m.phone && m.phone !== c.phone) { u.phone = m.phone; changes++; }

    if (changes === 0) { identical++; continue; }

    updates.push({
      id: c.id,
      name: c.name,
      insured: c.insured_number,
      before: { address: c.address, postal_code: c.postal_code, phone: c.phone },
      after: u,
    });
  }

  console.log(`=== マッチング結果 ===`);
  console.log(`✓ 上書き対象: ${updates.length} 件`);
  console.log(`= 既に CSV と一致: ${identical} 件`);
  console.log(`× CSV にマッチ無し: ${noMatch} 件\n`);

  if (updates.length > 0) {
    console.log(`=== サンプル 5 件 ===`);
    for (const u of updates.slice(0, 5)) {
      console.log(`\n[${u.name} / 被保番 ${u.insured}]`);
      if (u.after.address) console.log(`  address:  "${u.before.address ?? ""}" → "${u.after.address}"`);
      if (u.after.postal_code) console.log(`  postal:   "${u.before.postal_code ?? ""}" → "${u.after.postal_code}"`);
      if (u.after.phone) console.log(`  phone:    "${u.before.phone ?? ""}" → "${u.after.phone}"`);
    }
    console.log();
  }

  if (!EXECUTE) {
    console.log(`⏸  DRY RUN. --execute で本番。`);
    return;
  }

  console.log(`🚀  本番実行...`);
  let ok = 0, fail = 0;
  for (const u of updates) {
    const { error } = await supabase
      .from("clients")
      .update(u.after)
      .eq("id", u.id);
    if (error) { console.error(`  ✗ ${u.name}: ${error.message}`); fail++; }
    else ok++;
  }
  console.log(`\n成功: ${ok} / 失敗: ${fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
