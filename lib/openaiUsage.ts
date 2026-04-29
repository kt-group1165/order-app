import { supabase } from "./supabase";

// purpose 内訳キー
export type OpenAIPurpose = "transcribe_kana" | "manual_kana" | "bulk_furigana" | "other";

const PURPOSE_LABEL: Record<OpenAIPurpose, string> = {
  transcribe_kana: "音声発注（カナ変換）",
  manual_kana: "手動フリガナ生成",
  bulk_furigana: "用具一括フリガナ生成",
  other: "その他",
};

export type OpenAIUsageBreakdown = {
  purpose: OpenAIPurpose;
  label: string;
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  costJpy: number;
};

export type OpenAIUsageSummary = {
  // 今月
  monthCallCount: number;
  monthInputTokens: number;
  monthOutputTokens: number;
  monthCostJpy: number;
  monthBreakdown: OpenAIUsageBreakdown[];
  // 累計
  totalCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostJpy: number;
};

type Row = {
  purpose: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_jpy: number | null;
};

function classify(p: string | null | undefined): OpenAIPurpose {
  if (p === "transcribe_kana" || p === "manual_kana" || p === "bulk_furigana") return p;
  return "other";
}

export async function getOpenAIUsageSummary(tenantId: string): Promise<OpenAIUsageSummary> {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [monthRes, totalRes] = await Promise.all([
    supabase
      .from("openai_usage")
      .select("purpose, input_tokens, output_tokens, cost_jpy")
      .eq("tenant_id", tenantId)
      .gte("created_at", firstOfMonth),
    supabase
      .from("openai_usage")
      .select("purpose, input_tokens, output_tokens, cost_jpy")
      .eq("tenant_id", tenantId),
  ]);

  const monthData: Row[] = monthRes.data ?? [];
  const totalData: Row[] = totalRes.data ?? [];

  const sumOf = (rows: Row[]) => ({
    callCount: rows.length,
    inputTokens: rows.reduce((s, r) => s + Number(r.input_tokens ?? 0), 0),
    outputTokens: rows.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0),
    costJpy: rows.reduce((s, r) => s + Number(r.cost_jpy ?? 0), 0),
  });

  const monthTotal = sumOf(monthData);
  const total = sumOf(totalData);

  // 今月の用途別内訳
  const groups = new Map<OpenAIPurpose, Row[]>();
  for (const row of monthData) {
    const k = classify(row.purpose);
    const arr = groups.get(k) ?? [];
    arr.push(row);
    groups.set(k, arr);
  }
  const monthBreakdown: OpenAIUsageBreakdown[] = Array.from(groups.entries()).map(
    ([purpose, rows]) => {
      const s = sumOf(rows);
      return {
        purpose,
        label: PURPOSE_LABEL[purpose],
        callCount: s.callCount,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        costJpy: s.costJpy,
      };
    }
  ).sort((a, b) => b.costJpy - a.costJpy);

  return {
    monthCallCount: monthTotal.callCount,
    monthInputTokens: monthTotal.inputTokens,
    monthOutputTokens: monthTotal.outputTokens,
    monthCostJpy: monthTotal.costJpy,
    monthBreakdown,
    totalCallCount: total.callCount,
    totalInputTokens: total.inputTokens,
    totalOutputTokens: total.outputTokens,
    totalCostJpy: total.costJpy,
  };
}
