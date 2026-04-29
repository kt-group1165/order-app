// OpenAI を使った漢字混じり日本語テキスト → カタカナ読み変換
import OpenAI from "openai";

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (_client) return _client;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  _client = new OpenAI({ apiKey });
  return _client;
}

/**
 * 入力テキスト群をすべてカタカナの読みに変換する。
 * 入力配列の順序を保ったまま、同じ長さの配列を返す。失敗した要素は元の文字列。
 */
export async function toKatakanaReadings(texts: string[]): Promise<string[]> {
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
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "あなたは日本語の読み仮名（カタカナ）変換を行う専門アシスタントです。出力は必ず JSON 配列のみ。" },
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 2000,
      response_format: { type: "json_object" },
    });

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
