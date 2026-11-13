/**
 * 福祉用具 (ケアサポ) の 用具マスタ・利用者・認定・公費・貸与明細 を ほのぼの福祉用具の実出力に合わせる
 *
 *   node migrations/sync_fukuyogu_from_honobono.mjs                          # DRY RUN (全段)
 *   node migrations/sync_fukuyogu_from_honobono.mjs --step=master             # DRY RUN (1 段だけ表示)
 *   node migrations/sync_fukuyogu_from_honobono.mjs --step=clients --execute  # 本番 (★ user 確認後)
 *   node migrations/sync_fukuyogu_from_honobono.mjs --revert <batch_id>       # 取り消し DRY RUN
 *   node migrations/sync_fukuyogu_from_honobono.mjs --revert <batch_id> --execute
 *   node migrations/sync_fukuyogu_from_honobono.mjs --cleanup-batch <batch_id> [--execute]  # 途中で落ちた batch の trigger 掃除の取りこぼし
 *
 *   --step=master|clients|insurance|kohi|rentals|all   (既定 all)
 *   ★ user 決定 (2026-11-09) どおりのフラグ一式 = --replace-history --with-assignments --terminate-absent-rentals --attach-billed-shared
 *   --replace-history    福祉用具専用の人の 認定・公費 で ほのぼのに無い既存行を削除する (= 全件置き換え。共有の人は消さない)
 *   --with-assignments   既存のケアサポ利用者にも client_office_assignments (ケアサポ) を作る (新規利用者には常に作る)
 *   --terminate-absent-rentals  KDS0031 (当月) に無い DB の当月有効な貸与明細を rental_end_date=前月末日・terminated にする。
 *                        KDS で月途中までの既存明細は rental_end_date=月初+日数-1・terminated にする
 *   --attach-billed-shared  共有の利用者で clients.office_id が空・かつ KDS0031 の当月請求者に突合できた人だけ office_id をケアサポにする
 *                        (他の列は書かない。office_id が他事業所の人は変えない)
 *   (誰もケアサポから外さない: clients.office_id を null にする処理は無い。住宅改修・予定・メモが画面から消えるため)
 *   (共有の利用者は clients の列を上書きしない・認定/公費は追加のみ。ほのぼのの値は data_import_rows に op=observe で控える)
 *   --as-of YYYY-MM-DD   clients の認定系の列 (伝送が使う) をどの日に有効な認定で埋めるか。既定 = 提供月の末日
 *   --csv <KDS0031>      既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KDS0031_明細書明細付_処理R8-09.CSV
 *   --master-csv <FYGMST01>  既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/マスタ/FYGMST01_用具マスタ_20261109.CSV
 *   --user-master-dir <dir>  既定 = kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109
 *                        (基本情報_*.CSV / 介護保険_*.CSV / 公費_*.CSV / 負担割合証等_*.CSV)
 *   --month YYYY-MM      既定 = KDS0031 で最も多い提供年月
 *   --db-cache <json>    DRY RUN で使う DB スナップショット (無ければ 1 回だけ読んで保存)。既定 = OS の一時フォルダ
 *   --refresh            DRY RUN でもスナップショットを読み直す (本番を流した後の確認用)
 *   --out-dir <dir>      詳細 JSON の出力先。既定 = OS の一時フォルダ/honobono-sync-<月>
 *
 * ── 目的と方針 ───────────────────────────────────────────────────────────
 *   このデータから当方で 2026-09 の伝送を作り、ほのぼのの KK261004 と一致させる。
 *   材料: 利用者・認定・公費 = ほのぼの 利用者管理 CSV (主) / 用具の価格・貸与明細 = KDS0031 (実請求) /
 *         用具の商品名・種目 = FYGMST01。KDS0031 は利用者・認定の「当月の照合」にも使う。
 *   user 方針 (2026-11-09): 福祉用具の利用者・保険は「今のデータは残さなくてよい。ほのぼのとそっくり同じに」。
 *     介護保険は過去の履歴も全部入れる (全世代)。ただし clients / client_insurance_records は kaigo-app と共有なので:
 *       ・ほのぼのに居ない現ケアサポ所属者も 外さない (所属 = clients.office_id はそのまま。貸与明細だけ終了する)
 *       ・kaigo-app でも使っている人 (= 共有) は clients を上書きしない。認定・公費は追加のみ。ほのぼのの値は observe で控える
 *   利用者のキー: ほのぼの利用者番号 + (保険者番号, 被保番) + 生年月日。
 *
 * ── 判定は差分 script と共有 ─────────────────────────────────────────────
 *   KDS0031 の読み方・当月有効・単位数 (BillingTab の書き写し)・利用者の突合は scripts/_honobono-sync-core.mts。
 *   計算は本物 (lib/half-month-units / lib/kokuho-densou/fukuyogu-amounts / build.ts / lib/equipment) を import。
 *   .mts / .ts を読むため tsx の下で自分自身を起動し直す (node 22.14 は TypeScript を直接読めない)。
 *
 * ── 段 ───────────────────────────────────────────────────────────────────
 *   master    product_code=TAIS 行の rental_price を KDS0031 の月額 (単位×10) に揃える。価格履歴が当月に効いていて
 *             食い違うなら当月 1 日付で履歴を足す。マスタに無い TAIS は FYGMST01 の商品名・種目で追加。
 *             重複行・種目名の不正・名前の差・FYGMST01 単位数との差は ★ 直さず一覧だけ。
 *   clients   ケアサポの利用者 = 基本情報 (利用登録有) ∪ KDS0031 の当月請求者 (居ない人も外さない)。基本情報の値と、--as-of に有効な認定
 *             (要介護度・認定期間・保険者・被保番・給付率 = 負担割合証・居宅) で上書き。office_id が空ならケアサポに。
 *             居なければ新規作成 (client_office_assignments も)。
 *   insurance 介護保険 CSV の全世代を入れる。同じ認定開始日の既存行は更新、無ければ追加 (古い順に 1 行ずつ = trigger の
 *             「直前の行」を正しくするため)。ほのぼのに無い既存行は 専用の人だけ --replace-history で削除。
 *   kohi      公費 CSV の全行 (生保は月ごとの行) を入れる。負担者番号 = 法制コード 2 桁 + 6 桁。
 *   rentals   当月の有効明細を KDS0031 の (TAIS, 数量) に揃える。CSV のみ → order_items 追加 / 数量差 → quantity。
 *             DB のみ (KDS に無い明細) と KDS で月途中までの明細は --terminate-absent-rentals で terminated (終了日は前月末日 / 月初+日数-1)。
 *
 * ── 書込みの作法 (--execute) ─────────────────────────────────────────────
 *   ・出どころ記録の表 (migrations/data_import_provenance.sql) が無ければ --execute を拒否する
 *   ・DB は必ず最新を読み直して計画を作り直す (DRY RUN のキャッシュは使わない)
 *   ・最初に data_import_batches を作り、各 insert/update/delete の直後に data_import_rows を書く。書けなければ止める
 *   ・段ごとに「書込み → 掃除」を続けて行う。掃除 = その段で trigger が新たに作った doc_tasks / care_plan_elements のうち
 *     参照先 (trigger_ref_id / ref_id) がこの段で触った行のものだけ削除 (op=delete・before 付きで記録)。他の原因で増えた行は消さない
 *   ・変更前の行は migrations/_backup_honobono_sync_<月>_<段>_<時刻>.json にも保存
 *   ・notes 列がある表 (client_insurance_records / orders / order_items) は notes にもマーカー [honobono-sync-YYYYMM]
 *   ・supabase の error は全部見る / .in() は 150 件ずつ / insert は 100 件ずつ・全行同じキー集合
 *   ・前の段を流していない状態で後の段を流すと、まだ無い利用者・注文を参照する行は飛ばして警告する
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";
import { resolveFukuyoguOffice, describeFukuyoguOffice } from "./_fukuyogu_office.mjs";
import { resolveUserMasterDirs } from "./_user_master_dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// .mts / lib の .ts を読むため、tsx の下で自分自身を起動し直す (node 22.14 は TypeScript を直接読めない)
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
// 認定状況の規則 (認定済み→申請中 に下げない 等) は lib/insurance/certStatus.ts の 1 か所 (逐語コピーしない。check:cert-status)
const { mayOverwriteCertStatus } = await import("../lib/insurance/certStatus.ts");
const {
  C, TENANT, PROVIDER_BN, readKds0031, loadSnapshot, loadLibs, readEnv, buildBillingModel, groupCsvUsers, repReceipt, csvTotals,
  buildMatchIndex, matchCsvUser, parseCsvLine, nfkc, nName, nKana, nInsurer, nInsured, nCare, nDate, nRate, nGender, toInt, ymOf, daysIn,
} = core;

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
const CLEANUP_BATCH = opt("--cleanup-batch");
const STEPS = ["master", "clients", "insurance", "kohi", "rentals"];
const STEP = opt("--step") ?? "all";
if (STEP !== "all" && !STEPS.includes(STEP)) { console.error(`--step は ${STEPS.join("|")}|all`); process.exit(1); }
const SHOW = (s) => STEP === "all" || STEP === s;
const GATES = ["replace-history", "with-assignments", "terminate-absent-rentals", "attach-billed-shared"];
const ENABLED = new Set(GATES.filter((g) => argv.includes(`--${g}`)));
// 対象事業所: 既定 ケアサポ (介護ショップ ケア・サポート千葉 1bfc0d57…)。--area / --office-bn で切替 (_fukuyogu_office.mjs)
//   事業所の番号 (PROVIDER_BN) は _honobono-sync-core.mts が同じ引数から決める
const FO = resolveFukuyoguOffice(argv);
if (!FO.isDefault) console.log(describeFukuyoguOffice(FO));
const DENSOU = FO.dir;
const REPO_ROOT = resolve(HERE, "../../..");
// --csv / --master-csv の既定はケアサポの固定ファイル (従来どおり)。ほかの事業所は必ず指定する (古い月を黙って読まないため)
if (!FO.isDefault && (!opt("--csv") || !opt("--master-csv"))) { console.error(`★ ${FO.area}: --csv <KDS0031> と --master-csv <FYGMST01_用具マスタ> を指定する (既定はケアサポのファイル)`); process.exit(1); }
const CSV_PATH = resolve(opt("--csv") ?? join(DENSOU, "202609/ほのぼのから/KDS0031_明細書明細付_処理R8-09.CSV"));
const MASTER_CSV = resolve(opt("--master-csv") ?? join(DENSOU, "マスタ/FYGMST01_用具マスタ_20261109.CSV"));
// 既定 = 最新の 利用者マスタ_YYYYMMDD (引数化の前は 20261109 に固定。ケアサポは今それしか無いので同じ)
const UM_DIR = resolve(opt("--user-master-dir") ?? resolveUserMasterDirs(DENSOU, [], { log: false }).on ?? join(DENSOU, "利用者マスタ_(未着)"));
const SCRIPT_REL = "apps/order-app/migrations/sync_fukuyogu_from_honobono.mjs";
let EXEC_LOCK = null; // 同じ script の同時 --execute を止める (_exec_lock.mjs)。--execute の最初に execLockStart で取る
const SOURCE_SYSTEM = "honobono-fukuyogu";

// ── 小道具 ────────────────────────────────────────────────────────────────
const clone = (x) => JSON.parse(JSON.stringify(x));
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const mode = (m) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
let seq = 0;
const newId = (kind) => `new:${kind}:${++seq}`;
const isNew = (id) => typeof id === "string" && id.startsWith("new:");
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const catFromServiceName = (s) => nfkc(s).replace(/^予防/, "").replace(/貸与$/, "");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const opEnabled = (op) => (op.gate ?? []).every((g) => ENABLED.has(g));
/** キー順を揃えた JSON (jsonb は保存時にキーを並べ替えるので、そのままでは比べられない) */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const relPath = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const dOrNull = (s) => nDate(s) || null;
/**
 * 負担割合 (copay_rate) は 給付率から決める。★ 表で単位が違う (同じ列名):
 *   clients.copay_rate                  = percent 表記 "10"/"20"/"30"
 *   client_insurance_records.copay_rate = 割 表記 "1"/"2"/"3"  (★ 認定に "10" を入れると 10 割負担に潰れる)
 * 給付率 90/80/70 以外 (0 = 公費単独・100・空) は決めない (null = 書かない)。
 * 2026-11-09: 当初版は benefit_rate だけ書き copay_rate を書いていなかった (fix_honobono_sync_shared_certs.mjs で後始末)。
 */
const clientCopayOf = (br) => ({ "90": "10", "80": "20", "70": "30" })[nRate(String(br ?? ""))] ?? null;
const certCopayOf = (br) => ({ "90": "1", "80": "2", "70": "3" })[nRate(String(br ?? ""))] ?? null;
const sOrNull = (s) => nfkc(s) || null;
const iOrNull = (s) => (nfkc(s) === "" ? null : toInt(s));
/** 比較用の正規化 (日付・要介護度・数値・文字) */
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
const noSpaceNfkc = (s) => nfkc(s).replace(/[\s　]+/g, "");

