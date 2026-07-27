/**
 * 出勤簿 CSV シリアライザ + パーサ
 *
 * 用途:
 *   - 管理者が出勤簿を CSV ダウンロード → 印刷 / 記録 / スタッフ本人が編集
 *   - 編集済 CSV を取込 → rows state に反映 (= 代行入力の代替)
 *
 * フォーマット (payroll-app の居宅出勤簿と同一、Shift-JIS、Excel で開ける):
 *   日付,曜日,出勤,退勤,休憩,出張距離,法定休日,有給,備考
 *   2026-05-01,木,09:00,18:00,01:00,12.5,0,,
 *   2026-05-02,金,09:00,19:30,01:00,8.0,0,○,会議
 *
 *   - 日付: YYYY-MM-DD
 *   - 曜日: 日/月/火/水/木/金/土
 *   - 出勤/退勤: HH:mm (未入力なら空文字)
 *   - 休憩: HH:mm (空文字も 0 扱い)
 *   - 出張距離: 数値 (km、小数 1 桁可)、空文字も可
 *   - 法定休日: 0/1
 *   - 有給: ○=全有給 / 半=半有給 / 空=なし
 *   - 備考: free text (改行/カンマは "..." quote)
 *
 * payroll-app 側と書式互換なので、どちらで出した CSV も相互に取込める。
 *
 * 関連:
 *   - apps/order-app/app/[tenant]/AttendanceTab.tsx (UI 呼び出し元)
 *   - apps/payroll-app/src/lib/csv/kyotaku-attendance-parser.ts (移植元)
 */

import Encoding from "encoding-japanese";
import { decodeCP932, parseCsvLines } from "./csv-decoder";

// =====================================================================
// 型定義
// =====================================================================

/**
 * CSV ↔ UI 共通の 1 日分データ。
 * UI の RowState から calculator 由来の field を除いた subset。
 */
export type AttendanceCsvRow = {
  /** YYYY-MM-DD */
  work_date: string;
  /** "HH:mm" or "" */
  start_time: string;
  /** "HH:mm" or "" */
  end_time: string;
  /** 休憩 分 (0 以上の整数) */
  break_minutes: number;
  is_legal_holiday: boolean;
  /** 有給種別: null=なし / "full"=全有給 / "half"=半有給 */
  paid_leave_type: "full" | "half" | null;
  /** 備考 (空文字可) */
  note: string;
  /** 出張距離 km。空 = "" (= データなし)。文字列保持で UI と整合 */
  business_km: string;
};

export type AttendanceParseResult = {
  success: boolean;
  rows: AttendanceCsvRow[];
  errors: string[];
  /** CSV 内の日付の月 (YYYY-MM)。検証用。混在時は最初の row の月 */
  detectedMonth: string | null;
};

// =====================================================================
// 定数
// =====================================================================

export const ATTENDANCE_CSV_HEADERS = [
  "日付",
  "曜日",
  "出勤",
  "退勤",
  "休憩",
  "出張距離",
  "法定休日",
  "有給",
  "備考",
] as const;

const WEEK_DAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

// =====================================================================
// 補助関数
// =====================================================================

