/**
 * check:futan-period の本体 (order-app / kaigo-app の検査 script の共用。★ READ ONLY)。
 *
 *   月ごとに「請求に出る利用者」について、
 *     ① 負担割合証が無いまま認定行の値で請求した件数   (source = cert_row)
 *     ② 負担割合証も認定行の割合も無い件数              (source = none)
 *     ③ 認定行の割合 と その月の負担割合証 が食い違う件数 (= 負担割合証を入れたことで給付率が変わる人)
 *     ④ 月の途中で負担割合証が切り替わる件数
 *   を数え、基準値 (json) より増えたら FAIL (基準値方式。0 を目指さない)。
 *   規則は共通の純関数 lib/insurance/cert-month.ts (resolveBenefitForMonth / pickCertForMonth)。
 *
 *   負担割合証の出どころ:
 *     db  = client_benefit_certificates (適用済みならこちら)
 *     csv = 表が未作成のとき、ほのぼのの負担割合証等 CSV をメモリ上で同じ形にしたもの (取込前の見込み)
 *   ★ 基準値は出どころごとに持つ。出どころが変わったら比較しない (exit 0・合格ではない)。
 *
 *   負のコントロール: 1 人ぶん負担割合証の給付率をわざと変えて ③ が 1 増えることを毎回確かめる。
 *   増えなければ「検査が効いていない」として FAIL。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  resolveBenefitForMonth, pickCertForMonth, type BenefitCertRow, type CertRowForBenefit,
} from "../lib/insurance/cert-month";

type Sb = import("@supabase/supabase-js").SupabaseClient;

/** service_role で読む (kaigo-app/.env.local)。無ければ null */
export async function serviceClient(envPaths: string[]): Promise<Sb | null> {
  const env: Record<string, string> = {};
  for (const p of envPaths) {
    let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
    for (const l of t.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

export async function selectAll<T>(sb: Sb, table: string, select: string, build: (q: any) => any = (q) => q): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw Object.assign(new Error(`${table}: ${error.message}`), { code: error.code });
    out.push(...(data as T[]));
    if (data.length < 1000) return out;
  }
}
export async function selectIn<T>(sb: Sb, table: string, select: string, col: string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  const u = [...new Set(ids)];
  for (let i = 0; i < u.length; i += 150) out.push(...await selectAll<T>(sb, table, select, (q) => q.in(col, u.slice(i, i + 150))));
  return out;
}

// office_id: 事業所別保険で 請求と同じ範囲に絞るため (order-app futan-period-check.mts。2026-11-13)
const CERT_ROW_COLS = "id,client_id,certification_start_date,certification_end_date,effective_date,copay_rate,benefit_rate,care_level,service_limit_amount,insurer_number,insured_number,office_id";
type CirRow = CertRowForBenefit & { client_id: string; insurer_number: string | null; insured_number: string | null };

/** 認定行 (全世代) を client ごとに */
export async function loadCertRows(sb: Sb, ids: string[]): Promise<Map<string, CertRowForBenefit[]>> {
  const m = new Map<string, CertRowForBenefit[]>();
  for (const r of await selectIn<CirRow>(sb, "client_insurance_records", CERT_ROW_COLS, "client_id", ids)) {
    if (!m.has(r.client_id)) m.set(r.client_id, []);
    m.get(r.client_id)!.push(r);
  }
  return m;
}

/**
 * 負担割合証: 表があれば表 (db)、未作成なら CSV をメモリ上で同じ形に (csv)。
 * CSV の (保険者番号, 被保番) → 利用者 は 認定行と clients の番号で引く (取込 script と同じ。複数に当たる番号は捨てる)。
 */
export async function loadBenefitCertsDbOrCsv(
  sb: Sb, ids: string[], csvSets: { futan: string; ins: string[]; label: string }[],
): Promise<{ source: "db" | "csv"; byClient: Map<string, BenefitCertRow[]>; note: string }> {
  try {
    // 表があるかを先に聞く (対象 0 名だと selectIn は問い合わせないので、未作成でも db に見えてしまう)
    const probe = await sb.from("client_benefit_certificates").select("id").limit(1); // head だと 404 の code が取れない
    if (probe.error) throw Object.assign(new Error(probe.error.message), { code: probe.error.code });
    const rows = await selectIn<BenefitCertRow & { client_id: string }>(sb, "client_benefit_certificates", "id,client_id,kind,benefit_rate,valid_from,valid_to,office_id,restriction", "client_id", ids);
    const m = new Map<string, BenefitCertRow[]>();
    for (const r of rows) { if (!m.has(r.client_id)) m.set(r.client_id, []); m.get(r.client_id)!.push(r); }
    return { source: "db", byClient: m, note: `client_benefit_certificates ${rows.length} 行` };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "PGRST205" && code !== "42P01") throw e;
  }
  const { readBenefitCsv, nInsurer, nInsured } = await import("./_benefit-cert-csv.mjs");
  const key = new Map<string, Set<string>>();
  const add = (a: string | null, b: string | null, cid: string) => {
    if (!b) return;
    const k = `${nInsurer(a)}|${nInsured(b)}`;
    if (!key.has(k)) key.set(k, new Set());
    key.get(k)!.add(cid);
  };
  for (const r of await selectIn<CirRow>(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number", "client_id", ids)) add(r.insurer_number, r.insured_number, r.client_id);
  for (const c of await selectIn<{ id: string; insurer_number: string | null; insured_number: string | null }>(sb, "clients", "id,insurer_number,insured_number", "id", ids)) add(c.insurer_number, c.insured_number, c.id);
  const m = new Map<string, BenefitCertRow[]>();
  const seen = new Set<string>();
  let n = 0;
  for (const s of csvSets) {
    for (const e of readBenefitCsv(s.futan, s.ins).entries) {
      const cs = key.get(`${e.insurer}|${e.insured}`);
      if (!cs || cs.size !== 1) continue;
      const cid = [...cs][0];
      const k = `${cid}|${e.kind}|${e.rate}|${e.from}|${e.to ?? ""}`;
      if (seen.has(k)) continue; // 2 つの CSV に同じ証 (事業所違いで 2 行入っても解決は同じ)
      seen.add(k);
      if (!m.has(cid)) m.set(cid, []);
      m.get(cid)!.push({ kind: e.kind, benefit_rate: e.rate, valid_from: e.from, valid_to: e.to, restriction: e.restriction, id: `csv:${s.label}:${e.line}` });
      n++;
    }
  }
  return { source: "csv", byClient: m, note: `★ 表が未作成のため CSV (${csvSets.map((s) => s.label).join(" + ")}) をメモリ上で ${n} 件 = 取込後の見込み` };
}

export type FutanPeriodConfig = {
  app: string;
  months: string[];
  baselinePath: string;
  update: boolean;
  /** その月に請求に出る利用者 */
  targets: (month: string) => Promise<Map<string, string>>; // client_id → 表示名
  certRows: (clientIds: string[]) => Promise<Map<string, CertRowForBenefit[]>>;
  benefitCerts: (clientIds: string[]) => Promise<{ source: "db" | "csv"; byClient: Map<string, BenefitCertRow[]>; note: string }>;
  /** 認定行の割合 (給付率)。kaigo は従来 copay_rate で請求していたので copay を、order は benefit_rate を優先 */
  certRowRate: (row: CertRowForBenefit | null) => number | null;
};

type Counts = { billed: number; withCert: number; noCertUsedRow: number; none: number; mismatch: number; split: number };

const monthRange = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return { ms: `${ym}-01`, me: `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}` };
};

function count(
  targets: Map<string, string>, rowsBy: Map<string, CertRowForBenefit[]>, certsBy: Map<string, BenefitCertRow[]>,
  ym: string, certRowRate: FutanPeriodConfig["certRowRate"],
): { c: Counts; mismatchList: string[]; noCertList: string[] } {
  const { ms, me } = monthRange(ym);
  const c: Counts = { billed: targets.size, withCert: 0, noCertUsedRow: 0, none: 0, mismatch: 0, split: 0 };
  const mismatchList: string[] = [], noCertList: string[] = [];
  for (const [cid, name] of targets) {
    const rows = rowsBy.get(cid) ?? [];
    const r = resolveBenefitForMonth(rows, certsBy.get(cid) ?? [], ms, me);
    if (r.source === "certificate") {
      c.withCert++;
      if (r.splitInMonth) c.split++;
      const picked = pickCertForMonth(rows, ms, me);
      const rowRate = certRowRate(picked?.row ?? null);
      if (rowRate !== r.benefitRate) {
        c.mismatch++;
        mismatchList.push(`${name}: 認定行 ${rowRate ?? "なし"} → 負担割合証 ${r.benefitRate} (${r.periodFrom}〜${r.periodTo ?? ""})`);
      }
    } else if (r.source === "cert_row") { c.noCertUsedRow++; noCertList.push(`${name} (認定行 ${r.benefitRate})`); }
    else c.none++;
  }
  return { c, mismatchList, noCertList };
}

export async function runFutanPeriod(cfg: FutanPeriodConfig): Promise<void> {
  type Baseline = { _readme: string[]; source: string; asOf: string; months: Record<string, Counts> };
  const current: Record<string, Counts> = {};
  let source = "";
  let ncOk = true;
  for (const ym of cfg.months) {
    const targets = await cfg.targets(ym);
    const ids = [...targets.keys()];
    const rowsBy = await cfg.certRows(ids);
    const b = await cfg.benefitCerts(ids);
    if (source && source !== b.source) throw new Error("★ 月の途中で負担割合証の出どころが変わった");
    source = b.source;
    const { c, mismatchList, noCertList } = count(targets, rowsBy, b.byClient, ym, cfg.certRowRate);
    current[ym] = c;
    console.log(`\n══ ${cfg.app} ${ym} (負担割合証の出どころ: ${b.source} — ${b.note}) ══`);
    console.log(`  請求に出る利用者 ${c.billed} 名 (母数 = この app の請求対象。下の script 冒頭を参照)`);
    console.log(`  負担割合証あり ${c.withCert} 名 / うち ★ 認定行の割合と食い違う ${c.mismatch} 名 / 月途中で切替 ${c.split} 名`);
    console.log(`  ★ 負担割合証なしで認定行の値で請求 ${c.noCertUsedRow} 名 / 割合なし ${c.none} 名`);
    for (const l of mismatchList.slice(0, 15)) console.log(`     ≠ ${l}`);
    if (mismatchList.length > 15) console.log(`     … 他 ${mismatchList.length - 15} 名`);
    for (const l of noCertList.slice(0, 5)) console.log(`     証なし ${l}`);
    if (noCertList.length > 5) console.log(`     … 他 ${noCertList.length - 5} 名`);

    // 負のコントロール: 負担割合証のある 1 人の給付率をわざと変える → ③ が 1 増えるはず
    const victim = ids.find((id) => (b.byClient.get(id) ?? []).some((x) => x.kind === "介護保険負担割合証"));
    if (victim) {
      const broken = new Map(b.byClient);
      const { ms, me } = monthRange(ym);
      const r0 = resolveBenefitForMonth(rowsBy.get(victim) ?? [], b.byClient.get(victim) ?? [], ms, me);
      const rowRate = cfg.certRowRate(pickCertForMonth(rowsBy.get(victim) ?? [], ms, me)?.row ?? null);
      const wasMismatch = r0.source === "certificate" && rowRate !== r0.benefitRate;
      const fake = rowRate === 50 ? 60 : 50; // 実在しない給付率
      broken.set(victim, [{ kind: "介護保険負担割合証", benefit_rate: fake, valid_from: ms, valid_to: me, id: "negative-control" }]);
      const n = count(targets, rowsBy, broken, ym, cfg.certRowRate).c.mismatch;
      const want = c.mismatch + (wasMismatch ? 0 : 1);
      if (n !== want) { ncOk = false; console.log(`  ★ 負のコントロール失敗: わざと食い違わせたのに ③ が ${c.mismatch} → ${n} (期待 ${want})`); }
      else console.log(`  負のコントロール OK (わざと食い違わせると ③ が ${c.mismatch} → ${n})`);
    } else console.log("  (負担割合証のある利用者がいないので負のコントロールは回せない)");
  }
  if (!ncOk) { console.log("\n★ FAIL — 検査が効いていない"); process.exit(1); }

  const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; })();
  const baseline: Baseline | null = existsSync(cfg.baselinePath) ? JSON.parse(readFileSync(cfg.baselinePath, "utf8")) : null;
  if (cfg.update || !baseline) {
    const out: Baseline = {
      _readme: baseline?._readme ?? [
        `npm run check:futan-period (${cfg.app}) の基準値。基準値方式 (増えたら FAIL・0 を目指さない)。`,
        "■ なぜこの数か: (--update 後に json 側で書くこと)",
      ],
      source, asOf: today, months: current,
    };
    writeFileSync(cfg.baselinePath, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`\n--update: 基準値を書きました (${cfg.baselinePath})。⚠ 件数が変わったなら _readme の「なぜこの数か」を書き直すこと`);
    return;
  }
  if (baseline.source !== source) {
    console.log(`\n⚠ 基準値は 出どころ=${baseline.source} のもの。今回は ${source} なので比べない (exit 0・★ 合格ではない)。`);
    console.log(`  表を適用して取込んだら、中身を確認のうえ --update で ${source} の基準値に置き換える`);
    return;
  }
  const keys: (keyof Counts)[] = ["noCertUsedRow", "none", "mismatch", "split"];
  let worse = false, improved = false;
  console.log(`\n══ 基準値比較 (${baseline.asOf}) ══`);
  for (const ym of cfg.months) {
    const b = baseline.months[ym];
    if (!b) { console.log(`  ${ym}: 基準値なし (比べない)`); continue; }
    for (const k of keys) {
      if (current[ym][k] > b[k]) { worse = true; console.log(`  ★ ${ym} ${k}: ${b[k]} → ${current[ym][k]}`); }
      else if (current[ym][k] < b[k]) { improved = true; console.log(`  ${ym} ${k}: ${b[k]} → ${current[ym][k]} (減った)`); }
    }
  }
  if (worse) { console.log("\n★ FAIL — 基準値より増えた。中身を確認すること"); process.exit(1); }
  console.log(`\n✓ PASS — 基準値より増えていない${improved ? " (減った項目あり。確認のうえ --update で下げてよい)" : ""}`);
}
