/**
 * 福祉用具貸与 1 利用者 1 か月分の 保険請求額・利用者負担・公費請求額 (純関数)。
 * BillingTab の 通常請求 と 返戻・過誤の再請求 の 2 か所から呼ぶ (以前は同じ式が 2 か所にコピーされていた)。
 *
 * ── 公費単独 (被保険者番号が H 始まり) ───────────────────────────────────
 *   介護保険に加入していない生保受給者 (みなし 2 号)。**保険給付は 0、生活保護が 10 割**。
 *   2026-10-15 まで order-app はこれを区別しておらず、clients.benefit_rate = "0" を
 *   「読めない値」として 1 割 (90) に倒していた = **保険資格の無い人に 9 割を保険請求** (返戻確実)。
 *   2026-06 の実データで 27 名が該当 (全員 H 番号・給付率 0)。
 *   扱いは kaigo-app (src/lib/visit-seikyu/aggregate.ts / kokuho-densou/build.ts) に揃える。
 *   kaigo-app 側は ほのぼの実伝送で公費単独の 7131 を裏取り済み。
 *
 * ── CM 指示単位数で頭打ち (2026-11-09 user 合意) ─────────────────────────
 *   ケアマネが給付管理で割り付けた単位数 (= 給付管理票の計画単位数) が実績より少ないとき、
 *   **その単位数までを保険請求し、超えた分は保険外 (全額自己負担)**。計画単位数のマスタは持たず、
 *   請求画面で利用者ごと・月ごとに入力する (fukuyogu_cm_units)。空欄 (null) なら従来どおり実績で請求。
 *   ほのぼの福祉用具の実伝送 KK261004 (提供 2026-09) で 6 名がこの形:
 *     10 項9 計画単位数 = CM の単位数 / 項10 限度額管理対象 = 実績 / 項14 保険単位数 = 頭打ち後 /
 *     項16・17 と 01 項33-35・7111 は頭打ち後の単位数で計算。明細 (02) は実績のまま。
 *     例 髙畠 孝祐 (給付率70): 実績 3,150 / CM 1,085 → 10,850 円 → 保険 7,595 / 本人 3,255 (+保険外 20,650)
 *   国保連の審査は「明細書の合計請求単位数 ≤ 給付管理票の計画単位数」(_if_svc.txt) で、超えると査定される。
 *
 * ── 月途中の公費 (生保) の扱い (2026-11-09 user 要件) ──────────────────────
 *   公費の期間が月の途中で始まる/終わる月 (= 貸与日の一部だけが公費) は、ケアマネの方針で 3 通り。
 *   利用者ごと・月ごとに請求画面で選ぶ (fukuyogu_kohi_month_mode):
 *     none  その月は全部 利用者負担 (公費欄を出さない)
 *     daily 日割り: 用具 1 行ごとに 公費対象単位 = round(単位 × 公費の日数 / 貸与日数)
 *     half  半月: 公費の日が多い半月 (1〜15日 / 16日〜末日) を公費、もう半月を利用者負担。
 *           貸与が両方の半月にかかる行は round(単位/2) (lib/half-month-units.ts の halfMonthUnits と同じ丸め)
 *   未選択は KOHI_MONTH_MODE_DEFAULT (none) + 警告 (理由は定数の注記)。
 *   金額は kaigo-app src/lib/visit-seikyu/aggregate.ts の「月途中開始/終了の生保 (kohiProrate)」と同じ式:
 *     公費対象費用 = min(floor(公費対象単位 × 10), 費用総額) / 公費対象の保険分 = floor(公費対象費用 × 給付率)
 *     公費対象の利用者負担 = 公費対象費用 − 公費対象の保険分
 *     公費分本人負担 = min(公費対象の利用者負担, 本人支払額) / 公費請求 = 公費対象の利用者負担 − 公費分本人負担
 *     利用者負担 (合計) = 費用総額 − 保険請求 − 公費請求
 *   単位の端数は四捨五入 (単位数算定の端数処理)、金額は保険・公費側を切捨てて端数は本人側 (国保連方式)。
 *   ⚠ 7131/7132-02 項11・15 に月途中の公費を出す実例は ほのぼのの実伝送 (KK261004) に無い。
 *     IF 仕様 (_if_form2.txt「公費１対象日数・回数 / 公費１対象分のサービス単位数」) と kaigo-app の扱い由来。
 *
 * ── 生保の本人支払額 (2026-11-09) ─────────────────────────────────────────
 *   介護券の本人支払額 (client_public_expenses.self_pay_amount) までを本人負担、残りを公費請求。
 *   userAmount はこの本人負担を含む合計 (7111 保険請求分の利用者負担もこれ。kaigo-app と同じ)。
 *   伝送の 01 項35 / 10 項17 は userAmount − kohiHonninFutan (保険分の利用者負担のみ)、01 項41 / 10 項20 = kohiHonninFutan。
 *   実証: 中島 紀久子 (KK261004 7132) 単位 1,200 / 保険 10,800 / 項35 0 / 項39 1,200 / 項40 0 / 項41 1,200。
 *
 * 検証: npm run check:fukuyogu-amounts / npm run check:fukuyogu-densou (頭打ち・月途中の公費・本人支払額の節)
 */
