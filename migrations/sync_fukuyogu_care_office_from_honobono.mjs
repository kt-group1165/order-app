/**
 * 福祉用具 (ケアサポ) の利用者の「担当居宅介護支援事業所」を ほのぼの福祉用具の実伝送に合わせる
 *
 *   node migrations/sync_fukuyogu_care_office_from_honobono.mjs                       # DRY RUN
 *   node migrations/sync_fukuyogu_care_office_from_honobono.mjs --execute             # 本番 (★ user 確認後)
 *   node migrations/sync_fukuyogu_care_office_from_honobono.mjs --revert <batch_id>   # 取り消し DRY RUN
 *   node migrations/sync_fukuyogu_care_office_from_honobono.mjs --revert <batch_id> --execute
 *
 *   --kk <KK*.CSV>        既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV (ほのぼのの実伝送 = 正)
 *   --csv <KDS0031>       既定 = 同フォルダの KDS0031_明細書明細付_処理R8-09.CSV (照合用。事業所番号・計画作成区分の文字)
 *   --kaigo-csv <CSV>     既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109/介護保険_全件_保険と認定.CSV
 *                        (支援事業所（正式名称）= care_offices に無い番号の名前の第一候補)
 *   --db-cache <json>     DRY RUN で使う DB スナップショット (無ければ 1 回だけ読んで保存)。既定 = OS の一時フォルダ。
 *                        scripts/_honobono-sync-core.mts の loadSnapshot が作ったファイル (clients/ins/careOffices/offices を含む) も読める
 *   --refresh             DRY RUN でもスナップショットを読み直す
 *   --out <json>          詳細 JSON の出力先
 *   --fill-empty-shared   共有の利用者 (kaigo-app でも使用) で clients.care_office_id が空のときだけ埋める (既定 = 書かずに observe で控える)
 *   --add-care-offices    care_offices に無い事業所番号を追加する (名前が決まり、名前が既存行と衝突しないものだけ)。
 *                        追加した事業所を担当にする利用者の update も同じ batch で行う (無ければその利用者は「追加待ち」で止まる)
 *
 * ── 何をどこに書くか ─────────────────────────────────────────────────────
 *   伝送 (lib/kokuho-densou/build.ts 項19/20) の材料は clients.care_office_id → care_offices.office_number だけ
 *   (app/[tenant]/BillingTab.tsx generateTransferData / 給付管理の送付も clients.care_office_id)。
 *   請求一覧の表示だけは client_insurance_records.care_office_id にフォールバックする (BillingTab L232 / L1547) が、伝送は見ない。
 *   → この script が書くのは **clients.care_office_id** (と --add-care-offices のときの care_offices の追加) だけ。
 *   client_insurance_records.care_office_id / care_office_number は sync_fukuyogu_from_honobono.mjs の insurance 段が扱う。
 *
 *   正 = KK の 7131/7132 基本 (01) レコード 項19 計画作成区分 (CSV 列 index 20) / 項20 居宅介護支援事業所番号 (index 21)。
 *     区分 1 = 居宅介護支援事業所作成 / 2 = 自己作成 (番号空) / 3 = 介護予防支援事業所・地域包括作成。
 *   KDS0031 の 列23 (計画作成区分の文字) / 列24 (事業所番号) は照合に使う (KK と違えば一覧)。
 *
 * ── 方針 (既存 sync_fukuyogu_from_honobono.mjs に揃える) ──────────────────
 *   ・利用者の突合 = (保険者, 被保番) を clients の列 ∪ client_insurance_records で引く。複数なら 未削除 → ケアサポ所属 → 生年月日 で絞る
 *   ・共有の利用者 (ケアサポ以外の client_office_assignments (終了済みも) / clients.office_id がケアサポ以外) は clients を上書きしない。
 *     ほのぼのの値は data_import_rows に op=observe で控える。空欄を埋めるのは --fill-empty-shared のときだけ
 *   ・区分 2 (自己作成) で DB に居宅が付いている人は外さない (判断が要る に出すだけ)
 *   ・care_offices に無い番号は 追加候補 として一覧。名前は 介護保険 CSV の 支援事業所（正式名称）→ care_offices_opendata の順
 *
 * ── 書込みの作法 (--execute) ─────────────────────────────────────────────
 *   ・出どころ記録の表 (migrations/data_import_provenance.sql) が無ければ拒否
 *   ・DB は必ず最新を読み直して計画を作り直す (キャッシュは使わない)
 *   ・最初に data_import_batches を作り、各 insert/update の直後に data_import_rows (before/after) を書く。書けなければ止める
 *   ・clients の update は「読んだときの care_office_id のままの行」だけ (eq / is null で条件を付け、更新件数 1 を確認)
 *   ・変更前の行は migrations/_backup_care_office_sync_<月>_<時刻>.json にも保存
 *   ・care_offices の insert は全行同じキー集合 (PostgREST が欠けた列に NULL を明示するため)・notes にマーカー [honobono-sync-YYYYMM]
 *   ・supabase の error は全部見る / .in() は 150 件ずつ / PostgREST 1000 行上限は order(id) + range
 *   ・trigger: clients / care_offices には updated_at 以外の trigger が無い (_dump_schema.sql 時点)。--execute 前に pg_trigger で再確認すること
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/_honobono-sync-core.mts (.mts) を読むため、tsx の下で自分自身を起動し直す (既存 sync script と同じ)
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
const { C, TENANT, PROVIDER_BN, readKds0031, readEnv, parseCsvLine, nfkc, nName, nInsurer, nInsured, nDate, ymOf } = core;

// ── 引数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const FILL_EMPTY_SHARED = argv.includes("--fill-empty-shared");
const ADD_CARE_OFFICES = argv.includes("--add-care-offices");
const DENSOU = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const REPO_ROOT = resolve(HERE, "../../..");
const KK_PATH = resolve(opt("--kk") ?? join(DENSOU, "202609/ほのぼのから/KK261004.CSV"));
const KDS_PATH = resolve(opt("--csv") ?? join(DENSOU, "202609/ほのぼのから/KDS0031_明細書明細付_処理R8-09.CSV"));
const KAIGO_CSV = resolve(opt("--kaigo-csv") ?? join(DENSOU, "利用者マスタ_20261109/介護保険_全件_保険と認定.CSV"));
const SCRIPT_REL = "apps/order-app/migrations/sync_fukuyogu_care_office_from_honobono.mjs";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "care_office";

// ── 小道具 ────────────────────────────────────────────────────────────────
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const relPath = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const nNo = (s) => nfkc(s).replace(/\D/g, "");
let seq = 0;
const newId = (kind) => `new:${kind}:${++seq}`;
const isNew = (id) => typeof id === "string" && id.startsWith("new:");

class Report {
  constructor() { this.m = new Map(); }
  add(cat, ex) { if (!this.m.has(cat)) this.m.set(cat, []); this.m.get(cat).push(ex); }
  count(cat) { return this.m.get(cat)?.length ?? 0; }
  toJSON() { return Object.fromEntries([...this.m].map(([k, v]) => [k, { count: v.length, items: v }])); }
  print(n = 5) {
    if (!this.m.size) console.log("  (なし)");
    for (const [k, v] of this.m) {
      console.log(`  ${String(v.length).padStart(5)}  ${k}`);
      for (const e of v.slice(0, n)) console.log(`         - ${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
  }
}

async function makeSb() {
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
async function selectAll(sb, table, select, build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function selectIn(sb, table, select, col, ids, extra = (q) => q) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll(sb, table, select, (q) => extra(q.in(col, c))));
  return out;
}
/** 出どころ記録の表があるか (SELECT 1 件で見る。わざとエラーを起こして調べるのではない) */
async function provenanceReady(sb) {
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) return { ok: false, why: `${t}: ${error.message}` };
  }
  return { ok: true };
}

