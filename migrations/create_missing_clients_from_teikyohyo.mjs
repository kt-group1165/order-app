/**
 * 提供票 (rebuild_rentals_from_teikyohyo.mjs) で DB の clients に引けなかった利用者を clients に作る
 *
 *   node migrations/create_missing_clients_from_teikyohyo.mjs                    # DRY RUN (既定)
 *   node migrations/create_missing_clients_from_teikyohyo.mjs --simulate         # DRY RUN + 作った後の rebuild を模擬 (rebuild の DRY RUN を控えの DB で回す)
 *   node migrations/create_missing_clients_from_teikyohyo.mjs --execute          # 本番 (★ user 承認後)
 *   node migrations/create_missing_clients_from_teikyohyo.mjs --revert <batch_id> [--execute]
 *   node migrations/create_missing_clients_from_teikyohyo.mjs --cleanup-batch <batch_id> [--execute]
 *     (--revert / --cleanup-batch は sync_fukuyogu_from_honobono.mjs の汎用処理に渡す。data_import_rows の before/after で戻す)
 *
 *   --teikyo-dir <dir>       既定 kaigo-app/伝送データ/ケアサポ/福祉用具/用具貸与期間_20261109
 *   --user-master-dir <dir>  利用登録＝有。既定 kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109
 *   --user-master-dir-off <dir>  利用登録＝無。既定 kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_全件_20261109
 *     (どちらも 基本情報_*.CSV / 介護保険_*.CSV / 公費_*.CSV / 負担割合証等_*.CSV。列構成は同じ。2 つ合わせて全件)
 *   --db-cache <json> / --refresh   DRY RUN の DB 控え (既定 OS 一時フォルダ。--execute は必ず読み直す)
 *   --rebuild-cache <json>   --simulate で使う rebuild の DB 控え (無ければ rebuild に 1 回読ませて作る)
 *   --out <json>             詳細の出力先
 *
 * ── 背景 (2026-11-09) ────────────────────────────────────────────────────────
 *   提供票 4〜10 月から貸与を組み直したとき、DB の clients に引けない利用者 50 名 / 172 台 は何もしなかった (FY-N)。
 *     (d) 利用者ではない行 2 件 (「介護老人保健施設 葵の園・緑区」「長柄町 役場」) → 作らない
 *     残り 48 名は 利用者マスタ「利用登録＝有」には居ないが、★「利用登録＝無」(利用者マスタ_全件_20261109) に 48 名とも居る
 *     (利用者番号・氏名とも一致。FY-N2 実測)。
 *   1e039e1 の初版は 13 名の保険を 請求の出力 KDS0031 から作っていた。user 方針
 *   「移行データは入力側から取る。請求の出力は答え合わせだけ」(memory feedback_migration_from_input_not_billing_output) に
 *   合わせて、★ 属性・認定・公費・負担割合証は 利用者マスタ (有+無) から作る形に直した (FY-N2)。KDS0031 は作った値と比べるだけ。
 *
 * ── 作り方 (sync_fukuyogu_from_honobono.mjs の新規作成と同じ列の入れ方) ──────────────────────
 *   clients: 基本情報 (氏名・カナ・性別・生年月日・住所・電話・死亡日→status=deceased) + 「最後に貸与した月の末日」に有効な認定
 *            (要介護度・認定期間・保険者・被保番・給付率 = 負担割合証があればその率・居宅 = 支援事業所(正式名称) を care_offices の名前で一意に引く)
 *            user_number = ほのぼのの利用者番号 (DB で空いていれば。使われていれば HN-<番号>。rebuild は両方で引く)
 *            office_id = ケアサポ / copay_rate は percent 表記 ("10"/"20"/"30") / insert のキー集合は全員同じ
 *   client_office_assignments: ケアサポ (tenant_id 付き)。start_date = 提供票の最初の月の 1 日
 *   client_insurance_records: 介護保険 CSV の全世代。copay_rate は 割 表記 ("1"/"2"/"3")。notes にマーカー
 *   client_public_expenses: 公費 CSV の全行 (介護医療区分=介護・負担者 8 桁)。本人支払額は列があれば
 *   client_benefit_certificates: 負担割合証等 CSV (scripts/_benefit-cert-csv.mts で読む・取込エンジン _benefit-cert-import.mts と同じ列)
 *   認定・公費・負担割合証は office_id = ケアサポ / office_source = 'import_record' (列がある DB だけ。DESIGN_INSURANCE_PER_OFFICE.md §5.3)
 *   trigger (client_insurance_records → care_plan_elements 等) が作った行は 書込み後に掃除して記録 (同期と同じ)
 *   data_import_batches / data_import_rows に before/after。--revert で戻せる
 *
 * ── 仮の値 (入れない) ────────────────────────────────────────────────────
 *   自費だけの人は ほのぼのに 仮の生年月日 (登録日。2020 年以降) と 仮の被保番 (1212121212 / 9999955555 等・要介護度が空) で
 *   登録されている。生年月日が 2020 年以降の人は 生年月日を空にし、認定・負担割合証を入れない (仮の被保番を共有表に入れない)。
 *   要介護度が空なのに 認定状況=認定済み の世代も 仮として入れない。
 *
 * ── 止める条件 (その人は作らない) ─────────────────────────────────────────
 *   利用者ではない行 (施設・役場 等) / 利用者マスタに 番号+氏名 で 1 人に決まらない /
 *   DB に 番号(HN- 含む)+氏名・(保険者,被保番)・氏名 (異体字・括弧を畳む)・生年月日+(姓|名|カナ) のどれかで既存 client が当たる (= 取りこぼしの疑い。新規にしない)
 *
 * ── あわせて (READ ONLY・件数だけ) ─────────────────────────────────────────
 *   利用者マスタ (有+無) の全員を DB と比べ、DB に居ない人 / 属性 (氏名・カナ・生年月日・性別) が食い違う人を数える (直さない)。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { resolveFukuyoguOffice, latestTeikyoDir, describeFukuyoguOffice } from "./_fukuyogu_office.mjs";
import { resolveUserMasterDirs } from "./_user_master_dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (opt("--revert") || opt("--cleanup-batch")) {
  const r = spawnSync(process.execPath, [join(HERE, "sync_fukuyogu_from_honobono.mjs"), ...argv], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...argv], { stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" } });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
const { C, TENANT, readKds0031, readEnv, parseCsvLine, nfkc, nName, nKana, nInsurer, nInsured, nCare, nDate, nRate, nGender, toInt, daysIn } = core;
const { readBenefitCsv } = await import("../scripts/_benefit-cert-csv.mjs");

const EXECUTE = argv.includes("--execute");
const SIMULATE = argv.includes("--simulate");
// 対象事業所: 既定 ケアサポ (介護ショップ ケア・サポート千葉 1bfc0d57…)。--area / --office-bn で切替 (_fukuyogu_office.mjs)
const FO = resolveFukuyoguOffice(argv);
if (!FO.isDefault) console.log(describeFukuyoguOffice(FO));
const OFFICE = FO.officeId;
const FUKUYOGU = FO.dir;
// 既定 = 最新の 用具貸与期間_ / 利用者マスタ_(全件_) (引数化の前は 20261109 に固定。ケアサポは今それしか無いので同じ)
const TEIKYO_DIR = resolve(opt("--teikyo-dir") ?? latestTeikyoDir(FUKUYOGU) ?? join(FUKUYOGU, "用具貸与期間_(未着)"));
const UMD = resolveUserMasterDirs(FUKUYOGU, argv, { log: false });
const UM_DIRS = [
  { reg: "有", dir: resolve(UMD.on ?? join(FUKUYOGU, "利用者マスタ_(未着)")) },
  { reg: "無", dir: resolve(UMD.off ?? join(FUKUYOGU, "利用者マスタ_全件_(未着)")) },
];
const REPO_ROOT = resolve(HERE, "../../..");
const SCRIPT_REL = "apps/order-app/migrations/create_missing_clients_from_teikyohyo.mjs";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP = "teikyo-missing-clients";
const MARK = "[teikyo-missing-clients-20261109]";
const OFFICE_SOURCE = "import_record";
/** 利用者ではない行 (提供票の利用者名)。施設・役所への貸与 */
const NOT_A_PERSON = /施設|老人保健|役場|市役所|町役場|病院|クリニック|株式会社|有限会社|\(株\)|（株）|法人|センター|ホーム|[^\s]園[・\s]|園$/;
/** これ以降の生年月日は ほのぼのの仮の値 (自費だけの人の登録日が入っている) */
const FAKE_BIRTH_FROM = "2020-01-01";

