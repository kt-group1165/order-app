/**
 * 負担割合証等 CSV → client_benefit_certificates の取込エンジン (order / kaigo の取込 script の共用)。
 *
 *   DRY RUN が既定。--execute で INSERT、--revert <batch_id> [--execute] で取り消し。
 *   書いた行は全部 data_import_batches / data_import_rows に記録する (書けなければその場で止める)。
 *   ★ 認定行 (client_insurance_records) は一切書き換えない。
 *   ★ 既に同じ証 (client, kind, 開始, 終了, 給付率, office) がある行は入れない (冪等)。
 *   ★ 1 つの (保険者, 被保番) が複数の利用者に当たるときは入れない (別人に付けない)。
 *   ★ insert は全行で同じキー集合 (memory feedback_batch_insert_key_mismatch_null_fill)。
 *   ★ ページングは order(id) 付き / .in() は 150 件ずつ。
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBenefitCsv, nInsurer, nInsured, type BenefitCsvEntry } from "./_benefit-cert-csv.mjs";

export const TENANT = "kt-group";
const TABLE = "client_benefit_certificates";

type Sb = import("@supabase/supabase-js").SupabaseClient;

export type OfficeDecision = { officeId: string | null; officeSource: string | null };

export type ImportConfig = {
  label: string;               // 表示名 (ケアサポ / 全社)
  scriptRel: string;           // data_import_batches.script
  sourceSystem: string;        // honobono-fukuyogu / honobono-kaigo
  marker: string;              // notes に入れる文字列
  futanCsv: string;
  kaigoInsCsvs: string[];
  /** 利用者 → 事業所 (DESIGN_INSURANCE_PER_OFFICE.md §5.2 と同じ考え方)。clientIds 全員ぶんを返す */
  decideOffices: (sb: Sb, clientIds: string[]) => Promise<Map<string, OfficeDecision>>;
  argv: string[];
};

export function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, "../../kaigo-app/.env.local"), join(here, "../.env.local")]) {
    let t = ""; try { t = readFileSync(p, "utf8"); } catch { continue; }
    for (const l of t.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const chunks = <T,>(a: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

export async function selectAll<T>(sb: Sb, table: string, select: string, build: (q: any) => any = (q) => q): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw Object.assign(new Error(`${table}: ${error.message}`), { code: error.code });
    out.push(...(data as T[]));
    if (data.length < 1000) return out;
  }
}
export async function selectIn<T>(sb: Sb, table: string, select: string, col: string, ids: string[], build: (q: any) => any = (q) => q): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...await selectAll<T>(sb, table, select, (q) => build(q.in(col, c))));
  return out;
}

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const certKey = (x: { client_id: string; kind: string; valid_from: string; valid_to: string | null; benefit_rate: number | null; office_id: string | null }) =>
  `${x.client_id}|${x.kind}|${x.valid_from}|${x.valid_to ?? ""}|${x.benefit_rate ?? ""}|${x.office_id ?? ""}`;