import { halfMonthUnits, rentalDayMask, type DateRange } from "../half-month-units";

export interface KohiPeriod {
  start: string | null;
  end: string | null;
}

export interface FukuyoguKohi {
  hobetsu: string;
  futansha: string | null;
  jukyusha: string | null;
  /** 本人支払額 (介護券の月額・円)。null/未登録 = 0 円 (公費対象の利用者負担を全額公費へ) */
  selfPay?: number | null;
  /**
   * 当月に重なる公費の有効期間 (同じ負担者番号の行をまとめたもの。YYYY-MM-DD・null = 制限なし)。
   * 省略時は月の全期間 (= 従来どおり月途中の判定をしない)
   */
  periods?: KohiPeriod[];
}

/** 月途中の公費の扱い: none = 全部利用者負担 / daily = 日割り / half = 半月 */
export type KohiMonthMode = "none" | "daily" | "half";
export const KOHI_MONTH_MODES: readonly KohiMonthMode[] = ["none", "daily", "half"];
export const KOHI_MONTH_MODE_LABEL: Record<KohiMonthMode, string> = {
  none: "全部利用者負担",
  daily: "日割り",
  half: "半月",
};
/**
 * 未選択のときの扱い = none (その月は公費を付けない)。理由:
 *   1. 公費 (福祉事務所) へ ケアマネが決めていない額を請求しない (公費側の返戻・過誤を作らない)
 *   2. ほのぼのの実伝送と同じ (飯村 昭 9 月分は公費なしで請求済み = KK261004)
 *   3. 2026-11-09 以前の当方は「月の一部でも公費があれば月全体を公費」= 公費の過大請求の向きだった
 *   代わりに利用者負担が過大の向きになるので、請求画面と伝送の両方で必ず警告を出す。
 *   ⚠ user 判断待ち (2026-11-09)。変えるならこの 1 か所。
 */
export const KOHI_MONTH_MODE_DEFAULT: KohiMonthMode = "none";

export function isKohiMonthMode(v: unknown): v is KohiMonthMode {
  return v === "none" || v === "daily" || v === "half";
}

/** 1 用具 (明細の 1 品目) の入力。伝送の明細 02 と同じ並びで渡す */
export interface FukuyoguLineInput {
  unitPer: number;
  count: number;
  units: number;
  /** 貸与開始日 / 終了日 (YYYY-MM-DD。null = 制限なし) */
  rentalStart?: string | null;
  rentalEnd?: string | null;
  /** 休止 (order_item_pauses)。休止日は貸与日に数えない (公費の日割・半月の判定も同じ) */
  pauses?: readonly DateRange[] | null;
}

