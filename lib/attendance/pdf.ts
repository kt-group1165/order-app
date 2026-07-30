// 出勤簿 PDF の組み立て (server-only)。
//
// 印刷レイアウト (globals.css の @media print) と同じ構成を pdf-lib で描く。
// 日本語フォントは public/fonts/NotoSansJP-Regular.ttf を実行時に読み込み、
// subset 埋め込みするので PDF 自体は数十 KB に収まる。
//
// A4 縦 (595.28 x 841.89pt)。上下左右 20pt マージン。

import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { formatHM, type DailyCalc, type MonthlySummary } from "./attendance-calc";

const A4 = { w: 595.28, h: 841.89 };
const M = 20; // マージン
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

export type PdfRow = {
  work_date: string;
  dow: number;
  start_time: string;
  end_time: string;
  break_minutes: number;
  paid_leave_type: "full" | "half" | null;
  business_km: string;
  business_trip_km: string;
  substitute_for_date: string;
  substitute_for_date2: string;
  note: string;
  phone_duty: boolean;
  holiday_support_count: number;
  /** その日の手当 (円)。0 は非表示 */
  allowance: number;
  /** 土日祝・会社休日 (行を薄いグレーに) */
  is_rest: boolean;
};

export type PdfInput = {
  officeName: string;
  employeeName: string;
  /** YYYY-MM */
  month: string;
  rows: PdfRow[];
  dailies: DailyCalc[];
  summary: MonthlySummary;
  overtimeTotal: number;
  kmTotal: number;
  tripKmTotal: number;
  workDays: number;
  isHonbu: boolean;
  isOfficeWorker: boolean;
  phoneDutyPay: number;
  allowanceTotal: number;
  phoneDutyDays: number;
  holidaySupportTotal: number;
};

let fontCache: Uint8Array | null = null;

/** public/fonts から日本語フォントを取得 (関数インスタンス内でキャッシュ) */
export async function loadJapaneseFont(origin: string): Promise<Uint8Array> {
  if (fontCache) return fontCache;
  const res = await fetch(new URL("/fonts/NotoSansJP-Regular.ttf", origin));
  if (!res.ok) throw new Error(`フォントの取得に失敗しました (${res.status})`);
  fontCache = new Uint8Array(await res.arrayBuffer());
  return fontCache;
}

type Col = { key: string; label: string; w: number; align: "l" | "c" | "r" };

function buildColumns(input: PdfInput): Col[] {
  const cols: Col[] = [
    { key: "d", label: "日付", w: 26, align: "c" },
    { key: "w", label: "曜日", w: 22, align: "c" },
    { key: "s", label: "出勤", w: 38, align: "r" },
    { key: "e", label: "退勤", w: 38, align: "r" },
    { key: "b", label: "休憩", w: 32, align: "r" },
    { key: "work", label: "実労働", w: 38, align: "r" },
    { key: "ot", label: "時間外", w: 38, align: "r" },
    { key: "mid", label: "深夜", w: 32, align: "r" },
    { key: "hol", label: "法定休日", w: 42, align: "r" },
    { key: "paid", label: "有給", w: 26, align: "c" },
    { key: "km", label: "通勤(km)", w: 42, align: "r" },
  ];
  if (input.isOfficeWorker) cols.push({ key: "trip", label: "出張(km)", w: 42, align: "r" });
  if (input.isHonbu) cols.push({ key: "pay", label: "手当(円)", w: 44, align: "r" });
  const used = cols.reduce((a, c) => a + c.w, 0);
  cols.push({ key: "note", label: "備考", w: A4.w - M * 2 - used, align: "l" });
  return cols;
}

