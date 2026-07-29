// create_members_for_unlinked_payroll.mjs
// link_payroll_members.mjs の後始末: members 側に存在しない「在籍」payroll_employees の
// ために members 行 + member_offices (主所属) を作成して紐付ける。
//
// 対象: employment_status ≠ 退職者 かつ member_id IS NULL の payroll_employees のうち、
//       所属 office の在籍 members に同名が居ない人 (= members 未整備の実職員)。
//       2026-07-29 時点で 34 名 (訪問介護の後入社 + 袖ヶ浦ムツミ居宅の全員)。
//
// members には UNIQUE (tenant_id, name) がある。同名 member が既に居る場合は
// 新規作成できないので、状態に応じて処理を分ける:
//   - 同名 1 件 (inactive・未削除)  → 在籍化 (status=active) + 紐付け + 所属追加
//     (payroll 側が 在籍 なので、この一括整備に限り payroll の在籍を正とみなす)
//   - 同名 1 件 (active)            → 紐付け + 所属追加のみ (別 office の兼務者)
//   - 同名 1 件 (soft-delete 済み)  → 保留 (delete_reason があるので手動確認)
//   - 同名 2 件以上                 → 保留 (同名別人の可能性)
//   - 同名 0 件                     → 新規作成 + 所属 (主) + 紐付け
//   - 退職者の payroll 行は対象外 (歴史データは payroll 単独のまま)
//
// 実行:
//   DRY:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node apps/order-app/migrations/create_members_for_unlinked_payroll.mjs
//   本番: 同上 + --execute

import { createClient } from "@supabase/supabase-js";

