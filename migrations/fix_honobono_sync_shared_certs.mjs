/**
 * ほのぼの福祉用具の反映 (sync_fukuyogu_from_honobono.mjs / 2026-11-09) で入れた認定行 の後始末
 *
 *   node migrations/fix_honobono_sync_shared_certs.mjs                         # DRY RUN (既定)
 *   node migrations/fix_honobono_sync_shared_certs.mjs --execute               # 本番 (★ user 確認後)
 *   node migrations/fix_honobono_sync_shared_certs.mjs --step=copay|dedupe|clients|all # 既定 all (dedupe → copay → clients の順)
 *   node migrations/fix_honobono_sync_shared_certs.mjs --revert <batch_id> [--execute]
 *   node migrations/fix_honobono_sync_shared_certs.mjs --out <json>            # 計画 (削除候補 id 等) の出力先。既定 = OS の一時フォルダ
 *
 * ── 直すもの ─────────────────────────────────────────────────────────────
 *   copay   マーカー [honobono-sync-202609] 付きで insert した client_insurance_records の copay_rate が全部 null。
 *           kaigo-app (cert-for-month.ts / visit-seikyu/aggregate.ts) は認定の copay_rate を読み、null は既定 1 割に倒す。
 *           ★ 規約: client_insurance_records.copay_rate は「割」表記 "1"/"2"/"3" (既存 21,435 行の実測で "10"/"20"/"30" は 0 行)。
 *             clients.copay_rate は percent 表記 "10"/"20"/"30" で 単位が違う (同じ列名)。認定に "10" を入れると 10 割負担に潰れる。
 *           benefit_rate 90→"1" / 80→"2" / 70→"3"。それ以外 (0・100・空 等) は ★ 自動で埋めず一覧だけ。
 *           order-app は請求で認定の copay_rate を読まない (BillingTab は clients.benefit_rate → computeFukuyoguAmounts)。
 *           読むのは ClientsTab の保険情報一覧 (表示・同着時の優先) だけ。
 *   dedupe  kaigo-app と共有の利用者に insert した行のうち、既存行 (kaigo 側) と同じ認定と判断できるものを消す (既存行を正とする)。
 *             削除候補 = 既存行に 同じ (保険者・被保番・要介護度) で期間が重なる行があり、かつ insert 行の期間が既存行で覆われている
 *                        (覆われない日が 2026-06-01 より前だけ = 古い世代の端のずれ も含む)
 *             判断が要る = 同じ開始日だが 保険者/被保番/要介護度 が違う / 重なる既存行が全部 要介護度か被保番が違う /
 *                         覆われない日が 2026-06 以降に掛かる / ★ 消すと order-app の 2026-09 の当月認定が変わり ほのぼの KK261004 と
 *                         合わなくなる (福祉用具と訪問介護/居宅で ほのぼの自身の認定開始日が違う型)
 *             残す     = 既存行と期間が重ならない (kaigo に無い世代)
 *   clients clients 段が clients.benefit_rate だけを書き換え / 新規作成し、clients.copay_rate を書いていなかった。
 *           ケアサポ専用の利用者 (共有でない) で、sync が benefit_rate を書いた (update / insert) 行の copay_rate を
 *           100 − benefit_rate の percent 表記 "10"/"20"/"30" に揃える。給付率 0 (公費単独)・null は一覧だけ。共有の人は触らない。
 *           order-app で clients.copay_rate を読むのは DocumentsTab の初期値・ClientsTab 表示・RenovationTab の初期値 (先頭の数字だけ見る)。
 *           請求 (BillingTab) は benefit_rate → computeFukuyoguAmounts なので金額は変わらない。
 *   (dedupe の) 証拠として kaigo-app/伝送データ 配下の ほのぼの実伝送 (7131/7132 様式の 01 / 8124) の認定期間を並べる。
 *
 * ── 書込みの作法 (--execute) ─────────────────────────────────────────────
 *   sync script と同じ: data_import_batches を 1 件作り、各 update/delete の直後に data_import_rows (before/after) を書く。
 *   消す直前に行を読み直し、insert 時 (data_import_rows.after) から 主要列が変わっていたら消さない。
 *   copay は「いま copay_rate が空 かつ benefit_rate が計画時と同じ」行だけ更新 (条件付き update)。
 *   client_insurance_records の trigger は AFTER INSERT のみ (care_plan_elements / doc_tasks)。update / delete では動かない。
 *   取り消し (--revert) の入れ直しは INSERT なので trigger が動く → sync script と同じ方法で その行を参照する派生行だけ掃除する。
 */
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
// lib の .ts を読むため tsx の下で自分自身を起動し直す (sync script と同じ)
if (!process.env.FIX_SHARED_CERTS_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, FIX_SHARED_CERTS_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const { pickCertForMonth, certFieldsForDensou } = await import("../lib/kokuho-densou/cert-for-month.ts");
const { TENANT, readEnv, nCare, nfkc } = await import("../scripts/_honobono-sync-core.mts");

const argv = process.argv.slice(2);
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const STEP = opt("--step") ?? "all";
if (!["copay", "dedupe", "clients", "all"].includes(STEP)) { console.error("--step は copay|dedupe|clients|all"); process.exit(1); }
const DO = (s) => STEP === "all" || STEP === s;
const OUT = resolve(opt("--out") ?? join(tmpdir(), "fix_honobono_sync_shared_certs_plan.json"));
const MARK = "[honobono-sync-202609]";
const SOURCE_SYSTEM_SYNC = "honobono-fukuyogu";
const SOURCE_SYSTEM = "honobono-fukuyogu-fix-shared-certs";
const SCRIPT_REL = "apps/order-app/migrations/fix_honobono_sync_shared_certs.mjs";
const CARE_SUPO = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";
const KAIGO_FROM = "2026-06-01"; // kaigo の検証範囲 (2026-06〜11) の先頭。これより前だけの端のずれは 削除候補 に入れる
const OA_MONTH = ["2026-09-01", "2026-09-30"]; // order-app 福祉用具 の検証月 (KK261004)
const DENSOU = resolve(HERE, "../../kaigo-app/伝送データ");
const KK261004 = join(DENSOU, "ケアサポ/福祉用具/202609/ほのぼのから/KK261004.CSV");
const KEY_COLS = ["client_id", "care_level", "certification_start_date", "certification_end_date", "insurer_number", "insured_number", "benefit_rate", "effective_date"];
const RATE_TO_COPAY = { "90": "1", "80": "2", "70": "3" }; // 認定 = 割表記
const RATE_TO_CLIENT_COPAY = { "90": "10", "80": "20", "70": "30" }; // clients = percent 表記

// ── 小道具 ────────────────────────────────────────────────────────────────
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const addDays = (ymd, n) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const ins8 = (s) => { const t = nfkc(s ?? "").replace(/\D/g, ""); return t ? t.slice(-6) : ""; }; // 保険者番号は 6 桁で比べる (伝送は 00 付き 8 桁)
const insd = (s) => nfkc(s ?? "").replace(/[\s"=]/g, "");
const certKey = (r) => `${ins8(r.insurer_number)}|${insd(r.insured_number)}|${nCare(r.care_level)}`;
const S = (r) => r.certification_start_date ?? "0000-01-01";
const E = (r) => r.certification_end_date ?? "9999-12-31";
const overlaps = (a, b) => S(a) <= E(b) && S(b) <= E(a);
const ymd8 = (s) => (s && /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s || null);
const CARE_CODE = { "01": "非該当", "06": "事業対象者", "11": "経過的要介護", "12": "要支援1", "13": "要支援2", "21": "要介護1", "22": "要介護2", "23": "要介護3", "24": "要介護4", "25": "要介護5" };
const fmt = (r) => r ? `${r.care_level ?? "-"}|${r.insurer_number ?? "-"}|${r.insured_number ?? "-"}|${r.certification_start_date ?? "?"}〜${r.certification_end_date ?? "?"}|eff ${r.effective_date ?? "-"}|cp ${r.copay_rate ?? "null"}|br ${r.benefit_rate ?? "null"}` : "(なし)";
/** a の期間のうち rs の和集合で覆われない区間 */
function uncovered(a, rs) {
  const iv = rs.map((r) => [S(r), E(r)]).sort((x, y) => x[0].localeCompare(y[0]));
  const gaps = []; let cur = S(a); const end = E(a);
  for (const [s, e] of iv) {
    if (e < cur) continue;
    if (s > end) break;
    if (s > cur) gaps.push([cur, addDays(s, -1)]);
    if (e >= cur) cur = e >= "9999-12-31" ? "9999-12-31" : addDays(e, 1);
    if (cur > end) break;
  }
  if (cur <= end) gaps.push([cur, end]);
  return gaps;
}

function makeSb() {
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  return import("@supabase/supabase-js").then(({ createClient }) => createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }));
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
async function provenanceReady(sb) {
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) return { ok: false, why: `${t}: ${error.message}` };
  }
  return { ok: true };
}

