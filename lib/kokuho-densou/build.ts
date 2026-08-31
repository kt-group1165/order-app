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
 * 7131 (居宅サービス介護給付費明細書 = 様式第二) は利用者ごとに
 *   基本情報レコード (01) → 明細情報レコード (02) × n → 集計情報レコード (10)。
 *
 * 福祉用具貸与の固有ルール:
 *   - サービス種類コード = 17
 *   - サービス実日数 = 0 (様式第二 仕様 ※6: 福祉用具貸与は 0 / NULL)
 *   - 単位数単価 = 10.00 円固定 (地域区分の対象外)
 *   - 処遇改善等の加算は無し
 *
 * 注意: 空欄項目は空文字のまま出力する (可変長 CSV)。
 * Shift_JIS への変換は呼出側 (UI) で行う。
 */

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

/** 種目名から福祉用具貸与のサービスコード (6 桁) を引く。未一致は null */
export function fukuyoguServiceCode(category: string | null | undefined): string | null {
  if (!category) return null;
  return FUKUYOGU_SERVICE_CODES[category.trim()] ?? null;
}

// 福祉用具貸与の単位数単価 (円)。地域区分の対象外で 10.00 円固定
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
  /** 利用者負担率 (0.1 / 0.2 / 0.3) */
  copayRate: number;
  details: FukuyoguDetailLine[];
  totalUnits: number;
  /** 費用総額 (円) */
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
  /** 公費請求額 (円)。生保は本人負担分(1割)を公費へ振替 */
  kohiAmount?: number | null;
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

const dateNum = (iso: string | null) => (iso ? iso.replaceAll("-", "") : "");
const genderCode = (g: string | null) =>
  g == null ? "" : g.includes("女") ? "2" : g.includes("男") ? "1" : "";

