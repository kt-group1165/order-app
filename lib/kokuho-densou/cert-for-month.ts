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
 * 選び方は BillingTab の autoLateClients (月遅れの自動判定) と同じ:
 *   effective_date の新しい順に見て、認定期間 (開始が無ければ effective_date) が当月に掛かる最初の 1 件。
 */
export type CertLike = {
  effective_date?: string | null;
  certification_start_date?: string | null;
  certification_end_date?: string | null;
  care_level?: string | null;
};

export function pickCertForMonth<T extends CertLike>(records: T[], monthStart: string, monthEnd: string): T | null {
  return records
    .slice()
    .sort((a, b) => (b.effective_date ?? "").localeCompare(a.effective_date ?? ""))
    .find((r) => {
      const start = r.certification_start_date ?? r.effective_date;
      const end = r.certification_end_date;
      if (start && start > monthEnd) return false;
      if (end && end < monthStart) return false;
      return true;
    }) ?? null;
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
