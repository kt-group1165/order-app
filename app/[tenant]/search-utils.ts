// 表記ゆれを吸収した部分一致検索のヘルパー。ほぼ全タブ(Orders/Equipment/Clients/
// Billing/Documents 等)から使われる基礎ユーティリティのため独立させている。
import type { Equipment, Client } from "@/lib/supabase";

/** 半角カタカナ→全角カタカナ変換テーブル */
const HW_KANA: Record<string, string> = {
  ｦ:"ヲ",ｧ:"ァ",ｨ:"ィ",ｩ:"ゥ",ｪ:"ェ",ｫ:"ォ",ｬ:"ャ",ｭ:"ュ",ｮ:"ョ",ｯ:"ッ",ｰ:"ー",
  ｱ:"ア",ｲ:"イ",ｳ:"ウ",ｴ:"エ",ｵ:"オ",ｶ:"カ",ｷ:"キ",ｸ:"ク",ｹ:"ケ",ｺ:"コ",
  ｻ:"サ",ｼ:"シ",ｽ:"ス",ｾ:"セ",ｿ:"ソ",ﾀ:"タ",ﾁ:"チ",ﾂ:"ツ",ﾃ:"テ",ﾄ:"ト",
  ﾅ:"ナ",ﾆ:"ニ",ﾇ:"ヌ",ﾈ:"ネ",ﾉ:"ノ",ﾊ:"ハ",ﾋ:"ヒ",ﾌ:"フ",ﾍ:"ヘ",ﾎ:"ホ",
  ﾏ:"マ",ﾐ:"ミ",ﾑ:"ム",ﾒ:"メ",ﾓ:"モ",ﾔ:"ヤ",ﾕ:"ユ",ﾖ:"ヨ",
  ﾗ:"ラ",ﾘ:"リ",ﾙ:"ル",ﾚ:"レ",ﾛ:"ロ",ﾜ:"ワ",ﾝ:"ン",
};

/**
 * 検索用正規化：
 * 半角カナ→全角カナ → ひらがな→カタカナ → 小文字 → スペース除去
 * これにより「やまだ」「ヤマダ」「ﾔﾏﾀﾞ」がすべて「ヤマダ」に統一される
 */
export const normalizeSearch = (str: string) =>
  str
    .normalize("NFC")                                      // 濁点合成（NFD対策）
    .replace(/[ｦ-ﾟ]/g, (c) => HW_KANA[c] ?? c)          // 半角カナ→全角カナ
    .replace(/[ぁ-ゖ]/g, (c) =>                   // ひらがな→カタカナ
      String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[！-～]/g, (c) =>                   // 全角英数字・記号→半角
      String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ")                              // 全角スペース→半角
    .toLowerCase()
    .replace(/[\s　]+/g, "");                              // スペース除去

/** 用具名・フリガナ・コード・TAISコード・カテゴリに対してキーワード検索 */
export const matchEquipment = (e: Equipment, raw: string): boolean => {
  const q = normalizeSearch(raw);
  if (!q) return true;
  return [e.name, e.furigana ?? "", e.product_code, e.tais_code ?? "", e.category ?? ""].some((s) =>
    normalizeSearch(s).includes(q)
  );
};

/** 利用者名・フリガナ・利用者番号に対してキーワード検索 */
export const matchClient = (c: Client, raw: string): boolean => {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const q = normalizeSearch(trimmed);
  const fields = [c.name, c.furigana ?? "", c.user_number ?? ""];
  // ① 正規化マッチ（ひらがな→カタカナ統一後に比較）
  if (fields.some(s => normalizeSearch(s).includes(q))) return true;
  // ② カタカナ→ひらがなに変換してそのまま比較（DB側がひらがな保存の場合）
  const qHira = trimmed.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  if (qHira !== trimmed && fields.some(s => s.includes(qHira))) return true;
  // ③ 直接マッチ（全角カタカナをそのまま比較）
  return fields.some(s => s.toLowerCase().includes(trimmed.toLowerCase()));
};

export { HW_KANA };
