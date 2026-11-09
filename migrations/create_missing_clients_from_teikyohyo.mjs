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
 *   --user-master-dir <dir>  既定 kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109
 *   --db-cache <json> / --refresh   DRY RUN の DB 控え (既定 OS 一時フォルダ。--execute は必ず読み直す)
 *   --rebuild-cache <json>   --simulate で使う rebuild の DB 控え (無ければ rebuild に 1 回読ませて作る)
 *   --out <json>             詳細の出力先
 *
 * ── 背景 (2026-11-09) ────────────────────────────────────────────────────────
 *   提供票 4〜10 月から貸与を組み直したとき、DB の clients に引けない利用者 50 名 / 172 台 は何もしなかった。
 *   1 人ずつ調べた結果 (FY-N):
 *     (a) DB に居た (取りこぼし)                 0 名  … 保険者+被保番 / 番号 / 氏名(異体字を畳む) / 生年月日+カナ・姓・名 で全 9,269 名 (削除済み含む) を照会
 *     (b) 利用者マスタに居る                      0 名  … 利用者マスタ_20261109 は「利用登録有」= 今の利用者だけ。50 名は 1 人も居ない
 *     (c) 利用者マスタにも居ない                 48 名  … 利用登録が外れた元利用者・自費だけの人
 *           うち KDS0031 (4〜9 月の伝送の控え) に居る 13 名 → 氏名・カナ・生年月日・性別・保険者+被保番・要介護度・認定期間・給付率・居宅 は KDS の値
 *           残り 35 名                                     → 提供票の氏名・利用者番号だけ
 *     (d) 利用者ではない行                         2 件  … 「介護老人保健施設 葵の園・緑区」「長柄町 役場」 → 作らない
 *
 * ── 作り方 (fix_honobono_sync_7_cases_202609.mjs の新規作成 case 3・4 と同じ作法) ─────────────
 *   clients: user_number = ほのぼのの利用者番号 (DB で空いていれば。使われていれば HN-<番号>。rebuild は両方で引く)
 *            office_id = ケアサポ / is_facility=false / is_provisional=false / status='active' / insert のキー集合は全員同じ
 *            氏名の (千葉) 等の同名識別は外す (rebuild は括弧を畳んで比べるので引ける)
 *   client_office_assignments: ケアサポ (tenant_id 付き)。start_date = 提供票の最初の月の 1 日
 *   client_insurance_records: KDS に居る人だけ。KDS の基本情報レコードの (保険者,被保番,認定期間,要介護度,給付率,居宅) ごとに 1 行。
 *            notes に マーカー + 出典。KDS に居ない人は作らない (保険の情報が無い)
 *   client_public_expenses: KDS の公費 1〜3 (負担者 8 桁) があれば。期間 = KDS に出た最初の月の 1 日〜最後の月の末日
 *   trigger (client_insurance_records → care_plan_elements 等) が作った行は 書込み後に掃除して記録 (同期と同じ)
 *   data_import_batches / data_import_rows に before/after。--revert で戻せる
 *
 * ── 止める条件 (その人は作らない) ─────────────────────────────────────────
 *   利用者ではない行 (施設・役場 等) / 利用者マスタに居る ((b) は同期 script の作法で別に扱う。今回 0 名) /
 *   DB に 番号(HN- 含む)+氏名・(保険者,被保番)・氏名 (異体字・括弧を畳む)・氏名+生年月日 のどれかで既存 client が当たる (= (a) の疑い。新規にしない) /
 *   KDS の同じ利用者番号に 別の氏名が居る / KDS の 生年月日・性別 が人の中で割れる
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

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
const { C, TENANT, readKds0031, readEnv, parseCsvLine, nfkc, nKana, nInsurer, nInsured, nCare, nDate, nRate, nGender, daysIn } = core;

