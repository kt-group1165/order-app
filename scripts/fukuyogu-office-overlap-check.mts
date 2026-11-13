/**
 * 福祉用具: 新しく受け入れる事業所 (例 誉田) のほのぼのデータが「どの事業所番号で請求されているか」と
 * 「ケアサポのデータ・DB に同じ利用者が既に入っていないか」を見る — ★ READ ONLY (DB は SELECT だけ)
 *
 *   npx tsx scripts/fukuyogu-office-overlap-check.mts --area 誉田 [--db-cache <json>] [--refresh] [--show 30]
 *
 * 入力 (置き場 = apps/kaigo-app/伝送データ/<area>/福祉用具/。migrations/_fukuyogu_office.mjs):
 *   <YYYYMM>/ほのぼのから/KDS0031_*.CSV (明細書明細付) / 用具貸与期間_*\/提供票_*.csv / 利用者マスタ_*\/介護保険_*.CSV
 *   どれも無ければ「未着」と出して exit 0 (PASS ではない)。
 *
 * (i)  請求の事業所番号: KDS の 事業所番号 列・提供票の 事業所番号/事業所名 の内訳。
 *      その事業所の番号 → 自前で請求している / ケアサポ 1272400050 → ケアサポとして請求されている利用者の一部。
 * (ii) 重なり: その事業所の利用者を ケアサポのほのぼのデータ (KDS 全月・KK・利用者マスタ・提供票) と突き合わせる。
 *      キー = (被保番, 生年月日) / (氏名, 生年月日) / 利用者番号 (同じほのぼの DB なら番号は共通の可能性。参考)
 *      ★ 保険者は ほのぼの利用者マスタが「名前」(市原市) で持つので キーに入れない。被保番は保険者の中でしか一意でないため 生年月日 と組む。
 *      重なった人は DB でも引き (clients / 認定の 被保番+生年月日)、割当 (client_office_assignments)・発注 (orders.office_id) の事業所を出す。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readKds0031, C, parseCsvLine, loadSnapshot, nName, nDate, ymOf } from "./_honobono-sync-core.mjs";
import { resolveFukuyoguOffice, fukuyoguDir, FUKUYOGU_OFFICES, DEFAULT_FUKUYOGU_BN } from "../migrations/_fukuyogu_office.mjs";

const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
if (!opt("--area") && !opt("--office-bn")) { console.error("usage: npx tsx scripts/fukuyogu-office-overlap-check.mts --area <拠点> (例 誉田)"); process.exit(1); }
const office = resolveFukuyoguOffice(argv);
const SHOW = Number(opt("--show") ?? 20);
const caresapo = FUKUYOGU_OFFICES.find((o) => o.bn === DEFAULT_FUKUYOGU_BN)!;
if (office.bn === caresapo.bn) { console.error("★ ケアサポ自身とは突き合わせられない (--area に受け入れる事業所を指定)"); process.exit(1); }
const CS_DIR = fukuyoguDir(caresapo.area);

type Person = { src: string; userNo: string; name: string; birth: string; insured: string; insurer: string };
const sjis = (p: string) => new TextDecoder("shift-jis").decode(readFileSync(p)).split(/\r?\n/).filter((l) => l.length > 0).map(parseCsvLine);
const subdirs = (base: string, re: RegExp) => (existsSync(base) ? readdirSync(base).filter((d) => re.test(d)).sort() : []);

/** 置き場から人を集める。kds は (i) 用の 事業所番号 の内訳も返す */
function collect(base: string) {
  const people: Person[] = [];
  const kdsBn = new Map<string, number>(), teikyoBn = new Map<string, number>(), files: string[] = [];
  for (const ym of subdirs(base, /^\d{6}$/)) {
    const d = join(base, ym, "ほのぼのから");
    for (const f of existsSync(d) ? readdirSync(d) : []) {
      if (/^KDS0031_.*\.csv$/i.test(f)) {
        const { rows } = readKds0031(join(d, f));
        files.push(`${ym}/${f}`);
        for (const r of rows) {
          kdsBn.set(r[C.PROVIDER], (kdsBn.get(r[C.PROVIDER]) ?? 0) + 1);
          people.push({ src: `KDS ${ymOf(r[C.SVC_MONTH])}`, userNo: r[C.USER_NO].trim(), name: r[C.NAME], birth: nDate(r[C.BIRTH]), insured: r[C.INSURED].trim(), insurer: r[C.INSURER].replace(/\D/g, "") });
        }
      } else if (/^KK\d+\.csv$/i.test(f)) {
        files.push(`${ym}/${f}`);
        for (const l of readFileSync(join(d, f), "latin1").split(/\r?\n/)) {
          const v = l.split(",").slice(2).map((s) => s.replace(/^"(.*)"$/, "$1"));
          if (v[1] !== "01" || (v[0] !== "7131" && v[0] !== "7132")) continue;
          const b = v[12] ?? "";
          people.push({ src: `KK ${ym}`, userNo: "", name: "", birth: b.length === 8 ? `${b.slice(0, 4)}-${b.slice(4, 6)}-${b.slice(6, 8)}` : "", insured: v[5], insurer: v[4].replace(/^00/, "") });
        }
      }
    }
  }
  for (const td of subdirs(base, /^用具貸与期間_\d{8}$/)) {
    for (const f of readdirSync(join(base, td)).filter((x) => /^提供票_\d{6}\.csv$/i.test(x))) {
      const rows = sjis(join(base, td, f));
      const h = rows[0];
      const iBn = h.indexOf("事業所番号"), iNm = h.indexOf("事業所名"), iNo = h.indexOf("利用者番号"), iName = h.indexOf("利用者名");
      files.push(`${td}/${f}`);
      for (const r of rows.slice(1)) {
        const k = `${r[iBn]} ${r[iNm]}`;
        teikyoBn.set(k, (teikyoBn.get(k) ?? 0) + 1);
        people.push({ src: `提供票 ${f.slice(4, 10)}`, userNo: (r[iNo] ?? "").trim(), name: r[iName] ?? "", birth: "", insured: "", insurer: "" });
      }
    }
  }
  for (const um of subdirs(base, /^利用者マスタ_(全件_)?\d{8}$/)) {
    for (const f of readdirSync(join(base, um)).filter((x) => /^介護保険_.*\.csv$/i.test(x))) {
      const rows = sjis(join(base, um, f));
      const h = rows[0];
      const iNo = h.indexOf("利用者番号"), iName = h.indexOf("利用者名"), iB = h.indexOf("生年月日"), iIns = h.indexOf("被保険者番号");
      files.push(`${um}/${f}`);
      for (const r of rows.slice(1)) people.push({ src: `${um}`, userNo: (r[iNo] ?? "").trim(), name: r[iName] ?? "", birth: nDate(r[iB]), insured: (r[iIns] ?? "").trim(), insurer: "" });
    }
  }
  return { people, kdsBn, teikyoBn, files };
}