export async function runBenefitCertImport(cfg: ImportConfig): Promise<void> {
  const argv = cfg.argv;
  const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
  const EXECUTE = argv.includes("--execute");
  const REVERT = opt("--revert");
  const OUT = opt("--out");
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ── 取り消し ─────────────────────────────────────────────────────────────
  if (REVERT) {
    const recs = await selectAll<{ row_id: string; op: string; table_name: string }>(sb, "data_import_rows", "id,row_id,op,table_name", (q) => q.eq("batch_id", REVERT));
    const ins = recs.filter((r) => r.op === "insert" && r.table_name === TABLE);
    const still = await selectIn<{ id: string }>(sb, TABLE, "id", "id", ins.map((r) => r.row_id));
    console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 取り消し batch ${REVERT}: 記録 ${recs.length} 行 / うち ${TABLE} の insert ${ins.length} 行 (現存 ${still.length} 行) を DELETE`);
    if (!EXECUTE) { console.log("  (DRY RUN。実行は --execute)"); return; }
    let n = 0;
    for (const c of chunks(still.map((r) => r.id), 150)) {
      const { error, count } = await sb.from(TABLE).delete({ count: "exact" }).in("id", c);
      if (error) throw new Error(`revert delete: ${error.message}`);
      n += count ?? 0;
    }
    const { error } = await sb.from("data_import_batches").update({ status: n === ins.length ? "reverted" : "partially_reverted", reverted_at: new Date().toISOString() }).eq("id", REVERT);
    if (error) throw new Error(`data_import_batches: ${error.message}`);
    console.log(`  削除 ${n} 行 / 記録 ${ins.length} 行`);
    console.log(`  確認 SQL: SELECT count(*) FROM ${TABLE} WHERE notes LIKE '%${cfg.marker}%';`);
    return;
  }

  // ── CSV ─────────────────────────────────────────────────────────────────
  for (const p of [cfg.futanCsv, ...cfg.kaigoInsCsvs]) if (!existsSync(p)) throw new Error(`★ ファイルが無い: ${p}`);
  const { entries, stats } = readBenefitCsv(cfg.futanCsv, cfg.kaigoInsCsvs);
  const people = new Set(entries.map((e) => `${e.insurer}|${e.insured}`));
  console.log(`══ ${cfg.label}: 負担割合証等 CSV ══`);
  console.log(`  ${cfg.futanCsv}`);
  console.log(`  データ行 ${stats.rows} / 給付種類が空 ${stats.blankKind} / 適用でない ${stats.notApplied} / 開始日なし ${stats.noFrom} / 期間逆転 ${stats.badPeriod} / 給付率不正 ${stats.badRate}`);
  console.log(`  保険者名→番号: 本人の介護保険行で ${stats.insurerViaPerson} / 名前で一意に ${stats.insurerViaName} / ★ 決まらず ${stats.insurerUnresolved}${stats.unresolvedNames.size ? ` (${[...stats.unresolvedNames].map(([k, v]) => `${k}×${v}`).join(" ")})` : ""}`);
  console.log(`  重複行をまとめた ${stats.dupMerged} / 取込候補 ${entries.length} 件 (${people.size} 名)`);
  const byKind = new Map<string, number>();
  for (const e of entries) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
  console.log(`  給付種類: ${[...byKind].map(([k, v]) => `${k} ${v}`).join(" / ")}`);

  // ── 利用者を引く (保険者, 被保番) ────────────────────────────────────────
  type Cl = { id: string; insurer_number: string | null; insured_number: string | null; deleted_at: string | null };
  type Ci = { id: string; client_id: string; insurer_number: string | null; insured_number: string | null };
  const clients = await selectAll<Cl>(sb, "clients", "id,insurer_number,insured_number,deleted_at", (q) => q.eq("tenant_id", TENANT));
  const cirs = await selectAll<Ci>(sb, "client_insurance_records", "id,client_id,insurer_number,insured_number", (q) => q.eq("tenant_id", TENANT));
  const alive = new Set(clients.filter((c) => !c.deleted_at).map((c) => c.id));
  const byKey = new Map<string, Set<string>>();
  const add = (ins: string | null, no: string | null, cid: string) => {
    if (!no || !alive.has(cid)) return;
    const k = `${nInsurer(ins)}|${nInsured(no)}`;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k)!.add(cid);
  };
  for (const r of cirs) add(r.insurer_number, r.insured_number, r.client_id);
  for (const c of clients) add(c.insurer_number, c.insured_number, c.id);
  const ambiguous: string[] = [];
  const unmatched: BenefitCsvEntry[] = [];
  const matched: (BenefitCsvEntry & { clientId: string })[] = [];
  const ambiguousPeople = new Set<string>(), unmatchedPeople = new Set<string>();
  for (const e of entries) {
    const k = `${e.insurer}|${e.insured}`;
    const s = byKey.get(k);
    if (!s || s.size === 0) { unmatched.push(e); unmatchedPeople.add(k); continue; }
    if (s.size > 1) { if (!ambiguousPeople.has(k)) ambiguous.push(`${e.name} ${k} → ${s.size} 名 (${[...s].join(", ")})`); ambiguousPeople.add(k); continue; }
    matched.push({ ...e, clientId: [...s][0] });
  }
  const matchedClients = [...new Set(matched.map((m) => m.clientId))];
  console.log(`\n══ 利用者の突合 (保険者番号, 被保険者番号) ══`);
  console.log(`  当たった ${matchedClients.length} 名 / ${matched.length} 件`);
  console.log(`  ★ 当たらない ${unmatchedPeople.size} 名 / ${unmatched.length} 件 (DB に利用者がいない。入れない)`);
  for (const k of [...unmatchedPeople].slice(0, 10)) console.log(`     - ${unmatched.find((e) => `${e.insurer}|${e.insured}` === k)?.name} ${k}`);
  if (unmatchedPeople.size > 10) console.log(`     … 他 ${unmatchedPeople.size - 10} 名`);
  console.log(`  ★ 複数の利用者に当たる ${ambiguousPeople.size} 名 (別人に付けないため入れない)`);
  for (const l of ambiguous.slice(0, 10)) console.log(`     - ${l}`);

  // ── 事業所 ───────────────────────────────────────────────────────────────
  const offices = await cfg.decideOffices(sb, matchedClients);
  const bySrc = new Map<string, number>();
  for (const cid of matchedClients) {
    const d = offices.get(cid) ?? { officeId: null, officeSource: null };
    const k = d.officeId ? (d.officeSource ?? "?") : "NULL (事業所未定)";
    bySrc.set(k, (bySrc.get(k) ?? 0) + 1);
  }
  console.log(`\n══ 事業所の付け方 (人数) ══`);
  for (const [k, v] of bySrc) console.log(`  ${k.padEnd(20)} ${v} 名`);

  // ── 既存 (冪等) ─────────────────────────────────────────────────────────
  let tableExists = true;
  const existing = new Set<string>();
  try {
    const ex = await selectIn<{ client_id: string; kind: string; valid_from: string; valid_to: string | null; benefit_rate: number | null; office_id: string | null }>(
      sb, TABLE, "id,client_id,kind,valid_from,valid_to,benefit_rate,office_id", "client_id", matchedClients);
    for (const r of ex) existing.add(certKey(r));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "PGRST205" || code === "42P01") tableExists = false;
    else throw e;
  }
  const rows = matched.map((m) => {
    const d = offices.get(m.clientId) ?? { officeId: null, officeSource: null };
    return {
      tenant_id: TENANT, client_id: m.clientId, insurer_number: m.insurer, insured_number: m.insured,
      kind: m.kind, benefit_rate: m.rate, valid_from: m.from, valid_to: m.to, restriction: m.restriction,
      source: "honobono_csv", notes: `${cfg.marker}${m.note ? ` 備考: ${m.note}` : ""}`,
      office_id: d.officeId, copied_from_id: null, office_source: d.officeId ? d.officeSource : null,
      _line: m.line, _name: m.name,
    };
  });
  // ★ 2026-11-09: CSV の中に完全に同じ証が繰り返し出る (484 組) ので、一意キー (uq_cbc_same_cert と同じ) で 1 件に畳む。
  //   畳まずに送ると同じバッチ内で重複して insert が落ちる (初回 --execute で実際に 400 件書いた所で止まった)
  const seenKey = new Set(existing);
  const toInsert = rows.filter((r) => { const k = certKey(r); if (seenKey.has(k)) return false; seenKey.add(k); return true; });
  console.log(`\n══ 書込み予定 ══`);
  console.log(`  表 ${TABLE}: ${tableExists ? "あり" : "★ 未作成 (migrations/client_benefit_certificates.sql を先に適用。DRY RUN は既存 0 件として数えた)"}`);
  console.log(`  INSERT ${toInsert.length} 件 / 既にある ${rows.length - toInsert.length} 件 / ★ 認定行 (client_insurance_records) は書き換えない`);
  // 8/1 で割合が変わる人 (認定期間途中の切替。この表を作った理由) の人数
  const byClient = new Map<string, typeof rows>();
  for (const r of rows) { if (r.kind !== "介護保険負担割合証") continue; if (!byClient.has(r.client_id)) byClient.set(r.client_id, []); byClient.get(r.client_id)!.push(r); }
  let switch0801 = 0;
  for (const rs of byClient.values()) {
    const at = (d: string) => rs.filter((r) => r.valid_from <= d && (!r.valid_to || r.valid_to >= d)).sort((a, b) => (a.valid_from < b.valid_from ? 1 : -1))[0]?.benefit_rate;
    const a = at("2026-07-31"), b = at("2026-08-01");
    if (a != null && b != null && a !== b) switch0801++;
  }
  console.log(`  参考: 2026-08-01 で負担割合が変わる人 ${switch0801} 名`);
  if (OUT) { writeFileSync(OUT, JSON.stringify({ toInsert, unmatched, ambiguous }, null, 1)); console.log(`  → 明細 ${OUT}`); }

  if (!EXECUTE) { console.log(`\nDRY RUN (DB は書いていない)。実行は --execute`); return; }
  if (!tableExists) { console.error("★ 表が未作成なので止める"); process.exit(2); }
  if (ambiguousPeople.size > 0) console.log(`  (複数に当たる ${ambiguousPeople.size} 名は入れずに進める)`);

  const { data: batch, error: bErr } = await sb.from("data_import_batches").insert({
    tenant_id: TENANT, source_system: cfg.sourceSystem,
    source_files: [cfg.futanCsv, ...cfg.kaigoInsCsvs].map((p) => ({ path: p, sha256: sha256(p) })),
    script: cfg.scriptRel, args: argv.join(" "), step: "benefit_certificates", status: "running", notes: cfg.marker,
  }).select("id").single();
  if (bErr || !batch) throw new Error(`data_import_batches: ${bErr?.message}`);
  let written = 0;
  try {
    for (const part of chunks(toInsert, 200)) {
      const payload = part.map(({ _line, _name, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
      const { data, error } = await sb.from(TABLE).insert(payload).select("id,client_id,kind,valid_from,valid_to,benefit_rate,office_id");
      if (error) throw new Error(`${TABLE} insert: ${error.message}`);
      if ((data ?? []).length !== part.length) throw new Error(`${TABLE} insert: 返った行 ${(data ?? []).length} ≠ 送った行 ${part.length}`);
      const recs = (data ?? []).map((d, i) => ({
        batch_id: batch.id, tenant_id: TENANT, table_name: TABLE, row_id: d.id, op: "insert",
        source_key: `${part[i].insurer_number}|${part[i].insured_number}|${part[i].kind}|${part[i].valid_from}`,
        source_ref: { line: part[i]._line, name: part[i]._name }, before: null, after: payload[i],
      }));
      const { error: e2 } = await sb.from("data_import_rows").insert(recs);
      if (e2) throw new Error(`data_import_rows: ${e2.message}`);
      written += part.length;
    }
  } catch (e) {
    await sb.from("data_import_batches").update({ status: "failed" }).eq("id", batch.id);
    console.error(`★ 途中で止めた (書いた ${written} 件)。取り消しは --revert ${batch.id} --execute`);
    throw e;
  }
  const { error: e3 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", batch.id);
  if (e3) throw new Error(`data_import_batches: ${e3.message}`);
  console.log(`完了 batch ${batch.id}: INSERT ${written} 件。取り消しは --revert ${batch.id} --execute`);
  console.log(`確認 SQL: SELECT kind, office_source, count(*) FROM ${TABLE} WHERE notes LIKE '%${cfg.marker}%' GROUP BY 1,2;`);
}
