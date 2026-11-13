/**
 * 利用終了者 (ほのぼのの利用登録が無い人) の 事業所割当 (client_office_assignments) に 利用期間を入れる (2026-11-14)
 *   sync_fukuyogu_from_honobono.mjs は 新規利用者の割当を 提供月の 1 日から・終了日なしで作る。
 *   利用終了者を足したとき そのままだと「ずっと現利用者」として 自事業所の一覧・利用者数に数えられるので、
 *   提供票 (入力側・日ごとの実績) の 最初に借りた日 → 最後に借りた日 で 割当の期間を直す。
 *
 *   node migrations/fix_former_user_assignment_period.mjs --area 誉田 --users <利用者番号を 1 行 1 つ書いたファイル>            DRY RUN
 *   node migrations/fix_former_user_assignment_period.mjs --area 誉田 --users <file> --execute --expect <件数>                 本番
 *
 * 対象 = --users の利用者で、その事業所の割当が ちょうど 1 行 (終了日なし) あるもの。
 *   start_date = 提供票で最初に印がある日 (提供票の最初の月の 1 日から印があれば その月の 1 日)
 *   end_date   = 提供票で最後に印がある日
 *   提供票に実績が無い・割当が 0 行/2 行以上 は書かずに一覧に出す。
 * 書く前の行は migrations/_backup_former_assignment_<時刻ミリ秒>.json に退避。1 行ずつ update して件数 1 を確かめる。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFukuyoguOffice, latestTeikyoDir } from "./_fukuyogu_office.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const EXECUTE = argv.includes("--execute");
const FO = resolveFukuyoguOffice(argv);
const USERS = opt("--users");
if (!USERS) { console.error("usage: --area <拠点> --users <利用者番号のファイル> [--execute --expect <件数>]"); process.exit(1); }
const want = new Set(readFileSync(USERS, "utf8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean));

// 提供票 (実績行) から 利用者ごとの 最初・最後に印がある日
const dir = latestTeikyoDir(FO.dir);
const parseLine = (line) => { const o = []; let c = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (q) { if (ch === '"') { if (line[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } o.push(c); return o; };
const span = new Map();
for (const f of readdirSync(dir).filter((x) => /^提供票_\d{6}\.csv$/i.test(x)).sort()) {
  const lines = new TextDecoder("shift-jis").decode(readFileSync(join(dir, f))).split(/\r?\n/).filter(Boolean);
  const h = parseLine(lines[0]); const ix = (k) => h.indexOf(k);
  for (const l of lines.slice(1)) {
    const r = parseLine(l);
    const no = r[ix("利用者番号")]; if (!want.has(no) || r[ix("予定／実績")] !== "実績") continue;
    const [y, m] = r[ix("提供年月")].split("/");
    for (let d = 1; d <= 31; d++) {
      if (!Number(r[ix(`${d}日`)] || 0)) continue;
      const day = `${y}-${m}-${String(d).padStart(2, "0")}`;
      const s = span.get(no) ?? { first: day, last: day };
      if (day < s.first) s.first = day; if (day > s.last) s.last = day;
      span.set(no, s);
    }
  }
}

const env = Object.fromEntries(readFileSync(join(HERE, "..", "..", "kaigo-app", ".env.local"), "utf8").split(/\r?\n/)
  .filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }));
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const nums = [...want];
const clients = [];
for (let i = 0; i < nums.length; i += 150) {
  const { data, error } = await sb.from("clients").select("id,user_number,name").eq("tenant_id", "kt-group").in("user_number", nums.slice(i, i + 150));
  if (error) throw new Error(`clients: ${error.message}`);
  clients.push(...data);
}
const assigns = [];
for (let i = 0; i < clients.length; i += 150) {
  const { data, error } = await sb.from("client_office_assignments").select("*").eq("office_id", FO.officeId).in("client_id", clients.slice(i, i + 150).map((c) => c.id));
  if (error) throw new Error(`client_office_assignments: ${error.message}`);
  assigns.push(...data);
}
const plan = [], skip = [];
for (const no of nums) {
  const c = clients.find((x) => x.user_number === no);
  if (!c) { skip.push({ 利用者番号: no, 理由: "clients に居ない (同期で作られていない)" }); continue; }
  const s = span.get(no);
  if (!s) { skip.push({ 利用者番号: no, 氏名: c.name, 理由: "提供票に実績が無い" }); continue; }
  const as = assigns.filter((a) => a.client_id === c.id);
  const open = as.filter((a) => !a.end_date);
  if (as.length !== 1 || open.length !== 1) { skip.push({ 利用者番号: no, 氏名: c.name, 理由: `割当が ${as.length} 行 (終了日なし ${open.length})` }); continue; }
  const a = open[0];
  if (a.start_date === s.first && a.end_date === s.last) continue;
  plan.push({ id: a.id, 利用者番号: no, 氏名: c.name, before: { start_date: a.start_date, end_date: a.end_date }, after: { start_date: s.first, end_date: s.last } });
}
console.log(`事業所 ${FO.area} / 対象 ${want.size} 名 / 提供票 ${dir}`);
console.log(`直す ${plan.length} 行 / 書かない ${skip.length}`);
for (const p of plan.slice(0, 5)) console.log(`  ${p.利用者番号} ${p.氏名}: ${p.before.start_date}〜${p.before.end_date ?? ""} → ${p.after.start_date}〜${p.after.end_date}`);
for (const s of skip) console.log(`  書かない ${JSON.stringify(s)}`);
console.log("  最後に借りた月:", JSON.stringify(plan.reduce((m, p) => { const k = p.after.end_date.slice(0, 7); m[k] = (m[k] ?? 0) + 1; return m; }, {})));
if (!EXECUTE) { console.log(`DRY RUN (書いていない)。本番: --execute --expect ${plan.length}`); process.exit(0); }
if (Number(opt("--expect")) !== plan.length) { console.error(`★ 止めた: 直す ${plan.length} 行が --expect ${opt("--expect")} と違う`); process.exit(2); }
const bk = join(HERE, `_backup_former_assignment_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(bk, JSON.stringify({ createdAt: new Date().toISOString(), area: FO.area, rows: plan }, null, 2));
console.log(`退避: ${bk}`);
let n = 0;
for (const p of plan) {
  const { data, error } = await sb.from("client_office_assignments").update(p.after).eq("id", p.id).is("end_date", null).select("id");
  if (error || data?.length !== 1) { console.error(`★ ${p.利用者番号}: ${error?.message ?? `更新 ${data?.length} 件`} (ここまで ${n} 行。退避 ${bk} の before で戻せる)`); process.exit(1); }
  n++;
}
console.log(`書いた: ${n} 行`);
