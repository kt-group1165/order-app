/**
 * 国保連伝送ファイル (福祉用具貸与 介護給付費請求書・明細書情報) 生成
 *
 * 国保中央会「インタフェース仕様書 (サービス事業所編)」準拠。
 * kaigo-app の src/lib/kokuho-densou/build.ts (訪問介護) を福祉用具貸与用に移植。
 *
 * ファイル構成 (伝送 = カンマ区切り可変長 CSV / Shift_JIS / CRLF):
 *   1 行目:   コントロールレコード (レコード種別 1)
 *   2 行目〜: データレコード       (レコード種別 2) — 7111 請求書 + 7131 明細書
 *   最終行:   エンドレコード       (レコード種別 3)
 *
 * 7131 (居宅サービス介護給付費明細書 = 様式第二) / 7132 (介護予防サービス給付費明細書 = 様式第二の二)
 * は利用者ごとに 基本情報レコード (01) → 明細情報レコード (02) × n → 集計情報レコード (10)。
 *
 * ★ 2026-11-09: ほのぼの福祉用具の実伝送 (ケアサポ KK261004 = 提供 2026-09・1,116 レセプト) と
 *   突合して形を合わせた (scripts/fukuyogu-densou-honobono-diff.mts)。以前の形は仕様書由来で、
 *   ほのぼのとは次が違っていた:
 *     - 要支援 (要支援1・2) は 7132 / サービス種類 67 (介護予防福祉用具貸与) で出す。
 *       並びは 7131 を全部出してから 7132。それぞれ 保険者番号+被保険者番号 の昇順
 *     - 明細 (02) は **1 用具 1 行** (同じ用具 2 個は 2 行)。項9 単位数 = 0 (仕様 ※6: 福祉用具貸与は
 *       NULL もしくは 0)、項10 日数・回数 = **当月の貸与日数**、項14 サービス単位数 = その用具の単位数、
 *       項18 摘要 = TAIS コード (例 "00170-000527")
 *     - 集計 (10) 項8 サービス実日数 = 明細の貸与日数の最大 (以前は 0 固定)
 *     - 基本 (01) 項21/22/23 開始年月日・中止年月日・中止理由 (月内にサービスを始めた/やめた人)
 *     - 書式: 引用符 (識別番号・被保険者番号・摘要) と 使わない数値項目の 0 埋め
 *       (kaigo-app honobono-format.ts の 7111/7131 規則と同じ。7132 は 7131 と同じ形)
 *
 * 福祉用具貸与の固有ルール:
 *   - サービス種類コード = 17 (要介護) / 67 (要支援)。サービス項目コードは同じ (1001〜1013)
 *   - 単位数単価 = 10.00 円固定 (地域区分の対象外。ほのぼの実伝送も 7131/7132 とも 1000)
 *   - 処遇改善等の加算は無し
 *   - ★ CM 指示単位数で頭打ち (2026-11-09): ケアマネが給付管理で割り付けた単位数が実績より少ないとき、
 *     ほのぼのは 10 項9 計画単位数 = CM の単位数 / 項10 限度額管理対象 = 実績 / 項14 以降と 01 項33-35・
 *     7111 = 頭打ち後 で出す (KK261004 で 6 名。明細 02 は実績のまま)。超過分は保険外 (全額自己負担)。
 *     row.totalUnits = 頭打ち後 / row.limitTargetUnits = 実績 / row.planUnits = CM の単位数 で渡す
 *     (金額は lib/kokuho-densou/fukuyogu-amounts.ts の computeFukuyoguAmounts で頭打ち後に計算済み)。
 *
 *   - ★ 月途中の公費 (生保) と本人支払額 (2026-11-09): 公費が月の一部だけのとき、請求画面で選んだ扱い
 *     (none / daily / half) で fukuyogu-amounts.ts が公費対象を決める。row.kohiUnits / kohiTargetCost /
 *     kohiHonninFutan と 明細ごとの detail.kohiPieces で渡す。出す所: 02 項11・15 / 01 項39-41 / 10 項18-20 /
 *     7111 公費分 項8・9。本人支払額は 01 項41 / 10 項20 に出し 01 項35 / 10 項17 から除く (kaigo-app build.ts と同じ)。
 *     ⚠ 月途中の公費 (02 項11 ≠ 項10) は ほのぼの実伝送 KK261004 に例が無く、IF 仕様と kaigo-app 由来。
 *
 * Shift_JIS への変換は呼出側 (UI) で行う。
 */
import { fukuyoguLinePieces, type KohiPiece } from "./fukuyogu-amounts";
import { rentalDayMask, type DateRange } from "../half-month-units";

// ─── コード値 ────────────────────────────────────────────────────────────────
// 要介護状態区分コード (被保険者証記載の標準コード)
const CARE_LEVEL_CODE: Record<string, string> = {
  事業対象者: "06",
  要支援1: "12",
  要支援2: "13",
  要介護1: "21",
  要介護2: "22",
  要介護3: "23",
  要介護4: "24",
  要介護5: "25",
};

// 種目 (equipment.category) → 福祉用具貸与サービスコード (6 桁 = 種類17 + 項目4桁)
// コード値は公式マスタ kaigo_service_codes (system=介護, 17xxxx) で検証済み (連番 1001-1013)。
// ※ page.tsx の旧 JISSEKI_SERVICE_CODES は 歩行補助つえ以降が誤り (171014-16 はマスタに存在しない)。
export const FUKUYOGU_SERVICE_CODES: Record<string, string> = {
  車いす: "171001",
  車椅子: "171001",
  車いす付属品: "171002",
  車椅子付属品: "171002",
  特殊寝台: "171003",
  特殊寝台付属品: "171004",
  床ずれ防止用具: "171005",
  体位変換器: "171006",
  手すり: "171007",
  スロープ: "171008",
  歩行器: "171009",
  歩行補助つえ: "171010",
  徘徊感知機器: "171011",
  認知症老人徘徊感知機器: "171011",
  移動用リフト: "171012",
  自動排泄処理装置: "171013",
  自動排せつ処理装置: "171013",
};

