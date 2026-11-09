/**
 * ほのぼの福祉用具 (KDS0031 明細書明細付) と order-app DB の突合 — 共通部分
 *
 * 使っているもの:
 *   scripts/honobono-sync-diff.mts              差分レポート (READ ONLY)
 *   migrations/sync_fukuyogu_from_honobono.mjs  反映 script (DRY RUN 付き)
 *
 * ★ 2 つが同じ判定 (CSV の読み方 / 当月有効 / 単位数 / 利用者の突合) を使うために切り出した。
 *   逐語コピーで二重実装にすると、片方だけ直したときに乖離する。
 * ★ ここを変えると差分レポートの数字も変わる。BillingTab.tsx の根拠は diff script 冒頭を参照。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "dummy";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TENANT = "kt-group";
export const PROVIDER_BN = "1272400050";

// ── 型 ────────────────────────────────────────────────────────────────────
export type ClientRow = {
  id: string; user_number: string | null; name: string; furigana: string | null; birth_date: string | null;
  gender: string | null; care_level: string | null; insurer_number: string | null; insured_number: string | null;
  benefit_rate: string | null; certification_start_date: string | null; certification_end_date: string | null;
  care_office_id: string | null; office_id: string | null; deleted_at: string | null;
  // 以下は反映 script (ほのぼの優先の上書き) の比較用。差分 script は使わない
  postal_code?: string | null; address?: string | null; phone?: string | null; mobile?: string | null; status?: string | null;
};
export type InsRow = {
  id: string; client_id: string; effective_date: string | null; insurer_number: string | null; insured_number: string | null;
  care_level: string | null; certification_start_date: string | null; certification_end_date: string | null;
  benefit_rate: string | null; certification_status: string | null; care_office_id: string | null;
  care_office_number: string | null; birth_date: string | null;
  // 以下は反映 script (ほのぼの優先の更新) の比較用。差分 script は使わない
  [col: string]: unknown;
};
export type KohiRow = {
  id: string; client_id: string; hohei_code: string | null; futan_sha_number: string | null;
  jukyu_sha_number: string | null; valid_start: string | null; valid_end: string | null;
};
export type OrderRow = { id: string; client_id: string | null; office_id: string | null; payment_type: string | null; status: string | null };
export type ItemRow = {
  id: string; order_id: string; product_code: string; status: string | null; payment_type: string | null;
  rental_start_date: string | null; rental_end_date: string | null; quantity: number | null; cancelled_at: string | null;
  rental_price: number | null;
};
export type EqRow = { id: string; product_code: string; tais_code: string | null; name: string | null; category: string | null; kind: string | null; rental_price: number | null };
export type PriceHist = { id: string; product_code: string; rental_price: number; valid_from: string };
export type HospRow = { id: string; client_id: string; admission_date: string; discharge_date: string | null };
export type OverrideRow = { id: string; client_id: string; month: string; order_item_id: string; units_override: number };
export type LateRow = { id: string; client_id: string; month: string };
export type CareOfficeRow = { id: string; office_number: string | null; name: string };
export type OfficeRow = { id: string; name: string; business_number: string | null };

export type Snapshot = {
  fetchedAt: string; month: string;
  offices: OfficeRow[]; clients: ClientRow[]; ins: InsRow[]; kohi: KohiRow[]; orders: OrderRow[]; items: ItemRow[];
  equipment: EqRow[]; priceHist: PriceHist[]; hosp: HospRow[]; overrides: OverrideRow[]; late: LateRow[]; careOffices: CareOfficeRow[];
  coa?: CoaRow[]; // 2026-11-10 追加 (古いキャッシュには無い → --refresh)
};
export type CoaRow = { id: string; client_id: string; office_id: string; end_date: string | null };

// ── CSV ───────────────────────────────────────────────────────────────────
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}
export const C = {
  BILL_MONTH: 0, SVC_MONTH: 1, RECEIPT_NO: 2, PROVIDER: 3, INSURER: 4, FORM: 5, INSURED: 6, FUTAN1: 7, FUTAN2: 8, FUTAN3: 9,
  USER_NO: 10, KANA: 11, NAME: 12, JUKYU1: 14, JUKYU2: 15, JUKYU3: 16, BIRTH: 17, GENDER: 18, CARE_LEVEL: 19, CERT_START: 21, CERT_END: 22,
  PLAN_KUBUN: 23, CARE_OFFICE: 24, BENEFIT: 33, KOHI1_RATE: 34, TOT_UNITS: 37, TOT_INS: 38, TOT_USER: 39,
  K1_UNITS: 43, K1_CLAIM: 44, K1_SELF: 45, SVC_KIND: 62, SVC_ITEM: 63, DAYS: 65, SVC_UNITS: 69, TAIS: 73, SVC_NAME: 74,
} as const;
export const EXPECTED_HEADER: [number, string][] = [
  [1, "提供年月"], [4, "保険者番号"], [6, "被保険者番号"], [10, "利用者番号"], [12, "利用者名"], [17, "生年月日"],
  [19, "要介護状態区分"], [33, "保険給付率"], [37, "保険サービス単位数"], [63, "サービス項目コード"],
  [65, "日数・回数"], [69, "サービス単位数"], [73, "摘要"],
];

/** KDS0031 を読む。ヘッダーと列数を検査し、提供年月ごとの行数を返す */
export function readKds0031(path: string): { header: string[]; rows: string[][]; monthCount: Map<string, number> } {
  const text = new TextDecoder("shift-jis").decode(readFileSync(path));
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  const header = parseCsvLine(lines[0]);
  for (const [i, want] of EXPECTED_HEADER) {
    if (!(header[i] ?? "").includes(want)) throw new Error(`★ CSV ヘッダー列 ${i} が「${want}」を含まない (実際: ${header[i]})。帳票が違う`);
  }
  const rows = lines.slice(1).map(parseCsvLine);
  const badLen = rows.filter((r) => r.length !== header.length).length;
  if (badLen) throw new Error(`★ 列数が ${header.length} でない行が ${badLen} 行`);
  const monthCount = new Map<string, number>();
  for (const r of rows) monthCount.set(ymOf(r[C.SVC_MONTH]), (monthCount.get(ymOf(r[C.SVC_MONTH])) ?? 0) + 1);
  return { header, rows, monthCount };
}

