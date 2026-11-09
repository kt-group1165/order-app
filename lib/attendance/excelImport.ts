// excelImport.ts
// ケアサポ (介護ショップケア・サポート千葉) の出勤簿 Excel (.xls) を読む純関数集。
//
// 元ファイル: Box 事業所共有/03_KT/ケアサポ(共有)/【 業務書類 】/【出勤簿】+小口精算表/♦2024.3月～【出勤簿】.xls
//
// Excel の構造 (2026-11 実ファイルで確認):
//   - シート = 職員ごと (シート名 = 姓)。一覧 / 祝日一覧 / 出勤簿(原本） は対象外
//   - 1 シート = 1 か月分 (毎月上書きする運用)。年 = 行3列0 / 月 = 行3列3 / 氏名 = 行3列13
//   - 日付行 = 行6〜21。左ブロック 列0-7 / 右ブロック 列8-15:
//       日付(Excelシリアル) / 曜日 / 休暇理由 / 出社(日の小数) / 退社 / 勤務時間(h) / 残業時間(h) / 走行距離
//     ※ 列7(+8) の見出しは人により「走行距離」(km) と「交通費」(円) がある。交通費は km に入れない
//   - 行27 列12 = その月の残業時間合計 (Excel の数式の値。#VALUE! のことがある)
//
// 残業の数え方は Excel と アプリで違う (2026-11 user 決定: アプリの計算が正、Excel は参考表示のみ):
//   Excel  18:00 以降の退社分を 30 分単位で切り捨て (19:01→1.0 / 18:59→0.5)
//   アプリ 1日8h超 + 週40h超 + 法定休日・深夜換算 (lib/attendance/attendance-calc.ts)
//
// ここは DB に触らない。保存の形 (payroll_kyotaku_attendance_records) に合わせた
// payload と、既存行との差分までを作る。保存は画面側 (AttendanceExcelImportModal)。
// 検査: npx tsx scripts/attendance-excel-import-check.mts <xlsのパス>

import { minutesBetween } from "./attendance-calc";

// =====================================================================
// 定数
// =====================================================================

/** 職員シートではないシート */
export const EXCLUDED_SHEETS = new Set(["一覧", "祝日一覧", "出勤簿(原本）", "出勤簿(原本)"]);

/** 出勤簿 (AttendanceTab) の稼働開始月。これより前の月は画面で開けないので取込対象にしない */
export const ATTENDANCE_FIRST_MONTH = "2026-06";

/**
 * 休憩の既定値。AttendanceTab の patchRow と同じ規則
 * (拘束 6 時間以上なら 60 分、未満は 0)。
 * Excel の「勤務時間」は 8.0 固定 + 残業 で作られており (拘束 9:26 でも 8.0)、
 * 拘束 − 勤務 から休憩を逆算すると 14〜86 分とばらつくので使わない。
 */
export const DEFAULT_BREAK_THRESHOLD_MIN = 6 * 60;
export const DEFAULT_BREAK_MINUTES = 60;

const DATA_ROW_FIRST = 6;
const DATA_ROW_LAST = 21;
const BLOCK_OFFSETS = [0, 8];
const TOTAL_ROW = 27;
const TOTAL_COL = 12;

// =====================================================================
// 型
// =====================================================================

export type SheetRows = { name: string; rows: unknown[][] };

export type ExcelDay = {
  /** YYYY-MM-DD */
  work_date: string;
  /** 休暇理由 (空なら "") */
  reason: string;
  /** "HH:mm" or null */
  start: string | null;
  end: string | null;
  /** 退社 < 出社 で 12 時間足して午後と解釈した (例: 08:35 → 20:35) */
  endShifted12h: boolean;
  /** Excel の勤務時間 (h) */
  excelWorkHours: number | null;
  /** Excel の残業時間 (h) */
  excelOvertimeHours: number | null;
  /** 列7 の値 (走行距離 km または 交通費 円) */
  col7: number | null;
};

export type ParsedSheet = {
  sheetName: string;
  year: number | null;
  month: number | null;
  /** YYYY-MM。年月が読めなければ null */
  ym: string | null;
  /** Excel の氏名 (原文) */
  fullName: string;
  /** 空白を除いた突合キー */
  nameKey: string;
  /** 列7 の見出し ("走行距離" / "交通費" など) */
  col7Header: string;
  /** 列7 が走行距離 (km) か。false なら km に取り込まない */
  col7IsKm: boolean;
  days: ExcelDay[];
  /** 行27 の残業合計 (h)。#VALUE! 等で読めなければ null */
  excelOvertimeTotal: number | null;
  /** 日ごとの残業 (h) の合計 */
  excelOvertimeDaySum: number;
  warnings: string[];
};

