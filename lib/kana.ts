// 文字列の正規化・カナ変換ユーティリティ（クライアント・サーバー両用）

const HW_KANA: Record<string, string> = {
  ｦ:"ヲ",ｧ:"ァ",ｨ:"ィ",ｩ:"ゥ",ｪ:"ェ",ｫ:"ォ",ｬ:"ャ",ｭ:"ュ",ｮ:"ョ",ｯ:"ッ",
  ｰ:"ー",ｱ:"ア",ｲ:"イ",ｳ:"ウ",ｴ:"エ",ｵ:"オ",ｶ:"カ",ｷ:"キ",ｸ:"ク",ｹ:"ケ",ｺ:"コ",
  ｻ:"サ",ｼ:"シ",ｽ:"ス",ｾ:"セ",ｿ:"ソ",ﾀ:"タ",ﾁ:"チ",ﾂ:"ツ",ﾃ:"テ",ﾄ:"ト",
  ﾅ:"ナ",ﾆ:"ニ",ﾇ:"ヌ",ﾈ:"ネ",ﾉ:"ノ",ﾊ:"ハ",ﾋ:"ヒ",ﾌ:"フ",ﾍ:"ヘ",ﾎ:"ホ",
  ﾏ:"マ",ﾐ:"ミ",ﾑ:"ム",ﾒ:"メ",ﾓ:"モ",ﾔ:"ヤ",ﾕ:"ユ",ﾖ:"ヨ",
  ﾗ:"ラ",ﾘ:"リ",ﾙ:"ル",ﾚ:"レ",ﾛ:"ロ",ﾜ:"ワ",ﾝ:"ン",
};

/**
 * カナマッチング用の正規化：
 * 半角カナ→全角カナ、ひらがな→カタカナ、長音/濁点/中黒/スペース除去
 * これにより「ハンドル付き歩行車」「ハンドルツキ歩行車」「はんどるつきほこうしゃ」が
 * いずれも比較可能な形（「ハンドルツキホコウシャ」相当）に揃う前提で使う。
 * ただし漢字部分は変換できないので、漢字→カナ変換は別途 toKatakanaReading() で行う必要がある。
 */
export function normalizeKana(str: string): string {
  if (!str) return "";
  return str
    .normalize("NFC")
    .replace(/[ｦ-ﾟ]/g, (c) => HW_KANA[c] ?? c)
    .replace(/[ぁ-ゖ]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[！-～]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[ー－―‐\-・]/g, "")
    .toUpperCase()
    .replace(/[\s　]+/g, "");
}

/**
 * 2つの文字列がカナ的に一致するかを判定（包含・先頭一致・連続n文字一致）
 */
export function kanaIncludes(haystack: string, needle: string, minMatchLen = 3): boolean {
  const h = normalizeKana(haystack);
  const n = normalizeKana(needle);
  if (!h || !n) return false;
  if (h.includes(n) || n.includes(h)) return true;
  // 連続minMatchLen文字が含まれていればヒット
  for (let i = 0; i + minMatchLen <= n.length; i++) {
    const sub = n.substring(i, i + minMatchLen);
    if (h.includes(sub)) return true;
  }
  return false;
}