/** 分 → "HH:mm" */
function minutesToHm(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "00:00";
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** "HH:mm" / "H:mm" → 分。空文字や不正は 0 */
function hmToMinutes(s: string): number {
  const trim = (s ?? "").trim();
  if (!trim) return 0;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(trim);
  if (!m) return 0;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return 0;
  return Math.max(0, h * 60 + mm);
}

/** "HH:mm" or "" を正規化 (HH:mm 以外は空文字に丸める) */
function normalizeHm(s: string): string {
  const trim = (s ?? "").trim();
  if (!trim) return "";
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(trim);
  if (!m) return "";
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return "";
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * 日付文字列を YYYY-MM-DD 形式に正規化。受け付ける形式:
 *   - YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD (0 padded)
 *   - YYYY-M-D / YYYY/M/D / YYYY.M.D (no padding)
 *   - YYYY年M月D日 (和暦は別途、令和の対応は将来検討)
 * 不正なら null を返す。
 */
function normalizeDate(raw: string): string | null {
  if (!raw) return null;
  // 全角数字を半角化
  const s = raw.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)).trim();
  // YYYY[-/.]M[-/.]D (区切り: ハイフン / スラッシュ / ピリオド)
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (!m) {
    // YYYY年M月D日 (西暦のみ、和暦は未対応)
    m = /^(\d{4})年(\d{1,2})月(\d{1,2})日?$/.exec(s);
  }
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (!Number.isFinite(y) || y < 1900 || y > 2999) return null;
  if (!Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  if (!Number.isFinite(d) || d < 1 || d > 31) return null;
  // 月末日 validity (例: 2月31日 を弾く)
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** YYYY-MM-DD → 曜日 index (UTC 計算で TZ 揺れ回避) */
function dowOf(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 0;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return 0;
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

/** YYYY-MM-DD → YYYY-MM */
function monthOf(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  if (!m) return null;
  return `${m[1]}-${m[2]}`;
}

/** CSV field を必要に応じて "..." quote (カンマ/改行/ダブルクォート含む場合) */
function quoteField(value: string): string {
  const s = value ?? "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** 0/1 boolean */
function boolToFlag(b: boolean): string {
  return b ? "1" : "0";
}

/** "1" / "true" / "○" / 等 → true、それ以外 false */
function flagToBool(s: string): boolean {
  const t = (s ?? "").trim();
  if (!t) return false;
  if (t === "1" || t === "true" || t === "TRUE" || t === "True") return true;
  if (t === "○" || t === "◯" || t === "有") return true;
  return false;
}

/** km 文字列の正規化。空 → ""、数値 → 小数 1 桁文字列。不正 → "" */
function normalizeKm(s: string): string {
  const t = (s ?? "").trim();
  if (!t) return "";
  const n = parseFloat(t);
  if (!Number.isFinite(n) || n < 0) return "";
  // 0 は明示的に "0" を返す (= 入力済 0 とデータなし "" を区別)
  return String(Math.round(n * 10) / 10);
}

// =====================================================================
// 出力 (serialize + Shift-JIS encode + Blob 化 + download)
// =====================================================================

/**
 * rows を CSV 文字列にシリアライズ (Shift-JIS encode は別関数)。
 * 改行は CRLF (Excel 互換)。
 */
export function serializeAttendanceCsv(
  rows: AttendanceCsvRow[],
): string {
  const header = ATTENDANCE_CSV_HEADERS.join(",");
  const body = rows.map((r) => {
    const breakHm = r.break_minutes > 0 ? minutesToHm(r.break_minutes) : "";
    const dowLabel = WEEK_DAY_LABELS[dowOf(r.work_date)] ?? "";
    return [
      r.work_date,
      dowLabel,
      normalizeHm(r.start_time),
      normalizeHm(r.end_time),
      breakHm,
      normalizeKm(r.business_km),
      boolToFlag(r.is_legal_holiday),
      // 有給: 全=○, 半=半, なし=空
      r.paid_leave_type === "full" ? "○" : r.paid_leave_type === "half" ? "半" : "",
      r.note ?? "",
    ]
      .map(quoteField)
      .join(",");
  });
  return [header, ...body].join("\r\n") + "\r\n";
}

/**
 * CSV 文字列を Shift-JIS バイト列に encode し、Blob 化。
 */
export function buildAttendanceCsvBlob(csv: string): Blob {
  const unicodeArr = Encoding.stringToCode(csv);
  const sjisArr = Encoding.convert(unicodeArr, { to: "SJIS", from: "UNICODE" });
  const bytes = new Uint8Array(sjisArr);
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "text/csv" });
}

/**
 * Blob ダウンロード (anchor の click() trick)。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // microtask 後に revoke (Safari 対応の予備)
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * CSV 出力 1 発呼び出し用 helper。
 * file 名は `attendance_<staff_name>_<YYYY-MM>.csv`。
 */
export function exportAttendanceCsv(args: {
  rows: AttendanceCsvRow[];
  staffName: string;
  month: string; // YYYY-MM
}): void {
  const { rows, staffName, month } = args;
  const csv = serializeAttendanceCsv(rows);
  const blob = buildAttendanceCsvBlob(csv);
  // ファイル名に使えない文字を sanitize
  const safeName = (staffName || "staff").replace(/[\\/:*?"<>|]/g, "_");
  downloadBlob(blob, `attendance_${safeName}_${month}.csv`);
}

// =====================================================================
// 取込 (Shift-JIS decode + CSV パース + 検証)
// =====================================================================

/**
 * Shift-JIS CSV ファイルをパース。
 *
 * @param file 取込対象 file
 * @param expectedMonth 「現在表示中の月」(YYYY-MM)。CSV の日付がこの月の範囲に
 *                     含まれるかを検証 (= 別月の CSV 誤取込を防ぐ)
 */
export async function parseAttendanceCsv(
  file: File,
  expectedMonth: string | null,
): Promise<AttendanceParseResult> {
  const errors: string[] = [];
  try {
    const buffer = await file.arrayBuffer();
    const text = decodeCP932(buffer);
    const grid = parseCsvLines(text);

    // 空行を取り除き、ヘッダ + データ部に分解
    const nonEmpty = grid.filter((r) => r.some((c) => (c ?? "").trim() !== ""));
    if (nonEmpty.length === 0) {
      return {
        success: false,
        rows: [],
        errors: ["CSV が空です"],
        detectedMonth: null,
      };
    }

    const header = nonEmpty[0].map((h) => (h ?? "").trim());
    // ヘッダ列数チェック (9 列 ぴったり想定だが、余分な列は許容して未使用)
    if (header.length < ATTENDANCE_CSV_HEADERS.length) {
      return {
        success: false,
        rows: [],
        errors: [
          `ヘッダ列数が不足しています (期待: ${ATTENDANCE_CSV_HEADERS.length} 列、実際: ${header.length} 列)`,
        ],
        detectedMonth: null,
      };
    }
    // 主要ヘッダ名の検証 (順序固定)
    const headerErrors: string[] = [];
    for (let i = 0; i < ATTENDANCE_CSV_HEADERS.length; i++) {
      if (header[i] !== ATTENDANCE_CSV_HEADERS[i]) {
        headerErrors.push(
          `列 ${i + 1} のヘッダが不正: 期待 "${ATTENDANCE_CSV_HEADERS[i]}" / 実際 "${header[i]}"`,
        );
      }
    }
    if (headerErrors.length > 0) {
      return {
        success: false,
        rows: [],
        errors: headerErrors,
        detectedMonth: null,
      };
    }

    const dataRows = nonEmpty.slice(1);
    const out: AttendanceCsvRow[] = [];
    let detectedMonth: string | null = null;

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      const rowNo = i + 2; // CSV 行番号 (1-origin、header が 1 行目)
      const rawDate = (r[0] ?? "").trim();
      const workDate = normalizeDate(rawDate);
      if (!workDate) {
        errors.push(`行 ${rowNo}: 日付フォーマットが不正 "${rawDate}" (例: 2025-01-01 / 2025/1/1)`);
        continue;
      }
      const ym = monthOf(workDate);
      if (!detectedMonth && ym) detectedMonth = ym;
      if (expectedMonth && ym && ym !== expectedMonth) {
        errors.push(
          `行 ${rowNo}: 日付 ${workDate} が対象月 ${expectedMonth} の範囲外`,
        );
        continue;
      }

      const startTime = normalizeHm((r[2] ?? "").trim());
      const endTime = normalizeHm((r[3] ?? "").trim());
      const breakMinutes = hmToMinutes((r[4] ?? "").trim());
      const businessKm = normalizeKm((r[5] ?? "").trim());
      const isLegalHoliday = flagToBool((r[6] ?? "").trim());
      // 有給: "半"=half / "○"|"true"|"1"|"全"=full / その他=null
      const paidLeaveRaw = (r[7] ?? "").trim();
      const paidLeaveType: "full" | "half" | null = /^半$/.test(paidLeaveRaw)
        ? "half"
        : flagToBool(paidLeaveRaw) || /^全$/.test(paidLeaveRaw)
          ? "full"
          : null;
      const note = (r[8] ?? "").trim();

      out.push({
        work_date: workDate,
        start_time: startTime,
        end_time: endTime,
        break_minutes: breakMinutes,
        is_legal_holiday: isLegalHoliday,
        paid_leave_type: paidLeaveType,
        note,
        business_km: businessKm,
      });
    }

    // 日付の重複 check
    const seen = new Set<string>();
    for (const row of out) {
      if (seen.has(row.work_date)) {
        errors.push(`日付 ${row.work_date} が CSV 内で重複しています`);
      } else {
        seen.add(row.work_date);
      }
    }

    return {
      success: errors.length === 0 && out.length > 0,
      rows: out,
      errors,
      detectedMonth,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      rows: [],
      errors: [`CSV 取込エラー: ${msg}`],
      detectedMonth: null,
    };
  }
}
