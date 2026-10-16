/**
 * 住宅改修の書類の見本: サンプル利用者 3 名 + 住宅改修案件 3 件 (書類・写真つき) を作る
 *
 *   node migrations/seed_renovation_docs_samples.mjs --photos <写真フォルダ>                 # DRY RUN
 *   node migrations/seed_renovation_docs_samples.mjs --photos <写真フォルダ> --execute       # 作成
 *   node migrations/seed_renovation_docs_samples.mjs --delete                                # 撤去 DRY RUN
 *   node migrations/seed_renovation_docs_samples.mjs --delete --execute                      # 撤去
 *
 * 目的: 書類画面 (見積書・理由書・承諾書・支給申請書・各市の届・写真添付用紙・領収書) の出来ばえ確認 (user 依頼 2026-10-17)。
 * 様式の違う 3 市に 1 名ずつ置く:
 *   市原市   受領委任払い・事前 (事前協議願が出る)        手すり 2 箇所 + 段差解消
 *   木更津市 受領委任払い・事後 (費用の内訳が出る)・所有者は長男 (承諾書が出る)   手すり + 便器の取替え
 *   茂原市   受領委任払い・事前 (受領委任届・委任状が出る)・2 割負担   扉の取替え + 床材の変更
 *
 * マーカー:
 *   clients                         氏名「サンプル 住改…」かつ 被保険者番号 999999000x (clients に memo 列は無い)
 *   renovation_projects.import_marker  fake-renovation-sample-2026-10
 *   documents._sample_marker        fake-renovation-sample-2026-10
 *   被保険者番号は 999999000x (実在しない番号)。氏名は「サンプル」で始める
 * 発行元は法人マスタ (株式会社 ケイ・ティ・サービス) の住所・電話・代表者。口座・登録番号は空 (枠だけ出る)。
 * 写真は Storage renovation-photos/<案件id>/sample-*.jpg。
 * サンプル案件の発行元は本物の案件に引き継がれない (getLatestRenovationIssuer が fake-* を除外)。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const DELETE = args.includes("--delete");
const PHOTOS = args.includes("--photos") ? args[args.indexOf("--photos") + 1] : null;

const MARK = "fake-renovation-sample-2026-10";
const SAMPLE_INSURED = ["9999990001", "9999990002", "9999990003"];
const TENANT = "kt-group";
const OFFICE_ID = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a"; // 介護ショップケア・サポート千葉 (住宅改修の既存案件はすべてここ)
const COMPANY_ID = "6757c4f3-12bb-4e9e-ac4b-f614f26c71ea"; // 株式会社 ケイ・ティ・サービス
const BUCKET = "renovation-photos";

const loadEnv = (p) => existsSync(p) ? Object.fromEntries(
  readFileSync(p, "utf8").split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
) : {};
const env = {
  ...loadEnv(join(APP, "..", "kaigo-app", ".env.local")),
  ...loadEnv(join(APP, "..", "calendar-app", ".env.local")),
  ...loadEnv(join(APP, ".env.local")),
};
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) { console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が見つかりません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(method, path, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: { ...H, "Content-Type": "application/json", ...(method === "GET" ? {} : { Prefer: "return=representation" }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
async function storageList(prefix) {
  const r = await fetch(`${SB_URL}/storage/v1/object/list/${BUCKET}`, {
    method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefix, limit: 1000 }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`storage list: ${r.status} ${JSON.stringify(j)}`);
  return j.map((f) => `${prefix}${f.name}`);
}
async function storageRemove(paths) {
  if (paths.length === 0) return;
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}`, {
    method: "DELETE", headers: { ...H, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: paths }),
  });
  if (!r.ok) throw new Error(`storage remove: ${r.status} ${await r.text()}`);
}
async function storageUpload(path, buf) {
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST", headers: { ...H, "Content-Type": "image/jpeg", "x-upsert": "false" }, body: buf,
  });
  if (!r.ok) throw new Error(`storage upload ${path}: ${r.status} ${await r.text()}`);
}

// ─── 撤去 ───────────────────────────────────────────────
async function findExisting() {
  const projects = await rest("GET", `renovation_projects?select=id,client_name,client_id&import_marker=eq.${MARK}`);
  const clients = await rest("GET", `clients?select=id,name&insured_number=in.(${SAMPLE_INSURED.join(",")})&name=like.${encodeURIComponent("サンプル 住改*")}`);
  const photos = [];
  for (const p of projects) photos.push(...await storageList(`${p.id}/`));
  return { projects, clients, photos };
}

if (DELETE) {
  const ex = await findExisting();
  console.log(`撤去対象: 案件 ${ex.projects.length} 件 / 利用者 ${ex.clients.length} 名 / 写真 ${ex.photos.length} 枚`);
  for (const p of ex.projects) console.log(`  案件 ${p.client_name}`);
  for (const c of ex.clients) console.log(`  利用者 ${c.name}`);
  // サンプル以外の案件がサンプル利用者を参照していないか (消すと client_id が NULL になる)
  if (ex.clients.length) {
    const ref = await rest("GET", `renovation_projects?select=id,import_marker&client_id=in.(${ex.clients.map((c) => c.id).join(",")})`);
    const others = ref.filter((r) => r.import_marker !== MARK);
    if (others.length) { console.error(`✗ サンプル以外の案件 ${others.length} 件がサンプル利用者を参照しています。止めます`); process.exit(2); }
  }
  if (!EXECUTE) { console.log("DRY RUN — --execute で撤去"); process.exit(0); }
  await storageRemove(ex.photos);
  if (ex.projects.length) await rest("DELETE", `renovation_projects?id=in.(${ex.projects.map((p) => p.id).join(",")})&import_marker=eq.${MARK}`);
  if (ex.clients.length) await rest("DELETE", `clients?id=in.(${ex.clients.map((c) => c.id).join(",")})`);
  const after = await findExisting();
  console.log(`撤去後: 案件 ${after.projects.length} / 利用者 ${after.clients.length} / 写真 ${after.photos.length}`);
  process.exit(after.projects.length + after.clients.length + after.photos.length === 0 ? 0 : 1);
}

// ─── 作成 ───────────────────────────────────────────────
if (!PHOTOS || !existsSync(PHOTOS)) { console.error("--photos <フォルダ> を指定してください (s0_before.jpg 〜 s6_after.jpg)"); process.exit(1); }
const ex0 = await findExisting();
if (ex0.projects.length || ex0.clients.length) {
  console.error(`✗ 既にサンプルがあります (案件 ${ex0.projects.length} / 利用者 ${ex0.clients.length})。先に --delete --execute で撤去してください`);
  process.exit(2);
}

const [company] = await rest("GET", `companies?select=name,postal_code,address,phone,fax,representative_name&id=eq.${COMPANY_ID}`);
const [office] = await rest("GET", `offices?select=name&id=eq.${OFFICE_ID}`);
const issuer = {
  company_name: company?.name ?? "", office_name: office?.name ?? "",
  postal_code: company?.postal_code ?? "", address: company?.address ?? "", tel: company?.phone ?? "", fax: company?.fax ?? "",
  invoice_number: "", staff_name: "サンプル担当", representative: company?.representative_name ?? "",
  bank_name: "", bank_branch: "", bank_type: "普通", bank_number: "", bank_holder_kana: "", bank_holder: "",
};

const line = (name, spec, qty, unit, unit_price, basis = "") => ({ name, spec, qty, unit, unit_price, basis });
const handrailLines = (len) => [
  line("アッシュ丸棒", "マツ六 BD-112 φ35", len, "ｍ", 4400, "現地採寸"),
  line("エンドブラケット", "マツ六 BD-08", 2, "個", 2100),
  line("上記施工費", "", 1, "式", 8500),
];
const emptyAct = () => ({ actions: [], action_other: "", difficulty: "", purposes: [], purpose_other: "", policy: "" });
const tools = (on) => Object.fromEntries(on.map(([k, b, a]) => [k, { before: b, after: a }]));

const SAMPLES = [
  {
    client: {
      name: "サンプル 住改一郎", furigana: "ｻﾝﾌﾟﾙ ｼﾞｭｳｶｲｲﾁﾛｳ", birth_date: "1942-05-12", gender: "男",
      postal_code: "299-0111", address: "千葉県市原市姉崎1000-1", phone: "0436-00-0001",
      insurer_number: "122192", insured_number: "9999990001", care_level: "要介護2", benefit_rate: "90",
      certification_start_date: "2026-04-01", certification_end_date: "2027-03-31",
    },
    project: { work_content: "手すり・段差解消", copay_rate: "1割", care_office_text: "サンプル居宅", care_manager_text: "サンプル ケア子" },
    photoIdx: [0, 1, 2],
    groups: [
      { kind: 1, photo_no: "①", place: "廊下", part: "動線", lines: handrailLines(2.4) },
      { kind: 1, photo_no: "②", place: "玄関", part: "上がりかまち", lines: handrailLines(0.9) },
      { kind: 2, photo_no: "③", place: "浴室出入口", part: "段差", lines: [
        line("段差解消スロープ", "シンエイテクノ ダンスロープ H40", 1, "台", 12800, "段差 40mm"),
        line("上記施工費", "", 1, "式", 6000),
      ] },
    ],
    app: { phase: "pre", payment: "juryo", previous_history: "なし", apply_date: "2026-10-20" },
    owner: { is_self: true, name: "", relation: "", address: "", phone: "" },
    reason: {
      body: "脳梗塞後遺症で左半身に軽い麻痺がある。杖歩行は可能だが、ふらつきがあり、方向転換や立ち座りで不安定になる。",
      care: "妻 (78歳) と二人暮らし。妻は腰痛があり身体介助は難しい。長女が週 1 回訪問している。",
      goal: "廊下・玄関・浴室を一人で安全に移動できるようにし、外出や入浴の機会を減らさずに自宅での生活を続けたい。",
      tools: tools([["歩行補助つえ", true, true], ["手すり", false, true], ["入浴補助用具", true, true]]),
      activities: {
        excretion: { ...emptyAct(), actions: ["トイレまでの移動"], difficulty: "夜間にトイレへ行く際、廊下でふらつき壁伝いに歩いている。", purposes: ["転倒等の防止、安全の確保"], policy: "廊下に手すりを付けることで、夜間も安全にトイレまで移動できる。" },
        bathing: { ...emptyAct(), actions: ["浴室出入口の出入（扉の開閉を含む）"], difficulty: "浴室出入口の 40mm の段差でつまずきやすい。", purposes: ["転倒等の防止、安全の確保", "動作の容易性の確保"], policy: "スロープで段差をなくし、すり足でも出入りできるようにする。" },
        going_out: { ...emptyAct(), actions: ["上がりかまちの昇降"], difficulty: "上がりかまちが高く、昇り降りに介助が要る。", purposes: ["できなかったことをできるようにする"], policy: "手すりを付け、一人で昇降できるようにする。" },
        other: emptyAct(),
      },
      works: { "1": ["廊下 動線", "玄関 上がりかまち"], "2": ["浴室出入口 段差"] },
    },
  },
  {
    client: {
      name: "サンプル 住改花子", furigana: "ｻﾝﾌﾟﾙ ｼﾞｭｳｶｲﾊﾅｺ", birth_date: "1938-11-03", gender: "女",
      postal_code: "292-0000", address: "千葉県木更津市中央1-1-1", phone: "0438-00-0002",
      insurer_number: "122069", insured_number: "9999990002", care_level: "要支援2", benefit_rate: "90",
      certification_start_date: "2026-01-01", certification_end_date: "2027-12-31",
    },
    project: { work_content: "トイレ手すり・便器交換", copay_rate: "1割", care_office_text: "サンプル地域包括", care_manager_text: "サンプル 包括子" },
    photoIdx: [3, 4],
    groups: [
      { kind: 1, photo_no: "①", place: "トイレ", part: "便器横", lines: [
        line("L 型手すり", "TOTO EWT24AR", 1, "本", 18500),
        line("上記施工費", "", 1, "式", 9000),
      ] },
      { kind: 5, photo_no: "②", place: "トイレ", part: "便器", lines: [
        line("洋式便器", "TOTO ピュアレスト QR", 1, "台", 68000),
        line("和式便器撤去・処分費", "", 1, "式", 15000),
        line("床補修・設置工事", "", 1, "式", 32000),
      ] },
    ],
    app: { phase: "post", payment: "juryo", started_date: "2026-09-10", completed_date: "2026-09-12", previous_history: "", apply_date: "2026-09-20" },
    owner: { is_self: false, name: "サンプル 長男", relation: "長男", address: "千葉県木更津市中央1-1-1", phone: "0438-00-0003" },
    reason: {
      body: "両膝の変形性膝関節症で、しゃがむ動作と立ち上がりに強い痛みがある。和式便器の使用が困難になってきた。",
      care: "長男家族と同居。日中は独居で、トイレは自分で行う必要がある。",
      goal: "日中一人でもトイレを使えるようにし、失禁の不安を減らしたい。",
      tools: tools([["手すり", false, true], ["腰掛便座", true, false]]),
      activities: {
        excretion: { ...emptyAct(), actions: ["便器からの立ち座り（移乗を含む）", "排泄時の姿勢保持"], difficulty: "和式便器でしゃがめず、据え置きの腰掛便座も不安定。", purposes: ["できなかったことをできるようにする", "利用者の精神的負担や不安の軽減"], policy: "洋式便器に替え、横に L 型手すりを付けて立ち座りを支える。" },
        bathing: emptyAct(), going_out: emptyAct(), other: emptyAct(),
      },
      works: { "1": ["トイレ 便器横"], "5": ["トイレ 便器"] },
    },
  },
  {
    client: {
      name: "サンプル 住改次郎", furigana: "ｻﾝﾌﾟﾙ ｼﾞｭｳｶｲｼﾞﾛｳ", birth_date: "1945-02-20", gender: "男",
      postal_code: "297-0000", address: "千葉県茂原市茂原100", phone: "0475-00-0004",
      insurer_number: "122101", insured_number: "9999990003", care_level: "要介護3", benefit_rate: "80",
      certification_start_date: "2026-06-01", certification_end_date: "2028-05-31",
    },
    project: { work_content: "引き戸・床材", copay_rate: "2割", care_office_text: "サンプル居宅", care_manager_text: "サンプル ケア子" },
    photoIdx: [5, 6],
    groups: [
      { kind: 4, photo_no: "①", place: "居室", part: "出入口", lines: [
        line("引き戸 (上吊り)", "パナソニック ベリティス 標準", 1, "式", 98000),
        line("開き戸撤去・枠加工", "", 1, "式", 28000),
      ] },
      { kind: 3, photo_no: "②", place: "居室", part: "床", lines: [
        line("クッションフロア (滑り止め)", "サンゲツ 店舗用 1.8mm", 9.7, "㎡", 4200, "6 畳"),
        line("既存畳撤去・下地調整", "", 1, "式", 22000),
      ] },
    ],
    app: { phase: "pre", payment: "juryo", previous_history: "", apply_date: "2026-10-22" },
    owner: { is_self: true, name: "", relation: "", address: "", phone: "" },
    reason: {
      body: "パーキンソン病で小刻み歩行・すくみ足がある。開き戸の開閉で後ろに下がる動作があり、転倒歴が 2 回ある。",
      care: "妻と二人暮らし。車いすを使い始めたが、畳の上では動かしにくい。",
      goal: "居室の出入りと室内の移動を車いすでも自力でできるようにしたい。",
      tools: tools([["車いす", true, true], ["特殊寝台", true, true]]),
      activities: {
        excretion: emptyAct(), bathing: emptyAct(), going_out: emptyAct(),
        other: { ...emptyAct(), action_other: "居室の出入り・室内の移動", difficulty: "開き戸の開閉で後退が必要で転倒の危険がある。畳では車いすが進みにくい。", purposes: ["転倒等の防止、安全の確保", "介護者の負担の軽減"], policy: "引き戸と滑りにくい床材に替え、車いすで出入り・移動できるようにする。" },
      },
      works: { "4": ["居室 出入口"], "3": ["居室 床"] },
    },
  },
];

function buildDocs(s, photoRefs) {
  return {
    version: 1,
    _sample_marker: MARK,
    issuer,
    estimate: {
      issue_date: "2026-10-17", title: "住宅改修工事", site: s.client.address, payment_terms: "完成後現金", validity: "次回御見積まで",
      start_date: s.app.phase === "pre" ? "2026-11-05" : s.app.started_date, overhead_rate: 0.1, tax_rate: 0.1,
      groups: s.groups.map((g, i) => ({ ...g, photos: photoRefs[i] ?? { before: null, after: null } })),
    },
    owner: s.owner,
    reason: {
      site_visit_date: "2026-10-10", created_date: "2026-10-15", creator_office: s.project.care_office_text,
      creator_qualification: "", creator_name: s.project.care_manager_text, creator_phone: "0436-00-9999",
      body_status: s.reason.body, care_status: s.reason.care, goal: s.reason.goal,
      tools: s.reason.tools,
      tools_other: [{ name: "", before: false, after: false }, { name: "", before: false, after: false }, { name: "", before: false, after: false }],
      activities: s.reason.activities, works: s.reason.works,
      cm_consent_office: "", cm_consent_name: "", cm_consent_date: null,
    },
    application: {
      phase: s.app.phase, payment: s.app.payment, started_date: s.app.started_date ?? null, completed_date: s.app.completed_date ?? null,
      change_reason: "", previous_history: s.app.previous_history ?? "", apply_date: s.app.apply_date, addressee: "", proxy: true,
    },
    receipt: { amount: null, date: s.app.completed_date ?? null, note: "住宅改修工事代金として" },
  };
}

console.log(`作成予定: 利用者 ${SAMPLES.length} 名 / 案件 ${SAMPLES.length} 件 / 写真 ${SAMPLES.reduce((n, s) => n + s.photoIdx.length * 2, 0)} 枚`);
for (const s of SAMPLES) console.log(`  ${s.client.name}  ${s.client.address}  ${s.project.copay_rate}  ${s.app.phase === "pre" ? "事前" : "事後"}・受領委任  改修箇所 ${s.groups.length}`);
console.log(`  発行元: ${issuer.company_name} ${issuer.office_name} / ${issuer.address} / ${issuer.tel} / 代表 ${issuer.representative}`);
for (const s of SAMPLES) for (const i of s.photoIdx) for (const side of ["before", "after"]) {
  if (!existsSync(join(PHOTOS, `s${i}_${side}.jpg`))) { console.error(`✗ 写真がありません: s${i}_${side}.jpg`); process.exit(1); }
}
if (!EXECUTE) { console.log("\nDRY RUN — --execute で作成"); process.exit(0); }

const created = { clients: [], projects: [], photos: [] };
try {
  for (const s of SAMPLES) {
    const [c] = await rest("POST", "clients?select=id,name", [{
      tenant_id: TENANT, ...s.client, is_facility: false, is_provisional: false,
    }]);
    created.clients.push(c.id);
    const [p] = await rest("POST", "renovation_projects?select=id", [{
      tenant_id: TENANT, office_id: OFFICE_ID, fiscal_year: 2026, client_id: c.id, client_name: s.client.name,
      client_address: s.client.address, care_office_text: s.project.care_office_text, care_manager_text: s.project.care_manager_text,
      staff_name: "サンプル担当", work_content: s.project.work_content, contractor: null, copay_rate: s.project.copay_rate,
      notes: "書類の見本 (サンプル)", cost_total: null, sales_total: null, status: "in_progress", import_marker: MARK,
    }]);
    created.projects.push(p.id);
    const steps = [
      ["visit", "2026-10-10", "2026-10-10", "done"], ["quote_created", "2026-10-14", "2026-10-15", "done"],
      ["quote_presented", "2026-10-17", null, "pending"], ["pre_application", "2026-10-24", null, "pending"],
      ["construction", "2026-11-05", null, "pending"], ["order_sheet", "2026-11-08", null, "pending"],
      ["collection", "2026-11-12", null, "pending"], ["office_submit", "2026-11-19", null, "pending"],
    ].map(([step_key, planned_date, actual_date, status]) => ({ project_id: p.id, step_key, planned_date, actual_date, status, note: null }));
    await rest("POST", "renovation_project_steps", steps);
    // 写真
    const photoRefs = [];
    for (const [gi, idx] of s.photoIdx.entries()) {
      const ref = {};
      for (const side of ["before", "after"]) {
        const path = `${p.id}/sample-${gi}-${side}.jpg`;
        await storageUpload(path, readFileSync(join(PHOTOS, `s${idx}_${side}.jpg`)));
        created.photos.push(path);
        ref[side] = { path, taken_date: side === "before" ? "2026-10-10" : (s.app.completed_date ?? null) };
      }
      photoRefs[gi] = ref;
    }
    const docs = buildDocs(s, photoRefs);
    const upd = await rest("PATCH", `renovation_projects?id=eq.${p.id}&select=id`, { documents: docs });
    if (upd.length !== 1) throw new Error(`書類データの保存が ${upd.length} 件`);
    console.log(`✓ ${s.client.name}  案件 ${p.id}`);
  }
} catch (e) {
  console.error("✗ 作成に失敗:", e.message, "— 作った分を戻します");
  await storageRemove(created.photos).catch((err) => console.error("  写真の取り消しに失敗:", err.message));
  if (created.projects.length) await rest("DELETE", `renovation_projects?id=in.(${created.projects.join(",")})`).catch((err) => console.error("  案件の取り消しに失敗:", err.message));
  if (created.clients.length) await rest("DELETE", `clients?id=in.(${created.clients.join(",")})`).catch((err) => console.error("  利用者の取り消しに失敗:", err.message));
  process.exit(1);
}
const check = await findExisting();
console.log(`作成後: 案件 ${check.projects.length} / 利用者 ${check.clients.length} / 写真 ${check.photos.length}`);
