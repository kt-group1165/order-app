/**
 * 介護保険(5.14).csv で clients.phone を充填するスクリプト。
 *
 * 対象: clients.phone IS NULL の行のみ (= 直前に「office デフォルト埋込」を NULL 化した結果)
 *
 * 流れ:
 *   1. CSV から (insured_number, phone) を取得
 *   2. clients.phone IS NULL の行を 被保険者番号で照合
 *   3. CSV に phone があれば update
 *
 * Usage:
 *   node migrations/update_clients_phone_from_master_csv.mjs           # DRY RUN
 *   node migrations/update_clients_phone_from_master_csv.mjs --execute # 本番
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
const SUPABASE_URL =
  envOrder.NEXT_PUBLIC_SUPABASE_URL || envCal.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY =
  envOrder.SUPABASE_SERVICE_ROLE_KEY || envCal.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が読めません");
  process.exit(1);
}

const CSV_PATH = "C:/Users/domen-PC/Downloads/介護保険（5.14）.csv";
const TENANT_ID = "kt-group";
const EXECUTE = process.argv.includes("--execute");

const C = {
  PHONE: 14,
  INSURED_NUMBER: 24,
  USER_NAME_FULL: 3,
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

async function main() {
  console.log(`\n=== ${EXECUTE ? "本番実行" : "DRY RUN"} ===`);

  const { rows } = readCsv();
  const phoneByInsured = new Map();
  for (const r of rows) {
    const insured = pick(r[C.INSURED_NUMBER]);
    const phone = pick(r[C.PHONE]);
    if (insured && phone) phoneByInsured.set(insured, { phone, name: pick(r[C.USER_NAME_FULL]) });
  }
  console.log(`CSV: 被保番+電話 揃ってる行 ${phoneByInsured.size} 件\n`);

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const PAGE = 1000;
  const targets = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, insured_number")
      .eq("tenant_id", TENANT_ID)
      .is("phone", null)
      .not("insured_number", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    targets.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`DB: phone IS NULL かつ 被保番ありの clients: ${targets.length} 件\n`);

  const updates = [];
  const noMatch = [];
  for (const c of targets) {
    const m = phoneByInsured.get(c.insured_number);
    if (m) {
      updates.push({ id: c.id, name: c.name, insured: c.insured_number, phone: m.phone });
    } else {
      noMatch.push(c);
    }
  }
  console.log(`✓ 更新可能: ${updates.length} 件`);
  console.log(`× CSV 内に被保番なし or CSV 内 phone 空: ${noMatch.length} 件\n`);

  if (updates.length > 0) {
    console.log(`=== サンプル 3 件 ===`);
    for (const u of updates.slice(0, 3)) {
      console.log(`  ${u.name} (${u.insured}) → ${u.phone}`);
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
      .update({ phone: u.phone })
      .eq("id", u.id);
    if (error) { console.error(`  ✗ ${u.name}: ${error.message}`); fail++; }
    else ok++;
  }
  console.log(`\n成功: ${ok} / 失敗: ${fail}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