/** payroll_kyotaku_attendance_records に書く列 (tenant_id / office_id / employee_id は保存時に付ける) */
export type ExcelRowPayload = {
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
  is_legal_holiday: boolean;
  is_paid_leave: boolean;
  paid_leave_type: "full" | "half" | null;
  note: string;
  business_km: number | null;
  substitute_for_date: string | null;
  substitute_for_date2: string | null;
};

/** 差分を取るための既存行 (DB row の一部) */
export type ExistingRow = {
  id?: string;
  work_date: string;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number | null;
  is_paid_leave?: boolean | null;
  paid_leave_type: "full" | "half" | null;
  note: string | null;
  business_km: number | null;
  substitute_for_date: string | null;
  substitute_for_date2?: string | null;
};

export type DiffEntry = {
  payload: ExcelRowPayload;
  status: "new" | "changed" | "same";
  /** 変わる列 (changed のときだけ) */
  changes: { field: string; before: string; after: string }[];
};

// =====================================================================
// 補助
// =====================================================================

/** 氏名の突合キー (全角/半角スペースを除く。髙/高 等の字体は揃えない) */
export function normName(s: string | null | undefined): string {
  return (s ?? "").replace(/[\s　]/g, "");
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/** Excel シリアル値 (1900 年方式) → YYYY-MM-DD。TZ に影響されないよう UTC で組む */
export function excelSerialToYmd(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 日の小数 (0.3618 = 08:41) or "8:41" → 分。読めなければ null */
export function excelTimeToMinutes(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const frac = v - Math.floor(v); // 日付付きでも時刻部分だけ
    if (v >= 1 && frac === 0) return null;
    const min = Math.round(frac * 1440);
    return min >= 1440 ? null : min;
  }
  if (typeof v === "string") {
    const m = /^(\d{1,2}):(\d{2})/.exec(v.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }
  return null;
}

export function minutesToHHMM(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// =====================================================================
// シートの解析
// =====================================================================

/**
 * 1 シートを読む。職員シートでなければ null。
 * 「入力のある日」= 休暇理由 か 出社/退社 のどれかがある日だけを days に入れる。
 */
export function parseSheet(sheet: SheetRows): ParsedSheet | null {
  const { name, rows } = sheet;
  if (EXCLUDED_SHEETS.has(name)) return null;
  const at = (r: number, c: number): unknown => rows[r]?.[c] ?? null;
  // 出勤簿様式かどうか: 行5 列0 が「日付」
  if (str(at(5, 0)) !== "日付") return null;

  const warnings: string[] = [];
  const year = num(at(3, 0));
  const month = num(at(3, 3));
  const ym =
    year !== null && month !== null && month >= 1 && month <= 12
      ? `${year}-${String(month).padStart(2, "0")}`
      : null;
  if (!ym) warnings.push("年月が読めません (行3)");
  const fullName = str(at(3, 13));
  if (!fullName) warnings.push("氏名が空です (行3列13)");

  const col7Header = str(at(5, 7)).replace(/\s/g, "");
  const col7IsKm = col7Header.includes("走行距離");
  if (!col7IsKm && col7Header) {
    warnings.push(`列「${col7Header}」は走行距離ではないため通勤km に取り込みません`);
  }

  const days: ExcelDay[] = [];
  for (let r = DATA_ROW_FIRST; r <= DATA_ROW_LAST; r++) {
    for (const off of BLOCK_OFFSETS) {
      const serial = num(at(r, off));
      if (serial === null) continue;
      const date = excelSerialToYmd(serial);
      if (!date) continue;
      const reason = str(at(r, off + 2));
      const sMin = excelTimeToMinutes(at(r, off + 3));
      let eMin = excelTimeToMinutes(at(r, off + 4));
      if (!reason && sMin === null && eMin === null) continue; // 入力なし
      if (ym && !date.startsWith(ym)) {
        warnings.push(`${date} はシートの年月 (${ym}) の外なので読みません`);
        continue;
      }
      let endShifted12h = false;
      if (sMin !== null && eMin !== null && eMin < sMin) {
        if (eMin + 720 > sMin) {
          // 例: 出社 08:52 / 退社 08:35 (Excel の残業 2.5h) → 20:35 の入力漏れ。
          // Excel 側も午後として計算している (18:00 から 2.5h)
          eMin += 720;
          endShifted12h = true;
          warnings.push(
            `${date} 退社 ${minutesToHHMM(eMin - 720)} が出社より前のため ${minutesToHHMM(eMin)} と解釈しました`,
          );
        } else {
          warnings.push(`${date} 退社が出社より前です (日跨ぎとして扱われます)`);
        }
      }
      if ((sMin === null) !== (eMin === null)) {
        warnings.push(`${date} 出社/退社の片方だけ入っています`);
      }
      days.push({
        work_date: date,
        reason,
        start: sMin === null ? null : minutesToHHMM(sMin),
        end: eMin === null ? null : minutesToHHMM(eMin),
        endShifted12h,
        excelWorkHours: num(at(r, off + 5)),
        excelOvertimeHours: sMin === null && eMin === null ? null : num(at(r, off + 6)),
        col7: num(at(r, off + 7)),
      });
    }
  }
  days.sort((a, b) => a.work_date.localeCompare(b.work_date));
  const dup = days.filter((d, i) => i > 0 && days[i - 1].work_date === d.work_date);
  for (const d of dup) warnings.push(`${d.work_date} が 2 回出てきます (後のものを使います)`);

  const excelOvertimeDaySum = days.reduce((s, d) => s + (d.excelOvertimeHours ?? 0), 0);
  return {
    sheetName: name,
    year,
    month,
    ym,
    fullName,
    nameKey: normName(fullName),
    col7Header,
    col7IsKm,
    days: days.filter((d, i) => i === days.length - 1 || days[i + 1].work_date !== d.work_date),
    excelOvertimeTotal: num(at(TOTAL_ROW, TOTAL_COL)),
    excelOvertimeDaySum,
    warnings,
  };
}

export function parseWorkbookSheets(sheets: SheetRows[]): ParsedSheet[] {
  return sheets.map(parseSheet).filter((s): s is ParsedSheet => s !== null);
}

/**
 * xls / xlsx の ArrayBuffer を シートごとの 2 次元配列に。
 * SheetJS は重いので呼ばれたときだけ読み込む (出勤簿タブの初期表示を重くしない)。
 * 数式のエラー (#VALUE! 等) は null になる。
 */
export async function readWorkbookSheets(buf: ArrayBuffer | Uint8Array): Promise<SheetRows[]> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: buf instanceof Uint8Array ? "buffer" : "array" });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = ws
      ? (XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][])
      : [];
    return { name, rows };
  });
}

