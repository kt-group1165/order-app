/**
 * 認定 (client_insurance_records) の 保険者名 (insurer_name) が空の行を、同じ保険者番号のほかの認定行の名前で埋める案を出す — ★ DRY RUN 専用
 *
 *   node migrations/fill_insurer_name_from_same_number.mjs [--area ケアサポ] [--db-cache <json>] [--refresh]
 *
 * 背景 (2026-11-13): 請求 → 月次情報 の「保険者」列が空の人が ケアサポで 18 名 (以前は居宅の名前を出していた → 392265d で番号表示に)。
 * 案の作り方:
 *   対象 = 事業所 (--area。既定 ケアサポ) の認定行のうち insurer_name が空で insurer_number がある行
 *   名前 = 同じ保険者番号 (6 桁にそろえて比べる) を持つ ★ほかの認定行 (全事業所) の insurer_name のうち いちばん多いもの
 *          名前が 2 通り以上あるときは 「判断が要る」に出して埋めない。1 件も無ければ「名前が見つからない」
 * ★ DB は書き換えない (--execute は未実装。user の判断のあとで足す)。
 * ★ 全件読み (認定 約 2.2 万行) を含むので、並行セッションに一報し返事を待ってから回す。控えは --db-cache で使い回す。
 * ★ 5xx・522・HTML が返ったら止める (リトライしない)。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveFukuyoguOffice } from "./_fukuyogu_office.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (argv.includes("--execute")) { console.error("★ --execute は未実装 (DRY RUN 専用)。案を user が確認してから書込みを足す"); process.exit(1); }
const FO = resolveFukuyoguOffice(argv);
const CACHE = opt("--db-cache") ?? join(tmpdir(), "fill-insurer-name-db.json");
const TENANT = "kt-group";

function env() {
  const txt = readFileSync(join(HERE, "../../kaigo-app/.env.local"), "utf8");
  return Object.fromEntries(txt.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
}
async function all(table, sel, filter = "") {
  const E = env();
  const H = { apikey: E.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${E.SUPABASE_SERVICE_ROLE_KEY}` };
  const out = [];
  for (let o = 0; ; o += 1000) {
    const r = await fetch(`${E.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${table}?select=${sel}${filter}&order=id&limit=1000&offset=${o}`, { headers: H });
    const t = await r.text();
    if (!r.ok || t.startsWith("<")) throw new Error(`STOP (リトライしない) ${r.status} ${table} ${t.slice(0, 120)}`);
    const j = JSON.parse(t);
    out.push(...j);
    if (j.length < 1000) break;
  }
  console.log(`  ${table} ${out.length} 行`);
  return out;
}

let snap;
if (existsSync(CACHE) && !argv.includes("--refresh")) {
  snap = JSON.parse(readFileSync(CACHE, "utf8"));
  console.log(`DB: 控えを使う ${CACHE} (取得 ${snap.fetchedAt})。最新は --refresh`);
} else {
  console.log("DB 読込 (READ ONLY)...");
  snap = {
    fetchedAt: new Date().toISOString(),
    ins: await all("client_insurance_records", "id,client_id,office_id,insurer_number,insurer_name,certification_start_date,certification_end_date", `&tenant_id=eq.${TENANT}`),
    clients: await all("clients", "id,name,user_number,insurer_number", `&tenant_id=eq.${TENANT}`),
  };
  writeFileSync(CACHE, JSON.stringify(snap));
  console.log(`  → 控え ${CACHE}`);
}

const n6 = (s) => String(s ?? "").normalize("NFKC").replace(/\D/g, "").replace(/^00(?=\d{6}$)/, "");
const nameOf = (s) => String(s ?? "").normalize("NFKC").trim();
const names = new Map(); // 保険者番号 → Map<名前, 件数>
for (const r of snap.ins) {
  const k = n6(r.insurer_number), v = nameOf(r.insurer_name);
  if (!k || !v) continue;
  if (!names.has(k)) names.set(k, new Map());
  names.get(k).set(v, (names.get(k).get(v) ?? 0) + 1);
}
const clientById = new Map(snap.clients.map((c) => [c.id, c]));
const targets = snap.ins.filter((r) => r.office_id === FO.officeId && !nameOf(r.insurer_name) && n6(r.insurer_number));
const R = { fill: [], ambiguous: [], none: [] };
for (const r of targets) {
  const k = n6(r.insurer_number);
  const m = names.get(k);
  const c = clientById.get(r.client_id);
  const ex = { 利用者: c?.name ?? r.client_id, 利用者番号: c?.user_number ?? null, 保険者番号: k, 認定: `${r.certification_start_date ?? "?"}〜${r.certification_end_date ?? "?"}`, row_id: r.id };
  if (!m) R.none.push(ex);
  else if (m.size > 1) R.ambiguous.push({ ...ex, 候補: [...m].map(([n, cnt]) => `${n} (${cnt})`).join(" / ") });
  else R.fill.push({ ...ex, 埋める名前: [...m.keys()][0], 根拠の行数: [...m.values()][0] });
}
console.log(`\n事業所: ${FO.area} ${FO.bn} / 保険者名が空の認定行 ${targets.length} 行 (利用者 ${new Set(targets.map((r) => r.client_id)).size} 名)`);
for (const [title, xs] of [["埋められる (同じ番号の名前が 1 通り)", R.fill], ["★ 判断が要る (同じ番号に名前が 2 通り以上)", R.ambiguous], ["名前が見つからない (同じ番号の名前付きの行が無い)", R.none]]) {
  console.log(`\n${title}: ${xs.length} 行`);
  for (const x of xs.slice(0, Number(process.env.SHOW ?? 30))) console.log(`  - ${JSON.stringify(x)}`);
}
console.log("\nDRY RUN — DB は書き換えていない (--execute は未実装)");
