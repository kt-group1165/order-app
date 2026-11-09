/**
 * 負担割合 (給付率) を「その月」に解決する共通の純関数。★ 正本は order-app。
 *
 *   正本   apps/order-app/lib/insurance/cert-month.ts
 *   写し   apps/kaigo-app/src/lib/insurance/cert-month.ts   ← ★ 中身はバイト単位で同じにする
 *   検査   apps/order-app/scripts/cert-month-parity.mts (npm run check:cert-month-parity / check:all)
 *          ① 2 ファイルが同一 ② 固定データで期待値 ③ わざと壊して鳴る
 *   ⚠ import を足さないこと (両 app から同じ中身で読むため。外部依存なし・DB なし)。
 *
 * 背景 (2026-11-09 user 合意 / FY-B 調査・FY-H 実装):
 *   負担割合証は毎年 8/1 に切り替わるが、認定 (client_insurance_records) の有効期間とは揃わない。
 *   認定行 1 行に負担割合を 1 つしか持てないため、認定期間の途中の 8/1 で割合が変わる人
 *   (kaigo 側で 48 名 52 行・福祉用具ケアサポで 17 名) は、どちらかの月が必ず違う割合で出ていた。
 *   → 負担割合証を期間ごとに別の表 client_benefit_certificates に持ち、月ごとにここで解決する。
 *
 * ★ ほのぼのは負担割合証の期間で月ごとに給付率を出し分けている (2026-11-09 実測で裏付け)
 *   ケアサポ 福祉用具の明細書明細付 KDS0031 (処理 R8/4〜R8/9) を、負担割合証等 CSV で
 *   8/1 に割合が変わる 17 名について見た:
 *     提供 2026-07 = 旧い証の給付率 / 提供 2026-08 = 新しい証の給付率  → 17 名とも最終的に一致
 *     ・月遅れ: 関 貞雄 は提供 7 月を処理 R8/9 に出しているが、給付率は旧い証の 70 (新しい 90 ではない)
 *       = 処理月ではなく提供月の証で決めている
 *     ・石渡 増男 / 小山 勝治 は処理 R8/8 で 8 月を旧い 90 で出し、処理 R8/9 に 8 月を新しい 80 で
 *       出し直している (ほのぼの側で誤りに気付いて再請求したと見られる)。出し直し後は新しい証と一致
 *   → 規則「提供月に掛かる負担割合証のうち、開始が最新のもの」を期待値にする。
 *
 * 規則 (resolveBenefitForMonth):
 *   1. 負担割合証 (kind = '介護保険負担割合証') のうち、その月に掛かるもの
 *      (valid_from <= 月末 かつ (valid_to IS NULL または valid_to >= 月初))。
 *      開始 (valid_from) が最新の 1 枚を採る。
 *      同じ開始日で給付率が違う証が複数あれば、終了の遅いほう → 給付率の低いほう (= 保険請求が
 *      小さい側。過大請求に倒さない) を採り、警告を出す。
 *      月内に給付率の違う証が 2 枚掛かる (月の途中で切り替わる) ときは splitInMonth=true + 警告。
 *   2. 無ければ 採用した認定行の値 (benefit_rate を優先、無ければ copay_rate) + 警告。source='cert_row'
 *   3. それも無ければ 無し。source='none'
 *   給付制限 (kind = '給付制限') は給付率とは別項目 (restriction) で返す。給付率は変えない。
 *
 *   officeId (opts) は事業所別設計 (DESIGN_INSURANCE_PER_OFFICE.md) の段階切替用。
 *   ★ 今は呼び出し側で指定しない = 全行を見る。指定すると office_id が一致する行だけを見る。
 *
 * 負担割合証が無いとき (2026-11-09 user 合意):
 *   今は「認定行の値で出して警告」。BLOCK_DENSOU_WITHOUT_BENEFIT_CERT を true にすると
 *   blockDensou=true を返す (呼び出し側が伝送を作らせない)。★ 切り替えはこの定数 1 か所だけ。
 *   締める時期: 事業所別設計の切替時、check:futan-period の「負担割合証なしで請求」が実質 0 件になったら。
 *
 * 日付は 'YYYY-MM-DD' の文字列比較 (Date パースなし = タイムゾーン安全)。
 */

