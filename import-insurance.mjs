// 保険.csv から client_insurance_records へ一括インポート
// 実行: node import-insurance.mjs
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SUPABASE_URL = "https://arkbrrdknhgurikiapcm.supabase.co";
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFya2JycmRrbmhndXJpa2lhcGNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0Nzc0MjcsImV4cCI6MjA5MDA1MzQyN30.oEWqkVvKxE7IQuoUMWg18LDn_jjQYctrjwyf3MePIJU";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const __dirname = dirname(fileURLToPath(import.meta.url));

// CSVパース（カンマ区切り、クォート対応）
function parseCsvRow(line) {
  const result = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { result.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  result.push(cur);
  return result;
}

// "2022/3/1" → "2022-03-01"、空・無効は null
function toDate(s) {
  if (!s || !s.trim()) return null;
  const parts = s.trim().split("/");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts;
  if (!y || !m || !d) return null;
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function val(s) {
  const v = (s ?? "").trim();
  return v === "" ? null : v;
}

async function main() {
  // CSVを読み込んでShift-JISデコード
  const buf = readFileSync(join(__dirname, "保険.csv"));
  const text = new TextDecoder("shift_jis").decode(buf);
  const lines = text.split("\n").filter((l) => l.trim());

  const headers = parseCsvRow(lines[0]);
  const col = (name) => headers.indexOf(name);

  // 列インデックス
  const C = {
    user_number:             col("利用者番号"),
    birth_date:              col("生年月日"),
    insured_number:          col("被保険者番号"),
    insurer_name:            col("保険者"),
    insurer_number:          col("保険者番号"),
    copay_rate:              col("給付率"),
    care_level:              col("要介護度"),
    certification_start:     col("認定有効期間－開始日"),
    certification_end:       col("認定有効期間－終了日"),
    care_manager_org:        col("支援事業所"),
    care_manager:            col("担当ケアマネジャー"),
  };

  console.log("列インデックス:", C);

  // 全テナントの利用者を取得（user_number → {id, tenant_id} のマップ）
  const { data: clients, error: clientsErr } = await supabase
    .from("clients")
    .select("id, tenant_id, user_number");
  if (clientsErr) { console.error("clients取得エラー:", clientsErr); process.exit(1); }

  const clientMap = new Map();
  for (const c of clients) {
    if (c.user_number) clientMap.set(c.user_number.trim(), c);
  }
  console.log(`利用者数: ${clients.length}`);

  // データ行をパース
  const rows = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = parseCsvRow(line);
    const userNum = val(cols[C.user_number]);
    if (!userNum) continue;
    const client = clientMap.get(userNum);
    if (!client) continue; // マッチする利用者がいない場合はスキップ

    const certStart = toDate(cols[C.certification_start]);
    const certEnd   = toDate(cols[C.certification_end]);

    rows.push({
      tenant_id:                client.tenant_id,
      client_id:                client.id,
      effective_date:           certStart,
      birth_date:               toDate(cols[C.birth_date]),
      insured_number:           val(cols[C.insured_number]),
      insurer_name:             val(cols[C.insurer_name]),
      insurer_number:           val(cols[C.insurer_number]),
      copay_rate:               val(cols[C.copay_rate]),
      care_level:               val(cols[C.care_level]),
      certification_start_date: certStart,
      certification_end_date:   certEnd,
      care_manager_org:         val(cols[C.care_manager_org]),
      care_manager:             val(cols[C.care_manager]),
    });
  }
  console.log(`インポート対象行数: ${rows.length}`);

  // 対象利用者の既存レコードを削除してから新規挿入
  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  console.log(`対象利用者数: ${clientIds.length}`);

  // 100件ずつ削除
  for (let i = 0; i < clientIds.length; i += 100) {
    const chunk = clientIds.slice(i, i + 100);
    const { error } = await supabase
      .from("client_insurance_records")
      .delete()
      .in("client_id", chunk);
    if (error) console.warn("削除エラー:", error);
  }
  console.log("既存レコード削除完了");

  // 50件ずつ挿入
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const { error } = await supabase
      .from("client_insurance_records")
      .insert(chunk);
    if (error) { console.error("挿入エラー:", error); }
    else inserted += chunk.length;
  }
  console.log(`挿入完了: ${inserted}件`);
}

main().catch(console.error);