// 介護予防福祉用具貸与 (サービス種類 67)。項目コードは 17 と同じ 1001〜1013
//   (kaigo_service_codes 671001〜671013 = 予防車いす貸与〜予防自動排泄処理装置貸与 で確認済み。
//    ほのぼの実伝送 KK261004 の 7132-02 も 67+1007/1008/1009/1010 等で出ている)。
export const FUKUYOGU_YOBO_SERVICE_CODES: Record<string, string> = Object.fromEntries(
  Object.entries(FUKUYOGU_SERVICE_CODES).map(([k, v]) => [k, `67${v.slice(2)}`]),
);

/**
 * 要介護状態区分コード (01 項15)。コードにできない (未設定・"非該当"・読めない値) ときは ""。
 *   ★ "" の利用者は伝送から外す (buildFukuyoguDensou 冒頭)。請求画面 (BillingTab) は同じ関数で
 *   「要介護度なし」の印を付けて月遅れ扱いにする。
 */
export function careLevelCodeForDensou(careLevel: string | null | undefined): string {
  // 2026-08-31 監査: CARE_LEVEL_CODE のキーは半角だが、clients.care_level は
  //   ほのぼの由来で**全角のことがある** (実測 306 件: 要介護１〜５ / 要支援１・２)。NFKC で寄せてから引く。
  return CARE_LEVEL_CODE[(careLevel ?? "").normalize("NFKC").replace(/\s/g, "")] ?? "";
}

/** 要支援 (要支援1・2) = 介護予防 (7132 / サービス種類 67) で請求する人か */
export function isYoboCareLevel(careLevel: string | null | undefined): boolean {
  const code = careLevelCodeForDensou(careLevel);
  return code === "12" || code === "13";
}

/**
 * 種目名から福祉用具貸与のサービスコード (6 桁) を引く。未一致は null。
 * careLevel を渡すと 要支援は 67xxxx (介護予防福祉用具貸与) を返す。省略時は 17xxxx。
 * ⚠ 伝送 (buildFukuyoguDensou) は 要介護度から 17/67 を決め直すので、17 のまま渡しても正しく出る。
 */
export function fukuyoguServiceCode(category: string | null | undefined, careLevel?: string | null): string | null {
  if (!category) return null;
  const table = isYoboCareLevel(careLevel) ? FUKUYOGU_YOBO_SERVICE_CODES : FUKUYOGU_SERVICE_CODES;
  return table[category.trim()] ?? null;
}

