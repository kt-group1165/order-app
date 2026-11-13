/**
 * 提供票 FAX 照合用: order-app DB の控えを 1 回だけ取る — ★ READ ONLY・直列・リトライなし
 *
 *   node scripts/teikyohyo-fax/snapshot.mjs --out <snapshot.json> [--area ケアサポ]
 *
 * 読むもの (★福祉用具新ソフト セッションの snapshot.mjs + snap2.mjs をそのまま 1 本にしたもの。読み方は変えていない):
 *   clients (全件) / 認定・割当・発注・負担割合証 (事業所で絞る) / 居宅 / ケアマネ / 発注明細 (発注 id を 150 件ずつ) / 用具マスタ
 * ★ 5xx・522・HTML が返ったら止める (リトライしない)。並行セッションがあるときは 始める前に一報する (全件読みを含む)。
 * ★ 出力は個人情報。repo の外に置く。
 */
import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFukuyoguOffice } from "../../migrations/_fukuyogu_office.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argOf = (n) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null);
const OUT = argOf("--out");
if (!OUT) { console.error("usage: node scripts/teikyohyo-fax/snapshot.mjs --out <snapshot.json>"); process.exit(1); }
const envTxt = fs.readFileSync(join(HERE, "../../../kaigo-app/.env.local"), "utf8");
const env = Object.fromEntries(envTxt.split(/\r?\n/).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")]));
const SB = env.NEXT_PUBLIC_SUPABASE_URL, K = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };
const FO = resolveFukuyoguOffice(process.argv.slice(2));
const CS = FO.officeId; // 既定 ケアサポ 1bfc0d57…

async function get(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers: H });
  const t = await r.text();
  if (!r.ok || t.startsWith("<")) throw new Error(`STOP (リトライしない) ${r.status} ${path.slice(0, 80)} ${t.slice(0, 120)}`);
  return JSON.parse(t);
}
async function all(table, sel, filter = "") {
  const out = [];
  for (let o = 0; ; o += 1000) {
    const j = await get(`${table}?select=${sel}${filter}&order=id&limit=1000&offset=${o}`);
    out.push(...j);
    if (j.length < 1000) break;
  }
  console.log(table, out.length);
  return out;
}
const t0 = Date.now();
const snap = {};
snap.clients = await all("clients", "id,tenant_id,office_id,user_number,name,furigana,birth_date,gender,care_level,insurer_number,insured_number,care_office_id,care_manager,care_manager_id");
snap.certs = await all("client_insurance_records", "id,client_id,office_id,effective_date,certification_start_date,certification_end_date,certification_status,care_level,insurer_number,insured_number,care_office_id", `&office_id=eq.${CS}`);
snap.assign = await all("client_office_assignments", "id,client_id,office_id,end_date", `&office_id=eq.${CS}`);
snap.care_offices = await all("care_offices", "id,name,office_number");
snap.care_managers = await all("care_managers", "id,name,care_office_id");
snap.orders = await all("orders", "id,client_id,office_id,payment_type", `&office_id=eq.${CS}`);
const oids = snap.orders.map((o) => o.id);
snap.items = [];
for (let i = 0; i < oids.length; i += 150) {
  snap.items.push(...await all("order_items", "id,order_id,product_code,quantity,status,rental_start_date,rental_end_date", `&order_id=in.(${oids.slice(i, i + 150).join(",")})`));
}
snap.equipment = await all("equipment_master", "id,product_code,tais_code,name,rental_price");
// 負担割合の照合用 (旧 snap2.mjs)
snap.benefit = await all("client_benefit_certificates", "id,client_id,kind,benefit_rate,valid_from,valid_to,office_id", `&office_id=eq.${CS}`);
snap.certRates = await all("client_insurance_records", "id,benefit_rate,copay_rate", `&office_id=eq.${CS}`);
snap.clientRates = await all("clients", "id,benefit_rate,copay_rate", "");
snap.takenAt = new Date().toISOString();
snap.office = { bn: FO.bn, area: FO.area, officeId: FO.officeId }; // match.mjs が 照合の事業所と同じか確かめる
fs.mkdirSync(dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snap));
console.log("done", ((Date.now() - t0) / 1000).toFixed(1) + "s", "→", OUT);
