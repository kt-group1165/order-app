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
 * 検証: npm run check:fukuyogu-amounts / npm run check:fukuyogu-densou (頭打ちの節)
 */

export interface FukuyoguKohi {
  hobetsu: string;
  futansha: string | null;
  jukyusha: string | null;
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
  /** 利用者負担額 (保険分の 1〜3 割。公費があれば 0)。保険外 (outsideAmount) は含まない */
  userAmount: number;
  /** 公費請求額 (公費が無ければ null) */
  kohiAmount: number | null;
  kohiHobetsu: string | null;
  kohiTandoku: boolean;
  /** 利用者名を付けずに返す注意書き (呼出側で前置する) */
  warnings: string[];
}

/** 福祉用具の単位数単価 (10 円固定) */
const UNIT_YEN = 10;

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
    return {
      benefitRate: 0,
      copayRate: 1,
      ...unitsPart,
      totalCost,
      insuranceAmount: 0,
      userAmount: 0,
      kohiAmount: totalCost,
      kohiHobetsu: input.kohi?.hobetsu ?? "12",
      kohiTandoku: true,
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
  // 公費 (生保 等): 本人負担分を公費へ振替、本人負担は 0 (v1 = 全額公費前提)
  return {
    benefitRate,
    copayRate,
    ...unitsPart,
    totalCost,
    insuranceAmount,
    userAmount: input.kohi ? 0 : rawUserAmount,
    kohiAmount: input.kohi ? rawUserAmount : null,
    kohiHobetsu: input.kohi?.hobetsu ?? null,
    kohiTandoku: false,
    warnings,
  };
}