const EXECUTE = argv.includes("--execute");
const SIMULATE = argv.includes("--simulate");
const OFFICE = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a"; // 介護ショップ ケア・サポート千葉
const FUKUYOGU = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const TEIKYO_DIR = resolve(opt("--teikyo-dir") ?? join(FUKUYOGU, "用具貸与期間_20261109"));
const UM_DIR = resolve(opt("--user-master-dir") ?? join(FUKUYOGU, "利用者マスタ_20261109"));
const REPO_ROOT = resolve(HERE, "../../..");
const SCRIPT_REL = "apps/order-app/migrations/create_missing_clients_from_teikyohyo.mjs";
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP = "teikyo-missing-clients";
const MARK = "[teikyo-missing-clients-20261109]";
/** 利用者ではない行 (提供票の利用者名)。施設・役所への貸与 */
const NOT_A_PERSON = /施設|老人保健|役場|市役所|町役場|病院|クリニック|株式会社|有限会社|\(株\)|（株）|法人|センター|ホーム|[^\s]園[・\s]|園$/;

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
const clientCopayOf = (br) => ({ "90": "10", "80": "20", "70": "30" })[nRate(String(br ?? ""))] ?? null;
const certCopayOf = (br) => ({ "90": "1", "80": "2", "70": "3" })[nRate(String(br ?? ""))] ?? null;
const monthEnd = (ym) => `${ym}-${pad(daysIn(ym))}`;
/** 氏名から 同名識別の括弧 ((千葉) 等) を外す */
const cleanName = (s) => nfkc(s).replace(/\s*[(（][^)）]*[)）]\s*$/, "").trim();

