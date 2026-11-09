/**
 * 福祉用具 CM 指示単位数 (fukuyogu_cm_units) の読み書き。
 *
 * ケアマネが給付管理で割り付けた単位数 (= 給付管理票の計画単位数)。利用者ごと・月ごとに請求画面で入力する。
 * 入力があれば その単位数までを保険請求し、超えた分は保険外 (全額自己負担)。空欄なら従来どおり実績で請求。
 * 計算は lib/kokuho-densou/fukuyogu-amounts.ts (computeFukuyoguAmounts の cmUnits)。
 *
 * ⚠ 表は migrations/fukuyogu_cm_units.sql。**未適用でも請求画面と伝送は壊さない**:
 *   読めなければ「入力なし」(空の Map) として扱い、available=false と理由を返す (呼出側で画面に出す)。
 */
import { supabase } from "./supabase";
import { isTableMissingError } from "./fukuyoguExceptions";

export type FukuyoguCmUnitRow = {
  id: string;
  tenant_id: string;
  office_id: string;
  client_id: string;
  /** "YYYY-MM" (サービス提供月) */
  service_month: string;
  units: number;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CmUnitsLoad = {
  /** client_id → 単位数 */
  byClient: Map<string, number>;
  /** 表が読めたか (false = 未適用・権限なし・通信エラー。全員「入力なし」扱い) */
  available: boolean;
  /** 読めなかった理由 / 事業所未選択で複数の値がある等の注意 (画面に出す) */
  message: string | null;
};

/**
 * 当月の CM 指示単位数を読む。
 * officeId を渡すとその事業所の値だけ。null (全事業所表示) のときは利用者ごとに 1 件だけなら使い、
 * 事業所によって値が違う利用者は「入力なし」にして message で知らせる (どちらで頭打ちするか決められないため)。
 */
export async function getCmUnits(tenantId: string, month: string, officeId: string | null): Promise<CmUnitsLoad> {
  const byClient = new Map<string, number>();
  const rows: Pick<FukuyoguCmUnitRow, "client_id" | "office_id" | "units">[] = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("fukuyogu_cm_units")
      .select("client_id, office_id, units")
      .eq("tenant_id", tenantId)
      .eq("service_month", month);
    if (officeId) q = q.eq("office_id", officeId);
    const { data, error } = await q.order("id").range(from, from + 999);
    if (error) {
      const why = isTableMissingError(error)
        ? "CM 指示単位数の表 (fukuyogu_cm_units) が未適用です — migrations/fukuyogu_cm_units.sql を適用するまで、全員 実績で請求します"
        : `CM 指示単位数を読めませんでした (${error.message}) — 全員 実績で請求します`;
      console.error("fukuyogu_cm_units 読込失敗:", error.code, error.message);
      return { byClient, available: false, message: why };
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const conflicted: string[] = [];
  const seen = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!seen.has(r.client_id)) seen.set(r.client_id, new Set());
    seen.get(r.client_id)!.add(r.units);
  }
  for (const [cid, vals] of seen) {
    if (vals.size === 1) byClient.set(cid, [...vals][0]);
    else conflicted.push(cid);
  }
  return {
    byClient,
    available: true,
    message: conflicted.length
      ? `事業所によって CM 指示単位数が違う利用者が ${conflicted.length} 名います — 事業所を選ぶとその事業所の値で頭打ちします (全事業所表示では実績で請求)`
      : null,
  };
}

/** 入力値を保存する (同じ 利用者×月×事業所 は上書き)。units=null で削除 (= 実績で請求に戻す) */
export async function saveCmUnits(args: {
  tenantId: string;
  officeId: string;
  clientId: string;
  month: string;
  units: number | null;
  note?: string | null;
}): Promise<void> {
  const { tenantId, officeId, clientId, month, units } = args;
  if (units == null) {
    const { error } = await supabase
      .from("fukuyogu_cm_units")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("office_id", officeId)
      .eq("client_id", clientId)
      .eq("service_month", month);
    if (error) throw new Error(`CM 指示単位数の削除に失敗: ${error.message}`);
    return;
  }
  // created_by は DB の既定値 (auth.uid()) に任せる (上書き時に最初の入力者を消さないため送らない)
  const { error } = await supabase.from("fukuyogu_cm_units").upsert(
    {
      tenant_id: tenantId,
      office_id: officeId,
      client_id: clientId,
      service_month: month,
      units,
      note: args.note ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,office_id,client_id,service_month" },
  );
  if (error) throw new Error(`CM 指示単位数の保存に失敗: ${error.message}`);
}
