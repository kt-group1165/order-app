/**
 * ほのぼの福祉用具 同期 (sync_fukuyogu_from_honobono.mjs、提供 2026-09) で落ちた 7 件を 個別に直す
 *
 *   node migrations/fix_honobono_sync_7_cases_202609.mjs                 # DRY RUN (既定)
 *   node migrations/fix_honobono_sync_7_cases_202609.mjs --execute       # 本番 (★ user 承認後)
 *   node migrations/fix_honobono_sync_7_cases_202609.mjs --revert <batch_id> [--execute]
 *   node migrations/fix_honobono_sync_7_cases_202609.mjs --cleanup-batch <batch_id> [--execute]
 *     (--revert / --cleanup-batch は sync_fukuyogu_from_honobono.mjs の同名処理にそのまま渡す。
 *      data_import_rows の before/after だけで戻す汎用処理なので この batch にも効く)
 *   --db-cache <json> / --refresh   DRY RUN の DB スナップショット (既定 = OS 一時フォルダ。--execute は必ず読み直す)
 *   --out <json>                    詳細 (計画・判定) の出力先
 *
 * ── user 合意 (2026-11-09) ────────────────────────────────────────────────
 *   1 和田 雅子 (14450)   DB の「和田 まさこ」(生年月日 2026-05-12・被保番 6666444111 の仮登録) = 同一人物。
 *                          その client を ほのぼのの値で直し、認定・公費・貸与明細を同期と同じ形で入れる
 *   2 丹羽 三千代 (14446) DB の「丹羽 美千代」(2023-01-01・7775566221) = 同一人物。同上
 *                          (★ 利用者管理 CSV に居ない = KDS0031 の値だけで直す。住所等は KDS に無いので DB の値を残す)
 *   3 渡邉 喜美子 (2570)  2570 は kaigo 側 (木更津ヘルパー) の別人「髙橋 年枝」が使用 → 番号で引かず新規作成
 *   4 内山 裕康          ほのぼのの利用者番号が空 → 新規作成
 *   5 森 春江 (15183)     伝送 (KDS) の被保番 1000011111 を正 (利用者管理の 1000059363 は notes に残す)。
 *                          前 batch で作られた client をそのまま使い、認定・貸与を入れる
 *   6 佐藤 昭子 (15137)   伝送の 1000083549 を正 (利用者管理は 1000083548)。clients と認定行の被保番を直す
 *   7 佐藤 万紀子 (15111) TAIS 00063-000031 が用具マスタに無く貸与が入らなかった → 統合 (batch 40972af8) 後なので貸与明細を入れる
 *
 * ── user_number (UNIQUE (user_number, tenant_id)・NOT NULL) の扱い ──────────
 *   同期 script は 衝突 / 空 のとき insert せず飛ばす (= 今回落ちた理由)。新規 2 名は 衝突しない仮番号を付ける。
 *   kaigo-app の import_kyotaku_clients_from_user_master.mjs と同じ「HN-<ほのぼのの番号>」方式 (HN- 接頭辞が記録になる。clients に notes 列は無い)
 *     渡邉 喜美子  HN-2570
 *     内山 裕康    HN-KDS-122192-1000074789  (番号が無いので 伝送の 保険者-被保番 から作る)
 *   既にその番号があれば止める。次回の同期は (保険者, 被保番)+生年月日 で先に当たるので、この仮番号は突合に使われない。
 *
 * ── 同期と同じにしているもの ───────────────────────────────────────────────
 *   利用者管理 CSV / KDS0031 の読み方・as-of (提供月末) の認定・給付率 (負担割合証)・居宅の引き方・
 *   clients の列 (copay_rate は clients "10/20/30" / 認定 "1/2/3")・認定は全世代を古い順に 1 行ずつ・notes マーカー [honobono-sync-YYYYMM]・
 *   公費 (介護のみ・負担者 8 桁)・貸与 (CSV のみの用具 = order_items 追加。日数 < 月の日数 は 開始 = 末日-日数+1)・
 *   注文が無ければ orders を作る・client_office_assignments (tenant_id 付き)・insert はキー集合ごと・
 *   trigger (doc_tasks / care_plan_elements) の掃除・data_import_batches / data_import_rows に before/after。
 *   計算は本物 (scripts/_honobono-sync-core の buildBillingModel = BillingTab と同じ / lib/kokuho-densou/fukuyogu-amounts)。
 *
 * ── 止める条件 (その件は書かない) ─────────────────────────────────────────
 *   既存 client を使う件 (1・2・5・6・7): id・利用者番号・氏名が想定と違う / 削除済み / サンプルの印
 *     (氏名が Z+英字 で始まる・fake/サンプル/テスト/ダミー・認定 notes に fake/_sample) /
 *   1・2 は さらに: kaigo / order 側のどの表からも参照されていないこと (OpenAPI の全表を client_id・user_id で照会)・
 *     ケアサポ以外の割当が無いこと → 違えば止め、「新規作成に切り替える案」を出す
 *   5・6・7 で共有 (ケアサポ以外の割当 / office_id が他事業所) なら clients は空欄だけ埋める (6 の被保番是正は合意どおり書き、影響を出す)
 *   新規 (3・4): 仮番号が既にある / (保険者, 被保番) か 氏名+生年月日 で既存 client が当たる → 止める
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execLockStart, execLockAcquire } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
// --revert / --cleanup-batch は同期 script の汎用処理に任せる (data_import_rows の before/after で戻す)
if (opt("--revert") || opt("--cleanup-batch")) {
  const r = spawnSync(process.execPath, [join(HERE, "sync_fukuyogu_from_honobono.mjs"), ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
// .mts / lib の .ts を読むため、tsx の下で自分自身を起動し直す (同期 script と同じ)
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...argv], { stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" } });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
// 認定状況の規則は lib/insurance/certStatus.ts の 1 か所 (逐語コピーしない。check:cert-status)
const { mayOverwriteCertStatus } = await import("../lib/insurance/certStatus.ts");
const {
  C, TENANT, PROVIDER_BN, readKds0031, loadSnapshot, loadLibs, readEnv, buildBillingModel, groupCsvUsers, repReceipt, csvTotals,
  buildMatchIndex, matchCsvUser, parseCsvLine, nfkc, nName, nKana, nInsurer, nInsured, nCare, nDate, nRate, nGender, toInt, ymOf, daysIn,
} = core;

const EXECUTE = argv.includes("--execute");
const DENSOU = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const REPO_ROOT = resolve(HERE, "../../..");
const CSV_PATH = join(DENSOU, "202609/ほのぼのから/KDS0031_明細書明細付_処理R8-09.CSV");
const UM_DIR = join(DENSOU, "利用者マスタ_20261109");
const SCRIPT_REL = "apps/order-app/migrations/fix_honobono_sync_7_cases_202609.mjs";
let EXEC_LOCK = null; // 同じ script の同時 --execute を止める (_exec_lock.mjs)。--execute の最初に execLockStart で取る
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "fix7";

// ── 7 件の定義 (user 合意 2026-11-09) ─────────────────────────────────────
const CASES = [
  { no: 1, label: "和田 雅子", kdsKey: "122069|0000030815", pid: "14450|1941-07-10", mode: "fix-provisional",
    target: { id: "11536491-966e-418d-9154-a19b9d79df5a", user_number: "14450", name: "和田 まさこ" } },
  { no: 2, label: "丹羽 三千代", kdsKey: "122259|0000344333", pid: null, mode: "fix-provisional",
    target: { id: "0e25a0fe-bb6e-4c45-88ae-48810a2c1938", user_number: "14446", name: "丹羽 美千代" } },
  { no: 3, label: "渡邉 喜美子", kdsKey: "122069|0000019619", pid: "2570|1935-08-05", mode: "create", userNumber: "HN-2570" },
  { no: 4, label: "内山 裕康", kdsKey: "122192|1000074789", pid: null, mode: "create", userNumber: "HN-KDS-122192-1000074789" },
  { no: 5, label: "森 春江", kdsKey: "122192|1000011111", pid: "15183|1941-03-04", mode: "existing-full", insuredFromKds: true,
    target: { id: "c1fe8440-d9c1-4416-a18c-8c0ce42c65c7", user_number: "15183", name: "森 春江" } },
  { no: 6, label: "佐藤 昭子", kdsKey: "122192|1000083549", pid: "15137|1946-06-29", mode: "insured-only", insuredFromKds: true,
    target: { id: "2cc63c24-8434-4ffc-b22d-593760dd6edf", user_number: "15137", name: "佐藤 昭子" } },
  { no: 7, label: "佐藤 万紀子", kdsKey: "122069|0000062612", pid: null, mode: "rentals-only",
    target: { id: "84232f8d-423e-4e46-81ee-289202ae70d9", user_number: "15111", name: "佐藤 万紀子" } },
];
// 1・2 のとき 参照があっても「使われている」とみなさない表 (= 福祉用具の同期が書く表。中身は個別に見る)
const OWN_TABLES = new Set(["clients", "client_office_assignments", "client_insurance_records", "client_public_expenses", "orders", "doc_tasks", "care_plan_elements", "v_order_margin"]);
const SAMPLE_NAME = /^Z[A-Z]|fake|サンプル|テスト|ダミー/i;
const SAMPLE_NOTE = /\[fake|_sample|サンプル/i;

// ── 小道具 (同期 script と同じもの) ────────────────────────────────────────
const clone = (x) => JSON.parse(JSON.stringify(x));
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const mode = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
let seq = 0;
const newId = (kind) => `new:${kind}:${++seq}`;
const isNew = (id) => typeof id === "string" && id.startsWith("new:");
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const relPath = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const dOrNull = (s) => nDate(s) || null;
const clientCopayOf = (br) => ({ "90": "10", "80": "20", "70": "30" })[nRate(String(br ?? ""))] ?? null;
const certCopayOf = (br) => ({ "90": "1", "80": "2", "70": "3" })[nRate(String(br ?? ""))] ?? null;
const sOrNull = (s) => nfkc(s) || null;
const iOrNull = (s) => (nfkc(s) === "" ? null : toInt(s));
const noSpaceNfkc = (s) => nfkc(s).replace(/[\s　]+/g, "");
const normFor = (col, v) => {
  if (v == null || v === "") return "";
  if (/date|_start$|_end$/.test(col)) return nDate(String(v));
  if (col === "care_level") return nCare(String(v));
  if (col === "insurer_number") return nInsurer(String(v));
  if (col === "insured_number") return nInsured(String(v));
  if (col === "benefit_rate") return nRate(String(v));
  if (col === "name") return nName(String(v));
  if (col === "furigana") return nKana(String(v));
  return noSpaceNfkc(String(v));
};

async function makeSb() {
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  const { createClient } = await import("@supabase/supabase-js");
  return { sb: createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }), env };
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
async function provenanceReady(sb) {
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) return { ok: false, why: `${t}: ${error.message}` };
  }
  return { ok: true };
}
/** ほのぼの 利用者管理 CSV (同期 script と同じ読み方) */
function readUserMasterCsv(prefix) {
  const f = readdirSync(UM_DIR).find((x) => x.startsWith(prefix) && /\.csv$/i.test(x));
  if (!f) throw new Error(`★ ${UM_DIR} に ${prefix}*.CSV が無い`);
  const path = join(UM_DIR, f);
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  const bad = rows.filter((r) => r.length !== head.length).length;
  if (bad) throw new Error(`★ ${f}: 列数が ${head.length} でない行が ${bad} 行`);
  const col = (name) => { const ex = head.indexOf(name); const i = ex >= 0 ? ex : head.findIndex((h) => h.startsWith(name)); if (i < 0) throw new Error(`★ ${f} に列「${name}」が無い`); return i; };
  return { path, rows, col };
}

