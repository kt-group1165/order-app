/**
 * 負担割合証等 (client_benefit_certificates) の読み込み (order-app 専用。純関数は ./cert-month.ts)。
 *
 * ★ 表が未適用 (migrations/client_benefit_certificates.sql) でも画面は壊さない:
 *   available=false と理由を返す。呼び出し側 (BillingTab) は従来どおり clients.benefit_rate で請求する
 *   (表を適用する前に金額を動かさないため)。表があれば純関数 resolveBenefitForMonth の結果で請求する。
 */
import { supabase } from "@/lib/supabase";
import { selectAllPagedParallel } from "@/lib/pagedParallel";
import type { BenefitCertRow } from "./cert-month";

export type BenefitCertDbRow = BenefitCertRow & {
  id: string;
  client_id: string;
  insurer_number: string | null;
  insured_number: string | null;
  source: string;
};

export type BenefitCertsLoad = {
  available: boolean;
  /** client_id → 証 (全期間) */
  byClient: Map<string, BenefitCertDbRow[]>;
  /** 読めなかった理由 (画面に出す)。読めたら null */
  notice: string | null;
};

const COLS = "id, client_id, kind, benefit_rate, valid_from, valid_to, office_id, restriction, insurer_number, insured_number, source";

export async function loadBenefitCertificates(tenantId: string): Promise<BenefitCertsLoad> {
  const empty = new Map<string, BenefitCertDbRow[]>();
  // 表の有無は通常の select で聞く (head: true だと 404 の code が取れず「未作成」と見分けられない)
  const probe = await supabase.from("client_benefit_certificates").select("id").eq("tenant_id", tenantId).limit(1);
  if (probe.error) {
    const missing = probe.error.code === "42P01" || probe.error.code === "PGRST205";
    console.error("負担割合証 (client_benefit_certificates) の取得失敗:", probe.error.message);
    return {
      available: false,
      byClient: empty,
      notice: missing
        ? "負担割合証の表が未作成のため、給付率は従来どおり利用者マスタ (clients.benefit_rate) で計算しています (migrations/client_benefit_certificates.sql)"
        : `負担割合証を読めなかったため、給付率は従来どおり利用者マスタ (clients.benefit_rate) で計算しています (${probe.error.message})`,
    };
  }
  try {
    const rows = await selectAllPagedParallel<BenefitCertDbRow>(
      () => supabase.from("client_benefit_certificates").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
      (from, to) => supabase.from("client_benefit_certificates").select(COLS).eq("tenant_id", tenantId).order("id").range(from, to),
    );
    const byClient = new Map<string, BenefitCertDbRow[]>();
    for (const r of rows) {
      if (!byClient.has(r.client_id)) byClient.set(r.client_id, []);
      byClient.get(r.client_id)!.push(r);
    }
    return { available: true, byClient, notice: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("負担割合証 (client_benefit_certificates) の取得失敗:", msg);
    return { available: false, byClient: empty, notice: `負担割合証を読めなかったため、給付率は認定行の値で計算しています (${msg})` };
  }
}
