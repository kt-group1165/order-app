/**
 * ケアプランデータ連携標準仕様 V4.1 (202410) — 第6表 (サービス利用票) 実績情報 CSV ビルダー
 * 福祉用具貸与 (サービス種類 17) 版。
 *
 * kaigo-app の src/lib/careplan-v4/build-jisseki.ts (訪問介護) を福祉用具貸与用に移植。
 * 用途: order-app (福祉用具貸与事業所) → 外部の居宅介護支援事業所へ
 *       ケアプランデータ連携システムで実績を返す UPJSK ファイルの生成。
 *
 * ファイル仕様 (標準仕様 令和6年10月版 / _if_careplan_v4_layout.txt):
 *   - ヘッダー/コントロールレコード無し。データレコード (25 項目) のみ CRLF 区切り
 *   - 制御情報 (対象年月・送信元/先事業所番号・サービス種類コード・作成日時) はファイル名に埋込
 *   - 文字コード Shift_JIS (MS932)。SJIS 変換は呼出側 (UI) で行う
 *
 * 福祉用具貸与の固有ルール:
 *   - No.10 サービス利用日: 福祉用具貸与でも必須 (月内の貸与開始日を設定)
 *   - No.11 日割対象日: 福祉用具貸与は月/半月単位算定のため Null (空)
 *   - No.12/13 開始・終了時刻: 時間表示の無いサービスは 9999
 *   - No.16 TAISコード / No.17 福祉用具届出コード: どちらか一方必須
 *   - No.19 明細判別コード: 同一サービスコード・同一単位数の明細が複数ある場合 1 からの連番
 *   - ファイル送信単位: サービス種類コード + 事業所番号ごと (= 送信先居宅事業所ごとに 1 ファイル)
 */

// CSV バージョン (No.1)。標準仕様 令和6年10月版 = V4.1
export const CAREPLAN_V4_CSV_VERSION = "202410";

// サービス種類コード (ファイル名用 2 桁)
export const SERVICE_KIND_FUKUYOGU = "17"; // 福祉用具貸与 (送信元)
export const SERVICE_KIND_KYOTAKU = "43"; // 居宅介護支援 (送信先)

// 第6表 実績情報のフィールド数 (No.1〜25)
const JISSEKI_FIELD_COUNT = 25;

/** 実績 1 明細 (= 1 用具 × 1 個)。quantity 分は呼出側でなく本ビルダーが行展開する */
export interface FukuyoguJissekiItem {
  /** サービスコード 6 桁 (171001〜171013) */
  serviceCode: string;
  /** 1 個あたり単位数 (割引後・半月/入院補正済み) */
  units: number;
  /** 貸与個数 (2 以上は同一明細を連番展開) */
  quantity: number;
  /** TAIS コード (equipment_master.tais_code)。届出コードと排他で一方必須 */
  taisCode: string | null;
  /** 福祉用具届出コード (TAIS 未取得商品用)。マスタに無い場合 null */
  todokedeCode: string | null;
  /** 用具名称 (機種名) */
  equipmentName: string;
  /** サービス利用日 = 月内の貸与開始日 (YYYY-MM-DD、月跨ぎ継続は月初日) */
  serviceDate: string;
}

/** 実績 CSV の 1 利用者ぶんの入力 */
export interface FukuyoguJissekiUser {
  name: string; // warning 表示用
  insurerNumber: string | null; // 保険者番号 6 桁
  insuredNumber: string | null; // 被保険者番号 10 桁 (生保単独は H+9 桁)
  /** プラン担当者名 (No.7)。ケアマネ名、無ければ居宅事業所名 */
  planStaffName: string | null;
  items: FukuyoguJissekiItem[];
}

export interface FukuyoguJissekiBuildOptions {
  year: number;
  month: number; // 1-12
  /** 送信元 (自事業所) 事業所番号 10 桁 */
  senderOfficeNumber: string;
  /** 送信元事業所名 (No.21) */
  senderOfficeName: string;
  /** 送信先 (居宅介護支援事業所) 事業所番号 10 桁 (No.6 とファイル名) */
  receiverOfficeNumber: string;
  /** ファイル名タイムスタンプ用 (省略時 = 現在時刻) */
  now?: Date;
}

export interface FukuyoguJissekiBuildResult {
  /** CRLF 区切りの CSV 文字列 (Shift_JIS 変換前)。実績 0 件は null */
  content: string | null;
  fileName: string;
  recordCount: number;
  warnings: string[];
}

// ─── ヘルパ ──────────────────────────────────────────────────────────────────