/** 明細 02 の 1 行分の公費 (公費1対象日数・回数 / 公費1対象サービス単位数) */
export interface KohiPiece {
  days: number;
  units: number;
}

export interface FukuyoguAmountInput {
  /** clients.benefit_rate の生値 (90/80/70/0。null・空・読めない値もありうる) */
  benefitRateRaw: string | null;
  /** clients.insured_number (H 始まり = 公費単独) */
  insuredNumber: string | null;
  /** 実績の単位数合計 (明細 02 のサービス単位数の合計) */
  totalUnits: number;
  /** 対象月に有効な公費 (生保 等)。無ければ null */
  kohi: FukuyoguKohi | null;
  /**
   * CM 指示単位数 (給付管理票の計画単位数)。null / undefined = 入力なし (実績で請求)。
   * 実績を超える値が入っていても請求は実績まで (計画単位数としては入力値をそのまま出す)。
   */
  cmUnits?: number | null;
  /** サービス提供月 "YYYY-MM" (月途中の公費の判定に使う。lines と一緒に渡す) */
  month?: string | null;
  /** 用具ごとの単位と貸与期間 (月途中の公費の判定・明細の公費対象に使う)。省略時は月途中の判定をしない */
  lines?: FukuyoguLineInput[] | null;
  /** 月途中の公費の扱い (請求画面で選んだ値)。null/undefined = 未選択 → KOHI_MONTH_MODE_DEFAULT */
  kohiMode?: KohiMonthMode | null;
}

export interface FukuyoguAmounts {
  /** 保険給付率 (90/80/70。公費単独は 0) */
  benefitRate: number;
  /** 利用者負担率 (0.1/0.2/0.3。公費単独は 1 = 保険給付なし) */
  copayRate: number;
  /** 実績の単位数 (= 入力の totalUnits。集計 10 項10 限度額管理対象単位数) */
  actualUnits: number;
  /** 保険請求の対象単位数 (頭打ち後。01 項33 / 10 項14 / 7111 項8)。CM 指示が無ければ actualUnits */
  billedUnits: number;
  /** 計画単位数 (10 項9)。CM 指示があればその値、無ければ actualUnits */
  planUnits: number;
  /** CM 指示単位数を超えた単位数 (保険外)。頭打ちしなければ 0 */
  overUnits: number;
  /** 保険外の金額 (overUnits × 10 円。全額自己負担。伝送には載らない) */
  outsideAmount: number;
  /** CM 指示単位数で頭打ちしたか */
  capped: boolean;
  /** 費用総額 (= billedUnits × 10 円。保険外は含まない) */
  totalCost: number;
  insuranceAmount: number;
  /**
   * 利用者負担額 = 費用総額 − 保険請求 − 公費請求 (公費分本人負担 kohiHonninFutan を含む合計)。
   * 保険外 (outsideAmount) は含まない。伝送の 01 項35 / 10 項17 には userAmount − kohiHonninFutan を出す
   */
  userAmount: number;
  /** 公費請求額 (公費が無ければ null) */
  kohiAmount: number | null;
  kohiHobetsu: string | null;
  kohiTandoku: boolean;
  /** 公費対象単位数 (01 項39 / 10 項18 / 7111 公費分 単位数)。公費が無ければ null */
  kohiUnits: number | null;
  /** 公費対象費用 (7111 公費分 費用合計)。公費が無ければ null */
  kohiTargetCost: number | null;
  /** 公費分本人負担額 (01 項41 / 10 項20)。公費が無ければ null */
  kohiHonninFutan: number | null;
  /** 公費の期間が月 (貸与期間) の一部だけ */
  kohiPartial: boolean;
  /** 実際に使った月途中の扱い (kohiPartial のときだけ。それ以外は null) */
  kohiMode: KohiMonthMode | null;
  /** 月途中なのに未選択で 既定 (KOHI_MONTH_MODE_DEFAULT) を使った */
  kohiModeDefaulted: boolean;
  /**
   * 明細 02 の公費対象 (lines と同じ並び × fukuyoguLinePieces の行)。
   * null = 月途中でない (明細は 公費対象日数 = 貸与日数 / 公費対象単位 = その行の単位 で出す)
   */
  kohiPieces: KohiPiece[][] | null;
  /** 利用者名を付けずに返す注意書き (呼出側で前置する) */
  warnings: string[];
}

