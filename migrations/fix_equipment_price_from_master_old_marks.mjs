/**
 * ほのぼの福祉用具の用具マスタで「●付き = 旧価格」の行がある TAIS について、当方の価格を現価格 (●無し) に合わせる。
 *
 *   node migrations/fix_equipment_price_from_master_old_marks.mjs                       # DRY RUN
 *   node migrations/fix_equipment_price_from_master_old_marks.mjs --execute
 *   node migrations/fix_equipment_price_from_master_old_marks.mjs --revert <batch_id> [--execute]
 *
 * 背景 (2026-11-11 user): ほのぼのは同じ商品で価格の履歴を持てないので、旧価格の商品を「●」付きで残し、
 *   新価格の商品を別に作る。切り替えは その商品を借りている全員が同時。当方は 1 商品 + 価格履歴 (equipment_price_history)。
 *   2026-10 の突合で 00980-000496 (1000→980)・00170-001944 (1250→1220) が 10 月から全員新価格なのに、当方は旧価格のままだった。
 * 対象: FYGMST01 で ●行と ●無し行 (現価格 1 種類) がある TAIS のうち、equipment_master (product_code か tais_code が一致) の
 *   2026-10 時点の価格が現価格と違う行。
 * 直し方 (いつ切り替わったかは 請求の答え合わせ KDS0031 (処理R8-04〜10) で決める。値そのものは用具マスタ = 入力側):
 *   A. 旧価格で請求した月があり、その後 現価格で請求した月がある → 価格履歴を「現価格で請求した最初の月の 1 日」付けで足す
 *   B. 旧価格で請求した月が無い (最初から現価格・または請求なし) → equipment_master.rental_price を現価格に
 *   C. 旧価格の請求しか無い (まだ切り替わっていない?) → 直さず一覧だけ
 * 記録: data_import_batches / data_import_rows (A = insert / B = update)。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { execLockStart, execLockAcquire, execLockRun } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.HONOBONO_SYNC_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env, HONOBONO_SYNC_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}
const core = await import("../scripts/_honobono-sync-core.mjs");
const { TENANT, readEnv } = core;

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const SCRIPT_REL = "apps/order-app/migrations/fix_equipment_price_from_master_old_marks.mjs";
const SOURCE_SYSTEM = "order-app";
const STEP_NAME = "fix-equipment-price-from-master-old-marks";
const BASE = join(HERE, "../../kaigo-app/伝送データ/ケアサポ/福祉用具");
const MASTER_FILE = "マスタ/FYGMST01_用具マスタ_20261109.CSV";
const MONTHS = ["04", "05", "06", "07", "08", "09", "10"];
const kdsFile = (m) => `2026${m}/ほのぼのから/KDS0031_明細書明細付_処理R8-${m}.CSV`;
let EXEC_LOCK = null;

const parseLine = (l) => (l.match(/("([^"]*)"|[^,]*)(,|$)/g) || []).map((s) => s.replace(/,$/, "").replace(/^"|"$/g, ""));
const readSjis = (f) => new TextDecoder("shift_jis").decode(readFileSync(join(BASE, f))).split(/\r?\n/).filter(Boolean);

async function makeSb() {
  const env = readEnv();
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

function loadMaster() {
  const m = new Map(); // TAIS → { old:Set<単位>, cur:Set<単位> }
  for (const l of readSjis(MASTER_FILE).slice(1)) {
    const r = parseLine(l);
    if (r[6] !== "レンタル" || !r[12]) continue;
    if (!m.has(r[12])) m.set(r[12], { old: new Set(), cur: new Set() });
    (r[9].startsWith("●") ? m.get(r[12]).old : m.get(r[12]).cur).add(Number(r[13]));
  }
  return m;
}
/** TAIS → [{ month: "2026-04", unit }] (その提供月に全日数で請求した明細の 1 か月単位。半月は ×2 で月額に戻す) */
function loadBilled() {
  const b = new Map();
  for (const mm of MONTHS) {
    for (const l of readSjis(kdsFile(mm)).slice(1)) {
      const r = parseLine(l);
      if (r[61] !== "明細情報レコード" || !r[73]) continue;
      const ym = r[1].replace("/", "-");
      const dim = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
      const days = Number(r[65]);
      const unit = Number(r[69]);
      if (!unit) continue;
      // 半月按分 (15 日以下) は 1/2。全日数でも半月でもない (按分なし運用) は そのまま
      const monthly = days === dim ? unit : days <= 15 ? unit * 2 : unit;
      if (!b.has(r[73])) b.set(r[73], []);
      b.get(r[73]).push({ month: ym, unit: monthly });
    }
  }
  return b;
}