// =====================================================================
// 保存の形に変換
// =====================================================================

const NOTE_MARK_RE = /\s*(?:\/\s*)?Excel反映 \d{4}-\d{2}-\d{2}\s*$/;

/** 備考から「Excel反映 YYYY-MM-DD」を除いた本文 (差分判定用) */
export function noteCore(note: string | null | undefined): string {
  return (note ?? "").replace(NOTE_MARK_RE, "").trim();
}

/**
 * Excel の 1 日 → 保存行。既存出勤簿 (AttendanceTab.handleSave) と同じ表し方:
 *   有休 → paid_leave_type "full" / 半休 → "half" (時刻はそのまま)
 *   振替・振休 → 備考に「振替」。振替元の出勤日は Excel に無いので substitute_for_date は既存値を保つ
 *     (既存が無ければ null。null でも出退勤なしの日は欠勤にならない = calc の「未入力日」扱い)
 *   欠勤・在宅 ほか → 備考に理由
 *   休憩 → 拘束 6 時間以上なら 60 分 (AttendanceTab の既定と同じ)
 *   is_legal_holiday → 常に false (法定休日は calc が週単位で自動判定。AttendanceTab と同じ)
 */
export function dayToPayload(
  day: ExcelDay,
  opts: { col7IsKm: boolean; importedOn: string; existing?: ExistingRow | null },
): ExcelRowPayload {
  const reason = day.reason;
  const paid: "full" | "half" | null = reason.includes("半休")
    ? "half"
    : reason.includes("有休") || reason.includes("有給")
      ? "full"
      : null;
  const isFurikae = reason.includes("振替") || reason.includes("振休") || reason.includes("代休");
  let breakMin = 0;
  if (day.start && day.end && minutesBetween(day.start, day.end) >= DEFAULT_BREAK_THRESHOLD_MIN) {
    breakMin = DEFAULT_BREAK_MINUTES;
  }
  const kmFromExcel = opts.col7IsKm && day.col7 !== null && day.start ? day.col7 : null;
  // 有休・半休も備考に理由を残す (Excel の原文。在宅・欠勤・振替 などは備考だけが手がかり)
  const notePrefix = reason;
  return {
    work_date: day.work_date,
    start_time: day.start ? `${day.start}:00` : null,
    end_time: day.end ? `${day.end}:00` : null,
    break_minutes: breakMin,
    is_legal_holiday: false,
    is_paid_leave: paid !== null,
    paid_leave_type: paid,
    note: `${notePrefix ? `${notePrefix} / ` : ""}Excel反映 ${opts.importedOn}`,
    // 走行距離の列が無い人 (交通費の列) は既存の値を保つ
    business_km: opts.col7IsKm ? kmFromExcel : (opts.existing?.business_km ?? null),
    substitute_for_date: isFurikae ? (opts.existing?.substitute_for_date ?? null) : null,
    substitute_for_date2: isFurikae ? (opts.existing?.substitute_for_date2 ?? null) : null,
  };
}