/** 福祉用具の単位数単価 (10 円固定) */
const UNIT_YEN = 10;

/**
 * 明細 02 の行の分け方 (1 用具 1 行。同じ用具 n 個は n 行)。build.ts と共用。
 * unitPer × count と units が合わない (手入力の上書き等) ときは 1 行にまとめる。
 */
export function fukuyoguLinePieces(l: { unitPer: number; count: number; units: number }): number[] {
  const split = l.count > 1 && l.unitPer * l.count === l.units;
  return split ? Array.from({ length: l.count }, () => l.unitPer) : [l.units];
}

const daysOfMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
/** 当月の日 (1..N) のうち [start, end] のどれかに入る日の印 (index 0 は使わない) */
function daysMask(ym: string, ranges: KohiPeriod[]): boolean[] {
  const n = daysOfMonth(ym);
  const mask = Array.from({ length: n + 1 }, () => false);
  for (const r of ranges) {
    const s = (r.start ?? "").slice(0, 10);
    const e = (r.end ?? "").slice(0, 10);
    for (let d = 1; d <= n; d++) {
      const day = `${ym}-${String(d).padStart(2, "0")}`;
      if (s && day < s) continue;
      if (e && day > e) continue;
      mask[d] = true;
    }
  }
  return mask;
}
const countDays = (mask: boolean[], a: number, b: number, other?: boolean[]) => {
  let c = 0;
  for (let d = a; d <= b; d++) if (mask[d] && (!other || other[d])) c++;
  return c;
};

/**
 * 1 行 (1 個) の公費対象 (日数・単位)。純関数。
 *   R = その用具の当月の貸与日 / K = 公費の日。K∩R が空 → 0、K⊇R → 全部公費 (扱いによらない)。
 *   daily: 単位 = round(u × |K∩R| / |R|)、日数 = |K∩R|
 *   half : 公費の日が多いほうの半月 (同数なら後半) を公費の半月とする。
 *          貸与が両方の半月にかかる → round(u/2) (halfMonthUnits と同じ丸め)、
 *          貸与が公費の半月だけ → u、貸与が公費でない半月だけ → 0。日数 = 公費の半月にかかる貸与日数
 *   none : 0 (呼出側で公費欄ごと出さない)
 */
export function kohiShareOfPiece(u: number, rental: boolean[], kohi: boolean[], mode: KohiMonthMode): KohiPiece {
  const n = rental.length - 1;
  const rc = countDays(rental, 1, n);
  const kc = countDays(rental, 1, n, kohi);
  if (rc === 0 || kc === 0 || u <= 0 || mode === "none") return { days: 0, units: 0 };
  if (kc === rc) return { days: rc, units: u };
  if (mode === "daily") return { days: kc, units: Math.round((u * kc) / rc) };
  const kFirst = countDays(kohi, 1, Math.min(15, n));
  const kSecond = countDays(kohi, 16, n);
  const kohiHalfIsSecond = kSecond >= kFirst;
  const [a, b] = kohiHalfIsSecond ? [16, n] : [1, Math.min(15, n)];
  const rInKohiHalf = countDays(rental, a, b);
  if (rInKohiHalf === 0) return { days: 0, units: 0 };
  if (rInKohiHalf === rc) return { days: rc, units: u };
  return { days: rInKohiHalf, units: halfMonthUnits(u, !kohiHalfIsSecond, kohiHalfIsSecond) };
}

/**
 * 公費が当月の貸与期間の一部だけか (請求画面で「公費の扱い」を出す利用者の判定)。
 *   partial = 公費の日を含む用具があり、かつ どれかの用具に公費でない貸与日がある
 *   covered = 貸与日のどこかに公費がかかる (false = 公費の期間と貸与が重ならない → 公費を付けない)
 */