async function plan(sb) {
  const master = loadMaster();
  const billed = loadBilled();
  const eq = await selectAll(sb, "equipment_master", "id,name,product_code,tais_code,rental_price", (q) => q.eq("tenant_id", TENANT));
  const ph = await selectAll(sb, "equipment_price_history", "id,product_code,rental_price,valid_from", (q) => q.eq("tenant_id", TENANT));
  const hist = new Map();
  for (const p of ph) { if (!hist.has(p.product_code)) hist.set(p.product_code, []); hist.get(p.product_code).push(p); }
  const priceAt = (pc, base, d) => {
    const hs = (hist.get(pc) ?? []).filter((x) => x.valid_from <= d).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1));
    return hs.length ? hs[0].rental_price : base;
  };
  const ops = [], skipped = [];
  for (const [tais, v] of master) {
    if (!v.old.size || v.cur.size !== 1) continue;
    const cur = [...v.cur][0];
    if (v.old.has(cur)) continue;
    for (const e of eq.filter((x) => x.product_code === tais || x.tais_code === tais)) {
      const p10 = priceAt(e.product_code, e.rental_price, "2026-10-01");
      if (p10 != null && Math.round(p10 / 10) === cur) continue;
      const bl = (billed.get(tais) ?? []).sort((a, b) => (a.month < b.month ? -1 : 1));
      const oldMonths = bl.filter((x) => v.old.has(x.unit)).map((x) => x.month);
      const curMonths = bl.filter((x) => x.unit === cur).map((x) => x.month);
      const ev = bl.map((x) => `${x.month}:${x.unit}`).join(" ");
      const base = { tais, equipment: e, cur, old: [...v.old], evidence: ev || "請求なし" };
      if (oldMonths.length && curMonths.length) {
        const lastOld = oldMonths.at(-1);
        const firstCur = curMonths.find((m) => m > lastOld);
        if (!firstCur) { skipped.push({ ...base, why: "旧価格と現価格の請求が前後している" }); continue; }
        const validFrom = `${firstCur}-01`;
        if ((hist.get(e.product_code) ?? []).some((x) => x.valid_from === validFrom)) { skipped.push({ ...base, why: `${validFrom} の履歴が既にある (価格違い)` }); continue; }
        ops.push({ ...base, kind: "A 価格履歴を足す", validFrom });
      } else if (oldMonths.length) {
        skipped.push({ ...base, why: "旧価格の請求しか無い (まだ切り替わっていない可能性)" });
      } else {
        const hs = hist.get(e.product_code) ?? [];
        if (hs.length > 1 || (hs.length === 1 && hs[0].valid_from > "2026-04-01")) { skipped.push({ ...base, why: "価格履歴が複数 / 途中から始まる行は触らない" }); continue; }
        // 履歴が 2026-04 以前開始の 1 行だけ (= 移行時の基準行) ならそれも同じ値に直す (価格は履歴が優先されるため)
        ops.push({ ...base, kind: hs.length ? "B 基本価格と基準の履歴を直す" : "B 基本価格を直す", baseHist: hs[0] ?? null });
      }
    }
  }
  return { ops, skipped };
}

