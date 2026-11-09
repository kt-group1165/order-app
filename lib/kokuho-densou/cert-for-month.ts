/**
 * 伝送 (7131/7132-01) の 要介護度・認定有効期間 に使う「その月に有効な認定」を選ぶ。
 *
 * ★ 2026-11-09: 以前は clients.care_level / certification_start_date / certification_end_date を
 *   そのまま使っていたが、ほのぼの実伝送 (ケアサポ KK261004 = 提供 2026-09) と比べると
 *   clients の列は古いことが多かった (認定開始 49 名・終了 46 名・要介護度 26 名が食い違い、
 *   そのうち 47 / 45 / 25 名は client_insurance_records の当月有効レコードならほのぼのと一致)。
 *   要介護度は 7131 (要介護) / 7132 (要支援) の振り分けにも効く。
 *   → 当月に有効な認定レコードを優先し、無いときだけ clients の列を使う。
 *
 * 選び方 (BillingTab の autoLateClients = 月遅れの自動判定 も同じ関数を使う):
 *   effective_date の新しい順に見て、認定期間 (開始が無ければ effective_date) が当月に掛かるもののうち、
 *   ★ 利用者の保険者番号+被保険者番号 (clients の列 = 伝送に載せる番号) と一致する最初の 1 件。
 *   一致するものが無ければ (番号が未登録・番号が違う) 従来どおり当月に掛かる最初の 1 件。
 *
 * ★ 2026-11-09 (FY-C2): 被保番の一致を優先にした。内海 淳 (被保番 1000304436) は 旧被保番 H333010211
 *   (生保単独だった頃) の認定 (2024-05〜2028-04) が当月に掛かったまま残っていて、正しい認定
 *   (1000304436・2026-04-22〜2026-10-31) は effective_date が null のため並べ替えで負けていた
 *   → 伝送の認定期間が旧証のものになっていた。並べ替えの鍵 (開始日順 等) を変える案は 國島 彰 が崩れるので採らない。
 *   ケアサポ所属の全員で試して、選ぶ認定が変わるのは内海 1 名だけ (scripts/fukuyogu-densou-check.mts に固定データ)。
 *   ⚠ lib/insurance/cert-month.ts の pickCertForMonth (kaigo-app と同一・給付率の解決用) とは別物。
 */
export type CertLike = {
  effective_date?: string | null;
  certification_start_date?: string | null;
  certification_end_date?: string | null;
  care_level?: string | null;
  insurer_number?: string | null;
  insured_number?: string | null;
};

/** 番号の比較用 (全角→半角・空白除去。保険者番号は 8 桁に 0 埋め = build.ts の並び順キーと同じ) */
const normInsurer = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/\s/g, "").padStart(8, "0");
const normInsured = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/\s/g, "");

export function pickCertForMonth<T extends CertLike>(
  records: T[],
  monthStart: string,
  monthEnd: string,
  /** 利用者の保険者番号・被保険者番号 (clients の列)。渡すと番号が一致する認定を優先する */
  prefer?: { insurerNumber?: string | null; insuredNumber?: string | null } | null,
): T | null {
  const inMonth = records
    .slice()
    .sort((a, b) => (b.effective_date ?? "").localeCompare(a.effective_date ?? ""))
    .filter((r) => {
      const start = r.certification_start_date ?? r.effective_date;
      const end = r.certification_end_date;
      if (start && start > monthEnd) return false;
      if (end && end < monthStart) return false;
      return true;
    });
  const insured = normInsured(prefer?.insuredNumber);
  if (insured) {
    const insurer = (prefer?.insurerNumber ?? "").trim() ? normInsurer(prefer?.insurerNumber) : null;
    const hit = inMonth.find((r) =>
      normInsured(r.insured_number) === insured && (insurer == null || normInsurer(r.insurer_number) === insurer));
    if (hit) return hit;
  }
  return inMonth[0] ?? null;
}

/** 伝送に載せる 要介護度・認定期間。認定レコードの値を優先し、空の項目だけ clients の列で補う */
export function certFieldsForDensou(
  client: { care_level: string | null; certification_start_date: string | null; certification_end_date: string | null },
  cert: CertLike | null,
): { careLevel: string | null; certStart: string | null; certEnd: string | null } {
  return {
    careLevel: cert?.care_level || client.care_level,
    certStart: cert?.certification_start_date || client.certification_start_date,
    certEnd: cert?.certification_end_date || client.certification_end_date,
  };
}
