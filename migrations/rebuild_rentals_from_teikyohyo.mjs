/**
 * 福祉用具 (ケアサポ) の貸与明細 (order_items) を ほのぼのの「提供票」(入力側・日ごとの実績) から組み直す
 *
 *   node migrations/rebuild_rentals_from_teikyohyo.mjs                         # DRY RUN (既定)
 *   node migrations/rebuild_rentals_from_teikyohyo.mjs --remove-db-only        # DRY RUN (DB だけの明細の削除も計画に入れる)
 *   node migrations/rebuild_rentals_from_teikyohyo.mjs --remove-db-only --execute   # 本番 (★ user 承認後)
 *   node migrations/rebuild_rentals_from_teikyohyo.mjs --revert <batch_id> [--execute]
 *   node migrations/rebuild_rentals_from_teikyohyo.mjs --cleanup-batch <batch_id> [--execute]
 *     (--revert / --cleanup-batch は sync_fukuyogu_from_honobono.mjs の汎用処理に渡す。data_import_rows の before/after で戻す)
 *
 *   --teikyo-dir <dir>      既定 kaigo-app/伝送データ/ケアサポ/福祉用具/用具貸与期間_20261109 (提供票_YYYYMM.csv を全部読む)
 *   --master-dir <dir>      既定 kaigo-app/伝送データ/ケアサポ/福祉用具/マスタ
 *                           FYGMST01_用具マスタ*.CSV (介護) / ファイル名に「予防」= 予防の用具マスタ / 「自費」= 自費の用具マスタ
 *                           (予防・自費のマスタが届いたら置くだけで差し替わる。無ければ 予防 = 介護マスタとの類似度、自費 = 名前で新規)
 *   --user-master-dir <dir> 既定 kaigo-app/伝送データ/ケアサポ/福祉用具/利用者マスタ_20261109 (介護保険_*.CSV で 利用者番号 → 保険者+被保番)
 *   --out-dir <dir>         詳細 JSON の出力先 (既定 OS の一時フォルダ/teikyo-rebuild)
 *   --db-cache <json>       DRY RUN で DB の控えを使う (無ければ 1 回読んで保存。--refresh で読み直す。--execute は常に読み直す)
 *   --pause-mode single|split  月内の休止の表し方 (既定 single = 1 明細のまま notes に休止期間 / split = 休止の前後で 2 明細)
 *   --remove-db-only        提供票 (4〜10月) に無い DB の明細を削除する (★ 既定は計画に出すだけで消さない)
 *   --skip-users 14400,…    提供票の利用者番号を扱わない (DB の明細も消さない)。2026-11-11: 風戸 芳子 (14400) は自費 2 台が DB に別コード
 *                           (EQ-001524/1526) で居て、そのまま入れると二重になるため外した
 *   --disambiguate-by-billing  略称・単位が同じで TAIS が複数ある用具を、ほのぼのの請求 (KDS0031) の TAIS で決める (2026-11-11 user 承認)
 *
 * ── 方針 (user 承認 2026-11-09) ─────────────────────────────────────────────
 *   ・入力 = 提供票 (実績行) + 用具マスタ + 利用者マスタ。★ KDS0031 (請求の出力) は最後の答え合わせにだけ使う (循環させない)
 *   ・予定行は使わない (実績と 424/5,907 件で食い違い、請求は実績どおり)
 *   ・日付が DB と食い違うときは 提供票 (実績) を正とする
 *   ・0 円の付属品 (自費レンタル=対象・概算単位 0) も貸与に入れる → payment_type='自費'・rental_price=0
 *     ★ 2026-11-09: 保険事業所の行で 概算単位 0 なら 自費レンタル欄が空でも 自費 (欄が空の月だけ 介護 0 円になり、翌月の自費と別明細に割れていた)
 *   ・用具が「+単位+中止」で決まるとき、中止で絞る前の候補に その利用者の DB の既存明細の TAIS が 1 つだけあれば それを優先 (2026-11-09)
 *     (BillingTab は 介護 だけを請求、UserBillingTab は単価 0 を飛ばすので、金額には出ない)
 *   ・自費レンタル事業所の行 → payment_type='自費'。rental_price = 月額の単位数 × 10 (★ 仮。自費マスタが来たら見直し)
 *     自費の用具が用具マスタに無ければ equipment_master に EQ-nnnnnn で追加 (lib/equipment.ts の採番と同じ形)
 *   ・月内で空く台 (101 型) = 休止。order-app に休止の仕組みは無く、client_hospitalizations は kaigo-app と共有
 *     (障害の入院判定に使われる) で、しかも利用者単位 (全用具) なので使わない。
 *     → 既定 (--pause-mode single): 1 明細のまま、notes に [休止 YYYY-MM-DD〜YYYY-MM-DD] (貸与しなかった日) を書く。
 *       半月按分は「前半/後半に 1 日でも貸与があるか」なので、休止の前後が同じ明細なら ほのぼのの単位と同じになる
 *       (ほのぼのも 1 行・満額で、日数だけ休止を除く)。★ 伝送の日数は休止を数えてしまう (order-app に休止日を除く仕組みが無い)
 *       --pause-mode split (2 明細) は ★ 過大になる: 例 6/1〜26 + 6/30 → 満額 + 半額 (ほのぼのは満額 1 本。饗庭 將公 2026-06 で実証)
 *   ・4/1 より前から借りている台 (4 月の 1 日から印) → rental_start_date=2026-04-01 を仮置きし notes に [4/1以前から]
 *   ・最後の月 (10 月) の末日まで印がある台 → 継続中 (rental_end_date=null・rental_started)。それ以外は terminated + 終了日
 *   ・同じ月に同じ用具が 2 行以上ある組 (台数 2 以上) の対応付け: 下の「月またぎ・同月の連結」
 *   ・利用者の引き当て: 利用者マスタ CSV の (保険者, 被保番) → DB の clients / 認定 → 利用者番号+氏名 → 氏名 (ケアサポ所属で一意)。
 *     ★ 2026-11-13: 氏名だけで引くとき・候補が複数のときは 生年月日 (利用者マスタ 基本情報 ↔ clients.birth_date) の一致を必須に
 *     (_name_birth_match.mjs。違えば新規の候補、どちらかが無い・仮なら判断待ち。どちらも引かない)
 *     引けない利用者は ★ 何もしない (clients 等の共有表は作らない・触らない)
 *   ・order_items は福祉用具専用なので、共有の利用者でも置き換えてよい。clients / 認定 / 公費 / 入院記録 は触らない
 *
 * ── 連結の規則 ─────────────────────────────────────────────────────────────
 *   ・1 行 = 1 台 (数量は常に 1)。行の連続した 1 = 1 区間
 *   ・用具のキー = TAIS (引き当て不可なら 種目+名称)。事業所 (保険/自費レンタル) が違えば別の台
 *   ・月またぎ: 前月の末日まで続く台と、当月 1 日から始まる区間を つなぐ。候補が複数なら
 *     ① 月額の単位数が同じ → ② 行の順 (CSV の並び) の順で 1 対 1
 *   ・同じ月の中: 別の行の区間が前日で終わっていれば同じ台の続き (保険者・介護↔予防の切替で行が分かれる。単位数が同じものを優先)
 *   ・同じ行の中で 0 が挟まる = 休止 (上の 2 明細)
 *
 * ── DB との置き換え ────────────────────────────────────────────────────────
 *   対象 = ケアサポの注文の明細で status が rental_started / terminated のもの (ordered / cancelled は触らない)。
 *   利用者ごと・用具 (TAIS) ごとに 提供票の明細 と DB の明細 を 1 対 1 で対応付け (日付が同じ → 重なる → 残り の順):
 *     対応あり → update (日付・状態・数量・支払区分・単価・notes の差だけ。id を残す = 書類タスクや単位上書きの参照が切れない)
 *     提供票だけ → insert (利用者のケアサポの注文に入れる。注文が無ければ注文を作る)
 *     DB だけ   → --remove-db-only のときだけ delete。ただし ★ 参照 (billing_unit_overrides / order_item_price_changes /
 *                 monitoring_items) がある明細、引き当て不可の行を持つ利用者の明細、4/1 より前に終わった明細は消さない
 *
 * ── 書込みの作法 (--execute) ─────────────────────────────────────────────
 *   sync_fukuyogu_from_honobono.mjs と同じ: data_import_batches → 各書込みの直後に data_import_rows (before/after)。
 *   変更前の行は migrations/_backup_teikyo_rebuild_<時刻>.json にも保存。trigger が作る doc_tasks / care_plan_elements は
 *   参照先がこの batch で触った行のものだけ消して記録 (op=delete・cleanup)。DB は --execute 時に必ず読み直す。
 *   update は更新件数 1 を確認。insert は 100 件ずつ・同じキー集合。.in() は 150 件ずつ。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { execLockStart, execLockAcquire } from "./_exec_lock.mjs";
import { resolveFukuyoguOffice, latestTeikyoDir, describeFukuyoguOffice, teikyoKindOfOffice } from "./_fukuyogu_office.mjs";
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
const { C, TENANT, readKds0031, readEnv, parseCsvLine, nfkc, nInsurer, nInsured, nDate, daysIn } = core;
const { decideByBirth } = await import("./_name_birth_match.mjs");
const { halfMonthUnits } = await import("../lib/half-month-units");
const { getPriceForMonth } = await import("../lib/equipment");

const EXECUTE = argv.includes("--execute");
const REMOVE_DB_ONLY = argv.includes("--remove-db-only");
const PAUSE_MODE = opt("--pause-mode") ?? "single";
const DISAMBIGUATE_BY_BILLING = argv.includes("--disambiguate-by-billing"); // ★ 2026-11-11 user 承認 (下の注記)
const SKIP_USERS = new Set((opt("--skip-users") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
// ★ 2026-11-12: --as-of YYYY-MM-DD — 最新月が月の途中のとき (提供票は予定の写しで月末まで印が入る)、
//   as-of 当日以降の「終了」は まだ確定していない予定なので 継続扱い (end=null) に、as-of より後の「開始」は 入れない。
//   as-of より後の休止も notes に書かない (予定の休止を確定扱いにしない)。
const AS_OF = opt("--as-of") ?? null;
// ★ 2026-11-14: --until YYYYMM — それより後の月の提供票を読まない。
//   最新月の提供票が途中までしか出ていない (誉田 20261113 の 11 月は 実績 431 行 / 10 月 4,543 行) と、
//   「最後の月の月末まで続く台だけ継続」の判定で 10 月末まで借りている台が軒並み 10/31 終了になる (誉田で 現利用者 1,121 名中 貸与中 71 名)。
//   読まなかった月に始まった台は入らない (揃った提供票で回し直すと入る)。
const UNTIL = opt("--until") ?? null;
if (UNTIL && !/^\d{6}$/.test(UNTIL)) { console.error("--until は YYYYMM"); process.exit(1); }
if (AS_OF && !/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) { console.error("--as-of は YYYY-MM-DD"); process.exit(1); }
// ★ --as-of で飛ばした 開始予定の台に当たる DB の明細 (先に手で登録された未来開始の明細) を「DB だけ」として消してしまうので併用禁止
if (AS_OF && REMOVE_DB_ONLY) { console.error("★ --as-of と --remove-db-only は併用できない (as-of より後の開始予定に当たる DB の明細を消してしまう)"); process.exit(1); }
if (!["single", "split"].includes(PAUSE_MODE)) { console.error("--pause-mode は single|split"); process.exit(1); }
// 対象事業所: 既定 ケアサポ (介護ショップ ケア・サポート千葉 1bfc0d57…)。--area / --office-bn で切替 (_fukuyogu_office.mjs)
const FO = resolveFukuyoguOffice(argv);
if (!FO.isDefault) console.log(describeFukuyoguOffice(FO));
const OFFICE = FO.officeId;
const FUKUYOGU = FO.dir;
// 既定 = 最新の 用具貸与期間_YYYYMMDD / 利用者マスタ_YYYYMMDD (引数化の前は 20261109 に固定。ケアサポは今それしか無いので同じ)
const TEIKYO_DIR = resolve(opt("--teikyo-dir") ?? latestTeikyoDir(FUKUYOGU) ?? join(FUKUYOGU, "用具貸与期間_(未着)"));
const MASTER_DIR = resolve(opt("--master-dir") ?? join(FUKUYOGU, "マスタ"));
const UM_DIR = resolve(opt("--user-master-dir") ?? resolveUserMasterDirs(FUKUYOGU, [], { log: false }).on ?? join(FUKUYOGU, "利用者マスタ_(未着)"));
// 登録無 (元利用者) の利用者マスタ。氏名だけで引くときの生年月日に使う (★ 2026-11-13)
const UM_DIR_OFF = opt("--user-master-dir-off") ? resolve(opt("--user-master-dir-off")) : resolveUserMasterDirs(FUKUYOGU, [], { log: false }).off;
const OUT_DIR = resolve(opt("--out-dir") ?? join(tmpdir(), "teikyo-rebuild"));
const REPO_ROOT = resolve(HERE, "../../..");
const SCRIPT_REL = "apps/order-app/migrations/rebuild_rentals_from_teikyohyo.mjs";
let EXEC_LOCK = null; // 同じ script の同時 --execute を止める (_exec_lock.mjs)。--execute の最初に execLockStart で取る
const SOURCE_SYSTEM = "honobono-fukuyogu";
const STEP = "teikyo-rebuild";
const MARK = "[teikyo-rebuild-20261109]";
// 移行の起点 = 提供票の最初の月の 1 日 (ケアサポは 2026-04 から → 2026-04-01 / [4/1以前から] で従来どおり)。
//   ★ 2026-11-13: 誉田は R8/5 からしか無いので 4/1 固定だと 5/1 から続く台に 4/1 を仮置きしていた → 最初の月から決める (main で確定)
const BILLED_TAIS_MARK = "[品目は請求の出力で特定]";
let MIGRATION_START = "2026-04-01";
let BEFORE_APR = "[4/1以前から]";
const REF_TABLES = [["billing_unit_overrides", "order_item_id"], ["order_item_price_changes", "order_item_id"], ["monitoring_items", "order_item_id"]];

// ── 小道具 ────────────────────────────────────────────────────────────────
const nf = (s) => nfkc(s).replace(/[\s　]+/g, "");
const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const countBy = (arr, f) => { const m = {}; for (const x of arr) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const pad = (n) => String(n).padStart(2, "0");
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const relPath = (p) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const monthIdx = (ym) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
let seq = 0;
const newId = (k) => `new:${k}:${++seq}`;
const isNew = (id) => typeof id === "string" && id.startsWith("new:");
class Report {
  constructor() { this.m = new Map(); }
  add(cat, ex) { if (!this.m.has(cat)) this.m.set(cat, []); this.m.get(cat).push(ex); }
  print(n = 3) { for (const [k, v] of this.m) { console.log(`  ${String(v.length).padStart(5)}  ${k}`); for (const e of v.slice(0, n)) console.log(`         - ${JSON.stringify(e)}`); } }
  toJSON() { return Object.fromEntries([...this.m].map(([k, v]) => [k, { count: v.length, items: v }])); }
}
/** 類似度 = 2×最長共通部分列 / (長さの和)。difflib の ratio の代わり (予防の短縮名の引き当てにだけ使う) */
const ratio = (a, b) => {
  if (!a.length || !b.length) return 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) { let prev = 0; for (let j = 1; j <= b.length; j++) { const t = dp[j]; dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]); prev = t; } }
  return (2 * dp[b.length]) / (a.length + b.length);
};