// ── 正規化 ────────────────────────────────────────────────────────────────
export const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC").trim();
export const noSpace = (s: string) => s.replace(/[\s　]+/g, "");
export const toKata = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
export const nName = (s: string | null | undefined) => noSpace(nfkc(s));
export const nKana = (s: string | null | undefined) => toKata(noSpace(nfkc(s)));
export const nInsurer = (s: string | null | undefined) => {
  const d = nfkc(s).replace(/\D/g, "");
  return d.length === 8 && d.startsWith("00") ? d.slice(2) : d;
};
export const nInsured = (s: string | null | undefined) => nfkc(s).toUpperCase();
export const nCare = (s: string | null | undefined) =>
  noSpace(nfkc(s)).replace("要介護度", "要介護").replace("要支援度", "要支援");
export const nDate = (s: string | null | undefined) => {
  const t = nfkc(s);
  const m = t.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
};
export const nRate = (s: string | null | undefined) => {
  const n = parseInt(nfkc(s), 10);
  return Number.isFinite(n) ? String(n) : "";
};
export const nGender = (s: string | null | undefined) => {
  const t = nfkc(s);
  return t.startsWith("男") || t === "1" ? "男" : t.startsWith("女") || t === "2" ? "女" : t;
};
export const toInt = (s: string | null | undefined) => {
  const n = parseInt(nfkc(s), 10);
  return Number.isFinite(n) ? n : 0;
};
export const ymOf = (s: string) => {
  const m = nfkc(s).match(/^(\d{4})[/-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}` : "";
};
export const daysIn = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(y, m, 0).getDate(); };

// ── env / DB ─────────────────────────────────────────────────────────────
/** service_role は kaigo-app/.env.local (無ければ order-app/.env.local) から読む */
export function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const p of [join(__dirname, "../../kaigo-app/.env.local"), join(__dirname, "../.env.local")]) {
    let txt = "";
    try { txt = readFileSync(p, "utf8"); } catch { continue; }
    for (const l of txt.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

/**
 * DB を読む (★ SELECT のみ)。cachePath にあれば読み直さない (refresh=true で読み直す)。
 * 重い全件読みを並行セッションと重ねないための仕組み。
 */
export async function loadSnapshot(month: string, cachePath: string, refresh: boolean): Promise<Snapshot> {
  if (!refresh && existsSync(cachePath)) {
    const snap = JSON.parse(readFileSync(cachePath, "utf8")) as Snapshot;
    if (snap.month === month) {
      console.log(`DB: キャッシュを使う ${cachePath} (取得 ${snap.fetchedAt})。最新は --refresh`);
      return snap;
    }
    console.log(`DB: キャッシュの月 ${snap.month} ≠ ${month} なので読み直す`);
  }
  const { createClient } = await import("@supabase/supabase-js");
  const env = readEnv();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("kaigo-app/.env.local に SUPABASE_URL / SERVICE_ROLE_KEY が無い");
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // ★ 読みだけ。PostgREST 1000 行上限 → order(id) + range でページング
  async function all<T>(table: string, select: string, eqExtra?: [string, string]): Promise<T[]> {
    const out: T[] = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      let q = sb.from(table).select(select).eq("tenant_id", TENANT);
      if (eqExtra) q = q.eq(eqExtra[0], eqExtra[1]);
      const { data, error } = await q.order("id").range(from, from + PAGE - 1);
      if (error) throw new Error(`${table}: ${error.message}`);
      const rows = (data ?? []) as T[];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    console.log(`  ${table.padEnd(26)} ${out.length} 行`);
    return out;
  }
  console.log("DB 読込 (READ ONLY)...");
  const snap: Snapshot = {
    fetchedAt: new Date().toISOString(), month,
    offices: await all<OfficeRow>("offices", "id,name,business_number"),
    clients: await all<ClientRow>("clients", "id,user_number,name,furigana,birth_date,gender,care_level,insurer_number,insured_number,benefit_rate,certification_start_date,certification_end_date,care_office_id,office_id,deleted_at,postal_code,address,phone,mobile,status"),
    ins: await all<InsRow>("client_insurance_records", "id,client_id,effective_date,insurer_number,insured_number,care_level,certification_start_date,certification_end_date,benefit_rate,certification_status,care_office_id,care_office_number,birth_date,insurer_name,certification_date,issued_date,insurance_confirmed_date,qualification_date,insurance_valid_start,insurance_valid_end,limit_period_start,limit_period_end,service_limit_amount,care_manager,care_manager_org,care_office_name,service_restriction,service_memo"),
    kohi: await all<KohiRow>("client_public_expenses", "id,client_id,hohei_code,futan_sha_number,jukyu_sha_number,valid_start,valid_end"),
    orders: await all<OrderRow>("orders", "id,client_id,office_id,payment_type,status"),
    items: await all<ItemRow>("order_items", "id,order_id,product_code,status,payment_type,rental_start_date,rental_end_date,quantity,cancelled_at,rental_price"),
    equipment: await all<EqRow>("equipment_master", "id,product_code,tais_code,name,category,kind,rental_price"),
    priceHist: await all<PriceHist>("equipment_price_history", "id,product_code,rental_price,valid_from"),
    hosp: await all<HospRow>("client_hospitalizations", "id,client_id,admission_date,discharge_date"),
    overrides: await all<OverrideRow>("billing_unit_overrides", "id,client_id,month,order_item_id,units_override", ["month", month]),
    late: await all<LateRow>("billing_late_flags", "id,client_id,month", ["month", month]),
    careOffices: await all<CareOfficeRow>("care_offices", "id,office_number,name"),
    coa: await all<CoaRow>("client_office_assignments", "id,client_id,office_id,end_date"),
  };
  // 0 件は偽陰性を疑う (列名ミスなら上で error になるが、tenant 違い等で 0 になりうる)
  for (const k of ["clients", "ins", "orders", "items", "equipment"] as const) {
    if (snap[k].length === 0) throw new Error(`★ ${k} が 0 行。tenant_id や列名を疑うこと`);
  }
  writeFileSync(cachePath, JSON.stringify(snap));
  console.log(`  → 保存 ${cachePath}`);
  return snap;
}

// ── 本物の計算関数 (BillingTab / 伝送と同じもの) ────────────────────────
export async function loadLibs() {
  const { halfMonthUnits, halfMonthFlags, hospitalizationRanges } = await import("../lib/half-month-units");
  const { computeFukuyoguAmounts } = await import("../lib/kokuho-densou/fukuyogu-amounts");
  const { fukuyoguServiceCode, FUKUYOGU_SERVICE_CODES, careLevelCodeForDensou } = await import("../lib/kokuho-densou/build");
  const { pickCertForMonth, certFieldsForDensou } = await import("../lib/kokuho-densou/cert-for-month");
  const { getPriceForMonth } = await import("../lib/equipment");
  return { halfMonthUnits, halfMonthFlags, hospitalizationRanges, computeFukuyoguAmounts, fukuyoguServiceCode, FUKUYOGU_SERVICE_CODES, careLevelCodeForDensou, pickCertForMonth, certFieldsForDensou, getPriceForMonth };
}
export type Libs = Awaited<ReturnType<typeof loadLibs>>;

// ── 当月の請求対象を組む (BillingTab と同じ条件) ────────────────────────
export type DbLine = { itemId: string; tais: string; code: string | null; unitPer: number; count: number; units: number; overridden: boolean; half: boolean; skipped?: string };

/**
 * pausesByItem: 貸与の休止期間 (order_item_pauses。order_item_id → 期間)。省略 = 休止なし (従来どおり)。
 *   BillingTab と同じく 半月按分の判定 で休止日を貸与日に数えない (lib/half-month-units.ts halfMonthFlags)。
 *   明細 項10 日数 は呼出側で fukuyoguRentalDaysInMonth(…, model.pausesOf(itemId)) に渡す。
 */
export function buildBillingModel(snap: Snapshot, MONTH: string, officeId: string, libs: Libs,
  pausesByItem: Map<string, { from: string; to: string | null }[]> = new Map()) {
  const pausesOf = (itemId: string) => pausesByItem.get(itemId) ?? [];
  const { halfMonthUnits, halfMonthFlags, hospitalizationRanges, fukuyoguServiceCode, getPriceForMonth, pickCertForMonth, certFieldsForDensou, careLevelCodeForDensou } = libs;
  const clientById = new Map(snap.clients.map((c) => [c.id, c]));
  const eqByCode = new Map<string, EqRow>();
  for (const e of snap.equipment) if (!eqByCode.has(e.product_code)) eqByCode.set(e.product_code, e); // BillingTab は find = 先頭一致
  const careOfficeNo = new Map(snap.careOffices.map((c) => [c.id, c.office_number ?? ""]));
  const ordersById = new Map(snap.orders.map((o) => [o.id, o]));
  const overrideByItem = new Map(snap.overrides.map((o) => [o.order_item_id, o.units_override]));
  const lateFlag = new Set(snap.late.map((l) => l.client_id));
  const insByClient = new Map<string, InsRow[]>();
  for (const r of snap.ins) { if (!insByClient.has(r.client_id)) insByClient.set(r.client_id, []); insByClient.get(r.client_id)!.push(r); }
  const hospByClient = new Map<string, HospRow[]>();
  for (const h of snap.hosp) { if (!hospByClient.has(h.client_id)) hospByClient.set(h.client_id, []); hospByClient.get(h.client_id)!.push(h); }
  const kohiByClient = new Map<string, KohiRow[]>();
  for (const k of snap.kohi) { if (!kohiByClient.has(k.client_id)) kohiByClient.set(k.client_id, []); kohiByClient.get(k.client_id)!.push(k); }

  const [Y, M] = MONTH.split("-").map(Number);
  const monthStartS = `${MONTH}-01`;
  const monthEndS = `${MONTH}-${String(daysIn(MONTH)).padStart(2, "0")}`;
  const pld = (s: string) => { const [a, b, c] = s.slice(0, 10).split("-").map(Number); return new Date(a, b - 1, c); };
  const monthStart = new Date(Y, M - 1, 1);
  const monthEnd = new Date(Y, M, 0, 23, 59, 59);

  // ── 当月有効 (BillingTab activeRentals と同じ) ─────────────────────────
  const isActive = (item: ItemRow) => {
    const pt = item.payment_type ?? ordersById.get(item.order_id)?.payment_type ?? "介護";
    if (pt !== "介護") return false;
    if (!item.rental_start_date) return false;
    if (pld(item.rental_start_date) > monthEnd) return false;
    if (item.status === "terminated" && item.rental_end_date && pld(item.rental_end_date) < monthStart) return false;
    return item.status === "rental_started" || item.status === "terminated";
  };
  // BillingTab getUnits と同じ
  const unitsOf = (item: ItemRow, clientId: string): { unitPer: number; overridden: boolean; half: boolean } => {
    if (overrideByItem.has(item.id)) return { unitPer: overrideByItem.get(item.id)!, overridden: true, half: false };
    const eq = eqByCode.get(item.product_code);
    const price = getPriceForMonth(snap.priceHist as never, item.product_code, MONTH) ?? eq?.rental_price ?? 0;
    const base = price ? Math.round(price / 10) : 0;
    if (!item.rental_start_date) return { unitPer: base, overridden: false, half: false };
    // 半月按分: 入院・休止の日を除いた貸与日で判定 (BillingTab と同じ halfMonthFlags)
    const { firstHalf: f, secondHalf: s } = halfMonthFlags(item.rental_start_date, item.rental_end_date, MONTH,
      [...hospitalizationRanges(hospByClient.get(clientId) ?? []), ...pausesOf(item.id)]);
    const u = halfMonthUnits(base, f, s);
    return { unitPer: u, overridden: false, half: u !== base };
  };
  // BillingTab の autoLateClients / 伝送と同じ lib/kokuho-densou/cert-for-month.ts (被保番が一致する認定を優先。FY-C2)
  const pickIns = (clientId: string) => {
    const c = clientById.get(clientId);
    return pickCertForMonth(insByClient.get(clientId) ?? [], monthStartS, monthEndS,
      c ? { insurerNumber: c.insurer_number, insuredNumber: c.insured_number } : null);
  };
  const pickKohi = (clientId: string) => (kohiByClient.get(clientId) ?? []).find((k) =>
    k.hohei_code && !(k.valid_start && k.valid_start > monthEndS) && !(k.valid_end && k.valid_end < monthStartS)) ?? null;

  // ── DB 側の当月請求対象を組む ────────────────────────────────────────
  // ★ 2026-11-10: アプリ (lib/clients.ts getClients) と同じく junction の割当も含める
  const assignedIds = new Set((snap.coa ?? []).filter((a) => a.office_id === officeId).map((a) => a.client_id));
  const officeClients = new Set(snap.clients.filter((c) => (c.office_id === officeId || assignedIds.has(c.id)) && !c.deleted_at).map((c) => c.id));
  const dbLines = new Map<string, DbLine[]>(); // client_id → 請求に乗る明細
  const dbSkipped = new Map<string, DbLine[]>(); // 有効だが請求に乗らない明細
  const activeOtherScope = new Map<string, { itemId: string; tais: string; why: string }[]>(); // 他事業所 / clients 側で落ちる
  let activeCount = 0, ceilingCheckDiffers = 0;
  for (const item of snap.items) {
    if (!isActive(item)) continue;
    activeCount++;
    if (item.status === "rental_started" && item.rental_end_date && item.rental_end_date.slice(0, 10) < monthStartS) ceilingCheckDiffers++;
    const order = ordersById.get(item.order_id);
    const cid = order?.client_id ?? null;
    if (!cid) continue;
    if (order?.office_id !== officeId || !officeClients.has(cid)) {
      if (!activeOtherScope.has(cid)) activeOtherScope.set(cid, []);
      const c = clientById.get(cid);
      const why = order?.office_id !== officeId ? `orders.office_id=${order?.office_id ?? "null"}` :
        c?.deleted_at ? "clients.deleted_at あり" : `clients.office_id=${c?.office_id ?? "null"}`;
      activeOtherScope.get(cid)!.push({ itemId: item.id, tais: item.product_code, why });
      continue;
    }
    const eq = eqByCode.get(item.product_code);
    const { unitPer, overridden, half } = unitsOf(item, cid);
    const count = item.quantity ?? 1;
    const line: DbLine = { itemId: item.id, tais: eq?.tais_code || item.product_code, code: fukuyoguServiceCode(eq?.category), unitPer, count, units: unitPer * count, overridden, half };
    if (line.units <= 0) line.skipped = "単位数 0";
    else if (!line.code) line.skipped = `サービスコード不明 (種目=${eq?.category ?? "未設定"}${eq ? "" : " / equipment_master に無い"})`;
    const target = line.skipped ? dbSkipped : dbLines;
    if (!target.has(cid)) target.set(cid, []);
    target.get(cid)!.push(line);
  }
  const autoLate = new Set<string>();
  const noCareLevel = new Set<string>(); // ★ 要介護度をコードにできない (BillingTab の noCareLevelClients と同じ。月遅れ扱いで伝送から外れる)
  for (const cid of new Set([...dbLines.keys(), ...dbSkipped.keys()])) {
    const rec = pickIns(cid);
    if (rec?.certification_status === "申請中") autoLate.add(cid);
    const c = clientById.get(cid);
    if (c && !careLevelCodeForDensou(certFieldsForDensou(c, rec).careLevel)) { noCareLevel.add(cid); autoLate.add(cid); }
  }
  const isLate = (cid: string) => autoLate.has(cid) || lateFlag.has(cid);
  const dbTargets = [...dbLines.keys()]; // 明細が 1 行でも乗る利用者 (BillingTab は details 0 の人を出さない)

  return {
    clientById, eqByCode, careOfficeNo, ordersById, overrideByItem, lateFlag, insByClient, hospByClient, kohiByClient,
    monthStartS, monthEndS, isActive, unitsOf, pickIns, pickKohi, pausesOf,
    officeClients, dbLines, dbSkipped, activeOtherScope, activeCount, ceilingCheckDiffers, autoLate, noCareLevel, isLate, dbTargets,
  };
}
export type BillingModel = ReturnType<typeof buildBillingModel>;

// ── CSV 側を利用者ごとに束ねる (保険者, 被保番) ─────────────────────────
export type CsvLine = { tais: string; kind: string; item: string; code: string; units: number; days: number; name: string };
export type CsvUser = {
  key: string; insurer: string; insured: string; userNo: string; name: string; kana: string; birth: string; gender: string;
  receipts: Map<string, string[]>; // 番号 → 代表行
  lines: CsvLine[];
};
export function groupCsvUsers(mRows: string[][]): Map<string, CsvUser> {
  const csvUsers = new Map<string, CsvUser>();
  for (const r of mRows) {
    const insurer = nInsurer(r[C.INSURER]);
    const insured = nInsured(r[C.INSURED]);
    const key = `${insurer}|${insured}`;
    let u = csvUsers.get(key);
    if (!u) {
      u = { key, insurer, insured, userNo: nfkc(r[C.USER_NO]), name: nfkc(r[C.NAME]), kana: nfkc(r[C.KANA]), birth: nDate(r[C.BIRTH]), gender: nGender(r[C.GENDER]), receipts: new Map(), lines: [] };
      csvUsers.set(key, u);
    }
    if (!u.receipts.has(r[C.RECEIPT_NO])) u.receipts.set(r[C.RECEIPT_NO], r);
    const kind = nfkc(r[C.SVC_KIND]).slice(0, 2);
    const item = nfkc(r[C.SVC_ITEM]).padStart(4, "0");
    u.lines.push({ tais: nfkc(r[C.TAIS]), kind, item, code: kind + item, units: toInt(r[C.SVC_UNITS]), days: toInt(r[C.DAYS]), name: nfkc(r[C.SVC_NAME]) });
  }
  return csvUsers;
}
/** 1 人が同じ月に複数レセプト (要支援↔要介護の切替等) → 月末に有効な認定の方を代表にする */
export const repReceipt = (u: CsvUser, monthEndS: string) => {
  const rs = [...u.receipts.values()];
  return rs.find((r) => nDate(r[C.CERT_START]) <= monthEndS && nDate(r[C.CERT_END]) >= monthEndS) ?? rs[rs.length - 1];
};
/** レセプトごとに重複して付く合計情報を 番号で 1 回ずつ足す */
export const csvTotals = (u: CsvUser) => {
  let units = 0, ins = 0, self = 0, kohi = 0;
  for (const r of u.receipts.values()) { units += toInt(r[C.TOT_UNITS]); ins += toInt(r[C.TOT_INS]); self += toInt(r[C.TOT_USER]); kohi += toInt(r[C.K1_CLAIM]); }
  return { units, ins, self, kohi };
};

// ── 利用者の突合 ─────────────────────────────────────────────────────────
export function buildMatchIndex(snap: Snapshot) {
  const byKey = new Map<string, Set<string>>();
  const addKey = (ins: string | null, insd: string | null, cid: string) => {
    const k = `${nInsurer(ins)}|${nInsured(insd)}`;
    if (k.startsWith("|") || k.endsWith("|")) return;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k)!.add(cid);
  };
  for (const c of snap.clients) addKey(c.insurer_number, c.insured_number, c.id);
  for (const r of snap.ins) addKey(r.insurer_number, r.insured_number, r.client_id);
  const byUserNo = new Map<string, ClientRow[]>();
  const byNameBirth = new Map<string, ClientRow[]>();
  for (const c of snap.clients) {
    if (c.user_number) { const k = nfkc(c.user_number); if (!byUserNo.has(k)) byUserNo.set(k, []); byUserNo.get(k)!.push(c); }
    const nb = `${nName(c.name)}|${nDate(c.birth_date)}`;
    if (!byNameBirth.has(nb)) byNameBirth.set(nb, []);
    byNameBirth.get(nb)!.push(c);
  }
  return { byKey, byUserNo, byNameBirth };
}
export type MatchIndex = ReturnType<typeof buildMatchIndex>;

export type MatchResult =
  | { status: "ambiguous"; cands: ClientRow[] }
  | { status: "none"; hint: string[]; nbCount: number }
  | { status: "ok"; client: ClientRow; method: string; viaAux: boolean };

/**
 * 第一 (保険者, 被保番)。複数一致は 未削除 → 当月請求対象 → 生年月日 → 利用者番号 で絞る。
 * 0 件のときだけ 補助: 利用者番号+生年月日 → 氏名+生年月日 (どちらも一意のときだけ)。
 */
export function matchCsvUser(u: CsvUser, idx: MatchIndex, clientById: Map<string, ClientRow>, isTarget: (cid: string) => boolean): MatchResult {
  let cands = [...(idx.byKey.get(u.key) ?? [])].map((id) => clientById.get(id)!).filter(Boolean);
  let method = "保険者+被保番";
  if (cands.length > 1) {
    const live = cands.filter((c) => !c.deleted_at);
    if (live.length >= 1) cands = live;
  }
  if (cands.length > 1) {
    const t = cands.filter((c) => isTarget(c.id));
    if (t.length >= 1) cands = t;
  }
  if (cands.length > 1) { const t = cands.filter((c) => nDate(c.birth_date) === u.birth); if (t.length >= 1) cands = t; }
  if (cands.length > 1) { const t = cands.filter((c) => nfkc(c.user_number) === u.userNo); if (t.length >= 1) cands = t; }
  if (cands.length > 1) return { status: "ambiguous", cands };
  let viaAux = false;
  if (cands.length === 0) {
    const byNo = (idx.byUserNo.get(u.userNo) ?? []).filter((c) => nDate(c.birth_date) === u.birth);
    const byNb = idx.byNameBirth.get(`${nName(u.name)}|${u.birth}`) ?? [];
    if (byNo.length === 1) { cands = byNo; method = "利用者番号+生年月日 (被保番不一致)"; }
    else if (byNb.length === 1) { cands = byNb; method = "氏名+生年月日 (被保番不一致)"; }
    else {
      const hint = (idx.byUserNo.get(u.userNo) ?? []).map((c) => `${c.name}/${c.birth_date}`);
      return { status: "none", hint, nbCount: byNb.length };
    }
    viaAux = true;
  }
  return { status: "ok", client: cands[0], method, viaAux };
}