/** "YYYY-MM-DD" の 2 日付の間の日数 (両端含む) */
const daysBetween = (a: string, b: string) => {
  const t = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((t(b) - t(a)) / 86400000) + 1;
};
const monthBounds = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${ym}-01`, last: `${ym}-${String(last).padStart(2, "0")}`, days: last };
};

/**
 * 当月の貸与日数 (明細 項10 日数・回数)。貸与開始日〜終了日を当月に切り詰めた日数 (両端含む) から、
 * 休止 (order_item_pauses。月の途中で使わなかった日) を除いた日数。
 * ほのぼの実伝送 KK261004 の 7131/7132-02 項10 と同じ (9/9 開始 → 22、9/22 終了 → 22、通月 → 30)。
 * ★ 休止 (2026-11-09 FY-PZ): ほのぼのは項10 を「提供票の実績の印の数」で出す = 休止日を数えない
 *   (例 山口 裕 2026-09: 9/15〜9/27 休止 → 17 / 江藤 久美: 9/11〜9/28 → 12 / 小川 幸江: 9/11〜9/22 → 18)。
 * ⚠ 入院 (client_hospitalizations) は日数から除かない (単位数の半月按分にだけ効く)。入院の月の項10 を
 *   ほのぼのの実出力で確かめた例が無いため従来どおり。休止として登録すれば日数からも除かれる。
 */
export function fukuyoguRentalDaysInMonth(
  rentalStart: string | null,
  rentalEnd: string | null,
  ym: string,
  pauses: readonly DateRange[] = [],
): number {
  const { first, last } = monthBounds(ym);
  const s = rentalStart && rentalStart.slice(0, 10) > first ? rentalStart.slice(0, 10) : first;
  const e = rentalEnd && rentalEnd.slice(0, 10) < last ? rentalEnd.slice(0, 10) : last;
  if (e < s) return 0;
  if (pauses.length === 0) return daysBetween(s, e);
  return rentalDayMask(rentalStart, rentalEnd, ym, pauses).filter(Boolean).length;
}


// 福祉用具貸与の単位数単価 (円)。地域区分の対象外で 10.00 円固定。
// ⚠ **同じ前提がもう 1 か所にある** (2026-09-03 実測):
//     kaigo-app/src/app/(authenticated)/reports/[type]/reports-content.tsx
//       beppyoUnitPrice(): `if (t.includes("福祉用具")) return 10.0;`
//   利用票別表の印字に使う。**片方だけ変えると別表と請求が食い違う。**
//   検査: order-app && npx tsx scripts/fukuyogu-units-check.mts
const FUKUYOGU_UNIT_PRICE = 10;

const HOKEN_KOHI_KUBUN_HOKEN = "1"; // 保険・公費等区分コード: 保険請求分
const SEIKYU_JOHO_KUBUN = "01"; // 請求情報区分コード: 居宅サービス

export interface FukuyoguDetailLine {
  /** サービスコード 6 桁 (17 + 項目コード) */
  serviceCode: string;
  /** 1 回 (1 個) あたり単位数 (月額単位) */
  unitPer: number;
  /** 回数 (= 貸与個数) */
  count: number;
  /** サービス単位数 (unitPer × count) */
  units: number;
  /** 当月の貸与日数 (fukuyoguRentalDaysInMonth)。省略時は当月の日数 (通月) */
  days?: number;
  /** TAIS コード (明細 項18 摘要)。ほのぼのは用具ごとに "00170-000527" 形式で出す */
  taisCode?: string | null;
  /**
   * 月途中の公費 (日割り/半月) のときの 明細 02 項11 公費1対象日数・項15 公費1対象サービス単位数。
   * fukuyoguLinePieces の行ごと (computeFukuyoguAmounts の kohiPieces[i])。
   * 省略時 = 公費が月の全期間 → 項11 = 貸与日数 / 項15 = その行の単位 (従来どおり)
   */
  kohiPieces?: KohiPiece[] | null;
}

export interface FukuyoguSeikyuRow {
  userName: string;
  insurerNumber: string | null;
  insuredNumber: string | null;
  birthDate: string | null; // YYYY-MM-DD
  gender: string | null; // 男/女 表記そのまま
  careLevel: string | null;
  certStart: string | null; // 認定有効期間 開始
  certEnd: string | null; // 認定有効期間 終了
  /** 担当居宅介護支援事業所番号 (10 桁) */
  careOfficeNumber: string | null;
  /** 担当居宅の care_offices.plan_kubun。"3" = 介護予防支援事業所・地域包括作成 (要支援の 7132 だけで使う)。未設定・列未適用は "1" 扱い */
  carePlanKubun?: string | null;
  /** 利用者負担率 (0.1 / 0.2 / 0.3) */
  copayRate: number;
  details: FukuyoguDetailLine[];
  /** 保険請求の対象単位数 (CM 指示単位数で頭打ちしたときは頭打ち後)。01 項33 / 10 項14 / 7111 項8 */
  totalUnits: number;
  /**
   * 実績の単位数 (明細 02 のサービス単位数の合計 = 10 項10 限度額管理対象単位数)。
   * 省略時は totalUnits (頭打ちなし)。totalUnits より大きいとき = CM 指示単位数で頭打ちした
   */
  limitTargetUnits?: number | null;
  /** 10 項9 計画単位数 (CM 指示単位数)。省略時は totalUnits */
  planUnits?: number | null;
  /**
   * その月の CM 指示単位数 (月次情報 = 給付管理) が この人だけ未入力。true なら伝送から外す (月遅れ扱い)。
   * 呼び出し側は「その月・その事業所に 1 件でも入力がある」ときだけ true にする (全員未入力の月は実績で請求)。
   */
  cmMissing?: boolean;
  /** 費用総額 (円。頭打ち後の単位数 × 10。保険外は含まない) */
  totalCost: number;
  /** 保険請求額 (円) */
  insuranceAmount: number;
  /** 利用者負担額 (円)。公費(生保)ありのとき本人負担は公費へ振替済で 0 */
  userAmount: number;
  // ─── 公費 (生活保護 等)。無い場合は未設定 ───
  /** 公費 法別番号 (12=生活保護 等) */
  kohiHobetsu?: string | null;
  /** 公費 負担者番号 (8桁) */
  kohiFutansha?: string | null;
  /** 公費 受給者番号 (7桁) */
  kohiJukyusha?: string | null;
  /** 公費請求額 (円)。生保は本人負担分(1割)を公費へ振替 (本人支払額を除く)。公費単独は費用総額 − 本人支払額 */
  kohiAmount?: number | null;
  /** 公費対象単位数 (01 項39 / 10 項18 / 7111 公費分 単位数)。省略時は totalUnits (公費が月の全期間) */
  kohiUnits?: number | null;
  /** 公費対象費用 (7111 公費分 費用合計)。省略時は totalCost */
  kohiTargetCost?: number | null;
  /**
   * 公費分本人負担額 (生保の本人支払額の適用分。01 項41 / 10 項20)。省略時 0。
   * userAmount はこれを含む合計で、01 項35 / 10 項17 には userAmount − これ を出す (kaigo-app build.ts hokenUserAmountOf と同じ)
   */
  kohiHonninFutan?: number | null;
  /**
   * 公費単独 (被保険者番号 H = 介護保険未加入の生保受給者。保険給付 0・公費 10 割)。
   * 請求書 7111 の保険請求分には含めず、公費請求分 (法別12) にだけ載せる。明細の保険給付率は空欄。
   * kaigo-app src/lib/kokuho-densou/build.ts と同じ扱い (ほのぼの実伝送で裏取り済み)。
   */
  kohiTandoku?: boolean;
  /**
   * 基本 項21 開始年月日。月内にサービスを始めた人だけ。
   * ⚠ 2026-11-09 時点では呼出側 (BillingTab) は渡していない: order_items.rental_start_date が
   *   移行時の仮の日付 (2026-04-01 / 2026-09-01) で、そこから決めるとほのぼのと 152 件食い違うため
   *   (scripts/fukuyogu-densou-honobono-diff.mts の「開始・中止の導出」で測定)。
   */
  serviceStartDate?: string | null;
  /** 基本 項22 中止年月日。月内にサービスをやめた人だけ (同上の理由で 今は渡していない) */
  serviceStopDate?: string | null;
  /** 基本 項23 中止理由コード (1 非該当 / 3 医療機関入院 / 4 死亡 / 5 その他 …)。DB に持っていないので通常 null */
  stopReason?: string | null;
}

// ─── ほのぼの書式 (引用符・0 埋め) ───────────────────────────────────────────
// ほのぼの福祉用具の実伝送 KK261004 (7382 レコード) を項目ごとに数えて決めた。
//   kaigo-app src/lib/kokuho-densou/honobono-format.ts の 7111 / 7131-01・02・10 の規則と同じで、
//   7132 (様式第二の二) は 7131 と同じ形 (実伝送で全項目同じだった)。
//   ⚠ order-app は kaigo-app を import できない (別ビルド) ので表を持つ。
//     乖離は scripts/fukuyogu-densou-check.mts が kaigo-app の formatRecordLikeHonobono と比べて検知する。
// 項番は IF 仕様の項番 (1 始まり)。0 を書くのは **空欄のときだけ** (値があれば触らない)。
const rng = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const FORMAT_RULES: Record<string, { quote: number[]; zero: number[] }> = {
  "7111": { quote: [1], zero: rng(1, 18) },
  "01": { quote: [1, 6], zero: [...rng(1, 5), 13, 14, 15, 17, 18, 19, 29, ...rng(33, 56)] },
  "02": { quote: [1, 6, 18], zero: [...rng(1, 5), ...rng(7, 17)] },
  "10": { quote: [1, 6], zero: [...rng(1, 5), ...rng(7, 11), ...rng(14, 26)] },
};
function formatFukuyoguRecord(parts: string[]): string[] {
  const id = parts[0];
  const rule = id === "7111" ? FORMAT_RULES["7111"] : id === "7131" || id === "7132" ? FORMAT_RULES[parts[1]] : undefined;
  if (!rule) return parts;
  return parts.map((v, i) => {
    const filled = v === "" && rule.zero.includes(i + 1) ? "0" : v;
    return rule.quote.includes(i + 1) ? `"${filled}"` : filled;
  });
}

export interface FukuyoguDensouOptions {
  /** 請求事業所番号 (10 桁) */
  officeNumber: string;
  year: number;
  month: number; // 1-12
}

export interface DensouBuildResult {
  content: string;
  fileName: string;
  dataRecordCount: number;
  warnings: string[];
}

// ★ 2026-11-09: clients.certification_start/end_date に "2026/2/19" 形式 (ほのぼの由来) が混ざっていた
//   (2026-09 の請求対象で 認定開始 61 名・終了 58 名)。"-" を消すだけだと "2026/2/19" のまま出て
//   数字8 の項目に "/" が入る。YYYY-MM-DD / YYYY/M/D のどちらも YYYYMMDD に直す。読めない値は空欄にして警告。
const dateNum = (s: string | null | undefined) => {
  const t = (s ?? "").normalize("NFKC").trim();
  if (!t) return "";
  const m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : "";
};
const genderCode = (g: string | null) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";

export function buildFukuyoguDensou(
  inputRows: FukuyoguSeikyuRow[],
  opts: FukuyoguDensouOptions,
): DensouBuildResult {
  const warnings: string[] = [];
  // ★ 2026-10-15 (B-2t②): 保険者番号・被保険者番号のどちらかが空の行は **伝送に載せない**。
  //   国保連で確実に返戻になるうえ、請求書 (7111) の件数・金額まで水増しされるため。
  //   kaigo-app build.ts:105-127 と同じ扱い (以前は warning だけで 7111 に含めていた)。
  const rows = inputRows.filter((r) => {
    const hasInsurer = !!(r.insurerNumber ?? "").trim();
    const hasInsured = !!(r.insuredNumber ?? "").trim();
    if (hasInsurer && hasInsured) return true;
    const miss = [!hasInsurer && "保険者番号", !hasInsured && "被保険者番号"].filter(Boolean).join("・");
    warnings.push(
      `${r.userName}: ${miss}が未登録のため伝送から除外しました (${r.totalCost.toLocaleString()}円) — 被保険者証を確認して登録してください`,
    );
    return false;
  }).filter((r) => {
    // ★ 2026-11-09 (FY-C2): 要介護度をコードにできない行も伝送に載せない。項15 が 0 (空欄の 0 埋め) の
    //   7131 になり確実に返戻するうえ、7131/7132 の振り分けもできない
    //   (実例: 西野 規子(介) 1000062551 — 当月に有効な認定が無く、ほのぼのは要支援2 の 7132 で出していた)。
    if (careLevelCodeForDensou(r.careLevel)) return true;
    warnings.push(
      `${r.userName}: 要介護度 ("${r.careLevel ?? "未設定"}") をコードにできないため伝送から除外しました (${r.totalCost.toLocaleString()}円) — 当月に有効な認定を登録してください (月遅れ扱い)`,
    );
    return false;
  }).filter((r) => {
    // ★ 2026-11-10 (user 承認): CM 指示単位数が 0 (給付管理で 0 単位) の人はレセプトを出さない。
    //   ほのぼのも月次情報の区分支給限度基準内単位数 0 の人 (廣瀬・秦・横瀬 2026-09) は伝送に載せていない。
    //   保険請求 0 のレセプトは国保連で返戻になる。実績分は全額利用者負担 (保険外)。
    if (r.kohiTandoku || r.planUnits !== 0) return true;
    warnings.push(
      `${r.userName}: CM 指示単位数が 0 のため伝送から除外しました (実績 ${r.limitTargetUnits ?? r.totalUnits} 単位は保険外・全額利用者負担)`,
    );
    return false;
  }).filter((r) => {
    // ★ 2026-11-11 (user 承認): CM 指示単位数 (月次情報 = 給付管理) が その月に無い人は出さない (月遅れ扱い)。
    //   ほのぼのは月次情報に行がある人だけ請求している (2026-09: 請求 1,138 名中 1,136 名が該当・例外は被保番変更の 2 名 /
    //   2026-08: 1,131 名中 1,130 名)。給付管理票が届く前に出すと国保連で突合できず返戻になる。
    if (r.kohiTandoku || !r.cmMissing) return true;
    warnings.push(
      `${r.userName}: CM 指示単位数 (月次情報) が未入力のため伝送から除外しました (${r.totalCost.toLocaleString()}円・月遅れ扱い) — 給付管理の単位数が届いたら入力して翌月以降に請求`,
    );
    return false;
  });
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) {
    warnings.push(
      `事業所番号が 10 桁の数字ではありません ("${office}") — 設定タブで正しい事業所番号を登録してください`,
    );
  }

  const dataParts: string[][] = [];

  // ── 7111 介護給付費請求書情報 (保険請求分 1 レコード) ──
  // 公費単独 (被保険者番号 H = 生保 10割公費) は保険請求分レコードに含めない
  // (様式第一の記載例: 保険請求欄には記載せず、公費請求欄の生保行に合算)。kaigo-app build.ts と同じ。
  const hokenRows = rows.filter((r) => !r.kohiTandoku);
  const totalCount = hokenRows.length;
  const totalUnits = hokenRows.reduce((s, r) => s + r.totalUnits, 0);
  const totalCost = hokenRows.reduce((s, r) => s + r.totalCost, 0);
  const totalInsurance = hokenRows.reduce((s, r) => s + r.insuranceAmount, 0);
  // 項11 公費請求額: 保険請求分レコードにも公費併用分の公費請求額を記載する
  //   (kaigo-app build.ts:153 と同じ。ほのぼの実伝送とバイト一致済みの側に揃える)
  const totalKohi = hokenRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0);
  const totalUser = hokenRows.reduce((s, r) => s + r.userAmount, 0);
  dataParts.push([
    "7111", // 1 交換情報識別番号
    ym, // 2 サービス提供年月
    office, // 3 事業所番号
    HOKEN_KOHI_KUBUN_HOKEN, // 4 保険・公費等区分コード
    "0", // 5 法別番号 (保険請求分は 0)
    SEIKYU_JOHO_KUBUN, // 6 請求情報区分コード
    String(totalCount), // 7 サービス費用 件数
    String(totalUnits), // 8 同 単位数
    String(totalCost), // 9 同 費用合計
    String(totalInsurance), // 10 同 保険請求額
    String(totalKohi), // 11 同 公費請求額
    String(totalUser), // 12 同 利用者負担
    "", // 13 特定入所者介護サービス費等 件数 (福祉用具は対象外)
    "", // 14 同 延べ日数
    "", // 15 同 費用合計
    "", // 16 同 利用者負担
    "", // 17 同 公費請求額
    "", // 18 同 保険請求額
  ]);

  // 公費請求分 (法別番号ごと。生活保護 12 等)。本人負担分を公費が負担。
  // ★ 2026-10-15 (B-2t①): 条件は明細書 (7131 の hasKohi) と必ず一致させる。
  //   公費請求額 0 円でも明細書には公費欄が出るので、`kohiAmount > 0` を条件にすると
  //   **明細の件数 > 請求書の件数** になり返戻。kaigo-app は姉ム KK260704 (法別12) の実伝送で
  //   「0 円の 1 件も件数・単位・費用に含める」を裏取り済み。公費単独は法別未登録でも 12 で合算。
  const kohiTargets = rows.filter((r) => r.kohiHobetsu || r.kohiTandoku);
  const byHobetsu = new Map<string, FukuyoguSeikyuRow[]>();
  for (const r of kohiTargets) {
    const h = r.kohiHobetsu ?? "12";
    if (!byHobetsu.has(h)) byHobetsu.set(h, []);
    byHobetsu.get(h)!.push(r);
  }
  for (const [hobetsu, hRows] of byHobetsu) {
    dataParts.push([
      "7111", // 1 交換情報識別番号
      ym, // 2 サービス提供年月
      office, // 3 事業所番号
      "2", // 4 保険・公費等区分コード (2:公費請求)
      hobetsu, // 5 法別番号 (12=生活保護 等)
      SEIKYU_JOHO_KUBUN, // 6 請求情報区分コード
      String(hRows.length), // 7 件数
      // 8/9 単位数・費用合計 = 公費対象分 (月途中の公費は公費の期間の分だけ。kaigo-app build.ts の kohiEntries と同じ)
      String(hRows.reduce((s, r) => s + (r.kohiUnits ?? r.totalUnits), 0)), // 8 単位数
      String(hRows.reduce((s, r) => s + (r.kohiTargetCost ?? r.totalCost), 0)), // 9 費用合計
      // 2026-08-31 監査: ここに保険請求額を再掲していたため、生保利用者が居る月は
      //   国保連の取込で**保険請求が公費件数分だけ二重計上**されていた。
      //   kaigo-app 側 (src/lib/kokuho-densou/build.ts:233) は明示的に "0" にしており、
      //   ほのぼの実伝送でも公費行の項10 は 0。
      "0", // 10 保険請求額 (公費請求分レコードでは再掲しない)
      String(hRows.reduce((s, r) => s + (r.kohiAmount ?? 0), 0)), // 11 公費請求額
      "0", // 12 利用者負担 (公費振替後は 0)
      "", "", "", "", "", "", // 13-18 特定入所者 (対象外)
    ]);
  }

  // ── 7131 / 7132 明細書 (利用者ごと: 基本 01 → 明細 02×n → 集計 10) ──
  // 並び順は ほのぼの実伝送 (KK261004) と同じ: 7131 (要介護) を全部 → 7132 (要支援)、
  //   それぞれ 保険者番号 (8 桁) + 被保険者番号 の昇順。
  const sortKey = (r: FukuyoguSeikyuRow) =>
    `${isYoboCareLevel(r.careLevel) ? "7132" : "7131"}|${(r.insurerNumber ?? "").trim().padStart(8, "0")}|${(r.insuredNumber ?? "").trim()}`;
  const ordered = rows.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const daysInMonth = new Date(Date.UTC(opts.year, opts.month, 0)).getUTCDate();
  for (const r of ordered) {
    // 要支援 = 介護予防福祉用具貸与 (様式第二の二 = 7132 / サービス種類 67)
    const yobo = isYoboCareLevel(r.careLevel);
    const formId = yobo ? "7132" : "7131";
    const kind = yobo ? "67" : "17";
    // 2026-08-31 監査: padStart が無く 6 桁のまま出していた (仕様は数字8)。
    //   clients.insurer_number は実測で 6 桁が 5,393 件 = 福祉用具伝送は全件が桁不足だった。
    //   kaigo-app build.ts:246 / build-sougou.ts:231 と同じく 8 桁に 0 埋めする。
    const insurerRaw = (r.insurerNumber ?? "").trim();
    const insurer = insurerRaw ? insurerRaw.padStart(8, "0") : "";
    const insured = (r.insuredNumber ?? "").trim();
    // 保険者・被保険者番号が空の行 / 要介護度をコードにできない行は冒頭で除外済み (ここには来ない)
    const careLevelCode = careLevelCodeForDensou(r.careLevel);
    if (!r.birthDate) warnings.push(`${r.userName}: 生年月日が未登録です`);
    if (!r.careOfficeNumber) warnings.push(`${r.userName}: 担当居宅介護支援事業所 (事業所番号) が未登録です`);

    // 公費単独 (H 番号 10割公費): 保険給付率は空欄、公費1給付率 100 (kaigo-app build.ts:292 と同じ)
    const benefitRate = r.kohiTandoku ? "" : String(Math.round((1 - r.copayRate) * 100)); // 90 等
    // ★ 2026-10-15 (B-2t①): 公費欄は「対象月に有効な公費があるか」で出す。**公費請求額 0 でも出す**
    //   (請求書 7111 の公費請求分と同じ条件。kaigo-app build.ts:300 と同じ)
    const hasKohi = !!r.kohiTandoku || !!r.kohiHobetsu;
    if (r.kohiTandoku && !r.kohiFutansha) {
      warnings.push(
        `${r.userName}: 公費単独 (被保険者番号 H) なのに公費情報 (負担者番号) が未登録です — 生活保護 (法別12) を登録してください`,
      );
    } else if (hasKohi && !r.kohiFutansha) {
      warnings.push(`${r.userName}: 公費 (法別${r.kohiHobetsu}) の負担者番号が未登録です`);
    }
    // 公費対象単位数 / 公費分本人負担 (生保の本人支払額)。保険分の利用者負担 (01 項35 / 10 項17) から本人支払額を除く
    const kohiUnits = r.kohiUnits ?? r.totalUnits;
    const kohiHonnin = hasKohi ? Math.max(0, r.kohiHonninFutan ?? 0) : 0;
    const hokenUserAmount = Math.max(0, r.userAmount - kohiHonnin);
    if (hasKohi && kohiUnits > r.totalUnits) {
      warnings.push(`${r.userName}: 公費対象単位数 (${kohiUnits}) が保険の単位数 (${r.totalUnits}) を超えています — 呼出側の計算を確認してください`);
    }

    // 基本情報レコード (01) — 福祉用具。施設系項目は空欄、公費は生保等のとき充填
    dataParts.push([
      formId, // 1 交換情報識別番号 (7131 / 7132)
      "01", // 2 レコード種別コード
      ym, // 3 サービス提供年月
      office, // 4 事業所番号
      insurer, // 5 証記載保険者番号
      insured, // 6 被保険者番号
      hasKohi ? (r.kohiFutansha ?? "") : "", // 7 公費1 負担者番号
      hasKohi ? (r.kohiJukyusha ?? "") : "", // 8 公費1 受給者番号
      "", // 9 公費2 負担者番号
      "", // 10 公費2 受給者番号
      "", // 11 公費3 負担者番号
      "", // 12 公費3 受給者番号
      dateNum(r.birthDate), // 13 生年月日
      genderCode(r.gender), // 14 性別コード
      careLevelCode, // 15 要介護状態区分コード
      "", // 16 旧措置入所者特例コード
      dateNum(r.certStart), // 17 認定有効期間 開始
      dateNum(r.certEnd), // 18 認定有効期間 終了
      // 2026-08-31 監査: "1" 固定だったため、担当居宅が未登録だと
      //   「区分1 (居宅介護支援事業所作成) なのに項20 が空」= IF 必須欠落で返戻。
      //   kaigo-app build.ts:328 と同じく居宅事業所番号の有無で 1/2 を出し分ける。
      //   ⚠ "2" (被保険者が自己作成) は実際にケアマネが居る利用者に付けると
      //     居宅側の給付管理票と突合できず返戻になり得る。上の warning を必ず潰すこと。
      // ★ 2026-11-09: ほのぼの実伝送 KK261004 では 区分 3 は 7132 (要支援) の 5 事業所だけ (care_offices.plan_kubun)
      fukuyoguPlanKubunCode(r.careOfficeNumber, yobo, r.carePlanKubun), // 19 居宅サービス計画作成区分コード
      r.careOfficeNumber ?? "", // 20 事業所番号 (居宅介護支援事業所)
      dateNum(r.serviceStartDate ?? null), // 21 開始年月日 (月内にサービスを始めた人)
      dateNum(r.serviceStopDate ?? null), // 22 中止年月日 (月内にサービスをやめた人)
      r.serviceStopDate ? (r.stopReason ?? "") : "", // 23 中止理由・入所前状況
      "", // 24 入所年月日
      "", // 25 退所年月日
      "", // 26 入所実日数
      "", // 27 外泊日数
      "", // 28 退所後の状態
      benefitRate, // 29 保険給付率
      hasKohi ? "100" : "", // 30 公費1給付率 (生活保護等は 100)
      "", // 31 公費2給付率
      "", // 32 公費3給付率
      String(r.totalUnits), // 33 合計 保険 サービス単位数
      String(r.insuranceAmount), // 34 同 請求額
      String(hokenUserAmount), // 35 同 利用者負担額 (保険分のみ。公費分本人負担は項41)
      "", // 36 緊急時施設療養費請求額
      "", // 37 特定診療費請求額
      "", // 38 特定入所者介護サービス費等請求額
      // 39-44 公費1 合計情報 (サービス単位数 / 請求額 / 本人負担額 / 緊急時 / 特定診療 / 特定入所者)
      hasKohi ? String(kohiUnits) : "", // 39 公費1対象サービス単位数 (月途中は公費の期間の分)
      hasKohi ? String(r.kohiAmount ?? 0) : "", // 40 公費1請求額
      hasKohi ? String(kohiHonnin) : "", // 41 公費1本人負担額 (生保の本人支払額。ほのぼの KK261004 中島 紀久子 1,200)
      "", "", "",
      "", "", "", "", "", "", // 45-50 公費2 合計情報
      "", "", "", "", "", "", // 51-56 公費3 合計情報
    ]);

    // 明細情報レコード (02) — ★ 1 用具 1 行 (ほのぼの実伝送と同じ。同じ用具 2 個は 2 行)
    //   項9 単位数 = 0 (_if_svc.txt ※6「福祉用具貸与は NULL もしくは 0」) / 項10 = 当月の貸与日数 /
    //   項14 = その用具の単位数 / 項18 摘要 = TAIS コード
    // ★ CM 指示単位数で頭打ち: 項10 = 実績 (明細の合計) / 項14 = 頭打ち後 / 項9 = CM の単位数
    const limitTargetUnits = r.limitTargetUnits ?? r.totalUnits;
    const planUnits = r.planUnits ?? r.totalUnits;
    if (limitTargetUnits > r.totalUnits) {
      warnings.push(
        `${r.userName}: CM 指示単位数で頭打ち — 実績 ${limitTargetUnits} 単位のうち ${r.totalUnits} 単位を保険請求 (超過 ${limitTargetUnits - r.totalUnits} 単位は保険外)`,
      );
    } else if (limitTargetUnits < r.totalUnits) {
      warnings.push(`${r.userName}: 保険請求の単位数 (${r.totalUnits}) が実績 (${limitTargetUnits}) より多くなっています — 呼出側の計算を確認してください`);
    }
    const detailSum = r.details.reduce((s, d) => s + d.units, 0);
    if (detailSum !== limitTargetUnits) {
      warnings.push(`${r.userName}: 明細のサービス単位数の合計 (${detailSum}) と 限度額管理対象単位数 (${limitTargetUnits}) が違います`);
    }
    if (planUnits < r.totalUnits) {
      warnings.push(`${r.userName}: 保険請求の単位数 (${r.totalUnits}) が計画単位数 (${planUnits}) を超えています — 国保連で査定されます`);
    }
    let serviceDays = 0;
    let kohiDetailSum = 0;
    for (const d of r.details) {
      // 桁あふれは返戻になる (_if_form2.txt: 10 日数・回数=数字2 / 14 サービス単位数=数字6)。
      // 福祉用具は月額 ÷10 が単位数 (2026-10-19 時点の最大は 58,000 円 = 5,800 単位)。
      if (d.unitPer > 9999) warnings.push(`${r.userName}: ${d.serviceCode} の単位数 ${d.unitPer} が 4 桁を超えています (月額 ${d.unitPer * 10} 円?)。伝送できません`);
      if (d.units > 999999) warnings.push(`${r.userName}: ${d.serviceCode} のサービス単位数 ${d.units} が 6 桁を超えています`);
      if (!/^(17|67)\d{4}$/.test(d.serviceCode)) warnings.push(`${r.userName}: サービスコード ${d.serviceCode} が福祉用具貸与 (17xxxx / 67xxxx) ではありません`);
      const days = d.days ?? daysInMonth;
      if (days > serviceDays) serviceDays = days;
      // 個数 n は n 行に分ける。unitPer × count と units が合わない (手入力の上書き等) ときは 1 行にまとめる
      //   (fukuyoguLinePieces。月途中の公費の kohiPieces も同じ分け方で計算している)
      const lineUnits = fukuyoguLinePieces(d);
      if (d.kohiPieces && d.kohiPieces.length !== lineUnits.length) {
        warnings.push(`${r.userName}: ${d.serviceCode} の公費対象の行数 (${d.kohiPieces.length}) が明細の行数 (${lineUnits.length}) と違います — 公費対象は貸与日数・単位で出しました`);
      }
      const pieces = d.kohiPieces && d.kohiPieces.length === lineUnits.length ? d.kohiPieces : null;
      for (const [pi, u] of lineUnits.entries()) {
        // 月途中の公費 (日割り/半月) は その行の公費対象日数・単位。それ以外は貸与日数・その行の単位 (従来どおり)
        const kp = pieces ? pieces[pi] : { days, units: u };
        if (hasKohi) kohiDetailSum += kp.units;
        dataParts.push([
          formId, // 1
          "02", // 2 レコード種別コード
          ym, // 3
          office, // 4
          insurer, // 5
          insured, // 6
          kind, // 7 サービス種類コード (17 / 67。要介護度で決める)
          d.serviceCode.slice(2, 6), // 8 サービス項目コード
          "0", // 9 単位数 (福祉用具貸与は 0)
          String(days), // 10 日数・回数 (当月の貸与日数)
          hasKohi ? String(kp.days) : "", // 11 公費1対象日数・回数 (月途中は公費の日数 / 半月は公費の半月の貸与日数)
          "", // 12 公費2対象日数・回数
          "", // 13 公費3対象日数・回数
          String(u), // 14 サービス単位数
          hasKohi ? String(kp.units) : "", // 15 公費1対象サービス単位数
          "", // 16 公費2対象サービス単位数
          "", // 17 公費3対象サービス単位数
          (d.taisCode ?? "").trim(), // 18 摘要 (TAIS コード)
        ]);
      }
      if (!(d.taisCode ?? "").trim()) warnings.push(`${r.userName}: ${d.serviceCode} の TAIS コード (摘要) が未登録です`);
    }
    // 国保連の突合: 明細 02 項15 の合計 = 01 項39 / 10 項18 (CM 指示単位数で頭打ちしたときは明細が実績のままなので差が出うる)
    if (hasKohi && kohiDetailSum !== kohiUnits && limitTargetUnits === r.totalUnits) {
      warnings.push(`${r.userName}: 明細の公費対象単位数の合計 (${kohiDetailSum}) と 公費対象単位数 (${kohiUnits}) が違います — 伝送前にレセプトを確認してください`);
    }

    // 集計情報レコード (10) — サービス種類 (17 / 67) 単位
    dataParts.push([
      formId, // 1
      "10", // 2 レコード種別コード
      ym, // 3
      office, // 4
      insurer, // 5
      insured, // 6
      kind, // 7 サービス種類コード
      String(serviceDays), // 8 サービス実日数 (= 明細の貸与日数の最大。ほのぼの実伝送と同じ)
      // 9 計画単位数: ほのぼのは給付管理票の計画単位数を入れ、超過分 (項10 − 項9) は保険外になる。
      //   ★ 2026-11-09: 請求画面の「CM 指示単位数」が入っていればその値 (planUnits)。無ければ実績
      String(planUnits),
      String(limitTargetUnits), // 10 限度額管理対象単位数 (= 実績。明細 02 の合計)
      "0", // 11 限度額管理対象外単位数
      "", // 12 短期入所計画日数
      "", // 13 短期入所実日数
      String(r.totalUnits), // 14 保険 単位数合計
      String(FUKUYOGU_UNIT_PRICE * 100), // 15 単位数単価 (10.00円 → 1000)
      String(r.insuranceAmount), // 16 保険 請求額
      String(hokenUserAmount), // 17 利用者負担額 (保険分のみ。公費分本人負担は項20)
      // 18-20 公費1 (単位数合計 / 請求額 / 本人負担額)
      hasKohi ? String(kohiUnits) : "", // 18 公費1対象単位数
      hasKohi ? String(r.kohiAmount ?? 0) : "", // 19 公費1請求額
      hasKohi ? String(kohiHonnin) : "", // 20 公費分本人負担額
      "", "", "", // 21-23 公費2
      "", "", "", // 24-26 公費3
      "", "", "", // 27-29 保険分出来高医療費
      "", "", "", // 30-32 公費1分出来高医療費
      "", "", "", // 33-35 公費2分出来高医療費
      "", "", "", // 36-38 公費3分出来高医療費
    ]);
  }

  // ── レコード番号を付与してファイルを組む ──
  const lines: string[] = [];
  let recNo = 1;
  // 2026-08-31 監査:
  //   媒体区分を "1"、処理対象年月を提供年月 (ym) で出していたが、ほのぼの実伝送は
  //   全ファイルで **媒体区分 7 (インターネット伝送) / 処理対象年月 = 審査月**。
  //   kaigo-app build.ts:560-568 は是正済みなので同じ形に揃える。
  //   処理対象年月 = 審査月 = 提出バッチの月 + 1。提供月 M の請求は M+1 月 10 日までに
  //   提出し M+1 月に審査される (_if_kyotaku.txt 注1「国保連合会での電算処理を
  //   実行する年月を設定する」)。
  //   ⚠ 提出が遅れる (月遅れ・再請求) 場合は本来 提出月+1 を指定する必要がある。
  //     order-app 側に提出月の指定 UI が無いので、当面は提供月+1 で出す。
  const shinsaYm =
    opts.month === 12
      ? `${opts.year + 1}01`
      : `${opts.year}${String(opts.month + 1).padStart(2, "0")}`;
  // コントロールレコード: 種別1, 連番, ボリューム通番0, データ件数, データ種別711,
  //   福祉事務所0, 保険者番号0, 事業所番号, 都道府県番号0,
  //   媒体区分7(インターネット伝送), 処理対象年月(審査月), 管理番号1
  lines.push(
    ["1", String(recNo++), "0", String(dataParts.length), "711", "0", "0", office, "0", "7", shinsaYm, "1"].join(","),
  );
  for (const parts of dataParts) {
    lines.push(["2", String(recNo++), ...formatFukuyoguRecord(parts)].join(","));
  }
  lines.push(["3", String(recNo++)].join(","));

  return {
    content: lines.join("\r\n") + "\r\n",
    fileName: `F${ym}.CSV`, // 英字始まり 8 桁以内 + .CSV (F = 福祉用具)
    dataRecordCount: dataParts.length,
    warnings,
  };
}

/**
 * 7131/7132 の 項19 居宅サービス計画作成区分コード (伝送と画面で同じ値を出すため 1 か所に)。
 *   居宅事業所番号が無い → "2" (自己作成) / 要支援 かつ 担当居宅が 区分 3 (care_offices.plan_kubun) → "3" / それ以外 → "1"
 */
export function fukuyoguPlanKubunCode(careOfficeNumber: string | null | undefined, yobo: boolean, carePlanKubun: string | null | undefined): "1" | "2" | "3" {
  return careOfficeNumber ? (yobo && carePlanKubun === "3" ? "3" : "1") : "2";
}
/** 作成区分コード → 画面の表示名 */
export const FUKUYOGU_PLAN_KUBUN_LABEL: Record<"1" | "2" | "3", string> = { "1": "居宅介護支援事業者作成", "2": "被保険者自己作成", "3": "介護予防支援事業者作成" };