/** SJIS の CSV (引用符ありでも無しでも) */
function readSjis(path) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(path)).split(/\r\n|\n/).filter((l) => l.length > 0);
  return { head: parseCsvLine(lines[0]), rows: lines.slice(1).map(parseCsvLine), path };
}
const colOf = (f, name) => { const i = f.head.indexOf(name); if (i < 0) throw new Error(`★ ${f.path} に列「${name}」が無い`); return i; };

// ── 用具マスタ (FYGMST01 形式) ──────────────────────────────────────────────
function readMaster(path) {
  const f = readSjis(path);
  const H = Object.fromEntries(["中止", "区分", "福祉用具種目", "商品名称", "略称", "型番", "TAISコード等", "単位数"].map((k) => [k, colOf(f, k)]));
  const out = []; const fixed = [];
  for (let r of f.rows) {
    const wasFixed = r.length === f.head.length + 1;
    if (wasFixed) { fixed.push(r[H.商品名称]); r = [...r.slice(0, H.型番), `${r[H.型番]},${r[H.型番 + 1]}`, ...r.slice(H.型番 + 2)]; } // 型番に引用符なしのカンマ (FYGMST01 で 1 行)
    if (r.length !== f.head.length) throw new Error(`★ ${path}: 列数 ${r.length} ≠ ${f.head.length} の行 (${r.slice(0, 12).join(",")})`);
    if (wasFixed && !/^\d{5}-[0-9A-Z]{6}$/.test(nfkc(r[H.TAISコード等]))) throw new Error(`★ ${path}: TAIS の形がおかしい行 (列ずれ?) ${r.slice(8, 14).join(",")}`);
    out.push({ stop: r[H.中止] === "1", kubun: nfkc(r[H.区分]), cat: kindOf(r[H.福祉用具種目]), name: nfkc(r[H.商品名称]), abbr: nfkc(r[H.略称]), model: nfkc(r[H.型番]), tais: nfkc(r[H.TAISコード等]), units: r[H.単位数] === "" ? null : Number(r[H.単位数]) });
  }
  return { path, rows: out, fixed };
}
const kindOf = (kindRaw) => { const k = nf(kindRaw).replace(/^予防/, ""); return k === "徘徊感知機器" ? "認知症老人徘徊感知機器" : k; };

function makeMatcher(masters) {
  const idx = (m) => { const o = { 略称: new Map(), 商品名称: new Map(), 型番: new Map() }; for (const r of m.rows) for (const [f, v] of [["略称", r.abbr], ["商品名称", r.name], ["型番", r.model]]) { if (!v) continue; const k = nf(v); if (!o[f].has(k)) o[f].set(k, []); o[f].get(k).push(r); } return o; };
  const I = Object.fromEntries(Object.entries(masters).filter(([, m]) => m).map(([k, m]) => [k, idx(m)]));
  const cache = new Map();
  const narrow = (c, full) => {
    const uniq = (xs) => new Set(xs.map((x) => x.tais || `名:${x.name}`)).size === 1;
    if (uniq(c)) return [c[0], ""];
    const cu = c.filter((x) => x.units === full);
    if (cu.length && uniq(cu)) return [cu[0], "+単位"];
    const cn = (cu.length ? cu : c).filter((x) => !x.stop);
    // ★ 2026-11-09: 中止で絞る前の候補も返す (呼び出し側で その利用者の DB の既存明細の TAIS を優先する)
    if (cn.length && uniq(cn)) return [cn[0], "+単位+中止", cu.length ? cu : c];
    return [null, ""];
  };
  /** @returns {{how:string, tais:string|null, m:object|null, cands:string[]}} */
  return function match(src, kindRaw, item, full) {
    const key = `${src}|${kindRaw}|${item}|${full}`;
    if (cache.has(key)) return cache.get(key);
    const k = kindOf(kindRaw), it = nf(item);
    const names = [it, ...(it.startsWith("予") ? [it.slice(1)] : [])];
    const order = src === "予防" ? ["予防", "介護"] : src === "自費" ? ["自費", "介護"] : ["介護"];
    let res = null;
    outer: for (const mk of order) {
      if (!I[mk]) continue;
      for (const nm of names) for (const f of ["略称", "商品名称", "型番"]) {
        const c = (I[mk][f].get(nm) ?? []).filter((x) => x.cat === k);
        if (!c.length) continue;
        const [hit, how, pre] = narrow(c, full);
        res = hit ? { how: `完全一致(${mk}マスタ・${f}${how})${nm !== it ? "/予除去" : ""}`, tais: hit.tais || null, m: hit, cands: [], pre: pre ?? null }
                  : { how: "複数", tais: null, m: null, cands: [...new Set(c.map((x) => x.tais).filter(Boolean))] };
        break outer;
      }
    }
    if (!res && src === "予防" && !masters.予防) {
      // 予防の用具マスタが無い間のつなぎ: 介護マスタの同種目・同単位数の中で 略称/商品名称 との類似度
      const nm = names[names.length - 1];
      const pool = masters.介護.rows.filter((x) => x.cat === k && x.units === full && x.kubun === "レンタル" && x.tais);
      const sc = pool.map((x) => ({ s: Math.max(ratio(nm, nf(x.abbr)), ratio(nm, nf(x.name))) + (x.stop ? 0 : 0.02), x })).sort((a, b) => b.s - a.s);
      if (sc.length && sc[0].s >= 0.55) {
        const best = sc[0].x.tais, second = sc.find((y) => y.x.tais !== best)?.s ?? 0;
        res = sc[0].s - second >= 0.08 ? { how: "類似(予防マスタ無し・同種目同単位)", tais: best, m: sc[0].x, cands: [] }
                                       : { how: "類似が複数", tais: null, m: null, cands: [...new Set(sc.slice(0, 4).map((y) => y.x.tais))] };
      }
    }
    if (!res) res = { how: "当たらない", tais: null, m: null, cands: [] };
    cache.set(key, res);
    return res;
  };
}