/** カンマ・引用符・改行を含む値を CSV エスケープ */
function csvField(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** YYYY-MM-DD → YYYYMMDD */
function dateNum(iso: string): string {
  return iso.replace(/-/g, "");
}

/** ローカル現在時刻を 14 桁 (YYYYMMDDHHMMSS) に */
function timestamp14(d: Date): string {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1, 2)}${p(d.getDate(), 2)}` +
    `${p(d.getHours(), 2)}${p(d.getMinutes(), 2)}${p(d.getSeconds(), 2)}`
  );
}

/**
 * ファイル名: UPJSK_対象年月_送信元事業所番号_送信元サービス種類(2桁)_
 *             送信先事業所番号_送信先サービス種類(2桁)_YYYYMMDDHHMMSS.CSV
 */
export function buildFukuyoguJissekiFileName(opts: FukuyoguJissekiBuildOptions): string {
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  return [
    "UPJSK",
    ym,
    opts.senderOfficeNumber,
    SERVICE_KIND_FUKUYOGU,
    opts.receiverOfficeNumber,
    SERVICE_KIND_KYOTAKU,
    timestamp14(opts.now ?? new Date()),
  ].join("_") + ".CSV";
}

// ─── 本体 ────────────────────────────────────────────────────────────────────

/**
 * 送信先居宅事業所 1 か所ぶんの利用者実績から UPJSK CSV を組み立てる。
 * 呼出側で利用者を care_office ごとにグルーピングして渡すこと。
 */
export function buildFukuyoguJissekiCsv(
  users: FukuyoguJissekiUser[],
  opts: FukuyoguJissekiBuildOptions,
): FukuyoguJissekiBuildResult {
  const warnings: string[] = [];
  const ym = `${opts.year}${String(opts.month).padStart(2, "0")}`;
  const now = opts.now ?? new Date();
  const createdDate =
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const fileName = buildFukuyoguJissekiFileName({ ...opts, now });

  const lines: string[] = [];

  for (const u of users) {
    const insurer = (u.insurerNumber ?? "").trim();
    const insured = (u.insuredNumber ?? "").trim();
    if (!insurer || !insured) {
      warnings.push(`${u.name}: 保険者番号または被保険者番号が未設定のためスキップしました`);
      continue;
    }

    // quantity を行展開 (同一用具 2 個 → 同一コード・同一単位数の明細 2 行)
    type ExpandedRow = Omit<FukuyoguJissekiItem, "quantity">;
    const expanded: ExpandedRow[] = [];
    for (const it of u.items) {
      if (it.units <= 0) continue; // 全月入院等で単位 0 は実績なし扱い
      for (let i = 0; i < Math.max(1, it.quantity); i++) expanded.push(it);
    }
    if (expanded.length === 0) continue;

    // 明細判別コード: 同一 (サービスコード, 単位数) が複数行のときのみ 1 からの連番
    const groupCount = new Map<string, number>();
    for (const r of expanded) {
      const k = `${r.serviceCode}|${r.units}`;
      groupCount.set(k, (groupCount.get(k) ?? 0) + 1);
    }
    const groupSeq = new Map<string, number>();

    for (const r of expanded) {
      const k = `${r.serviceCode}|${r.units}`;
      let detailCode = "";
      if ((groupCount.get(k) ?? 0) > 1) {
        const seq = (groupSeq.get(k) ?? 0) + 1;
        groupSeq.set(k, seq);
        detailCode = String(seq);
      }

      const tais = (r.taisCode ?? "").trim();
      const todokede = (r.todokedeCode ?? "").trim();
      if (!tais && !todokede) {
        warnings.push(
          `${u.name}: 「${r.equipmentName}」に TAIS コード・福祉用具届出コードのいずれも未設定です (受信側の取込チェックでエラーになる可能性があります)`,
        );
      }

      const fields = [
        CAREPLAN_V4_CSV_VERSION,           //  1 CSVバージョン
        insurer,                           //  2 保険者番号
        insured,                           //  3 被保険者番号
        createdDate,                       //  4 作成年月日
        ym,                                //  5 対象年月
        opts.receiverOfficeNumber,         //  6 プラン担当業者コード (居宅支援事業者番号)
        csvField(u.planStaffName ?? ""),   //  7 プラン担当者名
        String(r.units),                   //  8 単位数
        "",                                //  9 前月までの短期入所利用日数
        dateNum(r.serviceDate),            // 10 サービス利用日
        "",                                // 11 日割対象日 (福祉用具貸与は月/半月単位のため空)
        "9999",                            // 12 サービス開始時刻 (時間表示なし)
        "9999",                            // 13 サービス終了時刻
        "1",                               // 14 サービス回数
        r.serviceCode,                     // 15 サービスコード
        tais,                              // 16 TAISコード
        todokede,                          // 17 福祉用具届出コード
        csvField(r.equipmentName),         // 18 用具名称 (機種名)
        detailCode,                        // 19 明細判別コード
        opts.senderOfficeNumber,           // 20 サービス事業者コード (実績 = サービス事業者)
        csvField(opts.senderOfficeName),   // 21 サービス事業所名
        "",                                // 22 サテライト枝番
        "0",                               // 23 30日超区分 (福祉用具貸与は非該当)
        opts.senderOfficeNumber,           // 24 更新業者コード (実績 = サービス事業者番号)
        "",                                // 25 識別子 (未使用)
      ];
      if (fields.length !== JISSEKI_FIELD_COUNT) {
        throw new Error(`第6表実績レコードの項目数が不正です: ${fields.length} != ${JISSEKI_FIELD_COUNT}`);
      }
      lines.push(fields.join(","));
    }
  }

  if (lines.length === 0) {
    return { content: null, fileName, recordCount: 0, warnings };
  }
  return {
    content: lines.join("\r\n") + "\r\n",
    fileName,
    recordCount: lines.length,
    warnings,
  };
}