// ── 入力ファイル ───────────────────────────────────────────────────────────
/** KK (国保連伝送 CSV)。基本 (01) レコードだけ。列 = [0]"2" [1]連番 [2]様式 (項1) [3]種別 (項2) … [6]保険者 (項5) [7]被保番 (項6) [14]生年月日 (項13) [20]項19 [21]項20 */
function readKk(path) {
  const lines = readFileSync(path, "latin1").split(/\r\n|\n/).filter((l) => l.length > 0);
  const unq = (s) => s.replace(/^"(.*)"$/, "$1");
  const ctl = lines[0].split(",");
  const recs = [];
  for (const l of lines) {
    const c = l.split(",").map(unq);
    if (c[0] !== "2" || c[3] !== "01" || !["7131", "7132"].includes(c[2])) continue;
    recs.push({ form: c[2], ym: c[4], insurer: nInsurer(c[6]), insured: nInsured(c[7]), birth: c[14], kubun: c[20], no: nNo(c[21]) });
  }
  if (!recs.length) throw new Error(`★ ${path}: 7131/7132 の基本 (01) レコードが 0 件。ファイルを疑うこと`);
  const yms = [...new Set(recs.map((r) => r.ym))];
  if (yms.length !== 1) throw new Error(`★ ${path}: 提供年月が複数 (${yms.join(",")})。月遅れ分と分けて渡すこと`);
  return { recs, control: ctl, ym: yms[0], lines: lines.length };
}
/** 介護保険 CSV: (保険者番号, 被保番) → 認定 (支援事業所（正式名称）) */
function readKaigoCsv(path) {
  if (!existsSync(path)) return { byKey: new Map(), rows: 0, note: `★ 無い (${path})` };
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const k = (n) => { const i = head.indexOf(n); if (i < 0) throw new Error(`★ ${path}: 列「${n}」が無い`); return i; };
  const I = { ins: k("保険者番号"), insd: k("被保険者番号"), st: k("認定有効期間－開始日"), en: k("認定有効期間－終了日"), office: k("支援事業所"), full: k("支援事業所（正式名称）"), cm: k("担当ケアマネジャー") };
  const byKey = new Map();
  let n = 0;
  for (const l of lines.slice(1)) {
    const r = parseCsvLine(l);
    if (r.length !== head.length) throw new Error(`★ ${path}: 列数が ${head.length} でない行がある`);
    n++;
    const key = `${nInsurer(r[I.ins])}|${nInsured(r[I.insd])}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ start: nDate(r[I.st]), end: nDate(r[I.en]), office: nfkc(r[I.office]), full: nfkc(r[I.full]), cm: nfkc(r[I.cm]) });
  }
  return { byKey, rows: n, note: "" };
}

// ── DB ───────────────────────────────────────────────────────────────────
/** ★ SELECT のみ。キャッシュがあれば読み直さない (core の loadSnapshot が作ったものも可) */
async function loadDb(sb, cachePath, { read, write }) {
  if (read && existsSync(cachePath)) {
    const j = JSON.parse(readFileSync(cachePath, "utf8"));
    if (j.clients && j.ins && j.careOffices && j.offices) {
      console.log(`DB: キャッシュを使う ${cachePath} (取得 ${j.fetchedAt})。最新は --refresh`);
      return j;
    }
    console.log(`DB: キャッシュ ${cachePath} に必要な表が無いので読み直す`);
  }
  const all = (table, select) => selectAll(sb, table, select, (q) => q.eq("tenant_id", TENANT));
  console.log("DB 読込 (READ ONLY)...");
  const snap = {
    fetchedAt: new Date().toISOString(),
    offices: await all("offices", "id,name,business_number"),
    clients: await all("clients", "id,user_number,name,birth_date,insurer_number,insured_number,care_office_id,office_id,deleted_at"),
    ins: await all("client_insurance_records", "id,client_id,insurer_number,insured_number"),
    careOffices: await all("care_offices", "id,office_number,name"),
  };
  for (const k of ["clients", "ins", "careOffices", "offices"]) {
    console.log(`  ${k.padEnd(12)} ${snap[k].length} 行`);
    if (!snap[k].length) throw new Error(`★ ${k} が 0 行。tenant_id や列名を疑うこと`);
  }
  if (write) { writeFileSync(cachePath, JSON.stringify(snap)); console.log(`  → 保存 ${cachePath}`); }
  return snap;
}

// ── 計画 ─────────────────────────────────────────────────────────────────
async function plan(sb, { read, write }) {
  const kk = readKk(KK_PATH);
  const MONTH = `${kk.ym.slice(0, 4)}-${kk.ym.slice(4, 6)}`;
  const monthEndS = new Date(Date.UTC(+kk.ym.slice(0, 4), +kk.ym.slice(4, 6), 0)).toISOString().slice(0, 10);
  console.log(`ほのぼの伝送: ${KK_PATH}\n  提供 ${MONTH} / 基本レコード ${kk.recs.length} 件 ${JSON.stringify(countBy(kk.recs, (r) => `${r.form} 区分${r.kubun}${r.no ? "" : " 番号空"}`))}`);
  const kds = existsSync(KDS_PATH) ? readKds0031(KDS_PATH) : null;
  const kdsBy = new Map();
  if (kds) for (const r of kds.rows) {
    if (ymOf(r[C.SVC_MONTH]) !== MONTH) continue;
    const key = `${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}`;
    if (!kdsBy.has(key)) kdsBy.set(key, { no: new Set(), kubun: new Set(), name: nfkc(r[C.NAME]), userNo: nfkc(r[C.USER_NO]) });
    kdsBy.get(key).no.add(nNo(r[C.CARE_OFFICE]));
    kdsBy.get(key).kubun.add(nfkc(r[C.PLAN_KUBUN]));
  }
  console.log(`KDS0031 (照合): ${kds ? `${KDS_PATH} 当月 ${kdsBy.size} 名` : `★ 無い (${KDS_PATH}) — 照合なし`}`);
  const kc = readKaigoCsv(KAIGO_CSV);
  console.log(`介護保険 CSV (名前): ${KAIGO_CSV} ${kc.rows} 行 ${kc.note}`);

  const cachePath = opt("--db-cache") ?? join(tmpdir(), `fukuyogu-care-office-db-${MONTH}.json`);
  const db = await loadDb(sb, cachePath, { read, write });
  const office = db.offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
  if (!office) throw new Error(`offices に business_number=${PROVIDER_BN} が無い`);
  const OFFICE = office.id;
  const officeName = new Map(db.offices.map((o) => [o.id, o.name]));
  const clientById = new Map(db.clients.map((c) => [c.id, c]));
  const coById = new Map(db.careOffices.map((c) => [c.id, c]));
  const coByNo = groupBy(db.careOffices.filter((c) => nNo(c.office_number)), (c) => nNo(c.office_number));
  const coByName = groupBy(db.careOffices, (c) => nName(c.name));
  const idx = new Map();
  const addK = (a, b, id) => { if (!a || !b) return; const k = `${nInsurer(a)}|${nInsured(b)}`; if (!idx.has(k)) idx.set(k, new Set()); idx.get(k).add(id); };
  for (const c of db.clients) addK(c.insurer_number, c.insured_number, c.id);
  for (const r of db.ins) addK(r.insurer_number, r.insured_number, r.client_id);

  const R = { summary: new Report(), judge: new Report(), coAdd: new Report(), check: new Report() };
  // 1 人 = (保険者, 被保番)。様式違いの 2 レセプト (月途中の要支援↔要介護) は同じ人
  const persons = groupBy(kk.recs, (r) => `${r.insurer}|${r.insured}`);
  const subjects = [];
  for (const [key, recs] of persons) {
    const pairs = [...new Set(recs.map((r) => `${r.kubun}|${r.no}`))];
    const ex = { 保険者: recs[0].insurer, 被保番: recs[0].insured, 様式: recs.map((r) => r.form).join("+"), 生年月日: recs[0].birth };
    if (pairs.length > 1) { R.judge.add("★ 同じ人の 2 レセプトで 計画作成区分/事業所番号 が違う (★ 触らない)", { ...ex, 値: pairs }); continue; }
    const [kubun, no] = pairs[0].split("|");
    const k = kdsBy.get(key);
    if (k) {
      ex.氏名 = k.name;
      if (k.no.size !== 1 || [...k.no][0] !== no) R.check.add("KDS0031 の事業所番号が KK と違う (KK を正にする)", { ...ex, KK: no, KDS: [...k.no] });
    } else if (kds) R.check.add("KDS0031 の当月に居ない (KK にだけ居る)", ex);
    subjects.push({ key, kubun, no, ex, form: recs[0].form });
  }

  // 利用者の突合
  const birth8 = (d) => (d ?? "").replaceAll("-", "").slice(0, 8);
  const matched = [];
  for (const s of subjects) {
    let cs = [...(idx.get(s.key) ?? [])].map((id) => clientById.get(id)).filter(Boolean);
    if (cs.length > 1) { const t = cs.filter((c) => !c.deleted_at); if (t.length) cs = t; }
    if (cs.length > 1) { const t = cs.filter((c) => c.office_id === OFFICE); if (t.length) cs = t; }
    if (cs.length > 1) { const t = cs.filter((c) => birth8(c.birth_date) === s.ex.生年月日); if (t.length) cs = t; }
    if (cs.length > 1) { R.judge.add("★ (保険者, 被保番) で複数の client に一致 (絞れない。★ 触らない)", { ...s.ex, 候補: cs.map((c) => `${c.name}/${c.user_number}/${c.id}`) }); continue; }
    if (!cs.length) { R.judge.add("DB に (保険者, 被保番) が一致する利用者がいない (★ 触らない。fukuyogu-densou-honobono-diff の ほのぼのだけ を参照)", s.ex); continue; }
    if (cs[0].deleted_at) { R.judge.add("★ 一致した client が削除済み (★ 触らない)", { ...s.ex, client_id: cs[0].id }); continue; }
    matched.push({ ...s, c: cs[0] });
  }

  // 共有の判定 (既存 sync と同じ: ケアサポ以外の割当 (終了済みも) / clients.office_id がケアサポ以外)
  const ids = matched.map((m) => m.c.id);
  const coaCache = cachePath.replace(/\.json$/, "") + "_care_office_coa.json";
  const coaKey = createHash("sha1").update([...ids].sort().join(",")).digest("hex");
  let coa = null;
  if (read && existsSync(coaCache)) { const j = JSON.parse(readFileSync(coaCache, "utf8")); if (j.key === coaKey) coa = j.rows; }
  if (!coa) {
    coa = await selectIn(sb, "client_office_assignments", "id,client_id,office_id,start_date,end_date", "client_id", ids, (q) => q.eq("tenant_id", TENANT));
    if (write) writeFileSync(coaCache, JSON.stringify({ key: coaKey, rows: coa }));
  }
  console.log(`  client_office_assignments (対象 ${ids.length} 名ぶん) ${coa.length} 行`);
  const coaBy = groupBy(coa, (a) => a.client_id);
  const sharedOf = (c) => {
    const why = [...new Set((coaBy.get(c.id) ?? []).filter((a) => a.office_id !== OFFICE).map((a) => `割当:${officeName.get(a.office_id) ?? a.office_id}`))];
    if (c.office_id && c.office_id !== OFFICE) why.push(`clients.office_id:${officeName.get(c.office_id) ?? c.office_id}`);
    return why.length ? why : null;
  };

  // care_offices に無い番号 → 名前を決める
  const missingNos = [...new Set(matched.filter((m) => m.no && !coByNo.has(m.no)).map((m) => m.no))];
  const od = missingNos.length ? await selectIn(sb, "care_offices_opendata", "id,office_number,name,service_type,address,address_detail,phone_number,fax_number,corp_name", "office_number", missingNos) : [];
  const odByNo = groupBy(od, (r) => nNo(r.office_number));
  const nameFromCsv = (key) => {
    const cs = kc.byKey.get(key) ?? [];
    const at = cs.filter((c) => c.start && c.start <= monthEndS && (!c.end || c.end >= monthEndS));
    return (at[0] ?? null)?.full || null;
  };
  const coNew = new Map(); // 番号 → { id, row, how, users }
  for (const no of missingNos) {
    const users = matched.filter((m) => m.no === no);
    const csvNames = [...new Set(users.map((u) => nameFromCsv(u.key)).filter(Boolean))];
    const o = odByNo.get(no) ?? [];
    const odName = o.length === 1 ? nfkc(o[0].name) : null;
    let name = null, how = "";
    if (csvNames.length === 1) { name = csvNames[0]; how = "介護保険 CSV 支援事業所（正式名称）"; }
    else if (csvNames.length === 0 && odName) { name = odName; how = "care_offices_opendata"; }
    const ex = { 事業所番号: no, 利用者数: users.length, 区分: [...new Set(users.map((u) => u.kubun))].join(","), CSV名: csvNames, opendata: o.map((x) => `${nfkc(x.name)} (${nfkc(x.service_type)}) ${nfkc(x.address)}`) };
    if (!name) { R.coAdd.add(`★ 名前が決まらない (${csvNames.length > 1 ? "CSV の名前が複数" : "CSV にも opendata にも無い"}。★ 追加しない)`, ex); continue; }
    if (odName && nName(odName) !== nName(name)) ex.注 = `opendata の名前「${odName}」と違う`;
    const clash = coByName.get(nName(name)) ?? [];
    if (clash.length) { R.coAdd.add("★ 同名の care_offices が既にある (UNIQUE (tenant_id, name)。番号違い/番号空 → 既存行に番号を付けるかは user 判断。★ 追加しない)", { ...ex, 名前: name, 既存: clash.map((c) => `${c.name}/${c.office_number ?? "番号空"}/${c.id}`) }); continue; }
    const row = {
      tenant_id: TENANT, name, office_number: no,
      address: o.length === 1 ? (nfkc(`${o[0].address ?? ""}${o[0].address_detail ?? ""}`) || null) : null,
      phone_number: o.length === 1 ? (nfkc(o[0].phone_number) || null) : null,
      fax_number: o.length === 1 ? (nfkc(o[0].fax_number) || null) : null,
      notes: `[honobono-sync-${kk.ym}] ほのぼの福祉用具の伝送 (${relPath(KK_PATH)}) の居宅事業所番号から追加。名前=${how}`,
    };
    const id = newId("care_office");
    coNew.set(no, { id, row, how });
    R.coAdd.add(`追加候補 (名前 = ${how})${ADD_CARE_OFFICES ? "" : " [要 --add-care-offices]"}`, { ...ex, 名前: name });
  }

  // 1 人ずつ
  const ops = [];
  for (const m of matched) {
    const c = m.c;
    const cur = c.care_office_id ? coById.get(c.care_office_id) ?? null : null;
    const curNo = cur ? nNo(cur.office_number) : "";
    const shared = sharedOf(c);
    const ex = { ...m.ex, 氏名: m.ex.氏名 ?? c.name, client_id: c.id, 区分: m.kubun, ほのぼの: m.no || "(空)", DB: c.care_office_id ? `${curNo || "番号空"} ${cur?.name ?? "(care_offices に無い id)"}` : "(空)", ...(shared ? { 共有: shared } : {}) };
    const src = { key: m.key, ref: { file: relPath(KK_PATH), 様式: m.form, 項19_計画作成区分: m.kubun, 項20_事業所番号: m.no || null, 生年月日: m.ex.生年月日 } };
    if (!m.no) {
      if (m.kubun !== "2") { R.judge.add(`★ 区分 ${m.kubun} なのに事業所番号が空 (★ 触らない)`, ex); continue; }
      if (!c.care_office_id) { R.summary.add("変えない (区分 2 自己作成・DB も空)", ex); continue; }
      R.judge.add("★ ほのぼのは 区分 2 (自己作成) だが DB に居宅が付いている (★ 外さない。user 判断)", ex); continue;
    }
    if (curNo === m.no) { R.summary.add(`変えない (一致${shared ? "・共有" : ""})`, ex); continue; }
    let target = coByNo.get(m.no)?.[0] ?? null;
    let targetId = target?.id ?? null;
    let pending = null;
    if (!target) {
      const n = coNew.get(m.no);
      if (!n) { R.judge.add("★ care_offices に無い番号で、追加候補にもならない (名前が決まらない / 同名衝突。上の care_offices 追加候補 を参照)", ex); continue; }
      targetId = n.id;
      pending = n;
    }
    const kind = c.care_office_id ? "変える" : "付ける";
    const label = `${kind}${shared ? " (共有)" : ""}${pending ? " — care_offices 追加後" : ""}`;
    const exT = { ...ex, 新: `${m.no} ${target?.name ?? pending.row.name}` };
    const gate = [];
    if (pending) gate.push("add-care-offices");
    let action = "update";
    if (shared) {
      if (!c.care_office_id && FILL_EMPTY_SHARED) gate.push("fill-empty-shared");
      else action = "observe";
    }
    if (action === "update" && pending && !ADD_CARE_OFFICES) { R.summary.add(`${label} [要 --add-care-offices]`, exT); continue; }
    if (action === "update" && gate.includes("fill-empty-shared") && !FILL_EMPTY_SHARED) { R.summary.add(`${label} [要 --fill-empty-shared]`, exT); continue; }
    if (action === "observe") {
      R.summary.add(`${label} — 共有のため書かない (observe で控える)${!c.care_office_id ? " [--fill-empty-shared で付く]" : ""}`, exT);
      ops.push({ table: "clients", action: "observe", id: c.id, before: { care_office_id: c.care_office_id }, patch: { care_office_id: isNew(targetId) ? null : targetId }, src: { ...src, ref: { ...src.ref, 居宅事業所名: target?.name ?? pending?.row.name } }, why: `共有のため上書きしない (${kind})` });
      continue;
    }
    R.summary.add(label, exT);
    ops.push({ table: "clients", action: "update", id: c.id, before: { care_office_id: c.care_office_id }, patch: { care_office_id: targetId }, src, why: label, pendingCo: pending?.id ?? null });
  }
  // 追加する care_offices = 実際に使う update / observe があるものだけ
  if (ADD_CARE_OFFICES) {
    const used = new Set(ops.filter((o) => o.action === "update" && o.pendingCo).map((o) => o.pendingCo));
    for (const n of coNew.values()) if (used.has(n.id)) ops.unshift({ table: "care_offices", action: "insert", id: n.id, row: n.row, src: { key: `care_office:${n.row.office_number}`, ref: { file: relPath(KK_PATH), 名前の出どころ: n.how } }, why: "ほのぼのの伝送にある居宅事業所番号が care_offices に無い" });
  }
  // 区分別 (区分 3 = 予防支援・包括。列追加案は migrations/care_offices_plan_kubun.sql)
  const kubun3 = groupBy(matched.filter((m) => m.kubun === "3"), (m) => m.no);
  const sourceFiles = [
    { path: relPath(KK_PATH), sha256: sha256(KK_PATH), rows: kk.lines, kind: `国保連伝送 KK (提供 ${MONTH})` },
    ...(kds ? [{ path: relPath(KDS_PATH), sha256: sha256(KDS_PATH), rows: kds.rows.length, kind: "KDS0031 明細書明細付 (照合)" }] : []),
    ...(kc.rows ? [{ path: relPath(KAIGO_CSV), sha256: sha256(KAIGO_CSV), rows: kc.rows, kind: "利用者管理 介護保険 CSV (事業所名)" }] : []),
  ];
  return { MONTH, ym: kk.ym, R, ops, subjects, matched, kubun3, coByNo, sourceFiles, cachePath };
}

// ── 本番書込み ────────────────────────────────────────────────────────────
async function execute(sb, ops, { MONTH, ym, sourceFiles }) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: sourceFiles, script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME, status: "running",
    notes: `提供 ${MONTH} / 担当居宅 / フラグ ${[FILL_EMPTY_SHARED && "fill-empty-shared", ADD_CARE_OFFICES && "add-care-offices"].filter(Boolean).join(",") || "なし"}`,
  }).select("id").single();
  if (bErr) throw new Error(`data_import_batches: ${bErr.message}`);
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `提供 ${MONTH} / 担当居宅 / 失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  const record = async (recs) => {
    for (const c of chunks(recs, 100)) {
      const { error } = await sb.from("data_import_rows").insert(c);
      if (error) await fail(`data_import_rows: ${error.message}`);
    }
  };
  const srcRef = (o) => ({ ...(o.src?.ref ?? {}), 理由: o.why });
  // observe
  const obs = ops.filter((o) => o.action === "observe");
  await record(obs.map((o) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "observe", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: o.before, after: o.patch })));
  // 変更前の行 → バックアップ
  const ups = ops.filter((o) => o.action === "update");
  const beforeRows = new Map((await selectIn(sb, "clients", "*", "id", ups.map((o) => o.id))).map((r) => [r.id, r]));
  if (beforeRows.size !== new Set(ups.map((o) => o.id)).size) await fail(`clients: 変更前の行が ${ups.length} 件のはずが ${beforeRows.size} 件しか読めない`);
  const bpath = join(HERE, `_backup_care_office_sync_${ym}_${ts}.json`);
  writeFileSync(bpath, JSON.stringify({ batch: BATCH, at: new Date().toISOString(), before: Object.fromEntries(beforeRows) }, null, 2));
  console.log(`バックアップ ${bpath}`);
  // care_offices insert (全行同じキー集合)
  const idMap = new Map();
  const coIns = ops.filter((o) => o.action === "insert");
  for (const c of chunks(coIns, 100)) {
    const keys = new Set(c.map((o) => Object.keys(o.row).sort().join(",")));
    if (keys.size !== 1) await fail("care_offices insert: キー集合が揃っていない");
    const { data, error } = await sb.from("care_offices").insert(c.map((o) => o.row)).select("id,office_number");
    if (error) await fail(`insert care_offices: ${error.message}`);
    if (data.length !== c.length) await fail(`insert care_offices: 返った行数 ${data.length} ≠ ${c.length}`);
    const byNo = new Map(data.map((d) => [nNo(d.office_number), d.id]));
    for (const o of c) { const nid = byNo.get(o.row.office_number); if (!nid) await fail(`insert care_offices: ${o.row.office_number} の id が返らない`); idMap.set(o.id, nid); }
    await record(c.map((o) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: "care_offices", row_id: idMap.get(o.id), op: "insert", source_key: o.src.key, source_ref: srcRef(o), before: null, after: o.row })));
  }
  console.log(`  care_offices: 追加 ${coIns.length}`);
  // clients update (読んだときの値のままの行だけ)
  let nu = 0;
  for (const o of ups) {
    const to = isNew(o.patch.care_office_id) ? idMap.get(o.patch.care_office_id) : o.patch.care_office_id;
    if (!to) await fail(`update clients ${o.id}: 追加した care_offices の id が無い`);
    let q = sb.from("clients").update({ care_office_id: to }, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
    q = o.before.care_office_id == null ? q.is("care_office_id", null) : q.eq("care_office_id", o.before.care_office_id);
    const { error, count } = await q;
    if (error) await fail(`update clients ${o.id}: ${error.message}`);
    if (count !== 1) await fail(`update clients ${o.id}: 更新件数 ${count} (読んだ後に care_office_id が変わった可能性)`);
    await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: "clients", row_id: o.id, op: "update", source_key: o.src.key, source_ref: srcRef(o), before: { care_office_id: beforeRows.get(o.id)?.care_office_id ?? null }, after: { care_office_id: to } }]);
    nu++;
  }
  console.log(`  clients: 更新 ${nu} / observe ${obs.length}`);
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== obs.length + coIns.length + nu) await fail(`verify: data_import_rows ${count} 行 ≠ 見込み ${obs.length + coIns.length + nu}`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH} / data_import_rows ${count} 行。取り消しは --revert ${BATCH}`);
}

// ── 取り消し ──────────────────────────────────────────────────────────────
async function revert(sb, batchId) {
  const { data: batch, error } = await sb.from("data_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(`data_import_batches: ${error.message}`);
  if (!batch) { console.error(`batch ${batchId} が無い`); process.exit(1); }
  if (batch.script !== SCRIPT_REL) { console.error(`★ batch ${batchId} はこの script の batch ではない (${batch.script})`); process.exit(1); }
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 取り消し batch ${batchId} (${batch.status} / ${batch.created_at})`);
  if (batch.status === "reverted") { console.log("既に取り消し済み"); return; }
  const recs = (await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId))).filter((r) => r.op !== "observe");
  const restore = [], del = [], skip = [];
  const cur = new Map((await selectIn(sb, "clients", "id,care_office_id", "id", recs.filter((r) => r.table_name === "clients").map((r) => r.row_id))).map((r) => [r.id, r]));
  for (const r of recs.filter((x) => x.table_name === "clients" && x.op === "update")) {
    const now = cur.get(r.row_id);
    if (!now) skip.push({ id: r.row_id, why: "既に無い" });
    else if (now.care_office_id !== r.after.care_office_id) skip.push({ id: r.row_id, why: "後から care_office_id が変わった (★ 戻さない)" });
    else restore.push({ id: r.row_id, from: r.after.care_office_id, to: r.before?.care_office_id ?? null });
  }
  const coIds = recs.filter((r) => r.table_name === "care_offices" && r.op === "insert").map((r) => r.row_id);
  if (coIds.length) {
    const refs = new Set();
    for (const [t, col] of [["clients", "care_office_id"], ["client_insurance_records", "care_office_id"], ["care_managers", "care_office_id"]]) {
      for (const r of await selectIn(sb, t, `id,${col}`, col, coIds)) if (!(t === "clients" && restore.some((x) => x.id === r.id))) refs.add(r[col]);
    }
    for (const id of coIds) {
      if (refs.has(id)) skip.push({ id, why: "この batch 以外の行が参照している (★ 消さない)" });
      else del.push(id);
    }
  }
  console.log(`戻す clients ${restore.length} / 消す care_offices ${del.length} / 戻さない ${skip.length}`);
  for (const s of skip.slice(0, 10)) console.log(`   - ${JSON.stringify(s)}`);
  if (!EXECUTE) { console.log("\nDRY RUN — 何も変えていない。--execute で取り消し"); return; }
  for (const x of restore) {
    const { error: e, count } = await sb.from("clients").update({ care_office_id: x.to }, { count: "exact" }).eq("id", x.id).eq("care_office_id", x.from);
    if (e || count !== 1) throw new Error(`restore clients ${x.id}: ${e?.message ?? `件数 ${count}`}`);
  }
  for (const c of chunks(del, 150)) {
    const { error: e, count } = await sb.from("care_offices").delete({ count: "exact" }).in("id", c);
    if (e || count !== c.length) throw new Error(`delete care_offices: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`);
  }
  const status = skip.length ? "partially_reverted" : "reverted";
  const { error: e3 } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
  if (e3) throw new Error(`batch を ${status} にできない: ${e3.message}`);
  console.log(`取り消し完了 (${status})`);
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const sb = await makeSb();
  if (REVERT) return revert(sb, REVERT);
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 担当居宅の同期 (フラグ: ${[FILL_EMPTY_SHARED && "--fill-empty-shared", ADD_CARE_OFFICES && "--add-care-offices"].filter(Boolean).join(" ") || "なし"})`);
  if (EXECUTE) {
    const ready = await provenanceReady(sb);
    if (!ready.ok) { console.error(`出どころ記録の表が無い (${ready.why})。migrations/data_import_provenance.sql を先に適用すること`); process.exit(2); }
  }
  const P = await plan(sb, { read: !EXECUTE && !argv.includes("--refresh"), write: !EXECUTE });
  const { R, ops, subjects, matched, kubun3, coByNo } = P;
  console.log(`\n対象: KK の人 ${subjects.length} 名 / DB と突合できた ${matched.length} 名`);
  console.log("\n══ 1 人ずつ (付ける / 変える / 変えない) ══");
  R.summary.print(5);
  console.log("\n══ 判断が要る (★ 触らない) ══");
  R.judge.print(10);
  console.log("\n══ care_offices 追加候補 (ほのぼのの番号が care_offices に無い) ══");
  R.coAdd.print(50);
  console.log("\n══ 照合 (KK と KDS0031) ══");
  R.check.print(5);
  console.log("\n══ 計画作成区分 3 (介護予防支援事業所・地域包括作成) の事業所 ══");
  for (const [no, ms] of kubun3) console.log(`  ${no} ${coByNo.get(no)?.[0]?.name ?? "(care_offices に無い)"} … ${ms.length} 名`);
  const cnt = countBy(ops, (o) => `${o.table} ${o.action}`);
  console.log(`\n書込み計画: ${JSON.stringify(cnt)} (observe = 書かずに data_import_rows に控えるだけ)`);
  const out = opt("--out");
  if (out) { writeFileSync(out, JSON.stringify({ month: P.MONTH, summary: R.summary, judge: R.judge, coAdd: R.coAdd, check: R.check, ops }, null, 1)); console.log(`→ ${out}`); }
  if (!EXECUTE) { console.log("\nDRY RUN — 何も変えていない。--execute で反映 (★ user 確認後)"); return; }
  await execute(sb, ops, P);
}
main().catch((e) => { console.error(e); process.exit(1); });