// ── 提供票 ────────────────────────────────────────────────────────────────
function readTeikyo(path) {
  const f = readSjis(path);
  const c = Object.fromEntries(["事業所名", "利用者番号", "利用者名", "提供年月", "サービス内容", "数量", "日割区分", "自費レンタル", "予定／実績", "1日", "31日", "合計・回数", "概算単位数", "サービスコード"].map((k) => [k, colOf(f, k)]));
  if (c["31日"] - c["1日"] !== 30) throw new Error(`★ ${path}: 1日〜31日の列が連続していない`);
  const bad = f.rows.filter((r) => r.length !== f.head.length).length;
  if (bad) throw new Error(`★ ${path}: 列数が ${f.head.length} でない行 ${bad}`);
  return f.rows.map((r, i) => {
    const svc = r[c.サービス内容];
    const m = svc.match(/^(.*?)貸与[（(](.*)[)）]$/);
    const ym = nfkc(r[c.提供年月]).replace("/", "-");
    const nd = daysIn(ym);
    const days = r.slice(c["1日"], c["1日"] + 31).map((v) => (nfkc(v) === "1" ? 1 : 0));
    if (days.reduce((a, b) => a + b, 0) !== Number(r[c["合計・回数"]] || 0)) throw new Error(`★ ${path} 行 ${i + 2}: 合計・回数 と日の印の数が違う`);
    if (Number(r[c.数量]) !== 1) throw new Error(`★ ${path} 行 ${i + 2}: 数量 ${r[c.数量]} (1 以外は想定外)`);
    const office = nfkc(r[c.事業所名]);
    return {
      file: relPath(path), row: i + 2, ym, nd, days: days.slice(0, nd), office, userNo: nfkc(r[c.利用者番号]), name: nfkc(r[c.利用者名]),
      svc, kindRaw: m ? m[1] : "?", item: m ? m[2] : svc, hiwari: nfkc(r[c.日割区分]), jihiFlag: nfkc(r[c.自費レンタル]) === "対象",
      pa: nfkc(r[c["予定／実績"]]), units: Number(r[c.概算単位数] || 0), code: nfkc(r[c.サービスコード]),
      src: teikyoKindOfOffice(office), // 自費レンタル / 予・(予) で始まる / それ以外 (_fukuyogu_office.mjs。誉田の名前にも対応)
    };
  });
}
/** 月額 (満額) の単位数。半額 → ×2。日割 (保険者の月途中変更) → null (他の月か マスタで決める) */
const fullUnitsOf = (r) => (r.hiwari === "全額" ? r.units : r.hiwari === "半額" ? r.units * 2 : null);
/** 支払区分。自費レンタル事業所の行 / 自費レンタル=対象 / 保険事業所の行で概算単位 0 (0 円の付属) → 自費。それ以外は 介護 */
const payTypeOf = (r) => (r.src === "自費" || r.jihiFlag || (r.src !== "自費" && !r.jihiFlag && r.units === 0) ? "自費" : "介護");