export const BENEFIT_CERT_KIND_FUTAN = "介護保険負担割合証";
export const BENEFIT_CERT_KIND_SEIGEN = "給付制限";
export const BENEFIT_CERT_KIND_TOKUREI = "特例措置";

/**
 * ★ 将来の切替点 (今は false)。
 * true にすると、その月に負担割合証が無い人 (source !== 'certificate') は blockDensou=true になる。
 */
export const BLOCK_DENSOU_WITHOUT_BENEFIT_CERT = false;

/** 期限が近いとみなす日数 (利用者一覧の印。8/1 の更新前にもらいに行けるように) */
export const BENEFIT_CERT_EXPIRY_WARN_DAYS = 30;

/** 認定行 (client_insurance_records) のうち、ここで使う列 */
export type CertRowForBenefit = {
  id?: string | null;
  certification_start_date?: string | null;
  certification_end_date?: string | null;
  effective_date?: string | null;
  /** 認定行は「割」表記 ("1"/"2"/"3")。0.1〜0.3 表記も許容 */
  copay_rate?: string | number | null;
  /** 給付率 ("90"/"80"/"70") */
  benefit_rate?: string | number | null;
  care_level?: string | null;
  service_limit_amount?: number | null;
  office_id?: string | null;
};

/** 負担割合証等 (client_benefit_certificates) のうち、ここで使う列 */
export type BenefitCertRow = {
  id?: string | null;
  kind: string;
  benefit_rate: number | string | null;
  valid_from: string | null;
  valid_to: string | null;
  office_id?: string | null;
  restriction?: string | null;
};

export type BenefitSource = "certificate" | "cert_row" | "none";

export type BenefitRestriction = {
  id: string | null;
  benefitRate: number | null;
  from: string | null;
  to: string | null;
  content: string | null;
};

export type BenefitForMonth = {
  /** 給付率 (90/80/70 …)。無ければ null */
  benefitRate: number | null;
  /** 負担割合 (割。1/2/3)。= (100 − 給付率) / 10。無ければ null */
  copayWari: number | null;
  /** 出どころ。certificate = 負担割合証 / cert_row = 認定行の値 / none = 無し */
  source: BenefitSource;
  /** 採用した証 (または認定行) の期間 */
  periodFrom: string | null;
  periodTo: string | null;
  certificateId: string | null;
  certRowId: string | null;
  /** 月内に給付率の違う負担割合証が 2 枚以上掛かる (月の途中で切替) */
  splitInMonth: boolean;
  /** その月に掛かる給付制限 (給付率とは別。最新開始の 1 件) */
  restriction: BenefitRestriction | null;
  warnings: string[];
  /** 伝送を作らせないか (BLOCK_DENSOU_WITHOUT_BENEFIT_CERT が true のときだけ立つ) */
  blockDensou: boolean;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s: string | null | undefined): s is string => !!s && DATE_RE.test(s);

/** その月に掛かるか (start <= 月末 AND (end IS NULL OR end >= 月初))。start 無しは掛からない */
function overlaps(from: string | null | undefined, to: string | null | undefined, monthStart: string, monthEnd: string): boolean {
  if (!isDate(from)) return false;
  if (from > monthEnd) return false;
  if (isDate(to) && to < monthStart) return false;
  return true;
}

/** 給付率の文字列/数値を 0〜100 の整数に。範囲外・非数は null */
export function parseBenefitRate(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).normalize("NFKC").trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n);
}

/**
 * 認定行の copay_rate (割表記) → 給付率。
 *   "1"/"2"/"3" = 1〜3 割 → 90/80/70。0.1〜0.3 表記も許容。
 *   ⚠ kaigo の請求 (visit-seikyu/aggregate.ts) と同じく 1 以上は「割」(10 以上は 10 割で頭打ち)。
 *   0 以下・非数は null (kaigo は null を既定 1 割に倒すが、ここでは倒さない)。
 */
export function benefitRateFromCopay(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).normalize("NFKC").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  const wari = n >= 1 ? Math.min(n, 10) : n * 10;
  return Math.round(100 - wari * 10);
}