// ── 小道具 ────────────────────────────────────────────────────────────────
const nf = (s) => nfkc(s).replace(/[\s　]+/g, "");
const VAR = [..."靜髙﨑德巖邊邉齋齊濱澤櫻國瀨眞栁昜寬滿惠嵜冨榮曵"].reduce((m, ch, i) => (m[ch] = "静高崎徳巌辺辺斎斉浜沢桜国瀬真柳易寛満恵崎富栄曳"[i], m), {});
/** rebuild の fold と同じ (括弧を落とし、異体字を畳む)。rebuild より畳む字を増やしてある (嵜冨榮曵) */
const fold = (n) => nf(n).replace(/[(（].*?[)）]/g, "").replace(/./g, (ch) => VAR[ch] ?? ch);
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const relPath = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const pad = (n) => String(n).padStart(2, "0");
let seq = 0;
const newId = (k) => `new:${k}:${++seq}`;
const isNew = (id) => typeof id === "string" && id.startsWith("new:");
/** 負担割合: clients は percent 表記 "10"/"20"/"30"、認定は 割 表記 "1"/"2"/"3" (sync_fukuyogu_from_honobono.mjs と同じ) */
const clientCopayOf = (br) => ({ "90": "10", "80": "20", "70": "30" })[nRate(String(br ?? ""))] ?? null;
const certCopayOf = (br) => ({ "90": "1", "80": "2", "70": "3" })[nRate(String(br ?? ""))] ?? null;
const monthEnd = (ym) => `${ym}-${pad(daysIn(ym))}`;
const sOrNull = (s) => nfkc(s) || null;
const dOrNull = (s) => nDate(s) || null;
const iOrNull = (s) => (nfkc(s) === "" ? null : toInt(s));

function readSjis(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  const bad = rows.filter((r) => r.length !== head.length).length;
  if (bad) throw new Error(`★ ${path}: 列数が ${head.length} でない行 ${bad}`);
  const col = (name) => { const ex = head.indexOf(name); const i = ex >= 0 ? ex : head.findIndex((h) => h.startsWith(name)); if (i < 0) throw new Error(`★ ${path} に列「${name}」が無い`); return i; };
  return { path, head, rows, col };
}
const findCsv = (dir, prefix) => { const f = readdirSync(dir).find((x) => x.startsWith(prefix) && /\.csv$/i.test(x)); if (!f) throw new Error(`★ ${dir} に ${prefix}*.CSV が無い`); return join(dir, f); };

/**
 * 利用者マスタ (有+無) を読む。列の読み方は sync_fukuyogu_from_honobono.mjs の「利用者管理 CSV」と同じ。
 * 1 人 = 利用者番号+生年月日。有と無で同じ人が出たら止める (両方に出ることは無いはず)。
 */
function readUserMaster(sourceFiles) {
  const persons = new Map();
  const files = {};
  const overlap = []; // 有と無の両方に出た人
  const seenRow = new Set(); // 有と無で完全に同じ 介護保険・公費の行は 1 回だけ数える
  for (const { reg, dir } of UM_DIRS) {
    const UB = readSjis(findCsv(dir, "基本情報_")), UK = readSjis(findCsv(dir, "介護保険_")), UP = readSjis(findCsv(dir, "公費_")), UF = { path: findCsv(dir, "負担割合証等_") };
    files[reg] = { UB, UK, UP, UF };
    for (const [U, kind] of [[UB, "基本情報"], [UK, "介護保険 (全件・保険と認定)"], [UP, "公費 (全件)"]]) sourceFiles.push({ path: relPath(U.path), sha256: sha256(U.path), rows: U.rows.length, kind: `利用者管理 ${kind} (利用登録${reg})` });
    const b = (n) => UB.col(n);
    for (const r of UB.rows) {
      const no = nfkc(r[b("利用者番号")]), birth = nDate(r[b("生年月日")]);
      if (!no) continue; // 仮登録 (番号なし)
      const pid = `${no}|${birth}`;
      if (persons.has(pid)) {
        // 有と無の両方に同じ人が出ることがある (2026-11-09 実測 1 名 15133・行は完全に同じ)。同じ行なら 1 人として扱う (有を残す)
        if (persons.get(pid).line !== r.join(",")) throw new Error(`★ 基本情報に 利用者番号+生年月日 の重複で中身が違う ${pid} (${persons.get(pid).reg} と ${reg})`);
        overlap.push(pid);
        continue;
      }
      persons.set(pid, {
        pid, reg, line: r.join(","), userNo: no, birth, name: nfkc(r[b("利用者名")]), kana: nfkc(r[b("フリガナ")]), sameName: nfkc(r[b("同名識別")]), gender: nGender(r[b("性別")]),
        postal: sOrNull(r[b("郵便番号")]), address: sOrNull(r[b("住所")]), phone: sOrNull(r[b("電話番号")]), mobile: sOrNull(r[b("携帯番号")]),
        death: dOrNull(r[b("死亡日")]), certs: [], kohi: [], keys: new Set(), burden: [],
        raw: Object.fromEntries(["利用者番号", "利用者名", "フリガナ", "同名識別", "性別", "生年月日", "郵便番号", "住所", "電話番号", "携帯番号", "死亡日"].map((k) => [k, r[b(k)]])),
      });
    }
  }
  for (const { reg } of UM_DIRS) {
    const { UK, UP } = files[reg];
    const k = (n) => UK.col(n);
    for (const r of UK.rows) {
      const pid = `${nfkc(r[k("利用者番号")])}|${nDate(r[k("生年月日")])}`;
      const p = persons.get(pid);
      if (!p) { if (pid.startsWith("|")) continue; throw new Error(`★ 介護保険 CSV (利用登録${reg}) の利用者 ${pid} が基本情報に居ない`); }
      if (seenRow.has(`K|${r.join(",")}`)) continue;
      seenRow.add(`K|${r.join(",")}`);
      const c = {
        insStart: dOrNull(r[k("有効開始日")]), insEnd: dOrNull(r[k("有効終了日")]), insured: nInsured(r[k("被保険者番号")]), issued: dOrNull(r[k("交付年月日")]),
        insurerName: sOrNull(r[k("保険者")]), insurer: nInsurer(r[k("保険者番号")]), rate: nRate(r[k("給付率")]), confirmed: dOrNull(r[k("確認日")]), qualified: dOrNull(r[k("資格取得日")]),
        status: sOrNull(r[k("認定状況")]), care: nCare(r[k("要介護度")]) || null, certDate: dOrNull(r[k("認定年月日")]),
        start: dOrNull(r[k("認定有効期間－開始日")]), end: dOrNull(r[k("認定有効期間－終了日")]),
        limStart: dOrNull(r[k("適用期間－開始日")]), limEnd: dOrNull(r[k("適用期間－終了日")]), limit: iOrNull(r[k("区分支給限度基準額")]),
        office: sOrNull(r[k("支援事業所")]), cm: sOrNull(r[k("担当ケアマネジャー")]), restriction: sOrNull(r[k("サービス限定")]), memo: sOrNull(r[k("留意事項")]),
        officeFull: sOrNull(r[k("支援事業所（正式名称）")]), reg,
      };
      c.raw = Object.fromEntries(["有効開始日", "有効終了日", "被保険者番号", "保険者", "保険者番号", "給付率", "認定状況", "要介護度", "認定年月日", "認定有効期間－開始日", "認定有効期間－終了日", "区分支給限度基準額", "支援事業所（正式名称）", "担当ケアマネジャー"].map((n) => [n, r[k(n)]]));
      p.certs.push(c);
      if (c.insurer && c.insured) p.keys.add(`${c.insurer}|${c.insured}`);
    }
    const q = (n) => UP.col(n);
    for (const r of UP.rows) {
      const pid = `${nfkc(r[q("利用者番号")])}|${nDate(r[q("生年月日")])}`;
      const p = persons.get(pid);
      if (!p) { if (pid.startsWith("|")) continue; throw new Error(`★ 公費 CSV (利用登録${reg}) の利用者 ${pid} が基本情報に居ない`); }
      if (seenRow.has(`P|${r.join(",")}`)) continue;
      seenRow.add(`P|${r.join(",")}`);
      const hob = nfkc(r[q("法制コード")]).split(/\s+/)[0];
      const fut6 = nfkc(r[q("負担者番号")]);
      p.kohi.push({
        hob, fut: fut6.length === 6 ? hob + fut6 : fut6, jyu: sOrNull(r[q("受給者番号")]), confirmed: dOrNull(r[q("確認日")]),
        start: dOrNull(r[q("有効期限－開始日")]), end: dOrNull(r[q("有効期限－終了日")]), kubun: nfkc(r[q("介護医療区分")]), seiho: nfkc(r[q("生活保護区分")]),
        appType: sOrNull(r[q("申請区分")]), special: sOrNull(r[q("特別区分")]), outpatient: iOrNull(r[q("外来負担金")]), inpatient: iOrNull(r[q("入院負担金")]),
        selfPay: iOrNull(r[q("本人支払額")]), reg,
        raw: Object.fromEntries(["法制コード", "負担者番号", "受給者番号", "確認日", "有効期限－開始日", "有効期限－終了日", "生活保護区分", "介護医療区分", "本人支払額"].map((n) => [n, r[q(n)]])),
      });
    }
  }
  // 負担割合証等: 利用者番号が無いので (保険者番号, 被保番) で結ぶ。保険者名 → 番号は 有+無 両方の介護保険 CSV で変換 (_benefit-cert-csv.mts)
  const kaigoIns = UM_DIRS.map(({ reg }) => files[reg].UK.path);
  const burdenStats = {};
  const byKey = groupBy([...persons.values()].flatMap((p) => [...p.keys].map((k) => ({ k, p }))), (x) => x.k);
  const seenB = new Set();
  for (const { reg } of UM_DIRS) {
    const fpath = files[reg].UF.path;
    const { entries, stats } = readBenefitCsv(fpath, kaigoIns);
    sourceFiles.push({ path: relPath(fpath), sha256: sha256(fpath), rows: stats.rows, kind: `利用者管理 負担割合証等 (利用登録${reg})` });
    burdenStats[reg] = { データ行: stats.rows, 取込候補: entries.length, 保険者が決まらない: stats.insurerUnresolved, 重複をまとめた: stats.dupMerged, 人に結べない: 0, 複数の人に当たる: 0 };
    for (const e of entries) {
      const ps = [...new Set((byKey.get(`${e.insurer}|${e.insured}`) ?? []).map((x) => x.p))];
      if (ps.length === 0) { burdenStats[reg].人に結べない++; continue; }
      if (ps.length > 1) { burdenStats[reg].複数の人に当たる++; continue; }
      const key = `${ps[0].pid}|${e.kind}|${e.rate}|${e.from}|${e.to ?? ""}`;
      if (seenB.has(key)) continue;
      seenB.add(key);
      ps[0].burden.push({ ...e, reg, file: relPath(fpath) });
    }
  }
  return { persons, burdenStats, overlap };
}

