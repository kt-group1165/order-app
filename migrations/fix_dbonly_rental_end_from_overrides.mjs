/**
 * 提供票に無いのに 貸与中 / 8/31 終了 のまま残っている明細の 終了日を直す案 — ★ DRY RUN 専用 (DB は読まない・書かない)
 * (2026-11-13。2026-06 の貸与台数の差 (order-app が多い側) の切り分けで判明)
 *
 *   node migrations/rebuild_rentals_from_teikyohyo.mjs --db-cache <控え> --out-dir <dir> --disambiguate-by-billing --skip-users 14400
 *   node migrations/fix_dbonly_rental_end_from_overrides.mjs --db-cache <同じ控え> --rebuild-json <dir>/teikyo_rebuild.json
 *
 * 背景:
 *   rebuild_rentals_from_teikyohyo は 提供票 (R8/4〜) に無い DB の明細 (「DB だけ」) を、参照 (billing_unit_overrides 等) が
 *   あると消さない。2026-05-20 の移行で作った明細のうち、2026-02/03 (提供票より前) に単位の上書きがある 37 本がこれに当たり、
 *   移行の仮の終了日 2026-08-31 のまま残っていた → 4〜8 月を order-app だけが貸与中として数える (請求も当方だけになる)。
 * 案:
 *   「DB だけ・参照あり」の明細ごとに、終了日 = 単位の上書きがある最後の月の末日 (提供票に 4 月以降の印が無いので、それ以前に終わっている)。
 *   status は terminated。消さない (参照を切らない)。上書きの無い明細・最後の上書きが 2026-04 以降の明細は「判断が要る」に出して触らない。
 * ★ --execute は未実装。user の承認のあとで書込み (data_import_batches / rows の作法) を足す。
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (argv.includes("--execute")) { console.error("★ --execute は未実装 (DRY RUN 専用)。案を user が確認してから書込みを足す"); process.exit(1); }
const CACHE = opt("--db-cache"), RJ = opt("--rebuild-json");
if (!CACHE || !RJ) { console.error("usage: node migrations/fix_dbonly_rental_end_from_overrides.mjs --db-cache <json> --rebuild-json <teikyo_rebuild.json>"); process.exit(1); }
const OFFICE = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a"; // ケアサポ (rebuild_rentals の既定と同じ)
const TEIKYO_FIRST = "2026-04"; // 提供票の最初の月

const snap = JSON.parse(readFileSync(CACHE, "utf8"));
const rep = JSON.parse(readFileSync(RJ, "utf8")).report?.db;
if (!rep) throw new Error(`★ ${RJ} に report.db が無い (rebuild_rentals の詳細 JSON か確かめる)`);
const dbOnly = Object.entries(rep).filter(([k]) => k.includes("DB だけ")).flatMap(([, v]) => v.items ?? []);

const orders = new Map(snap.orders.map((o) => [o.id, o]));
const clientName = new Map(snap.clients.map((c) => [c.id, c.name]));
const ov = new Map();
for (const o of snap.overrides ?? []) { if (!ov.has(o.order_item_id)) ov.set(o.order_item_id, []); ov.get(o.order_item_id).push(o.month); }
const keyOf = (name, pc, s, e) => JSON.stringify([name, pc, s, e ?? null]);
const want = new Map();
for (const x of dbOnly) { const k = keyOf(x.氏名, x.用具, x.開始, x.終了); want.set(k, (want.get(k) ?? 0) + 1); }

const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const R = { fix: [], judge: [] };
for (const it of snap.items) {
  const o = orders.get(it.order_id);
  if (!o || o.office_id !== OFFICE) continue;
  const name = clientName.get(o.client_id);
  const k = keyOf(name, it.product_code, it.rental_start_date, it.rental_end_date);
  if (!want.get(k)) continue;
  want.set(k, want.get(k) - 1);
  const months = (ov.get(it.id) ?? []).map((m) => String(m).slice(0, 7)).sort();
  const base = { 利用者: name, 用具: it.product_code, 開始: it.rental_start_date, 今の終了: it.rental_end_date, 状態: it.status, 作成: String(it.created_at ?? "").slice(0, 10), 上書きの月: months.join(" ") || "-", id: it.id };
  const last = months.at(-1);
  if (!last) R.judge.push({ ...base, 理由: "単位の上書きが無い (参照なしの DB だけ = rebuild の --remove-db-only の対象)" });
  else if (last >= TEIKYO_FIRST) R.judge.push({ ...base, 理由: `最後の上書きが ${last} (提供票の期間内)` });
  else if (it.rental_start_date && monthEnd(last) < it.rental_start_date) R.judge.push({ ...base, 理由: "上書きの月が開始より前" });
  else R.fix.push({ ...base, 新しい終了: monthEnd(last), 新しい状態: "terminated" });
}
const left = [...want.values()].reduce((a, b) => a + b, 0);

console.log(`控え ${snap.fetchedAt} / rebuild の「DB だけ」 ${dbOnly.length} 本 (控えで見つからない ${left})`);
for (const [t, xs] of [["終了日を直す案", R.fix], ["★ 判断が要る (触らない)", R.judge]]) {
  console.log(`\n${t}: ${xs.length} 本`);
  for (const x of xs) console.log(`  - ${JSON.stringify(x)}`);
}
const people = new Map();
for (const x of R.fix) people.set(x.利用者, (people.get(x.利用者) ?? 0) + 1);
console.log(`\n利用者別: ${[...people].map(([n, c]) => `${n} ${c}`).join(" / ")}`);
console.log(`\n書込みの見込み (承認後): order_items update ${R.fix.length} 本 (rental_end_date・status)。削除なし`);
console.log("DRY RUN — DB は読んでいない・書き換えていない (--execute は未実装)");