/** 給付率 → 負担割合 (割)。90 → 1 / 80 → 2 / 70 → 3。端数 (91 等) はそのまま小数で返す */
export function copayWariFromBenefitRate(rate: number | null): number | null {
  if (rate == null) return null;
  return Math.round((100 - rate)) / 10;
}

/** 認定行の情報の揃い具合 (kaigo cert-for-month.ts の certCompleteness と同じ重み) */
function certCompleteness(r: CertRowForBenefit): number {
  const copay = r.copay_rate;
  return (copay == null || copay === "" ? 0 : 4) +
    (r.care_level == null || r.care_level === "" ? 0 : 2) +
    (r.service_limit_amount == null ? 0 : 1);
}

/**
 * 認定行から「対象月の 1 件」を選ぶ (kaigo-app src/lib/cert-for-month.ts と同じ規則)。
 *   1. certification_start_date <= 月末 かつ (end IS NULL または >= 月初) の行のうち start が最新。
 *      同着 (start と effective_date が同じ) は情報が揃っている行 (copay > care_level > 限度額)。
 *      それも同点なら入力順の先頭。
 *   2. 該当なしなら 全行のうち最新 1 件 (start DESC, effective DESC) を isFallback=true で返す。
 *   入力の並びは問わない (中で start DESC, effective DESC に安定ソートする)。
 */
export function pickCertForMonth<T extends CertRowForBenefit>(
  rows: T[],
  monthStart: string,
  monthEnd: string,
): { row: T; isFallback: boolean } | null {
  if (rows.length === 0) return null;
  // start DESC (null は最後), effective DESC (null は最後)。Array.prototype.sort は安定
  const desc = (a: string | null | undefined, b: string | null | undefined) => {
    const x = a ?? "", y = b ?? "";
    if (x === y) return 0;
    if (x === "") return 1;
    if (y === "") return -1;
    return x < y ? 1 : -1;
  };
  const sorted = rows.slice().sort((a, b) =>
    desc(a.certification_start_date, b.certification_start_date) || desc(a.effective_date, b.effective_date));
  const inMonth = sorted.filter((r) => overlaps(r.certification_start_date, r.certification_end_date, monthStart, monthEnd));
  if (inMonth.length === 0) return { row: sorted[0], isFallback: true };
  const head = inMonth[0];
  let best = head;
  let bestScore = certCompleteness(head);
  for (const r of inMonth) {
    if (r.certification_start_date !== head.certification_start_date) break;
    if ((r.effective_date ?? null) !== (head.effective_date ?? null)) break;
    const s = certCompleteness(r);
    if (s > bestScore) { best = r; bestScore = s; }
  }
  return { row: best, isFallback: false };
}

/** 認定行の給付率 (benefit_rate 優先、無ければ copay_rate から) */
export function benefitRateOfCertRow(r: CertRowForBenefit | null | undefined): number | null {
  if (!r) return null;
  return parseBenefitRate(r.benefit_rate) ?? benefitRateFromCopay(r.copay_rate);
}

const fmtRate = (n: number | null) => (n == null ? "?" : `${n}%`);

/**
 * その月の給付率 (負担割合) を解決する。
 * @param certRows      その利用者の認定行 (全世代。並びは問わない)
 * @param benefitCerts  その利用者の負担割合証等 (全期間。並びは問わない)
 */
