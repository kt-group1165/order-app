/**
 * 福祉用具 CM 指示単位数 (fukuyogu_cm_units) を ほのぼの福祉用具「請求 > 月次情報」CSV の
 * 「区分支給限度基準内単位数」から入れる (2026-11-09 / FY-G)。
 *
 *   node migrations/import_cm_units_from_getsuji.mjs                          # DRY RUN (既定。DB は読むだけ)
 *   node migrations/import_cm_units_from_getsuji.mjs --mode A                 # DRY RUN (案 A = 全員)
 *   node migrations/import_cm_units_from_getsuji.mjs [--mode B] --execute     # 本番 (★ user 承認後)
 *   node migrations/import_cm_units_from_getsuji.mjs --revert <batch_id> [--execute]
 *     --dir <dir>          既定 kaigo-app/伝送データ/ケアサポ/福祉用具/月次情報 (月次情報_YYYYMM.csv を全部読む)
 *     --teikyo-dir <dir>   既定 kaigo-app/伝送データ/ケアサポ/福祉用具/用具貸与期間_20261109 (提供票_YYYYMM.csv)
 *     --user-master-dir <dir> / --user-master-dir-off <dir>   利用者マスタ (登録有 / 登録無)。既定 = 日付が最新のフォルダ
 *     --months 2026-04,2026-05   対象月を絞る (既定 = 月次情報にある全月)
 *     --overwrite-manual   既存行のうち 取込マーカーの無い行 (= 画面で人が入れた値) も上書きする (既定は上書きしない)
 *
 * ── 何の値か ─────────────────────────────────────────────────────────────
 *   月次情報の「区分支給限度基準内単位数」= ケアマネの給付管理 (給付管理票の計画単位数) を取り込んだ値 = **入力側**。
 *   ほのぼのはこの値で保険請求の上限を決める (2026-11-09 画面確認)。ほのぼのの請求の出力 (KDS0031 / KK) は使わない
 *   (SESSION_START ⑬ の循環にしないため。答え合わせは別に行う)。
 *   CSV: cp932・38 列・1 行 = 利用者 × 月 × (介護 = 事業所名「ケア・サポート千葉」/ 予防 =「予ケア・サポート千葉」)。
 *   同じ人・同じ月に 2 行 (保険変更・介護⇔予防) あることがある。
 *
 * ── 入れる対象 ───────────────────────────────────────────────────────────
 *   案 B (既定): 区分支給限度基準内単位数 < 提供票の実績単位 の人だけ (0 を含む)。
 *        = 上限として実際に効く人だけ。請求画面の「空欄 = 実績で請求」と同じ意味になる
 *   案 A: 全員 (単位数 ≥ 実績の人も「給付管理の値」として残す。上限としては効かない)
 *   実績単位 = 提供票 (入力側) の実績行・保険の事業所 (自費レンタル事業所・自費レンタル=対象 を除く) の 概算単位数 の合計。
 *   1 利用者 × 月 に月次情報が 2 行以上あるとき: 単位数の合計を その月の値とする。ただし どれかの行で
 *     単位数 < その区分 (介護/予防) の実績 なら 自動では決めず 対象外 (手で確認) にする (表は利用者×月で 1 値しか持てない)。
 *
 * ── 利用者の引き当て ─────────────────────────────────────────────────────
 *   月次情報の 保険者 は名前なので、利用者番号 → 利用者マスタ (介護保険_*.CSV、利用登録 有 + 無) の (保険者番号, 被保番) のうち
 *   被保番が月次情報と一致するもの → clients の列 ∪ client_insurance_records。複数なら 未削除 → ケアサポ所属 → 氏名 で絞る
 *   (rebuild_rentals_from_teikyohyo.mjs と同じ作法)。引けなければ 利用者番号 (clients.user_number / HN-) + 氏名。
 *   1 人に決まらなければ 対象外 (書かない)。
 *
 * ── 既存行との関係 ───────────────────────────────────────────────────────
 *   同じ値 → skip / 違う値 → update (取込マーカー [import-cm-units-getsuji] / [seed-fukuyogu-cm-units-202609] の行だけ。
 *   マーカーの無い行 = 画面で人が入れた値は 上書きせず 対象外。--overwrite-manual で上書き)。
 *   案 B で「対象でなくなった」既存行 (単位数 ≥ 実績) は 消さない (表示だけ)。
 *
 * ── 書込みの作法 (--execute) ─────────────────────────────────────────────
 *   _exec_lock.mjs で同時実行を止める。data_import_batches → 各書込みの直後に data_import_rows (before/after)。
 *   変更前の行は migrations/_backup_import_cm_units_getsuji_<時刻>.json にも保存。insert は 1 行ずつ (キー集合は全行同じ)。
 *   update は「読んだときの units のまま」の行だけ (eq units) で更新件数 1 を確認。最後にマーカー付き行の件数を確認。
 *   --revert: insert した行は「現在値 = after」なら delete / update した行は「現在値 = after」なら before の値に戻す。
 *
 * ── 参考 (READ ONLY の報告) ──────────────────────────────────────────────
 *   月次情報の 支援事業所番号・作成区分 (= 月ごとの担当居宅・計画作成区分) と、今の DB
 *   (clients.care_office_id → care_offices.office_number / その月に有効な認定行の care_office) の食い違い件数を出す。直さない。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";
import { resolveUserMasterDirs } from "./_user_master_dir.mjs";
import { resolveFukuyoguOffice, latestTeikyoDir, describeFukuyoguOffice } from "./_fukuyogu_office.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
const { TENANT, readEnv, nInsurer, nInsured, nfkc, parseCsvLine } = core;

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const MODE = (opt("--mode") ?? "B").toUpperCase();
if (!["A", "B"].includes(MODE)) { console.error("--mode は A か B"); process.exit(1); }
const OVERWRITE_MANUAL = argv.includes("--overwrite-manual");
const REPO_ROOT = resolve(HERE, "../../..");
// 対象事業所: 既定 ケアサポ (介護ショップ ケア・サポート千葉 1bfc0d57…)。--area / --office-bn で切替 (_fukuyogu_office.mjs)
const FO = resolveFukuyoguOffice(argv);
if (!FO.isDefault) console.log(describeFukuyoguOffice(FO));
const FUKUYOGU = FO.dir;
const DIR = resolve(opt("--dir") ?? join(FUKUYOGU, "月次情報"));
// 既定 = 最新の 用具貸与期間_YYYYMMDD (引数化の前は 20261109 に固定。ケアサポは今それしか無いので同じ)
const TEIKYO_DIR = resolve(opt("--teikyo-dir") ?? latestTeikyoDir(FUKUYOGU) ?? join(FUKUYOGU, "用具貸与期間_(未着)"));
// 既定 = 利用者マスタ_YYYYMMDD / 利用者マスタ_全件_YYYYMMDD の最新。--user-master-dir / --user-master-dir-off で上書き
const UM = resolveUserMasterDirs(FUKUYOGU, argv);
const UM_DIRS = [UM.on, UM.off].filter(Boolean);
const MONTHS_ARG = opt("--months")?.split(",").map((s) => s.trim()) ?? null;
const SCRIPT_REL = "apps/order-app/migrations/import_cm_units_from_getsuji.mjs";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP_NAME = "import-cm-units-getsuji";
const MARK = "[import-cm-units-getsuji]";
const OWN_MARKS = [MARK, "[seed-fukuyogu-cm-units-202609]"];
// 名前は従来のまま (中身は --area / --office-bn で選んだ事業所。既定 ケアサポ)
const CAPASAPO_OFFICE = FO.officeId;
const CAPASAPO_BN = FO.bn;
const TABLE = "fukuyogu_cm_units";
let EXEC_LOCK = null;

const rel = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const countBy = (a, f) => { const m = {}; for (const x of a) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const VAR = [..."靜髙﨑德巖邊邉齋齊濱澤櫻國瀨眞栁昜寬滿惠"].reduce((m, ch, i) => (m[ch] = "静高崎徳巌辺辺斎斉浜沢桜国瀬真柳易寛満恵"[i], m), {});
const fold = (n) => nfkc(n).replace(/[\s　]+/g, "").replace(/[(（].*?[)）]/g, "").replace(/./g, (ch) => VAR[ch] ?? ch);

function readSjis(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  const bad = rows.filter((r) => r.length !== header.length).length;
  if (bad) throw new Error(`★ ${rel(path)}: 列数が ${header.length} でない行が ${bad} 行`);
  return { path, header, rows };
}
const colOf = (f, name) => { const i = f.header.findIndex((h) => nfkc(h) === nfkc(name)); if (i < 0) throw new Error(`★ ${rel(f.path)} に列「${name}」が無い`); return i; };
const kindOf = (officeName) => (nfkc(officeName).startsWith("予") ? "予防" : "介護");

// ── 月次情報 ──────────────────────────────────────────────────────────────
function readGetsuji() {
  const files = readdirSync(DIR).filter((f) => /^月次情報_\d{6}\.csv$/i.test(f)).sort();
  if (!files.length) throw new Error(`★ ${rel(DIR)} に 月次情報_YYYYMM.csv が無い`);
  const recs = [], sourceFiles = [];
  for (const f of files) {
    const ym = `${f.match(/(\d{4})(\d{2})/)[1]}-${f.match(/(\d{4})(\d{2})/)[2]}`;
    if (MONTHS_ARG && !MONTHS_ARG.includes(ym)) continue;
    const F = readSjis(join(DIR, f));
    if (F.header.length !== 38) throw new Error(`★ ${f}: 列数 ${F.header.length} (38 のはず)`);
    const c = Object.fromEntries(["事業所番号", "事業所名", "利用者番号", "利用者名", "処理年月", "保険変更", "保険者", "被保険者番号", "作成区分", "支援事業所番号", "居宅介護支援事業所名", "区分支給限度基準内単位数"].map((n) => [n, colOf(F, n)]));
    for (const r of F.rows) {
      if (nfkc(r[c.事業所番号]) !== CAPASAPO_BN) throw new Error(`★ ${f}: 事業所番号 ${r[c.事業所番号]} (${FO.area} ${CAPASAPO_BN} ではない)`);
      if (nfkc(r[c.処理年月]).replace("/", "-") !== ym) throw new Error(`★ ${f}: 処理年月 ${r[c.処理年月]} がファイル名と違う`);
      const u = nfkc(r[c.区分支給限度基準内単位数]);
      if (!/^\d+$/.test(u)) throw new Error(`★ ${f}: ${r[c.利用者名]} 区分支給限度基準内単位数 "${u}" が整数でない`);
      recs.push({ ym, userNo: nfkc(r[c.利用者番号]), name: nfkc(r[c.利用者名]), kind: kindOf(r[c.事業所名]), henko: nfkc(r[c.保険変更]),
        insurerName: nfkc(r[c.保険者]), insured: nInsured(r[c.被保険者番号]), sakusei: nfkc(r[c.作成区分]),
        shien: nfkc(r[c.支援事業所番号]), shienName: nfkc(r[c.居宅介護支援事業所名]), units: Number(u) });
    }
    sourceFiles.push(rel(F.path));
    console.log(`月次情報 ${f}: ${F.rows.length} 行`);
  }
  return { recs, sourceFiles };
}

// ── 提供票の実績単位 (月 × 利用者番号 × 介護/予防) ──────────────────────────
function readActual(months) {
  const act = new Map(), sourceFiles = [];
  for (const ym of months) {
    const p = join(TEIKYO_DIR, `提供票_${ym.replace("-", "")}.csv`);
    if (!existsSync(p)) throw new Error(`★ ${rel(p)} が無い (実績単位が出せない)`);
    const F = readSjis(p);
    const c = Object.fromEntries(["事業所名", "利用者番号", "提供年月", "自費レンタル", "予定／実績", "概算単位数"].map((n) => [n, colOf(F, n)]));
    for (const r of F.rows) {
      if (nfkc(r[c["予定／実績"]]) !== "実績") continue;
      if (nfkc(r[c.提供年月]).replace("/", "-") !== ym) throw new Error(`★ ${rel(p)}: 提供年月 ${r[c.提供年月]}`);
      const office = nfkc(r[c.事業所名]);
      if (office === "自費レンタル" || nfkc(r[c.自費レンタル]) === "対象") continue;
      const k = `${ym}|${nfkc(r[c.利用者番号])}|${kindOf(office)}`;
      act.set(k, (act.get(k) ?? 0) + Number(nfkc(r[c.概算単位数]) || 0));
    }
    sourceFiles.push(rel(p));
  }
  // 概算単位数は小数 4 桁表記 (200.0000)。単位は整数
  for (const [k, v] of act) act.set(k, Math.round(v));
  return { act, sourceFiles };
}

// ── 利用者マスタ: 利用者番号 → (保険者, 被保番) ─────────────────────────────
function readUserMaster() {
  const keysOf = new Map(), sourceFiles = [];
  for (const d of UM_DIRS) {
    const f = existsSync(d) ? readdirSync(d).find((x) => x.startsWith("介護保険_") && /\.csv$/i.test(x)) : null;
    if (!f) { console.log(`  (利用者マスタ ${rel(d)} に 介護保険_*.CSV が無い → 飛ばす)`); continue; }
    const F = readSjis(join(d, f));
    const a = colOf(F, "利用者番号"), b = colOf(F, "保険者番号"), c = colOf(F, "被保険者番号");
    for (const r of F.rows) {
      const ins = nInsurer(r[b]), insd = nInsured(r[c]);
      if (!ins || !insd) continue;
      const no = nfkc(r[a]);
      if (!keysOf.has(no)) keysOf.set(no, new Set());
      keysOf.get(no).add(`${ins}|${insd}`);
    }
    sourceFiles.push(rel(F.path));
  }
  if (!keysOf.size) throw new Error("★ 利用者マスタ (介護保険) が 1 件も読めない");
  return { keysOf, sourceFiles };
}

// ── DB (READ ONLY) ───────────────────────────────────────────────────────
async function makeSb() {
  const env = readEnv();
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
    clients: await selectAll(sb, "clients", "id,user_number,name,office_id,deleted_at,insurer_number,insured_number,care_office_id", t),
    ins: await selectAll(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number,care_office_id,care_office_number,certification_start_date,certification_end_date,effective_date", t),
    careOffices: await selectAll(sb, "care_offices", "id,office_number,name,plan_kubun", t),
    existing: await selectAll(sb, TABLE, "id,client_id,service_month,units,note", (q) => t(q).eq("office_id", CAPASAPO_OFFICE)),
  };
  for (const k of ["clients", "ins", "careOffices"]) if (!db[k].length) throw new Error(`★ ${k} が 0 行 (tenant / 列名を疑う)`);
  console.log(`DB (READ ONLY): ${Object.entries(db).map(([k, v]) => `${k} ${v.length}`).join(" / ")}`);
  return db;
}

// ── 計画 ─────────────────────────────────────────────────────────────────
function plan(G, act, keysOf, db) {
  const clientById = new Map(db.clients.map((c) => [c.id, c]));
  const byKey = new Map(), byNo = new Map();
  const addK = (ins, insd, id) => { const k = `${nInsurer(ins)}|${nInsured(insd)}`; if (k.startsWith("|") || k.endsWith("|")) return; if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(id); };
  for (const c of db.clients) {
    addK(c.insurer_number, c.insured_number, c.id);
    if (!c.deleted_at && c.user_number) { const k = nfkc(c.user_number); if (!byNo.has(k)) byNo.set(k, []); byNo.get(k).push(c); }
  }
  for (const r of db.ins) addK(r.insurer_number, r.insured_number, r.client_id);
  const narrowC = (cs, name) => {
    let x = [...new Map(cs.filter((c) => c && !c.deleted_at).map((c) => [c.id, c])).values()];
    if (x.length > 1) { const t = x.filter((c) => c.office_id === CAPASAPO_OFFICE); if (t.length) x = t; }
    if (x.length > 1) { const t = x.filter((c) => fold(c.name) === fold(name)); if (t.length) x = t; }
    return x;
  };
  const resolveCache = new Map();
  const resolveClient = (g) => {
    const ck = `${g.userNo}|${g.insured}|${g.name}`;
    if (resolveCache.has(ck)) return resolveCache.get(ck);
    const keys = [...(keysOf.get(g.userNo) ?? [])].filter((k) => k.endsWith(`|${g.insured}`));
    let cs = narrowC(keys.flatMap((k) => [...(byKey.get(k) ?? [])]).map((id) => clientById.get(id)), g.name), how = "保険者+被保番 (利用者マスタ経由)";
    if (!cs.length) { cs = narrowC([...(byNo.get(g.userNo) ?? []), ...(byNo.get(`HN-${g.userNo}`) ?? [])], g.name).filter((c) => fold(c.name) === fold(g.name)); how = "利用者番号+氏名"; }
    const res = cs.length === 1 ? { c: cs[0], how } : { c: null, how: cs.length ? `候補 ${cs.length} 人 (${cs.map((c) => c.name).join(" / ")})` : `引けない (利用者マスタに被保番一致 ${keys.length})` };
    resolveCache.set(ck, res);
    return res;
  };

  // 利用者番号 × 月 にまとめる
  const groups = new Map();
  for (const g of G) { const k = `${g.ym}|${g.userNo}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(g); }
  const existing = new Map(db.existing.map((r) => [`${r.client_id}|${r.service_month}`, r]));
  const R = { A: [], B: [], skip: [], same: { A: 0, B: 0 }, keepManual: [], rel: [], sameKeysB: new Set() };
  const seenTarget = new Set();
  for (const [k, rows] of groups) {
    const [ym, userNo] = k.split("|");
    const per = rows.map((g) => ({ ...g, actual: act.get(`${ym}|${userNo}|${g.kind}`) ?? 0 }));
    for (const p of per) R.rel.push({ ym, kind: p.kind, rel: p.units === 0 ? "0" : p.actual === 0 ? "実績0" : p.units >= p.actual ? "以上" : "未満" });
    const units = per.reduce((s, p) => s + p.units, 0);
    const actual = new Set(per.map((p) => p.kind)).size === per.length
      ? per.reduce((s, p) => s + p.actual, 0)
      : [...new Set(per.map((p) => p.kind))].reduce((s, kd) => s + (act.get(`${ym}|${userNo}|${kd}`) ?? 0), 0);
    const anyBelow = per.some((p) => p.units < p.actual);
    const label = { ym, userNo, name: per[0].name, units, actual, rows: per.length };
    const resolved = per.map((p) => resolveClient(p));
    const cids = [...new Set(resolved.map((r) => r.c?.id ?? null))];
    if (cids.includes(null) || cids.length !== 1) {
      R.skip.push({ ...label, 理由: `利用者を 1 人に決められない: ${resolved.map((r) => r.how).join(" / ")}`, 案B対象: anyBelow });
      continue;
    }
    const c = resolved[0].c;
    if (per.length > 1 && anyBelow) {
      R.skip.push({ ...label, client: c.name, 理由: `月次情報が ${per.length} 行 (${per.map((p) => `${p.kind} ${p.henko} ${p.insured} 単位 ${p.units}/実績 ${p.actual}`).join(" | ")}) で どれかの行が実績未満 — 表は利用者×月で 1 値なので手で確認`, 案B対象: true });
      continue;
    }
    const tkey = `${c.id}|${ym}`;
    if (seenTarget.has(tkey)) { R.skip.push({ ...label, client: c.name, 理由: "同じ client・月が別の利用者番号でも出ている (二重登録?)", 案B対象: anyBelow }); continue; }
    seenTarget.add(tkey);
    const row = { tenant_id: TENANT, office_id: CAPASAPO_OFFICE, client_id: c.id, service_month: ym, units,
      note: `${MARK} 月次情報 ${ym} 区分支給限度基準内単位数 (ほのぼの 利用者番号 ${userNo}${per.length > 1 ? ` / ${per.length} 行の合計` : ""}・提供票の実績 ${actual})` };
    const ex = existing.get(tkey);
    for (const mode of ["A", "B"]) {
      if (mode === "B" && !(units < actual)) continue;
      if (!ex) { R[mode].push({ action: "insert", key: `${ym}|${userNo}`, name: c.name, how: resolved[0].how, actual, row }); continue; }
      if (ex.units === units) { R.same[mode]++; if (mode === "B") R.sameKeysB.add(tkey); continue; }
      const own = OWN_MARKS.some((m) => String(ex.note ?? "").startsWith(m));
      if (!own && !OVERWRITE_MANUAL) { if (mode === MODE) R.keepManual.push({ ...label, client: c.name, 既存: ex.units, 月次情報: units, note: ex.note }); continue; }
      R[mode].push({ action: "update", key: `${ym}|${userNo}`, name: c.name, how: resolved[0].how, actual, id: ex.id, before: { units: ex.units, note: ex.note }, after: { units, note: row.note }, row });
    }
  }
  // 案 B の対象外になった既存行 (消さない。表示だけ)
  const targetB = new Set([...R.B.map((o) => `${o.row.client_id}|${o.row.service_month}`), ...R.sameKeysB]);
  const months = new Set(G.map((g) => g.ym));
  const notInB = db.existing.filter((r) => months.has(r.service_month) && !targetB.has(`${r.client_id}|${r.service_month}`))
    .map((r) => ({ client: clientById.get(r.client_id)?.name, month: r.service_month, units: r.units, note: r.note }));
  return { ...R, notInB, clientById, resolveClient };
}

// ── 参考: 担当居宅・作成区分 (月次情報) と DB の食い違い ─────────────────────
function careOfficeReport(G, db, resolveClient, clientById) {
  const coById = new Map(db.careOffices.map((c) => [c.id, c]));
  const insBy = new Map(); for (const r of db.ins) { if (!insBy.has(r.client_id)) insBy.set(r.client_id, []); insBy.get(r.client_id).push(r); }
  const sakuseiCode = (s) => (s.startsWith("居宅介護支援") ? "1" : s.startsWith("被保険者自己") ? "2" : s.startsWith("予防支援") ? "3" : `?${s}`);
  const out = {};
  const ex = [];
  const inc = (ym, k) => { out[ym] ??= {}; out[ym][k] = (out[ym][k] ?? 0) + 1; };
  for (const g of G) {
    const r = resolveClient(g);
    if (!r.c) { inc(g.ym, "利用者を引けない"); continue; }
    const c = clientById.get(r.c.id);
    const cur = c.care_office_id ? coById.get(c.care_office_id)?.office_number ?? "(care_offices に無い id)" : "";
    inc(g.ym, `clients.care_office_id ${cur === g.shien ? "一致" : cur ? "食い違い" : "空"}`);
    if (cur && cur !== g.shien && ex.length < 15) ex.push({ ym: g.ym, 氏名: g.name, 月次情報: `${g.shien} ${g.shienName}`, clients: cur });
    const ms = `${g.ym}-01`;
    const me = new Date(Date.UTC(+g.ym.slice(0, 4), +g.ym.slice(5, 7), 0)).toISOString().slice(0, 10);
    const cert = (insBy.get(c.id) ?? []).filter((x) => (!x.certification_start_date || x.certification_start_date <= me) && (!x.certification_end_date || x.certification_end_date >= ms))
      .sort((a, b) => String(b.effective_date ?? b.certification_start_date ?? "").localeCompare(String(a.effective_date ?? a.certification_start_date ?? "")))[0];
    const certNo = cert ? (cert.care_office_id ? coById.get(cert.care_office_id)?.office_number : null) ?? cert.care_office_number ?? "" : null;
    inc(g.ym, `その月の認定行 ${certNo == null ? "無し" : certNo === g.shien ? "一致" : certNo ? "食い違い" : "担当居宅 空"}`);
    // 作成区分: 伝送 (build.ts 項19) の導出 = 担当居宅あり ? (予防 && plan_kubun 3 ? 3 : 1) : 2
    const co = c.care_office_id ? coById.get(c.care_office_id) : null;
    const derived = co ? (g.kind === "予防" && co.plan_kubun === "3" ? "3" : "1") : "2";
    inc(g.ym, `作成区分 ${sakuseiCode(g.sakusei) === derived ? "一致" : `食い違い (月次 ${sakuseiCode(g.sakusei)} / DB から ${derived})`}`);
  }
  return { out, ex };
}

// ── 書込み ───────────────────────────────────────────────────────────────
async function execute(sb, ops, sourceFiles) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: sourceFiles, script: SCRIPT_REL,
    args: argv.join(" "), step: STEP_NAME, notes: `福祉用具 CM 指示単位数を月次情報から (案 ${MODE}) insert ${ops.filter((o) => o.action === "insert").length} / update ${ops.filter((o) => o.action === "update").length}`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_import_cm_units_getsuji_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, mode: MODE, ops }, null, 2));
  for (const o of ops) {
    let rowId, before = null, after;
    if (o.action === "insert") {
      const { data, error } = await sb.from(TABLE).insert(o.row).select("id").single();
      if (error) await fail(`insert ${TABLE} ${o.name} ${o.row.service_month}: ${error.message}`);
      rowId = data.id; after = o.row;
    } else {
      const { error, count } = await sb.from(TABLE).update(o.after, { count: "exact" }).eq("id", o.id).eq("units", o.before.units);
      if (error || count !== 1) await fail(`update ${TABLE} ${o.name} ${o.row.service_month}: ${error?.message ?? `件数 ${count} (読んだ後に変わった?)`}`);
      rowId = o.id; before = o.before; after = o.after;
    }
    const { error: e2 } = await sb.from("data_import_rows").insert({
      batch_id: BATCH, tenant_id: TENANT, table_name: TABLE, row_id: rowId, op: o.action, source_key: o.key,
      source_ref: { 由来: "月次情報 区分支給限度基準内単位数", 提供票の実績: o.actual, 案: MODE, 引き当て: o.how }, before, after,
    });
    if (e2) await fail(`data_import_rows: ${e2.message}`);
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== ops.length) await fail(`verify: data_import_rows ${count} ≠ ${ops.length}`);
  const { count: c2, error: e4 } = await sb.from(TABLE).select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT).eq("office_id", CAPASAPO_OFFICE).like("note", `${MARK}%`);
  if (e4) await fail(`verify ${TABLE}: ${e4.message}`);
  console.log(`  確認: ${TABLE} のマーカー ${MARK} 付き行 ${c2} 件`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 件。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId).eq("table_name", TABLE));
  const cur = new Map((await selectIn(sb, TABLE, "id,units", "id", recs.map((r) => r.row_id))).map((r) => [r.id, r]));
  const back = recs.filter((r) => cur.get(r.row_id)?.units === r.after.units);
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 戻す ${back.length} / 記録 ${recs.length} (${JSON.stringify(countBy(back, (r) => r.op))}。値が変わった行・既に無い行は触らない)`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し (同時実行ロック用。行の記録はしない)` }, async () => {
    for (const r of back) {
      const q = r.op === "insert"
        ? sb.from(TABLE).delete({ count: "exact" }).eq("id", r.row_id).eq("units", r.after.units)
        : sb.from(TABLE).update({ units: r.before.units, note: r.before.note }, { count: "exact" }).eq("id", r.row_id).eq("units", r.after.units);
      const { error, count } = await q;
      if (error || count !== 1) throw new Error(`revert ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
    }
    const status = back.length === recs.length ? "reverted" : "partially_reverted";
    const { error } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
    if (error) throw new Error(`batch: ${error.message}`);
    console.log(`取り消し完了 (${status})`);
  });
}

// ── main ─────────────────────────────────────────────────────────────────
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  案 ${MODE}${OVERWRITE_MANUAL ? " / --overwrite-manual" : ""}`);
const sb = await makeSb();
if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
if (REVERT) { await revert(sb, REVERT); process.exit(0); }

const { recs: G, sourceFiles: f1 } = readGetsuji();
const months = [...new Set(G.map((g) => g.ym))].sort();
const { act, sourceFiles: f2 } = readActual(months);
const { keysOf, sourceFiles: f3 } = readUserMaster();
const db = await loadDb(sb);
const P = plan(G, act, keysOf, db);

console.log("\n== 区分支給限度基準内単位数 と 提供票の実績単位 (月次情報の行単位)");
for (const ym of months) console.log(`  ${ym}  ${JSON.stringify(countBy(P.rel.filter((r) => r.ym === ym), (r) => `${r.kind} ${r.rel}`))}`);
console.log(`  作成区分 ${JSON.stringify(countBy(G, (g) => g.sakusei))} / 介護・予防 ${JSON.stringify(countBy(G, (g) => g.kind))}`);

for (const mode of ["A", "B"]) {
  const ops = P[mode];
  console.log(`\n== 案 ${mode}${mode === MODE ? " (★ --execute で書くのはこちら)" : ""}: insert ${ops.filter((o) => o.action === "insert").length} / update ${ops.filter((o) => o.action === "update").length} / 既存と同じ値 ${P.same[mode]}`);
  for (const ym of months) console.log(`  ${ym}  ${JSON.stringify(countBy(ops.filter((o) => o.row.service_month === ym), (o) => `${o.action}${o.row.units === 0 ? " (0)" : ""}`))}`);
  if (mode === "B") for (const o of ops) console.log(`   ${o.action === "insert" ? "+" : "~"} ${o.row.service_month} ${o.name}  ${o.action === "update" ? `${o.before.units} → ` : ""}${o.row.units} 単位 (実績 ${o.actual}${o.row.units === 0 ? " ★ 0 = 全額保険外" : ""})  [${o.how}]`);
}
console.log(`\n== 対象外 (書かない) ${P.skip.length} 件 / うち 案 B の対象になりうる (単位数 < 実績) ${P.skip.filter((s) => s.案B対象).length}`);
for (const s of P.skip.filter((x) => x.案B対象)) console.log(`  ★ ${JSON.stringify(s)}`);
console.log(`  理由別 (全件): ${JSON.stringify(countBy(P.skip, (s) => s.理由.replace(/[:(].*$/, "")))}`);
if (P.keepManual.length) { console.log(`\n== 画面で入れた値と違うので上書きしない (--overwrite-manual で上書き) ${P.keepManual.length}`); for (const s of P.keepManual) console.log(`  ${JSON.stringify(s)}`); }
if (P.notInB.length) { console.log(`\n== 既存行のうち 案 B の対象に入らないもの (消さない) ${P.notInB.length}`); for (const s of P.notInB) console.log(`  ${JSON.stringify(s)}`); }

const co = careOfficeReport(G, db, P.resolveClient, P.clientById);
console.log("\n== 参考 (READ ONLY): 月次情報の 支援事業所番号・作成区分 と 今の DB の食い違い (月次情報の行単位・直さない)");
for (const ym of months) console.log(`  ${ym}  ${JSON.stringify(co.out[ym])}`);
for (const e of co.ex) console.log(`    例 ${JSON.stringify(e)}`);

const ops = P[MODE];
if (EXECUTE) {
  if (!ops.length) { console.log("\n書くものが無い"); process.exit(0); }
  await execute(sb, ops, [...f1, ...f2, ...f3]);
} else console.log(`\nDRY RUN 終了 (DB には何も書いていません)。--execute で 案 ${MODE} の ${ops.length} 件を書きます (★ user 承認後)`);