const kInsBirth = (p: Person) => (p.insured && p.birth ? `${p.insured.normalize("NFKC").toUpperCase()}|${p.birth}` : null);
const kNameBirth = (p: Person) => (p.name && p.birth ? `${nName(p.name)}|${p.birth}` : null);

async function main() {
  console.log(`受け入れる事業所: ${office.area} ${office.bn} ${office.name}\n置き場: ${office.dir}`);
  const A = collect(office.dir);
  if (A.files.length === 0) {
    console.log(`\n未着: ${office.area} の置き場に KDS0031 / KK / 提供票 / 利用者マスタ が 1 本も無い — 測れていない (PASS ではない)`);
    process.exit(0);
  }
  console.log(`読んだファイル ${A.files.length} 本: ${A.files.join(" / ")}`);

  // (i)
  console.log("\n══ (i) 請求の事業所番号 ══");
  const tag = (bn: string) => (bn === office.bn ? `= ${office.area} (自前)` : bn === caresapo.bn ? "= ★ ケアサポ番号" : "= ★ 別の番号");
  if (A.kdsBn.size === 0) console.log("  KDS0031: 未着");
  for (const [bn, n] of A.kdsBn) console.log(`  KDS0031 事業所番号 ${bn} ${tag(bn)}: ${n} 行`);
  if (A.teikyoBn.size === 0) console.log("  提供票: 未着");
  for (const [k, n] of A.teikyoBn) console.log(`  提供票 ${k} ${tag(k.split(" ")[0])}: ${n} 行`);

  // (ii)
  const B = collect(CS_DIR);
  console.log(`\n══ (ii) ケアサポのほのぼのデータとの重なり (ケアサポ側 ${B.files.length} 本) ══`);
  const index = (ps: Person[], key: (p: Person) => string | null) => {
    const m = new Map<string, Person[]>();
    for (const p of ps) { const k = key(p); if (!k) continue; if (!m.has(k)) m.set(k, []); m.get(k)!.push(p); }
    return m;
  };
  const aPeople = new Map<string, Person>(); // 人 = 被保番+生年月日 → 無ければ 氏名+生年月日 → 無ければ 利用者番号+氏名
  for (const p of A.people) { const k = kInsBirth(p) ?? kNameBirth(p) ?? `N:${p.userNo}|${nName(p.name)}`; if (!aPeople.has(k)) aPeople.set(k, p); }
  const bIns = index(B.people, kInsBirth), bName = index(B.people, kNameBirth), bNo = index(B.people, (p) => (p.userNo ? p.userNo : null));
  let hitIns = 0, hitName = 0, hitNoOnly = 0;
  const hits: { p: Person; how: string; cs: Person }[] = [];
  for (const p of aPeople.values()) {
    const ki = kInsBirth(p), kn = kNameBirth(p);
    const bi = ki ? bIns.get(ki) : undefined, bn = kn ? bName.get(kn) : undefined;
    if (bi) { hitIns++; hits.push({ p, how: "被保番+生年月日", cs: bi[0] }); }
    else if (bn) { hitName++; hits.push({ p, how: "氏名+生年月日", cs: bn[0] }); }
    else if (p.userNo && bNo.get(p.userNo)?.some((x) => !x.name || !p.name || nName(x.name) === nName(p.name))) { hitNoOnly++; hits.push({ p, how: "利用者番号 (+氏名) のみ", cs: bNo.get(p.userNo)![0] }); }
  }
  console.log(`  ${office.area} の利用者 ${aPeople.size} 名 (データの和集合)`);
  console.log(`  ケアサポ側にも居る: 被保番+生年月日 ${hitIns} 名 / 氏名+生年月日 ${hitName} 名 / 利用者番号のみ (参考) ${hitNoOnly} 名`);
  for (const h of hits.slice(0, SHOW)) console.log(`    - [${h.how}] ${h.p.name || "(氏名なし)"} ${h.p.birth} 被保番${h.p.insured || "-"} (${h.p.src}) ↔ ケアサポ ${h.cs.src}`);

  // DB: 重なった人と、受け入れる事業所の全員を DB で引く
  const month = [...A.kdsBn.keys()].length ? (A.people.filter((p) => p.src.startsWith("KDS")).map((p) => p.src.slice(4)).sort().pop() ?? "2026-10") : "2026-10";
  const snap = await loadSnapshot(month, opt("--db-cache") ?? join(tmpdir(), `fukuyogu-densou-db-${month}.json`), argv.includes("--refresh"));
  const dbByIns = new Map<string, Set<string>>();
  const addDb = (insured: string | null, birth: string | null, cid: string) => {
    if (!insured || !birth) return; const k = `${insured.normalize("NFKC").trim().toUpperCase()}|${birth.slice(0, 10)}`;
    if (!dbByIns.has(k)) dbByIns.set(k, new Set()); dbByIns.get(k)!.add(cid);
  };
  const birthOf = new Map(snap.clients.map((c) => [c.id, c.birth_date]));
  for (const c of snap.clients) if (!c.deleted_at) addDb(c.insured_number, c.birth_date, c.id);
  for (const r of snap.ins) addDb(r.insured_number, r.birth_date ?? birthOf.get(r.client_id) ?? null, r.client_id);
  const offName = new Map(snap.offices.map((o) => [o.id, (o as { short_name?: string }).short_name ?? o.name]));
  const coaBy = new Map<string, string[]>();
  for (const a of snap.coa ?? []) if (!a.end_date) { if (!coaBy.has(a.client_id)) coaBy.set(a.client_id, []); coaBy.get(a.client_id)!.push(a.office_id); }
  const orderOffBy = new Map<string, Map<string, number>>();
  for (const o of snap.orders) { if (!o.client_id) continue; const m = orderOffBy.get(o.client_id) ?? new Map(); m.set(o.office_id ?? "null", (m.get(o.office_id ?? "null") ?? 0) + 1); orderOffBy.set(o.client_id, m); }
  let inDb = 0, inDbCs = 0, inDbSelf = 0;
  const dbEx: string[] = [];
  for (const p of aPeople.values()) {
    const k = kInsBirth(p);
    const cids = k ? dbByIns.get(k) : undefined;
    if (!cids?.size) continue;
    inDb++;
    const cid = [...cids][0];
    const coa = coaBy.get(cid) ?? [];
    if (coa.includes(caresapo.officeId)) inDbCs++;
    if (coa.includes(office.officeId)) inDbSelf++;
    if (dbEx.length < SHOW) dbEx.push(`${p.name || "(氏名なし)"} ${p.birth} → client ${cid}${cids.size > 1 ? ` (他 ${cids.size - 1} 件)` : ""} 割当 [${coa.map((x) => offName.get(x) ?? x).join(",")}] 発注 [${[...(orderOffBy.get(cid) ?? new Map())].map(([o, n]) => `${offName.get(o) ?? o}:${n}`).join(",")}]`);
  }
  console.log(`\n══ DB (READ ONLY・控え ${snap.fetchedAt}) ══`);
  console.log(`  ${office.area} の利用者のうち DB に (被保番, 生年月日) で居る: ${inDb} / ${aPeople.size} 名 — 割当が ケアサポ ${inDbCs} 名 / ${office.area} ${inDbSelf} 名`);
  for (const x of dbEx) console.log(`    - ${x}`);
  console.log(`\n読み方: (i) が ${office.area} の番号で (ii) の重なりが 0 → 二重の心配なし (新規の移行)。`
    + ` (i) がケアサポ番号 / (ii) の重なりが多い → ケアサポとして入っている利用者の付け替えの話 (移行ではない)。`);
}
main().catch((e) => { console.error(e); process.exit(1); });
