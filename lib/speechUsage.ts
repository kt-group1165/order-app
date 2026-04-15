import { supabase } from "./supabase";

// Google Speech-to-Text v2 long モデル: 月60分無料、超過分 $0.016/分 ≒ ¥2.4/分
const FREE_SECONDS_PER_MONTH = 60 * 60; // 3600秒
const YEN_PER_MINUTE = 2.4;

export type SpeechUsageSummary = {
  monthSeconds: number;
  monthCallCount: number;
  monthRawCostJpy: number; // 無料枠を考慮しない単純合計
  monthBillableCostJpy: number; // 無料枠控除後の実質料金
  freeSecondsRemaining: number;
  totalSeconds: number;
  totalCallCount: number;
  totalCostJpy: number;
};

export async function getSpeechUsageSummary(
  tenantId: string
): Promise<SpeechUsageSummary> {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [monthRes, totalRes] = await Promise.all([
    supabase
      .from("speech_usage")
      .select("billed_seconds, cost_jpy")
      .eq("tenant_id", tenantId)
      .gte("created_at", firstOfMonth),
    supabase
      .from("speech_usage")
      .select("billed_seconds, cost_jpy")
      .eq("tenant_id", tenantId),
  ]);

  const monthData = monthRes.data ?? [];
  const totalData = totalRes.data ?? [];

  const monthSeconds = monthData.reduce(
    (s, r) => s + Number(r.billed_seconds ?? 0),
    0
  );
  const monthRawCostJpy = monthData.reduce(
    (s, r) => s + Number(r.cost_jpy ?? 0),
    0
  );
  const monthCallCount = monthData.length;

  const totalSeconds = totalData.reduce(
    (s, r) => s + Number(r.billed_seconds ?? 0),
    0
  );
  const totalCostJpy = totalData.reduce(
    (s, r) => s + Number(r.cost_jpy ?? 0),
    0
  );
  const totalCallCount = totalData.length;

  const freeSecondsRemaining = Math.max(0, FREE_SECONDS_PER_MONTH - monthSeconds);
  const monthBillableSeconds = Math.max(0, monthSeconds - FREE_SECONDS_PER_MONTH);
  const monthBillableCostJpy = (monthBillableSeconds / 60) * YEN_PER_MINUTE;

  return {
    monthSeconds,
    monthCallCount,
    monthRawCostJpy,
    monthBillableCostJpy,
    freeSecondsRemaining,
    totalSeconds,
    totalCallCount,
    totalCostJpy,
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds - m * 60);
  return `${m}分${s}秒`;
}
