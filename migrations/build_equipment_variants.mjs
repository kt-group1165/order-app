/**
 * 用具マスタの 同じ TAIS の重複を「品目 (親) + サイズ・型 (子)」にまとめる (2026-11-13 user 決定: 1 TAIS = 1 品目 = 1 価格)
 *
 *   node migrations/build_equipment_variants.mjs --db-cache <json> [--csv-dir <dir>]   DRY RUN (控えから。DB を読まない)
 *   node migrations/build_equipment_variants.mjs [--csv-dir <dir>]                      DRY RUN (DB を読む: 用具マスタ・価格履歴・発注明細の品目コード)
 *   node migrations/build_equipment_variants.mjs --execute --expect <子の行数>           書く (DB を読み直して計画を作り、行数が --expect と同じときだけ)
 *     控え json = { fetchedAt, equipment: [...equipment_master], priceHistory: [{product_code, rental_price, valid_from}], orderItems: [{product_code}] }
 *
 * 分け方 (TAIS は NFKC + 大文字にそろえて 5桁-6桁 の形のものだけ。セット品・TAIS 空・既に子 は対象外):
 *   親 = ① 発注明細の件数が最多 ② product_code が TAIS そのもの ③ product_code が最小 の順。子 = 残り (variant_label = 子の名前)
 *   A まとめる … 全部の行の 請求で使う価格 (2024-01〜2027-12 の各月。価格履歴 → 無ければ rental_price) が同じ
 *   B まとめる … 価格が違うが、発注明細がある行は全部同じ価格 (= 価格が違う行は 1 度も使われていない)。子の価格は使わなくなる
 *   M 判断が要る (書かない) … 発注明細がある行どうしで価格が違う / 種目が違う (徘徊感知機器 の表記違いは同じとみなす)
 *   ★ A・B とも 既存の発注明細の請求額は変わらない (使われている行の価格 = 親の価格)。
 * 書くのは 子の parent_product_code と variant_label だけ (親・価格・TAIS は触らない)。
 *   書く前に 子の今の値を migrations/_backup_equipment_variants_<時刻>.json に退避。1 行ずつ update して件数 1 を確かめる。
 *   戻す: 退避ファイルの行を parent_product_code = NULL, variant_label = 元の値 に戻す (--revert <退避ファイル>)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execLockStart, execLockRun } from "./_exec_lock.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_REL = "apps/order-app/migrations/build_equipment_variants.mjs";
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const CACHE = opt("--db-cache");
if ((EXECUTE || REVERT) && CACHE) { console.error("★ --execute / --revert は控え (--db-cache) では動かさない (DB を読み直す)"); process.exit(1); }

function readEnv() {
  const p = join(HERE, "..", "..", "kaigo-app", ".env.local");
  return Object.fromEntries(readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
}
async function makeSb() {
  const env = readEnv();
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}
async function selectAll(sb, table, select) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(select).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const TAIS = /^\d{5}-[0-9A-Z]{6}$/;
// ハイフンが化けた TAIS (「00167?000197」) も 1 文字だけ「-」に戻して 同じ組に入れる (化けた行は子になり、TAIS は親のものを使う。tais_code 自体は書き換えない)
const normTais = (s) => {
  const t = String(s ?? "").normalize("NFKC").toUpperCase().replace(/\s/g, "");
  const m = t.match(/^(\d{5})[?？‐－―ー–—](.{6})$/);
  return m ? `${m[1]}-${m[2]}` : t;
};
const rawTaisOk = (e) => TAIS.test(String(e.tais_code ?? "").normalize("NFKC").toUpperCase().replace(/\s/g, ""));
const normCat = (c) => String(c ?? "").replace(/^認知症老人/, "");
const MONTHS = [];
for (let y = 2024; y <= 2027; y++) for (let m = 1; m <= 12; m++) MONTHS.push(`${y}-${String(m).padStart(2, "0")}-01`);

function plan(snap) {
  const used = new Map();
  for (const o of snap.orderItems ?? []) used.set(o.product_code, (used.get(o.product_code) ?? 0) + 1);
  const hist = new Map();
  for (const h of snap.priceHistory ?? []) {
    if (!hist.has(h.product_code)) hist.set(h.product_code, []);
    hist.get(h.product_code).push([h.valid_from, h.rental_price]);
  }
  // 請求で使う価格を 各月で並べたもの (lib/equipment.ts getPriceForMonth → 無ければ rental_price)
  const priceKey = (e) => {
    const rows = [...(hist.get(e.product_code) ?? [])].sort((a, b) => String(b[0]).localeCompare(String(a[0])));
    return MONTHS.map((ms) => rows.find(([vf]) => vf <= ms)?.[1] ?? e.rental_price ?? "null").join(",");
  };
  const groups = new Map();
  const skip = { set: 0, noTais: 0, child: 0 };
  for (const e of snap.equipment ?? []) {
    if (e.parent_product_code) { skip.child++; continue; }
    if (e.kind !== "single") { skip.set++; continue; }
    const t = normTais(e.tais_code);
    if (!TAIS.test(t)) { skip.noTais++; continue; }
    const k = `${e.tenant_id}|${t}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const fmt = (r) => ({ id: r.id, product_code: r.product_code, 名前: r.name, 種目: r.category, 単位数: r.rental_price,
    価格履歴: (hist.get(r.product_code) ?? []).map(([v, p]) => `${v}:${p}`).join(" "), 発注明細: used.get(r.product_code) ?? 0 });
  const out = { A: [], B: [], M: [], garbledParent: [], groups: groups.size, skip };
  for (const [k, rows] of groups) {
    if (rows.length < 2) continue;
    const tais = k.split("|")[1];
    const usedPrices = new Set(rows.filter((r) => used.get(r.product_code)).map(priceKey));
    const why = new Set(rows.map((r) => normCat(r.category))).size > 1 ? "種目が違う"
      : usedPrices.size > 1 ? "発注明細がある行どうしで価格が違う" : null;
    if (why) { out.M.push({ tais, why, rows: rows.map(fmt) }); continue; }
    const sorted = [...rows].sort((a, b) =>
      (used.get(b.product_code) ?? 0) - (used.get(a.product_code) ?? 0) ||
      rawTaisOk(b) - rawTaisOk(a) ||
      (b.product_code === tais) - (a.product_code === tais) ||
      a.product_code.localeCompare(b.product_code));
    const [parent, ...children] = sorted;
    const pk = priceKey(parent);
    const tag = children.every((c) => priceKey(c) === pk) ? "A" : "B";
    if (!rawTaisOk(parent)) out.garbledParent.push(`${tais} ${parent.product_code}「${parent.name}」 (tais_code=${parent.tais_code})`);
    out[tag].push({ tais, parent: fmt(parent), children: children.map((c) => ({ ...fmt(c), TAIS化け: !rawTaisOk(c), 同じ価格: priceKey(c) === pk, variant_label: c.name, 元のvariant_label: c.variant_label ?? null })) });
  }
  return out;
}

function report(p, fetchedAt, n) {
  const kids = (l) => l.reduce((s, g) => s + g.children.length, 0);
  console.log(`■ 用具マスタ ${n} 行 (${fetchedAt})`);
  console.log(`   対象外: セット品 ${p.skip.set} / TAIS が空・形が崩れた ${p.skip.noTais} / 既に子 ${p.skip.child}`);
  console.log(`   TAIS ${p.groups} 種のうち 重複 ${p.A.length + p.B.length + p.M.length} 組`);
  console.log(`■ A まとめる (価格が全部同じ): ${p.A.length} 組 / 子 ${kids(p.A)} 行`);
  console.log(`■ B まとめる (価格の違う行は発注明細 0 = 子の価格は使わなくなる): ${p.B.length} 組 / 子 ${kids(p.B)} 行`);
  console.log(`■ M 判断が要る (書かない): ${p.M.length} 組 / ${p.M.reduce((s, g) => s + g.rows.length, 0)} 行`);
  for (const g of p.M) console.log(`   M ${g.tais} ${g.why}: ${g.rows.map((r) => `${r.product_code}「${r.名前}」${r.種目} ${r.単位数} 発注${r.発注明細}`).join(" / ")}`);
  const garbledKids = [...p.A, ...p.B].flatMap((g) => g.children.filter((c) => c.TAIS化け)).map((c) => c.product_code);
  console.log(`■ TAIS が化けた行で 子になるもの ${garbledKids.length}: ${garbledKids.join(" ")}`);
  console.log(`■ ⚠ 親の TAIS が化けている組 ${p.garbledParent.length} (TAIS を直すまで 上限チェック・請求で TAIS が崩れたまま)`);
  for (const x of p.garbledParent) console.log(`   ${x}`);
  console.log(`■ 子にする行 合計 ${kids(p.A) + kids(p.B)} (--execute --expect にこの数を渡す)`);
}

function writeCsv(p, dir) {
  mkdirSync(dir, { recursive: true });
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["区分", "TAIS", "役割", "product_code", "名前", "種目", "単位数", "価格履歴", "発注明細", "親と同じ価格", "理由"].map(q).join(",")];
  for (const tag of ["A", "B"]) for (const g of p[tag]) {
    const P = g.parent;
    lines.push([tag, g.tais, "親", P.product_code, P.名前, P.種目, P.単位数, P.価格履歴, P.発注明細, "", ""].map(q).join(","));
    for (const c of g.children) lines.push([tag, g.tais, "子", c.product_code, c.名前, c.種目, c.単位数, c.価格履歴, c.発注明細, c.同じ価格 ? "同じ" : "違う", ""].map(q).join(","));
  }
  for (const g of p.M) for (const r of g.rows) lines.push(["M", g.tais, "", r.product_code, r.名前, r.種目, r.単位数, r.価格履歴, r.発注明細, "", g.why].map(q).join(","));
  const f = join(dir, "equipment_variants_plan.csv");
  writeFileSync(f, "﻿" + lines.join("\r\n"));
  console.log(`■ 一覧: ${f}`);
}

async function loadLive(sb) {
  const [equipment, priceHistory, orderItems] = [
    await selectAll(sb, "equipment_master", "id,tenant_id,product_code,tais_code,name,category,kind,rental_price,parent_product_code,variant_label"),
    await selectAll(sb, "equipment_price_history", "id,product_code,rental_price,valid_from"),
    await selectAll(sb, "order_items", "id,product_code"),
  ];
  return { fetchedAt: new Date().toISOString(), equipment, priceHistory, orderItems };
}

if (REVERT) {
  const sb = await makeSb();
  const bk = JSON.parse(readFileSync(REVERT, "utf8"));
  const lock = await execLockStart(sb, { script: SCRIPT_REL, argv });
  await execLockRun(sb, lock, { tenant_id: "kt-group", source_system: "order-app", source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "revert", notes: `${REVERT} を戻す (${bk.rows.length} 行)` }, async () => {
    for (const r of bk.rows) {
      const { data, error } = await sb.from("equipment_master").update({ parent_product_code: null, variant_label: r.variant_label }).eq("id", r.id).select("id");
      if (error || data?.length !== 1) throw new Error(`${r.product_code}: ${error?.message ?? `更新 ${data?.length} 件`}`);
    }
  });
  console.log(`戻した: ${bk.rows.length} 行`);
  process.exit(0);
}

let sb = null, lock = null, snap;
if (CACHE) snap = JSON.parse(readFileSync(CACHE, "utf8"));
else {
  sb = await makeSb();
  if (EXECUTE) lock = await execLockStart(sb, { script: SCRIPT_REL, argv });
  snap = await loadLive(sb);
}
const p = plan(snap);
report(p, snap.fetchedAt, snap.equipment?.length ?? 0);
if (opt("--csv-dir")) writeCsv(p, opt("--csv-dir"));

if (EXECUTE) {
  const rows = [...p.A, ...p.B].flatMap((g) => g.children.map((c) => ({ id: c.id, product_code: c.product_code, parent: g.parent.product_code, variant_label: c.元のvariant_label, label: c.variant_label })));
  const expect = Number(opt("--expect"));
  if (!Number.isFinite(expect) || expect !== rows.length) {
    console.error(`★ 止めた: 子にする行 ${rows.length} が --expect ${opt("--expect")} と違う (DRY RUN の後に DB が変わった)。DRY RUN からやり直す`);
    process.exit(2);
  }
  const bkFile = join(HERE, `_backup_equipment_variants_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(bkFile, JSON.stringify({ createdAt: new Date().toISOString(), rows }, null, 2));
  console.log(`退避: ${bkFile}`);
  await execLockRun(sb, lock, { tenant_id: "kt-group", source_system: "order-app", source_files: [], script: SCRIPT_REL, args: argv.join(" "), step: "build-variants", notes: `同じ TAIS の重複 ${rows.length} 行を子 (サイズ・型) にする` }, async () => {
    let n = 0;
    for (const r of rows) {
      const { data, error } = await sb.from("equipment_master").update({ parent_product_code: r.parent, variant_label: r.label }).eq("id", r.id).is("parent_product_code", null).select("id");
      if (error || data?.length !== 1) throw new Error(`${r.product_code}: ${error?.message ?? `更新 ${data?.length} 件`} (ここまで ${n} 行。--revert ${bkFile} で戻せる)`);
      n++;
    }
    console.log(`書いた: ${n} 行`);
  });
  const { count, error } = await sb.from("equipment_master").select("id", { count: "exact", head: true }).not("parent_product_code", "is", null);
  if (error) throw new Error(`確認: ${error.message}`);
  console.log(`確認: 子の行 ${count} (書いた ${rows.length})`);
}