export function kohiCoverageInMonth(periods: KohiPeriod[] | null | undefined, lines: FukuyoguLineInput[], ym: string) {
  const kohi = daysMask(ym, periods && periods.length ? periods : [{ start: null, end: null }]);
  const rentals = lines.map((l) => rentalDayMask(l.rentalStart ?? null, l.rentalEnd ?? null, ym, l.pauses ?? []));
  let anyCovered = false;
  let anyUncovered = false;
  for (const r of rentals) {
    const n = r.length - 1;
    const rc = countDays(r, 1, n);
    const kc = countDays(r, 1, n, kohi);
    if (kc > 0) anyCovered = true;
    if (kc < rc) anyUncovered = true;
  }
  const n = kohi.length - 1;
  let first = -1;
  let last = -1;
  for (let d = 1; d <= n; d++) if (kohi[d]) { if (first < 0) first = d; last = d; }
  const ymd = (d: number) => `${ym}-${String(d).padStart(2, "0")}`;
  return {
    kohi,
    rentals,
    covered: anyCovered,
    partial: anyCovered && anyUncovered,
    /** 公費の当月内の最初/最後の日 (表示用。無ければ null) */
    firstDay: first >= 1 ? ymd(first) : null,
    lastDay: last >= 1 ? ymd(last) : null,
  };
}

/** 本人支払額の入力値を読む (負・非整数・空は 0) */
export function normalizeSelfPay(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(String(v).normalize("NFKC").replace(/[,\s円]/g, ""));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** CM 指示単位数の入力値を読む。null・空・負・非整数は「入力なし」(null) */
export function normalizeCmUnits(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).normalize("NFKC").replace(/[,\s]/g, ""));
  if (String(v).trim() === "" || !Number.isInteger(n) || n < 0) return null;
  return n;
}

/**
 * 頭打ちの単位数だけを決める (金額の計算は computeFukuyoguAmounts)。
 *   planUnits = CM 指示があればその値 / 無ければ実績
 *   billedUnits = min(実績, CM 指示)
 */
export function capFukuyoguUnits(actualUnits: number, cmUnits: number | null | undefined) {
  const cm = normalizeCmUnits(cmUnits ?? null);
  if (cm == null) return { planUnits: actualUnits, billedUnits: actualUnits, overUnits: 0, capped: false, cmUnits: null };
  const billedUnits = Math.min(actualUnits, cm);
  return { planUnits: cm, billedUnits, overUnits: actualUnits - billedUnits, capped: billedUnits < actualUnits, cmUnits: cm };
}

const NO_KOHI = {
  kohiAmount: null,
  kohiHobetsu: null,
  kohiUnits: null,
  kohiTargetCost: null,
  kohiHonninFutan: null,
  kohiPieces: null,
} as const;