// ── ほのぼの実伝送の認定期間 (kaigo-app/伝送データ 配下の ほのぼのから/ の KK・KY) ──────────────
function readDensouCerts() {
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/^K[KY].*\.CSV$/i.test(e.name) && /[\\/]ほのぼのから[^\\/]*[\\/]/.test(f)) files.push(f);
    }
  })(DENSOU);
  const by = new Map(); // insured → [{kind, file, ym, insurer, care, start, end}]
  for (const f of files) {
    const kind = /[\\/]福祉用具[\\/]/.test(f) ? "福祉用具" : /[\\/]居宅[\\/]/.test(f) ? "居宅" : /[\\/]訪問入浴[\\/]/.test(f) ? "訪問入浴" : "訪問介護";
    const rel = f.slice(DENSOU.length + 1).replace(/\\/g, "/");
    for (const l of new TextDecoder("shift-jis").decode(readFileSync(f)).split(/\r?\n/)) {
      const c = l.split(",").map((x) => x.replace(/^"|"$/g, ""));
      if (c[0] !== "2") continue;
      let rec = null;
      if ((c[2] === "7131" || c[2] === "7132") && c[3] === "01") rec = { ym: c[4], insurer: ins8(c[6]), insured: insd(c[7]), care: CARE_CODE[c[16]] ?? c[16], start: ymd8(c[18]), end: ymd8(c[19]) };
      else if (c[2] === "8124" && /^\d{8}$/.test(c[14] ?? "")) rec = { ym: c[5], insurer: ins8(c[6]), insured: insd(c[8]), care: CARE_CODE[c[13]] ?? c[13], start: ymd8(c[14]), end: ymd8(c[15]) };
      if (!rec || !rec.insured) continue;
      if (!by.has(rec.insured)) by.set(rec.insured, []);
      by.get(rec.insured).push({ kind, file: rel, ...rec });
    }
  }
  return { by, files: files.length };
}
const densouSummary = (dc, r) => {
  const hits = (dc.by.get(insd(r.insured_number)) ?? []).filter((h) => !ins8(r.insurer_number) || h.insurer === ins8(r.insurer_number));
  const m = new Map();
  for (const h of hits) { const k = `${h.kind}:${h.care}|${h.start}〜${h.end}`; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(h.ym); }
  return [...m].map(([k, ys]) => `${k} (${[...ys].sort().join(",")})`);
};
/** KK261004 (提供 2026-09・ケアサポ) の 01 レコード: insured → {care, start, end} */
function readKk261004() {
  const out = new Map();
  for (const l of new TextDecoder("shift-jis").decode(readFileSync(KK261004)).split(/\r?\n/)) {
    const c = l.split(",").map((x) => x.replace(/^"|"$/g, ""));
    if (c[0] === "2" && (c[2] === "7131" || c[2] === "7132") && c[3] === "01") out.set(`${ins8(c[6])}|${insd(c[7])}`, { care: CARE_CODE[c[16]] ?? c[16], start: ymd8(c[18]), end: ymd8(c[19]) });
  }
  return out;
}