export function resolveBenefitForMonth(
  certRows: CertRowForBenefit[],
  benefitCerts: BenefitCertRow[],
  monthStart: string,
  monthEnd: string,
  opts: { officeId?: string | null } = {},
): BenefitForMonth {
  const officeId = opts.officeId ?? null;
  const scoped = <R extends { office_id?: string | null }>(xs: R[]) =>
    officeId ? xs.filter((x) => (x.office_id ?? null) === officeId) : xs;
  const warnings: string[] = [];
  const certs = scoped(benefitCerts);

  // 給付制限 (給付率とは別項目)
  const seigen = certs
    .filter((c) => c.kind === BENEFIT_CERT_KIND_SEIGEN && overlaps(c.valid_from, c.valid_to, monthStart, monthEnd))
    .sort((a, b) => (a.valid_from! < b.valid_from! ? 1 : a.valid_from! > b.valid_from! ? -1 : 0));
  const restriction: BenefitRestriction | null = seigen[0]
    ? {
        id: seigen[0].id ?? null,
        benefitRate: parseBenefitRate(seigen[0].benefit_rate),
        from: seigen[0].valid_from,
        to: seigen[0].valid_to,
        content: seigen[0].restriction ?? null,
      }
    : null;
  if (restriction) {
    warnings.push(`給付制限 (${restriction.content ?? "内容未入力"}・給付率 ${fmtRate(restriction.benefitRate)}・${restriction.from}〜${restriction.to ?? ""}) が掛かっています — 給付率は自動では変えていません。確認してください`);
  }

  // 1. 負担割合証
  const futan = certs
    .filter((c) => c.kind === BENEFIT_CERT_KIND_FUTAN && overlaps(c.valid_from, c.valid_to, monthStart, monthEnd))
    .map((c) => ({ c, rate: parseBenefitRate(c.benefit_rate) }))
    .filter((x) => x.rate != null);
  if (futan.length > 0) {
    futan.sort((a, b) => {
      if (a.c.valid_from !== b.c.valid_from) return a.c.valid_from! < b.c.valid_from! ? 1 : -1; // 開始 DESC
      const at = a.c.valid_to ?? "9999-12-31", bt = b.c.valid_to ?? "9999-12-31";
      if (at !== bt) return at < bt ? 1 : -1; // 終了の遅いほう
      return a.rate! - b.rate!; // 給付率の低いほう (保険請求が小さい側)
    });
    const top = futan[0];
    const sameStart = futan.filter((x) => x.c.valid_from === top.c.valid_from);
    if (new Set(sameStart.map((x) => x.rate)).size > 1) {
      warnings.push(`同じ開始日 ${top.c.valid_from} で給付率の違う負担割合証が ${sameStart.length} 枚あります (${sameStart.map((x) => fmtRate(x.rate)).join("/")}) — ${fmtRate(top.rate)} で計算しました。負担割合証を確認してください`);
    }
    const distinctRates = new Set(futan.map((x) => x.rate));
    const splitInMonth = distinctRates.size > 1;
    if (splitInMonth) {
      warnings.push(`月の途中で負担割合証が切り替わっています (${futan.map((x) => `${x.c.valid_from}〜${x.c.valid_to ?? ""} ${fmtRate(x.rate)}`).join(" / ")}) — 開始が最新の ${fmtRate(top.rate)} で計算しました`);
    }
    return {
      benefitRate: top.rate,
      copayWari: copayWariFromBenefitRate(top.rate),
      source: "certificate",
      periodFrom: top.c.valid_from,
      periodTo: top.c.valid_to,
      certificateId: top.c.id ?? null,
      certRowId: null,
      splitInMonth,
      restriction,
      warnings,
      blockDensou: false,
    };
  }

  // 2. 認定行の値
  const picked = pickCertForMonth(scoped(certRows), monthStart, monthEnd);
  const rowRate = benefitRateOfCertRow(picked?.row);
  if (picked && rowRate != null) {
    warnings.push(`その月の負担割合証がありません — 認定行の値 (給付率 ${fmtRate(rowRate)}) で計算しました。負担割合証を確認してください`);
    return {
      benefitRate: rowRate,
      copayWari: copayWariFromBenefitRate(rowRate),
      source: "cert_row",
      periodFrom: picked.row.certification_start_date ?? null,
      periodTo: picked.row.certification_end_date ?? null,
      certificateId: null,
      certRowId: picked.row.id ?? null,
      splitInMonth: false,
      restriction,
      warnings,
      blockDensou: BLOCK_DENSOU_WITHOUT_BENEFIT_CERT,
    };
  }

  // 3. 無し
  warnings.push("その月の負担割合証も認定行の負担割合もありません");
  return {
    benefitRate: null,
    copayWari: null,
    source: "none",
    periodFrom: null,
    periodTo: null,
    certificateId: null,
    certRowId: picked?.row.id ?? null,
    splitInMonth: false,
    restriction,
    warnings,
    blockDensou: BLOCK_DENSOU_WITHOUT_BENEFIT_CERT,
  };
}

