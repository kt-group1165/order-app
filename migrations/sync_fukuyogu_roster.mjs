// sync_fukuyogu_roster.mjs
// 福祉用具部門 + 統括営業本部の名簿 (氏名/フリガナ/性別/職種) を DB に反映する。
//
// 2026-07-29 user 提供の名簿が正。やること:
//   1. members に居ない人を新規作成 (氏名/フリガナ/性別/職種、主所属の member_offices も)
//   2. 既に居る人は フリガナ/性別/職種 を更新 (氏名は一致しているので触らない)
//   3. payroll_employees に居ない人を作成し、members と紐付け (出勤簿の対象になる)
//   4. 職種「事務」の人に is_office_worker=true を設定 (出勤簿に出張距離の列が出る)
//
// 名簿に無い在籍者は触らない (退職・異動の判断は人がやる)。
//
// 実行:
//   DRY:  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node migrations/sync_fukuyogu_roster.mjs
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

const norm = (n) => (n ?? "").replace(/[\s　]/g, "");

// [氏名, フリガナ, 性別, 職種]
const ROSTER = {
  "介護ショップケア・サポート千葉": [
    ["鎗田 秀記", "ﾔﾘﾀ ﾋﾃﾞﾉﾘ", "男性", "所長"],
    ["鈴木 謙", "ｽｽﾞｷ ｹﾝ", "男性", "副所長"],
    ["堀口 理奈", "ﾎﾘｸﾞﾁ ﾘﾅ", "女性", "事務"],
    ["豊藏 梨絵", "ﾄﾖｸﾗ ﾘｴ", "女性", "選定"],
    ["阿部 由美子", "ｱﾍﾞ ﾕﾐｺ", "女性", "外回り"],
    ["川島 大樹", "ｶﾜｼﾏ ﾋﾛｷ", "男性", "外回り"],
    ["綿貫 徳勇", "ﾜﾀﾇｷ ｱﾂｵ", "男性", "外回り"],
    ["清水 博美", "ｼﾐｽﾞ ﾋﾛﾐ", "女性", "営業"],
    ["信田 龍一", "ｼﾀﾞ ﾘｭｳｲﾁ", "男性", "選定"],
    ["小林 葵亜羅", "ｺﾊﾞﾔｼ ｷｱﾗ", "女性", "事務"],
    ["田村 裕子", "ﾀﾑﾗ ﾋﾛｺ", "女性", "事務"],
    ["髙橋 晴美", "ﾀｶﾊｼ ﾊﾙﾐ", "女性", "モニタリング"],
    ["室橋 香穂", "ﾑﾛﾊｼ ｶﾎ", "女性", "事務"],
    ["仲村 美香", "ﾅｶﾑﾗ ﾐｶ", "女性", "外回り"],
  ],
  "千葉ムツミ福祉用具高品": [
    ["前﨑 隆宏", "ﾏｴｻﾞｷ ﾀｶﾋﾛ", "男性", "管理者"],
    ["山口 敬子", "ﾔﾏｸﾞﾁ ｹｲｺ", "女性", "事務"],
    ["木村 維江", "ｷﾑﾗ ﾏｻｴ", "女性", "外回り"],
    ["松野 透", "ﾏﾂﾉ ﾄｵﾙ", "女性", "外回り"],
    ["木暮 美由紀", "ｺｸﾞﾚ ﾐﾕｷ", "女性", "事務"],
    ["大賀 綾華", "ｵｵｶﾞ ｱﾔｶ", "女性", "外回り"],
    ["西村 友里", "ﾆｼﾑﾗ ﾕﾘ", "女性", "事務"],
    ["信 菜津美", "ｼﾝ ﾅﾂﾐ", "女性", "事務"],
  ],
  "リンクス福祉用具": [
    ["友野 利治", "ﾄﾓﾉ ﾄｼﾊﾙ", "男性", "管理者"],
    ["文岡 豊", "ﾌﾐｵｶ ﾕﾀｶ", "男性", "外回り"],
    ["鈴木 爽太", "ｽｽﾞｷ ｿｳﾀ", "男性", "外回り"],
    ["森川 佳代子", "ﾓﾘｶﾜ ｶﾖｺ", "女性", "事務"],
  ],
  "Ｈａｎａムツミ福祉用具": [
    ["米倉 久仁子", "ﾖﾈｸﾗ ｸﾆｺ", "女性", "所長"],
    ["今野 孝宏", "ｺﾝﾉ ﾀｶﾋﾛ", "男性", "選定"],
    ["小岩井 恵子", "ｺｲﾜｲ ｹｲｺ", "女性", "外回り"],
    ["黒田 佳菜乃", "ｸﾛﾀﾞ ｶﾅﾉ", "女性", "事務"],
    ["安藤 広明", "ｱﾝﾄﾞｳ ﾋﾛｱｷ", "男性", "外回り"],
    ["内竹 綾乃", "ｳﾁﾀｹ ｱﾔﾉ", "女性", "事務"],
    ["増田 裕一", "ﾏｽﾀﾞ ﾕｳｲﾁ", "男性", "外回り"],
  ],
  "Ｈａｎａ福祉用具花見川": [
    ["中山 健司", "ﾅｶﾔﾏ ｹﾝｼﾞ", "男性", "管理者"],
    ["佐野 慎", "ｻﾉ ﾏｺﾄ", "男性", "管理者候補"],
  ],
  "統括営業本部": [
    ["鶴岡 隆幸", "ﾂﾙｵｶ ﾀｶﾕｷ", "男性", "営業職リーダー"],
    ["澤田 拓馬", "ｻﾜﾀﾞ ﾀｸﾏ", "男性", "営業職リーダー"],
    ["安川 裕二", "ﾔｽｶﾜ ﾕｳｼﾞ", "男性", "営業職"],
    ["三枝 裕紀子", "ｻｴｸﾞｻ ﾕｷｺ", "女性", "営業職"],
    ["阿部 竜生", "ｱﾍﾞ ﾘｭｳｾｲ", "男性", "営業職"],
    ["村上 雄汰", "ﾑﾗｶﾐ ﾕｳﾀ", "男性", "営業職"],
    ["前田 さくら", "ﾏｴﾀﾞ ｻｸﾗ", "女性", "営業職"],
    ["鉄炮塚 奈知子", "ﾃｯﾎﾟｳﾂﾞｶ ﾅﾁｺ", "女性", "事務"],
  ],
};