export function buildFukuyoguDensou(
  rows: FukuyoguSeikyuRow[],
  opts: FukuyoguDensouOptions,
): DensouBuildResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const office = (opts.officeNumber ?? "").trim();
  if (!/^\d{10}$/.test(office)) {
    warnings.push(
      `事業所番号が 10 桁の数字ではありません ("${office}") — 設定タブで正しい事業所番号を登録してください`,
    );
  }

  const dataParts: string[][] = [];

  // ── 7111 介護給付費請求書情報 (保険請求分 1 レコード) ──
  const totalCount = rows.length;
  const totalUnits = rows.reduce((s, r) => s + r.totalUnits, 0);
  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0);
  const totalInsurance = rows.reduce((s, r) => s + r.insuranceAmount, 0);
  const totalUser = rows.reduce((s, r) => s + r.userAmount, 0);
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
    "0", // 11 同 公費請求額
    String(totalUser), // 12 同 利用者負担
    "", // 13 特定入所者介護サービス費等 件数 (福祉用具は対象外)
    "", // 14 同 延べ日数
    "", // 15 同 費用合計
    "", // 16 同 利用者負担
    "", // 17 同 公費請求額
    "", // 18 同 保険請求額
  ]);

  // 公費請求分 (法別番号ごと。生活保護 12 等)。本人負担分を公費が負担。
  const kohiTargets = rows.filter((r) => r.kohiHobetsu && (r.kohiAmount ?? 0) > 0);
  const byHobetsu = new Map<string, FukuyoguSeikyuRow[]>();
  for (const r of kohiTargets) {
    const h = r.kohiHobetsu as string;
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
      String(hRows.reduce((s, r) => s + r.totalUnits, 0)), // 8 単位数
      String(hRows.reduce((s, r) => s + r.totalCost, 0)), // 9 費用合計
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

  // ── 7131 明細書 (利用者ごと: 基本 01 → 明細 02×n → 集計 10) ──
  for (const r of rows) {
    // 2026-08-31 監査: padStart が無く 6 桁のまま出していた (仕様は数字8)。
    //   clients.insurer_number は実測で 6 桁が 5,393 件 = 福祉用具伝送は全件が桁不足だった。
    //   kaigo-app build.ts:246 / build-sougou.ts:231 と同じく 8 桁に 0 埋めする。
    const insurerRaw = (r.insurerNumber ?? "").trim();
    const insurer = insurerRaw ? insurerRaw.padStart(8, "0") : "";
    const insured = (r.insuredNumber ?? "").trim();
    if (!insurerRaw) warnings.push(`${r.userName}: 証記載保険者番号が未登録です`);
    if (!insured) warnings.push(`${r.userName}: 被保険者番号が未登録です`);
    // 2026-08-31 監査: CARE_LEVEL_CODE のキーは半角だが、clients.care_level は
    //   ほのぼの由来で**全角のことがある** (実測 306 件: 要介護１〜５ / 要支援１・２)。
    //   そのまま引くと項15 が空欄で出力される。NFKC で寄せてから引く。
    const careLevelKey = (r.careLevel ?? "").normalize("NFKC").replace(/\s/g, "");
    const careLevelCode = CARE_LEVEL_CODE[careLevelKey] ?? "";
    if (!careLevelCode) warnings.push(`${r.userName}: 要介護度 ("${r.careLevel ?? "未設定"}") をコードに変換できません`);
    if (!r.birthDate) warnings.push(`${r.userName}: 生年月日が未登録です`);
    if (!r.careOfficeNumber) warnings.push(`${r.userName}: 担当居宅介護支援事業所 (事業所番号) が未登録です`);

    const benefitRate = String(Math.round((1 - r.copayRate) * 100)); // 90 等
    const hasKohi = !!(r.kohiHobetsu && (r.kohiAmount ?? 0) > 0);
    if (hasKohi && !r.kohiFutansha) {
      warnings.push(`${r.userName}: 公費 (法別${r.kohiHobetsu}) の負担者番号が未登録です`);
    }

    // 基本情報レコード (01) — 福祉用具。施設系項目は空欄、公費は生保等のとき充填
    dataParts.push([
      "7131", // 1 交換情報識別番号
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
      r.careOfficeNumber ? "1" : "2", // 19 居宅サービス計画作成区分コード
      r.careOfficeNumber ?? "", // 20 事業所番号 (居宅介護支援事業所)
      "", // 21 開始年月日
      "", // 22 中止年月日
      "", // 23 中止理由・入所前状況
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
      String(r.userAmount), // 35 同 利用者負担額
      "", // 36 緊急時施設療養費請求額
      "", // 37 特定診療費請求額
      "", // 38 特定入所者介護サービス費等請求額
      // 39-44 公費1 合計情報 (サービス単位数 / 請求額 / 本人負担額 / 緊急時 / 特定診療 / 特定入所者)
      hasKohi ? String(r.totalUnits) : "",
      hasKohi ? String(r.kohiAmount ?? 0) : "",
      hasKohi ? "0" : "",
      "", "", "",
      "", "", "", "", "", "", // 45-50 公費2 合計情報
      "", "", "", "", "", "", // 51-56 公費3 合計情報
    ]);

    // 明細情報レコード (02) — サービスコードごと
    for (const d of r.details) {
      dataParts.push([
        "7131", // 1
        "02", // 2 レコード種別コード
        ym, // 3
        office, // 4
        insurer, // 5
        insured, // 6
        d.serviceCode.slice(0, 2), // 7 サービス種類コード (17)
        d.serviceCode.slice(2, 6), // 8 サービス項目コード
        String(d.unitPer), // 9 単位数
        String(d.count), // 10 日数・回数 (貸与個数)
        hasKohi ? String(d.count) : "", // 11 公費1対象日数・回数
        "", // 12 公費2対象日数・回数
        "", // 13 公費3対象日数・回数
        String(d.units), // 14 サービス単位数
        hasKohi ? String(d.units) : "", // 15 公費1対象サービス単位数
        "", // 16 公費2対象サービス単位数
        "", // 17 公費3対象サービス単位数
        "", // 18 摘要
      ]);
    }

    // 集計情報レコード (10) — サービス種類 (福祉用具貸与 = 17) 単位
    dataParts.push([
      "7131", // 1
      "10", // 2 レコード種別コード
      ym, // 3
      office, // 4
      insurer, // 5
      insured, // 6
      "17", // 7 サービス種類コード
      "0", // 8 サービス実日数 (福祉用具貸与は 0)
      String(r.totalUnits), // 9 計画単位数
      String(r.totalUnits), // 10 限度額管理対象単位数
      "0", // 11 限度額管理対象外単位数
      "", // 12 短期入所計画日数
      "", // 13 短期入所実日数
      String(r.totalUnits), // 14 保険 単位数合計
      String(FUKUYOGU_UNIT_PRICE * 100), // 15 単位数単価 (10.00円 → 1000)
      String(r.insuranceAmount), // 16 保険 請求額
      String(r.userAmount), // 17 利用者負担額
      // 18-20 公費1 (単位数合計 / 請求額 / 本人負担額)
      hasKohi ? String(r.totalUnits) : "",
      hasKohi ? String(r.kohiAmount ?? 0) : "",
      hasKohi ? "0" : "",
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
    lines.push(["2", String(recNo++), ...parts].join(","));
  }
  lines.push(["3", String(recNo++)].join(","));

  return {
    content: lines.join("\r\n") + "\r\n",
    fileName: `F${ym}.CSV`, // 英字始まり 8 桁以内 + .CSV (F = 福祉用具)
    dataRecordCount: dataParts.length,
    warnings,
  };
}
