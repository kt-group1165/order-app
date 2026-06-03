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
const FORCE = process.argv.includes("--force-with-warnings");

// 警告の閾値
const W = {
  SHARED_ADDRESS_THRESHOLD: 10,   // 同住所が N+ で共有 → office address 埋込疑い
  SHARED_PHONE_THRESHOLD: 10,     // 同電話が N+ で共有 → office phone 埋込疑い
  INSURED_DIGITS: 10,             // 被保番桁数 (= 10 桁数字)
  CHANGE_RATIO_WARN: 0.20,        // DB 全体の 20% 以上が変わる → 警告
  HEADER_EXPECT: {                // 列マッピング sanity check
    0: "利用者番号",
    3: "利用者名",
    12: "郵便番号",
    13: "住所",
    14: "電話番号",
    24: "被保険者番号",
  },
};

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

  const { header, rows } = readCsv();

  // ─── Level 1: 列マッピング sanity check ─────────────────────────────────
  const headerErrors = [];
  for (const [idx, expected] of Object.entries(W.HEADER_EXPECT)) {
    const actual = header[Number(idx)];
    if (!actual || !actual.includes(expected.replace("利用者名", ""))) {
      // "利用者名" は完全一致したい (= column 3)
      if (Number(idx) === 3 && actual !== expected) {
        headerErrors.push(`column ${idx}: expected "${expected}" but got "${actual}"`);
      } else if (Number(idx) !== 3 && !actual?.includes(expected)) {
        headerErrors.push(`column ${idx}: expected "${expected}" but got "${actual}"`);
      }
    }
  }
  if (headerErrors.length > 0) {
    console.error(`🚨 列マッピング異常:`);
    for (const e of headerErrors) console.error(`   ${e}`);
    console.error(`\nCSV 形式が想定と違います。column 番号定数 C.* と CSV header を確認してください。`);
    process.exit(1);
  }
  console.log(`✓ Level 1: 列マッピング OK (header 想定通り)`);

  // ─── CSV パース ─────────────────────────────────────────────────────────
  const masterByInsured = new Map();
  const csvDupInsured = new Set();
  const addressCount = new Map();
  const phoneCount = new Map();
  const invalidInsured = [];
  const futureBirths = [];

  for (const r of rows) {
    const insuredRaw = pick(r[C.INSURED_NUMBER]);
    const insured = normInsured(insuredRaw);
    if (!insured) continue;

    // Level 2: 被保番形式チェック (10 桁数字)
    if (insuredRaw && !/^\d+$/.test(insuredRaw)) {
      invalidInsured.push({ raw: insuredRaw, name: pick(r[C.USER_NAME_FULL]) });
    }

    // Level 2: 重複被保番チェック
    if (masterByInsured.has(insured)) csvDupInsured.add(insured);

    const address = pick(r[C.ADDRESS]);
    const phone = pick(r[C.PHONE]);

    // Level 2: 住所/電話 の共有度カウント
    if (address) addressCount.set(address, (addressCount.get(address) ?? 0) + 1);
    if (phone) phoneCount.set(phone, (phoneCount.get(phone) ?? 0) + 1);

    masterByInsured.set(insured, {
      address,
      postal_code: pick(r[C.POSTAL_CODE]),
      phone,
      user_name: pick(r[C.USER_NAME_FULL]),
    });
  }
  console.log(`CSV: ユニーク被保番 (正規化後) ${masterByInsured.size} 件\n`);

  // ─── Level 2: CSV 内 異常検出 ─────────────────────────────────────────
  const warnings = [];
  const sharedAddresses = [...addressCount.entries()].filter(([_, n]) => n >= W.SHARED_ADDRESS_THRESHOLD);
  const sharedPhones = [...phoneCount.entries()].filter(([_, n]) => n >= W.SHARED_PHONE_THRESHOLD);

  if (sharedAddresses.length > 0) {
    warnings.push(`⚠️  Level 2: 同じ住所が ${W.SHARED_ADDRESS_THRESHOLD}+ 行で共有 (= office address 埋込疑い)`);
    for (const [addr, cnt] of sharedAddresses.slice(0, 5)) {
      warnings.push(`     ${cnt} 件: "${addr}"`);
    }
    if (sharedAddresses.length > 5) warnings.push(`     ... 他 ${sharedAddresses.length - 5} パターン`);
  }
  if (sharedPhones.length > 0) {
    warnings.push(`⚠️  Level 2: 同じ電話が ${W.SHARED_PHONE_THRESHOLD}+ 行で共有 (= office phone 埋込疑い)`);
    for (const [ph, cnt] of sharedPhones.slice(0, 5)) {
      warnings.push(`     ${cnt} 件: "${ph}"`);
    }
    if (sharedPhones.length > 5) warnings.push(`     ... 他 ${sharedPhones.length - 5} パターン`);
  }
  if (invalidInsured.length > 0) {
    warnings.push(`⚠️  Level 2: 被保番形式異常 ${invalidInsured.length} 件 (数字以外混入 or 桁不正)`);
    for (const e of invalidInsured.slice(0, 5)) {
      warnings.push(`     "${e.raw}" (${e.name})`);
    }
  }
  if (csvDupInsured.size > 0) {
    warnings.push(`⚠️  Level 2: CSV 内に重複 被保番 ${csvDupInsured.size} 件`);
  }
  if (futureBirths.length > 0) {
    warnings.push(`⚠️  Level 2: 未来の生年月日 ${futureBirths.length} 件`);
  }

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

  // ─── Level 3: DB 差分規模警告 ─────────────────────────────────────────
  const totalDbClients = allClients.length;
  const changeRatio = totalDbClients > 0 ? updates.length / totalDbClients : 0;
  if (changeRatio >= W.CHANGE_RATIO_WARN) {
    warnings.push(
      `⚠️  Level 3: 大規模変更 (DB 全体 ${totalDbClients} 件中 ${updates.length} 件 = ${(changeRatio * 100).toFixed(1)}% が更新対象)`
    );
  }
  // CSV にいるが DB にない (= 新規利用者の予兆)
  const dbInsuredSet = new Set(allClients.map((c) => normInsured(c.insured_number)));
  let csvNewCandidate = 0;
  for (const ins of masterByInsured.keys()) {
    if (!dbInsuredSet.has(ins)) csvNewCandidate++;
  }
  if (csvNewCandidate > 0) {
    warnings.push(
      `ℹ️  Level 3: CSV にあって DB にない 被保番 ${csvNewCandidate} 件 (= 新規利用者候補、本 script は INSERT しないので別途対応)`
    );
  }
  // DB にあるが CSV にない (= サービス終了 or 被保番変更の予兆)
  if (noMatch >= 100) {
    warnings.push(
      `⚠️  Level 3: DB にあって CSV にない clients ${noMatch} 件 (= サービス終了 or 被保番変更の疑い)`
    );
  }

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

  // ─── 警告の総合判定 ──────────────────────────────────────────────────
  if (warnings.length > 0) {
    console.log(`\n=== ⚠️  警告 (${warnings.length} 件) ===`);
    for (const w of warnings) console.log(w);
    console.log();
    const blocking = warnings.filter((w) => w.startsWith("⚠️")).length;
    if (blocking > 0 && EXECUTE && !FORCE) {
      console.error(`🛑 警告が ${blocking} 件あります (⚠️ マーク)。`);
      console.error(`   確認して問題なければ --force-with-warnings を付けて再実行してください。`);
      console.error(`   DRY RUN (--execute 無し) なら警告を見るだけで終了します。`);
      process.exit(2);
    }
  } else {
    console.log(`\n✓ 警告なし。安全に取込可能です。`);
  }

  if (!EXECUTE) {
    console.log(`⏸  DRY RUN. --execute で本番。`);
    return;
  }
  if (warnings.filter((w) => w.startsWith("⚠️")).length > 0 && FORCE) {
    console.log(`⚠️  警告ありで強制実行 (--force-with-warnings)`);
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