async function fetchAll(table, select, filter = (q) => q) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filter(sb.from(table).select(select).range(from, from + 999));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

// ── 事業所 ──
const offices = await fetchAll("offices", "id, name", (q) =>
  q.or(
    "and(tenant_id.eq.kt-group,service_type.eq.福祉用具),and(service_type.eq.本社,or(tenant_id.eq.kt-group,tenant_id.eq.sales-hq))",
  ),
);
const payrollOffices = await fetchAll("payroll_offices", "id, office_id", (q) =>
  q.in("office_id", offices.map((o) => o.id)),
);
const officeByName = new Map(offices.map((o) => [o.name, o]));
const payrollByCommon = new Map(payrollOffices.map((p) => [p.office_id, p.id]));

const allMembers = await fetchAll("members", "id, name, status, deleted_at, furigana, role");
const membersByName = new Map();
for (const m of allMembers) {
  if (m.deleted_at) continue;
  membersByName.set(norm(m.name), m);
}

const plan = { memberCreate: [], memberUpdate: [], empCreate: [], officeWorker: [], skip: [] };

for (const [officeName, list] of Object.entries(ROSTER)) {
  const office = officeByName.get(officeName);
  const payrollOfficeId = office ? payrollByCommon.get(office.id) : null;
  if (!office || !payrollOfficeId) {
    console.error(`✗ 事業所が見つからない: ${officeName}`);
    process.exit(1);
  }
  const emps = await fetchAll(
    "payroll_employees",
    "id, name, member_id, is_office_worker",
    (q) => q.eq("office_id", payrollOfficeId).neq("employment_status", "退職者"),
  );
  const empByName = new Map(emps.map((e) => [norm(e.name), e]));

  for (const [name, furigana, gender, role] of list) {
    const key = norm(name);
    const member = membersByName.get(key);
    const emp = empByName.get(key);
    const ctx = { name, furigana, gender, role, officeName, office, payrollOfficeId, member, emp };
    if (!member) plan.memberCreate.push(ctx);
    else if (member.furigana !== furigana || member.role !== role) plan.memberUpdate.push(ctx);
    if (!emp) plan.empCreate.push(ctx);
    if (role === "事務" && emp && emp.is_office_worker !== true) plan.officeWorker.push(ctx);
    if (member && emp && role !== "事務" && emp.is_office_worker === true) plan.skip.push(ctx);
  }
}