function readSjis(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  const head = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  const bad = rows.filter((r) => r.length !== head.length).length;
  if (bad) throw new Error(`★ ${path}: 列数が ${head.length} でない行 ${bad}`);
  const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`★ ${path} に列「${name}」が無い`); return i; };
  return { path, head, rows, col };
}

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
    clients: await selectAll(sb, "clients", "id,user_number,name,furigana,birth_date,office_id,deleted_at,insurer_number,insured_number", t),
    ins: await selectAll(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number", t),
    careOffices: await selectAll(sb, "care_offices", "id,office_number,name", t),
  };
  for (const k of ["clients", "ins", "careOffices"]) if (!db[k].length) throw new Error(`★ ${k} が 0 行 (tenant / 列名を疑う)`);
  console.log(`DB (READ ONLY): ${Object.entries(db).map(([k, v]) => `${k} ${v.length}`).join(" / ")}`);
  return db;
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

  // 利用者マスタ (基本情報・介護保険) — 居たら (b)
  const UB = readSjis(join(UM_DIR, readdirSync(UM_DIR).find((f) => f.startsWith("基本情報_") && /\.csv$/i.test(f))));
  const UK = readSjis(join(UM_DIR, readdirSync(UM_DIR).find((f) => f.startsWith("介護保険_") && /\.csv$/i.test(f))));
  for (const U of [UB, UK]) sourceFiles.push({ path: relPath(U.path), sha256: sha256(U.path), rows: U.rows.length, kind: "利用者管理 (居るかの確認だけ)" });
  const umNos = new Set([...UB.rows.map((r) => nfkc(r[UB.col("利用者番号")])), ...UK.rows.map((r) => nfkc(r[UK.col("利用者番号")]))]);
  const umFold = new Set(UB.rows.map((r) => fold(r[UB.col("利用者名")])));
  const umKeys = new Map(); // 利用者番号 → (保険者|被保番)
  for (const r of UK.rows) { const no = nfkc(r[UK.col("利用者番号")]); const k = `${nInsurer(r[UK.col("保険者番号")])}|${nInsured(r[UK.col("被保険者番号")])}`; if (k.startsWith("|") || k.endsWith("|")) continue; if (!umKeys.has(no)) umKeys.set(no, new Set()); umKeys.get(no).add(k); }

  // KDS0031 (4〜9 月の伝送の控え): 利用者番号 → 基本情報レコード
  const kdsBy = new Map();
  for (const d of readdirSync(FUKUYOGU).filter((x) => /^\d{6}$/.test(x)).sort()) {
    let fs = []; try { fs = readdirSync(join(FUKUYOGU, d, "ほのぼのから")).filter((f) => /^KDS0031.*\.csv$/i.test(f)); } catch { continue; }
    for (const f of fs) {
      const p = join(FUKUYOGU, d, "ほのぼのから", f);
      const { rows } = readKds0031(p);
      sourceFiles.push({ path: relPath(p), sha256: sha256(p), rows: rows.length, kind: "KDS0031 (利用者の属性・認定だけ使う)" });
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
  const CACHE = resolve(opt("--db-cache") ?? join(tmpdir(), "teikyo_missing_clients_db.json"));
  let db;
  if (!EXECUTE && existsSync(CACHE) && !argv.includes("--refresh")) { db = JSON.parse(readFileSync(CACHE, "utf8")); console.log(`DB: 控えを使う ${CACHE} (取得 ${db.fetchedAt})。最新は --refresh`); }
  else { db = await loadDb(sb); db.fetchedAt = new Date().toISOString(); if (!EXECUTE) writeFileSync(CACHE, JSON.stringify(db)); }
  const byKey = new Map(); const addK = (a, b, id) => { const k = `${nInsurer(a)}|${nInsured(b)}`; if (k.startsWith("|") || k.endsWith("|")) return; if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(id); };
  for (const c of db.clients) addK(c.insurer_number, c.insured_number, c.id);
  for (const r of db.ins) addK(r.insurer_number, r.insured_number, r.client_id);
  const byNo = groupBy(db.clients.filter((c) => c.user_number), (c) => nfkc(c.user_number));
  const byFold = groupBy(db.clients, (c) => fold(c.name));
  const byNameBirth = groupBy(db.clients.filter((c) => c.birth_date), (c) => `${fold(c.name)}|${c.birth_date}`);
  const clientById = new Map(db.clients.map((c) => [c.id, c]));
  const coByNo = groupBy(db.careOffices.filter((c) => c.office_number), (c) => nfkc(c.office_number));
  const desc = (c) => `${c.name}/${c.user_number}/${c.birth_date ?? "-"}${c.deleted_at ? "/削除済" : ""}`;

  // ── 対象 = 提供票の利用者で DB に何の手掛かりも無い人 (rebuild の「引けない」と同じ集合になるはず) ──
  const ops = [];
  const results = [];
  const cls = { a: [], b: [], c: [], d: [] };
  for (const [userNo, rs] of groupBy(trows, (r) => r.userNo)) {
    const tName = rs[rs.length - 1].name;
    // rebuild が引ける人 (利用者マスタの保険者+被保番 / 番号+氏名 / 氏名) は対象外
    const viaUm = [...(umKeys.get(userNo) ?? [])].some((k) => byKey.has(k));
    const viaNo = [...(byNo.get(userNo) ?? []), ...(byNo.get(`HN-${userNo}`) ?? [])].some((c) => !c.deleted_at && fold(c.name) === fold(tName));
    const viaName = (byFold.get(fold(tName)) ?? []).some((c) => !c.deleted_at);
    if (viaUm || viaNo || viaName) continue;

    const months = [...new Set(rs.map((r) => r.ym))].sort();
    const kinds = [...new Set(rs.map((r) => (r.office === "自費レンタル" ? "自費" : r.office.startsWith("予") ? "予防" : "介護")))].sort();
    const R = { 利用者番号: userNo, 氏名: tName, 行: rs.length, 月: `${months[0]}〜${months[months.length - 1]}`, 制度: kinds.join("+"), 用具: [...new Set(rs.map((r) => r.svc))], 分類: null, 状態: "計画", 判定: [], 注意: [] };
    results.push(R);
    const stop = (why) => { R.状態 = "★ 止めた"; R.判定.push(why); };

    // (d) 利用者ではない行
    if (NOT_A_PERSON.test(tName)) { R.分類 = "d"; cls.d.push(R); stop("利用者ではない行 (施設・役場 等) → 作らない"); continue; }
    // (b) 利用者マスタに居る
    if (umNos.has(userNo) || umFold.has(fold(tName))) { R.分類 = "b"; cls.b.push(R); stop("利用者マスタに居る → この script では作らない (sync_fukuyogu_from_honobono / fix7 の作法で 認定・負担割合証・公費ごと作る)"); continue; }

    // KDS
    const kr = kdsBy.get(userNo) ?? [];
    const kNames = [...new Set(kr.map((x) => fold(x.r[C.NAME])))];
    if (kNames.length && !kNames.includes(fold(tName))) { R.分類 = "c"; cls.c.push(R); stop(`KDS の同じ利用者番号に別の氏名 (${kNames.join(",")}) → 番号の使い回しの疑い`); continue; }
    const births = [...new Set(kr.map((x) => nDate(x.r[C.BIRTH])).filter(Boolean))];
    const genders = [...new Set(kr.map((x) => nGender(x.r[C.GENDER])).filter(Boolean))];
    const kanas = [...new Set(kr.map((x) => nKana(x.r[C.KANA])).filter(Boolean))];
    if (births.length > 1 || genders.length > 1) { R.分類 = "c"; cls.c.push(R); stop(`KDS の 生年月日/性別 が割れる (${births}/${genders})`); continue; }
    const birth = births[0] ?? null;

    // (a) の疑い: 既存 client に当たるか (削除済みも見る)
    const hits = [];
    for (const x of kr) for (const id of byKey.get(`${nInsurer(x.r[C.INSURER])}|${nInsured(x.r[C.INSURED])}`) ?? []) hits.push(`保険者+被保番 → ${desc(clientById.get(id))}`);
    for (const c of [...(byNo.get(userNo) ?? []), ...(byNo.get(`HN-${userNo}`) ?? [])]) hits.push(`利用者番号 → ${desc(c)}`);
    for (const c of byFold.get(fold(tName)) ?? []) hits.push(`氏名 → ${desc(c)}`);
    if (birth) for (const c of db.clients) {
      if (c.birth_date !== birth) continue;
      const fc = fold(c.name), ft = fold(tName);
      if (fc.slice(0, 2) === ft.slice(0, 2) || fc.slice(-2) === ft.slice(-2) || (c.furigana && kanas.includes(nKana(c.furigana)))) hits.push(`生年月日+(姓|名|カナ) → ${desc(c)}`);
    }
    if (birth) for (const c of byNameBirth.get(`${fold(tName)}|${birth}`) ?? []) hits.push(`氏名+生年月日 → ${desc(c)}`);
    if (hits.length) { R.分類 = "a"; cls.a.push(R); stop(`既存 client に当たる (同一人物の疑い・新規にしない): ${[...new Set(hits)].join(" / ")}`); continue; }
    R.分類 = "c"; cls.c.push(R);
    R.判定.push(kr.length ? `KDS0031 に居る (${[...new Set(kr.map((x) => nfkc(x.r[C.SVC_MONTH])))].sort().join(",")}) → 属性・認定は KDS の値` : "KDS0031 に居ない → 提供票の氏名・番号だけ");
    if (kinds.includes("介護") || kinds.includes("予防")) if (!kr.length) R.注意.push(`★ ${kinds.join("+")} の貸与があるが 保険の情報が無い (認定を作らない → 当方では請求の対象にならない)`);

    // ── clients ───────────────────────────────────────────────────────
    const userNumber = (byNo.get(userNo) ?? []).length ? `HN-${userNo}` : userNo;
    if ((byNo.get(userNumber) ?? []).length) { stop(`利用者番号 ${userNumber} も既にある`); continue; }
    const last = kr.length ? [...kr].sort((a, b) => nfkc(a.r[C.SVC_MONTH]).localeCompare(nfkc(b.r[C.SVC_MONTH])))[kr.length - 1].r : null;
    const coNo = last ? nfkc(last[C.CARE_OFFICE]) : "";
    const co = coNo ? coByNo.get(coNo)?.[0] ?? null : null;
    if (coNo && !co) R.注意.push(`居宅 ${coNo} が care_offices に無い (care_office_id は書かない)`);
    const name = cleanName(tName);
    if (name !== tName) R.注意.push(`氏名の同名識別を外す: 「${tName}」→「${name}」(rebuild は括弧を畳んで引くので一致する)`);
    const kana = last ? nfkc(last[C.KANA]) || null : null;
    const cid = newId("client");
    const src = last ? { file: [...new Set(kr.map((x) => x.file))].join(" + "), key: `ほのぼの利用者番号:${userNo}|${nInsurer(last[C.INSURER])}|${nInsured(last[C.INSURED])}|${birth}`, ref: { 提供票: { 氏名: tName, 月: R.月, 制度: R.制度 }, KDS: { 氏名: nfkc(last[C.NAME]), カナ: kana, 生年月日: last[C.BIRTH], 性別: last[C.GENDER], 要介護度: last[C.CARE_LEVEL], 認定: `${last[C.CERT_START]}〜${last[C.CERT_END]}`, 保険者: last[C.INSURER], 被保番: last[C.INSURED], 給付率: last[C.BENEFIT], 居宅: last[C.CARE_OFFICE] } } }
      : { file: [...new Set(rs.map((r) => relPath(join(TEIKYO_DIR, r.file))))].join(" + "), key: `ほのぼの利用者番号:${userNo}`, ref: { 提供票: { 氏名: tName, 月: R.月, 制度: R.制度 } } };
    const ex = { 利用者番号: userNo, 氏名: name };
    ops.push({ table: "clients", action: "insert", id: cid, cid, src, ref: ex, why: `新規 (提供票で引けない・利用者マスタに居ない。番号 ${userNumber}${userNumber !== userNo ? " = DB で番号が使用済みのため HN-" : ""})`, row: {
      tenant_id: TENANT, office_id: OFFICE, user_number: userNumber, name, furigana: kana, birth_date: birth, gender: ["男", "女"].includes(genders[0]) ? genders[0] : null,
      postal_code: null, address: null, phone: null, mobile: null,
      care_level: last ? nCare(last[C.CARE_LEVEL]) || null : null, certification_start_date: last ? nDate(last[C.CERT_START]) || null : null, certification_end_date: last ? nDate(last[C.CERT_END]) || null : null,
      insurer_number: last ? nInsurer(last[C.INSURER]) || null : null, insured_number: last ? nInsured(last[C.INSURED]) || null : null,
      benefit_rate: last ? nRate(last[C.BENEFIT]) || null : null, copay_rate: last ? clientCopayOf(last[C.BENEFIT]) : null, care_office_id: co?.id ?? null,
      is_facility: false, is_provisional: false, status: "active", deleted_at: null,
    } });
    ops.push({ table: "client_office_assignments", action: "insert", id: newId("coa"), cid, src, ref: ex, why: "新規利用者の自事業所割当 (ケアサポ)",
      row: { tenant_id: TENANT, client_id: cid, office_id: OFFICE, start_date: `${months[0]}-01`, end_date: null } });

    // ── 認定 (KDS の世代ごと) ─────────────────────────────────────────
    const gens = groupBy(kr, (x) => [nInsurer(x.r[C.INSURER]), nInsured(x.r[C.INSURED]), nDate(x.r[C.CERT_START]), nDate(x.r[C.CERT_END]), nCare(x.r[C.CARE_LEVEL]), nRate(x.r[C.BENEFIT]), nfkc(x.r[C.CARE_OFFICE])].join("|"));
    for (const [, xs] of [...gens].sort((a, b) => a[0].localeCompare(b[0]))) {
      const r = xs[0].r;
      const ms = [...new Set(xs.map((x) => nfkc(x.r[C.SVC_MONTH])))].sort();
      const gco = coByNo.get(nfkc(r[C.CARE_OFFICE]))?.[0] ?? null;
      const care = nCare(r[C.CARE_LEVEL]) || null;
      ops.push({ table: "client_insurance_records", action: "insert", id: newId("ins"), cid, why: "KDS0031 の認定 (伝送に出た世代)", ref: { ...ex, 認定: `${care}/${nDate(r[C.CERT_START])}〜${nDate(r[C.CERT_END])}`, KDS月: ms },
        src: { file: [...new Set(xs.map((x) => x.file))].join(" + "), key: `ほのぼの利用者番号:${userNo}|${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}|認定開始:${nDate(r[C.CERT_START])}`, ref: { 要介護度: r[C.CARE_LEVEL], 認定: `${r[C.CERT_START]}〜${r[C.CERT_END]}`, 給付率: r[C.BENEFIT], 居宅: r[C.CARE_OFFICE], 月: ms } },
        row: {
          tenant_id: TENANT, client_id: cid, effective_date: nDate(r[C.CERT_START]) || null, care_level: care, certification_start_date: nDate(r[C.CERT_START]) || null, certification_end_date: nDate(r[C.CERT_END]) || null,
          insurer_number: nInsurer(r[C.INSURER]) || null, insured_number: nInsured(r[C.INSURED]) || null, benefit_rate: nRate(r[C.BENEFIT]) || null, copay_rate: certCopayOf(r[C.BENEFIT]),
          certification_status: care ? "認定済み" : "申請中", care_office_id: gco?.id ?? null, care_office_number: nfkc(r[C.CARE_OFFICE]) || null, birth_date: birth,
          notes: `${MARK} 出典 KDS0031 (提供 ${ms.join(",")})。利用者マスタ (利用登録有) に居ない元利用者`,
        } });
      if (!care) R.注意.push(`KDS の要介護度が空 (${r[C.CERT_START]}〜)`);
    }
    if (gens.size > 1) R.注意.push(`KDS に認定の世代が ${gens.size} つ (全部入れる)`);

    // ── 公費 (KDS の公費 1〜3) ───────────────────────────────────────
    const kohi = new Map();
    for (const { r } of kr) for (const [f, j] of [[C.FUTAN1, C.JUKYU1], [C.FUTAN2, C.JUKYU2], [C.FUTAN3, C.JUKYU3]]) {
      const fut = nfkc(r[f]); if (!fut) continue;
      const k = `${fut}|${nfkc(r[j])}`;
      if (!kohi.has(k)) kohi.set(k, { fut, jyu: nfkc(r[j]) || null, months: new Set() });
      kohi.get(k).months.add(nfkc(r[C.SVC_MONTH]).replace("/", "-").slice(0, 7));
    }
    for (const k of kohi.values()) {
      if (!/^\d{8}$/.test(k.fut)) { R.注意.push(`公費: 負担者番号が 8 桁でない (入れない) ${k.fut}`); continue; }
      const ms = [...k.months].sort();
      ops.push({ table: "client_public_expenses", action: "insert", id: newId("kohi"), cid, why: "KDS0031 の公費", ref: { ...ex, 負担者: k.fut, 月: ms }, src: { file: src.file, key: `ほのぼの利用者番号:${userNo}|${k.fut}|${k.jyu}`, ref: { 負担者: k.fut, 受給者: k.jyu, 月: ms } },
        row: { tenant_id: TENANT, client_id: cid, hohei_code: k.fut.slice(0, 2), futan_sha_number: k.fut, jukyu_sha_number: k.jyu, valid_start: `${ms[0]}-01`, valid_end: monthEnd(ms[ms.length - 1]),
          confirmed_date: null, application_type: null, special_type: null, outpatient_copay: null, inpatient_copay: null } });
    }
    R.判定.push(`作る: clients 1 / 割当 1 / 認定 ${gens.size} / 公費 ${[...kohi.values()].filter((k) => /^\d{8}$/.test(k.fut)).length}`);
  }

  // ── 出力 ───────────────────────────────────────────────────────────
  console.log(`\n== 対象 (提供票で DB に手掛かりが無い利用者) ${results.length} 名`);
  console.log(`   (a) DB に居た疑い ${cls.a.length} / (b) 利用者マスタに居る ${cls.b.length} / (c) 利用者マスタにも居ない ${cls.c.length} (KDS あり ${cls.c.filter((r) => r.判定.some((s) => s.startsWith("KDS0031 に居る"))).length}) / (d) 利用者ではない ${cls.d.length}`);
  for (const R of results) {
    console.log(`\n(${R.分類}) ${R.利用者番号} ${R.氏名} — ${R.状態} / ${R.制度} ${R.月} 実績 ${R.行} 行`);
    for (const s of R.判定) console.log(`     判定: ${s}`);
    for (const s of R.注意) console.log(`     注意: ${s}`);
  }
  const keySets = {};
  for (const o of ops) (keySets[o.table] ??= new Set()).add(Object.keys(o.row).sort().join(","));
  console.log(`\n══ 合計 ══ 書込み ${ops.length} 件 ${JSON.stringify(countBy(ops, (o) => `${o.table} ${o.action}`))}`);
  console.log(`insert のキー集合 (表ごとの種類数。1 であること): ${JSON.stringify(Object.fromEntries(Object.entries(keySets).map(([t, v]) => [t, v.size])))}`);
  console.log(`作る利用者: ${results.filter((r) => r.状態 === "計画").length} 名 / 止めた: ${results.filter((r) => r.状態 !== "計画").map((r) => `${r.利用者番号} ${r.氏名}`).join(", ") || "なし"}`);
  console.log("trigger: client_insurance_records の追加で care_plan_elements 等が作られる → 実行時に「書込み → 掃除」(参照先がこの batch の行のものだけ消して記録)");

  let sim = null;
  if (SIMULATE) sim = simulateRebuild(ops, results);

  const outPath = resolve(opt("--out") ?? join(tmpdir(), "teikyo_missing_clients.json"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ sourceFiles, results, ops, sim }, null, 1));
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
    notes: "提供票で clients に引けない利用者を作る (利用者マスタに居ない元利用者・自費の人)",
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
    for (const table of ["clients", "client_office_assignments", "client_insurance_records", "client_public_expenses"]) {
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
