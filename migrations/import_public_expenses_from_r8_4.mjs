/**
 * 福祉用具の生活保護等の公費 (client_public_expenses) を R8_4kaigo.CSV の公費1〜3 から入れる
 *
 *   node migrations/import_public_expenses_from_r8_4.mjs                     # DRY RUN
 *   node migrations/import_public_expenses_from_r8_4.mjs --execute           # 投入
 *   node migrations/import_public_expenses_from_r8_4.mjs --delete            # 撤去 DRY RUN
 *   node migrations/import_public_expenses_from_r8_4.mjs --delete --execute  # 撤去
 *
 * 背景 (2026-10-15):
 *   client_public_expenses は 1 行しか無く (番号も空)、生保の利用者 89 名
 *   (公費単独 12 + 併用 77) が公費なしで請求される状態だった。
 *     公費単独 → 負担者番号が空で伝送 = 返戻 / 併用 → 本人に 1 割を請求してしまう
 *   R8_4kaigo.CSV は ほのぼの福祉用具の 2026-04 国保請求一覧 (公費1〜3 の負担者番号・受給者番号入り)。
 *   ほのぼの福祉用具は訪問介護と別 DB で、これより新しい出力は手元に無い。
 *   訪問介護側の client_kohi_records と番号まで一致するのは 18 名だけで、残りは裏が取れない。
 *   user 判断 (2026-10-15):「4月のCSVの番号で入れて」。
 *
 * 入れ方:
 *   法別 = 負担者番号の先頭 2 桁 / valid_start = 2026-04-01 (CSV の提供月) / valid_end = null
 *   利用者は (保険者番号, 被保険者番号) で引く。0 件・複数件は入れずに一覧に出す
 *   既に同じ (法別, 負担者番号, 受給者番号) の行がある人は飛ばす (冪等)
 *   表に notes 列が無いので、入れた id を _inserted_public_expenses_r8_4.json に控えて撤去に使う
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Encoding from "encoding-japanese";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..");
const EXECUTE = process.argv.includes("--execute");
const DELETE = process.argv.includes("--delete");
const TENANT = "kt-group";
const VALID_START = "2026-04-01";
const LEDGER = join(HERE, "_inserted_public_expenses_r8_4.json");

// service_role キーは order-app の .env.local に無いので、既存 script と同じく calendar-app / kaigo-app から読む
const loadEnv = (p) => existsSync(p) ? Object.fromEntries(
  readFileSync(p, "utf8").split(/\r?\n/)
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim())).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]),
) : {};
const env = {
  ...loadEnv(join(APP, "..", "kaigo-app", ".env.local")),
  ...loadEnv(join(APP, "..", "calendar-app", ".env.local")),
  ...loadEnv(join(APP, ".env.local")),
};
const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !KEY) { console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local にありません"); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function getAll(path) {
  const out = [];
  for (let f = 0; ; f += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { ...H, Range: `${f}-${f + 999}` } });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
    out.push(...j);
    if (j.length < 1000) return out;
  }
}

// ── 撤去 ───────────────────────────────────────────────
if (DELETE) {
  if (!existsSync(LEDGER)) { console.log("控えファイルが無いので撤去対象は 0 件"); process.exit(0); }
  const ids = JSON.parse(readFileSync(LEDGER, "utf8")).ids ?? [];
  const live = [];
  for (let i = 0; i < ids.length; i += 150) {
    const rows = await getAll(`client_public_expenses?select=id&id=in.(${ids.slice(i, i + 150).join(",")})&order=id`);
    live.push(...rows.map((r) => r.id));
  }
  console.log(`撤去対象 ${live.length} 件 (控え ${ids.length} 件)`);
  if (!EXECUTE) { console.log("DRY RUN — --execute で削除"); process.exit(0); }
  for (let i = 0; i < live.length; i += 150) {
    const r = await fetch(`${SB_URL}/rest/v1/client_public_expenses?id=in.(${live.slice(i, i + 150).join(",")})`, { method: "DELETE", headers: H });
    if (!r.ok) { console.error("削除失敗:", r.status, await r.text()); process.exit(1); }
  }
  const left = [];
  for (let i = 0; i < live.length; i += 150) {
    left.push(...await getAll(`client_public_expenses?select=id&id=in.(${live.slice(i, i + 150).join(",")})&order=id`));
  }
  console.log(`削除後の残り ${left.length} 件`);
  process.exit(left.length ? 1 : 0);
}

// ── CSV ────────────────────────────────────────────────
const lines = Encoding.convert(readFileSync(join(APP, "R8_4kaigo.CSV")), { to: "UNICODE", from: "SJIS", type: "string" }).split(/\r?\n/);
const head = lines[0].split(",").map((x) => x.replace(/"/g, ""));
const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`列「${name}」が CSV にありません`); return i; };
const I = {
  ins: col("被保険者番号"), insurer: col("保険者番号"), name: col("利用者名"),
  k: [1, 2, 3].map((n) => [col(`公費${n}負担者番号`), col(`公費${n}受給者番号`)]),
};
const byPerson = new Map(); // key 保険者|被保番 → { name, insured, insurer, kohi: Map }
for (const l of lines.slice(1)) {
  if (!l.trim()) continue;
  const c = l.split(",").map((x) => x.replace(/"/g, "").trim());
  const kohi = I.k.map(([f, j]) => ({ fut: c[f], jyu: c[j] })).filter((k) => k.fut);
  if (!kohi.length) continue;
  const insurer = c[I.insurer].replace(/^0+/, "");
  const key = `${insurer}|${c[I.ins]}`;
  const p = byPerson.get(key) ?? { name: c[I.name], insured: c[I.ins], insurer, kohi: new Map() };
  for (const k of kohi) {
    if (!/^\d{8}$/.test(k.fut)) { console.warn(`  ⚠ 負担者番号が 8 桁でない: ${p.name} ${k.fut}`); continue; }
    p.kohi.set(`${k.fut}|${k.jyu}`, { hobetsu: k.fut.slice(0, 2), fut: k.fut, jyu: k.jyu || null });
  }
  byPerson.set(key, p);
}

// ── DB ─────────────────────────────────────────────────
const clients = await getAll("clients?select=id,name,insured_number,insurer_number&insured_number=not.is.null&order=id");
const existing = await getAll("client_public_expenses?select=id,client_id,hohei_code,futan_sha_number,jukyu_sha_number,valid_start,valid_end&order=id");

const toInsert = [], skipped = [], noClient = [], multi = [], otherExisting = [];
for (const p of byPerson.values()) {
  const cs = clients.filter((c) => (c.insured_number ?? "").trim() === p.insured && (c.insurer_number ?? "").replace(/^0+/, "") === p.insurer);
  if (cs.length === 0) { noClient.push(p); continue; }
  if (cs.length > 1) { multi.push(p); continue; }
  const cid = cs[0].id;
  const mine = existing.filter((e) => e.client_id === cid);
  for (const k of p.kohi.values()) {
    if (mine.some((e) => e.hohei_code === k.hobetsu && e.futan_sha_number === k.fut && (e.jukyu_sha_number ?? null) === k.jyu)) { skipped.push(p.name); continue; }
    toInsert.push({ tenant_id: TENANT, client_id: cid, hohei_code: k.hobetsu, futan_sha_number: k.fut, jukyu_sha_number: k.jyu, valid_start: VALID_START, valid_end: null, _name: p.name, _tandoku: /^H/i.test(p.insured) });
  }
  if (mine.length && mine.some((e) => !p.kohi.has(`${e.futan_sha_number}|${e.jukyu_sha_number ?? ""}`))) otherExisting.push({ name: p.name, rows: mine });
}

const byHobetsu = {};
for (const r of toInsert) byHobetsu[r.hohei_code] = (byHobetsu[r.hohei_code] ?? 0) + 1;
console.log(`CSV で公費を持つ人 ${byPerson.size} 名`);
console.log(`  入れる ${toInsert.length} 行 / ${new Set(toInsert.map((r) => r.client_id)).size} 名 (公費単独 ${new Set(toInsert.filter((r) => r._tandoku).map((r) => r.client_id)).size} 名)  法別内訳 ${JSON.stringify(byHobetsu)}`);
console.log(`  既に同じ行あり ${skipped.length} 行`);
console.log(`  利用者が引けない ${noClient.length} 名 / 複数ヒット ${multi.length} 名`);
for (const p of [...noClient, ...multi]) console.log(`    ✗ ${p.name} 保険者${p.insurer} 被保番${p.insured}`);
for (const o of otherExisting) console.log(`    ⚠ 既存行が CSV と違う (触らない): ${o.name} ${JSON.stringify(o.rows.map((r) => [r.hohei_code, r.futan_sha_number, r.jukyu_sha_number, r.valid_start, r.valid_end]))}`);
for (const r of toInsert.slice(0, 5)) console.log(`    例 ${r._name} 法別${r.hohei_code} ${r.futan_sha_number}/${r.jukyu_sha_number}`);

if (!EXECUTE) { console.log("\nDRY RUN — --execute で投入"); process.exit(0); }

const payload = toInsert.map(({ _name, _tandoku, ...r }) => r);
const ids = [];
for (let i = 0; i < payload.length; i += 100) {
  const r = await fetch(`${SB_URL}/rest/v1/client_public_expenses?select=id`, { method: "POST", headers: { ...H, Prefer: "return=representation" }, body: JSON.stringify(payload.slice(i, i + 100)) });
  const j = await r.json();
  if (!r.ok) {
    console.error("投入失敗:", r.status, JSON.stringify(j));
    if (ids.length) writeFileSync(LEDGER, JSON.stringify({ created: new Date().toISOString(), ids }, null, 2));
    process.exit(1);
  }
  ids.push(...j.map((x) => x.id));
}
const prev = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")).ids ?? [] : [];
writeFileSync(LEDGER, JSON.stringify({ created: new Date().toISOString(), ids: [...prev, ...ids] }, null, 2));
const after = await getAll(`client_public_expenses?select=id&tenant_id=eq.${TENANT}&order=id`);
console.log(`投入 ${ids.length} 行 (控え ${LEDGER}) / 投入後の client_public_expenses ${after.length} 行`);