export function computeFukuyoguAmounts(input: FukuyoguAmountInput): FukuyoguAmounts {
  const warnings: string[] = [];
  const cap = capFukuyoguUnits(input.totalUnits, input.cmUnits);
  const unitsPart = {
    actualUnits: input.totalUnits,
    billedUnits: cap.billedUnits,
    planUnits: cap.planUnits,
    overUnits: cap.overUnits,
    outsideAmount: cap.overUnits * UNIT_YEN,
    capped: cap.capped,
  };
  if (cap.capped) {
    warnings.push(
      `CM 指示単位数で頭打ち: 実績 ${input.totalUnits.toLocaleString()} 単位のうち CM 指示 ${cap.billedUnits.toLocaleString()} 単位までを保険請求し、超過 ${cap.overUnits.toLocaleString()} 単位 (${unitsPart.outsideAmount.toLocaleString()} 円) は保険外 (全額自己負担) にしました`,
    );
  }
  const totalCost = cap.billedUnits * UNIT_YEN;
  const raw = (input.benefitRateRaw ?? "").trim();
  const parsed = parseInt(raw, 10);
  const kohiTandoku = /^[Hh]/.test((input.insuredNumber ?? "").trim());
  const selfPay = normalizeSelfPay(input.kohi?.selfPay ?? null);

  // ── 月途中の公費の判定 (month と lines と公費の期間が揃っているときだけ) ──
  const coverage =
    input.kohi && input.month && input.lines && input.lines.length > 0 && input.kohi.periods
      ? kohiCoverageInMonth(input.kohi.periods, input.lines, input.month)
      : null;
  const kohiRange = coverage ? `${coverage.firstDay ?? "?"}〜${coverage.lastDay ?? "?"}` : "";

  if (kohiTandoku) {
    // 公費単独: 保険は 1 円も出さず、全額を公費 (生活保護 = 法別 12) で請求する
    if (!input.kohi) {
      warnings.push(
        "公費単独 (被保険者番号 H) なのに対象月に有効な公費情報がありません — 生活保護 (法別12) の負担者番号・受給者番号を登録してください (未登録のままだと返戻になります)",
      );
    }
    if (Number.isFinite(parsed) && parsed > 0) {
      warnings.push(`公費単独 (被保険者番号 H) なのに給付率が "${raw}" です — 保険では請求せず全額を公費で計算しました`);
    }
    if (coverage?.partial) {
      warnings.push(`公費単独 (被保険者番号 H) なのに公費の期間 (${kohiRange}) が月の一部です — 保険給付が無いため月全体を公費で計算しました。介護券の期間を確認してください`);
    }
    // 本人支払額までは本人負担 (kaigo-app aggregate.ts の transferToKohi と同じ。未登録なら 0 = 全額公費)
    const honnin = Math.min(totalCost, selfPay);
    return {
      benefitRate: 0,
      copayRate: 1,
      ...unitsPart,
      totalCost,
      insuranceAmount: 0,
      userAmount: honnin,
      kohiAmount: totalCost - honnin,
      kohiHobetsu: input.kohi?.hobetsu ?? "12",
      kohiTandoku: true,
      kohiUnits: cap.billedUnits,
      kohiTargetCost: totalCost,
      kohiHonninFutan: honnin,
      kohiPartial: !!coverage?.partial,
      kohiMode: null,
      kohiModeDefaulted: false,
      kohiPieces: null,
      warnings,
    };
  }

  // 2026-08-31 監査: 未設定を無警告で 90 (1割負担) にしていた。既定 (90) は変えず、必ず警告を出す。
  //   2割負担者を 1割で出すと 費用総額7,200円 → 保険請求 6,480円 (正は 5,760円) = 720円/月 の過大請求 → 返戻。
  const benefitRate = Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
  if (!raw) {
    warnings.push("給付率が未設定のため 1 割 (90) で計算しました — 2割/3割なら過大請求になります。負担割合証を確認してください");
  } else if (!Number.isFinite(parsed) || parsed <= 0) {
    warnings.push(`給付率 "${raw}" を読めないため 1 割 (90) で計算しました — 値を確認してください`);
  }
  const copayRate = Math.max(0, 100 - benefitRate) / 100;
  const insuranceAmount = Math.floor((totalCost * benefitRate) / 100);
  const rawUserAmount = totalCost - insuranceAmount;
  const base = { benefitRate, copayRate, ...unitsPart, totalCost, insuranceAmount, kohiTandoku: false };
  const noKohiResult = (partial: boolean, mode: KohiMonthMode | null, defaulted: boolean): FukuyoguAmounts => ({
    ...base,
    userAmount: rawUserAmount,
    ...NO_KOHI,
    kohiPartial: partial,
    kohiMode: mode,
    kohiModeDefaulted: defaulted,
    warnings,
  });

  if (!input.kohi) return noKohiResult(false, null, false);

  if (coverage && !coverage.covered) {
    // 公費の期間と貸与日が重ならない (例: 9/10 に撤去・9/28 から生保) → 公費は付けない
    warnings.push(`公費 (法別${input.kohi.hobetsu}) の期間 (${kohiRange}) に貸与日がありません — この月は公費を付けずに請求しました`);
    return noKohiResult(false, null, false);
  }

  if (coverage?.partial) {
    const defaulted = !isKohiMonthMode(input.kohiMode);
    const mode: KohiMonthMode = defaulted ? KOHI_MONTH_MODE_DEFAULT : (input.kohiMode as KohiMonthMode);
    if (defaulted) {
      warnings.push(
        `公費 (法別${input.kohi.hobetsu}) が月の途中で始まる/終わる (${kohiRange}) のに「公費の扱い」が未選択です — 既定の「${KOHI_MONTH_MODE_LABEL[mode]}」で計算しました。ケアマネの方針 (全部利用者負担 / 日割り / 半月) を請求画面で選んでください`,
      );
    }
    if (mode === "none") {
      if (!defaulted) warnings.push(`公費 (法別${input.kohi.hobetsu}) の期間 (${kohiRange}) が月の一部 — 「全部利用者負担」の指定どおり この月は公費を付けずに請求しました`);
      return noKohiResult(true, mode, defaulted);
    }
    const lines = input.lines!;
    const kohiPieces = lines.map((l, i) =>
      fukuyoguLinePieces(l).map((u) => kohiShareOfPiece(u, coverage.rentals[i], coverage.kohi, mode)),
    );
    const kohiPieceSum = kohiPieces.reduce((s, ps) => s + ps.reduce((t, p) => t + p.units, 0), 0);
    // 限度 (CM 指示単位数) を超えた分は公費対象外 (kaigo-app と同じく保険の対象単位で頭打ち)
    const kohiUnits = Math.min(kohiPieceSum, cap.billedUnits);
    if (kohiUnits < kohiPieceSum) {
      warnings.push(`公費対象単位数 (${kohiPieceSum}) を CM 指示単位数で頭打ちした保険の単位数 (${cap.billedUnits}) に合わせました — 明細の公費対象単位の合計と一致しないので、伝送前にレセプトを確認してください`);
    }
    const kohiTargetCost = Math.min(kohiUnits * UNIT_YEN, totalCost);
    const kohiTargetInsurance = Math.floor((kohiTargetCost * benefitRate) / 100);
    const afterIns = kohiTargetCost - kohiTargetInsurance;
    const honnin = Math.min(afterIns, selfPay);
    const kohiAmount = afterIns - honnin;
    warnings.push(
      `公費 (法別${input.kohi.hobetsu}) の期間 (${kohiRange}) が月の一部 — 「${KOHI_MONTH_MODE_LABEL[mode]}」で 公費対象 ${kohiUnits}/${cap.billedUnits} 単位・公費請求 ${kohiAmount.toLocaleString()} 円にしました`,
    );
    return {
      ...base,
      userAmount: totalCost - insuranceAmount - kohiAmount,
      kohiAmount,
      kohiHobetsu: input.kohi.hobetsu,
      kohiUnits,
      kohiTargetCost,
      kohiHonninFutan: honnin,
      kohiPartial: true,
      kohiMode: mode,
      kohiModeDefaulted: defaulted,
      kohiPieces,
      warnings,
    };
  }

  // 公費 (生保 等) が月の全期間: 本人負担分を公費へ振替。本人支払額までは本人 (未登録 = 0 = 全額公費)
  const honnin = Math.min(rawUserAmount, selfPay);
  return {
    ...base,
    userAmount: honnin,
    kohiAmount: rawUserAmount - honnin,
    kohiHobetsu: input.kohi.hobetsu,
    kohiUnits: cap.billedUnits,
    kohiTargetCost: totalCost,
    kohiHonninFutan: honnin,
    kohiPartial: false,
    kohiMode: null,
    kohiModeDefaulted: false,
    kohiPieces: null,
    warnings,
  };
}