// ── main ──────────────────────────────────────────────────────────────────
const LOG = [];
const log = (...a) => { const s = a.join(" "); LOG.push(s); console.log(s); };

async function main() {
  const libs = await loadLibs();
  const { computeFukuyoguAmounts } = libs;
  const { rows, monthCount } = readKds0031(CSV_PATH);
  const MONTH = mode(monthCount);
  const MARK = `[honobono-sync-${MONTH.replace("-", "")}]`;
  const MDAYS = daysIn(MONTH);
  const monthStartS = `${MONTH}-01`;
  const monthEndS = `${MONTH}-${String(MDAYS).padStart(2, "0")}`;
  const AS_OF = monthEndS;
  const mRows = rows.filter((r) => ymOf(r[C.SVC_MONTH]) === MONTH);
  const csvUsers = groupCsvUsers(mRows);
  log(`${EXECUTE ? "★★ EXECUTE (本番書込み)" : "DRY RUN (DB は書き換えない)"} / 提供月 ${MONTH} / as-of ${AS_OF}`);
  log(`KDS0031: ${relPath(CSV_PATH)} ${rows.length} 行 (当月 ${mRows.length} / 当月利用者 ${csvUsers.size})`);

  // ── 利用者管理 CSV (同期 script の読み方をそのまま) ───────────────────
  const UB = readUserMasterCsv("基本情報_"), UK = readUserMasterCsv("介護保険_"), UP = readUserMasterCsv("公費_"), UF = readUserMasterCsv("負担割合証等_");
  const persons = new Map();
  const burden = new Map();
  {
    const b = (n) => UB.col(n);
    for (const r of UB.rows) {
      const no = nfkc(r[b("利用者番号")]), birth = nDate(r[b("生年月日")]);
      if (!no) continue;
      const pid = `${no}|${birth}`;
      if (persons.has(pid)) throw new Error(`★ 基本情報に 利用者番号+生年月日 の重複 ${pid}`);
      persons.set(pid, {
        pid, userNo: no, birth, name: nfkc(r[b("利用者名")]), kana: nfkc(r[b("フリガナ")]), gender: nGender(r[b("性別")]),
        postal: sOrNull(r[b("郵便番号")]), address: sOrNull(r[b("住所")]), phone: sOrNull(r[b("電話番号")]), mobile: sOrNull(r[b("携帯番号")]),
        death: dOrNull(r[b("死亡日")]), certs: [], kohi: [], keys: new Set(),
        raw: Object.fromEntries(["利用者番号", "利用者名", "フリガナ", "同名識別", "性別", "生年月日", "郵便番号", "住所", "電話番号", "携帯番号", "死亡日"].map((k) => [k, r[b(k)]])),
      });
    }
    const k = (n) => UK.col(n);
    const insurerNameToNo = new Map();
    for (const r of UK.rows) {
      const pid = `${nfkc(r[k("利用者番号")])}|${nDate(r[k("生年月日")])}`;
      const p = persons.get(pid);
      if (!p) { if (pid.startsWith("|")) continue; throw new Error(`★ 介護保険 CSV の利用者 ${pid} が基本情報に居ない`); }
      const c = {
        insStart: dOrNull(r[k("有効開始日")]), insEnd: dOrNull(r[k("有効終了日")]), insured: nInsured(r[k("被保険者番号")]), issued: dOrNull(r[k("交付年月日")]),
        insurerName: sOrNull(r[k("保険者")]), insurer: nInsurer(r[k("保険者番号")]), rate: nRate(r[k("給付率")]), confirmed: dOrNull(r[k("確認日")]), qualified: dOrNull(r[k("資格取得日")]),
        status: sOrNull(r[k("認定状況")]), care: nCare(r[k("要介護度")]) || null, certDate: dOrNull(r[k("認定年月日")]),
        start: dOrNull(r[k("認定有効期間－開始日")]), end: dOrNull(r[k("認定有効期間－終了日")]),
        limStart: dOrNull(r[k("適用期間－開始日")]), limEnd: dOrNull(r[k("適用期間－終了日")]), limit: iOrNull(r[k("区分支給限度基準額")]),
        office: sOrNull(r[k("支援事業所")]), cm: sOrNull(r[k("担当ケアマネジャー")]), restriction: sOrNull(r[k("サービス限定")]), memo: sOrNull(r[k("留意事項")]),
        officeFull: sOrNull(r[k("支援事業所（正式名称）")]),
      };
      c.raw = Object.fromEntries(["有効開始日", "有効終了日", "被保険者番号", "保険者", "保険者番号", "給付率", "認定状況", "要介護度", "認定年月日", "認定有効期間－開始日", "認定有効期間－終了日", "区分支給限度基準額", "支援事業所（正式名称）", "担当ケアマネジャー"].map((n) => [n, r[k(n)]]));
      p.certs.push(c);
      p.keys.add(`${c.insurer}|${c.insured}`);
      if (c.insurerName) insurerNameToNo.set(c.insurerName, c.insurer);
    }
    const q = (n) => UP.col(n);
    for (const r of UP.rows) {
      const pid = `${nfkc(r[q("利用者番号")])}|${nDate(r[q("生年月日")])}`;
      const p = persons.get(pid);
      if (!p) { if (pid.startsWith("|")) continue; throw new Error(`★ 公費 CSV の利用者 ${pid} が基本情報に居ない`); }
      const hob = nfkc(r[q("法制コード")]).split(/\s+/)[0];
      const fut6 = nfkc(r[q("負担者番号")]);
      p.kohi.push({
        hob, fut: fut6.length === 6 ? hob + fut6 : fut6, jyu: sOrNull(r[q("受給者番号")]), confirmed: dOrNull(r[q("確認日")]),
        start: dOrNull(r[q("有効期限－開始日")]), end: dOrNull(r[q("有効期限－終了日")]), kubun: nfkc(r[q("介護医療区分")]),
        appType: sOrNull(r[q("申請区分")]), special: sOrNull(r[q("特別区分")]), outpatient: iOrNull(r[q("外来負担金")]), inpatient: iOrNull(r[q("入院負担金")]),
        raw: Object.fromEntries(["法制コード", "負担者番号", "受給者番号", "確認日", "有効期限－開始日", "有効期限－終了日", "生活保護区分", "介護医療区分"].map((n) => [n, r[q(n)]])),
      });
    }
    const f = (n) => UF.col(n);
    for (const r of UF.rows) {
      if (nfkc(r[f("給付種類")]) !== "介護保険負担割合証" || nfkc(r[f("適用")]) !== "○") continue;
      const ino = insurerNameToNo.get(nfkc(r[f("保険者")]));
      if (!ino) continue;
      const key = `${ino}|${nInsured(r[f("被保険者番号")])}`;
      if (!burden.has(key)) burden.set(key, []);
      burden.get(key).push({ rate: nRate(r[f("給付率")]), start: dOrNull(r[f("有効開始日")]), end: dOrNull(r[f("有効終了日")]) });
    }
  }
  const sourceFiles = [
    { path: relPath(CSV_PATH), sha256: sha256(CSV_PATH), rows: rows.length, kind: `KDS0031 明細書明細付 (提供 ${MONTH})` },
    { path: relPath(UB.path), sha256: sha256(UB.path), rows: UB.rows.length, kind: "利用者管理 基本情報 (利用登録有)" },
    { path: relPath(UK.path), sha256: sha256(UK.path), rows: UK.rows.length, kind: "利用者管理 介護保険 (全件・保険と認定)" },
    { path: relPath(UP.path), sha256: sha256(UP.path), rows: UP.rows.length, kind: "利用者管理 公費 (全件)" },
    { path: relPath(UF.path), sha256: sha256(UF.path), rows: UF.rows.length, kind: "利用者管理 負担割合証等 (全件)" },
  ];
  const [SRC_KDS, SRC_UB, SRC_UK, SRC_UP, SRC_UF] = sourceFiles.map((s) => s.path);
  const certAt = (p, day) => p.certs.filter((c) => c.start && c.start <= day && (!c.end || c.end >= day))
    .sort((a, b) => (a.status === "申請中") - (b.status === "申請中") || b.start.localeCompare(a.start))[0] ?? null;
  const rateAt = (c, day) => (burden.get(`${c.insurer}|${c.insured}`) ?? []).filter((x) => x.start && x.start <= day && (!x.end || x.end >= day)).sort((a, b) => b.start.localeCompare(a.start))[0]?.rate || c.rate || null;
  const receiptRef = (rr) => ({
    レセプト番号: rr[C.RECEIPT_NO], 利用者番号: nfkc(rr[C.USER_NO]), 氏名: nfkc(rr[C.NAME]), フリガナ: nfkc(rr[C.KANA]), 生年月日: rr[C.BIRTH], 性別: rr[C.GENDER],
    要介護度: rr[C.CARE_LEVEL], 認定開始: rr[C.CERT_START], 認定終了: rr[C.CERT_END], 保険者: rr[C.INSURER], 被保番: rr[C.INSURED], 給付率: rr[C.BENEFIT],
    居宅事業所番号: rr[C.CARE_OFFICE], 公費1負担者: rr[C.FUTAN1], 公費1受給者: rr[C.JUKYU1],
  });

  // ── DB ──────────────────────────────────────────────────────────────
  const cachePath = EXECUTE ? join(tmpdir(), `honobono_fix7_db_${Date.now()}.json`) : resolve(opt("--db-cache") ?? join(tmpdir(), `honobono_fix7_db_snapshot_${MONTH}.json`));
  const snap = await loadSnapshot(MONTH, cachePath, EXECUTE || argv.includes("--refresh"));
  const office = snap.offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
  if (!office) throw new Error(`offices に business_number=${PROVIDER_BN} が無い`);
  const OFFICE = office.id;
  const officeName = new Map(snap.offices.map((o) => [o.id, o.name]));
  log(`事業所: ${office.name} (${OFFICE})`);
  const { sb, env } = await makeSb();
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  const careOfficeByNo = groupBy(snap.careOffices.filter((c) => c.office_number), (c) => nfkc(c.office_number));
  const careOfficeByName = groupBy(snap.careOffices, (c) => nName(c.name));
  const careOfficeFor = (cert, kdsNo) => {
    if (kdsNo) return { co: careOfficeByNo.get(kdsNo)?.[0] ?? null, no: kdsNo, how: "KDS 事業所番号" };
    const byName = cert?.officeFull ? careOfficeByName.get(nName(cert.officeFull)) ?? careOfficeByName.get(nName(cert.office)) ?? [] : [];
    return byName.length === 1 ? { co: byName[0], no: nfkc(byName[0].office_number) || null, how: "支援事業所名" } : { co: null, no: null, how: byName.length > 1 ? "名前が複数一致" : cert?.officeFull ? "名前が一致しない" : "支援事業所なし" };
  };

  // 既存 client の全列 / 割当 / 認定 / 他表からの参照 (対象分だけ。読みのみ)
  const targetIds = CASES.filter((c) => c.target).map((c) => c.target.id);
  const fullClients = new Map((await selectIn(sb, "clients", "*", "id", targetIds)).map((r) => [r.id, r]));
  const fullIns = await selectIn(sb, "client_insurance_records", "*", "client_id", targetIds);
  const coa = await selectIn(sb, "client_office_assignments", "id,client_id,office_id,start_date,end_date", "client_id", targetIds, (q) => q.eq("tenant_id", TENANT));
  // 参照する表の一覧は PostgREST の OpenAPI (GET /rest/v1/) を正にする (コード grep は漏れる)
  const apiRes = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Accept: "application/openapi+json" } });
  if (!apiRes.ok) throw new Error(`OpenAPI: HTTP ${apiRes.status}`);
  const defs = (await apiRes.json()).definitions ?? {};
  const refTables = Object.entries(defs).flatMap(([t, d]) => ["client_id", "user_id"].filter((c) => d.properties?.[c]).map((c) => [t, c]))
    .filter(([t]) => !/^(passkey_|trusted_devices|user_companies|user_groups|user_offices|auth_admin_|notifications|kaigo_ai_usage_logs)/.test(t)); // staff (auth user) を指す user_id の表は除く
  if (refTables.length < 50) throw new Error(`★ OpenAPI から client を参照する表が ${refTables.length} 種しか取れない (偽陰性を疑う)`);
  const refs = new Map(targetIds.map((id) => [id, []]));
  for (const [t, col] of refTables) {
    const got = await selectIn(sb, t, `${col}`, col, targetIds, (q) => q).catch(async () => {
      // id 列の無い表 (VIEW 等) は order(id) できないので件数だけ見る
      const out = [];
      for (const id of targetIds) { const { count, error } = await sb.from(t).select(col, { count: "exact", head: true }).eq(col, id); if (error) throw new Error(`${t}: ${error.message}`); for (let i = 0; i < (count ?? 0); i++) out.push({ [col]: id }); }
      return out;
    });
    for (const [id, n] of Object.entries(countBy(got, (r) => r[col]))) refs.get(id)?.push(`${t}.${col}=${n}`);
  }
  log(`参照の照会: OpenAPI の ${refTables.length} 表 (client_id / user_id) × 対象 ${targetIds.length} 名`);

  // ── 計画 ─────────────────────────────────────────────────────────────
  const sim = clone(snap);
  const ops = [];
  const TABLE_OF = (data) => ({ clients: data.clients, client_insurance_records: data.ins, client_public_expenses: data.kohi, orders: data.orders, order_items: data.items, client_office_assignments: data.coa ??= [] });
  const applyTo = (data, op) => {
    const list = TABLE_OF(data)[op.table];
    if (op.action === "insert") list.push({ id: op.id, ...op.row });
    else if (op.action === "delete") { const i = list.findIndex((x) => x.id === op.id); if (i >= 0) list.splice(i, 1); }
    else { const x = list.find((y) => y.id === op.id); if (x) Object.assign(x, op.patch); }
  };
  const applyOp = (cs, op) => { op.case = cs.no; ops.push(op); applyTo(sim, op); };
  const results = [];
  const kdsTaisUnits = (t) => { // 用具の月額単位 = KDS の月を通した行の最頻値 (当月優先 → 他月)。同期 script の master 段と同じ
    const cur = new Map(), other = new Map();
    for (const r of rows) {
      if (nfkc(r[C.TAIS]) !== t) continue;
      const ym = ymOf(r[C.SVC_MONTH]);
      if (toInt(r[C.DAYS]) !== daysIn(ym)) continue;
      const m = ym === MONTH ? cur : other; const u = toInt(r[C.SVC_UNITS]); m.set(u, (m.get(u) ?? 0) + 1);
    }
    return mode(cur.size ? cur : other);
  };

  for (const cs of CASES) {
    const R = { no: cs.no, 氏名: cs.label, 状態: "計画", 判定: [], 注意: [] };
    results.push(R);
    const u = csvUsers.get(cs.kdsKey);
    if (!u) { R.状態 = "★ 止めた"; R.判定.push(`KDS0031 (当月) に ${cs.kdsKey} が居ない`); continue; }
    const rr = repReceipt(u, monthEndS);
    const p = cs.pid ? persons.get(cs.pid) : null;
    if (cs.pid && !p) { R.状態 = "★ 止めた"; R.判定.push(`利用者管理 基本情報に ${cs.pid} が居ない`); continue; }
    if (!cs.pid && [...persons.values()].some((x) => x.birth === u.birth && nName(x.name) === nName(u.name))) R.注意.push("利用者管理 基本情報に同じ氏名+生年月日の人がいる (想定外)");
    const kdsInsured = nInsured(rr[C.INSURED]), kdsInsurer = nInsurer(rr[C.INSURER]);
    const cert = p ? certAt(p, AS_OF) : null;
    const co = careOfficeFor(cert, nfkc(rr[C.CARE_OFFICE]));
    if (!co.co) R.注意.push(`居宅 ${co.no} が care_offices に無い (care_office_id は書かない)`);
    // 「ほのぼのの値」= 同期 script の subject.client と同じ作り方 (基本情報 + as-of の認定 / KDS のみの人は KDS)
    const desired = p ? {
      name: p.name, furigana: p.kana || null, birth_date: p.birth || null, gender: ["男", "女"].includes(p.gender) ? p.gender : null,
      postal_code: p.postal, address: p.address, phone: p.phone, mobile: p.mobile,
      care_level: cert?.care ?? null, certification_start_date: cert?.start ?? null, certification_end_date: cert?.end ?? null,
      insurer_number: cert?.insurer ?? null, insured_number: cert?.insured ?? null, benefit_rate: cert ? rateAt(cert, AS_OF) : null, copay_rate: cert ? clientCopayOf(rateAt(cert, AS_OF)) : null,
      ...(p.death ? { status: "deceased" } : {}),
    } : {
      name: u.name, furigana: u.kana || null, birth_date: u.birth || null, gender: ["男", "女"].includes(u.gender) ? u.gender : null,
      care_level: nCare(rr[C.CARE_LEVEL]) || null, certification_start_date: nDate(rr[C.CERT_START]) || null, certification_end_date: nDate(rr[C.CERT_END]) || null,
      insurer_number: nInsurer(rr[C.INSURER]) || null, insured_number: nInsured(rr[C.INSURED]) || null, benefit_rate: nRate(rr[C.BENEFIT]) || null, copay_rate: clientCopayOf(rr[C.BENEFIT]),
    };
    if (p && !cert) { R.状態 = "★ 止めた"; R.判定.push(`${AS_OF} に有効な認定が 介護保険 CSV に無い`); continue; }
    const otherNo = p && cs.insuredFromKds && cert.insured !== kdsInsured ? cert.insured : null;
    if (cs.insuredFromKds) {
      if (desired.insurer_number !== kdsInsurer) { R.状態 = "★ 止めた"; R.判定.push(`保険者が KDS (${kdsInsurer}) と利用者管理 (${desired.insurer_number}) で違う (想定外)`); continue; }
      desired.insured_number = kdsInsured;
      R.判定.push(`被保番は伝送 (KDS0031) の ${kdsInsured} を正 (利用者管理は ${otherNo ?? "同じ"})`);
    }
    const src = p
      ? { file: `${SRC_UB} + ${SRC_UK} + ${SRC_UF} + ${SRC_KDS}`, key: `ほのぼの利用者番号:${p.userNo}|${desired.insurer_number}|${desired.insured_number}|${p.birth}`, ref: { 基本情報: p.raw, 認定: cert?.raw ?? null, as_of: AS_OF, KDS: receiptRef(rr), fix7: `case ${cs.no}` } }
      : { file: SRC_KDS, key: u.key, ref: { ...receiptRef(rr), fix7: `case ${cs.no}` } };
    const ex = { case: cs.no, 氏名: cs.label, 保険者: kdsInsurer, 被保番: kdsInsured };

    // ── 対象 client ─────────────────────────────────────────────────
    let cid = null, shared = null;
    if (cs.target) {
      const c = fullClients.get(cs.target.id);
      const why = [];
      if (!c) why.push("client が無い");
      else {
        if (nfkc(c.user_number) !== cs.target.user_number || nName(c.name) !== nName(cs.target.name)) why.push(`想定と違う (DB ${c.user_number}/${c.name})`);
        if (c.tenant_id !== TENANT) why.push(`tenant_id=${c.tenant_id}`);
        if (c.deleted_at) why.push("削除済み");
        if (SAMPLE_NAME.test(c.name ?? "") || SAMPLE_NAME.test(c.furigana ?? "")) why.push(`サンプルの印 (氏名 ${c.name})`);
        for (const r of fullIns.filter((x) => x.client_id === c.id)) if (SAMPLE_NOTE.test(r.notes ?? "")) why.push(`認定 notes にサンプルの印 ${r.notes}`);
      }
      const other = coa.filter((a) => a.client_id === cs.target.id && a.office_id !== OFFICE).map((a) => `割当:${officeName.get(a.office_id) ?? a.office_id}`);
      if (c?.office_id && c.office_id !== OFFICE) other.push(`clients.office_id:${officeName.get(c.office_id) ?? c.office_id}`);
      const used = (refs.get(cs.target.id) ?? []).filter((x) => !OWN_TABLES.has(x.split(".")[0]));
      R.判定.push(`既存 client ${cs.target.id} (${c?.user_number}/${c?.name}/${c?.birth_date}/${c?.insurer_number}|${c?.insured_number}) / 参照 ${JSON.stringify(refs.get(cs.target.id))} / 他事業所 ${other.length ? other.join(",") : "なし"}`);
      if (cs.mode === "fix-provisional") {
        if (used.length) why.push(`ケアサポ以外の表から参照あり (${used.join(", ")})`);
        if (other.length) why.push(`ケアサポ以外の所属 (${other.join(", ")})`);
        if (why.length) {
          R.状態 = "★ 止めた"; R.判定.push(...why);
          R.判定.push(`案: この client は触らず、${cs.label} を 仮番号 HN-${u.userNo || "KDS"} で新規作成する (case 3・4 と同じ形)。user 判断待ち`);
          continue;
        }
      } else if (why.length) { R.状態 = "★ 止めた"; R.判定.push(...why); continue; }
      if (other.length || used.length) { shared = [...other, ...used]; R.注意.push(`共有の利用者 (${shared.join(", ")}) — clients は空欄だけ埋める`); }
      cid = c.id;
    } else {
      // 新規: 仮番号の衝突 / 既存 client に当たらないか (保険者+被保番 全世代 / 氏名+生年月日)
      const idx = buildMatchIndex(snap);
      const hitKey = [...(idx.byKey.get(`${kdsInsurer}|${kdsInsured}`) ?? [])];
      const hitNb = (idx.byNameBirth.get(`${nName(desired.name)}|${desired.birth_date}`) ?? []).filter((x) => !x.deleted_at);
      const hitNo = snap.clients.filter((x) => nfkc(x.user_number) === cs.userNumber);
      const sameUserNo = u.userNo ? snap.clients.filter((x) => nfkc(x.user_number) === u.userNo) : [];
      R.判定.push(`ほのぼの番号 ${u.userNo || "(空)"} の DB 既存: ${sameUserNo.map((x) => `${x.name}/${x.birth_date}/${officeName.get(x.office_id) ?? x.office_id ?? "office なし"}`).join(", ") || "なし"}`);
      const why = [];
      if (hitNo.length) why.push(`仮番号 ${cs.userNumber} が既にある (${hitNo.map((x) => x.name).join(",")})`);
      if (hitKey.length) why.push(`(保険者,被保番) で既存 client に当たる (${hitKey.join(",")})`);
      if (hitNb.length) why.push(`氏名+生年月日 で既存 client に当たる (${hitNb.map((x) => `${x.name}/${x.id}`).join(",")})`);
      if (why.length) { R.状態 = "★ 止めた"; R.判定.push(...why); continue; }
      cid = newId("client");
      const row = {
        tenant_id: TENANT, office_id: OFFICE, user_number: cs.userNumber, name: desired.name, furigana: desired.furigana, birth_date: desired.birth_date, gender: desired.gender,
        postal_code: desired.postal_code ?? null, address: desired.address ?? null, phone: desired.phone ?? null, mobile: desired.mobile ?? null,
        care_level: desired.care_level, certification_start_date: desired.certification_start_date, certification_end_date: desired.certification_end_date,
        insurer_number: desired.insurer_number, insured_number: desired.insured_number, benefit_rate: desired.benefit_rate, copay_rate: desired.copay_rate ?? null, care_office_id: co.co?.id ?? null,
        is_facility: false, is_provisional: false, status: desired.status ?? "active", deleted_at: null,
      };
      applyOp(cs, { table: "clients", action: "insert", id: cid, row, src, why: `新規 (仮番号 ${cs.userNumber}。ほのぼの番号 ${u.userNo || "空"} は ${u.userNo ? "別人が使用" : "未採番"})`, ref: ex });
      applyOp(cs, { table: "client_office_assignments", action: "insert", id: newId("coa"), src, why: "新規利用者の自事業所割当", ref: ex,
        row: { tenant_id: TENANT, client_id: cid, office_id: OFFICE, start_date: monthStartS, end_date: null } });
    }

    // ── clients の上書き (既存) ─────────────────────────────────────
    if (cs.target && cs.mode !== "rentals-only") {
      const c = fullClients.get(cid);
      const cols = cs.mode === "insured-only" ? { insured_number: desired.insured_number } : desired;
      const patch = {}, before = {};
      for (const [col, v] of Object.entries(cols)) {
        if (v == null || v === "") continue;
        if (normFor(col, c[col] ?? null) === normFor(col, v)) continue;
        const forced = cs.insuredFromKds && col === "insured_number"; // 6 (・5) の被保番は「伝送が正」の合意
        if (shared && !forced && c[col] != null && c[col] !== "") { R.注意.push(`共有のため ${col} は上書きしない (DB ${c[col]} / ほのぼの ${v})`); continue; }
        patch[col] = v; before[col] = c[col] ?? null;
      }
      if (cs.mode !== "insured-only") {
        const curNo = c.care_office_id ? (snap.careOffices.find((x) => x.id === c.care_office_id)?.office_number ?? "") : "";
        if (co.co && curNo !== (co.no ?? "") && !(shared && c.care_office_id)) { patch.care_office_id = co.co.id; before.care_office_id = c.care_office_id; }
      }
      if (Object.keys(patch).length) applyOp(cs, { table: "clients", action: "update", id: cid, before, patch, src, ref: ex,
        why: cs.mode === "fix-provisional" ? "仮登録を ほのぼのの値で直す (同一人物・user 合意)" : cs.mode === "insured-only" ? "被保番を伝送 (KDS) の値に (user 合意)" : "ほのぼの優先で上書き (被保番は伝送の値)" });
      if (shared && patch.insured_number) R.注意.push(`★ 共有の利用者の被保番を変える: kaigo-app 側の請求・伝送にも効く (${before.insured_number} → ${patch.insured_number})`);
      if (!coa.some((a) => a.client_id === cid && a.office_id === OFFICE && (!a.end_date || a.end_date >= monthStartS)))
        applyOp(cs, { table: "client_office_assignments", action: "insert", id: newId("coa"), src, why: "ケアサポの割当が無い (同期の --with-assignments と同じ)", ref: ex,
          row: { tenant_id: TENANT, client_id: cid, office_id: OFFICE, start_date: monthStartS, end_date: null } });
    }

    // ── 認定 ───────────────────────────────────────────────────────
    const INS_COLS = ["care_level", "certification_end_date", "insurer_number", "insurer_name", "insured_number", "benefit_rate", "certification_status", "certification_date",
      "issued_date", "insurance_confirmed_date", "qualification_date", "insurance_valid_start", "insurance_valid_end", "limit_period_start", "limit_period_end",
      "service_limit_amount", "care_manager", "care_manager_org", "care_office_name", "service_restriction", "service_memo", "copay_rate"];
    const mine = isNew(cid) ? [] : fullIns.filter((r) => r.client_id === cid);
    if (cs.mode === "insured-only") {
      // 認定行の被保番だけを直す (利用者管理の番号と同じ行 = 前 batch で入れた行)
      const targets = mine.filter((r) => otherNo && nInsured(r.insured_number) === otherNo);
      if (!targets.length) R.注意.push(`被保番 ${otherNo} の認定行が無い (認定は直さない)`);
      for (const r of targets) applyOp(cs, { table: "client_insurance_records", action: "update", id: r.id, src, ref: { ...ex, 認定: `${r.care_level}/${r.certification_start_date}〜${r.certification_end_date}` },
        before: { insured_number: r.insured_number, notes: r.notes ?? null },
        patch: { insured_number: kdsInsured, notes: `${r.notes ? `${r.notes} ` : ""}被保番は伝送 KDS0031 の ${kdsInsured} を正 (ほのぼの利用者管理は ${otherNo})` }, why: "認定行の被保番を伝送の値に (user 合意)" });
      const kdsStart = nDate(rr[C.CERT_START]);
      if (cert && kdsStart !== cert.start) R.注意.push(`参考: 認定開始日が KDS ${kdsStart} / 利用者管理 ${cert.start} で違う (直さない。9 月の請求には効かない)`);
    } else if (cs.mode !== "rentals-only") {
      const gens = p ? p.certs.filter((c) => c.start).map((c) => {
        const gco = careOfficeFor(c, certAt(p, monthEndS) === c ? nfkc(rr[C.CARE_OFFICE]) : null);
        const at = c.end && c.end < AS_OF ? c.end : AS_OF < c.start ? c.start : AS_OF;
        const insured = cs.insuredFromKds && c.insured === otherNo ? kdsInsured : c.insured || null;
        return { row: {
          care_level: c.care, certification_start_date: c.start, certification_end_date: c.end, insurer_number: c.insurer || null, insurer_name: c.insurerName,
          insured_number: insured, benefit_rate: rateAt(c, at), copay_rate: certCopayOf(rateAt(c, at)), certification_status: c.care ? "認定済み" : "申請中", certification_date: c.certDate,
          issued_date: c.issued, insurance_confirmed_date: c.confirmed, qualification_date: c.qualified, insurance_valid_start: c.insStart, insurance_valid_end: c.insEnd,
          limit_period_start: c.limStart, limit_period_end: c.limEnd, service_limit_amount: c.limit, care_manager: c.cm, care_manager_org: c.office, care_office_name: c.officeFull,
          service_restriction: c.restriction ?? "なし", service_memo: c.memo, care_office_id: gco.co?.id ?? null, care_office_number: gco.no,
        }, note: insured !== (c.insured || null) ? `被保番は伝送 KDS0031 の ${kdsInsured} を正 (ほのぼの利用者管理は ${c.insured})` : null,
        src: { file: `${SRC_UK} + ${SRC_UF}`, key: `ほのぼの利用者番号:${p.userNo}|${c.insurer}|${insured}|認定開始:${c.start}`, ref: { ...c.raw, fix7: `case ${cs.no}` } } };
      }) : [{ row: {
        care_level: desired.care_level, certification_start_date: desired.certification_start_date, certification_end_date: desired.certification_end_date,
        insurer_number: desired.insurer_number, insured_number: desired.insured_number, benefit_rate: desired.benefit_rate, copay_rate: certCopayOf(desired.benefit_rate), certification_status: "認定済み",
        care_office_id: co.co?.id ?? null, care_office_number: co.no,
      }, note: null, src: { file: SRC_KDS, key: u.key, ref: { ...receiptRef(rr), fix7: `case ${cs.no}` } } }];
      if (p) for (const c of p.certs) if (c.status === "申請中" && c.care) R.注意.push(`認定状況=申請中 だが要介護度あり → 認定済み で入れる (同期と同じ): ${c.care}/${c.start}`);
      const used = new Set(), inserts = [];
      for (const g of gens) {
        const exr = mine.find((r) => !used.has(r.id) && nDate(r.certification_start_date) === g.row.certification_start_date && (!r.insured_number || nInsured(r.insured_number) === nInsured(g.row.insured_number)));
        if (!exr) { inserts.push(g); continue; }
        used.add(exr.id);
        const patch = {}, before = {};
        for (const col of INS_COLS) {
          const v = g.row[col]; if (v == null || v === "") continue;
          // ★ 2026-11-13: 認定済み → 申請中 には下げない (ほのぼのの申請中 = 更新申請中の印。sync_fukuyogu_from_honobono.mjs と同じ)
          if (col === "certification_status" && !mayOverwriteCertStatus(exr.certification_status, v)) { console.log(`  認定済み → 申請中 には下げない: ${ex?.氏名 ?? exr.client_id} ${g.row.certification_start_date}〜${g.row.certification_end_date}`); continue; }
          if (normFor(col, exr[col] ?? null) !== normFor(col, v)) { patch[col] = v; before[col] = exr[col] ?? null; }
        }
        if (Object.keys(patch).length) applyOp(cs, { table: "client_insurance_records", action: shared ? "observe" : "update", id: exr.id, before, patch, src: g.src, ref: ex, why: "同じ認定開始日の行を ほのぼのの値に更新" });
      }
      inserts.sort((a, b) => a.row.certification_start_date.localeCompare(b.row.certification_start_date));
      for (const g of inserts) {
        const row = { tenant_id: TENANT, client_id: cid, effective_date: g.row.certification_start_date, ...g.row, birth_date: desired.birth_date, notes: g.note ? `${MARK} ${g.note}` : MARK };
        applyOp(cs, { table: "client_insurance_records", action: "insert", id: newId("ins"), row, src: g.src, why: p ? "ほのぼのの認定 (全世代) で DB に無い世代" : "KDS の当月認定で DB に無い",
          ref: { ...ex, 認定: `${row.care_level}/${row.certification_start_date}〜${row.certification_end_date}` } });
      }
      for (const r of mine) if (!used.has(r.id)) R.注意.push(`ほのぼのに無い既存認定 (★ 残す): ${r.care_level}/${r.certification_start_date}〜${r.certification_end_date}/${r.insured_number}`);
      const dup = Object.entries(countBy(gens, (g) => g.row.certification_start_date)).filter(([, n]) => n > 1);
      if (dup.length) R.注意.push(`ほのぼのに 同じ認定開始日の世代が複数 (保険の有効期間が違う。同期と同じく全部入れる): ${dup.map(([d, n]) => `${d}×${n}`).join(", ")}`);

      // ── 公費 (同期と同じ。今回の 7 件はほのぼの・KDS とも 0 件の見込み) ──
      const kohiMine = isNew(cid) ? [] : sim.kohi.filter((k) => k.client_id === cid);
      const want = p ? p.kohi.map((k) => ({ k, src: { file: SRC_UP, key: `ほのぼの利用者番号:${p.userNo}|${k.fut}|${k.jyu}|${k.start}`, ref: k.raw } }))
        : [[C.FUTAN1, C.JUKYU1], [C.FUTAN2, C.JUKYU2], [C.FUTAN3, C.JUKYU3]].map(([f, j]) => nfkc(rr[f]) ? { k: { hob: nfkc(rr[f]).slice(0, 2), fut: nfkc(rr[f]), jyu: nfkc(rr[j]) || null, start: monthStartS, end: null, kubun: "介護", raw: { 負担者: rr[f], 受給者: rr[j] } }, src: { file: SRC_KDS, key: u.key, ref: receiptRef(rr) } } : null).filter(Boolean);
      let kohiN = 0;
      for (const { k, src: ksrc } of want) {
        if (k.kubun && k.kubun !== "介護") { R.注意.push(`公費: 介護医療区分が 介護 でない (入れない) ${k.fut}`); continue; }
        if (!/^\d{8}$/.test(k.fut)) { R.注意.push(`公費: 負担者番号が 8 桁にならない (入れない) ${k.fut}`); continue; }
        if (kohiMine.some((e) => nfkc(e.futan_sha_number) === k.fut && (nfkc(e.jukyu_sha_number) || null) === k.jyu && (e.valid_start ?? null) === k.start && (e.valid_end ?? null) === k.end)) continue;
        kohiN++;
        applyOp(cs, { table: "client_public_expenses", action: "insert", id: newId("kohi"), why: p ? "ほのぼのの公費 (全件) で DB に無い行" : "KDS の公費で DB に無い", ref: { ...ex, 期間: `${k.start}〜${k.end}` }, src: ksrc,
          row: { tenant_id: TENANT, client_id: cid, hohei_code: k.hob, futan_sha_number: k.fut, jukyu_sha_number: k.jyu, valid_start: k.start, valid_end: k.end,
            confirmed_date: k.confirmed ?? null, application_type: k.appType ?? null, special_type: k.special ?? null, outpatient_copay: k.outpatient ?? null, inpatient_copay: k.inpatient ?? null } });
      }
      R.判定.push(`公費: ほのぼの ${want.length} 行 / 追加 ${kohiN} 行 (KDS 公費1負担者: ${nfkc(rr[C.FUTAN1]) || "なし"})`);
    }

    // ── 貸与明細 (同期の rentals 段と同じ) ─────────────────────────────
    {
      const m = buildBillingModel(sim, MONTH, OFFICE, libs);
      const eqCodes = new Set(sim.equipment.map((e) => e.product_code));
      const dItems = sim.items.filter((it) => { if (!m.isActive(it)) return false; const o = m.ordersById.get(it.order_id); return o?.client_id === cid && o.office_id === OFFICE; });
      const cg = groupBy(u.lines, (l) => l.tais), dg = groupBy(dItems, (it) => it.product_code);
      let oid = null;
      for (const [tais, cl] of cg) {
        const isrc = { file: SRC_KDS, key: `${u.key}|TAIS:${tais}`, ref: { 明細: cl, fix7: `case ${cs.no}` } };
        const d = dg.get(tais) ?? [];
        const dQty = d.reduce((s, it) => s + (it.quantity ?? 1), 0);
        if (d.length === 0) {
          if (!eqCodes.has(tais)) { R.注意.push(`★ 用具 ${tais} が equipment_master (product_code) に無い → 入れない`); continue; }
          if (!oid) {
            oid = sim.orders.find((o) => o.client_id === cid && o.office_id === OFFICE && o.status !== "cancelled" && (o.payment_type ?? "介護") === "介護")?.id ?? null;
            if (!oid) {
              oid = newId("order");
              applyOp(cs, { table: "orders", action: "insert", id: oid, cid, why: "利用者にケアサポの注文が無い", ref: ex, src: { file: SRC_KDS, key: u.key, ref: { 用途: "CSV のみの用具を入れる器", fix7: `case ${cs.no}` } }, row: {
                tenant_id: TENANT, client_id: cid, office_id: OFFICE, payment_type: "介護", status: "completed", ordered_at: monthStartS, delivery_date: monthStartS,
                delivery_type: "直納", attendance_required: false, attendee_ids: [], email_sent_count: 0, merged_from_order_ids: [], notes: MARK,
              } });
            }
          }
          const units = kdsTaisUnits(tais);
          if (units == null) R.注意.push(`用具 ${tais} の月額単位が KDS で決まらない (rental_price は null)`);
          for (const [days, ls] of groupBy(cl, (l) => l.days)) {
            const start = days > 0 && days < MDAYS ? addDays(monthStartS, MDAYS - days) : monthStartS;
            if (start !== monthStartS) R.注意.push(`用具 ${tais} は月途中から (日数 ${days} → 開始日 ${start} を仮置き。同期と同じ)`);
            applyOp(cs, { table: "order_items", action: "insert", id: newId("item"), cid, why: "CSV のみの用具", ref: { ...ex, TAIS: tais, 単位: ls.map((l) => l.units) }, src: isrc, row: {
              tenant_id: TENANT, order_id: oid, product_code: tais, quantity: ls.length, status: "rental_started", payment_type: "介護",
              rental_start_date: start, rental_end_date: null, cancelled_at: null, rental_price: (units ?? 0) * 10 || null, notes: MARK,
            } });
          }
          continue;
        }
        if (cl.every((l) => l.days > 0 && l.days < MDAYS)) {
          const end = addDays(monthStartS, Math.max(...cl.map((l) => l.days)) - 1);
          for (const it of d) applyOp(cs, { table: "order_items", action: "update", id: it.id, cid, src: isrc, before: { status: it.status, rental_end_date: it.rental_end_date }, patch: { status: "terminated", rental_end_date: end }, why: "KDS では月途中まで (終了日 = 月初 + 日数 - 1)", ref: { ...ex, TAIS: tais } });
        }
        if (cl.length === dQty) continue;
        if (cl.length > dQty) { const it = d[0]; applyOp(cs, { table: "order_items", action: "update", id: it.id, cid, src: isrc, before: { quantity: it.quantity }, patch: { quantity: (it.quantity ?? 1) + (cl.length - dQty) }, why: "数量が CSV より少ない", ref: { ...ex, TAIS: tais } }); continue; }
        R.注意.push(`用具 ${tais}: DB の数量 ${dQty} > KDS ${cl.length} (★ この script では減らさない)`);
      }
      for (const [tais, d] of dg) if (!cg.has(tais)) R.注意.push(`DB のみの用具 ${tais} ×${d.length} (★ この script では終了しない)`);
    }
  }

  // ── 反映後の見込み (7 名だけ。同期 script の evaluate と同じ判定) ──────
  const evalOne = (data, key) => {
    const m = buildBillingModel(data, MONTH, OFFICE, libs);
    const idx = buildMatchIndex(data);
    const u = csvUsers.get(key);
    if (!u) return "KDS に居ない";
    const mr = matchCsvUser(u, idx, m.clientById, (cid) => m.dbLines.has(cid) || m.dbSkipped.has(cid));
    if (mr.status !== "ok") return `利用者が引けない (${mr.status === "ambiguous" ? "複数一致" : "不在"})`;
    const c = mr.client;
    if (!m.officeClients.has(c.id)) return `請求の範囲外 (office_id=${c.office_id ? officeName.get(c.office_id) : "空"})`;
    const dl = m.dbLines.get(c.id) ?? [];
    const ct = csvTotals(u);
    if (m.isLate(c.id)) return "月遅れ扱い (伝送から外れる)";
    if (!dl.length) return `請求明細 0 (${(m.dbSkipped.get(c.id) ?? []).map((s) => s.skipped).join(",") || "有効明細なし"})`;
    const totalUnits = dl.reduce((s, l) => s + l.units, 0);
    const kk = m.pickKohi(c.id);
    const amt = computeFukuyoguAmounts({ benefitRateRaw: c.benefit_rate, insuredNumber: c.insured_number, totalUnits, kohi: kk ? { hobetsu: kk.hohei_code, futansha: kk.futan_sha_number, jukyusha: kk.jukyu_sha_number } : null });
    const ins = m.pickIns(c.id);
    const same = ct.units === totalUnits && ct.ins === amt.insuranceAmount && ct.self === amt.userAmount && ct.kohi === (amt.kohiAmount ?? 0);
    const codes = [...new Set(dl.map((l) => l.code))].join(",");
    const kdsCodes = [...new Set(u.lines.map((l) => l.code))].join(",");
    return `${same ? "一致" : "★ 不一致"} (${mr.method}) 単位 KDS ${ct.units} / DB ${totalUnits}・保険 ${ct.ins}/${amt.insuranceAmount}・本人 ${ct.self}/${amt.userAmount}・公費 ${ct.kohi}/${amt.kohiAmount ?? 0}` +
      ` / 当月の認定 ${ins ? `${ins.care_level} ${ins.certification_start_date}〜${ins.certification_end_date} ${ins.insurer_number}|${ins.insured_number}` : "なし"}` +
      ` / サービスコード KDS ${kdsCodes} vs DB ${codes}${kdsCodes !== codes ? " (★ 7131 の明細コードが違う)" : ""}`;
  };
  for (const R of results) {
    const cs = CASES.find((x) => x.no === R.no);
    R.伝送_反映前 = evalOne(snap, cs.kdsKey);
    R.伝送_反映後 = evalOne(sim, cs.kdsKey);
  }

  // ── 出力 ───────────────────────────────────────────────────────────
  for (const R of results) {
    log(`\n━━ ${R.no}. ${R.氏名} — ${R.状態}`);
    for (const s of R.判定) log(`   判定: ${s}`);
    for (const s of R.注意) log(`   注意: ${s}`);
    const mineOps = ops.filter((o) => o.case === R.no);
    for (const [k, v] of Object.entries(countBy(mineOps, (o) => `${o.table} ${o.action} — ${o.why}`))) log(`   ${String(v).padStart(3)}  ${k}`);
    for (const o of mineOps) {
      const body = o.action === "insert" ? o.row : { id: o.id, before: o.before, patch: o.patch };
      log(`        ${o.table} ${o.action} ${JSON.stringify(body)}`);
    }
    log(`   伝送 反映前: ${R.伝送_反映前}`);
    log(`   伝送 反映後: ${R.伝送_反映後}`);
  }
  const keySets = {};
  for (const o of ops.filter((x) => x.action === "insert")) (keySets[o.table] ??= new Set()).add(Object.keys(o.row).sort().join(","));
  log(`\n══ 合計 ══ 書込み ${ops.filter((o) => o.action !== "observe").length} 件 ${JSON.stringify(countBy(ops, (o) => `${o.table} ${o.action}`))}`);
  log(`insert のキー集合 (表ごとの種類数。違う集合は別の insert に分ける): ${JSON.stringify(Object.fromEntries(Object.entries(keySets).map(([t, v]) => [t, v.size])))}`);
  log(`止めた件: ${results.filter((r) => r.状態 !== "計画").map((r) => `${r.no}.${r.氏名}`).join(", ") || "なし"}`);
  log(`trigger: client_insurance_records の追加 (care_plan_elements) / order_items の追加 (doc_tasks・care_plan_elements) は 実行時に「書込み → 掃除」(同期と同じ。参照先がこの batch で触った行のものだけ消す)`);
  const outPath = resolve(opt("--out") ?? join(tmpdir(), `honobono_fix7_${MONTH}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ month: MONTH, sourceFiles, results, ops }, null, 2));
  log(`詳細 JSON: ${outPath}`);
  const ready = await provenanceReady(sb);
  log(`出どころ記録の表: ${ready.ok ? "あり" : `無い (${ready.why})`}`);
  if (!EXECUTE) { log("\nDRY RUN — DB は書き換えていない。--execute で本番"); return; }
  if (!ready.ok) { console.error("★ 出どころ記録の表が無いので --execute しない"); process.exit(2); }
  if (results.some((r) => r.状態 !== "計画")) log("⚠ 止めた件は書かない (計画に入っていない)");
  await execute(sb, ops.filter((o) => o.action !== "observe"), ops.filter((o) => o.action === "observe"), { MONTH, sourceFiles });
}

// ── trigger が作る行の掃除 (同期 script と同じ) ─────────────────────────────
const DERIVED = [["doc_tasks", "trigger_ref_id"], ["care_plan_elements", "ref_id"]];
async function snapshotDerived(sb, clientIds) {
  const out = {};
  for (const [t] of DERIVED) out[t] = new Set((await selectIn(sb, t, "id", "client_id", clientIds, (q) => q.eq("tenant_id", TENANT))).map((r) => r.id));
  return out;
}
async function cleanupDerived(sb, clientIds, beforeSets, refIds) {
  const res = {};
  for (const [t, refCol] of DERIVED) {
    const rows = await selectIn(sb, t, "*", "client_id", clientIds, (q) => q.eq("tenant_id", TENANT));
    const fresh = rows.filter((r) => !beforeSets[t].has(r.id));
    const mine = fresh.filter((r) => refIds.has(r[refCol]));
    const others = fresh.filter((r) => !refIds.has(r[refCol]));
    for (const c of chunks(mine.map((r) => r.id), 150)) {
      const { error, count } = await sb.from(t).delete({ count: "exact" }).in("id", c);
      if (error || count !== c.length) throw new Error(`掃除 ${t}: ${error?.message ?? `削除件数 ${count} ≠ ${c.length}`}`);
    }
    res[t] = { mine, others };
  }
  return res;
}

// ── 本番書込み (同期 script の execute と同じ作法。段は 1 つ = fix7) ────────
async function execute(sb, writes, observes, { MONTH, sourceFiles }) {
  const ym = MONTH.replace("-", "");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: sourceFiles, script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `提供 ${MONTH} / 同期で落ちた 7 件の個別是正 (user 合意 2026-11-09)`,
  });
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `提供 ${MONTH} / 失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  const record = async (recs) => {
    for (const c of chunks(recs, 100)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); }
  };
  const srcRef = (o) => ({ file: o.src?.file ?? null, ...(o.src?.ref ?? {}) });
  await record(observes.map((o) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "observe", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: o.before ?? null, after: o.patch ?? null })));
  const idMap = new Map();
  const fix = (v) => (isNew(v) ? idMap.get(v) ?? null : v);
  const cidOf = (o) => o.cid ?? o.row?.client_id ?? (o.table === "clients" ? o.id : null);
  const beforeRows = new Map();
  for (const [table, us] of groupBy(writes.filter((o) => o.action !== "insert"), (o) => o.table)) {
    const got = await selectIn(sb, table, "*", "id", us.map((o) => o.id));
    if (got.length !== new Set(us.map((o) => o.id)).size) await fail(`${table}: 変更前の行が ${us.length} 件のはずが ${got.length} 件しか読めない`);
    for (const r of got) beforeRows.set(`${table}:${r.id}`, r);
  }
  const bpath = join(HERE, `_backup_honobono_fix7_${ym}_${ts}.json`);
  writeFileSync(bpath, JSON.stringify({ batch: BATCH, at: new Date().toISOString(), before: Object.fromEntries(beforeRows) }, null, 2));
  console.log(`バックアップ ${bpath}`);
  const existingCids = [...new Set(writes.map(cidOf).filter((x) => x && !isNew(x)))];
  const beforeDerived = await snapshotDerived(sb, existingCids);
  const touched = new Set();
  const doCleanup = async () => {
    const allCids = [...new Set(writes.map((o) => fix(cidOf(o))).filter(Boolean))];
    const res = await cleanupDerived(sb, allCids, beforeDerived, touched);
    for (const [t, { mine, others }] of Object.entries(res)) {
      await record(mine.map((r) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger", source_ref: { cleanup: true, 理由: "fix7 の書込みで trigger が作った行" }, before: r, after: null })));
      console.log(`  掃除 ${t}: 消した ${mine.length} / 参照先が違うので消さなかった新しい行 ${others.length}`);
    }
  };
  const order = ["clients", "client_office_assignments", "client_insurance_records", "client_public_expenses", "orders", "order_items"];
  try {
    for (const table of order) {
      let nu = 0, ni = 0;
      for (const o of writes.filter((x) => x.table === table && x.action === "update")) {
        const { error, count } = await sb.from(table).update(o.patch, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
        if (error) await fail(`update ${table} ${o.id}: ${error.message}`);
        if (count !== 1) await fail(`update ${table} ${o.id}: 更新件数 ${count}`);
        await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: o.id, op: "update", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${table}:${o.id}`), after: o.patch }]);
        touched.add(o.id);
        const oid = beforeRows.get(`${table}:${o.id}`)?.order_id; if (oid) touched.add(oid);
        nu++;
      }
      const ins = [];
      for (const o of writes.filter((x) => x.table === table && x.action === "insert")) {
        const row = Object.fromEntries(Object.entries(o.row).map(([k, v]) => [k, ["client_id", "order_id"].includes(k) ? fix(v) : v]));
        if (("client_id" in o.row && row.client_id === null) || ("order_id" in o.row && row.order_id === null)) await fail(`${table}: 参照先が無い (${o.row.client_id ?? o.row.order_id})`);
        ins.push({ o, row });
      }
      const batches = [];
      for (const x of ins) {
        const k = Object.keys(x.row).sort().join(",");
        const last = batches[batches.length - 1];
        if (last && last.k === k && last.rows.length < (table === "client_insurance_records" ? 1 : 100)) last.rows.push(x); else batches.push({ k, rows: [x] });
      }
      for (const { rows: c } of batches) {
        const { data, error } = await sb.from(table).insert(c.map((x) => x.row)).select("id");
        if (error) await fail(`insert ${table}: ${error.message}`);
        if (data.length !== c.length) await fail(`insert ${table}: 返った行数 ${data.length} ≠ ${c.length}`);
        data.forEach((d, j) => { idMap.set(c[j].o.id, d.id); touched.add(d.id); if (c[j].row.order_id) touched.add(c[j].row.order_id); });
        await record(c.map((x, j) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: data[j].id, op: "insert", source_key: x.o.src?.key ?? null, source_ref: srcRef(x.o), before: null, after: x.row })));
        ni += c.length;
      }
      if (nu || ni) console.log(`  ${table}: 更新 ${nu} / 追加 ${ni}`);
    }
  } catch (e) {
    console.error(`\n★ 途中で失敗: ${e.message}\n  ここまでに trigger が作った行の掃除だけは行う`);
    try { await doCleanup(); } catch (e2) { console.error(`★ 掃除も失敗: ${e2.message} → --cleanup-batch ${BATCH} で後から掃除すること`); }
    throw e;
  }
  try { await doCleanup(); } catch (e) { await fail(`掃除: ${e.message} (--cleanup-batch ${BATCH} で後から掃除できる)`); }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH} / data_import_rows ${count} 行。取り消しは --revert ${BATCH}`);
  if (!existsSync(bpath)) console.warn("バックアップファイルが見当たらない");
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