/** その日に有効な認定 (認定済み優先・開始の新しい順)。sync と同じ */
const certAt = (p, day) => p.certs.filter((c) => c.start && c.start <= day && (!c.end || c.end >= day))
  .sort((a, b) => (a.status === "申請中") - (b.status === "申請中") || b.start.localeCompare(a.start))[0] ?? null;
/** その日の給付率: 負担割合証 (介護保険負担割合証) があればその率、無ければ 認定の給付率。sync の rateAt と同じ考え方 */
const rateAt = (p, c, day) => {
  const b = p.burden.filter((x) => x.kind === "介護保険負担割合証" && x.insurer === c.insurer && x.insured === c.insured && x.from <= day && (!x.to || x.to >= day)).sort((a, b2) => b2.from.localeCompare(a.from))[0];
  return (b?.rate != null ? String(b.rate) : "") || c.rate || null;
};
/** 仮の認定 (要介護度が空なのに 認定済み) */
const isFakeCert = (c) => !c.care && c.status !== "申請中";

async function makeSb() {
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
async function selectAll(sb, table, select, build = (q) => q) {
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
async function loadDb(sb) {
  const t = (q) => q.eq("tenant_id", TENANT);
  const db = {
    clients: await selectAll(sb, "clients", "id,user_number,name,furigana,birth_date,gender,office_id,deleted_at,insurer_number,insured_number", t),
    ins: await selectAll(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number", t),
    careOffices: await selectAll(sb, "care_offices", "id,office_number,name", t),
  };
  for (const k of ["clients", "ins", "careOffices"]) if (!db[k].length) throw new Error(`★ ${k} が 0 行 (tenant / 列名を疑う)`);
  console.log(`DB (READ ONLY): ${Object.entries(db).map(([k, v]) => `${k} ${v.length}`).join(" / ")}`);
  return db;
}
/** 列があるか (SELECT 1 件で見る。わざとエラーを起こして調べるのではない) */
async function hasColumns(sb, table, cols) {
  const { error } = await sb.from(table).select(["id", ...cols].join(",")).limit(1);
  return !error;
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${EXECUTE ? "★★ EXECUTE (本番書込み)" : "DRY RUN (DB は書き換えない)"}${SIMULATE ? " / --simulate" : ""}`);
  const sourceFiles = [];

  // 提供票 (実績行)
  const tfiles = readdirSync(TEIKYO_DIR).filter((f) => /^提供票_\d{6}\.csv$/i.test(f)).sort();
  if (!tfiles.length) throw new Error(`★ ${TEIKYO_DIR} に 提供票_YYYYMM.csv が無い`);
  const trows = [];
  for (const f of tfiles) {
    const T = readSjis(join(TEIKYO_DIR, f));
    const c = Object.fromEntries(["事業所名", "利用者番号", "利用者名", "提供年月", "サービス内容", "予定／実績", "概算単位数"].map((k) => [k, T.col(k)]));
    for (const r of T.rows) {
      if (nfkc(r[c["予定／実績"]]) !== "実績") continue;
      trows.push({ file: f, ym: nfkc(r[c.提供年月]).replace("/", "-"), office: nfkc(r[c.事業所名]), userNo: nfkc(r[c.利用者番号]), name: nfkc(r[c.利用者名]), svc: nfkc(r[c.サービス内容]), units: Number(nfkc(r[c.概算単位数]) || 0) });
    }
    sourceFiles.push({ path: relPath(T.path), sha256: sha256(T.path), rows: T.rows.length, kind: `提供票 ${f}` });
  }
  console.log(`提供票: ${tfiles.length} ファイル / 実績 ${trows.length} 行 / 利用者 ${new Set(trows.map((r) => r.userNo)).size}`);

  // 利用者マスタ (有+無) = 属性・認定・公費・負担割合証の出どころ
  const { persons, burdenStats, overlap } = readUserMaster(sourceFiles);
  const pAll = [...persons.values()];
  console.log(`利用者マスタ: 有 ${pAll.filter((p) => p.reg === "有").length} 名 + 無 ${pAll.filter((p) => p.reg === "無").length} 名 = ${pAll.length} 名 / 認定 ${pAll.reduce((s, p) => s + p.certs.length, 0)} 世代 / 公費 ${pAll.reduce((s, p) => s + p.kohi.length, 0)} 行 / 負担割合証等 (人に結べた) ${pAll.reduce((s, p) => s + p.burden.length, 0)} 件`);
  console.log(`  負担割合証等: ${JSON.stringify(burdenStats)}`);
  if (overlap.length) console.log(`  有と無の両方に出た人 ${overlap.length} 名 (行が同じなので 1 人として扱う。有を残す): ${overlap.join(", ")}`);
  const umByNo = groupBy(pAll, (p) => p.userNo);
  const umKeys = new Map(); // 利用者番号 → (保険者|被保番)。rebuild は「有」の介護保険 CSV だけで引く
  for (const p of pAll) if (p.reg === "有") for (const k of p.keys) { if (!umKeys.has(p.userNo)) umKeys.set(p.userNo, new Set()); umKeys.get(p.userNo).add(k); }

  // KDS0031 (4〜9 月の伝送の控え) — ★ 答え合わせだけ (作る値には使わない)
  const kdsBy = new Map();
  for (const d of readdirSync(FUKUYOGU).filter((x) => /^\d{6}$/.test(x)).sort()) {
    let fs = []; try { fs = readdirSync(join(FUKUYOGU, d, "ほのぼのから")).filter((f) => /^KDS0031.*\.csv$/i.test(f)); } catch { continue; }
    for (const f of fs) {
      const p = join(FUKUYOGU, d, "ほのぼのから", f);
      const { rows } = readKds0031(p);
      sourceFiles.push({ path: relPath(p), sha256: sha256(p), rows: rows.length, kind: "KDS0031 (答え合わせだけ。作る値には使わない)" });
      for (const r of rows) {
        if (!nfkc(r[13]).includes("基本")) continue; // レコード種別 = 基本情報レコード
        const no = nfkc(r[C.USER_NO]);
        if (!kdsBy.has(no)) kdsBy.set(no, []);
        kdsBy.get(no).push({ file: relPath(p), r });
      }
    }
  }

  // DB
  const sb = await makeSb();
  const CACHE = resolve(opt("--db-cache") ?? join(tmpdir(), "teikyo_missing_clients_db_v2.json"));
  let db;
  if (!EXECUTE && existsSync(CACHE) && !argv.includes("--refresh")) { db = JSON.parse(readFileSync(CACHE, "utf8")); console.log(`DB: 控えを使う ${CACHE} (取得 ${db.fetchedAt})。最新は --refresh`); }
  else { db = await loadDb(sb); db.fetchedAt = new Date().toISOString(); if (!EXECUTE) writeFileSync(CACHE, JSON.stringify(db)); }
  // 事業所別保険の列 (insurance_per_office_stage0.sql) / 本人支払額の列 / 負担割合証の表 があるか
  const cols = {
    insOffice: await hasColumns(sb, "client_insurance_records", ["office_id", "office_source"]),
    kohiOffice: await hasColumns(sb, "client_public_expenses", ["office_id", "office_source"]),
    kohiSelfPay: await hasColumns(sb, "client_public_expenses", ["self_pay_amount"]),
    benefit: await hasColumns(sb, "client_benefit_certificates", ["office_id", "office_source", "copied_from_id"]),
  };
  console.log(`DB の列: 認定 office_id/office_source ${cols.insOffice ? "あり" : "★無し"} / 公費 office_id/office_source ${cols.kohiOffice ? "あり" : "★無し"} / 公費 self_pay_amount ${cols.kohiSelfPay ? "あり" : "★無し"} / client_benefit_certificates (office 列込み) ${cols.benefit ? "あり" : "★無し (負担割合証は書かない)"}`);
  const officeCols = (has) => (has ? { office_id: OFFICE, office_source: OFFICE_SOURCE } : {});

  const byKey = new Map(); const addK = (a, b, id) => { const k = `${nInsurer(a)}|${nInsured(b)}`; if (k.startsWith("|") || k.endsWith("|")) return; if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(id); };
  for (const c of db.clients) addK(c.insurer_number, c.insured_number, c.id);
  for (const r of db.ins) addK(r.insurer_number, r.insured_number, r.client_id);
  const byNo = groupBy(db.clients.filter((c) => c.user_number), (c) => nfkc(c.user_number));
  const byFold = groupBy(db.clients, (c) => fold(c.name));
  const byNameBirth = groupBy(db.clients.filter((c) => c.birth_date), (c) => `${fold(c.name)}|${c.birth_date}`);
  const clientById = new Map(db.clients.map((c) => [c.id, c]));
  const coByNo = groupBy(db.careOffices.filter((c) => c.office_number), (c) => nfkc(c.office_number));
  const coByName = groupBy(db.careOffices, (c) => nName(c.name));
  /** 居宅: 支援事業所(正式名称) → 支援事業所 を care_offices の名前で一意に引く (入力側だけで決める。KDS の事業所番号は答え合わせだけ) */
  const careOfficeOf = (c) => {
    if (!c?.officeFull && !c?.office) return { co: null, no: null, how: "支援事業所なし" };
    const hit = (c.officeFull ? coByName.get(nName(c.officeFull)) : null) ?? (c.office ? coByName.get(nName(c.office)) : null) ?? [];
    return hit.length === 1 ? { co: hit[0], no: nfkc(hit[0].office_number) || null, how: "支援事業所名" } : { co: null, no: null, how: hit.length > 1 ? "名前が複数一致" : "名前が一致しない" };
  };
  const desc = (c) => `${c.name}/${c.user_number}/${c.birth_date ?? "-"}${c.deleted_at ? "/削除済" : ""}`;

  // ── 対象 = 提供票の利用者で DB に何の手掛かりも無い人 (rebuild の「引けない」と同じ集合になるはず) ──
  const ops = [];
  const results = [];
  const kdsCheck = []; // KDS との答え合わせ (作った値 ≠ KDS)
  const cls = { a: [], b: [], c: [], d: [] };
  for (const [userNo, rs] of groupBy(trows, (r) => r.userNo)) {
    const tName = rs[rs.length - 1].name;
    // rebuild が引ける人 (利用者マスタ「有」の保険者+被保番 / 番号+氏名 / 氏名) は対象外
    const viaUm = [...(umKeys.get(userNo) ?? [])].some((k) => byKey.has(k));
    const viaNo = [...(byNo.get(userNo) ?? []), ...(byNo.get(`HN-${userNo}`) ?? [])].some((c) => !c.deleted_at && fold(c.name) === fold(tName));
    const viaName = (byFold.get(fold(tName)) ?? []).some((c) => !c.deleted_at);
    if (viaUm || viaNo || viaName) continue;

    const months = [...new Set(rs.map((r) => r.ym))].sort();
    const kinds = [...new Set(rs.map((r) => (r.office === "自費レンタル" ? "自費" : r.office.startsWith("予") ? "予防" : "介護")))].sort();
    const R = { 利用者番号: userNo, 氏名: tName, 行: rs.length, 月: `${months[0]}〜${months[months.length - 1]}`, 制度: kinds.join("+"), 用具: [...new Set(rs.map((r) => r.svc))], 分類: null, 材料: null, 状態: "計画", 判定: [], 注意: [] };
    results.push(R);
    const stop = (why) => { R.状態 = "★ 止めた"; R.判定.push(why); };

    // (d) 利用者ではない行
    if (NOT_A_PERSON.test(tName)) { R.分類 = "d"; cls.d.push(R); stop("利用者ではない行 (施設・役場 等) → 作らない"); continue; }

    // 利用者マスタ (有+無) で 番号+氏名 が一致する人
    const umCands = (umByNo.get(userNo) ?? []).filter((p) => fold(p.name) === fold(tName));
    if ((umByNo.get(userNo) ?? []).length && !umCands.length) { R.分類 = "c"; cls.c.push(R); stop(`利用者マスタの同じ利用者番号に別の氏名 (${(umByNo.get(userNo) ?? []).map((p) => p.name).join(",")}) → 番号の使い回しの疑い`); continue; }
    if (umCands.length > 1) { R.分類 = "c"; cls.c.push(R); stop(`利用者マスタに 番号+氏名 が ${umCands.length} 人`); continue; }
    const P = umCands[0] ?? null;
    R.分類 = P ? "b" : "c";
    R.材料 = P ? `利用者マスタ (利用登録${P.reg})` : "利用者マスタに居ない → 提供票の氏名・番号だけ";
    const fakeBirth = !!(P?.birth && P.birth >= FAKE_BIRTH_FROM);
    const birth = P && !fakeBirth ? P.birth || null : null;
    if (fakeBirth) R.注意.push(`生年月日 ${P.birth} は仮の値 (登録日) とみて空にする。認定・負担割合証も仮の被保番なので入れない`);
    const certs = P && !fakeBirth ? P.certs.filter((c) => c.start && !isFakeCert(c)) : [];
    if (P && !fakeBirth) for (const c of P.certs) if (c.start && isFakeCert(c)) R.注意.push(`仮の認定 (要介護度が空・${c.status}) は入れない: ${c.insurer}|${c.insured} ${c.start}〜${c.end}`);

    // 取りこぼしの疑い: 既存 client に当たるか (削除済みも見る)
    const hits = [];
    for (const c of certs) for (const id of byKey.get(`${c.insurer}|${c.insured}`) ?? []) hits.push(`保険者+被保番 → ${desc(clientById.get(id))}`);
    for (const c of [...(byNo.get(userNo) ?? []), ...(byNo.get(`HN-${userNo}`) ?? [])]) if (fold(c.name) === fold(tName)) hits.push(`利用者番号+氏名 → ${desc(c)}`);
    for (const c of byFold.get(fold(tName)) ?? []) hits.push(`氏名 → ${desc(c)}`);
    if (birth) for (const c of db.clients) {
      if (c.birth_date !== birth) continue;
      const fc = fold(c.name), ft = fold(tName);
      if (fc.slice(0, 2) === ft.slice(0, 2) || fc.slice(-2) === ft.slice(-2) || (c.furigana && P?.kana && nKana(c.furigana) === nKana(P.kana))) hits.push(`生年月日+(姓|名|カナ) → ${desc(c)}`);
    }
    if (birth) for (const c of byNameBirth.get(`${fold(tName)}|${birth}`) ?? []) hits.push(`氏名+生年月日 → ${desc(c)}`);
    if (hits.length) { R.分類 = "a"; cls.a.push(R); stop(`既存 client に当たる (同一人物の疑い・新規にしない): ${[...new Set(hits)].join(" / ")}`); continue; }
    if (R.分類 === "b") cls.b.push(R); else cls.c.push(R);

    // ── clients ───────────────────────────────────────────────────────
    const userNumber = (byNo.get(userNo) ?? []).length ? `HN-${userNo}` : userNo;
    if ((byNo.get(userNumber) ?? []).length) { stop(`利用者番号 ${userNumber} も既にある`); continue; }
    // clients の認定系の列 = 最後に貸与した月から遡って 月末に有効な認定
    let cert = null, certMonth = null;
    if (P) for (const ym of [...months].reverse()) { const pp = { ...P, certs }; const c = certAt(pp, monthEnd(ym)); if (c) { cert = c; certMonth = ym; break; } }
    const asOf = certMonth ? monthEnd(certMonth) : null;
    if ((kinds.includes("介護") || kinds.includes("予防")) && !cert) R.注意.push(`★ ${kinds.join("+")} の貸与があるが 貸与月 (${R.月}) に有効な認定が 利用者マスタに無い (clients の認定系の列は空)`);
    if (cert && certMonth !== months[months.length - 1]) R.注意.push(`最後の貸与月 ${months[months.length - 1]} に有効な認定が無い → ${certMonth} 末日の認定で clients を埋める`);
    const co = careOfficeOf(cert);
    if (cert && !co.co && co.how !== "支援事業所なし") R.注意.push(`居宅 (支援事業所「${cert.officeFull ?? cert.office}」) が care_offices に引けない (${co.how}。care_office_id は書かない)`);
    const name = P ? P.name : nfkc(tName).replace(/\s*[(（][^)）]*[)）]\s*$/, "").trim();
    if (fold(name) !== fold(tName) || nf(name) !== nf(tName)) R.注意.push(`氏名: 提供票「${tName}」→ 利用者マスタ「${name}」${P?.sameName ? ` (同名識別 ${P.sameName})` : ""}`);
    const cid = newId("client");
    const umFiles = (reg) => UM_DIRS.find((d) => d.reg === reg).dir;
    const src = P
      ? { file: relPath(findCsv(umFiles(P.reg), "基本情報_")) + (cert ? ` + ${relPath(findCsv(umFiles(cert.reg), "介護保険_"))}` : ""), key: `ほのぼの利用者番号:${userNo}|${cert ? `${cert.insurer}|${cert.insured}` : ""}|${P.birth}`, ref: { 提供票: { 氏名: tName, 月: R.月, 制度: R.制度 }, 基本情報: P.raw, 認定: cert?.raw ?? null, as_of: asOf } }
      : { file: [...new Set(rs.map((r) => relPath(join(TEIKYO_DIR, r.file))))].join(" + "), key: `ほのぼの利用者番号:${userNo}`, ref: { 提供票: { 氏名: tName, 月: R.月, 制度: R.制度 } } };
    const ex = { 利用者番号: userNo, 氏名: name };
    const rate = cert ? rateAt(P, cert, asOf) : null;
    ops.push({ table: "clients", action: "insert", id: cid, cid, src, ref: ex, why: `新規 (提供票で引けない・${R.材料}。番号 ${userNumber}${userNumber !== userNo ? " = DB で番号が使用済みのため HN-" : ""})`, row: {
      tenant_id: TENANT, office_id: OFFICE, user_number: userNumber, name, furigana: P?.kana || null, birth_date: birth, gender: ["男", "女"].includes(P?.gender) ? P.gender : null,
      postal_code: P?.postal ?? null, address: P?.address ?? null, phone: P?.phone ?? null, mobile: P?.mobile ?? null,
      care_level: cert?.care ?? null, certification_start_date: cert?.start ?? null, certification_end_date: cert?.end ?? null,
      insurer_number: cert?.insurer || null, insured_number: cert?.insured || null,
      benefit_rate: rate, copay_rate: clientCopayOf(rate), care_office_id: co.co?.id ?? null,
      is_facility: false, is_provisional: false, status: P?.death ? "deceased" : "active", deleted_at: null,
    } });
    ops.push({ table: "client_office_assignments", action: "insert", id: newId("coa"), cid, src, ref: ex, why: "新規利用者の自事業所割当 (ケアサポ)",
      row: { tenant_id: TENANT, client_id: cid, office_id: OFFICE, start_date: `${months[0]}-01`, end_date: null } });

    // ── 認定 (介護保険 CSV の全世代。古い順) ─────────────────────────────
    for (const c of [...certs].sort((a, b) => a.start.localeCompare(b.start))) {
      const at = c.end && asOf && c.end < asOf ? c.end : !asOf || asOf < c.start ? c.start : asOf;
      const r8 = rateAt(P, c, at);
      const gco = careOfficeOf(c);
      ops.push({ table: "client_insurance_records", action: "insert", id: newId("ins"), cid, why: `利用者マスタ (利用登録${c.reg}) の認定 (全世代)`, ref: { ...ex, 認定: `${c.care ?? "(空)"}/${c.start}〜${c.end}` },
        src: { file: relPath(findCsv(umFiles(c.reg), "介護保険_")), key: `ほのぼの利用者番号:${userNo}|${c.insurer}|${c.insured}|認定開始:${c.start}`, ref: c.raw },
        row: {
          tenant_id: TENANT, client_id: cid, effective_date: c.start,
          care_level: c.care, certification_start_date: c.start, certification_end_date: c.end, insurer_number: c.insurer || null, insurer_name: c.insurerName,
          insured_number: c.insured || null, benefit_rate: r8, copay_rate: certCopayOf(r8), certification_status: c.care ? "認定済み" : "申請中", certification_date: c.certDate,
          issued_date: c.issued, insurance_confirmed_date: c.confirmed, qualification_date: c.qualified, insurance_valid_start: c.insStart, insurance_valid_end: c.insEnd,
          limit_period_start: c.limStart, limit_period_end: c.limEnd, service_limit_amount: c.limit, care_manager: c.cm, care_manager_org: c.office, care_office_name: c.officeFull,
          service_restriction: c.restriction ?? "なし", service_memo: c.memo, care_office_id: gco.co?.id ?? null, care_office_number: gco.no,
          birth_date: birth, notes: `${MARK} 出典 利用者マスタ (利用登録${c.reg})`, ...officeCols(cols.insOffice),
        } });
      if (c.status === "申請中" && c.care) R.注意.push(`認定状況=申請中 だが要介護度あり (認定済み で入れる。sync と同じ): ${c.care}/${c.start}`);
    }
    if (kinds.length === 1 && kinds[0] === "自費" && certs.length) R.注意.push(`自費だけの人に認定 ${certs.length} 世代 (利用者マスタのとおり入れる): ${certs.map((c) => `${c.care ?? "(空)"}/${c.insurer}|${c.insured}/${c.start}〜${c.end}`).join(", ")}`);

    // ── 公費 (公費 CSV の全行) ───────────────────────────────────────
    let nKohi = 0;
    for (const k of P?.kohi ?? []) {
      if (k.kubun && k.kubun !== "介護") { R.注意.push(`公費: 介護医療区分が 介護 でない (入れない) ${k.fut}`); continue; }
      if (!/^\d{8}$/.test(k.fut)) { R.注意.push(`公費: 負担者番号が 8 桁にならない (入れない) ${k.fut}`); continue; }
      nKohi++;
      ops.push({ table: "client_public_expenses", action: "insert", id: newId("kohi"), cid, why: `利用者マスタ (利用登録${k.reg}) の公費`, ref: { ...ex, 負担者: k.fut, 期間: `${k.start}〜${k.end}` },
        src: { file: relPath(findCsv(umFiles(k.reg), "公費_")), key: `ほのぼの利用者番号:${userNo}|${k.fut}|${k.jyu}|${k.start}`, ref: k.raw },
        row: { tenant_id: TENANT, client_id: cid, hohei_code: k.hob, futan_sha_number: k.fut, jukyu_sha_number: k.jyu, valid_start: k.start, valid_end: k.end,
          confirmed_date: k.confirmed ?? null, application_type: k.appType ?? null, special_type: k.special ?? null, outpatient_copay: k.outpatient ?? null, inpatient_copay: k.inpatient ?? null,
          ...(cols.kohiSelfPay ? { self_pay_amount: k.selfPay ?? null } : {}), ...officeCols(cols.kohiOffice) } });
    }

    // ── 負担割合証等 (client_benefit_certificates。取込エンジンと同じ列) ──────────
    let nBen = 0;
    const certKeys = new Set(certs.map((c) => `${c.insurer}|${c.insured}`));
    for (const e of P && !fakeBirth ? P.burden : []) {
      if (!certKeys.has(`${e.insurer}|${e.insured}`)) { R.注意.push(`負担割合証: 入れる認定に無い (保険者,被保番) ${e.insurer}|${e.insured} (入れない)`); continue; }
      if (!cols.benefit) continue;
      nBen++;
      ops.push({ table: "client_benefit_certificates", action: "insert", id: newId("cbc"), cid, why: `利用者マスタ (利用登録${e.reg}) の負担割合証等`, ref: { ...ex, 種類: e.kind, 給付率: e.rate, 期間: `${e.from}〜${e.to ?? ""}` },
        src: { file: e.file, key: `${e.insurer}|${e.insured}|${e.kind}|${e.from}`, ref: { line: e.line, name: e.name } },
        row: { tenant_id: TENANT, client_id: cid, insurer_number: e.insurer, insured_number: e.insured, kind: e.kind, benefit_rate: e.rate, valid_from: e.from, valid_to: e.to,
          restriction: e.restriction, source: "honobono_csv", notes: `${MARK}${e.note ? ` 備考: ${e.note}` : ""}`, office_id: OFFICE, copied_from_id: null, office_source: OFFICE_SOURCE } });
    }
    R.判定.push(`作る: clients 1 / 割当 1 / 認定 ${certs.length} / 公費 ${nKohi} / 負担割合証 ${nBen}`);

    // ── 答え合わせ (KDS0031 = 請求の出力。比べるだけ) ────────────────────
    const kr = kdsBy.get(userNo) ?? [];
    if (kr.length) {
      const diffs = [];
      const kName = [...new Set(kr.map((x) => fold(x.r[C.NAME])))];
      if (!kName.includes(fold(name))) diffs.push(`氏名 ${name} ≠ KDS ${kName}`);
      const kKana = [...new Set(kr.map((x) => nKana(x.r[C.KANA])).filter(Boolean))];
      if (kKana.length && !kKana.includes(nKana(P?.kana))) diffs.push(`カナ ${P?.kana} ≠ KDS ${kKana}`);
      const kBirth = [...new Set(kr.map((x) => nDate(x.r[C.BIRTH])).filter(Boolean))];
      if (kBirth.length && !kBirth.includes(birth ?? "")) diffs.push(`生年月日 ${birth ?? "(空)"} ≠ KDS ${kBirth}`);
      const kGender = [...new Set(kr.map((x) => nGender(x.r[C.GENDER])).filter(Boolean))];
      if (kGender.length && !kGender.includes(P?.gender)) diffs.push(`性別 ${P?.gender} ≠ KDS ${kGender}`);
      for (const [ym, xs] of groupBy(kr, (x) => nfkc(x.r[C.SVC_MONTH]).replace("/", "-").slice(0, 7))) {
        const r = xs[0].r;
        const c = P ? certAt({ ...P, certs }, monthEnd(ym)) : null;
        const kInfo = `${nCare(r[C.CARE_LEVEL])}/${nDate(r[C.CERT_START])}〜${nDate(r[C.CERT_END])}/${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}/給付率${nRate(r[C.BENEFIT])}/居宅${nfkc(r[C.CARE_OFFICE])}`;
        if (!c) { diffs.push(`${ym}: 有効な認定を作らない ≠ KDS ${kInfo}`); continue; }
        const d = [];
        if (nCare(r[C.CARE_LEVEL]) !== (c.care ?? "")) d.push(`要介護度 ${c.care}≠${nCare(r[C.CARE_LEVEL])}`);
        if (nDate(r[C.CERT_START]) !== c.start || nDate(r[C.CERT_END]) !== (c.end ?? "")) d.push(`認定期間 ${c.start}〜${c.end}≠${nDate(r[C.CERT_START])}〜${nDate(r[C.CERT_END])}`);
        if (nInsurer(r[C.INSURER]) !== c.insurer || nInsured(r[C.INSURED]) !== c.insured) d.push(`保険者/被保番 ${c.insurer}|${c.insured}≠${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}`);
        const rr = rateAt(P, c, monthEnd(ym));
        if (nRate(r[C.BENEFIT]) !== (rr ?? "")) d.push(`給付率 ${rr}≠${nRate(r[C.BENEFIT])}`);
        const kco = nfkc(r[C.CARE_OFFICE]);
        const mine = careOfficeOf(c);
        if (kco && kco !== (mine.no ?? "")) d.push(`居宅 ${mine.no ?? `(引けない:${c.officeFull ?? c.office ?? ""})`}≠${kco}${coByNo.get(kco)?.[0] ? `(${coByNo.get(kco)[0].name})` : ""}`);
        const kFut = [C.FUTAN1, C.FUTAN2, C.FUTAN3].map((f) => nfkc(r[f])).filter(Boolean);
        const myFut = (P?.kohi ?? []).filter((k) => k.start && k.start <= monthEnd(ym) && (!k.end || k.end >= `${ym}-01`)).map((k) => k.fut);
        for (const f of kFut) if (!myFut.includes(f)) d.push(`公費 KDS ${f} が当月の公費に無い`);
        for (const f of myFut) if (!kFut.includes(f)) d.push(`公費 ${f} が KDS に無い`);
        if (d.length) diffs.push(`${ym}: ${d.join(" / ")}`);
      }
      kdsCheck.push({ 利用者番号: userNo, 氏名: name, KDS月: [...new Set(kr.map((x) => nfkc(x.r[C.SVC_MONTH])))].sort(), 一致: diffs.length === 0, 差: diffs });
    }
  }

  // ── 全件比較 (READ ONLY・件数だけ): 利用者マスタ (有+無) の全員 vs DB ──────────
  const full = { 利用者マスタ: pAll.length, 有: 0, 無: 0, DBに居る: 0, DBに居ない: 0, DBに居ない_今回作る: 0, DBに居ない_提供票に居る他: 0, DBに居ない_提供票に居ない: 0, 複数に当たる: 0, 引き当て方: {}, 属性の食い違い_人: 0, 属性の食い違い_項目: {}, 例: { DBに居ない: [], 提供票に居る他: [], 食い違い: [] } };
  const createdNos = new Set(results.filter((r) => r.状態 === "計画").map((r) => r.利用者番号));
  const teikyoNos = new Set(trows.map((r) => r.userNo));
  for (const p of pAll) {
    full[p.reg]++;
    let cands = [], how = "";
    const realKeys = p.birth && p.birth >= FAKE_BIRTH_FROM ? [] : p.certs.filter((c) => !isFakeCert(c)).map((c) => `${c.insurer}|${c.insured}`);
    cands = [...new Set(realKeys.flatMap((k) => [...(byKey.get(k) ?? [])]))].map((id) => clientById.get(id)).filter((c) => c && !c.deleted_at); how = "保険者+被保番";
    if (cands.length > 1) { const t = cands.filter((c) => fold(c.name) === fold(p.name)); if (t.length) cands = t; }
    if (!cands.length) { cands = [...(byNo.get(p.userNo) ?? []), ...(byNo.get(`HN-${p.userNo}`) ?? [])].filter((c) => !c.deleted_at && fold(c.name) === fold(p.name)); how = "利用者番号+氏名"; }
    if (!cands.length && p.birth) { cands = (byNameBirth.get(`${fold(p.name)}|${p.birth}`) ?? []).filter((c) => !c.deleted_at); how = "氏名+生年月日"; }
    if (!cands.length) {
      full.DBに居ない++;
      full[`DBに居ない_${p.reg}`] = (full[`DBに居ない_${p.reg}`] ?? 0) + 1;
      if (createdNos.has(p.userNo)) full.DBに居ない_今回作る++;
      else if (teikyoNos.has(p.userNo)) { full.DBに居ない_提供票に居る他++; full.例.提供票に居る他.push(`${p.reg} ${p.userNo} ${p.name} ${p.birth}`); }
      else full.DBに居ない_提供票に居ない++;
      if (!createdNos.has(p.userNo) && full.例.DBに居ない.length < 15) full.例.DBに居ない.push(`${p.reg} ${p.userNo} ${p.name} ${p.birth}`);
      continue;
    }
    if (cands.length > 1) { full.複数に当たる++; continue; }
    full.DBに居る++;
    full.引き当て方[how] = (full.引き当て方[how] ?? 0) + 1;
    const c = cands[0];
    const d = [];
    if (fold(c.name) !== fold(p.name)) d.push("氏名");
    if (p.kana && nKana(c.furigana) !== nKana(p.kana)) d.push(c.furigana ? "カナ" : "カナ(DB空)");
    if (p.birth && p.birth < FAKE_BIRTH_FROM && nDate(c.birth_date) !== p.birth) d.push(c.birth_date ? "生年月日" : "生年月日(DB空)");
    if (["男", "女"].includes(p.gender) && c.gender && c.gender !== p.gender) d.push("性別");
    if (["男", "女"].includes(p.gender) && !c.gender) d.push("性別(DB空)");
    if (d.length) {
      full.属性の食い違い_人++;
      for (const x of d) full.属性の食い違い_項目[`${x}`] = (full.属性の食い違い_項目[x] ?? 0) + 1;
      if (full.例.食い違い.length < 15) full.例.食い違い.push(`${p.reg} ${p.userNo} ${p.name} [${d.join(",")}] DB=${c.name}/${c.furigana}/${c.birth_date}/${c.gender} 利用者マスタ=${p.kana}/${p.birth}/${p.gender}`);
    }
  }

  // ── 出力 ───────────────────────────────────────────────────────────
  console.log(`\n== 対象 (提供票で DB に手掛かりが無い利用者) ${results.length} 名`);
  console.log(`   (a) DB に居た疑い ${cls.a.length} / (b) 利用者マスタに居る ${cls.b.length} (有 ${cls.b.filter((r) => r.材料?.includes("有")).length} / 無 ${cls.b.filter((r) => r.材料?.includes("無")).length}) / (c) 利用者マスタにも居ない ${cls.c.length} / (d) 利用者ではない ${cls.d.length}`);
  for (const R of results) {
    console.log(`\n(${R.分類}) ${R.利用者番号} ${R.氏名} — ${R.状態} / ${R.制度} ${R.月} 実績 ${R.行} 行 / 材料: ${R.材料 ?? "-"}`);
    for (const s of R.判定) console.log(`     判定: ${s}`);
    for (const s of R.注意) console.log(`     注意: ${s}`);
  }
  const keySets = {};
  for (const o of ops) (keySets[o.table] ??= new Set()).add(Object.keys(o.row).sort().join(","));
  console.log(`\n══ 合計 ══ 書込み ${ops.length} 件 ${JSON.stringify(countBy(ops, (o) => `${o.table} ${o.action}`))}`);
  console.log(`insert のキー集合 (表ごとの種類数。1 であること): ${JSON.stringify(Object.fromEntries(Object.entries(keySets).map(([t, v]) => [t, v.size])))}`);
  console.log(`作る利用者: ${results.filter((r) => r.状態 === "計画").length} 名 / 止めた: ${results.filter((r) => r.状態 !== "計画").map((r) => `${r.利用者番号} ${r.氏名}`).join(", ") || "なし"}`);
  console.log("trigger: client_insurance_records の追加で care_plan_elements 等が作られる → 実行時に「書込み → 掃除」(参照先がこの batch の行のものだけ消して記録)");
  console.log(`\n== 答え合わせ (KDS0031 = 請求の出力。★ 作る値には使っていない) 対象 ${kdsCheck.length} 名 / 一致 ${kdsCheck.filter((x) => x.一致).length} / 差あり ${kdsCheck.filter((x) => !x.一致).length}`);
  for (const x of kdsCheck.filter((y) => !y.一致)) { console.log(`   ${x.利用者番号} ${x.氏名} (KDS ${x.KDS月.join(",")})`); for (const d of x.差) console.log(`       ${d}`); }
  console.log(`\n== 全件比較 (READ ONLY・直さない) 利用者マスタ 有 ${full.有} + 無 ${full.無} = ${full.利用者マスタ} 名`);
  console.log(`   DB に居る ${full.DBに居る} (${JSON.stringify(full.引き当て方)}) / 複数に当たる ${full.複数に当たる} / DB に居ない ${full.DBに居ない} (有 ${full.DBに居ない_有 ?? 0} / 無 ${full.DBに居ない_無 ?? 0}。今回作る ${full.DBに居ない_今回作る} / 提供票に居る他 ${full.DBに居ない_提供票に居る他} / 提供票に居ない ${full.DBに居ない_提供票に居ない})`);
  for (const l of full.例.提供票に居る他) console.log(`     提供票に居るが この照合では DB に引けない (rebuild は別の引き方で引けている人): ${l}`);
  console.log(`   属性 (氏名・カナ・生年月日・性別) が食い違う ${full.属性の食い違い_人} 名 ${JSON.stringify(full.属性の食い違い_項目)}`);
  for (const l of full.例.DBに居ない) console.log(`     居ない例: ${l}`);
  for (const l of full.例.食い違い) console.log(`     食い違い例: ${l}`);

  let sim = null;
  if (SIMULATE) sim = simulateRebuild(ops, results);

  const outPath = resolve(opt("--out") ?? join(tmpdir(), "teikyo_missing_clients.json"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ sourceFiles, results, kdsCheck, full, ops, sim }, null, 1));
  console.log(`\n詳細 JSON: ${outPath}`);
  if (!EXECUTE) { console.log("\nDRY RUN — DB は書き換えていない。--execute で本番 (★ user 承認後)"); return; }
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) { console.error(`★ 出どころ記録の表 ${t} が無い (${error.message}) → --execute しない`); process.exit(2); }
  }
  await execute(sb, ops, sourceFiles);
}

/**
 * 作った後に rebuild_rentals_from_teikyohyo.mjs を DRY RUN したらどうなるか。
 * rebuild の DB 控え (--db-cache) に 作る clients / 認定 を足した写しを作り、rebuild をその控えで回して詳細 JSON を読む。DB は読むだけ。
 */
function simulateRebuild(ops, results) {
  const base = resolve(opt("--rebuild-cache") ?? join(tmpdir(), "teikyo_rebuild_db_cache.json"));
  const outDir = join(tmpdir(), "teikyo-missing-clients-sim");
  mkdirSync(outDir, { recursive: true });
  const run = (cache, out) => {
    const r = spawnSync(process.execPath, [join(HERE, "rebuild_rentals_from_teikyohyo.mjs"), "--db-cache", cache, "--out-dir", out], { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "" } });
    if (r.status !== 0) throw new Error(`rebuild の DRY RUN が失敗 (exit ${r.status}): ${(r.stderr || r.stdout).slice(-2000)}`);
    return JSON.parse(readFileSync(join(out, "teikyo_rebuild.json"), "utf8"));
  };
  // 作る前 (控えが無ければ rebuild に 1 回 DB を読ませて作る)
  const before = run(base, join(outDir, "before"));
  const cache = JSON.parse(readFileSync(base, "utf8"));
  const simId = new Map();
  for (const o of ops.filter((x) => x.table === "clients")) {
    const id = `sim-${o.row.user_number}`; simId.set(o.id, id);
    cache.clients.push({ id, user_number: o.row.user_number, name: o.row.name, office_id: o.row.office_id, deleted_at: null, insurer_number: o.row.insurer_number, insured_number: o.row.insured_number });
  }
  for (const o of ops.filter((x) => x.table === "client_insurance_records")) cache.ins.push({ id: `sim-${o.id}`, client_id: simId.get(o.row.client_id), insurer_number: o.row.insurer_number, insured_number: o.row.insured_number });
  const augPath = join(outDir, "rebuild_db_cache_with_new_clients.json");
  writeFileSync(augPath, JSON.stringify(cache));
  const after = run(augPath, join(outDir, "after"));
  const ids = new Set(simId.values());
  const unresolved = (j) => (Object.entries(j.report.users).find(([k]) => k.includes("引けない"))?.[1]?.items ?? []);
  const mine = after.ops.filter((o) => ids.has(o.cid));
  const res = {
    作る前_引けない: unresolved(before).length, 作った後_引けない: unresolved(after).length,
    作った後も引けない: unresolved(after).map((x) => `${x.利用者番号} ${x.氏名}`),
    この人たちの書込み: countBy(mine, (o) => `${o.table} ${o.action}${o.row?.payment_type ? `(${o.row.payment_type})` : ""}`),
    台数: mine.filter((o) => o.table === "order_items" && o.action === "insert").reduce((s, o) => s + (o.row.quantity ?? 1), 0),
    用具が引けない台: (after.report.plan["★ 用具が引けない台 (入れない。その利用者の DB だけ明細は消さない)"]?.items ?? []).filter((x) => results.some((r) => fold(r.氏名) === fold(x.氏名))),
    答え合わせ_前: before.checks.map((c) => `${c.ym} KDSだけ ${c.利用者_KDSだけ}名 / 全行一致 ${c.利用者_全行一致}/${c.利用者_両方} / 引けない行 ${c.KDS_利用者を引けない行}`),
    答え合わせ_後: after.checks.map((c) => `${c.ym} KDSだけ ${c.利用者_KDSだけ}名 / 全行一致 ${c.利用者_全行一致}/${c.利用者_両方} / 引けない行 ${c.KDS_利用者を引けない行}`),
    作った人の答え合わせ: after.checks.map((c) => ({ ym: c.ym, 例: c.例.filter((e) => results.some((r) => r.状態 === "計画" && fold(r.氏名) === fold(e.氏名 ?? ""))).map((e) => `${e.型} ${e.氏名}`) })).filter((x) => x.例.length),
  };
  console.log("\n== 模擬: 作った後に rebuild_rentals_from_teikyohyo.mjs を DRY RUN (DB は読むだけ・控えに clients を足して回した)");
  console.log(`   提供票で引けない利用者: ${res.作る前_引けない} → ${res.作った後_引けない} 名 (${res.作った後も引けない.join(", ") || "なし"})`);
  console.log(`   この人たちの貸与の書込み見込み: ${JSON.stringify(res.この人たちの書込み)} / 台数 ${res.台数}`);
  if (res.用具が引けない台.length) console.log(`   用具が引けない台 (入らない): ${res.用具が引けない台.map((x) => `${x.氏名}:${x.用具}`).join(", ")}`);
  console.log(`   答え合わせ (KDS × 置き換え後) 前: ${res.答え合わせ_前.join(" | ")}`);
  console.log(`   答え合わせ (KDS × 置き換え後) 後: ${res.答え合わせ_後.join(" | ")}`);
  for (const x of res.作った人の答え合わせ) console.log(`   ${x.ym} 作った人で差が残る: ${x.例.join(", ")}`);
  return res;
}

// ── 本番書込み (fix_honobono_sync_7_cases_202609.mjs と同じ作法) ──────────────
const DERIVED = [["doc_tasks", "trigger_ref_id"], ["care_plan_elements", "ref_id"]];
async function execute(sb, writes, sourceFiles) {
  const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: sourceFiles, script: SCRIPT_REL, args: argv.join(" "), step: STEP, status: "running",
    notes: "提供票で clients に引けない利用者を作る (利用者マスタ 利用登録＝無 の元利用者・自費の人。属性・認定・公費・負担割合証は利用者マスタから)",
  }).select("id").single();
  if (bErr) throw new Error(`data_import_batches: ${bErr.message}`);
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  const record = async (recs) => { for (const c of chunks(recs, 100)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); } };
  const srcRef = (o) => ({ file: o.src?.file ?? null, why: o.why, ...(o.src?.ref ?? {}) });
  const idMap = new Map();
  const fix = (v) => (isNew(v) ? idMap.get(v) ?? null : v);
  const touched = new Set();
  const doCleanup = async () => {
    const cids = [...new Set(writes.map((o) => fix(o.cid)).filter(Boolean))];
    for (const [t, refCol] of DERIVED) {
      // 新規の利用者だけなので、その client_id の派生行は全部この batch のもの。ただし参照先がこの batch の行のものだけ消す
      const rows = await selectIn(sb, t, "*", "client_id", cids, (q) => q.eq("tenant_id", TENANT));
      const mine = rows.filter((r) => touched.has(r[refCol]));
      for (const c of chunks(mine.map((r) => r.id), 150)) {
        const { error, count } = await sb.from(t).delete({ count: "exact" }).in("id", c);
        if (error || count !== c.length) throw new Error(`掃除 ${t}: ${error?.message ?? `削除件数 ${count} ≠ ${c.length}`}`);
      }
      await record(mine.map((r) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger", source_ref: { cleanup: true, 理由: "新規利用者の作成で trigger が作った行" }, before: r, after: null })));
      console.log(`  掃除 ${t}: 消した ${mine.length} / 参照先が違うので消さなかった行 ${rows.length - mine.length}`);
    }
  };
  try {
    for (const table of ["clients", "client_office_assignments", "client_insurance_records", "client_public_expenses", "client_benefit_certificates"]) {
      const ins = [];
      for (const o of writes.filter((x) => x.table === table && x.action === "insert")) {
        const row = Object.fromEntries(Object.entries(o.row).map(([k, v]) => [k, k === "client_id" ? fix(v) : v]));
        if ("client_id" in o.row && !row.client_id) await fail(`${table}: 参照先の client がまだ無い (${o.row.client_id})`);
        ins.push({ o, row });
      }
      const batches = [];
      for (const x of ins) {
        const k = Object.keys(x.row).sort().join(",");
        const last = batches[batches.length - 1];
        // 認定は 1 行ずつ (trigger の掃除で参照先を確実に結ぶため。同期と同じ)
        if (last && last.k === k && last.rows.length < (table === "client_insurance_records" ? 1 : 100)) last.rows.push(x); else batches.push({ k, rows: [x] });
      }
      let n = 0;
      for (const { rows: c } of batches) {
        const { data, error } = await sb.from(table).insert(c.map((x) => x.row)).select("id");
        if (error) await fail(`insert ${table}: ${error.message}`);
        if (data.length !== c.length) await fail(`insert ${table}: 返った行数 ${data.length} ≠ ${c.length}`);
        data.forEach((d, j) => { idMap.set(c[j].o.id, d.id); touched.add(d.id); });
        await record(c.map((x, j) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: data[j].id, op: "insert", source_key: x.o.src?.key ?? null, source_ref: srcRef(x.o), before: null, after: x.row })));
        n += c.length;
      }
      if (n) console.log(`  ${table}: 追加 ${n}`);
    }
  } catch (e) {
    console.error(`\n★ 途中で失敗: ${e.message}\n  ここまでに trigger が作った行の掃除だけは行う`);
    try { await doCleanup(); } catch (e2) { console.error(`★ 掃除も失敗: ${e2.message} → --cleanup-batch ${BATCH} で後から掃除すること`); }
    throw e;
  }
  try { await doCleanup(); } catch (e) { await fail(`掃除: ${e.message} (--cleanup-batch ${BATCH} で後から掃除できる)`); }
  // 件数確認
  const newClientIds = writes.filter((o) => o.table === "clients").map((o) => idMap.get(o.id));
  const got = await selectIn(sb, "clients", "id", "id", newClientIds);
  if (got.length !== newClientIds.length) await fail(`verify: clients ${got.length} ≠ ${newClientIds.length}`);
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH} / clients ${got.length} 名 / data_import_rows ${count} 行。取り消しは --revert ${BATCH}`);
  console.log("★ 続けて rebuild_rentals_from_teikyohyo.mjs を DRY RUN → この人たちの貸与が入る計画になっているか確認してから --execute");
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
