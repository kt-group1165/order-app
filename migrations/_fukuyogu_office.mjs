/**
 * 福祉用具の取込・突合で「どの事業所のデータか」を引数で選ぶ (2026-11-13)。
 *
 *   --office-bn <事業所番号>   既定 = --area の事業所 (どちらも無ければ 1272400050 ケアサポ)
 *   --area <拠点フォルダ名>    既定 = --office-bn の事業所の拠点 (どちらも無ければ ケアサポ)
 *   (子プロセスへ渡すときは env FUKUYOGU_OFFICE_BN / FUKUYOGU_AREA でもよい。argv が優先)
 *
 *   置き場 = apps/kaigo-app/伝送データ/<area>/福祉用具/
 *     <YYYYMM>/ほのぼのから/          KDS0031 (明細書明細付) / KSG0331 / KK
 *     用具貸与期間_YYYYMMDD/          提供票_YYYYMM.csv
 *     利用者マスタ_YYYYMMDD/ 利用者マスタ_全件_YYYYMMDD/   (_user_master_dir.mjs)
 *     月次情報/月次情報_YYYYMM.csv
 *     マスタ/FYGMST01_*.CSV
 *
 * ★ 既定はケアサポ (= 引数化の前に各 script に決め打ちしていた値と同じ)。引数を付けなければ動きは変わらない。
 * ★ 事業所は下の表 (福祉用具 5 事業所) からだけ選べる。表に無い番号は止める (別事業所のデータを取り違えて書かないため)。
 *   office_id は offices.business_number で引いた値 (2026-11-13 に DB で確認)。
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FUKUYOGU_OFFICES = [
  { bn: "1272400050", officeId: "1bfc0d57-9ee0-4ae2-baa5-80edb776290a", area: "ケアサポ", name: "介護ショップケア・サポート千葉" },
  { bn: "1270502097", officeId: "bf2cbf8d-d4ca-4887-beae-a867d71a2b16", area: "誉田", name: "Ｈａｎａムツミ福祉用具" },
  { bn: "1270402124", officeId: "ea7d88ea-5373-4054-8b6d-e8a11fbae217", area: "高品", name: "千葉ムツミ福祉用具高品" },
  { bn: "1270204132", officeId: "e1b7b604-a4fd-44d5-98d1-efcb440ba035", area: "花見川", name: "Ｈａｎａ福祉用具花見川" },
  { bn: "1271502500", officeId: "c3a5a2f7-a8f9-4d7a-81f5-3cf6a9c51f08", area: "茂原", name: "リンクス福祉用具" },
];
export const DEFAULT_FUKUYOGU_BN = "1272400050";

const optOf = (argv, name) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };

/**
 * argv (と env) から事業所を決める。返り値:
 *   { bn, officeId, area, name, isDefault, dir }   dir = 置き場 (絶対パス) / isDefault = 引数も env も無い (= ケアサポ)
 * @param {string[]} [argv]
 * @returns {{ bn: string, officeId: string, area: string, name: string, isDefault: boolean, dir: string }}
 */
export function resolveFukuyoguOffice(argv = process.argv.slice(2)) {
  const bnArg = optOf(argv, "--office-bn") ?? process.env.FUKUYOGU_OFFICE_BN ?? null;
  const areaArg = optOf(argv, "--area") ?? process.env.FUKUYOGU_AREA ?? null;
  const bn = bnArg ? bnArg.replace(/\D/g, "") : null;
  let o;
  if (bn) {
    o = FUKUYOGU_OFFICES.find((x) => x.bn === bn);
    if (!o) throw new Error(`★ --office-bn ${bnArg} は福祉用具の事業所の表に無い (${FUKUYOGU_OFFICES.map((x) => `${x.bn} ${x.area}`).join(" / ")})`);
    if (areaArg && areaArg !== o.area) throw new Error(`★ --office-bn ${bn} (${o.area}) と --area ${areaArg} が食い違う。別事業所のデータを取り違えないよう止める`);
  } else if (areaArg) {
    o = FUKUYOGU_OFFICES.find((x) => x.area === areaArg);
    if (!o) throw new Error(`★ --area ${areaArg} は福祉用具の事業所の表に無い (${FUKUYOGU_OFFICES.map((x) => x.area).join(" / ")})`);
  } else {
    o = FUKUYOGU_OFFICES.find((x) => x.bn === DEFAULT_FUKUYOGU_BN);
  }
  return { ...o, isDefault: !bn && !areaArg, dir: fukuyoguDir(o.area) };
}

/** 置き場 (絶対パス): apps/kaigo-app/伝送データ/<area>/福祉用具 */
export function fukuyoguDir(area) {
  return join(HERE, "../../kaigo-app/伝送データ", area, "福祉用具");
}

/**
 * base の中の 用具貸与期間_YYYYMMDD のうち日付が最新のフォルダ (絶対パス)。無ければ null。
 * (引数化の前は 用具貸与期間_20261109 に固定していた。ケアサポには今それしか無いので同じものを選ぶ)
 */
export function latestTeikyoDir(base) {
  if (!existsSync(base)) return null;
  const hits = readdirSync(base).filter((d) => /^用具貸与期間_\d{8}$/.test(d)).sort();
  return hits.length ? join(base, hits[hits.length - 1]) : null;
}

/** 置き場の 利用者マスタ_YYYYMMDD (登録有) のうち最新の日付 (YYYYMMDD)。無ければ null */
export function latestUserMasterDate(area) {
  const base = fukuyoguDir(area);
  if (!existsSync(base)) return null;
  const ds = readdirSync(base).map((d) => /^利用者マスタ_(\d{8})$/.exec(d)?.[1]).filter(Boolean).sort();
  return ds.length ? ds[ds.length - 1] : null;
}

/** ログ用の 1 行 */
export function describeFukuyoguOffice(o) {
  return `事業所: ${o.area} ${o.bn} ${o.name}${o.isDefault ? " (既定。--area / --office-bn で切替)" : ""}`;
}

/**
 * 提供票・月次情報の「事業所名」から 介護 / 予防 / 自費 を決める (2026-11-13)。
 *   ケアサポ: 「ケア・サポート千葉」/「予ケア・サポート千葉」/「自費レンタル」
 *   誉田    : 「Hanaムツミ福祉用具」/「(予)Hanaムツミ福祉用」/「Hana自費レンタル」
 *   → 自費 = 名前が「自費レンタル」で終わる / 予防 = 「予」または「(予)」で始まる (全角括弧も) / それ以外 = 介護。
 *   ケアサポの 3 つの名前では 引数化の前の判定 (=== "自費レンタル" / startsWith("予")) と同じ結果になる。
 * @param {string} officeName
 * @returns {"自費" | "予防" | "介護"}
 */
export function teikyoKindOfOffice(officeName) {
  const n = String(officeName ?? "").normalize("NFKC").trim();
  if (n.endsWith("自費レンタル")) return "自費";
  if (/^(予|\(予\))/.test(n)) return "予防";
  return "介護";
}