// ── 計画 ──────────────────────────────────────────────────────────────────
async function plan(sb) {
  const batches = await selectAll(sb, "data_import_batches", "id,source_system,status,step,created_at", (q) => q.eq("source_system", SOURCE_SYSTEM_SYNC));
  // 途中で落ちた batch (failed) も書込みは残っている。取り消し済み / dry_run だけ除く
  const live = batches.filter((b) => !["reverted", "dry_run"].includes(b.status));
  console.log(`sync の batch ${batches.length} 件 (対象 ${live.length}: ${live.map((b) => `${b.id.slice(0, 8)}/${b.status}`).join(", ")})`);
  const logs = await selectIn(sb, "data_import_rows", "id,batch_id,table_name,op,row_id,after", "batch_id", live.map((b) => b.id), (q) => q.eq("table_name", "client_insurance_records").eq("op", "insert"));
  const logById = new Map(logs.map((r) => [r.row_id, r]));
  const marked = await selectAll(sb, "client_insurance_records", "*", (q) => q.eq("tenant_id", TENANT).like("notes", `%${MARK}%`));
  const unlogged = marked.filter((r) => !logById.has(r.id));
  const gone = logs.filter((l) => !marked.some((r) => r.id === l.row_id));
  console.log(`マーカー付き認定行 ${marked.length} 行 / insert の記録 ${logs.length} 行 (記録に無いマーカー行 ${unlogged.length} / 記録はあるが既に無い ${gone.length})`);
  const targets = marked.filter((r) => logById.has(r.id)); // 記録のある行だけ触る

  // clients 段の書込み (benefit_rate を書いた update / insert)
  const clientLogs = (await selectIn(sb, "data_import_rows", "id,batch_id,table_name,op,row_id,after,created_at", "batch_id", live.map((b) => b.id), (q) => q.eq("table_name", "clients").in("op", ["update", "insert"])))
    .filter((r) => r.after && "benefit_rate" in r.after)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
  // 共有 = ケアサポ以外の事業所割当がある / clients.office_id が他事業所 / sync で observe (共有のため控えのみ) された人
  const insCids = new Set(targets.map((r) => r.client_id));
  const cids = [...new Set([...insCids, ...clientLogs.map((r) => r.row_id)])];
  const coa = await selectIn(sb, "client_office_assignments", "id,client_id,office_id", "client_id", cids);
  const cl = await selectIn(sb, "clients", "id,name,user_number,office_id,care_level,certification_start_date,certification_end_date,deleted_at,benefit_rate,copay_rate", "id", cids);
  const obs = await selectIn(sb, "data_import_rows", "id,row_id", "batch_id", live.map((b) => b.id), (q) => q.eq("table_name", "clients").eq("op", "observe"));
  const offices = await selectAll(sb, "offices", "id,name,short_name");
  const on = new Map(offices.map((o) => [o.id, o.short_name || o.name]));
  const clientById = new Map(cl.map((c) => [c.id, c]));
  const obsSet = new Set(obs.map((o) => o.row_id));
  const sharedWhy = new Map();
  for (const c of cl) {
    const why = [...new Set(coa.filter((a) => a.client_id === c.id && a.office_id !== CARE_SUPO).map((a) => on.get(a.office_id) ?? a.office_id))];
    if (c.office_id && c.office_id !== CARE_SUPO) why.push(`office_id:${on.get(c.office_id) ?? c.office_id}`);
    if (!why.length && obsSet.has(c.id)) why.push("(sync で共有として控えた)");
    if (why.length) sharedWhy.set(c.id, why);
  }
  const sharedIds = [...sharedWhy.keys()].filter((id) => insCids.has(id));
  const allRows = await selectIn(sb, "client_insurance_records", "*", "client_id", sharedIds, (q) => q.eq("tenant_id", TENANT));
  const rowsByClient = groupBy(allRows, (r) => r.client_id);
  const targetIds = new Set(targets.map((r) => r.id));
  const dc = readDensouCerts();
  const kk = readKk261004();
  console.log(`共有の利用者 ${sharedIds.length} 名 (マーカー行のある ${insCids.size} 名のうち) / ほのぼの実伝送 ${dc.files} ファイル`);

  // ── dedupe の分類 ──
  const D = { 削除候補: [], 判断が要る: [], 残す: [] };
  for (const cid of sharedIds) {
    const rs = rowsByClient.get(cid) ?? [];
    const olds = rs.filter((r) => !targetIds.has(r.id) && !(r.notes ?? "").includes(MARK));
    for (const R of rs.filter((r) => targetIds.has(r.id))) {
      const c = clientById.get(cid);
      const base = { id: R.id, client_id: cid, 氏名: c?.name ?? null, 利用者番号: c?.user_number ?? null, 共有: sharedWhy.get(cid), 追加行: fmt(R) };
      const same = olds.filter((x) => x.certification_start_date === R.certification_start_date);
      const ovl = olds.filter((x) => overlaps(x, R));
      const sameKeyOvl = ovl.filter((x) => certKey(x) === certKey(R));
      const gaps = uncovered(R, olds);
      const ev = { 重なる既存行: ovl.map(fmt), 覆われない日: gaps.map(([a, b]) => `${a}〜${b}`), ほのぼの伝送: densouSummary(dc, R) };
      let cat, why;
      if (!ovl.length) { cat = "残す"; why = "既存行と期間が重ならない (kaigo に無い世代)"; }
      else if (same.length && !same.some((x) => certKey(x) === certKey(R))) { cat = "判断が要る"; why = "同じ開始日だが 保険者/被保番/要介護度 が違う"; }
      else if (!sameKeyOvl.length) { cat = "判断が要る"; why = ovl.some((x) => ins8(x.insurer_number) === ins8(R.insurer_number) && insd(x.insured_number) === insd(R.insured_number)) ? "重なる既存行は 要介護度が違う (区分変更か kaigo 側が古いか)" : "重なる既存行は 保険者/被保番が違う"; }
      else if (gaps.some(([, b]) => b >= KAIGO_FROM)) { cat = "判断が要る"; why = `同じ認定と重なるが 覆われない日が ${KAIGO_FROM} 以降に掛かる`; }
      else { cat = "削除候補"; why = same.length ? "同じ開始日・同じ認定の重複" : gaps.length ? "同じ認定と重なる (覆われない日は古い端のずれのみ)" : "同じ認定の期間に包含される"; }
      D[cat].push({ ...base, 理由: why, ...ev });
    }
  }

  // ── order-app 2026-09 の当月認定への影響 (BillingTab と同じ: tenant 内・id 順 → pickCertForMonth → certFieldsForDensou) ──
  const oaCheck = (cid, del) => {
    const rs = (rowsByClient.get(cid) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const c = clientById.get(cid);
    const f = (recs) => { const p = pickCertForMonth(recs, OA_MONTH[0], OA_MONTH[1]); return { pick: p?.id ?? null, ...certFieldsForDensou(c, p) }; };
    const b = f(rs), a = f(rs.filter((r) => !del.has(r.id)));
    const p = rs.find((r) => r.id === b.pick) ?? rs[0];
    const truth = p ? kk.get(`${ins8(p.insurer_number)}|${insd(p.insured_number)}`) ?? null : null;
    const score = (x) => truth ? (nCare(x.careLevel) === nCare(truth.care) ? 1 : 0) + (x.certStart === truth.start ? 1 : 0) + (x.certEnd === truth.end ? 1 : 0) : null;
    return { before: b, after: a, truth, sb: score(b), sa: score(a), changed: b.careLevel !== a.careLevel || b.certStart !== a.certStart || b.certEnd !== a.certEnd };
  };
  const oa = [];
  for (let pass = 0; pass < 5; pass++) {
    const del = new Set(D.削除候補.map((x) => x.id));
    let moved = 0;
    for (const cid of new Set(D.削除候補.map((x) => x.client_id))) {
      const r = oaCheck(cid, del);
      if (!r.changed) continue;
      if (r.sa != null && r.sb != null && r.sa < r.sb) {
        // 悪くなる → 当月 (2026-09) に掛かる この人の削除候補を 判断が要る へ
        for (const x of D.削除候補.filter((y) => y.client_id === cid)) {
          const R = allRows.find((z) => z.id === x.id);
          if (!overlaps(R, { certification_start_date: OA_MONTH[0], certification_end_date: OA_MONTH[1] }) && x.id !== r.before.pick) continue;
          D.削除候補 = D.削除候補.filter((y) => y.id !== x.id);
          D.判断が要る.push({ ...x, 理由: `${x.理由} → ★ ただし消すと order-app 2026-09 の認定が ${r.before.certStart}〜${r.before.certEnd}/${r.before.careLevel} → ${r.after.certStart}〜${r.after.certEnd}/${r.after.careLevel} になり KK261004 (${r.truth.start}〜${r.truth.end}/${r.truth.care}) と合わなくなる`, 福祉用具と訪問介護で認定開始日が違う型: true });
          moved++;
        }
      }
    }
    if (!moved) break;
  }
  const delSet = new Set(D.削除候補.map((x) => x.id));
  for (const cid of new Set([...D.削除候補, ...D.判断が要る].map((x) => x.client_id))) {
    const r = oaCheck(cid, delSet);
    if (r.changed) oa.push({ 氏名: clientById.get(cid)?.name, client_id: cid, 前: `${r.before.careLevel}/${r.before.certStart}〜${r.before.certEnd}`, 後: `${r.after.careLevel}/${r.after.certStart}〜${r.after.certEnd}`, KK261004: r.truth ? `${r.truth.care}/${r.truth.start}〜${r.truth.end}` : "(請求なし)", 一致項目数: `${r.sb ?? "-"} → ${r.sa ?? "-"}` });
  }

  // ── copay ──
  const copay = { 埋める: [], 埋めない: [], 既に値あり: [] };
  for (const R of targets) {
    const c = clientById.get(R.client_id);
    const x = { id: R.id, client_id: R.client_id, 氏名: c?.name ?? null, 共有: sharedWhy.has(R.client_id), 削除候補: delSet.has(R.id), benefit_rate: R.benefit_rate, 認定: fmt(R) };
    if (R.copay_rate != null && R.copay_rate !== "") copay.既に値あり.push(x);
    else if (RATE_TO_COPAY[nfkc(R.benefit_rate ?? "")]) copay.埋める.push({ ...x, copay_rate: RATE_TO_COPAY[nfkc(R.benefit_rate)] });
    else copay.埋めない.push({ ...x, 理由: `benefit_rate=${JSON.stringify(R.benefit_rate)} は自動で決めない` });
  }
  // ── clients.copay_rate ──
  const cc = { 更新: [], 一致済み: [], 給付率0か空: [], 共有で触らない: [], 後から変わった: [] };
  for (const [cid, ls] of groupBy(clientLogs, (r) => r.row_id)) {
    const c = clientById.get(cid);
    const last = ls[ls.length - 1]; // 同じ人を複数 batch で書いた場合は最後の値
    const x = { client_id: cid, 氏名: c?.name ?? null, 利用者番号: c?.user_number ?? null, 種別: ls.some((r) => r.op === "insert") ? "新規 insert" : "benefit_rate 書換え", benefit_rate: c?.benefit_rate ?? null, copay_rate: c?.copay_rate ?? null };
    if (!c) { cc.後から変わった.push({ ...x, 理由: "clients に無い" }); continue; }
    if (sharedWhy.has(cid)) { cc.共有で触らない.push({ ...x, 共有: sharedWhy.get(cid) }); continue; }
    if (nfkc(c.benefit_rate ?? "") !== nfkc(last.after.benefit_rate ?? "")) { cc.後から変わった.push({ ...x, 理由: `sync 後に benefit_rate が ${last.after.benefit_rate} → ${c.benefit_rate}` }); continue; }
    const want = RATE_TO_CLIENT_COPAY[nfkc(c.benefit_rate ?? "")];
    if (!want) { cc.給付率0か空.push(x); continue; }
    if (nfkc(c.copay_rate ?? "") === want) cc.一致済み.push(x); else cc.更新.push({ ...x, 新copay_rate: want });
  }
  return { targets, logById, D, oa, copay, cc, sharedIds, sharedWhy, unlogged, gone, clientById };
}

function printPlan(p) {
  const { D, oa, copay, targets, sharedIds } = p;
  const sharedTargets = targets.filter((r) => p.sharedWhy.has(r.client_id));
  console.log(`\n══ (2) dedupe — 母数: 共有の利用者に insert した認定行 ${sharedTargets.length} 行 / ${new Set(sharedTargets.map((r) => r.client_id)).size} 名 (共有の利用者 ${sharedIds.length} 名) ══`);
  for (const k of ["削除候補", "判断が要る", "残す"]) {
    const xs = D[k];
    console.log(`\n■ ${k} ${xs.length} 行 / ${new Set(xs.map((x) => x.client_id)).size} 名`);
    for (const [why, n] of Object.entries(countBy(xs, (x) => x.理由.split(" → ")[0]))) console.log(`   ${String(n).padStart(4)}  ${why}${xs.some((x) => x.理由.startsWith(why) && x.福祉用具と訪問介護で認定開始日が違う型) ? "  (うち order-app を悪くするため移したもの含む)" : ""}`);
    const show = k === "残す" ? xs.slice(0, 5) : xs;
    for (const x of show) {
      console.log(`   - ${x.氏名}/${x.利用者番号} [${x.共有.join(",")}] ${x.理由}`);
      console.log(`       追加: ${x.追加行}`);
      for (const e of x.重なる既存行) console.log(`       既存: ${e}`);
      if (x.覆われない日.length && k !== "残す") console.log(`       覆われない日: ${x.覆われない日.join(", ")}`);
      if (x.ほのぼの伝送.length) console.log(`       ほのぼの伝送: ${x.ほのぼの伝送.join(" / ")}`);
    }
    if (show.length < xs.length) console.log(`   … ほか ${xs.length - show.length} 行 (計画 JSON に全件)`);
  }
  console.log(`\n■ order-app 2026-09 の当月認定 (pickCertForMonth) が 削除候補を消すと変わる人 ${oa.length} 名`);
  for (const x of oa) console.log(`   - ${x.氏名}: ${x.前} → ${x.後} / KK261004 ${x.KK261004} / 一致項目数 ${x.一致項目数}`);

  console.log(`\n══ (1) copay — 母数: マーカー付き insert 行 ${targets.length} 行 (共有 ${sharedTargets.length} / 非共有 ${targets.length - sharedTargets.length}) ══`);
  const fill = copay.埋める.filter((x) => STEP === "copay" || !x.削除候補);
  console.log(`   埋める ${fill.length} 行 ${JSON.stringify(countBy(fill, (x) => `${x.benefit_rate}→${x.copay_rate}${x.共有 ? " 共有" : ""}`))}${STEP === "all" ? ` (削除候補 ${copay.埋める.length - fill.length} 行は消すので埋めない)` : ""}`);
  console.log(`   埋めない ${copay.埋めない.length} 行 ${JSON.stringify(countBy(copay.埋めない, (x) => `br=${x.benefit_rate}${x.共有 ? " 共有" : ""}`))}`);
  for (const x of copay.埋めない) console.log(`     - ${x.氏名} ${x.共有 ? "[共有]" : ""}${x.削除候補 ? "[削除候補]" : ""} ${x.認定}`);
  console.log(`   既に値あり ${copay.既に値あり.length} 行`);
  const cc = p.cc, tot = Object.values(cc).reduce((a, b) => a + b.length, 0);
  console.log(`\n══ (3) clients.copay_rate — 母数: sync の clients 段が benefit_rate を書いた利用者 ${tot} 名 ${JSON.stringify(countBy(Object.values(cc).flat(), (x) => x.種別))} ══`);
  for (const [k, xs] of Object.entries(cc)) {
    console.log(`   ${k} ${xs.length} 名 ${JSON.stringify(countBy(xs, (x) => `${x.種別}:${x.benefit_rate}/${x.copay_rate}${x.新copay_rate ? "→" + x.新copay_rate : ""}`))}`);
    if (k === "一致済み") continue;
    for (const x of (k === "更新" ? xs.filter((y) => y.種別 !== "新規 insert") : xs)) console.log(`     - ${x.氏名}/${x.利用者番号} ${x.種別} 給付率 ${x.benefit_rate} 負担 ${x.copay_rate}${x.新copay_rate ? ` → ${x.新copay_rate}` : ""}${x.理由 ? ` (${x.理由})` : ""}${x.共有 ? ` [${x.共有.join(",")}]` : ""}`);
    if (k === "更新") console.log(`     (新規 insert ${xs.filter((y) => y.種別 === "新規 insert").length} 名は 計画 JSON に全件)`);
  }
  return fill;
}

// ── 本番 ──────────────────────────────────────────────────────────────────
async function execute(sb, p, fill) {
  const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: STEP, status: "running",
    notes: `honobono-sync-202609 の後始末 (copay 補完 / 共有の重複認定の削除)`,
  }).select("id").single();
  if (bErr) throw new Error(`data_import_batches: ${bErr.message}`);
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  const record = async (recs) => {
    for (const c of chunks(recs, 100)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); }
  };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  let nd = 0, nu = 0, skip = [];
  if (DO("dedupe")) {
    const ids = p.D.削除候補.map((x) => x.id);
    const cur = new Map((await selectIn(sb, "client_insurance_records", "*", "id", ids)).map((r) => [r.id, r]));
    writeFileSync(join(HERE, `_backup_fix_shared_certs_dedupe_${ts}.json`), JSON.stringify({ batch: BATCH, before: Object.fromEntries(cur) }, null, 2));
    for (const x of p.D.削除候補) {
      const now = cur.get(x.id); const after = p.logById.get(x.id)?.after ?? {};
      if (!now) { skip.push({ id: x.id, why: "既に無い" }); continue; }
      const changed = KEY_COLS.filter((k) => k in after && String(now[k] ?? "") !== String(after[k] ?? ""));
      if (changed.length || !(now.notes ?? "").includes(MARK)) { skip.push({ id: x.id, why: `insert 後に変わった列 ${changed.join(",") || "notes"}` }); continue; }
      const { error, count } = await sb.from("client_insurance_records").delete({ count: "exact" }).eq("id", x.id);
      if (error || count !== 1) await fail(`delete ${x.id}: ${error?.message ?? `件数 ${count}`}`);
      await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: x.id, op: "delete", source_key: `dedupe:${x.client_id}`, source_ref: { 理由: x.理由, 重なる既存行: x.重なる既存行, ほのぼの伝送: x.ほのぼの伝送 }, before: now, after: null }]);
      nd++;
    }
  }
  if (DO("copay")) {
    for (const x of fill) {
      const { data, error } = await sb.from("client_insurance_records").update({ copay_rate: x.copay_rate }).eq("id", x.id).is("copay_rate", null).eq("benefit_rate", x.benefit_rate).select("id");
      if (error) await fail(`update ${x.id}: ${error.message}`);
      if (!data.length) { skip.push({ id: x.id, why: "copay_rate が既に入った か benefit_rate が変わった" }); continue; }
      await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: "client_insurance_records", row_id: x.id, op: "update", source_key: `copay:${x.client_id}`, source_ref: { 規約: "認定の copay_rate は割表記 1/2/3", benefit_rate: x.benefit_rate }, before: { copay_rate: null }, after: { copay_rate: x.copay_rate } }]);
      nu++;
    }
  }
  if (DO("clients")) {
    for (const x of p.cc.更新) {
      let q = sb.from("clients").update({ copay_rate: x.新copay_rate }).eq("id", x.client_id).eq("benefit_rate", x.benefit_rate);
      q = x.copay_rate == null ? q.is("copay_rate", null) : q.eq("copay_rate", x.copay_rate);
      const { data, error } = await q.select("id");
      if (error) await fail(`update clients ${x.client_id}: ${error.message}`);
      if (!data.length) { skip.push({ id: x.client_id, why: "clients の benefit_rate/copay_rate が計画後に変わった" }); continue; }
      await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: "clients", row_id: x.client_id, op: "update", source_key: `clients-copay:${x.client_id}`, source_ref: { 規約: "clients の copay_rate は percent 表記 10/20/30 = 100−benefit_rate", benefit_rate: x.benefit_rate }, before: { copay_rate: x.copay_rate }, after: { copay_rate: x.新copay_rate } }]);
      nu++;
    }
  }
  const { count, error: ce } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (ce) await fail(`data_import_rows の件数確認: ${ce.message}`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch 更新: ${e2.message}`);
  console.log(`完了。削除 ${nd} / copay 更新 (認定+clients) ${nu} / 飛ばした ${skip.length} ${JSON.stringify(countBy(skip, (s) => s.why.split(" ")[0]))} / data_import_rows ${count} 行 (= ${nd + nu} のはず)`);
  console.log(`取り消しは --revert ${BATCH}`);
}

// ── 取り消し ──────────────────────────────────────────────────────────────
const DERIVED = [["doc_tasks", "trigger_ref_id"], ["care_plan_elements", "ref_id"]];
async function revert(sb, batchId) {
  const { data: batch, error } = await sb.from("data_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(`data_import_batches: ${error.message}`);
  if (!batch || batch.source_system !== SOURCE_SYSTEM) { console.error(`batch ${batchId} が無い か この script のものではない`); process.exit(1); }
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 取り消し batch ${batchId} (${batch.status} / ${batch.created_at})`);
  if (batch.status === "reverted") { console.log("既に取り消し済み"); return; }
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  const cur = new Map((await selectIn(sb, "client_insurance_records", "*", "id", recs.filter((r) => r.table_name === "client_insurance_records").map((r) => r.row_id))).map((r) => [r.id, r]));
  const curC = new Map((await selectIn(sb, "clients", "id,copay_rate", "id", recs.filter((r) => r.table_name === "clients").map((r) => r.row_id))).map((r) => [r.id, r]));
  const restore = [], restoreC = [], reinsert = [], skip = [];
  for (const r of recs) {
    if (r.table_name === "clients") {
      const nowC = curC.get(r.row_id);
      if (!nowC) skip.push({ id: r.row_id, why: "既に無い" }); else if (String(nowC.copay_rate ?? "") !== String(r.after.copay_rate)) skip.push({ id: r.row_id, why: "後から copay_rate が変わった" }); else restoreC.push(r);
      continue;
    }
    const now = cur.get(r.row_id);
    if (r.op === "delete") { if (now) skip.push({ id: r.row_id, why: "同じ id の行が既にある" }); else reinsert.push(r.before); }
    else if (r.op === "update") { if (!now) skip.push({ id: r.row_id, why: "既に無い" }); else if (String(now.copay_rate ?? "") !== String(r.after.copay_rate)) skip.push({ id: r.row_id, why: "後から copay_rate が変わった" }); else restore.push(r.row_id); }
  }
  console.log(`戻す 認定 (copay_rate → null) ${restore.length} / clients (copay_rate → 元の値) ${restoreC.length} / 入れ直す ${reinsert.length} / 戻さない ${skip.length} ${JSON.stringify(countBy(skip, (s) => s.why))}`);
  if (!EXECUTE) { console.log("DRY RUN — 何も変えていない"); return; }
  for (const c of chunks(restore, 150)) {
    const { error: e, count } = await sb.from("client_insurance_records").update({ copay_rate: null }, { count: "exact" }).in("id", c);
    if (e || count !== c.length) throw new Error(`restore: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`);
  }
  for (const r of restoreC) {
    const { error: e, count } = await sb.from("clients").update({ copay_rate: r.before?.copay_rate ?? null }, { count: "exact" }).eq("id", r.row_id);
    if (e || count !== 1) throw new Error(`restore clients ${r.row_id}: ${e?.message ?? `件数 ${count}`}`);
  }
  // 入れ直しは INSERT → trigger が派生行を作る。入れ直した行を参照するものだけ消す
  const clientIds = [...new Set(reinsert.map((r) => r.client_id))];
  const beforeSets = {};
  for (const [t] of DERIVED) beforeSets[t] = new Set((await selectIn(sb, t, "id", "client_id", clientIds, (q) => q.eq("tenant_id", TENANT))).map((r) => r.id));
  reinsert.sort((a, b) => (a.certification_start_date ?? "").localeCompare(b.certification_start_date ?? ""));
  for (const row of reinsert) { // trigger が「直前の行」を見るので 1 行ずつ・古い順
    const { error: e } = await sb.from("client_insurance_records").insert(row);
    if (e) throw new Error(`reinsert ${row.id}: ${e.message}`);
  }
  const refIds = new Set(reinsert.map((r) => r.id));
  for (const [t, refCol] of DERIVED) {
    const fresh = (await selectIn(sb, t, "*", "client_id", clientIds, (q) => q.eq("tenant_id", TENANT))).filter((r) => !beforeSets[t].has(r.id));
    const mine = fresh.filter((r) => refIds.has(r[refCol]));
    for (const c of chunks(mine.map((r) => r.id), 150)) {
      const { error: e, count } = await sb.from(t).delete({ count: "exact" }).in("id", c);
      if (e || count !== c.length) throw new Error(`掃除 ${t}: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`);
    }
    console.log(`  掃除 ${t}: 消した ${mine.length} / 消さなかった新しい行 ${fresh.length - mine.length}`);
  }
  const status = skip.length ? "partially_reverted" : "reverted";
  const { error: e3 } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
  if (e3) throw new Error(`batch 更新: ${e3.message}`);
  console.log(`取り消し完了 (${status})`);
}

// ── main ──────────────────────────────────────────────────────────────────
const sb = await makeSb();
const ready = await provenanceReady(sb);
if (!ready.ok) { console.error(`出どころ記録の表が無い (${ready.why})`); process.exit(2); }
if (REVERT) { await revert(sb, REVERT); process.exit(0); }
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} fix_honobono_sync_shared_certs --step=${STEP}`);
const p = await plan(sb);
const fill = printPlan(p);
writeFileSync(OUT, JSON.stringify({
  at: new Date().toISOString(), step: STEP,
  削除候補: p.D.削除候補, 判断が要る: p.D.判断が要る, 残す: p.D.残す, order_app_2026_09: p.oa,
  copay: { 埋める: fill, 埋めない: p.copay.埋めない, 既に値あり: p.copay.既に値あり.length },
  clients_copay: p.cc,
  記録に無いマーカー行: p.unlogged.map((r) => r.id),
}, null, 1));
console.log(`\n計画 ${OUT}`);
if (!EXECUTE) { console.log("DRY RUN — 何も変えていない。--execute で反映 (★ user 確認後)"); process.exit(0); }
await execute(sb, p, fill);
