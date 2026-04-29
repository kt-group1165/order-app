// OpenAI を使った漢字混じり日本語テキスト → カタカナ読み変換
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const MODEL = "gpt-4o-mini";

// gpt-4o-mini 公式料金（2026年初時点）
// Input:  $0.150 / 1M tokens
// Output: $0.600 / 1M tokens
const USD_PER_INPUT_TOKEN = 0.150 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 0.600 / 1_000_000;
// 1USD ≒ 150円で換算（為替変動の影響を受けるため概算）
const JPY_PER_USD = 150;

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  _client = new OpenAI({ apiKey });
  return _client;
}

/** トークン数から日本円換算した料金を計算 */
export function calcKanaCostJpy(inputTokens: number, outputTokens: number): number {
  const usd = inputTokens * USD_PER_INPUT_TOKEN + outputTokens * USD_PER_OUTPUT_TOKEN;
  return usd * JPY_PER_USD;
}

/** Supabase に使用量を記録（失敗してもメイン処理は続行） */
async function logUsage(opts: {
  tenantId?: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  textCount: number;
}): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return;
    const sb = createClient(url, key);
    const costJpy = calcKanaCostJpy(opts.inputTokens, opts.outputTokens);
    await sb.from("openai_usage").insert({
      tenant_id: opts.tenantId ?? null,
      model: MODEL,
      purpose: opts.purpose,
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      cost_jpy: Number(costJpy.toFixed(4)),
      text_count: opts.textCount,
    });
  } catch (e) {
    console.error("openai usage log error:", e);
  }
}

/**
 * 入力テキスト群をすべてカタカナの読みに変換する。
 * 入力配列の順序を保ったまま、同じ長さの配列を返す。失敗した要素は元の文字列。
 *
 * 第2引数で使用量記録のメタ情報を渡せる（tenantId と purpose）。
 */
export async function toKatakanaReadings(
  texts: string[],
  meta?: { tenantId?: string; purpose?: string }
): Promise<string[]> {
  const filtered = texts.map((t) => (t ?? "").trim()).filter((t) => t.length > 0);
  if (filtered.length === 0) return texts.map(() => "");

  const client = getClient();
  if (!client) {
    // OPENAI_API_KEY 未設定の場合は元のテキストをそのまま返す（呼出側が辞書比較にフォールバック）
    return texts.map((t) => (t ?? "").trim());
  }

  // 入力をJSON配列で渡し、同じ長さのカタカナ配列を返してもらう
  const prompt = `以下の日本語テキスト配列の各要素を、すべてカタカナの読み仮名に変換してください。
- 漢字・ひらがな・英数字すべてカタカナの読みに直す（数字は読み上げ）
- 元の単語の区切りは保ち、不要な記号・空白は削除しない
- 配列の長さと順序は変えない
- 出力は厳密に JSON 配列のみ。説明や前置きは不要

入力: ${JSON.stringify(filtered)}
出力:`;

  try {
    const res = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: "あなたは日本語の読み仮名（カタカナ）変換を行う専門アシスタントです。出力は必ず JSON 配列のみ。" },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    });

    // 使用トークンを Supabase に記録（失敗時は呼出側に影響なし）
    const usage = res.usage;
    if (usage) {
      await logUsage({
        tenantId: meta?.tenantId,
        purpose: meta?.purpose ?? "kana_convert",
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        textCount: filtered.length,
      });
    }

    const content = res.choices[0]?.message?.content ?? "";
    // response_format=json_object のとき、モデルは {"result": [...]} のような形を返すので柔軟にパース
    let arr: string[] = [];
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        arr = parsed;
      } else if (Array.isArray(parsed.result)) {
        arr = parsed.result;
      } else if (Array.isArray(parsed.readings)) {
        arr = parsed.readings;
      } else {
        // 値の中で最初に配列が見つかったものを採用
        for (const v of Object.values(parsed)) {
          if (Array.isArray(v)) { arr = v as string[]; break; }
        }
      }
    } catch {
      arr = [];
    }

    if (arr.length !== filtered.length) {
      // 長さが合わなければ全件元テキストにフォールバック
      return texts.map((t) => (t ?? "").trim());
    }

    // texts 内の空要素は空のまま戻す
    const result: string[] = [];
    let j = 0;
    for (const t of texts) {
      const trimmed = (t ?? "").trim();
      if (!trimmed) { result.push(""); continue; }
      result.push(String(arr[j] ?? trimmed));
      j++;
    }
    return result;
  } catch (e) {
    console.error("OpenAI kana conversion error:", e);
    return texts.map((t) => (t ?? "").trim());
  }
}