function hhmm(t: string | null | undefined): string {
  if (!t) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
}

function leaveLabel(t: "full" | "half" | null | undefined): string {
  return t === "full" ? "有休" : t === "half" ? "半休" : "";
}

/**
 * 既存行との差分。同じ (職員, 日) の行は上書き、内容が同じなら書かない (= 何度押しても同じ)。
 * 備考の「Excel反映 日付」は比較から外す (日付だけ違っても変更なし)。
 */
export function diffPayload(payload: ExcelRowPayload, existing: ExistingRow | null | undefined): DiffEntry {
  if (!existing) return { payload, status: "new", changes: [] };
  const exLeave: "full" | "half" | null =
    existing.paid_leave_type ?? (existing.is_paid_leave ? "full" : null);
  const pairs: [string, string, string][] = [
    ["出社", hhmm(existing.start_time), hhmm(payload.start_time)],
    ["退社", hhmm(existing.end_time), hhmm(payload.end_time)],
    ["休憩", String(existing.break_minutes ?? 0), String(payload.break_minutes)],
    ["有給", leaveLabel(exLeave), leaveLabel(payload.paid_leave_type)],
    ["備考", noteCore(existing.note), noteCore(payload.note)],
    [
      "通勤km",
      existing.business_km === null || existing.business_km === undefined ? "" : String(Number(existing.business_km)),
      payload.business_km === null ? "" : String(payload.business_km),
    ],
    ["振替元", existing.substitute_for_date ?? "", payload.substitute_for_date ?? ""],
    ["振替元2", existing.substitute_for_date2 ?? "", payload.substitute_for_date2 ?? ""],
  ];
  const changes = pairs
    .filter(([, b, a]) => b !== a)
    .map(([field, before, after]) => ({ field, before, after }));
  return { payload, status: changes.length > 0 ? "changed" : "same", changes };
}

// =====================================================================
// 既定の選択
// =====================================================================

/**
 * 取り込むかの既定値。今後は毎月この Excel から当月分を入れる運用 (2026-11 user 決定) なので、
 * シートの年月が「今月」のものだけ既定でチェックする。古い月は既定オフ (選べば入れられる)。
 * 出勤簿の稼働開始月より前・年月不明・入力 0 日は選べない。
 */
export function sheetSelectable(s: ParsedSheet): { ok: boolean; reason: string | null } {
  if (!s.ym) return { ok: false, reason: "年月が読めない" };
  if (s.ym < ATTENDANCE_FIRST_MONTH) return { ok: false, reason: `出勤簿の開始 (${ATTENDANCE_FIRST_MONTH}) より前` };
  if (!s.nameKey) return { ok: false, reason: "氏名が空" };
  if (s.days.length === 0) return { ok: false, reason: "入力が 0 日" };
  return { ok: true, reason: null };
}

export function defaultChecked(s: ParsedSheet, currentYm: string): boolean {
  return sheetSelectable(s).ok && s.ym === currentYm;
}