// ─── 利用者一覧の印 (期限管理) ────────────────────────────────────────────

export type BenefitCertAlertLevel = "ok" | "missing" | "expired" | "expiring";

export type BenefitCertAlert = {
  level: BenefitCertAlertLevel;
  /** 一覧の印の文言 */
  label: string;
  /** ホバーの説明 */
  detail: string;
  /** 今日有効な証の終了日 (expiring) / 最後に切れた証の終了日 (expired) */
  validTo: string | null;
  daysLeft: number | null;
};

/** 'YYYY-MM-DD' 同士の日数差 (b − a)。UTC で計算するので TZ に依存しない */
function daysBetween(a: string, b: string): number {
  const p = (s: string) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 86_400_000);
}

/**
 * 今日時点の負担割合証の状態 (利用者一覧の印・期限一覧用)。
 *   missing  = 負担割合証が 1 枚も無い (赤)
 *   expired  = 今日有効な証が無い (過去の証はある) (赤)
 *   expiring = 今日有効な証の終了が warnDays 日以内で、その翌日から始まる証が無い (橙)
 *   ok       = それ以外
 * ★ 対象者 (介護保険の認定が今日有効な人 等) の絞り込みは呼び出し側で行う。
 */
export function judgeBenefitCertAlert(
  benefitCerts: BenefitCertRow[],
  today: string,
  opts: { officeId?: string | null; warnDays?: number } = {},
): BenefitCertAlert {
  const warnDays = opts.warnDays ?? BENEFIT_CERT_EXPIRY_WARN_DAYS;
  const officeId = opts.officeId ?? null;
  const futan = benefitCerts.filter((c) =>
    c.kind === BENEFIT_CERT_KIND_FUTAN && isDate(c.valid_from) && parseBenefitRate(c.benefit_rate) != null &&
    (!officeId || (c.office_id ?? null) === officeId));
  if (futan.length === 0) {
    return { level: "missing", label: "負担割合証なし", detail: "負担割合証が登録されていません — 請求は認定行の負担割合で出ます", validTo: null, daysLeft: null };
  }
  const valid = futan.filter((c) => overlaps(c.valid_from, c.valid_to, today, today));
  if (valid.length === 0) {
    const ends = futan.map((c) => c.valid_to).filter(isDate).filter((d) => d < today).sort();
    const lastEnd = ends.length > 0 ? ends[ends.length - 1] : null;
    const future = futan.filter((c) => c.valid_from! > today).map((c) => c.valid_from!).sort();
    return {
      level: "expired",
      label: "負担割合証 期限切れ",
      detail: `今日有効な負担割合証がありません${lastEnd ? ` (最後の証は ${lastEnd} まで)` : ""}${future.length ? ` / ${future[0]} からの証はあります` : ""}`,
      validTo: lastEnd,
      daysLeft: lastEnd ? daysBetween(today, lastEnd) : null,
    };
  }
  // 今日有効な証のうち 終了が最も遅いもの (終了なし = 無期限)
  let end: string | null = null;
  let open = false;
  for (const c of valid) {
    if (!isDate(c.valid_to)) { open = true; break; }
    if (end == null || c.valid_to > end) end = c.valid_to;
  }
  if (open || end == null) return { level: "ok", label: "", detail: "", validTo: null, daysLeft: null };
  const left = daysBetween(today, end);
  // 終了の翌日以前から始まる次の証 (更新済み) があれば ok
  const hasNext = futan.some((c) => c.valid_from! > today && daysBetween(end!, c.valid_from!) <= 1);
  if (left <= warnDays && !hasNext) {
    return {
      level: "expiring",
      label: `負担割合証 残${left}日`,
      detail: `負担割合証が ${end} で切れます (残 ${left} 日)。次の証が未登録です`,
      validTo: end,
      daysLeft: left,
    };
  }
  return { level: "ok", label: "", detail: "", validTo: end, daysLeft: left };
}
