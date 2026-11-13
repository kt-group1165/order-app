/**
 * 用具マスタの価格が「半月分の請求の単位数 × 10」で入ってしまった品目を、月額に直す案 — ★ DRY RUN 専用 (DB は読まない・書かない)
 * (2026-11-13。ケアサポの FYGMST01 の単位数と 今の共通の価格が違う 85 品目のうち、ちょうど半分の 9 品目を追って判明)
 *
 *   node migrations/fix_equipment_price_half_from_r8_4.mjs --db-cache <控え json (equipment / priceHist を含む)> [--area ケアサポ]
 *
 * 原因:
 *   import_R8_4kaigo.mjs (2026-05-20 の最初の移行) は、R8_4kaigo.CSV (4 月の国保請求) の「行の単位数」(列 132) × 10 を
 *   equipment_master.rental_price に入れていた。4 月に月の途中で始まった/終わった台は 半額 (半月按分) の行なので、
 *   その品目は 月額の半分 が価格になった。価格履歴は作っていないので、今もその値が使われる。
 *   → 11 月以降にその品目を貸すと、order-app は半分の月額から計算して 過少請求になる。
 * 判定 (すべて満たすものだけ「直す案」):
 *   - 用具マスタの価格 × 2 = その事業所の FYGMST01 の単位数 (使用中が 1 通り) × 10
 *   - その品目に価格履歴が無い (= 用具マスタの価格がそのまま使われている)
 *   - R8-04 の 明細書明細付 (KDS0031) に、その品目が サービス単位数 (列 69) = 今の価格 / 10・日数 15 日以下
 *     (= 半月按分の半額) で載っている (半額の行から取った証拠。福祉用具の行は 列 64 の単位数が 0 なので見ない)
 *     (KDS は 原因の確かめにだけ使う。直す値は FYGMST01 = 入力側のマスタ)
 *   満たさないもの (半分だが証拠が無い 等) は「判断が要る」に出して触らない。
 * ★ --execute は未実装。user の承認のあとで書込み (data_import_batches / rows の作法) を足す。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveFukuyoguOffice } from "./_fukuyogu_office.mjs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (argv.includes("--execute")) { console.error("★ --execute は未実装 (DRY RUN 専用)。案を user が確認してから書込みを足す"); process.exit(1); }
const CACHE = opt("--db-cache");
if (!CACHE) { console.error("usage: node migrations/fix_equipment_price_half_from_r8_4.mjs --db-cache <json> [--area ケアサポ]"); process.exit(1); }
const FO = resolveFukuyoguOffice(argv);
const nf = (s) => String(s ?? "").normalize("NFKC").trim();
const nTais = (s) => nf(s).toUpperCase().replace(/[‐－―ー–?]/g, "-");
const isTais = (t) => /^\d{5}-[0-9A-Z]{6}$/.test(t);

function parseCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}
const readSjis = (p) => new TextDecoder("shift-jis").decode(readFileSync(p)).split(/\r\n|\n/).filter((l) => l.length > 0).map(parseCsvLine);

// FYGMST01 (介護・予防。自費は TAIS が無いので外す) → TAIS → 使用中の単位数
const mdir = join(FO.dir, "マスタ");
if (!existsSync(mdir)) { console.log(`未着: ${mdir} が無い`); process.exit(0); }
const fy = new Map();
for (const f of readdirSync(mdir).filter((x) => /^FYGMST.*\.csv$/i.test(x) && !/自費/.test(x))) {
  const [head, ...rows] = readSjis(join(mdir, f));
  const H = Object.fromEntries(["中止", "型番", "TAISコード等", "単位数"].map((k) => { const i = head.indexOf(k); if (i < 0) throw new Error(`★ ${f} に列「${k}」が無い`); return [k, i]; }));
  for (let r of rows) {
    if (r.length === head.length + 1) r = [...r.slice(0, H.型番), `${r[H.型番]},${r[H.型番 + 1]}`, ...r.slice(H.型番 + 2)];
    if (r.length !== head.length) throw new Error(`★ ${f}: 列数 ${r.length} ≠ ${head.length}`);
    const t = nTais(r[H.TAISコード等]);
    if (!isTais(t) || r[H.中止] === "1" || r[H.単位数] === "") continue;
    if (!fy.has(t)) fy.set(t, new Set());
    fy.get(t).add(Number(r[H.単位数]));
  }
}

// R8-04 の KDS0031 (原因の確かめだけ): TAIS → [{単位数, 日数}]
const kds = new Map();
const kdir = join(FO.dir, "202604", "ほのぼのから");
const kfile = existsSync(kdir) ? readdirSync(kdir).find((f) => /^KDS0031.*\.csv$/i.test(f)) : null;
if (kfile) {
  const [head, ...rows] = readSjis(join(kdir, kfile));
  if (head[64] !== "単位数" || !/日数/.test(head[65] ?? "") || head[69] !== "サービス単位数") throw new Error(`★ ${kfile} の列 64/65/69 が 単位数/日数/サービス単位数 でない`);
  for (const r of rows) {
    const t = nTais(r[73]);
    if (!isTais(t)) continue;
    if (!kds.has(t)) kds.set(t, []);
    kds.get(t).push({ units: Number(r[64] || 0), days: Number(r[65] || 0), svc: Number(r[69] || 0) });
  }
}

const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const hasHist = new Set((snap.priceHist ?? []).map((h) => h.product_code));
const R = { fix: [], judge: [] };
for (const e of snap.equipment ?? []) {
  const t = nTais(e.tais_code || e.product_code);
  const u = fy.get(t);
  if (!u || u.size !== 1 || !e.rental_price) continue;
  const full = [...u][0] * 10;
  if (e.rental_price * 2 !== full) continue;
  const ev = (kds.get(t) ?? []).filter((x) => x.svc * 10 === e.rental_price && x.days > 0 && x.days <= 15);
  const base = { product_code: e.product_code, TAIS: t, 名前: e.name, 今の価格: e.rental_price, [`${FO.area}_FYG_月額`]: full, 価格履歴: hasHist.has(e.product_code) ? "あり" : "なし", R8_04_半額の行: ev.map((x) => `${x.svc}単位/${x.days}日`).join(" ") || "-" };
  if (hasHist.has(e.product_code)) R.judge.push({ ...base, 理由: "価格履歴がある (履歴の値が使われるので マスタの価格だけ直しても効かない)" });
  else if (!ev.length) R.judge.push({ ...base, 理由: "R8-04 に半額の行が無い (半額の請求から取った証拠が無い)" });
  else R.fix.push({ ...base, 新しい価格: full, id: e.id });
}

console.log(`事業所 ${FO.area} ${FO.bn} / 控え ${snap.fetchedAt} / R8-04 KDS ${kfile ?? "★無し"}`);
for (const [t, xs] of [["直す案 (equipment_master.rental_price を 月額に)", R.fix], ["★ 判断が要る (触らない)", R.judge]]) {
  console.log(`\n${t}: ${xs.length} 品目`);
  for (const x of xs) console.log(`  - ${JSON.stringify(x)}`);
}
console.log(`\n書込みの見込み (承認後): equipment_master update ${R.fix.length} 行 (rental_price)。価格履歴・明細は触らない`);
console.log("DRY RUN — DB は読んでいない・書き換えていない (--execute は未実装)");
