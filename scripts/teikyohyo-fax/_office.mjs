/**
 * 提供票 FAX 照合の「どの事業所の行を見るか」(2026-11-13)。--area / --office-bn で切り替える (_fukuyogu_office.mjs の 5 事業所から)。
 * ★ 既定 (引数なし) はケアサポで、各 script の判定・出力は引数化の前と同じ (ケアサポの名前の正規表現は各 script の元の値をそのまま使う)。
 * 名前の正規表現は FAX の事業所名 (NFKC 済みでないこともある) に当てる。番号が読めないときの予備なので、別事業所に当たらない形にする。
 */
import { resolveFukuyoguOffice } from "../../migrations/_fukuyogu_office.mjs";

const NAME_RE = {
  ケアサポ: /サポート千|ケア.?サポ/,
  誉田: /(Hana|Ｈａｎａ|ハナ).?ムツミ/i,
  高品: /ムツミ福祉用具.?高品/,
  花見川: /福祉用具.?花見川/,
  茂原: /リンクス.?福祉用具/,
};

/**
 * @param {string[]} [argv]
 * @returns {{ bn: string, officeId: string, area: string, name: string, isDefault: boolean, dir: string, nameRe: RegExp, args: string[] }}
 *   args = 子プロセスに渡す引数 (既定なら空 = 引数化の前と同じ呼び方)
 */
export function faxOffice(argv = process.argv.slice(2)) {
  const fo = resolveFukuyoguOffice(argv);
  const nameRe = NAME_RE[fo.area];
  if (!nameRe) throw new Error(`★ ${fo.area} の事業所名の判定が無い (_office.mjs の NAME_RE に足す)`);
  return { ...fo, nameRe, args: fo.isDefault ? [] : ["--office-bn", fo.bn] };
}
