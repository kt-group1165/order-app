/**
 * 福祉用具の種目 (equipment.category) ごとの札の色 (2026-11-11 user 依頼)。
 * 種目名の表記ゆれ (車椅子 / 徘徊感知機器 / 自動排せつ 等) は NFKC + 同義語で 1 つに寄せる。
 * 知らない種目は灰色 (色が付かないだけで、表示は消さない)。
 */
const COLOR: Record<string, string> = {
  車いす: "bg-sky-50 text-sky-700 border-sky-300",
  車いす付属品: "bg-cyan-50 text-cyan-700 border-cyan-300",
  特殊寝台: "bg-indigo-50 text-indigo-700 border-indigo-300",
  特殊寝台付属品: "bg-violet-50 text-violet-700 border-violet-300",
  床ずれ防止用具: "bg-pink-50 text-pink-700 border-pink-300",
  体位変換器: "bg-fuchsia-50 text-fuchsia-700 border-fuchsia-300",
  手すり: "bg-amber-50 text-amber-800 border-amber-300",
  スロープ: "bg-lime-50 text-lime-800 border-lime-300",
  歩行器: "bg-emerald-50 text-emerald-700 border-emerald-300",
  歩行補助つえ: "bg-teal-50 text-teal-700 border-teal-300",
  認知症老人徘徊感知機器: "bg-rose-50 text-rose-700 border-rose-300",
  移動用リフト: "bg-blue-50 text-blue-700 border-blue-300",
  自動排泄処理装置: "bg-yellow-50 text-yellow-800 border-yellow-300",
};
const ALIAS: Record<string, string> = {
  車椅子: "車いす",
  車椅子付属品: "車いす付属品",
  徘徊感知機器: "認知症老人徘徊感知機器",
  自動排せつ処理装置: "自動排泄処理装置",
};
export function categoryChipClass(category: string | null | undefined): string {
  const c = (category ?? "").normalize("NFKC").trim();
  return COLOR[ALIAS[c] ?? c] ?? "bg-gray-50 text-gray-600 border-gray-300";
}