// ── DB ────────────────────────────────────────────────────────────────────
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
    clients: await selectAll(sb, "clients", "id,user_number,name,birth_date,office_id,deleted_at,insurer_number,insured_number", t),
    ins: await selectAll(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number", t),
    orders: await selectAll(sb, "orders", "id,client_id,office_id,payment_type,status,ordered_at", t),
    items: await selectAll(sb, "order_items", "*", t),
    equipment: await selectAll(sb, "equipment_master", "id,product_code,tais_code,name,category,kind,rental_price", t),
    priceHist: await selectAll(sb, "equipment_price_history", "*", t), // ★ office_id (事業所ごとの価格) は列が無い DB でも読めるよう *
    hosp: await selectAll(sb, "client_hospitalizations", "id,client_id,admission_date,discharge_date", t),
    overrides: await selectAll(sb, "billing_unit_overrides", "id,client_id,month,order_item_id,units_override", t),
    refs: {},
  };
  for (const k of ["clients", "orders", "items", "equipment"]) if (!db[k].length) throw new Error(`★ ${k} が 0 行 (tenant / 列名を疑う)`);
  for (const [tb, col] of REF_TABLES) {
    const { error } = await sb.from(tb).select("id").limit(1);
    if (error) { console.log(`  参照の確認: ${tb} を読めない (${error.message}) → 参照なしとして扱う`); db.refs[tb] = new Set(); continue; }
    db.refs[tb] = new Set((await selectAll(sb, tb, `id,${col}`)).map((r) => String(r[col])));
  }
  console.log(`DB (READ ONLY): ${Object.entries(db).filter(([, v]) => Array.isArray(v)).map(([k, v]) => `${k} ${v.length}`).join(" / ")}`);
  return db;
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`${EXECUTE ? "★★ EXECUTE (本番書込み)" : "DRY RUN (DB は書き換えない)"} / --remove-db-only ${REMOVE_DB_ONLY ? "あり" : "なし"}`);

  // マスタ
  const mfiles = readdirSync(MASTER_DIR).filter((f) => /^FYGMST.*\.csv$/i.test(f));
  const pick = (re) => mfiles.filter((f) => re.test(f));
  const kaigoF = mfiles.filter((f) => !/予防|自費/.test(f));
  if (kaigoF.length !== 1) throw new Error(`★ ${MASTER_DIR} の介護の用具マスタが 1 本でない: ${kaigoF.join(", ")}`);
  const masters = { 介護: readMaster(join(MASTER_DIR, kaigoF[0])), 予防: null, 自費: null };
  for (const [k, re] of [["予防", /予防/], ["自費", /自費/]]) { const fs = pick(re); if (fs.length > 1) throw new Error(`★ ${k}マスタが複数 ${fs}`); if (fs.length) masters[k] = readMaster(join(MASTER_DIR, fs[0])); }
  for (const [k, m] of Object.entries(masters)) console.log(`用具マスタ ${k}: ${m ? `${relPath(m.path)} ${m.rows.length} 行${m.fixed.length ? ` (型番のカンマを直した ${m.fixed.length} 行)` : ""}` : "★ 無い (届くまで: " + (k === "予防" ? "介護マスタとの類似度" : "介護マスタに名前で当たらなければ EQ で新規") + ")"}`);
  const match = makeMatcher(masters);

  // 提供票
  const tfilesAll = readdirSync(TEIKYO_DIR).filter((f) => /^提供票_\d{6}\.csv$/i.test(f)).sort();
  const tfiles = UNTIL ? tfilesAll.filter((f) => f.match(/(\d{6})/)[1] <= UNTIL) : tfilesAll;
  if (UNTIL) for (const f of tfilesAll.filter((x) => !tfiles.includes(x))) console.log(`★ --until ${UNTIL}: ${f} は読まない (この月に始まった台は入らない)`);
  if (!tfiles.length) throw new Error(`★ ${TEIKYO_DIR} に 提供票_YYYYMM.csv が無い`);
  const all = [];
  const sourceFiles = [];
  for (const f of tfiles) {
    const p = join(TEIKYO_DIR, f), rs = readTeikyo(p);
    const yms = new Set(rs.map((r) => r.ym));
    if (yms.size !== 1 || [...yms][0].replace("-", "") !== f.match(/(\d{6})/)[1]) throw new Error(`★ ${f}: ファイル名と提供年月が違う (${[...yms]})`);
    all.push(...rs);
    sourceFiles.push({ path: relPath(p), sha256: sha256(p), rows: rs.length, kind: `提供票 (提供 ${[...yms][0]})` });
    console.log(`提供票 ${f}: ${rs.length} 行 (実績 ${rs.filter((r) => r.pa === "実績").length})`);
  }
  for (const m of Object.values(masters)) if (m) sourceFiles.push({ path: relPath(m.path), sha256: sha256(m.path), rows: m.rows.length, kind: "用具マスタ" });
  const months = [...new Set(all.map((r) => r.ym))].sort();
  for (let i = 1; i < months.length; i++) if (monthIdx(months[i]) - monthIdx(months[i - 1]) !== 1) throw new Error(`★ 提供票の月が飛んでいる ${months[i - 1]} → ${months[i]}`);
  const FIRST = months[0], LAST = months[months.length - 1];
  MIGRATION_START = `${FIRST}-01`;
  BEFORE_APR = `[${Number(FIRST.slice(5, 7))}/1以前から]`;
  if (FIRST !== "2026-04") console.log(`★ 提供票の最初の月が ${FIRST} なので、${MIGRATION_START} より前から続く台は ${MIGRATION_START} を仮置きし notes に ${BEFORE_APR}`);
  const rows = all.filter((r) => r.pa === "実績" && !SKIP_USERS.has(r.userNo));
  if (SKIP_USERS.size) console.log(`--skip-users: 提供票の利用者番号 ${[...SKIP_USERS].join(",")} は扱わない`);
  const R = { map: new Report(), users: new Report(), link: new Report(), plan: new Report(), db: new Report(), warn: new Report() };

  // 利用者マスタ (介護保険) → 利用者番号 → (保険者, 被保番)
  //   ★ 2026-11-13: 新しく受け入れる事業所 (誉田) で 利用者マスタがまだ届いていないときは、DRY RUN に限り
  //   (保険者, 被保番) の引き当て無しで続ける (提供票の読み方を先に確かめるため)。--execute は止める
  const keysOf = new Map();
  const birthOf = new Map(); // 利用者番号 → 生年月日 (利用者マスタ 基本情報。食い違えば null)
  if (!existsSync(UM_DIR)) {
    if (EXECUTE) throw new Error(`★ 利用者マスタが無い (${UM_DIR})。--execute は 利用者マスタを置いてから`);
    console.log(`⚠ 利用者マスタが無い (${relPath(UM_DIR)}) — DRY RUN なので (保険者, 被保番) の引き当て無し (利用者番号・氏名だけ) で続ける。結果は参考`);
  } else {
  // ★ 2026-11-13: 登録有 に加えて 登録無 (元利用者) の介護保険も鍵にする (登録無にしか居ない人も 保険者+被保番 で引けるように。生年月日に頼らない)
  for (const [dir, must, kind] of [[UM_DIR, true, "利用者管理 介護保険"], [UM_DIR_OFF, false, "利用者管理 介護保険 (登録無)"]]) {
    if (!dir || !existsSync(dir)) continue;
    const ukF = readdirSync(dir).find((f) => f.startsWith("介護保険_") && /\.csv$/i.test(f));
    if (!ukF) { if (must) throw new Error(`★ ${dir} に 介護保険_*.CSV が無い`); continue; }
    const UK = readSjis(join(dir, ukF));
    sourceFiles.push({ path: relPath(UK.path), sha256: sha256(UK.path), rows: UK.rows.length, kind });
    const a = colOf(UK, "利用者番号"), b = colOf(UK, "保険者番号"), c = colOf(UK, "被保険者番号");
    for (const r of UK.rows) { const k = `${nInsurer(r[b])}|${nInsured(r[c])}`; if (k.startsWith("|") || k.endsWith("|")) continue; const no = nfkc(r[a]); if (!keysOf.has(no)) keysOf.set(no, new Set()); keysOf.get(no).add(k); }
  }
  // ★ 2026-11-13: 利用者番号 → 生年月日 (基本情報。登録有 + 登録無)。氏名だけで引くとき・候補が複数のときに 生年月日の一致を必須にする (_name_birth_match.mjs)
  //   同じ番号に違う生年月日が 2 つ以上あれば 使わない (null)
  for (const dir of [UM_DIR, UM_DIR_OFF]) {
    if (!dir || !existsSync(dir)) continue;
    const ubF = readdirSync(dir).find((f) => f.startsWith("基本情報_") && /\.csv$/i.test(f));
    if (!ubF) continue;
    const UB = readSjis(join(dir, ubF));
    sourceFiles.push({ path: relPath(UB.path), sha256: sha256(UB.path), rows: UB.rows.length, kind: "利用者管理 基本情報 (生年月日)" });
    const a = colOf(UB, "利用者番号"), b = colOf(UB, "生年月日");
    for (const r of UB.rows) {
      const no = nfkc(r[a]), bd = nDate(r[b]);
      if (!no || !bd) continue;
      birthOf.set(no, birthOf.has(no) && birthOf.get(no) !== bd ? null : bd);
    }
  }
  }

  // DB
  const sb = await makeSb();
  if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv }); // ★ 計画の DB 読みより前 (同時実行なら exit 2)
  // DRY RUN は DB の読み直しを避けて控えを使える (--db-cache <json>・--refresh で読み直す)。--execute は必ず読み直す
  const CACHE = opt("--db-cache");
  let db;
  if (!EXECUTE && CACHE && !argv.includes("--refresh") && existsSync(CACHE)) {
    db = JSON.parse(readFileSync(CACHE, "utf8")); db.refs = Object.fromEntries(Object.entries(db.refs).map(([k, v]) => [k, new Set(v)]));
    // ★ 2026-11-13: 生年月日で引き当てを決めるので、birth_date の無い古い控えは使えない
    if (db.clients.length && !("birth_date" in db.clients[0])) throw new Error(`★ 控え ${CACHE} の clients に birth_date が無い (2026-11-13 より前の控え)。--refresh で取り直す`);
    console.log(`DB: 控えを使う ${CACHE} (取得 ${db.fetchedAt})。最新は --refresh`);
  } else {
    db = await loadDb(sb);
    db.fetchedAt = new Date().toISOString();
    if (CACHE) writeFileSync(CACHE, JSON.stringify({ ...db, refs: Object.fromEntries(Object.entries(db.refs).map(([k, v]) => [k, [...v]])) }));
  }
  const clientById = new Map(db.clients.map((c) => [c.id, c]));
  const ordersById = new Map(db.orders.map((o) => [o.id, o]));
  const eqByCode = new Map(); for (const e of db.equipment) if (!eqByCode.has(e.product_code)) eqByCode.set(e.product_code, e);
  const taisOfCode = (pc) => eqByCode.get(pc)?.tais_code || pc;
  const VAR = [..."靜髙﨑德巖邊邉齋齊濱澤櫻國瀨眞栁昜寬滿惠"].reduce((m, ch, i) => (m[ch] = "静高崎徳巌辺辺斎斉浜沢桜国瀬真柳易寛満恵"[i], m), {});
  const fold = (n) => nf(n).replace(/[(（].*?[)）]/g, "").replace(/./g, (ch) => VAR[ch] ?? ch);
  const byKey = new Map(), byNo = new Map(), byFold = new Map();
  const addK = (ins, insd, id) => { const k = `${nInsurer(ins)}|${nInsured(insd)}`; if (k.startsWith("|") || k.endsWith("|")) return; if (!byKey.has(k)) byKey.set(k, new Set()); byKey.get(k).add(id); };
  for (const c of db.clients) {
    addK(c.insurer_number, c.insured_number, c.id);
    if (c.deleted_at) continue;
    if (c.user_number) { const k = nfkc(c.user_number); if (!byNo.has(k)) byNo.set(k, []); byNo.get(k).push(c); }
    const f = fold(c.name); if (!byFold.has(f)) byFold.set(f, []); byFold.get(f).push(c);
  }
  for (const r of db.ins) addK(r.insurer_number, r.insured_number, r.client_id);
  // ケアサポの貸与明細 (置き換えの対象)
  const ksOrders = db.orders.filter((o) => o.office_id === OFFICE);
  const ksOrderIds = new Set(ksOrders.map((o) => o.id));
  const rentalItems = db.items.filter((it) => ksOrderIds.has(it.order_id) && ["rental_started", "terminated"].includes(it.status) && !it.cancelled_at);
  const itemsByClient = groupBy(rentalItems, (it) => ordersById.get(it.order_id)?.client_id ?? "");
  const narrowC = (cs, name) => {
    let x = [...new Map(cs.filter((c) => c && !c.deleted_at).map((c) => [c.id, c])).values()];
    if (x.length > 1) { const t = x.filter((c) => c.office_id === OFFICE); if (t.length) x = t; }
    if (x.length > 1) { const t = x.filter((c) => fold(c.name) === fold(name)); if (t.length) x = t; }
    if (x.length > 1) { const t = x.filter((c) => itemsByClient.has(c.id)); if (t.length) x = t; }
    return x;
  };
  const clientOfUser = new Map();
  for (const [userNo, rs] of groupBy(rows, (r) => r.userNo)) {
    const name = rs[rs.length - 1].name;
    let cs = narrowC([...(keysOf.get(userNo) ?? [])].flatMap((k) => [...(byKey.get(k) ?? [])]).map((id) => clientById.get(id)), name);
    let how = "保険者+被保番 (利用者マスタ経由)";
    if (cs.length === 0) { cs = narrowC([...(byNo.get(userNo) ?? []), ...(byNo.get(`HN-${userNo}`) ?? [])], name).filter((c) => fold(c.name) === fold(name)); how = "利用者番号+氏名"; }
    if (cs.length === 0) { cs = (byFold.get(fold(name)) ?? []).filter((c) => c.office_id === OFFICE); how = "氏名 (ケアサポ所属で一意)"; }
    if (cs.length === 0) { cs = (byFold.get(fold(name)) ?? []).filter((c) => ksOrders.some((o) => o.client_id === c.id)); how = "氏名 (ケアサポの注文がある人で一意)"; }
    if (cs.length === 0) { cs = byFold.get(fold(name)) ?? []; how = "氏名 (全利用者で一意・★ 利用登録の無い元利用者。要確認)"; }
    // ★ 2026-11-13: 氏名だけで引いた人・候補が複数の人は 生年月日で決める (一致が 1 人だけなら その人。違えば新規の候補、そろわなければ判断待ち)
    if (cs.length > 1 || (cs.length === 1 && how.startsWith("氏名"))) {
      const d = decideByBirth(cs, birthOf.get(userNo));
      if (d.verdict === "pick") { cs = [d.client]; how += " + 生年月日一致"; }
      else {
        R.users.add(d.verdict === "new" ? "★ 新規の候補 (氏名は当たるが生年月日が違う) → この利用者は何もしない" : "★ 判断が要る (生年月日で決められない) → この利用者は何もしない",
          { 利用者番号: userNo, 氏名: name, 行: rs.length, 引き方: how, 候補: cs.map((c) => `${c.name}/${c.user_number}/${c.birth_date ?? "-"}`).join(" "), 理由: d.reason });
        continue;
      }
    }
    if (cs.length === 1) {
      clientOfUser.set(userNo, cs[0]);
      R.users.add(how + (fold(cs[0].name) === fold(name) ? "" : " ★氏名の表記違い") + (cs[0].office_id === OFFICE ? "" : " ★clients.office_id がケアサポでない"), { 利用者番号: userNo, 氏名: name, DB: cs[0].name });
    } else R.users.add(`★ 引けない (候補 ${cs.length}) → この利用者は何もしない`, { 利用者番号: userNo, 氏名: name, 行: rs.length, 利用者マスタに保険: keysOf.has(userNo) });
  }

  // 用具の引き当て
  for (const r of rows) {
    r.full = fullUnitsOf(r);
    const res = match(r.src, r.kindRaw, r.item, r.full ?? r.units);
    Object.assign(r, { tais: res.tais, how: res.how, mrow: res.m, cands: res.cands });
    const haveTais = () => new Set((itemsByClient.get(clientOfUser.get(r.userNo)?.id) ?? []).map((it) => taisOfCode(it.product_code)));
    if (!r.tais && (r.how === "複数" || r.how === "類似が複数")) {
      // 候補の中で その利用者の DB の明細にある TAIS が 1 つだけなら それ
      const have = haveTais();
      const hit = r.cands.filter((t) => have.has(t));
      if (hit.length === 1) { r.tais = hit[0]; r.how = `${r.how} → DB の既存明細で特定`; r.mrow = masters.介護.rows.find((x) => x.tais === hit[0]) ?? null; }
    } else if (res.pre) {
      // ★ 2026-11-09: 「+単位+中止」で決まった用具は、中止で絞る前の候補に その利用者の DB の既存明細の TAIS が 1 つだけあれば それを優先
      //   (中止で絞ると 別の TAIS (後継品) が選ばれ、元の明細と別に insert して二重になった: 松本 ちよ 00167-000435/437・小山 いわ 00563-000019/021)
      const have = haveTais();
      const hit = [...new Set(res.pre.map((x) => x.tais).filter(Boolean))].filter((t) => have.has(t));
      if (hit.length === 1 && hit[0] !== r.tais) {
        r.tais = hit[0]; r.how = `${r.how} → 中止で絞る前の候補を DB の既存明細で特定`;
        r.mrow = res.pre.filter((x) => x.tais === hit[0]).sort((a, b) => Number(a.stop) - Number(b.stop))[0];
      }
    }
  }
  // ★ 2026-11-11 (user 承認): --disambiguate-by-billing — 略称・単位が同じで TAIS が複数ある用具 (サイズ違い等) は、
  //   提供票に TAIS が無いので決められない。ほのぼのの請求 (明細書明細付 KDS0031・処理R8-04〜) に その人・その提供月に出た
  //   TAIS のうち、同じ月の他の行で使っていないものが候補に 1 つだけなら それにする。値 (単位・日数・期間) は提供票のまま。
  //   使うのは「どの商品か」の手がかりだけ (請求の出力を入力に使う例外。user 2026-11-11)。
  // 請求 (KDS0031) が出ている提供月。前月 TAIS 引き継ぎは この集合に無い月 (= 月途中の最新月) だけで使う
  const kdsMonths = new Set();
  const billed = new Map(); // `${氏名}|${YYYY-MM}` → Map<TAIS, 件数>
  {
    const kdsFiles = [];
    for (const d of readdirSync(FUKUYOGU).filter((x) => /^\d{6}$/.test(x))) {
      const dir = join(FUKUYOGU, d, "ほのぼのから");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => /^KDS0031_.*\.csv$/i.test(x))) kdsFiles.push(join(dir, f));
    }
    for (const p of kdsFiles) {
      const K = readSjis(p);
      sourceFiles.push({ path: relPath(p), sha256: sha256(p), rows: K.rows.length,
        kind: DISAMBIGUATE_BY_BILLING ? "明細書明細付 (用具の特定と 提供月の有無の判定にだけ使う)" : "明細書明細付 (提供月の有無の判定にだけ使う)" });
      for (const x of K.rows) {
        if (x[61] !== "明細情報レコード") continue;
        kdsMonths.add(x[1].replace("/", "-"));
        if (!x[73]) continue;
        const k = `${nfkc(x[12]).replace(/\s/g, "")}|${x[1].replace("/", "-")}`;
        if (!billed.has(k)) billed.set(k, new Map());
        billed.get(k).set(x[73], (billed.get(k).get(x[73]) ?? 0) + 1);
      }
    }
    console.log(`請求 (KDS0031) のある提供月: ${[...kdsMonths].sort().join(", ") || "なし"}`);
  }
  if (DISAMBIGUATE_BY_BILLING) {
    const masterRowOf = (t) => Object.values(masters).filter(Boolean).flatMap((m) => m.rows).find((x) => x.tais === t) ?? null;
    for (const [, grp] of groupBy(rows, (r) => `${r.userNo}|${r.ym}`)) {
      const open = grp.filter((r) => !r.tais && (r.how === "複数" || r.how === "類似が複数") && r.cands?.length);
      if (!open.length) continue;
      const left = new Map(billed.get(`${nfkc(grp[0].name).replace(/\s/g, "")}|${grp[0].ym}`) ?? []);
      for (const r of grp) if (r.tais && left.get(r.tais)) left.set(r.tais, left.get(r.tais) - 1);
      for (const r of open) {
        const opts = r.cands.filter((t) => (left.get(t) ?? 0) > 0);
        const sameItem = open.filter((o) => o.item === r.item && !o.tais).length;
        const total = opts.reduce((s, t) => s + left.get(t), 0);
        if (opts.length === 1 || (opts.length > 1 && total === sameItem)) {
          const t = opts.sort()[0];
          r.tais = t; r.how = `${r.how} → 請求 (明細書明細付) の TAIS で特定`; r.mrow = masterRowOf(t);
          left.set(t, left.get(t) - 1);
        } else {
          // 警告は 前月 TAIS 引き継ぎの後に 最終的に未決のものだけ出す (下)
          r.billLeft = Object.fromEntries([...left].filter(([, n]) => n > 0));
        }
      }
    }
  }
  // ★ 2026-11-12: 請求 (KDS0031) がまだ無い月 (= 月途中の最新月) は、略称が同じで TAIS が複数ある用具を
  //   前月の同じ利用者・同じ用具名の行で決まった TAIS から引き継ぐ (続けて借りている台なので同じ商品)。
  //   これが無いと 11 月の行が「引き当て不可」→ 10 月の台が 10/31 で終了扱いになっていた (予ｳｪｰﾌﾞ型ｱｰﾑ ほか 14 台)。
  //   ★ 2026-11-12 (レビュー反映): 引き継ぐのは「月またぎで連結される組」だけ = 前月の行の最後の印が月末 かつ 当月の行が 1 日から。
  //     さらに 事業所 (src)・支払区分・満額の単位数 が同じこと。前月に終わったサイズ違いの台の TAIS を新しい台に振らない。
  //     請求 (KDS0031) のある月では引き継がない (警告だけ)。
  {
    const prevYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
    const byUserYm = groupBy(rows, (r) => `${r.userNo}|${r.ym}`);
    const masterRowOf2 = (t) => Object.values(masters).filter(Boolean).flatMap((m) => m.rows).find((x) => x.tais === t) ?? null;
    const linkable = (p, r) => p.item === r.item && p.tais && r.cands.includes(p.tais)
      && p.days[p.nd - 1] === 1 && r.days[0] === 1
      && p.src === r.src && payTypeOf(p) === payTypeOf(r) && r.full != null && p.full === r.full;
    for (const [k, grp] of byUserYm) {
      const open = grp.filter((r) => !r.tais && (r.how === "複数" || r.how === "類似が複数") && r.cands?.length);
      if (!open.length) continue;
      const [userNo, ym] = k.split("|");
      const prev = byUserYm.get(`${userNo}|${prevYm(ym)}`) ?? [];
      const hasKds = kdsMonths.has(ym);
      for (const r of open) {
        // 前月の 同じ用具名で TAIS が決まり 当月 1 日に続く行 (この月でまだ使っていない分) から候補に入るものを取る
        const used = grp.filter((x) => x.tais).map((x) => x.tais);
        const pool = prev.filter((p) => linkable(p, r)).map((p) => p.tais);
        for (const t of used) { const i = pool.indexOf(t); if (i >= 0) pool.splice(i, 1); }
        const opts = [...new Set(pool)];
        // 同じ用具名の未決の行が 前月の候補とちょうど同じ数なら 1 対 1 で振る (天野 るみ子 BPZ 2 台 = TAIS 2 種)
        const sameOpen = open.filter((o) => o.item === r.item && !o.tais).length;
        if (opts.length === 1 || (opts.length > 1 && pool.length === sameOpen)) {
          const t = [...pool].sort()[0];
          if (hasKds) { R.warn.add("前月の TAIS を引き継げるが 請求 (KDS0031) のある月なので引き継がない", { 氏名: r.name, 月: ym, 用具: r.item, 前月のTAIS: t }); continue; }
          r.tais = t; r.how = `${r.how} → 前月の同じ用具の TAIS を引き継ぎ`; r.mrow = masterRowOf2(t);
        }
      }
    }
    // ★ 2026-11-14 (誉田): 後ろの月 → 前の月 への引き継ぎ。手元の請求 (KDS0031) が 処理R8-09〜10 しか無い事業所では、
    //   9 月に請求の TAIS で決まった台でも 5〜8 月の行が「その人・その月の請求が無い」ため決まらず、
    //   9/1 開始の別の台に割れていた (開始日が実際より遅くなり 5〜8 月が抜ける)。
    //   翌月の同じ用具名の行で TAIS が決まり、当月の末日 → 翌月の 1 日に続く (同じ台) なら 同じ商品とみなす。
    //   条件は前月引き継ぎと同じ (事業所・支払区分・満額の単位数が同じ)。その人・その月の請求に TAIS が出ていれば引き継がない
    //   (請求で決められなかった = 請求と食い違う可能性があるため)。月を後ろから回して 何か月でも遡れる。
    if (DISAMBIGUATE_BY_BILLING) {
      const nextYm = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
      const linkBack = (n, r) => n.item === r.item && n.tais && r.cands.includes(n.tais)
        && r.days[r.nd - 1] === 1 && n.days[0] === 1
        && n.src === r.src && payTypeOf(n) === payTypeOf(r) && r.full != null && n.full === r.full;
      const yms = [...new Set(rows.map((r) => r.ym))].sort().reverse();
      for (const ym of yms) {
        for (const [k, grp] of byUserYm) {
          if (!k.endsWith(`|${ym}`)) continue;
          const open = grp.filter((r) => !r.tais && (r.how === "複数" || r.how === "類似が複数") && r.cands?.length);
          if (!open.length) continue;
          const userNo = k.split("|")[0];
          const billedHere = billed.get(`${nfkc(grp[0].name).replace(/\s/g, "")}|${ym}`);
          const next = byUserYm.get(`${userNo}|${nextYm(ym)}`) ?? [];
          for (const r of open) {
            if (billedHere && r.cands.some((t) => billedHere.has(t))) continue;
            const used = grp.filter((x) => x.tais).map((x) => x.tais);
            const pool = next.filter((n) => linkBack(n, r)).map((n) => n.tais);
            for (const t of used) { const i = pool.indexOf(t); if (i >= 0) pool.splice(i, 1); }
            const opts = [...new Set(pool)];
            const sameOpen = open.filter((o) => o.item === r.item && !o.tais).length;
            if (opts.length === 1 || (opts.length > 1 && pool.length === sameOpen)) {
              const t = [...pool].sort()[0];
              r.tais = t; r.how = `${r.how} → 翌月の同じ用具の TAIS を引き継ぎ (請求の出力で特定した台の続き)`; r.mrow = masterRowOf2(t);
            }
          }
        }
      }
    }
  }
  // 請求でも前月引き継ぎでも 最終的に決まらなかった行だけを警告に出す
  if (DISAMBIGUATE_BY_BILLING) for (const r of rows) {
    if (r.tais || !("billLeft" in r)) continue;
    R.warn.add("請求の TAIS でも用具を決められない", { 氏名: r.name, 月: r.ym, 用具: r.item, 候補: r.cands, 請求に残る: r.billLeft });
  }
  for (const r of rows) {
    // ★ 2026-11-09: 保険事業所の行で 概算単位 0 は 自費レンタル欄が空でも 0 円の付属 = 自費 (介護 0 円 172 件になった)
    r.zeroUnits = r.src !== "自費" && !r.jihiFlag && r.units === 0;
    r.payType = payTypeOf(r);
    if (r.payType === "自費" && r.src !== "自費" && r.units > 0) R.warn.add("自費レンタル=対象 だが 概算単位 > 0 (保険事業所の行)", { file: r.file, row: r.row, 氏名: r.name, 用具: r.item, 単位: r.units });
    r.grp = r.src === "自費" ? "自費事業所" : "保険事業所";
    // 支払区分もキーに入れる (同じ TAIS の有料の台と 0 円の付属を混ぜない)
    r.key = `${r.payType}|` + (r.tais ? `T:${r.tais}` : `N:${kindOf(r.kindRaw)}|${nf(r.item).replace(/^予/, "")}`);
    R.map.add(`${r.src}${r.payType === "自費" && r.src !== "自費" ? (r.zeroUnits ? "(0円付属・自費レンタル欄が空)" : "(0円付属)") : ""}: ${r.tais ? r.how : r.mrow ? `${r.how} (TAIS なし)` : r.src === "自費" ? `★ マスタに無い (${r.how}。名前で用具マスタに追加)` : `★ 引き当て不可 (${r.how})`}`, null);
  }

  // ── 区間 → 台 (連結) ─────────────────────────────────────────────────
  const segs = [];
  for (const r of rows) {
    const parts = [];
    for (let i = 0; i < r.nd; i++) if (r.days[i]) { let j = i; while (j + 1 < r.nd && r.days[j + 1]) j++; parts.push([i + 1, j + 1]); i = j; }
    if (!parts.length) { R.link.add("実績の印が 0 日の行 (飛ばす)", { file: r.file, row: r.row, 氏名: r.name, 用具: r.item }); continue; }
    parts.forEach(([a, b], k) => segs.push({ r, a, b, gapBefore: k > 0 }));
  }
  const chains = [];
  let tails = new Map(); // `${user}|${grp}|${key}` → [chain]
  const segsByMonth = groupBy(segs, (s) => s.r.ym);
  for (const ym of months) {
    const newTails = new Map();
    const inMonth = []; // この月に最後の区間がある chain
    const list = (segsByMonth.get(ym) ?? []).sort((x, y) => x.r.userNo.localeCompare(y.r.userNo) || x.r.key.localeCompare(y.r.key) || x.a - y.a || x.r.row - y.r.row);
    for (const s of list) {
      const k = `${s.r.userNo}|${s.r.grp}|${s.r.key}`;
      const prefer = (cands) => cands.find((ch) => ch.segs[ch.segs.length - 1].r.full === s.r.full) ?? cands[0];
      let ch = null, why = null;
      if (s.gapBefore) {
        const prev = inMonth.find((c) => c.segs[c.segs.length - 1].r === s.r);
        const gap = prev ? [`${ym}-${pad(prev.segs[prev.segs.length - 1].b + 1)}`, `${ym}-${pad(s.a - 1)}`] : null;
        if (PAUSE_MODE === "split" || !prev) { ch = { segs: [], gaps: [] }; chains.push(ch); if (prev) (prev.gaps ??= []).push(gap); }
        else ch = prev;
        if (gap) (ch.gaps ??= []).push(gap);
        why = "休止";
        R.link.add(`月内の休止 (同じ行に 0 が挟まる) → ${PAUSE_MODE === "split" ? "2 明細" : "1 明細のまま notes に休止期間"}`, { 氏名: s.r.name, 用具: s.r.item, 月: ym, 休止: gap ? gap.join("〜") : null });
      } else if (s.a === 1 && (tails.get(k) ?? []).length) {
        const t = tails.get(k); const n = t.length; const c = prefer(t); t.splice(t.indexOf(c), 1); ch = c; why = "月またぎ";
        if (n > 1) R.link.add(`月またぎで候補が 2 台以上 (${c.segs[c.segs.length - 1].r.full === s.r.full ? "単位数で決めた" : "行の順で決めた"})`, null);
      } else if (s.a > 1) {
        const cands = inMonth.filter((c) => { const l = c.segs[c.segs.length - 1]; return l.r.ym === ym && l.r !== s.r && l.b === s.a - 1 && `${l.r.userNo}|${l.r.grp}|${l.r.key}` === k; });
        if (cands.length) { ch = prefer(cands); why = "同月の行の切替"; R.link.add("同じ月の中で別の行に続く (保険者・介護↔予防 の切替等)", { 氏名: s.r.name, 用具: s.r.item, 月: ym, 日: s.a, 前の行: ch.segs[ch.segs.length - 1].r.office, 次の行: s.r.office }); }
      }
      if (!ch) { ch = { segs: [] }; chains.push(ch); }
      ch.segs.push(s);
      if (!inMonth.includes(ch)) inMonth.push(ch);
      if (s.b === s.r.nd) { if (!newTails.has(k)) newTails.set(k, []); newTails.get(k).push(ch); }
      void why;
    }
    // 月末で切れて 翌月 1 日に続かなかった tail は そのまま終わり
    tails = newTails;
  }
  // 台 → 明細の形
  const planned = [];
  for (const ch of chains) {
    const s0 = ch.segs[0], s1 = ch.segs[ch.segs.length - 1], r1 = s1.r;
    const beforeApr = s0.r.ym === FIRST && s0.a === 1;
    const rawEnd = `${r1.ym}-${pad(s1.b)}`;
    // as-of 当日以降の終了 (最新月の予定) は 確定していないので 継続扱い (提供票は予定の写しなので as-of 当日の終了も予定)
    const futureEnd = AS_OF != null && r1.ym === LAST && !(s1.b === r1.nd) && rawEnd >= AS_OF;
    const open = (r1.ym === LAST && s1.b === r1.nd) || futureEnd;
    const start = beforeApr ? MIGRATION_START : `${s0.r.ym}-${pad(s0.a)}`;
    const end = open ? null : rawEnd;
    if (futureEnd) R.warn.add(`--as-of ${AS_OF} 当日以降の終了予定 → 継続扱い (確定版の提供票で回し直すと終了になる)`, { 氏名: r1.name, 用具: r1.item, 終了予定: rawEnd });
    if (AS_OF != null && start > AS_OF) { R.warn.add(`--as-of ${AS_OF} より後の開始予定 → 入れない`, { 氏名: r1.name, 用具: r1.item, 開始予定: start }); continue; }
    const fullR = [...ch.segs].reverse().find((s) => s.r.full != null)?.r;
    const full = fullR?.full ?? r1.mrow?.units ?? null;
    const notes = [MARK];
    if (beforeApr) notes.push(BEFORE_APR);
    // ★ 2026-11-14: --disambiguate-by-billing で 品目を ほのぼのの請求の出力 (KDS0031) から決めた台には印を付ける。
    //   この台は KDS0031 との答え合わせで当然一致するので、一致率の分母から外せるようにする (循環の印)
    if (ch.segs.some((s) => String(s.r.how ?? "").includes("請求 (明細書明細付) の TAIS で特定"))) notes.push(BILLED_TAIS_MARK);
    planned.push({ ch, userNo: r1.userNo, name: r1.name, grp: r1.grp, key: r1.key, tais: r1.tais, payType: r1.payType, kindRaw: r1.kindRaw, item: r1.item, mrow: r1.mrow, how: r1.how,
      start, end, open, beforeApr, full, segs: ch.segs.map((s) => ({ ym: s.r.ym, a: s.a, b: s.b, units: s.r.units, hiwari: s.r.hiwari, file: s.r.file, row: s.r.row })), notes });
  }
  // 休止 (貸与しなかった日): notes に [休止 YYYY-MM-DD〜YYYY-MM-DD]
  //   --as-of: as-of より後の休止は予定なので書かない。as-of をまたぐ休止は as-of までに切る
  for (const p of planned) for (const [a, b] of p.ch.gaps ?? []) {
    if (AS_OF != null && a > AS_OF) continue;
    p.notes.push(`[休止 ${a}〜${AS_OF != null && b > AS_OF ? AS_OF : b}]`);
  }
  console.log(`\n提供票 ${FIRST}〜${LAST}: 実績 ${rows.length} 行 → 台 ${planned.length} (継続中 ${planned.filter((p) => p.open).length} / 終了 ${planned.filter((p) => !p.open).length} / ${BEFORE_APR.slice(1, -1)} ${planned.filter((p) => p.beforeApr).length})`);
  console.log(`  うち 品目を請求の出力 (KDS0031) で決めた台 ${planned.filter((p) => p.notes.includes(BILLED_TAIS_MARK)).length} (notes に ${BILLED_TAIS_MARK}。KDS0031 との答え合わせでは当然一致する = 一致率の分母から外して読む)`);
  { // 開始月の分布 (仮置きの「○/1以前から」は別に数える。2026-11-13 誉田の受入れで追加)
    const by = new Map();
    for (const p of planned) { const k = p.beforeApr ? `${BEFORE_APR.slice(1, -1)}` : p.start.slice(0, 7); by.set(k, (by.get(k) ?? 0) + 1); }
    console.log(`  開始月の分布: ${[...by].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([k, v]) => `${k} ${v}`).join(" / ")}`);
  }

  // ── 用具の product_code と equipment_master の追加 ─────────────────────
  const ops = [];
  const eqByTais = new Map();
  for (const e of db.equipment) if (e.tais_code && !eqByTais.has(e.tais_code)) eqByTais.set(e.tais_code, e);
  let eqMax = Math.max(0, ...db.equipment.map((e) => /^EQ-(\d+)$/.exec(e.product_code)?.[1]).filter(Boolean).map(Number));
  const eqByName = new Map(db.equipment.filter((e) => !e.tais_code).map((e) => [nf(e.name), e]));
  const newEq = new Map(); // key → product_code
  const productOf = (p) => {
    if (p.tais) {
      const e = eqByCode.get(p.tais) ?? eqByTais.get(p.tais);
      if (e) return e.product_code;
      // ★ 2026-11-09: キーは TAIS (台の p.key だと同じ TAIS を台の数だけ insert しようとして UNIQUE で落ちた)
      const tk = `tais:${p.tais}`;
      if (!newEq.has(tk)) {
        newEq.set(tk, p.tais);
        const m = p.mrow;
        ops.push({ table: "equipment_master", action: "insert", id: newId("eq"), why: "用具マスタに無い TAIS", src: { key: `TAIS:${p.tais}`, ref: { 商品名: m?.name ?? p.item, 種目: m?.cat ?? kindOf(p.kindRaw), 単位: p.full } },
          row: { tenant_id: TENANT, product_code: p.tais, tais_code: p.tais, name: m?.name || p.item, category: m?.cat || kindOf(p.kindRaw), kind: "single", rental_price: p.full != null ? p.full * 10 : null } });
      }
      return newEq.get(tk);
    }
    if (p.payType === "自費") {
      const nm = nfkc(p.mrow?.name || p.item);
      const e = eqByName.get(nf(nm));
      if (e) return e.product_code;
      const nk = `name:${nf(nm)}`; // 自費 (TAIS 無し) は名前で 1 品
      if (!newEq.has(nk)) {
        const code = `EQ-${String(++eqMax).padStart(6, "0")}`;
        newEq.set(nk, code);
        ops.push({ table: "equipment_master", action: "insert", id: newId("eq"), why: "自費の用具 (TAIS 無し) を用具マスタに追加", src: { key: `自費:${nm}`, ref: { 種目: kindOf(p.kindRaw), 単位: p.full, 自費マスタ: !!masters.自費 } },
          row: { tenant_id: TENANT, product_code: code, tais_code: null, name: nm, category: kindOf(p.kindRaw), kind: "single", rental_price: p.full != null ? p.full * 10 : null } });
      }
      return newEq.get(nk);
    }
    return null;
  };

  // ── 利用者ごとに DB と対応付け ──────────────────────────────────────────
  const plannedByClient = new Map();
  for (const p of planned) {
    const c = clientOfUser.get(p.userNo);
    if (!c) { R.plan.add("★ 利用者が引けない台 (何もしない)", { 利用者番号: p.userNo, 氏名: p.name, 用具: p.item }); continue; }
    p.code = productOf(p);
    if (!p.code) { R.plan.add("★ 用具が引けない台 (入れない。その利用者の DB だけ明細は消さない)", { 氏名: p.name, 用具: p.item, 種目: p.kindRaw, 引当: p.how, 候補: p.cands }); continue; }
    p.cid = c.id;
    if (!plannedByClient.has(c.id)) plannedByClient.set(c.id, []);
    plannedByClient.get(c.id).push(p);
  }
  const holdClients = new Set(planned.filter((p) => p.cid === undefined && clientOfUser.get(p.userNo)).map((p) => clientOfUser.get(p.userNo).id));
  // 提供票で引けなかった利用者と 氏名が同じ DB の利用者も 消さない (表記ゆれで別人扱いになっているかもしれない)
  const unresolvedNames = new Set([...groupBy(rows, (r) => r.userNo)].filter(([u]) => !clientOfUser.has(u)).map(([, rs]) => fold(rs[0].name)));
  for (const c of db.clients) if (unresolvedNames.has(fold(c.name))) holdClients.add(c.id);
  // 同じ (利用者, 用具, 支払, 開始, 終了, 単価, notes) の台は 1 明細・数量 n にまとめる
  const want = [];
  for (const [cid, ps] of plannedByClient) {
    for (const [, g] of groupBy(ps, (p) => [p.code, p.payType, p.start, p.end, p.full, p.notes.join(" ")].join("|"))) {
      const p = g[0];
      want.push({ cid, code: p.code, tais: p.tais, payType: p.payType, start: p.start, end: p.end, open: p.open, qty: g.length,
        price: p.payType === "自費" ? (p.full ?? 0) * 10 : (p.full != null ? p.full * 10 : null), notes: p.notes.join(" "), name: p.name, item: p.item, how: p.how, segs: g.flatMap((x) => x.segs) });
    }
  }
  const ymdOK = (s) => s ? s.slice(0, 10) : null;
  const overlap = (a, w) => { const s = ymdOK(a.rental_start_date) ?? "0000", e = ymdOK(a.rental_end_date) ?? "9999"; return s <= (w.end ?? "9999") && e >= w.start; };
  const orderFor = new Map();
  const insItems = [], updItems = [], delItems = [], keepItems = [];
  const touchedClients = new Set([...plannedByClient.keys()]);
  // 提供票に 1 台も無いが DB に当期 (4/1 以降) の貸与がある利用者も対象 (DB だけ)
  for (const [cid, its] of itemsByClient) if (cid && its.some((it) => (ymdOK(it.rental_end_date) ?? "9999") >= MIGRATION_START)) touchedClients.add(cid);
  for (const cid of touchedClients) {
    const ws = (want.filter((w) => w.cid === cid));
    const ds = [...(itemsByClient.get(cid) ?? [])];
    const used = new Set();
    // 対応付け: 同じ用具 (TAIS / product_code) で ① 日付が同じ ② 重なる ③ 残り
    const sameEq = (it, w) => it.product_code === w.code || (w.tais && taisOfCode(it.product_code) === w.tais);
    for (const pass of [0, 1, 2]) for (const w of ws) {
      if (w.dbItem) continue;
      const cand = ds.filter((it) => !used.has(it.id) && sameEq(it, w) && (pass === 0 ? ymdOK(it.rental_start_date) === w.start && ymdOK(it.rental_end_date) === w.end : pass === 1 ? overlap(it, w) : true));
      if (cand.length) { w.dbItem = cand[0]; used.add(cand[0].id); }
    }
    for (const w of ws) {
      const status = w.open ? "rental_started" : "terminated";
      if (w.dbItem) {
        const it = w.dbItem, patch = {};
        if (ymdOK(it.rental_start_date) !== w.start) patch.rental_start_date = w.start;
        if (ymdOK(it.rental_end_date) !== w.end) patch.rental_end_date = w.end;
        if (it.status !== status) patch.status = status;
        if ((it.quantity ?? 1) !== w.qty) patch.quantity = w.qty;
        if ((it.payment_type ?? ordersById.get(it.order_id)?.payment_type ?? "介護") !== w.payType) patch.payment_type = w.payType;
        if (w.payType === "自費" && it.rental_price !== w.price) patch.rental_price = w.price;
        if (w.payType === "介護" && it.rental_price == null && w.price != null) patch.rental_price = w.price;
        const extra = w.notes.split(" ").filter((t) => !(it.notes ?? "").includes(t));
        if (extra.length && Object.keys(patch).length) patch.notes = [it.notes, ...extra].filter(Boolean).join(" ");
        const kinds = Object.keys(patch).filter((k) => k !== "notes");
        if (!kinds.length) { R.db.add("一致 (変更なし)", null); continue; }
        const label = kinds.some((k) => ["rental_start_date", "rental_end_date", "status"].includes(k)) ? "日付・状態を直す" : kinds.includes("quantity") ? "数量を直す" : "支払区分・単価を直す";
        R.db.add(`update: ${label}`, { 氏名: w.name, 用具: w.item, 前: { 開始: ymdOK(it.rental_start_date), 終了: ymdOK(it.rental_end_date), 状態: it.status, 数量: it.quantity }, 後: { 開始: w.start, 終了: w.end, 状態: status, 数量: w.qty, 支払: w.payType } });
        updItems.push(it.id);
        ops.push({ table: "order_items", action: "update", id: it.id, cid, why: label, patch, src: { key: `提供票|${w.name}|${w.code}`, ref: { 区間: w.segs.slice(0, 12) } } });
      } else {
        let oid = orderFor.get(cid);
        if (!oid) {
          const os = ksOrders.filter((o) => o.client_id === cid && o.status !== "cancelled").sort((a, b) => (itemsByClient.get(cid) ?? []).filter((i) => i.order_id === b.id).length - (itemsByClient.get(cid) ?? []).filter((i) => i.order_id === a.id).length);
          if (os.length) oid = os[0].id;
          else {
            oid = newId("order");
            ops.push({ table: "orders", action: "insert", id: oid, cid, why: "利用者にケアサポの注文が無い (貸与の器)", src: { key: `提供票|${w.name}` },
              row: { tenant_id: TENANT, client_id: cid, office_id: OFFICE, payment_type: ws.every((x) => x.payType === "自費") ? "自費" : "介護", status: "completed", ordered_at: w.start, delivery_date: w.start, delivery_type: "直納", attendance_required: false, attendee_ids: [], email_sent_count: 0, merged_from_order_ids: [], notes: MARK } });
            R.db.add("insert: 注文 (器) を作る", { 氏名: w.name });
          }
          orderFor.set(cid, oid);
        }
        R.db.add(`insert: 提供票だけの台 (${w.payType}${w.payType === "自費" && w.price === 0 ? "・0円の付属" : ""})`, { 氏名: w.name, 用具: w.item, 開始: w.start, 終了: w.end, 数量: w.qty });
        insItems.push(w);
        ops.push({ table: "order_items", action: "insert", id: newId("item"), cid, why: "提供票だけの台", src: { key: `提供票|${w.name}|${w.code}`, ref: { 区間: w.segs.slice(0, 12), 引当: w.how } },
          row: { tenant_id: TENANT, order_id: oid, product_code: w.code, quantity: w.qty, status: w.open ? "rental_started" : "terminated", payment_type: w.payType,
            rental_start_date: w.start, rental_end_date: w.end, cancelled_at: null, rental_price: w.price, notes: w.notes } });
      }
    }
    for (const it of ds.filter((x) => !used.has(x.id))) {
      const c = clientById.get(cid);
      const ex = { 氏名: c?.name, 番号: c?.user_number, 用具: it.product_code, 開始: ymdOK(it.rental_start_date), 終了: ymdOK(it.rental_end_date), 状態: it.status, 今朝の同期: (it.notes ?? "").includes("[honobono-sync-") };
      if ((ymdOK(it.rental_end_date) ?? "9999") < MIGRATION_START) { R.db.add(`DB だけ・${MIGRATION_START === "2026-04-01" ? "4/1" : MIGRATION_START} より前に終了 (触らない)`, ex); keepItems.push(it.id); continue; }
      const ref = REF_TABLES.filter(([tb]) => db.refs[tb]?.has(it.id)).map(([tb]) => tb);
      if (ref.length) { R.db.add(`★ DB だけ・参照あり (${ref.join(",")}) → 消さない`, ex); keepItems.push(it.id); continue; }
      if (holdClients.has(cid)) { R.db.add("★ DB だけ・その利用者に引き当て不可の行がある → 消さない", ex); keepItems.push(it.id); continue; }
      R.db.add(`delete: DB だけ (${plannedByClient.has(cid) ? "同じ人に提供票あり" : "提供票に居ない人"}・${ex.今朝の同期 ? "今朝の同期で入れた" : "移行/手入力"})${REMOVE_DB_ONLY ? "" : " ★ --remove-db-only が無いので 残す"}`, ex);
      if (REMOVE_DB_ONLY) { delItems.push(it.id); ops.push({ table: "order_items", action: "delete", id: it.id, cid, why: "提供票に無い DB の明細", src: { key: `DB|${c?.name}|${it.product_code}` } }); }
      else keepItems.push(it.id);
    }
  }

  // ── 報告 ─────────────────────────────────────────────────────────────
  console.log("\n== 用具の引き当て (実績行)"); for (const [k, v] of R.map.m) console.log(`  ${String(v.length).padStart(5)}  ${k}`);
  console.log("\n== 利用者の引き当て (提供票の利用者)"); R.users.print(2);
  console.log("\n== 連結"); R.link.print(2);
  console.log("\n== 計画に入れない台"); R.plan.print(3);
  console.log("\n== DB との置き換え (明細単位)"); R.db.print(2);
  if (R.warn.m.size) { console.log("\n== 注意"); R.warn.print(3); }
  console.log(`\n書込み見込み: ${JSON.stringify(countBy(ops, (o) => `${o.table} ${o.action}`))}`);

  // ── 答え合わせ: 置き換え後の DB で 4〜9 月の請求を組み立て KDS0031 と比べる (★ KDS は照合だけ) ──────
  const after = [];
  const delSet = new Set(delItems), updMap = new Map(ops.filter((o) => o.table === "order_items" && o.action === "update").map((o) => [o.id, o.patch]));
  for (const it of db.items) {
    if (delSet.has(it.id)) continue;
    const o = ordersById.get(it.order_id);
    after.push({ ...it, ...(updMap.get(it.id) ?? {}), _cid: o?.client_id, _office: o?.office_id, _pay: (updMap.get(it.id)?.payment_type ?? it.payment_type) ?? o?.payment_type ?? "介護" });
  }
  for (const o of ops.filter((x) => x.table === "order_items" && x.action === "insert")) after.push({ ...o.row, id: o.id, _cid: o.cid, _office: OFFICE, _pay: o.row.payment_type });
  const eqAfter = new Map(eqByCode); for (const o of ops.filter((x) => x.table === "equipment_master")) eqAfter.set(o.row.product_code, o.row);
  const hospBy = groupBy(db.hosp, (h) => h.client_id);
  const kdsByMonth = new Map();
  for (const ym of months) {
    const dir = join(FUKUYOGU, ym.replace("-", ""), "ほのぼのから");
    let files = []; try { files = readdirSync(dir).filter((f) => /^KDS0031.*\.csv$/i.test(f)); } catch { /* その月の KDS が無い */ }
    for (const f of files) for (const r of readKds0031(join(dir, f)).rows) {
      const m = nfkc(r[C.SVC_MONTH]).replace("/", "-").slice(0, 7);
      if (!kdsByMonth.has(m)) kdsByMonth.set(m, []);
      kdsByMonth.get(m).push(r);
    }
  }
  const checks = [];
  for (const ym of months) {
    const kr = kdsByMonth.get(ym);
    if (!kr) { console.log(`\n[答え合わせ ${ym}] KDS0031 が無い → 飛ばす`); continue; }
    const nd = daysIn(ym), ms = `${ym}-01`, me = `${ym}-${pad(nd)}`;
    // KDS: (保険者,被保番) → DB client → TAIS ごとの 単位 (行の多重集合)
    const kUser = new Map(); let kNo = 0;
    for (const r of kr) {
      const ids = narrowC([...(byKey.get(`${nInsurer(r[C.INSURER])}|${nInsured(r[C.INSURED])}`) ?? [])].map((id) => clientById.get(id)), nfkc(r[C.NAME]));
      if (ids.length !== 1) { kNo++; continue; }
      const cid = ids[0].id;
      if (!kUser.has(cid)) kUser.set(cid, []);
      kUser.get(cid).push({ tais: nfkc(r[C.TAIS]), units: Number(nfkc(r[C.SVC_UNITS]) || 0) });
    }
    // 当方 (BillingTab の getUnits と同じ: 単価 = 価格履歴 → 用具マスタ、半月按分、入院日を除く、単位上書き)
    const ovr = new Map(db.overrides.filter((o) => o.month === ym).map((o) => [o.order_item_id, o.units_override]));
    const mine = new Map();
    for (const it of after) {
      if (!it._cid || it._office !== OFFICE || it._pay !== "介護" || !it.rental_start_date) continue;
      if (!["rental_started", "terminated"].includes(it.status) || it.cancelled_at) continue;
      const s = ymdOK(it.rental_start_date), e = ymdOK(it.rental_end_date) ?? me;
      if (s > me || e < ms) continue;
      const eq = eqAfter.get(it.product_code);
      let u;
      if (ovr.has(it.id)) u = ovr.get(it.id);
      else {
        const price = getPriceForMonth(db.priceHist, it.product_code, ym, OFFICE) ?? eq?.rental_price ?? 0; // 対象事業所の行 → 共通 → マスタ
        const base = price ? Math.round(price / 10) : 0;
        let f = false, sh = false;
        for (let d = 1; d <= nd; d++) {
          const ds = `${ym}-${pad(d)}`;
          if (ds < s || ds > e) continue;
          const inH = (hospBy.get(it._cid) ?? []).some((h) => ds >= h.admission_date && ds <= (h.discharge_date ?? me));
          if (!inH) { if (d <= 15) f = true; else sh = true; }
        }
        u = halfMonthUnits(base, f, sh);
      }
      if (u <= 0) continue;
      if (!mine.has(it._cid)) mine.set(it._cid, []);
      for (let q = 0; q < (it.quantity ?? 1); q++) mine.get(it._cid).push({ tais: eq?.tais_code || it.product_code, units: u });
    }
    const res = { ym, 例: [], 単位差_当方だけの利用者: 0, 単位差_KDSだけの利用者: 0, 単位差_両方の利用者: 0, 利用者_両方: 0, 利用者_全行一致: 0, 利用者_単位合計一致: 0, 利用者_KDSだけ: 0, 利用者_当方だけ: 0, 行_KDS: 0, 行_一致: 0, KDS_利用者を引けない行: kNo, 単位_KDS: 0, 単位_当方: 0, 単位_差の絶対値: 0 };
    for (const cid of new Set([...kUser.keys(), ...mine.keys()])) {
      const a = kUser.get(cid) ?? [], b = [...(mine.get(cid) ?? [])];
      const ua = a.reduce((x, y) => x + y.units, 0), ub = b.reduce((x, y) => x + y.units, 0);
      res.単位_KDS += ua; res.単位_当方 += ub; res.単位_差の絶対値 += Math.abs(ua - ub); res.行_KDS += a.length;
      const nm = clientById.get(cid)?.name;
      if (!a.length) { res.利用者_当方だけ++; res.単位差_当方だけの利用者 += ub; res.例.push({ 型: "当方だけ", 氏名: nm, 当方: b }); continue; }
      if (!b.length) { res.利用者_KDSだけ++; res.単位差_KDSだけの利用者 += ua; res.例.push({ 型: "KDSだけ", 氏名: nm, KDS: a }); continue; }
      res.単位差_両方の利用者 += Math.abs(ua - ub);
      res.利用者_両方++;
      let hit = 0;
      for (const x of a) { const j = b.findIndex((y) => y.tais === x.tais && y.units === x.units); if (j >= 0) { b.splice(j, 1); hit++; } }
      res.行_一致 += hit;
      if (hit === a.length && !b.length) res.利用者_全行一致++;
      else res.例.push({ 型: "両方・差あり", 氏名: nm, KDS: a, 当方: mine.get(cid), 当方の余り: b });
      if (ua === ub) res.利用者_単位合計一致++;
    }
    checks.push(res);
  }
  console.log("\n== 答え合わせ (置き換え後の DB で組んだ請求 × KDS0031。KDS は照合だけ・入力は提供票+利用者/保険+マスタ)");
  console.log("   ★ 単価は今の用具マスタ・価格履歴 (今朝の同期で KDS の単位に揃えた値を含む)。日付・用具・台数は提供票から");
  for (const r of checks) {
    const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
    console.log(`  ${r.ym}  利用者 全行一致 ${r.利用者_全行一致}/${r.利用者_両方} (${pct(r.利用者_全行一致, r.利用者_両方)}) / 単位合計一致 ${pct(r.利用者_単位合計一致, r.利用者_両方)} / 行一致 ${r.行_一致}/${r.行_KDS} (${pct(r.行_一致, r.行_KDS)}) / KDSだけ ${r.利用者_KDSだけ} 名 / 当方だけ ${r.利用者_当方だけ} 名 / 単位 KDS ${r.単位_KDS} 当方 ${r.単位_当方} (差の絶対値 ${r.単位_差の絶対値} = 両方の人 ${r.単位差_両方の利用者} + 当方だけの人 ${r.単位差_当方だけの利用者} + KDSだけの人 ${r.単位差_KDSだけの利用者}) / KDS の利用者を引けない行 ${r.KDS_利用者を引けない行}`);
  }
  writeFileSync(join(OUT_DIR, "teikyo_rebuild.json"), JSON.stringify({ months, sourceFiles, report: Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.toJSON()])), checks, ops: ops.map((o) => ({ ...o })) }, null, 1));
  console.log(`\n詳細 JSON: ${join(OUT_DIR, "teikyo_rebuild.json")}`);

  if (!EXECUTE) { console.log("\nDRY RUN — DB は書き換えていない。--execute で本番 (★ user 承認後)"); return; }
  await execute(sb, ops, sourceFiles);
}