class Report {
  constructor() { this.m = new Map(); }
  add(cat, ex) { if (!this.m.has(cat)) this.m.set(cat, []); this.m.get(cat).push(ex); }
  toJSON() { return Object.fromEntries([...this.m].map(([k, v]) => [k, { count: v.length, items: v }])); }
  print(n = 3) {
    for (const [k, v] of this.m) {
      console.log(`  ${String(v.length).padStart(5)}  ${k}`);
      for (const e of v.slice(0, n)) console.log(`         - ${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
  }
}

function makeSb() {
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  return import("@supabase/supabase-js").then(({ createClient }) => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }));
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

/** ほのぼの 利用者管理 CSV (SJIS・ダブルクォート付き・ヘッダーあり) */
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
async function main() {
  if (REVERT) return revert(REVERT);
  if (CLEANUP_BATCH) return cleanupBatch(CLEANUP_BATCH);
  const libs = await loadLibs();
  const { computeFukuyoguAmounts, fukuyoguServiceCode, getPriceForMonth } = libs;

  // ── KDS0031 ─────────────────────────────────────────────────────────
  const { rows, monthCount } = readKds0031(CSV_PATH);
  const MONTH = opt("--month") ?? mode(monthCount);
  const MARK = `[honobono-sync-${MONTH.replace("-", "")}]`;
  const MDAYS = daysIn(MONTH);
  const monthStartS = `${MONTH}-01`;
  const monthEndS = `${MONTH}-${String(MDAYS).padStart(2, "0")}`;
  const AS_OF = opt("--as-of") ?? monthEndS;
  const mRows = rows.filter((r) => ymOf(r[C.SVC_MONTH]) === MONTH);
  const OUT_DIR = resolve(opt("--out-dir") ?? join(tmpdir(), `honobono-sync-${MONTH}`));
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`${EXECUTE ? "★★ EXECUTE (本番書込み)" : "DRY RUN (DB は書き換えない)"} / 段 = ${STEP} / 提供月 ${MONTH} / as-of ${AS_OF} / フラグ: ${[...ENABLED].map((g) => `--${g}`).join(" ") || "なし"}`);
  console.log(`KDS0031: ${CSV_PATH}\n  ${rows.length} 行 (当月 ${mRows.length})`);

  // ── FYGMST01 (引用符なし・カンマ区切り) ─────────────────────────────
  const hmLines = new TextDecoder("shift-jis").decode(readFileSync(MASTER_CSV)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const hmHead = parseCsvLine(hmLines[0]);
  const H = Object.fromEntries(["ID", "中止", "区分", "福祉用具種目", "商品名称", "型番", "TAISコード等", "単位数"].map((k) => {
    const i = hmHead.indexOf(k); if (i < 0) throw new Error(`★ FYGMST01 に列「${k}」が無い`); return [k, i];
  }));
  const hmBad = [], hmRows = [];
  for (const l of hmLines.slice(1)) {
    const r = parseCsvLine(l);
    if (r.length !== hmHead.length) { hmBad.push(l); continue; }
    hmRows.push({ id: r[H.ID], stop: r[H.中止] === "1", kubun: r[H.区分], cat: nfkc(r[H.福祉用具種目]), name: nfkc(r[H.商品名称]), model: nfkc(r[H.型番]), tais: nfkc(r[H.TAISコード等]), units: r[H.単位数] === "" ? null : toInt(r[H.単位数]) });
  }
  const hmByTais = groupBy(hmRows.filter((r) => r.tais && r.kubun === "レンタル"), (r) => r.tais);
  console.log(`FYGMST01: ${MASTER_CSV}\n  ${hmRows.length} 行 (列数不正で読めない ${hmBad.length} 行) / レンタル TAIS ${hmByTais.size} 種`);

  // ── 利用者管理 CSV ──────────────────────────────────────────────────
  const UB = readUserMasterCsv("基本情報_"), UK = readUserMasterCsv("介護保険_"), UP = readUserMasterCsv("公費_"), UF = readUserMasterCsv("負担割合証等_");
  const persons = new Map(); // `${利用者番号}|${生年月日}` → person
  const burden = new Map(); // `${保険者番号}|${被保番}` → 負担割合証 [{ rate, start, end }]
  let burdenUnmapped = 0;
  const provisional = []; // 利用者番号が空の仮登録 (入れない)
  {
    const b = (n) => UB.col(n);
    for (const r of UB.rows) {
      const no = nfkc(r[b("利用者番号")]), birth = nDate(r[b("生年月日")]);
      if (!no) { provisional.push({ 氏名: nfkc(r[b("利用者名")]), 生年月日: birth, 住所: nfkc(r[b("住所")]) }); continue; } // 仮登録 (番号なし・生年月日が仮)
      const pid = `${no}|${birth}`;
      if (persons.has(pid)) throw new Error(`★ 基本情報に 利用者番号+生年月日 の重複 ${pid}`);
      persons.set(pid, {
        pid, userNo: no, birth, name: nfkc(r[b("利用者名")]), kana: nfkc(r[b("フリガナ")]), sameName: nfkc(r[b("同名識別")]), gender: nGender(r[b("性別")]),
        postal: sOrNull(r[b("郵便番号")]), address: sOrNull(r[b("住所")]), phone: sOrNull(r[b("電話番号")]), mobile: sOrNull(r[b("携帯番号")]),
        death: dOrNull(r[b("死亡日")]), certs: [], kohi: [], keys: new Set(), raw: Object.fromEntries(["利用者番号", "利用者名", "フリガナ", "同名識別", "性別", "生年月日", "郵便番号", "住所", "電話番号", "携帯番号", "死亡日"].map((k) => [k, r[b(k)]])),
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
        start: dOrNull(r[q("有効期限－開始日")]), end: dOrNull(r[q("有効期限－終了日")]), kubun: nfkc(r[q("介護医療区分")]), seiho: nfkc(r[q("生活保護区分")]),
        appType: sOrNull(r[q("申請区分")]), special: sOrNull(r[q("特別区分")]), outpatient: iOrNull(r[q("外来負担金")]), inpatient: iOrNull(r[q("入院負担金")]),
        // 本人支払額 (介護券の月額。2026-11-09 追加 = client_public_expenses.self_pay_amount)。空欄 = null (0 円扱い)
        selfPay: iOrNull(r[q("本人支払額")]),
        raw: Object.fromEntries(["法制コード", "負担者番号", "受給者番号", "確認日", "有効期限－開始日", "有効期限－終了日", "生活保護区分", "介護医療区分"].map((n) => [n, r[q(n)]])),
      });
    }
    // 負担割合証: 利用者番号が無いので (保険者番号, 被保番) で結ぶ (保険者は名前なので介護保険 CSV の 名前→番号 で引く)
    const f = (n) => UF.col(n);
    for (const r of UF.rows) {
      if (nfkc(r[f("給付種類")]) !== "介護保険負担割合証" || nfkc(r[f("適用")]) !== "○") continue;
      const ino = insurerNameToNo.get(nfkc(r[f("保険者")]));
      if (!ino) { burdenUnmapped++; continue; }
      const key = `${ino}|${nInsured(r[f("被保険者番号")])}`;
      if (!burden.has(key)) burden.set(key, []);
      burden.get(key).push({ rate: nRate(r[f("給付率")]), start: dOrNull(r[f("有効開始日")]), end: dOrNull(r[f("有効終了日")]) });
    }
  }
  const pAll = [...persons.values()];
  for (const x of provisional) console.log(`  ⚠ 基本情報の仮登録 (利用者番号が空・生年月日が仮) は入れない: ${JSON.stringify(x)}`);
  console.log(`利用者管理 CSV: ${UM_DIR}\n  基本情報 ${pAll.length} 名 / 介護保険 ${UK.rows.length} 行 / 公費 ${UP.rows.length} 行 / 負担割合証 ${UF.rows.length} 行 (保険者名が引けず使えない ${burdenUnmapped} 行)`);
  const sourceFiles = [
    { path: relPath(CSV_PATH), sha256: sha256(CSV_PATH), rows: rows.length, kind: `KDS0031 明細書明細付 (提供 ${MONTH})` },
    { path: relPath(MASTER_CSV), sha256: sha256(MASTER_CSV), rows: hmLines.length - 1, kind: "FYGMST01 用具マスタ" },
    { path: relPath(UB.path), sha256: sha256(UB.path), rows: UB.rows.length, kind: "利用者管理 基本情報 (利用登録有)" },
    { path: relPath(UK.path), sha256: sha256(UK.path), rows: UK.rows.length, kind: "利用者管理 介護保険 (全件・保険と認定)" },
    { path: relPath(UP.path), sha256: sha256(UP.path), rows: UP.rows.length, kind: "利用者管理 公費 (全件)" },
    { path: relPath(UF.path), sha256: sha256(UF.path), rows: UF.rows.length, kind: "利用者管理 負担割合証等 (全件)" },
  ];
  const [SRC_KDS, SRC_HM, SRC_UB, SRC_UK, SRC_UP, SRC_UF] = sourceFiles.map((s) => s.path);
  /** その日に有効な認定 (認定済み優先・開始の新しい順) */
  const certAt = (p, day) => p.certs.filter((c) => c.start && c.start <= day && (!c.end || c.end >= day))
    .sort((a, b) => (a.status === "申請中") - (b.status === "申請中") || b.start.localeCompare(a.start))[0] ?? null;
  const rateAt = (c, day) => (burden.get(`${c.insurer}|${c.insured}`) ?? []).filter((x) => x.start && x.start <= day && (!x.end || x.end >= day)).sort((a, b) => b.start.localeCompare(a.start))[0]?.rate || c.rate || null;

  // ── DB ──────────────────────────────────────────────────────────────
  const cachePath = EXECUTE ? join(tmpdir(), `honobono_sync_db_${Date.now()}.json`) : resolve(opt("--db-cache") ?? join(tmpdir(), `honobono_sync_db_snapshot_${MONTH}.json`));
  const snap = await loadSnapshot(MONTH, cachePath, EXECUTE || argv.includes("--refresh"));
  const office = snap.offices.find((o) => (o.business_number ?? "").replace(/-/g, "") === PROVIDER_BN);
  if (!office) throw new Error(`offices に business_number=${PROVIDER_BN} が無い`);
  const OFFICE = office.id;
  const officeName = new Map(snap.offices.map((o) => [o.id, o.name]));
  console.log(`事業所: ${office.name} (${OFFICE})`);
  const sb = await makeSb();
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)

  // ── 計画 (sim = 反映後の想定データ。全フラグ有効で書き換えていく) ──────
  const sim = clone(snap);
  sim.coa = [];
  const ops = Object.fromEntries(STEPS.map((s) => [s, []]));
  const R = Object.fromEntries(STEPS.map((s) => [s, new Report()]));
  const csvUsers = groupCsvUsers(mRows);
  const TABLE_OF = (data) => ({ equipment_master: data.equipment, equipment_price_history: data.priceHist, clients: data.clients, client_insurance_records: data.ins,
    client_public_expenses: data.kohi, orders: data.orders, order_items: data.items, client_office_assignments: data.coa });
  const applyTo = (data, op) => {
    const list = TABLE_OF(data)[op.table];
    if (op.action === "observe") return;
    if (op.action === "insert") list.push({ id: op.id, ...op.row });
    else if (op.action === "delete") { const i = list.findIndex((x) => x.id === op.id); if (i >= 0) list.splice(i, 1); }
    else Object.assign(list.find((x) => x.id === op.id), op.patch);
  };
  const applyOp = (step, op) => { ops[step].push(op); applyTo(sim, op); };
  const receiptRef = (rr) => ({
    レセプト番号: rr[C.RECEIPT_NO], 利用者番号: nfkc(rr[C.USER_NO]), 氏名: nfkc(rr[C.NAME]), フリガナ: nfkc(rr[C.KANA]), 生年月日: rr[C.BIRTH], 性別: rr[C.GENDER],
    要介護度: rr[C.CARE_LEVEL], 認定開始: rr[C.CERT_START], 認定終了: rr[C.CERT_END], 保険者: rr[C.INSURER], 被保番: rr[C.INSURED], 給付率: rr[C.BENEFIT],
    居宅事業所番号: rr[C.CARE_OFFICE], 公費1負担者: rr[C.FUTAN1], 公費1受給者: rr[C.JUKYU1],
  });

  // ════ 1. master ═════════════════════════════════════════════════════
  const kdsTais = new Map();
  for (const r of rows) {
    const t = nfkc(r[C.TAIS]);
    if (!t) continue;
    const ym = ymOf(r[C.SVC_MONTH]);
    let a = kdsTais.get(t);
    if (!a) { a = { cur: new Map(), other: new Map(), half: [], items: new Set(), names: new Set() }; kdsTais.set(t, a); }
    a.items.add(nfkc(r[C.SVC_ITEM]).padStart(4, "0"));
    a.names.add(nfkc(r[C.SVC_NAME]));
    const u = toInt(r[C.SVC_UNITS]);
    if (toInt(r[C.DAYS]) === daysIn(ym)) { const m = ym === MONTH ? a.cur : a.other; m.set(u, (m.get(u) ?? 0) + 1); }
    else a.half.push(u);
  }
  const targetUnits = new Map(); // TAIS → { units, source }
  {
    const eqByTaisAny = new Map();
    for (const e of sim.equipment) for (const k of new Set([e.tais_code, e.product_code].filter(Boolean).map(nfkc))) {
      if (!eqByTaisAny.has(k)) eqByTaisAny.set(k, []); eqByTaisAny.get(k).push(e);
    }
    for (const [t, a] of kdsTais) {
      const item = [...a.items][0];
      const svcName = [...a.names][0];
      if (a.items.size > 1) R.master.add("KDS 内で同じ TAIS に複数のサービス項目コード (★ 一覧のみ)", { TAIS: t, 項目: [...a.items] });
      const full = a.cur.size ? a.cur : a.other;
      const kdsU = mode(full);
      if (full.size > 1) R.master.add("KDS 内で同じ TAIS の月額単位が複数 (最頻値を採用)", { TAIS: t, 単位と件数: Object.fromEntries(full) });
      // FYGMST01 の行: 中止=0 優先 → KDS の当月単位数と一致 → それでも複数なら 種目・単位数が同じなら先頭
      let hmC = hmByTais.get(t) ?? [];
      if (hmC.length > 1) { const live = hmC.filter((h) => !h.stop); if (live.length) hmC = live; }
      if (hmC.length > 1 && kdsU != null) { const m = hmC.filter((h) => h.units === kdsU); if (m.length) hmC = m; }
      let hm = hmC[0] ?? null;
      if (hmC.length > 1) {
        if (new Set(hmC.map((h) => `${h.cat}|${h.units}`)).size > 1) { R.master.add("FYGMST01 の行が決まらない (同じ TAIS で 種目/単位数 が違う行が複数。★ 一覧のみ)", { TAIS: t, 候補: hmC.map((h) => `${h.id}/${h.stop ? "中止" : "有効"}/${h.cat}/${h.name}/${h.units}`) }); hm = null; }
        else if (new Set(hmC.map((h) => h.name)).size > 1) R.master.add("FYGMST01 に同じ TAIS・同じ単位数で商品名違いが複数 (先頭を採用)", { TAIS: t, 候補: hmC.map((h) => `${h.id}/${h.name}`) });
      }
      // 正の単位数: KDS (実請求)。月を通した行が無いときだけ FYGMST01 を半月行で裏取りして使う
      let target = null, source = "";
      if (kdsU != null) { target = kdsU; source = a.cur.size ? "KDS 当月" : "KDS 他月 (月遅れ分)"; }
      else if (hm?.units != null && a.half.length && a.half.every((h) => h === Math.round(hm.units / 2))) { target = hm.units; source = "FYGMST01 (KDS は半月行のみ・半月額と整合)"; }
      else R.master.add("価格が決まらない (KDS に月を通した行が無く FYGMST01 でも裏が取れない。★ 価格は触らない)", { TAIS: t, KDS半月単位: a.half, FYGMST01: hm?.units ?? null });
      if (target != null) targetUnits.set(t, { units: target, source });
      if (hm && hm.units != null && target != null && hm.units !== target) R.master.add("FYGMST01 の単位数 と KDS (実請求) が違う (★ KDS を正にする。一覧のみ)", { TAIS: t, KDS: target, FYGMST01: hm.units, 商品名: hm.name });
      if (!hm) R.master.add("FYGMST01 に TAIS が無い / 決まらない", { TAIS: t, サービス項目: svcName });
      const src = {
        file: hm ? `${SRC_KDS} + ${SRC_HM}` : SRC_KDS, key: `TAIS:${t}${hm ? `|ほのぼの用具ID:${hm.id}` : ""}`,
        ref: { KDS: { 単位: target, 出どころ: source, 項目コード: [...a.items], サービス項目: [...a.names], 月通し単位と件数: Object.fromEntries(full), 半月行: a.half.length }, FYGMST01: hm },
      };
      const all = eqByTaisAny.get(t) ?? [];
      if (all.length > 1) R.master.add("equipment_master に同じ TAIS が複数行 (★ 直さず一覧)", { TAIS: t, DB: all.map((e) => `${e.product_code}/${e.category}/${e.rental_price}`) });
      const own = sim.equipment.filter((e) => e.product_code === t);
      const kdsCode = (cat) => { const c = fukuyoguServiceCode(cat); return c && c.slice(2) === item ? c : null; };
      if (own.length === 0) {
        if (target == null) { R.master.add("マスタに無いが価格が決まらないので追加しない", { TAIS: t }); continue; }
        const cat = [hm?.cat, catFromServiceName(svcName)].find((c) => c && kdsCode(c)) ?? null;
        if (!cat) { R.master.add("マスタに無いが種目からサービスコードが引けないので追加しない", { TAIS: t, FYGMST01種目: hm?.cat, サービス項目: svcName }); continue; }
        const viaTais = all[0] ?? null; // tais_code だけ一致する既存行 (EQ-xxxx)
        const name = hm?.name || viaTais?.name || `${cat} (TAIS ${t})`;
        if (!hm?.name) R.master.add("追加する行の商品名が FYGMST01 に無い (既存 EQ 行の名前 / 仮名)", { TAIS: t, 名前: name });
        applyOp("master", { table: "equipment_master", action: "insert", id: newId("eq"), src,
          row: { tenant_id: TENANT, product_code: t, tais_code: t, name, category: cat, kind: "single", rental_price: target * 10 },
          why: `マスタに product_code=TAIS の行が無い${viaTais ? " (tais_code 一致の EQ 行はあるが請求は product_code で引く)" : ""}`,
          ref: { TAIS: t, 名前: name, 型番: hm?.model || null, 単位: target, 単位の出どころ: source, tais一致の既存行: viaTais?.product_code ?? null } });
        continue;
      }
      for (const e of own) {
        if (!kdsCode(e.category)) R.master.add(fukuyoguServiceCode(e.category) ? "種目 (category) とサービス項目コードが合わない (★ 直さず一覧)" : "種目 (category) からサービスコードが引けない (★ 直さず一覧。請求に乗らない)", { TAIS: t, category: e.category, KDS項目: item, FYGMST01種目: hm?.cat ?? null });
        if (hm?.name && nName(hm.name) !== nName(e.name)) R.master.add("商品名の差 (equipment_master.name vs FYGMST01 商品名称。★ 直すかは user 判断)", { TAIS: t, DB: e.name, FYGMST01: hm.name });
        if (target == null) continue;
        if (e.rental_price !== target * 10) {
          const ratio = e.rental_price ? (target * 10) / e.rental_price : null;
          applyOp("master", { table: "equipment_master", action: "update", id: e.id, src, before: { rental_price: e.rental_price }, patch: { rental_price: target * 10 },
            why: ratio === 2 ? "DB が半額" : "価格差", ref: { TAIS: t, DB単位: e.rental_price == null ? null : Math.round(e.rental_price / 10), 正: target, 出どころ: source } });
        }
        const eff = getPriceForMonth(sim.priceHist, e.product_code, MONTH);
        if (eff != null && eff !== target * 10) {
          applyOp("master", { table: "equipment_price_history", action: "insert", id: newId("ph"), src,
            row: { tenant_id: TENANT, product_code: e.product_code, rental_price: target * 10, valid_from: monthStartS },
            why: "価格履歴が当月に効いていて食い違う (請求は履歴を先に見る)", ref: { TAIS: t, 履歴の当月価格: eff, 正: target * 10 } });
        }
      }
    }
  }
  for (const l of hmBad) R.master.add("FYGMST01 で列数が合わず読めない行 (商品名にカンマ? ★ 一覧のみ)", l.slice(0, 160));

  // ════ 2. clients ════════════════════════════════════════════════════
  const careOfficeByNo = groupBy(sim.careOffices.filter((c) => c.office_number), (c) => nfkc(c.office_number));
  const careOfficeByName = groupBy(sim.careOffices, (c) => nName(c.name));
  /** 居宅: 当月の請求があれば KDS の事業所番号、無ければ 支援事業所(正式名称) を care_offices の名前で引く */
  const careOfficeFor = (cert, kdsNo) => {
    if (kdsNo) return { co: careOfficeByNo.get(kdsNo)?.[0] ?? null, no: kdsNo, how: "KDS 事業所番号" };
    const byName = cert?.officeFull ? careOfficeByName.get(nName(cert.officeFull)) ?? careOfficeByName.get(nName(cert.office)) ?? [] : [];
    return byName.length === 1 ? { co: byName[0], no: nfkc(byName[0].office_number) || null, how: "支援事業所名" } : { co: null, no: null, how: byName.length > 1 ? "名前が複数一致" : cert?.officeFull ? "名前が一致しない" : "支援事業所なし" };
  };
  const personOfKds = new Map(); // csv key → person
  const kdsOfPerson = new Map(); // pid → CsvUser
  {
    const byNoBirth = new Map(pAll.map((p) => [`${p.userNo}|${p.birth}`, p]));
    const byKey = new Map();
    for (const p of pAll) for (const k of p.keys) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p); }
    for (const u of csvUsers.values()) {
      let p = byNoBirth.get(`${u.userNo}|${u.birth}`) ?? null;
      if (!p) { const c = (byKey.get(u.key) ?? []).filter((x) => x.birth === u.birth); if (c.length === 1) p = c[0]; }
      if (p) { personOfKds.set(u.key, p); kdsOfPerson.set(p.pid, u); }
      else R.clients.add("KDS0031 の当月請求者だが 基本情報 (利用登録有) に居ない (請求済み・登録終了? KDS の値で作る)", { 保険者: u.insurer, 被保番: u.insured, 利用者番号: u.userNo, 氏名: u.name });
    }
    for (const p of pAll) if (!kdsOfPerson.has(p.pid)) R.clients.add("基本情報 (利用登録有) に居るが KDS0031 の当月請求に居ない (★ 一覧のみ)", { 利用者番号: p.userNo, 氏名: p.name, 生年月日: p.birth, 当月認定: certAt(p, monthEndS)?.care ?? null });
  }
  // 1 利用者 = 「ほのぼのの値」。基本情報 + as-of の認定 を主に、KDS は居宅事業所番号と照合に使う
  const subjects = []; // { sid, person|null, kds|null, ex, desired: { client, careOffice }, src }
  for (const p of pAll) {
    const u = kdsOfPerson.get(p.pid) ?? null;
    const cert = certAt(p, AS_OF);
    const rr = u ? repReceipt(u, monthEndS) : null;
    const co = careOfficeFor(cert, rr ? nfkc(rr[C.CARE_OFFICE]) : null);
    subjects.push({
      sid: p.pid, person: p, kds: u, ex: { 利用者番号: p.userNo, 氏名: p.name, 生年月日: p.birth }, careOffice: co,
      client: {
        name: p.name, furigana: p.kana || null, birth_date: p.birth || null, gender: ["男", "女"].includes(p.gender) ? p.gender : null,
        postal_code: p.postal, address: p.address, phone: p.phone, mobile: p.mobile,
        care_level: cert?.care ?? null, certification_start_date: cert?.start ?? null, certification_end_date: cert?.end ?? null,
        insurer_number: cert?.insurer ?? null, insured_number: cert?.insured ?? null, benefit_rate: cert ? rateAt(cert, AS_OF) : null, copay_rate: cert ? clientCopayOf(rateAt(cert, AS_OF)) : null,
        ...(p.death ? { status: "deceased" } : {}),
      },
      noCert: !cert,
      src: { file: `${SRC_UB} + ${SRC_UK} + ${SRC_UF}`, key: `ほのぼの利用者番号:${p.userNo}|${cert ? `${cert.insurer}|${cert.insured}` : ""}|${p.birth}`, ref: { 基本情報: p.raw, 認定: cert?.raw ?? null, as_of: AS_OF } },
    });
    if (!cert) R.clients.add(`${AS_OF} に有効な認定が 介護保険 CSV に無い (clients の認定系の列は触らない)`, { 利用者番号: p.userNo, 氏名: p.name, 世代数: p.certs.length });
    // 照合: 当月の値が KDS と合うか
    if (u && cert && AS_OF === monthEndS) {
      const diffs = [];
      if (nCare(rr[C.CARE_LEVEL]) !== cert.care) diffs.push(`要介護度 ${cert.care}≠KDS ${nCare(rr[C.CARE_LEVEL])}`);
      if (nDate(rr[C.CERT_START]) !== cert.start || nDate(rr[C.CERT_END]) !== cert.end) diffs.push(`認定期間 ${cert.start}〜${cert.end}≠KDS ${nDate(rr[C.CERT_START])}〜${nDate(rr[C.CERT_END])}`);
      if (nInsured(rr[C.INSURED]) !== cert.insured || nInsurer(rr[C.INSURER]) !== cert.insurer) diffs.push("保険者/被保番");
      if (nRate(rr[C.BENEFIT]) !== rateAt(cert, AS_OF)) diffs.push(`給付率 ${rateAt(cert, AS_OF)}≠KDS ${nRate(rr[C.BENEFIT])}`);
      if (diffs.length) R.clients.add("利用者管理 CSV の当月値が KDS0031 と違う (★ 利用者管理 CSV を正にする。照合のための一覧)", { 利用者番号: p.userNo, 氏名: p.name, 差: diffs });
    }
    const curCert = certAt(p, new Date().toISOString().slice(0, 10));
    if (cert && curCert && (cert.start !== curCert.start || cert.care !== curCert.care)) R.clients.add(`as-of (${AS_OF}) と今日で有効な認定が違う (9 月の伝送には as-of の値。以後の月は入れ直しが要る)`, { 利用者番号: p.userNo, 氏名: p.name, as_of: `${cert.care}/${cert.start}`, 今日: `${curCert.care}/${curCert.start}` });
  }
  for (const u of csvUsers.values()) {
    if (personOfKds.has(u.key)) continue;
    const rr = repReceipt(u, monthEndS);
    subjects.push({
      sid: `kds:${u.key}`, person: null, kds: u, ex: { 保険者: u.insurer, 被保番: u.insured, 利用者番号: u.userNo, 氏名: u.name, 生年月日: u.birth },
      careOffice: careOfficeFor(null, nfkc(rr[C.CARE_OFFICE])),
      client: {
        name: u.name, furigana: u.kana || null, birth_date: u.birth || null, gender: ["男", "女"].includes(u.gender) ? u.gender : null,
        care_level: nCare(rr[C.CARE_LEVEL]) || null, certification_start_date: nDate(rr[C.CERT_START]) || null, certification_end_date: nDate(rr[C.CERT_END]) || null,
        insurer_number: nInsurer(rr[C.INSURER]) || null, insured_number: nInsured(rr[C.INSURED]) || null, benefit_rate: nRate(rr[C.BENEFIT]) || null, copay_rate: clientCopayOf(rr[C.BENEFIT]),
      },
      src: { file: SRC_KDS, key: u.key, ref: receiptRef(rr) },
    });
  }

  const resolvedS = new Map(); // sid → client_id (新規は new:client:n)
  const resolved = new Map(); // KDS csv key → client_id
  const outOfScope = new Map(); // client_id → 理由
  const sharedInfo = new Map(); // client_id → 共有の根拠
  {
    const m0 = buildBillingModel(sim, MONTH, OFFICE, libs);
    const idx = buildMatchIndex(sim);
    const byKanaBirth = groupBy(sim.clients, (c) => `${nKana(c.furigana)}|${nDate(c.birth_date)}`);
    const byUserNo = groupBy(sim.clients.filter((c) => c.user_number), (c) => nfkc(c.user_number));
    const pickOne = (cs, s) => {
      let x = cs;
      if (x.length > 1) { const t = x.filter((c) => !c.deleted_at); if (t.length) x = t; }
      if (x.length > 1) { const t = x.filter((c) => c.office_id === OFFICE); if (t.length) x = t; }
      if (x.length > 1) { const t = x.filter((c) => nfkc(c.user_number) === (s.person?.userNo ?? s.kds?.userNo)); if (t.length) x = t; }
      return x;
    };
    // (a) 突合: (保険者,被保番) 全世代 + 生年月日 → 利用者番号+生年月日 → 氏名/カナ+生年月日
    const found = [];
    for (const s of subjects) {
      const birth = s.client.birth_date;
      let c = null, how = "";
      if (s.person) {
        let cs = [...new Set([...s.person.keys].flatMap((k) => [...(idx.byKey.get(k) ?? [])]))].map((id) => m0.clientById.get(id));
        if (cs.length) { const t = cs.filter((x) => nDate(x.birth_date) === birth); if (t.length) cs = t; }
        cs = pickOne(cs, s);
        if (cs.length > 1) { R.clients.add("★ (保険者,被保番) で複数の client に一致 (絞れない。★ 触らない)", { ...s.ex, 候補: cs.map((x) => `${x.name}/${x.user_number}/${x.id}`) }); continue; }
        if (cs.length === 1) { c = cs[0]; how = "保険者+被保番"; }
      } else {
        const mr = matchCsvUser(s.kds, idx, m0.clientById, (cid) => m0.dbLines.has(cid) || m0.dbSkipped.has(cid));
        if (mr.status === "ambiguous") { R.clients.add("★ 保険者+被保番で複数の client に一致 (絞れない。★ 触らない)", { ...s.ex, 候補: mr.cands.map((x) => `${x.name}/${x.user_number}/${x.id}`) }); continue; }
        if (mr.status === "ok") { c = mr.client; how = mr.method; }
      }
      if (!c) {
        const byNo = pickOne((byUserNo.get(s.person?.userNo ?? s.kds.userNo) ?? []).filter((x) => nDate(x.birth_date) === birth), s);
        if (byNo.length === 1) { c = byNo[0]; how = "利用者番号+生年月日"; }
      }
      if (!c) {
        const cand = new Map();
        for (const x of [...(idx.byNameBirth.get(`${nName(s.client.name)}|${birth}`) ?? []), ...(s.client.furigana ? byKanaBirth.get(`${nKana(s.client.furigana)}|${birth}`) ?? [] : [])]) cand.set(x.id, x);
        const cs = pickOne([...cand.values()].filter((x) => !x.deleted_at), s);
        if (cs.length > 1) { R.clients.add("★ 氏名/カナ+生年月日で既存 client が複数 (新規にも既存にもしない)", { ...s.ex, 候補: cs.map((x) => `${x.name}/${x.user_number}/${x.office_id}/${x.id}`) }); continue; }
        if (cs.length === 1) { c = cs[0]; how = "氏名/カナ+生年月日"; }
      }
      if (!c) {
        // clients は (user_number, tenant_id) が UNIQUE (削除済みも含む)。同じ番号・同じ氏名なら同一人物 (DB の生年月日が誤値の例あり) → その行を使う
        const sameNo = byUserNo.get(s.person?.userNo ?? s.kds.userNo) ?? [];
        const sameName = sameNo.filter((x) => nName(x.name) === nName(s.client.name));
        if (sameName.length === 1) { c = sameName[0]; how = "利用者番号+氏名 (DB の生年月日が違う)"; R.clients.add("新規候補だが 同じ利用者番号・同じ氏名の client がある → その行を ほのぼのの値で上書き (生年月日も直す)", { ...s.ex, DB: `${c.name}/${c.birth_date}/${c.id}` }); }
        else if (sameNo.length) { R.clients.add("★ 利用者番号が既存 client と衝突 (氏名が違う / 同名が複数。UNIQUE のため insert できない → 飛ばす)", { ...s.ex, 既存: sameNo.map((x) => `${x.name}/${x.birth_date}/${officeName.get(x.office_id) ?? x.office_id}${x.deleted_at ? "(削除)" : ""}`) }); continue; }
      }
      found.push({ s, c, how });
    }
    const dupTarget = groupBy(found.filter((f) => f.c), (f) => f.c.id);
    for (const [cid, fs] of dupTarget) if (fs.length > 1) {
      R.clients.add("★ ほのぼのの 2 人以上が同じ client に当たる (★ 触らない)", { client_id: cid, ほのぼの: fs.map((f) => f.s.ex) });
      for (const f of fs) f.skip = true;
    }
    // (b) 共有の判定: ケアサポ以外の client_office_assignments (終了済みも含む) / clients.office_id がケアサポ以外
    const presentIds = new Set(found.filter((f) => f.c && !f.skip).map((f) => f.c.id));
    const careSupoIds = sim.clients.filter((c) => c.office_id === OFFICE && !c.deleted_at).map((c) => c.id);
    const wantIds = [...new Set([...presentIds, ...careSupoIds])].sort();
    const coaCache = cachePath.replace(/\.json$/, "") + "_coa.json";
    const cacheKey = createHash("sha1").update(wantIds.join(",")).digest("hex");
    let coa = null;
    if (!EXECUTE && existsSync(coaCache)) { const j = JSON.parse(readFileSync(coaCache, "utf8")); if (j.key === cacheKey) coa = j.rows; }
    if (!coa) {
      coa = await selectIn(sb, "client_office_assignments", "id,client_id,office_id,start_date,end_date", "client_id", wantIds, (q) => q.eq("tenant_id", TENANT));
      writeFileSync(coaCache, JSON.stringify({ key: cacheKey, rows: coa }));
    }
    sim.coa = clone(coa);
    console.log(`  client_office_assignments (対象 ${wantIds.length} 名ぶん・全事業所) ${coa.length} 行`);
    const coaBy = groupBy(coa, (a) => a.client_id);
    for (const id of wantIds) {
      const c = m0.clientById.get(id);
      const why = [...new Set((coaBy.get(id) ?? []).filter((a) => a.office_id !== OFFICE).map((a) => `割当:${officeName.get(a.office_id) ?? a.office_id}`))];
      if (c.office_id && c.office_id !== OFFICE) why.push(`clients.office_id:${officeName.get(c.office_id) ?? c.office_id}`);
      if (why.length) sharedInfo.set(id, why);
    }
    const hasCareSupoCoa = new Set(coa.filter((a) => a.office_id === OFFICE && (!a.end_date || a.end_date >= monthStartS)).map((a) => a.client_id));
    // (c) 書込みの計画
    const newNos = new Set(); // 今回新規に入れる利用者番号 (計画内の重複も UNIQUE 違反になる)
    for (const f of found) {
      if (f.skip) continue;
      const { s, c, how } = f;
      const co = s.careOffice;
      if (!co.co && co.how !== "支援事業所なし") R.clients.add(`居宅事業所が care_offices に引けない (${co.how}。care_office_id は触らない)`, { ...s.ex, 番号: co.no, 支援事業所: s.person ? certAt(s.person, AS_OF)?.officeFull ?? null : null });
      if (!c) {
        const no = s.person?.userNo ?? s.kds.userNo;
        if (!no) { R.clients.add("★ 新規候補の利用者番号が空 (ほのぼの側で未採番。user_number が NOT NULL・UNIQUE のため入れない → 飛ばす)", { ...s.ex }); continue; }
        if ((byUserNo.get(no) ?? []).length || newNos.has(no)) { R.clients.add("★ 新規の利用者番号が衝突 (UNIQUE のため insert できない → 飛ばす)", { ...s.ex }); continue; }
        newNos.add(no);
        const id = newId("client");
        const row = {
          tenant_id: TENANT, office_id: OFFICE, user_number: s.person?.userNo ?? s.kds.userNo, name: s.client.name, furigana: s.client.furigana, birth_date: s.client.birth_date, gender: s.client.gender,
          postal_code: s.client.postal_code ?? null, address: s.client.address ?? null, phone: s.client.phone ?? null, mobile: s.client.mobile ?? null,
          care_level: s.client.care_level, certification_start_date: s.client.certification_start_date, certification_end_date: s.client.certification_end_date,
          insurer_number: s.client.insurer_number, insured_number: s.client.insured_number, benefit_rate: s.client.benefit_rate, copay_rate: s.client.copay_rate ?? null, care_office_id: co.co?.id ?? null,
          is_facility: false, is_provisional: false, status: s.client.status ?? "active", deleted_at: null,
        };
        applyOp("clients", { table: "clients", action: "insert", id, why: s.person ? "新規 (基本情報)" : "新規 (KDS のみ)", ref: s.ex, src: s.src, row });
        applyOp("clients", { table: "client_office_assignments", action: "insert", id: newId("coa"), why: "新規利用者の自事業所割当", ref: s.ex, src: s.src,
          row: { tenant_id: TENANT, client_id: id, office_id: OFFICE, start_date: monthStartS, end_date: null } });
        resolvedS.set(s.sid, id);
        if (s.kds) resolved.set(s.kds.key, id);
        continue;
      }
      resolvedS.set(s.sid, c.id);
      if (s.kds) resolved.set(s.kds.key, c.id);
      const shared = sharedInfo.get(c.id) ?? null;
      if (how !== "保険者+被保番") R.clients.add(`保険者+被保番以外で一致: ${how}`, { ...s.ex, DB: `${c.name}/${c.insurer_number}|${c.insured_number}/${c.id}` });
      if (shared) R.clients.add("共有の利用者 (kaigo-app でも使用) — clients は上書きしない (ほのぼのの値は observe で控える)", { ...s.ex, client_id: c.id, 根拠: shared });
      if (c.deleted_at) { outOfScope.set(c.id, "削除済み"); R.clients.add("★ 一致した client が削除済み (★ 復活させない。user 判断)", { ...s.ex, client_id: c.id }); }
      // ほのぼの優先で上書き (正規化して違うときだけ書く。ほのぼの側が空の項目は消さない)
      const patch = {}, before = {};
      for (const [col, v] of Object.entries(s.client)) {
        if (v == null || v === "") continue;
        if (s.noCert && /care_level|certification|insur|benefit|copay/.test(col)) continue;
        if (normFor(col, c[col] ?? null) !== normFor(col, v)) { patch[col] = v; before[col] = c[col] ?? null; }
      }
      const curCoNo = c.care_office_id ? m0.careOfficeNo.get(c.care_office_id) ?? "" : "";
      if (co.co && curCoNo !== (co.no ?? "")) { patch.care_office_id = co.co.id; before.care_office_id = c.care_office_id; }
      if (!c.deleted_at && c.office_id !== OFFICE) {
        if (c.office_id) { outOfScope.set(c.id, `office_id=${officeName.get(c.office_id) ?? c.office_id}`); R.clients.add("★ office_id が他事業所 (付け替えない。user 判断)", { ...s.ex, client_id: c.id, office: officeName.get(c.office_id) ?? c.office_id }); }
        else { patch.office_id = OFFICE; before.office_id = null; if (shared && !(s.kds && ENABLED.has("attach-billed-shared"))) outOfScope.set(c.id, s.kds ? "office_id が空 (共有。--attach-billed-shared で付く)" : "office_id が空 (共有・当月請求なしのため付けない)"); }
      }
      if (shared) {
        // 共有で office_id が空・KDS の当月請求者に突合できた人だけ office_id をケアサポに (他の列は書かない。user 決定 2026-11-09)
        if (patch.office_id && s.kds) {
          applyOp("clients", { table: "clients", action: "update", id: c.id, before: { office_id: null }, patch: { office_id: OFFICE }, gate: ["attach-billed-shared"], src: s.src,
            why: "共有・office_id が空・KDS (当月) で請求済み → office_id だけケアサポに", ref: { ...s.ex, client_id: c.id } });
        }
        if (patch.office_id) { delete patch.office_id; delete before.office_id; }
        // 共有: 書かない。ほのぼのの値 (被保番・要介護度・認定期間・給付率・居宅) と 書いたら変わる列を控えるだけ
        applyOp("clients", { table: "clients", action: "observe", id: c.id, before, patch, why: Object.keys(patch).length ? "共有のため上書きしない (差あり・控えのみ)" : "共有のため上書きしない (差なし・控えのみ)", ref: s.ex,
          src: { ...s.src, ref: { ...s.src.ref, ほのぼのの値: { ...s.client, 居宅事業所番号: co.no, 居宅事業所名: s.person ? certAt(s.person, AS_OF)?.officeFull ?? null : null } } } });
      } else if (Object.keys(patch).length) applyOp("clients", { table: "clients", action: "update", id: c.id, before, patch, src: s.src, why: patch.office_id ? "ほのぼの優先で上書き + office_id をケアサポに" : "ほのぼの優先で上書き", ref: s.ex });
      if (!hasCareSupoCoa.has(c.id) && !c.deleted_at) {
        applyOp("clients", { table: "client_office_assignments", action: "insert", id: newId("coa"), gate: ["with-assignments"], src: s.src, why: "ケアサポの割当が無い", ref: s.ex,
          row: { tenant_id: TENANT, client_id: c.id, office_id: OFFICE, start_date: monthStartS, end_date: null } });
        hasCareSupoCoa.add(c.id);
      }
    }
    // ほのぼのに居ない現ケアサポ所属者は外さない (user 決定 2026-11-09)。件数だけ出す
    const presentNow = new Set(resolvedS.values());
    for (const id of careSupoIds) if (!presentNow.has(id)) { const c = m0.clientById.get(id); R.clients.add("ほのぼのに居ない現ケアサポ所属者 (★ 外さない。当月有効の貸与明細は rentals 段で終了)", { 氏名: c.name, 利用者番号: c.user_number, 共有: sharedInfo.get(id) ?? null }); }
  }

  // ════ 3. insurance ══════════════════════════════════════════════════
  const triggerEst = { care_plan_elements_insurance: { plan_renewal: 0, plan_change: 0, care_office_change: 0, 注: "client_insurance_records は 古い順に 1 行ずつ入れる前提の見込み (trigger は「この行以外で effective_date が最新の行」と比べる)" } };
  {
    const m1 = buildBillingModel(sim, MONTH, OFFICE, libs);
    const INS_COLS = ["care_level", "certification_end_date", "insurer_number", "insurer_name", "insured_number", "benefit_rate", "certification_status", "certification_date",
      "issued_date", "insurance_confirmed_date", "qualification_date", "insurance_valid_start", "insurance_valid_end", "limit_period_start", "limit_period_end",
      "service_limit_amount", "care_manager", "care_manager_org", "care_office_name", "service_restriction", "service_memo", "copay_rate"];
    for (const s of subjects) {
      const cid = resolvedS.get(s.sid);
      if (!cid) continue;
      const shared = sharedInfo.get(cid) ?? null;
      const mine = (m1.insByClient.get(cid) ?? []).slice();
      const used = new Set();
      // ほのぼのの認定 (全世代)。KDS のみの人は KDS の当月認定 1 件
      const gens = s.person ? s.person.certs.filter((c) => c.start).map((c) => {
        const co = careOfficeFor(c, s.kds && certAt(s.person, monthEndS) === c ? nfkc(repReceipt(s.kds, monthEndS)[C.CARE_OFFICE]) : null);
        const at = c.end && c.end < AS_OF ? c.end : AS_OF < c.start ? c.start : AS_OF;
        return { row: {
          care_level: c.care, certification_start_date: c.start, certification_end_date: c.end, insurer_number: c.insurer || null, insurer_name: c.insurerName,
          insured_number: c.insured || null, benefit_rate: rateAt(c, at), copay_rate: certCopayOf(rateAt(c, at)), certification_status: c.care ? "認定済み" : "申請中", certification_date: c.certDate,
          issued_date: c.issued, insurance_confirmed_date: c.confirmed, qualification_date: c.qualified, insurance_valid_start: c.insStart, insurance_valid_end: c.insEnd,
          limit_period_start: c.limStart, limit_period_end: c.limEnd, service_limit_amount: c.limit, care_manager: c.cm, care_manager_org: c.office, care_office_name: c.officeFull,
          service_restriction: c.restriction ?? "なし", service_memo: c.memo, care_office_id: co.co?.id ?? null, care_office_number: co.no,
        }, src: { file: `${SRC_UK} + ${SRC_UF}`, key: `ほのぼの利用者番号:${s.person.userNo}|${c.insurer}|${c.insured}|認定開始:${c.start}`, ref: c.raw } };
      }) : (() => {
        const rr = repReceipt(s.kds, monthEndS);
        return [{ row: {
          care_level: s.client.care_level, certification_start_date: s.client.certification_start_date, certification_end_date: s.client.certification_end_date,
          insurer_number: s.client.insurer_number, insured_number: s.client.insured_number, benefit_rate: s.client.benefit_rate, copay_rate: certCopayOf(s.client.benefit_rate), certification_status: "認定済み",
          care_office_id: s.careOffice.co?.id ?? null, care_office_number: s.careOffice.no,
        }, src: { file: SRC_KDS, key: s.kds.key, ref: receiptRef(rr) } }];
      })();
      if (s.person) for (const c of s.person.certs) if (c.status === "申請中" && c.care) R.insurance.add("ほのぼのの認定状況=申請中 だが要介護度あり (区分変更・更新の申請中と見て 認定済み で入れる。申請中 にすると BillingTab が月遅れ扱いにして伝送から外す)", { ...s.ex, 認定: `${c.care}/${c.start}〜${c.end}` });
      const inserts = [];
      for (const g of gens) {
        const ex = mine.find((r) => !used.has(r.id) && nDate(r.certification_start_date) === g.row.certification_start_date && (!r.insured_number || nInsured(r.insured_number) === nInsured(g.row.insured_number)));
        if (ex) {
          used.add(ex.id);
          const patch = {}, before = {};
          for (const col of INS_COLS) {
            const v = g.row[col];
            if (v == null || v === "") continue;
            // ★ 2026-11-13: 認定済み → 申請中 には下げない。ほのぼのの「申請中」は 更新申請中の印で、その期間も請求している
            //   (5 名で 4〜9 月の KDS と照合して確認)。下げると BillingTab が月遅れ扱いにして 当方だけ請求を止めてしまう
            if (col === "certification_status" && !mayOverwriteCertStatus(ex.certification_status, v)) {
              R.insurance.add("認定済み → 申請中 には下げない (ほのぼのの申請中 = 更新申請中の印)", { ...s.ex, 認定: `${ex.care_level ?? ""}/${g.row.certification_start_date}〜${g.row.certification_end_date}` });
              continue;
            }
            if (normFor(col, ex[col] ?? null) !== normFor(col, v)) { patch[col] = v; before[col] = ex[col] ?? null; }
          }
          if (g.row.care_office_id && ex.care_office_id !== g.row.care_office_id) { patch.care_office_id = g.row.care_office_id; patch.care_office_number = g.row.care_office_number; before.care_office_id = ex.care_office_id; before.care_office_number = ex.care_office_number ?? null; }
          if (Object.keys(patch).length) applyOp("insurance", { table: "client_insurance_records", action: shared ? "observe" : "update", id: ex.id, before, patch, src: g.src,
            why: shared ? "共有のため既存の認定は更新しない (差あり・控えのみ)" : "同じ認定開始日の行を ほのぼのの値に更新", ref: { ...s.ex, 認定: `${g.row.care_level}/${g.row.certification_start_date}〜${g.row.certification_end_date}` } });
        } else inserts.push(g);
      }
      // 古い順に追加 (trigger の見込みも同じ順で数える)
      inserts.sort((a, b) => a.row.certification_start_date.localeCompare(b.row.certification_start_date));
      const officeOk = (sim.clients.find((c) => c.id === cid)?.office_id ?? null) != null;
      const live = mine.filter((r) => used.has(r.id) || shared); // 置き換えで消える行は比較相手にならない
      for (const g of inserts) {
        const row = { tenant_id: TENANT, client_id: cid, effective_date: g.row.certification_start_date, ...g.row, birth_date: s.client.birth_date, notes: MARK };
        const prev = live.slice().sort((a, b) => (b.effective_date ?? b.certification_start_date ?? "").localeCompare(a.effective_date ?? a.certification_start_date ?? ""))[0];
        if (officeOk && prev && prev.care_level && !["申請中", "apply"].includes(prev.care_level)) {
          if (prev.certification_end_date && row.certification_start_date === addDays(prev.certification_end_date, 1)) triggerEst.care_plan_elements_insurance.plan_renewal++;
          else if (prev.certification_end_date && row.certification_start_date < prev.certification_end_date && nCare(prev.care_level) !== nCare(row.care_level)) triggerEst.care_plan_elements_insurance.plan_change++;
          if ((prev.care_office_id ?? null) !== row.care_office_id) triggerEst.care_plan_elements_insurance.care_office_change++;
        }
        live.push(row);
        applyOp("insurance", { table: "client_insurance_records", action: "insert", id: newId("ins"), row, src: g.src, why: s.person ? "ほのぼのの認定 (全世代) で DB に無い世代" : "KDS の当月認定で DB に無い",
          ref: { ...s.ex, 認定: `${row.care_level}/${row.certification_start_date}〜${row.certification_end_date}` } });
      }
      // ほのぼのに無い既存行: 専用の人は --replace-history で削除 / 共有の人は残す
      if (s.person) for (const r of mine) {
        if (used.has(r.id)) continue;
        if (shared) { R.insurance.add("共有の人の ほのぼのに無い既存認定 (★ 残す)", { ...s.ex, 認定: `${r.care_level}/${r.certification_start_date}〜${r.certification_end_date}`, id: r.id }); continue; }
        applyOp("insurance", { table: "client_insurance_records", action: "delete", id: r.id, before: r, gate: ["replace-history"], why: "ほのぼのに無い既存認定 (福祉用具専用の人)",
          src: { file: SRC_UK, key: `ほのぼの利用者番号:${s.person.userNo}`, ref: { 理由: "介護保険 CSV (全件) に同じ認定開始日の世代が無い" } },
          ref: { ...s.ex, 認定: `${r.care_level}/${r.certification_start_date}〜${r.certification_end_date}` } });
      }
    }
    // 入れた後に 当月に選ばれる認定 (pickIns) が KDS の認定と同じか
    const m1b = buildBillingModel(sim, MONTH, OFFICE, libs);
    for (const u of csvUsers.values()) {
      const cid = resolved.get(u.key);
      if (!cid) continue;
      const rr = repReceipt(u, monthEndS);
      const p = m1b.pickIns(cid);
      if (!p || nDate(p.certification_start_date) !== nDate(rr[C.CERT_START]) || nCare(p.care_level) !== nCare(rr[C.CARE_LEVEL]))
        R.insurance.add(`★ 反映後 (全フラグ) も当月に選ばれる認定が KDS と違う${sharedInfo.has(cid) ? " — 共有" : ""}`, { 氏名: u.name, 被保番: u.insured, 選ばれる: p ? `${p.care_level}/${p.certification_start_date}〜${p.certification_end_date}/eff ${p.effective_date}/${p.certification_status}` : null, KDS: `${nCare(rr[C.CARE_LEVEL])}/${nDate(rr[C.CERT_START])}〜${nDate(rr[C.CERT_END])}` });
    }
  }

  // ════ 4. kohi ═══════════════════════════════════════════════════════
  {
    // 本人支払額の列 (migrations/fukuyogu_kohi_month_mode.sql) があるか。無い DB では本人支払額を書かない
    //   (SELECT 1 件で見る。わざとエラーを起こして調べるのではない)
    const { error: spErr } = await sb.from("client_public_expenses").select("id, self_pay_amount").limit(1);
    const selfPayCol = !spErr;
    const selfPayById = new Map();
    if (!selfPayCol) {
      console.log(`  ⚠ client_public_expenses.self_pay_amount が無い (${spErr.message}) — 本人支払額は書かない (migrations/fukuyogu_kohi_month_mode.sql 未適用)`);
    } else {
      const ids = sim.kohi.map((k) => k.id).filter((id) => !isNew(id));
      for (const r of await selectIn(sb, "client_public_expenses", "id, self_pay_amount", "id", ids)) selfPayById.set(r.id, r.self_pay_amount ?? null);
    }
    const m2 = buildBillingModel(sim, MONTH, OFFICE, libs);
    for (const s of subjects) {
      const cid = resolvedS.get(s.sid);
      if (!cid) continue;
      const shared = sharedInfo.get(cid) ?? null;
      const mine = m2.kohiByClient.get(cid) ?? [];
      const used = new Set();
      const want = s.person ? s.person.kohi.map((k) => ({ k, src: { file: SRC_UP, key: `ほのぼの利用者番号:${s.person.userNo}|${k.fut}|${k.jyu}|${k.start}`, ref: k.raw } }))
        : desiredKohiFromKds(s.kds).map((k) => ({ k, src: { file: SRC_KDS, key: s.kds.key, ref: receiptRef(repReceipt(s.kds, monthEndS)) } }));
      for (const { k, src } of want) {
        if (k.kubun && k.kubun !== "介護") { R.kohi.add("介護医療区分が 介護 でない (入れない)", { ...s.ex, ...k.raw }); continue; }
        if (!/^\d{8}$/.test(k.fut)) { R.kohi.add("負担者番号が 8 桁にならない (入れない)", { ...s.ex, 負担者: k.fut }); continue; }
        const hit = mine.find((e) => !used.has(e.id) && nfkc(e.futan_sha_number) === k.fut && (nfkc(e.jukyu_sha_number) || null) === k.jyu && (e.valid_start ?? null) === k.start && (e.valid_end ?? null) === k.end);
        if (hit) {
          used.add(hit.id);
          // 本人支払額: 既存行と違えば直す (共有の人は書かず控えるだけ)。列が無い DB では何もしない
          const want = k.selfPay ?? null;
          const have = selfPayById.has(hit.id) ? selfPayById.get(hit.id) : null;
          if (selfPayCol && want !== have && !(want == null && have == null)) {
            const op = { table: "client_public_expenses", id: hit.id, before: { self_pay_amount: have }, patch: { self_pay_amount: want }, src,
              ref: { ...s.ex, 期間: `${k.start}〜${k.end}`, 本人支払額: `${have ?? "空"} → ${want ?? "空"}` } };
            if (shared) applyOp("kohi", { ...op, action: "observe", why: "共有のため本人支払額を上書きしない (控えのみ)" });
            else applyOp("kohi", { ...op, action: "update", why: "ほのぼのの本人支払額と違う" });
          }
          continue;
        }
        applyOp("kohi", { table: "client_public_expenses", action: "insert", id: newId("kohi"), why: s.person ? "ほのぼのの公費 (全件) で DB に無い行" : "KDS の公費で DB に無い", ref: { ...s.ex, 期間: `${k.start}〜${k.end}` }, src,
          row: { tenant_id: TENANT, client_id: cid, hohei_code: k.hob, futan_sha_number: k.fut, jukyu_sha_number: k.jyu, valid_start: k.start, valid_end: k.end,
            confirmed_date: k.confirmed ?? null, application_type: k.appType ?? null, special_type: k.special ?? null, outpatient_copay: k.outpatient ?? null, inpatient_copay: k.inpatient ?? null,
            // 本人支払額は列がある DB で値があるときだけ書く (列が無い DB に送ると insert が落ちる)
            ...(selfPayCol && k.selfPay != null ? { self_pay_amount: k.selfPay } : {}) } });
      }
      if (s.person) for (const e of mine) {
        if (used.has(e.id)) continue;
        if (shared) { R.kohi.add("共有の人の ほのぼのに無い既存公費 (★ 残す)", { ...s.ex, DB: `${e.hohei_code}/${e.futan_sha_number}/${e.jukyu_sha_number}/${e.valid_start}〜${e.valid_end}` }); continue; }
        applyOp("kohi", { table: "client_public_expenses", action: "delete", id: e.id, before: e, gate: ["replace-history"], why: "ほのぼのに無い既存公費 (福祉用具専用の人)",
          src: { file: SRC_UP, key: `ほのぼの利用者番号:${s.person.userNo}`, ref: { 理由: "公費 CSV (全件) に同じ (負担者, 受給者, 期間) の行が無い" } },
          ref: { ...s.ex, DB: `${e.hohei_code}/${e.futan_sha_number}/${e.jukyu_sha_number}/${e.valid_start}〜${e.valid_end}` } });
      }
    }
    const m2b = buildBillingModel(sim, MONTH, OFFICE, libs);
    for (const u of csvUsers.values()) {
      const cid = resolved.get(u.key);
      if (!cid) continue;
      const fut = nfkc(repReceipt(u, monthEndS)[C.FUTAN1]);
      const k = m2b.pickKohi(cid);
      if ((fut || null) !== (k ? nfkc(k.futan_sha_number) : null)) R.kohi.add("★ 反映後 (全フラグ) も当月の公費が KDS と違う", { 氏名: u.name, 被保番: u.insured, KDS: fut || null, DB: k ? `${k.futan_sha_number}/${k.valid_start}〜${k.valid_end}` : null });
    }
  }
  function desiredKohiFromKds(u) {
    const rr = repReceipt(u, monthEndS);
    return [[C.FUTAN1, C.JUKYU1], [C.FUTAN2, C.JUKYU2], [C.FUTAN3, C.JUKYU3]].map(([f, j]) => nfkc(rr[f]) ? { hob: nfkc(rr[f]).slice(0, 2), fut: nfkc(rr[f]), jyu: nfkc(rr[j]) || null, start: monthStartS, end: null, kubun: "介護", raw: { 負担者: rr[f], 受給者: rr[j] } } : null).filter(Boolean);
  }

  // ════ 5. rentals ════════════════════════════════════════════════════
  const terminations = []; // { itemId, clientId, tais, why }
  {
    const m3 = buildBillingModel(sim, MONTH, OFFICE, libs);
    const eqCodes = new Set(sim.equipment.map((e) => e.product_code));
    const itemsByClient = new Map();
    for (const it of sim.items) {
      if (!m3.isActive(it)) continue;
      const o = m3.ordersById.get(it.order_id);
      if (!o?.client_id || o.office_id !== OFFICE) continue;
      if (!itemsByClient.has(o.client_id)) itemsByClient.set(o.client_id, []);
      itemsByClient.get(o.client_id).push(it);
    }
    const orderFor = new Map();
    for (const u of csvUsers.values()) {
      const cid = resolved.get(u.key);
      if (!cid) continue;
      const ex = { 保険者: u.insurer, 被保番: u.insured, 氏名: u.name };
      if (outOfScope.has(cid)) R.rentals.add("利用者が請求の範囲外のまま (用具は揃えるが、clients 段の判断が要る)", { ...ex, 理由: outOfScope.get(cid) });
      const cg = groupBy(u.lines, (l) => l.tais);
      const dg = groupBy(itemsByClient.get(cid) ?? [], (it) => it.product_code);
      for (const [tais, cl] of cg) {
        const src = { file: SRC_KDS, key: `${u.key}|TAIS:${tais}`, ref: { 明細: cl } };
        const d = dg.get(tais) ?? [];
        const dQty = d.reduce((s, it) => s + (it.quantity ?? 1), 0);
        if (d.length === 0) {
          if (!eqCodes.has(tais)) { R.rentals.add("CSV のみの用具だが equipment_master に無い (master 段で追加できなかった。★ 入れない)", { ...ex, TAIS: tais }); continue; }
          let oid = orderFor.get(cid);
          if (!oid) {
            oid = sim.orders.find((o) => o.client_id === cid && o.office_id === OFFICE && o.status !== "cancelled" && (o.payment_type ?? "介護") === "介護")?.id;
            if (!oid) {
              oid = newId("order");
              applyOp("rentals", { table: "orders", action: "insert", id: oid, why: "利用者にケアサポの注文が無い", ref: ex, src: { file: SRC_KDS, key: u.key, ref: { 用途: "CSV のみの用具を入れる器" } }, row: {
                tenant_id: TENANT, client_id: cid, office_id: OFFICE, payment_type: "介護", status: "completed", ordered_at: monthStartS, delivery_date: monthStartS,
                delivery_type: "直納", attendance_required: false, attendee_ids: [], email_sent_count: 0, merged_from_order_ids: [], notes: MARK,
              } });
            }
            orderFor.set(cid, oid);
          }
          // 日数が月の日数より少ない行 = 月途中の開始とみなし 開始日 = 末日 - 日数 + 1 (半月按分を再現)
          for (const [days, ls] of groupBy(cl, (l) => l.days)) {
            const start = days > 0 && days < MDAYS ? addDays(monthStartS, MDAYS - days) : monthStartS;
            if (start !== monthStartS) R.rentals.add("CSV のみの用具が月途中から (開始日を 末日-日数+1 で仮置き)", { ...ex, TAIS: tais, 日数: days, 開始: start });
            applyOp("rentals", { table: "order_items", action: "insert", id: newId("item"), cid, why: "CSV のみの用具", ref: { ...ex, TAIS: tais, 単位: ls.map((l) => l.units) }, src, row: {
              tenant_id: TENANT, order_id: oid, product_code: tais, quantity: ls.length, status: "rental_started", payment_type: "介護",
              rental_start_date: start, rental_end_date: null, cancelled_at: null, rental_price: (targetUnits.get(tais)?.units ?? 0) * 10 || null, notes: MARK,
            } });
          }
          continue;
        }
        // DB にある用具で KDS が月途中 (日数 < 月の日数) → 月途中の終了・入院の可能性 (★ 終了日は user 判断)
        if (cl.every((l) => l.days > 0 && l.days < MDAYS)) {
          // KDS では月途中まで → 終了日 = 月初 + 日数 - 1 で terminated (半月按分が KDS と同じになる)
          const end = addDays(monthStartS, Math.max(...cl.map((l) => l.days)) - 1);
          for (const it of d) applyOp("rentals", { table: "order_items", action: "update", id: it.id, cid, gate: ["terminate-absent-rentals"], src,
            before: { status: it.status, rental_end_date: it.rental_end_date }, patch: { status: "terminated", rental_end_date: end },
            why: "KDS では月途中まで (終了日 = 月初 + 日数 - 1)", ref: { ...ex, TAIS: tais, 日数: cl.map((l) => l.days), 終了日: end } });
        }
        if (cl.length === dQty) continue;
        if (cl.length > dQty) {
          const it = d[0];
          applyOp("rentals", { table: "order_items", action: "update", id: it.id, cid, src, before: { quantity: it.quantity }, patch: { quantity: (it.quantity ?? 1) + (cl.length - dQty) }, why: "数量が CSV より少ない", ref: { ...ex, TAIS: tais, CSV行数: cl.length, DB数量: dQty } });
          continue;
        }
        let excess = dQty - cl.length;
        for (const it of d) {
          if (excess <= 0) break;
          const q = it.quantity ?? 1;
          if (q > 1) {
            const dec = Math.min(q - 1, excess);
            applyOp("rentals", { table: "order_items", action: "update", id: it.id, cid, src, before: { quantity: q }, patch: { quantity: q - dec }, why: "数量が CSV より多い", ref: { ...ex, TAIS: tais, CSV行数: cl.length, DB数量: dQty } });
            excess -= dec;
          }
        }
        for (const it of d.slice().reverse()) {
          if (excess <= 0) break;
          if ((it.quantity ?? 1) === 1 && d.length > 1) { terminations.push({ itemId: it.id, clientId: cid, tais, why: "同じ TAIS の明細が CSV より多い", ref: ex }); excess--; }
        }
      }
      for (const [tais, d] of dg) if (!cg.has(tais)) for (const it of d) terminations.push({ itemId: it.id, clientId: cid, tais, why: "DB のみの用具 (CSV に無い TAIS)", ref: ex });
    }
    const resolvedIds = new Set(resolved.values());
    const personIds = new Set(subjects.filter((x) => x.person).map((x) => resolvedS.get(x.sid)).filter(Boolean));
    const otherMonthKeys = new Set(rows.filter((r) => ymOf(r[C.SVC_MONTH]) !== MONTH).map((r) => `${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}`));
    const m3b = buildBillingModel(snap, MONTH, OFFICE, libs); // 反映前の請求対象 (所属を外す前)
    for (const cid of m3b.dbTargets) {
      if (resolvedIds.has(cid)) continue;
      const c = m3b.clientById.get(cid);
      const late = otherMonthKeys.has(`${nInsurer(c.insurer_number)}|${nInsured(c.insured_number)}`);
      const reg = personIds.has(cid) ? "・基本情報 (利用登録有) には居る" : "";
      for (const it of itemsByClient.get(cid) ?? []) terminations.push({ itemId: it.id, clientId: cid, tais: it.product_code, why: `利用者が KDS の当月請求にいない${late ? " (他月 = 月遅れ分にはいる)" : ""}${reg}`, ref: { 氏名: c.name, 利用者番号: c.user_number, 被保番: c.insured_number } });
    }
  }
  const prevEnd = addDays(monthStartS, -1);
  for (const t of terminations) {
    const it = sim.items.find((x) => x.id === t.itemId);
    applyOp("rentals", { table: "order_items", action: "update", id: t.itemId, cid: t.clientId, gate: ["terminate-absent-rentals"],
      before: { status: it.status, rental_end_date: it.rental_end_date }, patch: { status: "terminated", rental_end_date: prevEnd },
      why: `KDS (当月) に無い — ${t.why}`, ref: { ...t.ref, TAIS: t.tais },
      src: { file: SRC_KDS, key: `client:${t.clientId}|TAIS:${t.tais}`, ref: { 理由: `KDS0031 (提供 ${MONTH}) に この利用者のこの TAIS の明細が無い — ${t.why}`, 終了日: prevEnd } } });
  }
  // 終了 (rental_started → terminated) の trigger 見込み: その利用者に rental_started が残る間は 一部解約 (doc_tasks 2 + care_plan_elements 1)
  const termOps = ops.rentals.filter((o) => o.patch?.status === "terminated");
  const termEst = { 明細: termOps.length, 利用者: new Set(termOps.map((o) => o.cid)).size, doc_tasks_partial_termination: 0, care_plan_elements_partial_termination: 0, 全解約になる利用者: 0 };
  {
    const ordById = new Map(snap.orders.map((o) => [o.id, o]));
    for (const [cid, ts] of groupBy(termOps, (o) => o.cid)) {
      const rs = snap.items.filter((it) => it.status === "rental_started" && ordById.get(it.order_id)?.client_id === cid).length // 全事業所 (trigger と同じ)。実行は 更新 → 追加 の順なので追加分は数えない
      const fire = Math.min(ts.length, Math.max(rs - 1, 0)); // 残りが 1 件以上ある間は毎回発火
      termEst.doc_tasks_partial_termination += fire * 2;
      termEst.care_plan_elements_partial_termination += fire;
      if (ts.length >= rs) termEst.全解約になる利用者++;
    }
  }
  const insItemOps = ops.rentals.filter((o) => o.table === "order_items" && o.action === "insert");
  triggerEst.rentals_insert = {
    care_plan_elements_new_or_additional_delivery: insItemOps.length,
    doc_tasks_rental_started_新規注文分: ops.rentals.filter((o) => o.table === "orders").length * 4,
    doc_tasks_rental_started_既存注文分_最大: new Set(insItemOps.filter((o) => !isNew(o.row.order_id)).map((o) => o.row.order_id)).size * 4,
  };

  // ════ 反映後の一致見込み ═══════════════════════════════════════════
  function evaluate(data, label, priceFixed, excludeShared = false) {
    const m = buildBillingModel(data, MONTH, OFFICE, libs);
    const idx = buildMatchIndex(data);
    const res = new Report();
    let ok = 0, n = 0;
    const matchedIds = new Set();
    for (const u of csvUsers.values()) {
      if (excludeShared && sharedInfo.has(resolved.get(u.key))) continue;
      n++;
      const ex = { 被保番: u.insured, 氏名: u.name };
      const mr = matchCsvUser(u, idx, m.clientById, (cid) => m.dbLines.has(cid) || m.dbSkipped.has(cid));
      if (mr.status !== "ok") { res.add(`利用者が引けない (${mr.status === "ambiguous" ? "複数一致" : "不在"})`, ex); continue; }
      const c = mr.client;
      matchedIds.add(c.id);
      if (!m.officeClients.has(c.id)) { res.add(`利用者が請求の範囲外 (${c.deleted_at ? "削除済み" : `office_id=${c.office_id ? officeName.get(c.office_id) : "空"}`}${sharedInfo.has(c.id) ? "・共有" : ""})`, ex); continue; }
      const dl = m.dbLines.get(c.id) ?? [];
      const ct = csvTotals(u);
      if (m.isLate(c.id)) { res.add("月遅れ扱いで伝送から外れる (申請中 / 月遅れフラグ)", ex); continue; }
      if (!dl.length) { res.add(`請求明細が 0 (${(m.dbSkipped.get(c.id) ?? []).map((s) => s.skipped.split(" (")[0]).join(",") || "有効明細なし"})`, ex); continue; }
      const totalUnits = dl.reduce((s, l) => s + l.units, 0);
      const kk = m.pickKohi(c.id);
      const amt = computeFukuyoguAmounts({ benefitRateRaw: c.benefit_rate, insuredNumber: c.insured_number, totalUnits,
        kohi: kk ? { hobetsu: kk.hohei_code, futansha: kk.futan_sha_number, jukyusha: kk.jukyu_sha_number } : null });
      if (ct.units === totalUnits && ct.ins === amt.insuranceAmount && ct.self === amt.userAmount && ct.kohi === (amt.kohiAmount ?? 0)) { ok++; res.add("一致", null); continue; }
      if (ct.units === totalUnits) { res.add("単位数は一致・金額だけ差 (給付率 / 公費)", { ...ex, CSV: ct, DB: { 保険: amt.insuranceAmount, 本人: amt.userAmount, 公費: amt.kohiAmount }, DB給付率: c.benefit_rate, DB公費: kk?.futan_sha_number ?? null }); continue; }
      const lineSum = u.lines.reduce((s, l) => s + l.units, 0);
      if (lineSum !== ct.units && lineSum === totalUnits) { res.add("区分支給限度超過 (KDS の保険対象単位 < 明細合計。当方は限度額管理をしない)", { ...ex, KDS保険対象: ct.units, 明細合計: lineSum, DB: totalUnits }); continue; }
      const cg = groupBy(u.lines, (l) => l.tais), dg = groupBy(dl, (l) => l.tais);
      const sk = groupBy(m.dbSkipped.get(c.id) ?? [], (l) => l.tais);
      const why = new Set();
      const detail = [];
      for (const [t, cl] of cg) {
        const d = dg.get(t);
        if (!d) { why.add(sk.has(t) ? `DB 明細が請求に乗らない (${sk.get(t)[0].skipped.split(" (")[0]})` : "CSV のみの用具が残る"); detail.push({ TAIS: t, CSV: cl.reduce((s, l) => s + l.units, 0), DB: 0 }); continue; }
        const cu = cl.reduce((s, l) => s + l.units, 0), du = d.reduce((s, l) => s + l.units, 0);
        if (cu !== du) {
          why.add(!targetUnits.has(t) ? "単位差 (価格が決まらない TAIS)" : d.some((x) => x.half) || cl.some((l) => l.days < MDAYS) ? "半月按分の差 (月途中の開始/終了)" : priceFixed ? "単位差 (価格を揃えた後も残る)" : "単位差 (マスタ価格)");
          detail.push({ TAIS: t, CSV: cu, DB: du, CSV日数: cl.map((l) => l.days) });
        }
      }
      for (const t of dg.keys()) if (!cg.has(t)) why.add("DB のみの用具 (終了案が未反映)");
      if (lineSum !== ct.units) why.add("区分支給限度超過も絡む");
      res.add(`単位数の差 — ${[...why].sort().join(" + ") || "不明"}`, { ...ex, CSV: ct.units, DB: totalUnits, 明細: detail });
    }
    const extra = m.dbTargets.filter((cid) => !matchedIds.has(cid) && !m.isLate(cid) && !(excludeShared && sharedInfo.has(cid)));
    return { label, CSV利用者: n, 一致: ok, 一致率: `${((ok / n) * 100).toFixed(1)}%`, DBだけの請求者_KKに余分に出る: extra.length, 内訳: res };
  }
  // 流し直し: 前の batch で同じ内容の observe を控え済みなら もう一度は控えない (書込みは前段の比較で自然に「変更なし」になる)
  const ready0 = await provenanceReady(sb);
  if (ready0.ok) {
    // ★ 2026-11-13: offset ページング (order id + range) だと data_import_rows が大きくなって statement timeout になる
    //   → id のキーセット (id > 前回の最後の id・order id・limit 200) で読む。読む中身・並びは同じ (書き込みロジックは変えない)
    const prior = [];
    for (let last = null; ;) {
      let q = sb.from("data_import_rows").select("id,table_name,row_id,after").eq("tenant_id", TENANT).eq("op", "observe");
      if (last) q = q.gt("id", last);
      // 1 回 200 行 (after は jsonb で重く、1,000 行ずつだと 1 回の問い合わせが timeout に掛かる。2026-11-13 実測: 200 行で 0.3 秒)
      const { data, error } = await q.order("id").limit(200);
      if (error) throw new Error(`data_import_rows: ${error.message}`);
      prior.push(...data);
      if (data.length < 200) break;
      last = data[data.length - 1].id;
    }
    const seen = new Set(prior.map((r) => `${r.table_name}:${r.row_id}:${canon(r.after ?? null)}`));
    let skipped = 0;
    for (const st of STEPS) ops[st] = ops[st].filter((o) => { const dup = o.action === "observe" && seen.has(`${o.table}:${o.id}:${canon(o.patch ?? null)}`); if (dup) skipped++; return !dup; });
    console.log(`  前の batch で控え済みの observe ${skipped} 件は今回は控えない (data_import_rows の observe ${prior.length} 行と比較)`);
  }
  // 今のフラグで書く範囲だけを反映したデータ (observe は書かない)
  const simRun = clone(snap);
  simRun.coa = clone(sim.coa);
  for (const st of STEPS) for (const op of ops[st]) if (opEnabled(op)) applyTo(simRun, op);
  const flagLabel = [...ENABLED].map((g) => `--${g}`).join(" ") || "フラグ無し";
  const evals = [
    evaluate(snap, "反映前 (現在の DB) — 全体", false),
    evaluate(snap, "反映前 (現在の DB) — 共有を除く", false, true),
    evaluate(simRun, `反映後 (${flagLabel}) — 全体`, true),
    evaluate(simRun, `反映後 (${flagLabel}) — 共有を除く`, true, true),
  ];
  const yobo = mRows.filter((r) => nfkc(r[C.SVC_KIND]).startsWith("67"));
  const yoboInfo = { 予防67の明細行: yobo.length, 利用者: new Set(yobo.map((r) => `${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}`)).size, 注: "DB は種目から常に 17 を出す (build.ts)。コード側の問題なので本 script の対象外。単位・金額には効かないが 7131 の明細コードは違う" };

  // ── 出力 ───────────────────────────────────────────────────────────
  const gateLabel = (op) => ((op.gate ?? []).length ? ` [要 ${op.gate.map((g) => `--${g}`).join(" ")}]` : "");
  for (const s of STEPS) {
    if (!SHOW(s)) continue;
    const runN = ops[s].filter(opEnabled).length;
    console.log(`\n══ ${s} ══ 書込み計画 ${ops[s].length} 件 (今のフラグで書く ${runN} 件)${STEP !== "all" && s !== STEPS[0] ? " ※前の段を反映した想定で計算" : ""}`);
    for (const [k, v] of Object.entries(countBy(ops[s], (o) => `${o.table} ${o.action} — ${o.why}${gateLabel(o)}`))) console.log(`  ${String(v).padStart(5)}  ${k}`);
    for (const o of ops[s].slice(0, 3)) console.log(`         例 ${JSON.stringify({ table: o.table, action: o.action, ...(o.action === "update" || o.action === "observe" ? { id: o.id, before: o.before, patch: o.patch } : o.action === "delete" ? { id: o.id } : { row: o.row }), ref: o.ref })}`);
    console.log("  -- 一覧 (判断材料・書込みなし) --");
    R[s].print(3);
    writeFileSync(join(OUT_DIR, `sync_${s}_plan.json`), JSON.stringify({ month: MONTH, asOf: AS_OF, step: s, enabledGates: [...ENABLED], ops: ops[s], lists: R[s].toJSON() }, null, 2));
  }
  const allOps = STEPS.filter(SHOW).flatMap((s) => ops[s]);
  const recordEst = {
    今のフラグで記録される行_掃除分を除く: allOps.filter(opEnabled).length, 全フラグで記録される行: allOps.length,
    うち_observe_書かずに控えるだけ: allOps.filter((o) => o.action === "observe").length,
    今のフラグ_表ごと: countBy(allOps.filter(opEnabled), (o) => `${o.table} ${o.action}`),
    フラグごとに増える行: Object.fromEntries(GATES.map((g) => [`--${g}`, allOps.filter((o) => (o.gate ?? []).includes(g)).length])),
  };
  const keySets = {};
  for (const o of allOps.filter((x) => opEnabled(x) && x.action === "insert")) (keySets[o.table] ??= new Set()).add(Object.keys(o.row).sort().join(","));
  console.log(`\n══ insert のキー集合 ══ (違う集合は別々の insert に分けて送る。NULL の明示送信はしない) ${JSON.stringify(Object.fromEntries(Object.entries(keySets).map(([t, v]) => [t, v.size])))}`);
  console.log("\n══ 出どころ記録 (data_import_rows) の見込み ══");
  console.log(JSON.stringify({ batch: { source_system: SOURCE_SYSTEM, step: STEP, source_files: sourceFiles.map((f) => `${f.path} (${f.rows} 行)`) }, ...recordEst }, null, 2));
  const ti = triggerEst.care_plan_elements_insurance, tr = triggerEst.rentals_insert;
  const termOn = ENABLED.has("terminate-absent-rentals");
  const cleanupEst = {
    care_plan_elements: { 認定の追加: ti.plan_renewal + ti.plan_change + ti.care_office_change, 明細の追加: tr.care_plan_elements_new_or_additional_delivery, 明細の終了_一部解約: termOn ? termEst.care_plan_elements_partial_termination : 0 },
    doc_tasks: { 新規注文: tr.doc_tasks_rental_started_新規注文分, 既存注文_最大: tr.doc_tasks_rental_started_既存注文分_最大, 明細の終了_一部解約: termOn ? termEst.doc_tasks_partial_termination : 0 },
  };
  const sumOf = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  console.log("\n══ trigger が作る行 → 掃除で消す 見込み ══ (実行時は段ごとに 書込み→掃除。消すのは参照先がこの batch で触った行のものだけ)");
  console.log(JSON.stringify({ ...cleanupEst,
    合計: { care_plan_elements: sumOf(cleanupEst.care_plan_elements), doc_tasks: `${sumOf(cleanupEst.doc_tasks) - cleanupEst.doc_tasks.既存注文_最大}〜${sumOf(cleanupEst.doc_tasks)}` },
    注: "作られる見込み = 消す見込み。既存注文の doc_tasks (rental_started) は同じ注文のタスクが既にあれば ON CONFLICT で作られない (最大値)。認定は古い順に 1 行ずつ入れる前提",
    終了の内訳: termEst, 認定の内訳: ti }, null, 2));
  console.log("\n══ 反映後の一致見込み (KDS0031 の利用者別 単位数・保険請求額・本人負担・公費請求額) ══");
  for (const e of evals) {
    console.log(`\n  [${e.label}] 一致 ${e.一致}/${e.CSV利用者} (${e.一致率}) / DB だけの請求者 (KK に余分なレセプト) ${e.DBだけの請求者_KKに余分に出る} 名`);
    for (const [k, v] of e.内訳.m) if (k !== "一致") console.log(`    ${String(v.length).padStart(5)}  ${k}`);
  }
  console.log(`\n  別枠: 予防 (サービス種類 67) ${JSON.stringify(yoboInfo)}`);
  writeFileSync(join(OUT_DIR, "sync_simulation.json"), JSON.stringify({ month: MONTH, asOf: AS_OF, sourceFiles, recordEst, triggerEst, termEst, yoboInfo, evaluations: evals.map((e) => ({ ...e, 内訳: e.内訳.toJSON() })) }, null, 2));
  console.log(`\n詳細 JSON: ${OUT_DIR}`);
  const ready = await provenanceReady(sb);
  console.log(`出どころ記録の表: ${ready.ok ? "あり" : `無い (${ready.why}) → --execute 前に apps/order-app/migrations/data_import_provenance.sql を SQL Editor で流すこと`}`);

  if (!EXECUTE) { console.log("\nDRY RUN — DB は書き換えていない。--execute で本番"); return; }
  if (!ready.ok) { console.error("★ 出どころ記録の表が無いので --execute しない。apps/order-app/migrations/data_import_provenance.sql を先に適用すること"); process.exit(2); }
  await execute(sb, ops, { MONTH, sourceFiles, cleanupEst });
}

// ── trigger が作る行の掃除 ────────────────────────────────────────────────
// doc_tasks (trigger_ref_id) / care_plan_elements (ref_id) を対象の利用者ぶん控えておき、書込み後に増えた行のうち
// 参照先がこの batch で触った行 (refIds) のものだけ消す。参照先が違う新しい行 (他の人・他の処理) は消さずに数だけ出す。
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

// ── 本番書込み ────────────────────────────────────────────────────────────
async function execute(sb, ops, { MONTH, sourceFiles, cleanupEst }) {
  const ym = MONTH.replace("-", "");
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: sourceFiles, script: SCRIPT_REL, args: argv.join(" "), step: STEP,
    notes: `提供 ${MONTH} / フラグ ${[...ENABLED].join(",") || "なし"}`,
  });
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `提供 ${MONTH} / 失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  const record = async (recs) => {
    for (const c of chunks(recs, 100)) {
      const { error } = await sb.from("data_import_rows").insert(c);
      if (error) await fail(`data_import_rows: ${error.message}`);
    }
  };
  const srcRef = (o) => ({ file: o.src?.file ?? null, ...(o.src?.ref ?? {}) });
  const idMap = new Map();
  const fix = (v) => (isNew(v) ? idMap.get(v) ?? null : v);
  const cidOf = (o) => o.cid ?? o.row?.client_id ?? (o.table === "clients" ? o.id : null);
  const order = ["equipment_master", "equipment_price_history", "clients", "client_office_assignments", "client_insurance_records", "client_public_expenses", "orders", "order_items"];
  const cleaned = { doc_tasks: 0, care_plan_elements: 0, 消さなかった新しい行: 0 };
  for (const s of STEP === "all" ? STEPS : [STEP]) {
    const list = ops[s].filter(opEnabled);
    if (!list.length) { console.log(`[${s}] 書込み 0 件`); continue; }
    // observe (共有の人の ほのぼのの値。書かない) を控える
    const obs = list.filter((o) => o.action === "observe");
    await record(obs.map((o) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: o.table, row_id: o.id, op: "observe", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: o.before ?? null, after: o.patch ?? null })));
    const writes = list.filter((o) => o.action !== "observe");
    // 変更前の行 (全列) → バックアップファイル + data_import_rows.before
    const beforeRows = new Map();
    for (const [table, us] of groupBy(writes.filter((o) => o.action !== "insert"), (o) => o.table)) {
      const got = await selectIn(sb, table, "*", "id", us.map((o) => o.id));
      if (got.length !== new Set(us.map((o) => o.id)).size) await fail(`${table}: 変更前の行が ${us.length} 件のはずが ${got.length} 件しか読めない`);
      for (const r of got) beforeRows.set(`${table}:${r.id}`, r);
    }
    const bpath = join(HERE, `_backup_honobono_sync_${ym}_${s}_${ts}.json`);
    writeFileSync(bpath, JSON.stringify({ batch: BATCH, step: s, at: new Date().toISOString(), before: Object.fromEntries(beforeRows) }, null, 2));
    console.log(`[${s}] バックアップ ${bpath}`);
    // 掃除の準備: この段で触る利用者の doc_tasks / care_plan_elements を控える
    const existingCids = [...new Set(writes.map(cidOf).filter((x) => x && !isNew(x)))];
    const beforeDerived = await snapshotDerived(sb, existingCids);
    const touched = new Set();
    // 掃除: この段で trigger が作った行を消して記録 (段の途中で落ちても必ず走らせる)
    const doCleanup = async () => {
      const allCids = [...new Set(writes.map((o) => fix(cidOf(o))).filter(Boolean))];
      const res = await cleanupDerived(sb, allCids, beforeDerived, touched);
      for (const [t, { mine, others }] of Object.entries(res)) {
        await record(mine.map((r) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger", source_ref: { cleanup: true, 理由: `段 ${s} の書込みで trigger が作った行` }, before: r, after: null })));
        cleaned[t] += mine.length;
        cleaned.消さなかった新しい行 += others.length;
        console.log(`  掃除 ${t}: 消した ${mine.length} / 参照先が違うので消さなかった新しい行 ${others.length}`);
      }
    };
    try {
    for (const table of order) {
      let nu = 0, nd = 0, ni = 0;
      for (const o of writes.filter((x) => x.table === table && x.action === "update")) {
        const { error, count } = await sb.from(table).update(o.patch, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
        if (error) await fail(`update ${table} ${o.id}: ${error.message}`);
        if (count !== 1) await fail(`update ${table} ${o.id}: 更新件数 ${count}`);
        await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: o.id, op: "update", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${table}:${o.id}`), after: o.patch }]);
        touched.add(o.id);
        const oid = beforeRows.get(`${table}:${o.id}`)?.order_id;
        if (oid) touched.add(oid);
        nu++;
      }
      for (const o of writes.filter((x) => x.table === table && x.action === "delete")) {
        const { error, count } = await sb.from(table).delete({ count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
        if (error) await fail(`delete ${table} ${o.id}: ${error.message}`);
        if (count !== 1) await fail(`delete ${table} ${o.id}: 削除件数 ${count}`);
        await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: o.id, op: "delete", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${table}:${o.id}`), after: null }]);
        nd++;
      }
      const ins = [];
      for (const o of writes.filter((x) => x.table === table && x.action === "insert")) {
        const row = Object.fromEntries(Object.entries(o.row).map(([k, v]) => [k, ["client_id", "order_id"].includes(k) ? fix(v) : v]));
        if (("client_id" in o.row && row.client_id === null) || ("order_id" in o.row && row.order_id === null)) {
          console.warn(`  ⚠ ${table}: 参照先がまだ無い (${o.row.client_id ?? o.row.order_id})。前の段を先に流すこと → 飛ばす`); continue;
        }
        ins.push({ o, row });
      }
      // キー集合が同じ行だけを 1 回の insert にまとめる (違う行を混ぜると PostgREST が欠けた列に NULL を明示して DEFAULT が効かない)。
      // 順番は保つ (認定は trigger が「直前の行」を見るので 1 行ずつ・利用者ごとに古い順)
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
      if (nu || nd || ni) console.log(`  ${table}: 更新 ${nu} / 削除 ${nd} / 追加 ${ni}`);
    }
    } catch (e) {
      console.error(`
★ 段 ${s} の途中で失敗: ${e.message}
  ここまでに trigger が作った行の掃除だけは行う`);
      try { await doCleanup(); } catch (e2) { console.error(`★ 掃除も失敗: ${e2.message} → --cleanup-batch ${BATCH} で後から掃除すること`); }
      throw e;
    }
    try { await doCleanup(); } catch (e) { await fail(`掃除: ${e.message} (--cleanup-batch ${BATCH} で後から掃除できる)`); }
  }
  const estCpe = Object.values(cleanupEst.care_plan_elements).reduce((a, b) => a + b, 0);
  const estDoc = Object.values(cleanupEst.doc_tasks).reduce((a, b) => a + b, 0) - cleanupEst.doc_tasks.既存注文_最大;
  console.log(`\n掃除 合計: care_plan_elements ${cleaned.care_plan_elements} (見込み ${estCpe}) / doc_tasks ${cleaned.doc_tasks} (見込み ${estDoc}〜${estDoc + cleanupEst.doc_tasks.既存注文_最大}) / 消さなかった新しい行 ${cleaned.消さなかった新しい行}`);
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH} / data_import_rows ${count} 行。取り消しは --revert ${BATCH}`);
}

// ── 取り消し ──────────────────────────────────────────────────────────────
async function revert(batchId) {
  const sb = await makeSb();
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  const ready = await provenanceReady(sb);
  if (!ready.ok) { console.error(`出どころ記録の表が無い (${ready.why})。migrations/data_import_provenance.sql を先に適用すること`); process.exit(2); }
  const { data: batch, error } = await sb.from("data_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(`data_import_batches: ${error.message}`);
  if (!batch) { console.error(`batch ${batchId} が無い`); process.exit(1); }
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 取り消し batch ${batchId} (${batch.source_system} / ${batch.step} / ${batch.status} / ${batch.created_at})`);
  if (batch.status === "reverted") { console.log("既に取り消し済み"); return; }
  const all = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  console.log(`記録 ${all.length} 行 ${JSON.stringify(countBy(all, (r) => `${r.table_name} ${r.op}${r.source_ref?.cleanup ? " (掃除)" : ""}`))}`);
  // observe は書いていないので戻すものが無い / 掃除で消した trigger の行は batch 前には無かったので入れ直さない
  const recs = all.filter((r) => r.op !== "observe" && !r.source_ref?.cleanup);
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (a != null && b != null && String(a) === String(b));
  const plan = { del: [], restore: [], reinsert: [], skip: [] };
  const insertedIds = new Set(recs.filter((r) => r.op === "insert").map((r) => r.row_id));
  for (const [table, rs] of groupBy(recs, (r) => r.table_name)) {
    const cur = new Map((await selectIn(sb, table, "*", "id", rs.map((r) => r.row_id))).map((r) => [r.id, r]));
    for (const r of rs) {
      const now = cur.get(r.row_id);
      if (r.op === "delete") { if (now) plan.skip.push({ table, id: r.row_id, why: "同じ id の行が既にある (★ 入れ直さない)" }); else plan.reinsert.push({ table, row: r.before }); continue; }
      if (!now) { plan.skip.push({ table, id: r.row_id, why: "既に無い" }); continue; }
      const changed = Object.keys(r.after ?? {}).filter((k) => !same(now[k], r.after[k]));
      if (changed.length) { plan.skip.push({ table, id: r.row_id, why: `後から変わった列 ${changed.join(",")} (★ 戻さない)` }); continue; }
      if (r.op === "insert") plan.del.push({ table, id: r.row_id });
      else plan.restore.push({ table, id: r.row_id, patch: Object.fromEntries(Object.keys(r.after).map((k) => [k, r.before?.[k] ?? null])) });
    }
  }
  // 消す行を、この batch 以外の行が参照していないか (FK で落ちる / 他人のデータを壊す)
  const refChecks = [["clients", [["orders", "client_id"], ["client_insurance_records", "client_id"], ["client_public_expenses", "client_id"], ["client_office_assignments", "client_id"]]], ["orders", [["order_items", "order_id"]]]];
  for (const [table, refs] of refChecks) {
    const ids = plan.del.filter((d) => d.table === table).map((d) => d.id);
    if (!ids.length) continue;
    const blocked = new Set();
    for (const [rt, col] of refs) for (const r of await selectIn(sb, rt, `id,${col}`, col, ids)) if (!insertedIds.has(r.id)) blocked.add(r[col]);
    plan.del = plan.del.filter((d) => !(d.table === table && blocked.has(d.id)));
    for (const id of blocked) plan.skip.push({ table, id, why: "この batch 以外の行が参照している (★ 消さない)" });
  }
  const eqDel = plan.del.filter((d) => d.table === "equipment_master").map((d) => d.id);
  if (eqDel.length) {
    const eqs = await selectIn(sb, "equipment_master", "id,product_code", "id", eqDel);
    const used = new Set((await selectIn(sb, "order_items", "id,product_code", "product_code", eqs.map((e) => e.product_code))).filter((r) => !insertedIds.has(r.id)).map((r) => r.product_code));
    for (const e of eqs) if (used.has(e.product_code)) { plan.del = plan.del.filter((d) => d.id !== e.id); plan.skip.push({ table: "equipment_master", id: e.id, why: `この batch 以外の order_items が ${e.product_code} を使っている` }); }
  }
  // 取り消しでも trigger が動く (終了の取り消し = rental_started に戻す → 搬入扱い / 明細の削除 → 一部解約)。同じ方法で掃除する
  const clientIds = new Set(recs.filter((r) => r.table_name === "clients").map((r) => r.row_id));
  for (const r of recs) { const c = r.after?.client_id ?? r.before?.client_id; if (c) clientIds.add(c); }
  const refIds = new Set(recs.map((r) => r.row_id));
  const itemRecs = recs.filter((r) => r.table_name === "order_items");
  if (itemRecs.length) {
    const orderIds = [...new Set(itemRecs.map((r) => r.after?.order_id ?? r.before?.order_id).filter(Boolean))];
    for (const oid of orderIds) refIds.add(oid);
    for (const o of await selectIn(sb, "orders", "id,client_id", "id", orderIds)) if (o.client_id) clientIds.add(o.client_id);
  }
  console.log(`\n消す ${plan.del.length} ${JSON.stringify(countBy(plan.del, (d) => d.table))}`);
  console.log(`戻す ${plan.restore.length} ${JSON.stringify(countBy(plan.restore, (d) => d.table))}`);
  console.log(`入れ直す (削除の取り消し) ${plan.reinsert.length} ${JSON.stringify(countBy(plan.reinsert, (d) => d.table))}`);
  console.log(`戻さない ${plan.skip.length} ${JSON.stringify(countBy(plan.skip, (d) => `${d.table} ${d.why.split(" (")[0]}`))}`);
  for (const s of plan.skip.slice(0, 10)) console.log(`   - ${JSON.stringify(s)}`);
  console.log(`取り消しでも trigger が doc_tasks / care_plan_elements を作るので、取り消しの後に 対象 ${clientIds.size} 名ぶんを同じ方法で掃除する`);
  if (!EXECUTE) { console.log("\nDRY RUN — 何も変えていない。--execute で取り消し"); return; }
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し (同時実行ロック用。行の記録はしない)` }, async () => {
    const beforeDerived = await snapshotDerived(sb, [...clientIds]);
    for (const r of plan.restore) {
      const { error: e, count } = await sb.from(r.table).update(r.patch, { count: "exact" }).eq("id", r.id);
      if (e || count !== 1) throw new Error(`restore ${r.table} ${r.id}: ${e?.message ?? `件数 ${count}`}`);
    }
    const delOrder = ["order_items", "orders", "client_public_expenses", "client_insurance_records", "client_office_assignments", "clients", "equipment_price_history", "equipment_master"];
    for (const table of delOrder) {
      for (const c of chunks(plan.del.filter((d) => d.table === table).map((d) => d.id), 150)) {
        const { error: e, count } = await sb.from(table).delete({ count: "exact" }).in("id", c);
        if (e || count !== c.length) throw new Error(`delete ${table}: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`);
      }
    }
    for (const [table, rs] of groupBy(plan.reinsert, (r) => r.table)) for (const c of chunks(rs.map((r) => r.row), 100)) {
      const { error: e } = await sb.from(table).insert(c);
      if (e) throw new Error(`reinsert ${table}: ${e.message}`);
    }
    const deletedClients = new Set(plan.del.filter((d) => d.table === "clients").map((d) => d.id));
    const res = await cleanupDerived(sb, [...clientIds].filter((id) => !deletedClients.has(id)), beforeDerived, refIds);
    const bpath = join(HERE, `_backup_honobono_sync_revert_${batchId}_cleanup.json`);
    writeFileSync(bpath, JSON.stringify(Object.fromEntries(Object.entries(res).map(([t, v]) => [t, v.mine])), null, 2));
    for (const [t, { mine, others }] of Object.entries(res)) console.log(`  掃除 ${t}: 消した ${mine.length} / 消さなかった新しい行 ${others.length}`);
    const status = plan.skip.some((s) => s.why !== "既に無い") ? "partially_reverted" : "reverted";
    const { error: e3 } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
    if (e3) throw new Error(`batch 更新: ${e3.message}`);
    console.log(`\n取り消し完了 (${status})。消した ${plan.del.length} / 戻した ${plan.restore.length} / 入れ直した ${plan.reinsert.length} / 戻さなかった ${plan.skip.length} / 掃除の控え ${bpath}`);
  });
}

// ── batch の掃除の取りこぼしを後から消す ──────────────────────────────────
// その batch の data_import_rows (insert/update/delete) で触った行を参照先に持ち、batch の created_at 以降に作られた
// doc_tasks / care_plan_elements を消す。消した行は新しい batch に op=delete・before 付きで記録する (取り消し可能)。
async function cleanupBatch(batchId) {
  const sb = await makeSb();
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  const ready = await provenanceReady(sb);
  if (!ready.ok) { console.error(`出どころ記録の表が無い (${ready.why})`); process.exit(2); }
  const { data: batch, error } = await sb.from("data_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(`data_import_batches: ${error.message}`);
  if (!batch) { console.error(`batch ${batchId} が無い`); process.exit(1); }
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 掃除 batch ${batchId} (${batch.step} / ${batch.status} / created ${batch.created_at})`);
  const all = await selectAll(sb, "data_import_rows", "id,table_name,row_id,op,before,after,source_ref", (q) => q.eq("batch_id", batchId));
  const recs = all.filter((r) => ["insert", "update", "delete"].includes(r.op) && !r.source_ref?.cleanup);
  const already = all.filter((r) => r.source_ref?.cleanup).length;
  console.log(`記録 ${all.length} 行 / 書込み ${recs.length} 行 ${JSON.stringify(countBy(recs, (r) => `${r.table_name} ${r.op}`))} / この batch で掃除済み ${already} 行`);
  const refIds = new Set(recs.map((r) => r.row_id));
  const clientIds = new Set(recs.filter((r) => r.table_name === "clients").map((r) => r.row_id));
  const orderIds = new Set();
  for (const r of recs) {
    const c = r.after?.client_id ?? r.before?.client_id; if (c) clientIds.add(c);
    if (r.table_name === "order_items") { const o = r.after?.order_id ?? r.before?.order_id; if (o) orderIds.add(o); }
  }
  for (const o of orderIds) refIds.add(o);
  if (orderIds.size) for (const o of await selectIn(sb, "orders", "id,client_id", "id", [...orderIds])) if (o.client_id) clientIds.add(o.client_id);
  const found = {};
  for (const [t, refCol] of DERIVED) {
    const rows = clientIds.size ? await selectIn(sb, t, "*", "client_id", [...clientIds], (q) => q.eq("tenant_id", TENANT).gte("created_at", batch.created_at)) : [];
    const denom = clientIds.size ? (await selectIn(sb, t, "id", "client_id", [...clientIds], (q) => q.eq("tenant_id", TENANT))).length : 0; // 分母 (0 件が偽陰性でないことの確認)
    found[t] = { mine: rows.filter((r) => refIds.has(r[refCol])), others: rows.filter((r) => !refIds.has(r[refCol])) };
    const typeCol = t === "doc_tasks" ? "trigger_type" : "element_type";
    console.log(`  ${t}: 対象 ${clientIds.size} 名の行 ${denom} (分母) / 消す ${found[t].mine.length} ${JSON.stringify(countBy(found[t].mine, (r) => r[typeCol]))} / batch 以降に作られたが参照先が違うので消さない ${found[t].others.length}`);
  }
  if (!EXECUTE) { console.log("\nDRY RUN — 何も消していない。--execute で掃除 (新しい batch に記録)"); return; }
  const total = Object.values(found).reduce((a, v) => a + v.mine.length, 0);
  if (!total) { console.log("消す行 0 件"); return; }
  const nb = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "cleanup",
    notes: `batch ${batchId} の trigger 掃除の取りこぼし`,
  });
  for (const [t, { mine }] of Object.entries(found)) {
    for (const c of chunks(mine, 150)) {
      const { error: e, count } = await sb.from(t).delete({ count: "exact" }).in("id", c.map((r) => r.id));
      if (e || count !== c.length) { await sb.from("data_import_batches").update({ status: "failed" }).eq("id", nb.id); throw new Error(`delete ${t}: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`); }
      const { error: e2 } = await sb.from("data_import_rows").insert(c.map((r) => ({ batch_id: nb.id, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger",
        source_ref: { cleanup: true, 対象batch: batchId, 理由: `batch ${batchId} の書込みで trigger が作った行 (掃除の取りこぼし)` }, before: r, after: null })));
      if (e2) { await sb.from("data_import_batches").update({ status: "failed" }).eq("id", nb.id); throw new Error(`data_import_rows: ${e2.message}`); }
    }
  }
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", nb.id);
  if (e3) throw new Error(`batch 更新: ${e3.message}`);
  console.log(`\n掃除完了。batch ${nb.id} に ${total} 行を記録 (取り消しは --revert ${nb.id})`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