function cellValue(col: Col, r: PdfRow, d: DailyCalc | undefined): string {
  const ot = (d?.daily_overtime ?? 0) + (d?.weekly_overtime ?? 0);
  switch (col.key) {
    case "d":
      return String(parseInt(r.work_date.slice(8), 10));
    case "w":
      return WEEK[r.dow] ?? "";
    case "s":
      return r.start_time;
    case "e":
      return r.end_time;
    case "b":
      return r.break_minutes > 0 ? formatHM(r.break_minutes) : "";
    case "work":
      return (d?.work_minutes ?? 0) > 0 ? formatHM(d!.work_minutes) : "";
    case "ot":
      return ot > 0 ? formatHM(ot) : "";
    case "mid":
      return (d?.midnight_overtime ?? 0) > 0 ? formatHM(d!.midnight_overtime) : "";
    case "hol":
      return (d?.holiday_work ?? 0) > 0 ? formatHM(d!.holiday_work) : "";
    case "paid":
      return r.paid_leave_type === "full" ? "○" : r.paid_leave_type === "half" ? "半" : "";
    case "km":
      return r.business_km;
    case "trip":
      return r.business_trip_km;
    case "pay":
      return r.allowance > 0 ? r.allowance.toLocaleString() : "";
    case "note": {
      const subs = [r.substitute_for_date, r.substitute_for_date2]
        .filter(Boolean)
        .map((s) => s.replace(/-/g, "/"))
        .join("・");
      return [r.note, subs].filter(Boolean).join(" ");
    }
    default:
      return "";
  }
}

function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  align: "l" | "c" | "r" = "l",
  width = 0,
) {
  if (!text) return;
  let tx = x;
  if (align !== "l") {
    const w = font.widthOfTextAtSize(text, size);
    tx = align === "c" ? x + (width - w) / 2 : x + width - w - 3;
  }
  page.drawText(text, { x: tx, y, size, font, color: rgb(0, 0, 0) });
}

/** 小さな集計表 (見出し + 行) を描いて、次に描ける x 座標を返す */
function drawSummaryBox(
  page: PDFPage,
  font: PDFFont,
  x: number,
  top: number,
  title: string,
  rows: [string, string][],
  labelW = 62,
  valueW = 62,
): number {
  const rowH = 13;
  const size = 7.5;
  drawText(page, title, x, top + 3, 8, font);
  let y = top - rowH;
  for (const [label, value] of rows) {
    page.drawRectangle({
      x,
      y,
      width: labelW,
      height: rowH,
      color: rgb(0.96, 0.96, 0.96),
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 0.5,
    });
    page.drawRectangle({
      x: x + labelW,
      y,
      width: valueW,
      height: rowH,
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 0.5,
    });
    drawText(page, label, x + 3, y + 4, size, font);
    drawText(page, value, x + labelW, y + 4, size, font, "r", valueW);
    y -= rowH;
  }
  return x + labelW + valueW + 22;
}