async function execute(sb, ops) {
  const batch = await execLockAcquire(sb, EXEC_LOCK, {
    tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [MASTER_FILE, ...MONTHS.map(kdsFile)], script: SCRIPT_REL, args: argv.join(" "), step: STEP_NAME,
    notes: `●(旧価格) のある用具 ${ops.length} 件の価格を現価格に`,
  });
  const BATCH = batch.id;
  console.log(`batch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  writeFileSync(join(HERE, `_backup_fix_equipment_price_${new Date().toISOString().replace(/[:.]/g, "-")}.json`), JSON.stringify({ batch: BATCH, ops }, null, 2));
  let n = 0;
  for (const o of ops) {
    const ref = { TAIS: o.tais, 品名: o.equipment.name, 種類: o.kind, 請求: o.evidence };
    if (o.kind.startsWith("A")) {
      const row = { tenant_id: TENANT, product_code: o.equipment.product_code, rental_price: o.cur * 10, valid_from: o.validFrom };
      const { data, error } = await sb.from("equipment_price_history").insert(row).select("id").single();
      if (error) await fail(`${o.tais} 履歴: ${error.message}`);
      const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "equipment_price_history", row_id: data.id, op: "insert", source_key: o.tais, source_ref: ref, before: null, after: row });
      if (e2) await fail(`data_import_rows: ${e2.message}`);
    } else {
      const before = { rental_price: o.equipment.rental_price };
      const after = { rental_price: o.cur * 10 };
      let q = sb.from("equipment_master").update(after, { count: "exact" }).eq("id", o.equipment.id);
      q = o.equipment.rental_price == null ? q.is("rental_price", null) : q.eq("rental_price", o.equipment.rental_price);
      const { error, count } = await q;
      if (error || count !== 1) await fail(`${o.tais} マスタ: ${error?.message ?? `件数 ${count}`}`);
      const { error: e2 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "equipment_master", row_id: o.equipment.id, op: "update", source_key: o.tais, source_ref: ref, before, after });
      if (e2) await fail(`data_import_rows: ${e2.message}`);
      n++;
      if (o.baseHist) {
        const hb = { rental_price: o.baseHist.rental_price };
        const { error: e4, count: c4 } = await sb.from("equipment_price_history").update(after, { count: "exact" }).eq("id", o.baseHist.id).eq("rental_price", o.baseHist.rental_price);
        if (e4 || c4 !== 1) await fail(`${o.tais} 基準の履歴: ${e4?.message ?? `件数 ${c4}`}`);
        const { error: e5 } = await sb.from("data_import_rows").insert({ batch_id: BATCH, tenant_id: TENANT, table_name: "equipment_price_history", row_id: o.baseHist.id, op: "update", source_key: o.tais, source_ref: ref, before: hb, after });
        if (e5) await fail(`data_import_rows: ${e5.message}`);
        n++;
      }
      continue;
    }
    n++;
  }
  const { count, error } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (error) await fail(`verify: ${error.message}`);
  if (count !== n) await fail(`verify: data_import_rows ${count} ≠ ${n}`);
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e3) throw new Error(`batch を executed にできない: ${e3.message}`);
  console.log(`完了。${ops.length} 件 / ${n} 行。取り消しは --revert ${BATCH}`);
}

async function revert(sb, batchId) {
  const recs = await selectAll(sb, "data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  console.log(`${EXECUTE ? "EXECUTE" : "DRY RUN"} 戻す ${recs.length} 行`);
  if (!EXECUTE) return;
  await execLockRun(sb, EXEC_LOCK, { tenant_id: TENANT, source_system: SOURCE_SYSTEM, source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert-lock", notes: `batch ${batchId} の取り消し` }, async () => {
    for (const r of recs) {
      const q = r.op === "insert"
        ? sb.from(r.table_name).delete({ count: "exact" }).eq("id", r.row_id)
        : sb.from(r.table_name).update(r.before, { count: "exact" }).eq("id", r.row_id);
      const { error, count } = await q;
      if (error || count !== 1) throw new Error(`revert ${r.table_name} ${r.row_id}: ${error?.message ?? `件数 ${count}`}`);
    }
    const { error } = await sb.from("data_import_batches").update({ status: "reverted", reverted_at: new Date().toISOString() }).eq("id", batchId);
    if (error) throw new Error(`batch: ${error.message}`);
    console.log("取り消し完了");
  });
}

const sb = await makeSb();
if (EXECUTE) EXEC_LOCK = await execLockStart(sb, { script: SCRIPT_REL, argv });
if (REVERT) { await revert(sb, REVERT); process.exit(0); }
const { ops, skipped } = await plan(sb);
console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"}  直す ${ops.length} 件`);
for (const o of ops) console.log(`  - [${o.kind}${o.validFrom ? ` ${o.validFrom}` : ""}] ${o.tais} ${o.equipment.product_code} ${o.equipment.name.slice(0, 24)}  当方 ${o.equipment.rental_price} → ${o.cur * 10}  (旧 ${o.old.join("/")} / 請求 ${o.evidence})`);
console.log(`\n直さない ${skipped.length} 件:`);
for (const o of skipped) console.log(`  - ${o.tais} ${o.equipment.product_code} ${o.equipment.name.slice(0, 24)}  当方 ${o.equipment.rental_price} / 現 ${o.cur * 10}  — ${o.why} (請求 ${o.evidence})`);
if (EXECUTE && ops.length) await execute(sb, ops);
