// link_payroll_members.mjs
// 既存 payroll_employees を members に氏名×事業所で突合して member_id を backfill する。
//
// 前提: payroll_employees_member_link.sql 適用済 (member_id 列がある)
//
// 突合ロジック:
//   payroll_employees.office_id → payroll_offices.office_id (= 共通 offices.id)
//   その共通 office に member_offices で紐づく在籍 members のうち、
//   氏名 (空白除去・全角英数正規化) が一致する 1 名に紐付ける。
//   - 同名複数 / 一致なし → skip (warning 出力、手動対応)
//   - 既に member_id 済みの行 → skip
//
// 実行:
//   DRY:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node apps/order-app/migrations/link_payroll_members.mjs
//   本番: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node apps/order-app/migrations/link_payroll_members.mjs --execute

import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) {
  console.error("env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, KEY);

/** 氏名正規化: 空白 (全半角) 除去 + 全角英数字→半角 */
function norm(name) {
  return (name ?? "")
    .replace(/[\s　]/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
}

/** PostgREST の 1000 行 limit を跨いで全件取得 */
async function fetchAll(table, select, filter = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(
      sb.from(table).select(select).range(from, from + 999),
    );
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const [payrollOffices, employees, memberOffices, members] = await Promise.all([
  fetchAll("payroll_offices", "id, office_id, short_name"),
  fetchAll("payroll_employees", "id, name, office_id, member_id, employment_status"),
  fetchAll("member_offices", "member_id, office_id, is_primary"),
  fetchAll("members", "id, name, status, deleted_at"),
]);

const commonByPayrollOffice = new Map(payrollOffices.map((p) => [p.id, p.office_id]));
const officeLabel = new Map(payrollOffices.map((p) => [p.id, p.short_name || p.id.slice(0, 8)]));
const memberById = new Map(members.map((m) => [m.id, m]));

// 共通 office → { 正規化名 → member_id[] } (在籍 member のみ)
const officeNameIndex = new Map();
for (const link of memberOffices) {
  const m = memberById.get(link.member_id);
  if (!m || m.deleted_at || m.status !== "active") continue;
  if (!officeNameIndex.has(link.office_id)) officeNameIndex.set(link.office_id, new Map());
  const idx = officeNameIndex.get(link.office_id);
  const key = norm(m.name);
  if (!idx.has(key)) idx.set(key, []);
  if (!idx.get(key).includes(m.id)) idx.get(key).push(m.id);
}

let already = 0;
const updates = []; // { id, member_id, label }
const ambiguous = [];
const unmatched = [];

for (const e of employees) {
  if (e.member_id) {
    already++;
    continue;
  }
  const commonOffice = commonByPayrollOffice.get(e.office_id);
  const idx = commonOffice ? officeNameIndex.get(commonOffice) : null;
  const hits = idx?.get(norm(e.name)) ?? [];
  const label = `${e.name} @ ${officeLabel.get(e.office_id) ?? "?"}`;
  if (hits.length === 1) {
    updates.push({ id: e.id, member_id: hits[0], label });
  } else if (hits.length > 1) {
    ambiguous.push(label);
  } else {
    unmatched.push(`${label}${e.employment_status === "退職者" ? " (退職者)" : ""}`);
  }
}

console.log(`payroll_employees 総数 : ${employees.length}`);
console.log(`  既に紐付け済み       : ${already}`);
console.log(`  紐付け対象 (一意一致) : ${updates.length}`);
console.log(`  同名複数で保留       : ${ambiguous.length}`);
console.log(`  members に一致なし   : ${unmatched.length} (擬似エントリ・退職者・表記ゆれ)`);
if (ambiguous.length) {
  console.log("\n-- 同名複数 (手動対応) --");
  for (const a of ambiguous) console.log("  " + a);
}
if (unmatched.length) {
  console.log("\n-- 一致なし (紐付けせず残す) --");
  for (const u of unmatched.slice(0, 40)) console.log("  " + u);
  if (unmatched.length > 40) console.log(`  … 他 ${unmatched.length - 40} 件`);
}

if (!EXECUTE) {
  console.log("\nDRY RUN (書込なし)。実行するには --execute を付ける");
  process.exit(0);
}

let done = 0;
for (const u of updates) {
  const { error } = await sb
    .from("payroll_employees")
    .update({ member_id: u.member_id })
    .eq("id", u.id)
    .is("member_id", null);
  if (error) {
    console.error(`UPDATE 失敗: ${u.label}: ${error.message}`);
    process.exit(2);
  }
  done++;
}
console.log(`\n✓ ${done} 件 紐付け完了`);

// 件数確認 (silent failure 防止)
const { count, error: cntErr } = await sb
  .from("payroll_employees")
  .select("id", { count: "exact", head: true })
  .not("member_id", "is", null);
if (cntErr) {
  console.error(`検証 count 失敗: ${cntErr.message}`);
  process.exit(2);
}
console.log(`検証: member_id 付き行 = ${count} 件 (期待 ${already + done})`);