console.log(`members 新規作成       : ${plan.memberCreate.length}`);
for (const c of plan.memberCreate) console.log(`  ${c.name} (${c.role}) @ ${c.officeName}`);
console.log(`\nmembers 更新 (ﾌﾘｶﾞﾅ/職種): ${plan.memberUpdate.length}`);
console.log(`\npayroll_employees 作成 : ${plan.empCreate.length}`);
for (const c of plan.empCreate) console.log(`  ${c.name} (${c.role}) @ ${c.officeName}`);
console.log(`\n事務員フラグ ON        : ${plan.officeWorker.length}`);
for (const c of plan.officeWorker) console.log(`  ${c.name} @ ${c.officeName}`);
if (plan.skip.length) {
  console.log(`\n事務員フラグ OFF にすべき (職種が事務でない): ${plan.skip.length}`);
  for (const c of plan.skip) console.log(`  ${c.name} (${c.role})`);
}

if (!EXECUTE) {
  console.log("\nDRY RUN (書込なし)。実行するには --execute");
  process.exit(0);
}

// ── 1. members 作成 ──
for (const c of plan.memberCreate) {
  const { data, error } = await sb
    .from("members")
    .insert({
      tenant_id: "kt-group",
      name: c.name,
      furigana: c.furigana,
      gender: c.gender,
      role: c.role,
      status: "active",
    })
    .select("id")
    .single();
  if (error) {
    console.error(`members INSERT 失敗 ${c.name}: ${error.message}`);
    process.exit(2);
  }
  c.member = { id: data.id };
  membersByName.set(norm(c.name), c.member);
  const { error: loErr } = await sb
    .from("member_offices")
    .insert({ member_id: data.id, office_id: c.office.id, is_primary: true });
  if (loErr) {
    console.error(`member_offices INSERT 失敗 ${c.name}: ${loErr.message}`);
    process.exit(2);
  }
}
console.log(`✓ members 作成 ${plan.memberCreate.length}`);

// ── 2. members 更新 ──
for (const c of plan.memberUpdate) {
  const { error } = await sb
    .from("members")
    .update({ furigana: c.furigana, gender: c.gender, role: c.role })
    .eq("id", c.member.id);
  if (error) {
    console.error(`members UPDATE 失敗 ${c.name}: ${error.message}`);
    process.exit(2);
  }
}
// 既存 member の性別も埋める (更新対象外でも gender が空なら入れる)
for (const [officeName, list] of Object.entries(ROSTER)) {
  for (const [name, furigana, gender] of list) {
    const m = membersByName.get(norm(name));
    if (!m?.id) continue;
    await sb.from("members").update({ gender, furigana }).eq("id", m.id).is("gender", null);
  }
}
console.log(`✓ members 更新 ${plan.memberUpdate.length}`);

// ── 3. payroll_employees 作成 (member と紐付け) ──
for (const c of plan.empCreate) {
  const member = c.member ?? membersByName.get(norm(c.name));
  const { error } = await sb.from("payroll_employees").insert({
    employee_number: `M-${(member?.id ?? "").slice(0, 8) || Date.now()}`,
    name: c.name,
    office_id: c.payrollOfficeId,
    employment_status: "在職者",
    member_id: member?.id ?? null,
    is_office_worker: c.role === "事務",
  });
  if (error) {
    console.error(`payroll_employees INSERT 失敗 ${c.name}: ${error.message}`);
    process.exit(2);
  }
}
console.log(`✓ payroll_employees 作成 ${plan.empCreate.length}`);

// ── 4. 事務員フラグ ──
for (const c of plan.officeWorker) {
  const { error } = await sb
    .from("payroll_employees")
    .update({ is_office_worker: true })
    .eq("id", c.emp.id);
  if (error) {
    console.error(`is_office_worker 更新失敗 ${c.name}: ${error.message}`);
    process.exit(2);
  }
}
for (const c of plan.skip) {
  const { error } = await sb
    .from("payroll_employees")
    .update({ is_office_worker: false })
    .eq("id", c.emp.id);
  if (error) {
    console.error(`is_office_worker 解除失敗 ${c.name}: ${error.message}`);
    process.exit(2);
  }
}
console.log(`✓ 事務員フラグ ON ${plan.officeWorker.length} / OFF ${plan.skip.length}`);
console.log("\n完了");