export async function buildAttendancePdf(
  input: PdfInput,
  fontBytes: Uint8Array,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  const page = doc.addPage([A4.w, A4.h]);
  const cols = buildColumns(input);

  // ── 見出し ──
  const title = "出　勤　簿";
  drawText(page, title, 0, A4.h - M - 16, 15, font, "c", A4.w);
  const [y, m] = input.month.split("-");
  drawText(page, input.officeName, M, A4.h - M - 38, 9, font);
  drawText(page, `${y}年${m}月分`, M + 170, A4.h - M - 38, 9, font);
  drawText(page, `氏名：${input.employeeName}`, M + 250, A4.h - M - 38, 9, font);
  // 確認印
  page.drawRectangle({
    x: A4.w - M - 42,
    y: A4.h - M - 52,
    width: 42,
    height: 42,
    borderColor: rgb(0, 0, 0),
    borderWidth: 0.8,
  });
  drawText(page, "確認印", A4.w - M - 42, A4.h - M - 22, 6.5, font, "c", 42);

  // ── 表 ──
  const tableTop = A4.h - M - 62;
  const headH = 15;
  const rowH = 16.2;
  let x = M;
  // ヘッダー
  for (const c of cols) {
    page.drawRectangle({
      x,
      y: tableTop - headH,
      width: c.w,
      height: headH,
      color: rgb(0.93, 0.93, 0.93),
      borderColor: rgb(0.6, 0.6, 0.6),
      borderWidth: 0.5,
    });
    drawText(page, c.label, x, tableTop - headH + 4.5, 6.8, font, "c", c.w);
    x += c.w;
  }
  // 明細
  let ry = tableTop - headH;
  input.rows.forEach((r, i) => {
    ry -= rowH;
    let cx = M;
    for (const c of cols) {
      page.drawRectangle({
        x: cx,
        y: ry,
        width: c.w,
        height: rowH,
        color: r.is_rest ? rgb(0.95, 0.95, 0.95) : undefined,
        borderColor: rgb(0.7, 0.7, 0.7),
        borderWidth: 0.4,
      });
      const v = cellValue(c, r, input.dailies[i]);
      drawText(page, v, cx + 2, ry + 5, 7.2, font, c.align, c.w);
      cx += c.w;
    }
  });
  // 合計行
  ry -= rowH;
  let cx = M;
  for (const c of cols) {
    page.drawRectangle({
      x: cx,
      y: ry,
      width: c.w,
      height: rowH,
      color: rgb(0.9, 0.9, 0.9),
      borderColor: rgb(0.4, 0.4, 0.4),
      borderWidth: 0.6,
    });
    let v = "";
    if (c.key === "d") v = "合計";
    else if (c.key === "work") v = formatHM(input.summary.total_work);
    else if (c.key === "ot") v = formatHM(input.overtimeTotal);
    else if (c.key === "mid") v = formatHM(input.summary.total_midnight);
    else if (c.key === "hol") v = formatHM(input.summary.total_holiday);
    else if (c.key === "paid") v = `${input.summary.total_paid_leave_days}日`;
    else if (c.key === "km") v = input.kmTotal > 0 ? input.kmTotal.toFixed(1) : "";
    else if (c.key === "trip") v = input.tripKmTotal > 0 ? input.tripKmTotal.toFixed(1) : "";
    else if (c.key === "pay") v = input.allowanceTotal > 0 ? input.allowanceTotal.toLocaleString() : "";
    drawText(page, v, cx + 2, ry + 5, 7.2, font, c.key === "d" ? "c" : "r", c.w);
    cx += c.w;
  }

  // ── 集計表 (勤務 → 時間外 → 調整手当) ──
  const sumTop = ry - 22;
  let sx = M;
  sx = drawSummaryBox(page, font, sx, sumTop, "勤務の集計", [
    ["実労働 合計", formatHM(input.summary.total_work)],
    ["出勤日数", `${input.workDays} 日`],
    ["有給", `${input.summary.total_paid_leave_days} 日`],
    ["通勤距離", `${input.kmTotal.toFixed(1)} km`],
    ...(input.isOfficeWorker
      ? ([["出張距離", `${input.tripKmTotal.toFixed(1)} km`]] as [string, string][])
      : []),
  ]);
  sx = drawSummaryBox(page, font, sx, sumTop, "時間外の集計", [
    ["通常残業", formatHM(input.overtimeTotal)],
    ["法定休日", formatHM(input.summary.total_holiday)],
    ["深夜", formatHM(input.summary.total_midnight)],
    ...(input.summary.total_absence > 0
      ? ([["欠勤", formatHM(input.summary.total_absence)]] as [string, string][])
      : []),
  ]);
  if (input.isHonbu) {
    drawSummaryBox(page, font, sx, sumTop, "調整手当", [
      ["電話当番", `${input.phoneDutyDays} 回 × ${input.phoneDutyPay.toLocaleString()}円`],
      ["土日祝対応", `${input.holidaySupportTotal} 件`],
      ["合計", `¥${input.allowanceTotal.toLocaleString()}`],
    ], 62, 78);
  }

  // ── 注記 ──
  const noteY = sumTop - 13 * 6 - 10;
  drawText(
    page,
    "通常残業 = 1日8時間超 + 週40時間超。" +
      (input.isHonbu
        ? " 土日祝対応は 1件 6,000円 / 2件以上 10,000円、電話当番とは併給しない。"
        : ""),
    M,
    Math.max(noteY, M),
    6.5,
    font,
  );

  return await doc.save();
}
