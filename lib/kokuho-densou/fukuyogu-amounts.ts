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
 * 検証: npm run check:fukuyogu-amounts
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
  totalUnits: number;
  /** 対象月に有効な公費 (生保 等)。無ければ null */
  kohi: FukuyoguKohi | null;
}

export interface FukuyoguAmounts {
  /** 保険給付率 (90/80/70。公費単独は 0) */
  benefitRate: number;
  /** 利用者負担率 (0.1/0.2/0.3。公費単独は 1 = 保険給付なし) */
  copayRate: number;
  totalCost: number;
  insuranceAmount: number;
  /** 利用者負担額 (公費があれば 0) */
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

export function computeFukuyoguAmounts(input: FukuyoguAmountInput): FukuyoguAmounts {
  const warnings: string[] = [];
  const totalCost = input.totalUnits * UNIT_YEN;
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
    totalCost,
    insuranceAmount,
    userAmount: input.kohi ? 0 : rawUserAmount,
    kohiAmount: input.kohi ? rawUserAmount : null,
    kohiHobetsu: input.kohi?.hobetsu ?? null,
    kohiTandoku: false,
    warnings,
  };
}