// ── 本番書込み (sync_fukuyogu_from_honobono.mjs と同じ作法) ───────────────────
const DERIVED = [["doc_tasks", "trigger_ref_id"], ["care_plan_elements", "ref_id"]];
async function execute(sb, ops, sourceFiles) {
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) { console.error(`★ 出どころ記録の表 ${t} が無い (${error.message}) → --execute しない`); process.exit(2); }
  }
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: sourceFiles, script: SCRIPT_REL, args: argv.join(" "), step: STEP,
    notes: `提供票から貸与を組み直す / --remove-db-only ${REMOVE_DB_ONLY ? "あり" : "なし"}`,
  });
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => { const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH); if (error) console.error(`batch を failed にできない: ${error.message}`); throw new Error(msg); };
  const record = async (recs) => { for (const c of chunks(recs, 100)) { const { error } = await sb.from("data_import_rows").insert(c); if (error) await fail(`data_import_rows: ${error.message}`); } };
  const srcRef = (o) => ({ why: o.why, ...(o.src?.ref ?? {}) });
  const idMap = new Map();
  const fix = (v) => (isNew(v) ? idMap.get(v) ?? null : v);
  // 変更前の行
  const beforeRows = new Map();
  for (const [table, us] of groupBy(ops.filter((o) => o.action !== "insert"), (o) => o.table)) {
    const got = await selectIn(sb, table, "*", "id", us.map((o) => o.id));
    if (got.length !== new Set(us.map((o) => o.id)).size) await fail(`${table}: 変更前の行が ${us.length} 件のはずが ${got.length} 件`);
    for (const r of got) beforeRows.set(`${table}:${r.id}`, r);
  }
  const bpath = join(HERE, `_backup_teikyo_rebuild_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(bpath, JSON.stringify({ batch: BATCH, at: new Date().toISOString(), before: Object.fromEntries(beforeRows) }, null, 2));
  console.log(`バックアップ ${bpath}`);
  const cids = [...new Set(ops.map((o) => o.cid).filter((x) => x && !isNew(x)))];
  const beforeDerived = {};
  for (const [t] of DERIVED) beforeDerived[t] = new Set((await selectIn(sb, t, "id", "client_id", cids, (q) => q.eq("tenant_id", TENANT))).map((r) => r.id));
  const touched = new Set();
  const doCleanup = async () => {
    for (const [t, refCol] of DERIVED) {
      const rowsNow = await selectIn(sb, t, "*", "client_id", cids, (q) => q.eq("tenant_id", TENANT));
      const fresh = rowsNow.filter((r) => !beforeDerived[t].has(r.id));
      const mine = fresh.filter((r) => touched.has(r[refCol]));
      for (const c of chunks(mine.map((r) => r.id), 150)) {
        const { error, count } = await sb.from(t).delete({ count: "exact" }).in("id", c);
        if (error || count !== c.length) throw new Error(`掃除 ${t}: ${error?.message ?? `削除件数 ${count} ≠ ${c.length}`}`);
      }
      await record(mine.map((r) => ({ batch_id: BATCH, tenant_id: TENANT, table_name: t, row_id: r.id, op: "delete", source_key: "cleanup:trigger", source_ref: { cleanup: true, 理由: "提供票の組み直しで trigger が作った行" }, before: r, after: null })));
      console.log(`  掃除 ${t}: 消した ${mine.length} / 参照先が違うので消さなかった新しい行 ${fresh.length - mine.length}`);
    }
  };
  try {
    for (const table of ["equipment_master", "orders", "order_items"]) {
      let nu = 0, nd = 0, ni = 0;
      for (const o of ops.filter((x) => x.table === table && x.action === "update")) {
        const { error, count } = await sb.from(table).update(o.patch, { count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
        if (error) await fail(`update ${table} ${o.id}: ${error.message}`);
        if (count !== 1) await fail(`update ${table} ${o.id}: 更新件数 ${count}`);
        await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: o.id, op: "update", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${table}:${o.id}`), after: o.patch }]);
        touched.add(o.id); const oid = beforeRows.get(`${table}:${o.id}`)?.order_id; if (oid) touched.add(oid);
        nu++;
      }
      for (const o of ops.filter((x) => x.table === table && x.action === "delete")) {
        const { error, count } = await sb.from(table).delete({ count: "exact" }).eq("id", o.id).eq("tenant_id", TENANT);
        if (error) await fail(`delete ${table} ${o.id}: ${error.message}`);
        if (count !== 1) await fail(`delete ${table} ${o.id}: 削除件数 ${count}`);
        await record([{ batch_id: BATCH, tenant_id: TENANT, table_name: table, row_id: o.id, op: "delete", source_key: o.src?.key ?? null, source_ref: srcRef(o), before: beforeRows.get(`${table}:${o.id}`), after: null }]);
        const oid = beforeRows.get(`${table}:${o.id}`)?.order_id; if (oid) touched.add(oid);
        nd++;
      }
      const ins = ops.filter((x) => x.table === table && x.action === "insert").map((o) => ({ o, row: Object.fromEntries(Object.entries(o.row).map(([k, v]) => [k, ["client_id", "order_id"].includes(k) ? fix(v) : v])) }));
      for (const x of ins) if (("order_id" in x.row && !x.row.order_id) || ("client_id" in x.row && !x.row.client_id)) await fail(`${table}: 参照先がまだ無い`);
      const batches = [];
      for (const x of ins) { const k = Object.keys(x.row).sort().join(","); const last = batches[batches.length - 1]; if (last && last.k === k && last.rows.length < 100) last.rows.push(x); else batches.push({ k, rows: [x] }); }
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
    console.error(`★ 途中で失敗: ${e.message} — ここまでに trigger が作った行の掃除だけは行う`);
    try { await doCleanup(); } catch (e2) { console.error(`★ 掃除も失敗: ${e2.message} → --cleanup-batch ${BATCH}`); }
    throw e;
  }
  try { await doCleanup(); } catch (e) { await fail(`掃除: ${e.message} (--cleanup-batch ${BATCH} で後から掃除できる)`); }
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  console.log(`\n完了。batch ${BATCH}。取り消しは --revert ${BATCH}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