const SB_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) {
  console.error("env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const EXECUTE = process.argv.includes("--execute");
const sb = createClient(SB_URL, KEY);

function norm(name) {
  return (name ?? "")
    .replace(/[\s　]/g, "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0));
}

async function fetchAll(table, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).range(from, from + 999);
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const [payrollOffices, employees, memberOffices, members, offices] = await Promise.all([
  fetchAll("payroll_offices", "id, office_id, short_name"),
  fetchAll("payroll_employees", "id, name, office_id, member_id, employment_status"),
  fetchAll("member_offices", "member_id, office_id"),
  fetchAll("members", "id, name, status, deleted_at"),
  fetchAll("offices", "id, name"),
]);

const commonByPayrollOffice = new Map(payrollOffices.map((p) => [p.id, p.office_id]));
const officeName = new Map(offices.map((o) => [o.id, o.name]));
const memberById = new Map(members.map((m) => [m.id, m]));

// office 内の在籍 member 名寄せ
const officeIdx = new Map();
for (const l of memberOffices) {
  const m = memberById.get(l.member_id);
  if (!m || m.deleted_at || m.status !== "active") continue;
  if (!officeIdx.has(l.office_id)) officeIdx.set(l.office_id, new Map());
  const idx = officeIdx.get(l.office_id);
  const k = norm(m.name);
  if (!idx.has(k)) idx.set(k, []);
  if (!idx.get(k).includes(m.id)) idx.get(k).push(m.id);
}
// 全体の member 名寄せ (状態不問。UNIQUE (tenant,name) 対応のため全状態を見る)
const globalIdx = new Map();
for (const m of members) {
  const k = norm(m.name);
  if (!globalIdx.has(k)) globalIdx.set(k, []);
  globalIdx.get(k).push(m);
}
// member → 既存の所属 office 集合
const officesOfMember = new Map();
for (const l of memberOffices) {
  if (!officesOfMember.has(l.member_id)) officesOfMember.set(l.member_id, new Set());
  officesOfMember.get(l.member_id).add(l.office_id);
}

const toCreate = [];   // 新規作成: { employee_id, name, common_office_id, office_label }
const toRevive = [];   // inactive を在籍化 + 紐付け: { employee_id, member, common_office_id, office_label, needLink }
const toLinkOnly = []; // active 既存に紐付けのみ: 同上
const held = [];       // 保留: { office_label, reason }

for (const e of employees) {
  if (e.member_id || e.employment_status === "退職者") continue;
  const commonOffice = commonByPayrollOffice.get(e.office_id);
  if (!commonOffice) continue;
  const activeHits = officeIdx.get(commonOffice)?.get(norm(e.name)) ?? [];
  if (activeHits.length > 0) continue; // 同 office の在籍に居る (link script の担当分)
  const label = `${e.name} @ ${officeName.get(commonOffice) ?? commonOffice.slice(0, 8)}`;
  const hits = globalIdx.get(norm(e.name)) ?? [];
  if (hits.length === 0) {
    toCreate.push({ employee_id: e.id, name: e.name, common_office_id: commonOffice, office_label: label });
  } else if (hits.length > 1) {
    held.push({ office_label: label, reason: `同名 member が ${hits.length} 件` });
  } else {
    const m = hits[0];
    const needLink = !officesOfMember.get(m.id)?.has(commonOffice);
    if (m.deleted_at) {
      held.push({ office_label: label, reason: "同名 member が soft-delete 済み" });
    } else if (m.status !== "active") {
      toRevive.push({ employee_id: e.id, member: m, common_office_id: commonOffice, office_label: label, needLink });
    } else {
      toLinkOnly.push({ employee_id: e.id, member: m, common_office_id: commonOffice, office_label: label, needLink });
    }
  }
}

console.log(`新規作成 + 紐付け           : ${toCreate.length} 名`);
for (const t of toCreate) console.log("  " + t.office_label);
console.log(`\ninactive を在籍化 + 紐付け  : ${toRevive.length} 名`);
for (const t of toRevive) console.log("  " + t.office_label + (t.needLink ? " (所属追加あり)" : ""));
console.log(`\n既存 active に紐付けのみ    : ${toLinkOnly.length} 名`);
for (const t of toLinkOnly) console.log("  " + t.office_label + (t.needLink ? " (所属追加あり)" : ""));
if (held.length) {
  console.log(`\n-- 保留 (手動確認): ${held.length} 名 --`);
  for (const h of held) console.log(`  ${h.office_label}: ${h.reason}`);
}

if (!EXECUTE) {
  console.log("\nDRY RUN (書込なし)。実行するには --execute を付ける");
  process.exit(0);
}

async function ensureOfficeLink(memberId, officeId, isPrimary, label) {
  const { error } = await sb
    .from("member_offices")
    .insert({ member_id: memberId, office_id: officeId, is_primary: isPrimary });
  if (error) {
    console.error(`member_offices INSERT 失敗: ${label}: ${error.message}`);
    process.exit(2);
  }
}

async function linkPayroll(employeeId, memberId, label) {
  const { error } = await sb
    .from("payroll_employees")
    .update({ member_id: memberId })
    .eq("id", employeeId)
    .is("member_id", null);
  if (error) {
    console.error(`payroll_employees UPDATE 失敗: ${label}: ${error.message}`);
    process.exit(2);
  }
}

let created = 0, revived = 0, linked = 0;
for (const t of toCreate) {
  const { data: row, error } = await sb
    .from("members")
    .insert({ tenant_id: "kt-group", name: t.name, status: "active" })
    .select("id")
    .single();
  if (error) {
    console.error(`members INSERT 失敗: ${t.office_label}: ${error.message}`);
    process.exit(2);
  }
  await ensureOfficeLink(row.id, t.common_office_id, true, t.office_label);
  await linkPayroll(t.employee_id, row.id, t.office_label);
  created++;
}
for (const t of toRevive) {
  const { error } = await sb.from("members").update({ status: "active" }).eq("id", t.member.id);
  if (error) {
    console.error(`members 在籍化 失敗: ${t.office_label}: ${error.message}`);
    process.exit(2);
  }
  if (t.needLink) await ensureOfficeLink(t.member.id, t.common_office_id, true, t.office_label);
  await linkPayroll(t.employee_id, t.member.id, t.office_label);
  revived++;
}
for (const t of toLinkOnly) {
  // 既に別 office で在籍している人 (兼務)。所属だけ追加、primary は動かさない
  if (t.needLink) await ensureOfficeLink(t.member.id, t.common_office_id, false, t.office_label);
  await linkPayroll(t.employee_id, t.member.id, t.office_label);
  linked++;
}
console.log(`\n✓ 新規 ${created} / 在籍化 ${revived} / 紐付けのみ ${linked} 完了`);

// 件数確認
const { count, error: cntErr } = await sb
  .from("payroll_employees")
  .select("id", { count: "exact", head: true })
  .not("member_id", "is", null);
if (cntErr) {
  console.error(`検証 count 失敗: ${cntErr.message}`);
  process.exit(2);
}
console.log(`検証: member_id 付き payroll 行 = ${count} 件`);
