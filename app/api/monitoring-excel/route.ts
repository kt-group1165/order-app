import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import path from "path";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    client,       // { name, care_level, care_manager_org, certification_start_date, certification_end_date }
    visit_date,   // "YYYY-MM-DD"
    target_month, // "YYYY-MM"
    report_date,  // "YYYY-MM-DD"
    staff_name,
    company,      // { name, tel, fax }
    items,        // [{ category, equipment_name, quantity, no_issue, has_malfunction, has_deterioration, needs_replacement }]
    continuity_comment,
    report_comment,
    previous_comment,
  } = body;

  const wb = new ExcelJS.Workbook();
  const templatePath = path.join(process.cwd(), "モニタリングシート_20260327-182727.xlsx");
  await wb.xlsx.readFile(templatePath);
  const sheet = wb.getWorksheet(1);
  if (!sheet) return NextResponse.json({ error: "template not found" }, { status: 500 });

  function set(row: number, col: number, value: ExcelJS.CellValue) {
    sheet!.getRow(row).getCell(col).value = value;
  }

  // Helper: parse "YYYY-MM-DD" to Date
  function toDate(s: string | null | undefined): Date | null {
    if (!s) return null;
    const d = new Date(s + "T00:00:00");
    return isNaN(d.getTime()) ? null : d;
  }

  // Helper: Reiwa year (2019 = 1)
  function reiwa(dateStr: string | null | undefined): number | null {
    const d = toDate(dateStr);
    if (!d) return null;
    return d.getFullYear() - 2018;
  }

  // Care manager org
  set(5, 2, client.care_manager_org ?? "");
  set(9, 2, (client.name ?? "") + " 様");
  set(11, 34, company.name ?? "");
  set(14, 34, company.tel ? `TEL：${company.tel}　　FAX：${company.fax ?? ""}` : "");
  set(17, 49, staff_name ?? "");

  // Visit date
  const vd = toDate(visit_date);
  set(24, 13, client.name ?? "");
  if (vd) {
    set(24, 49, vd.getFullYear() - 2018);
    set(24, 53, vd.getMonth() + 1);
    set(24, 57, vd.getDate());
  }

  // Care info
  set(28, 7, client.care_level ?? "");
  if (client.certification_start_date) set(28, 18, toDate(client.certification_start_date));
  if (client.certification_end_date) set(28, 30, toDate(client.certification_end_date));

  // Target month
  if (target_month) {
    const [, tm] = target_month.split("-").map(Number);
    set(28, 50, tm);
  }

  // Equipment items (max 8)
  const MAX_ITEMS = 8;
  const displayItems = items.slice(0, MAX_ITEMS);
  const ITEM_BASE_ROW = 35;
  let lastCategory = "";
  for (let i = 0; i < displayItems.length; i++) {
    const item = displayItems[i];
    const baseRow = ITEM_BASE_ROW + i * 4;
    const ariRow = baseRow + 2;
    // Category (only show if different from previous)
    if (item.category !== lastCategory) {
      set(baseRow, 2, item.category ?? "");
      lastCategory = item.category ?? "";
    } else {
      set(baseRow, 2, "");
    }
    set(baseRow, 17, item.equipment_name ?? "");
    set(baseRow, 34, item.quantity ?? 1);
    // Checks - なし row
    set(baseRow, 36, item.no_issue ? "☑" : "□");
    set(baseRow, 41, !item.has_malfunction ? "☑" : "□");
    set(baseRow, 48, !item.has_deterioration ? "☑" : "□");
    set(baseRow, 55, !item.needs_replacement ? "☑" : "□");
    // あり row
    set(ariRow, 36, !item.no_issue ? "☑" : "□");
    set(ariRow, 41, item.has_malfunction ? "☑" : "□");
    set(ariRow, 48, item.has_deterioration ? "☑" : "□");
    set(ariRow, 55, item.needs_replacement ? "☑" : "□");
  }
  // Clear remaining item rows
  for (let i = displayItems.length; i < MAX_ITEMS; i++) {
    const baseRow = ITEM_BASE_ROW + i * 4;
    const ariRow = baseRow + 2;
    for (const col of [2, 17, 34, 36, 41, 48, 55]) {
      set(baseRow, col, "");
      if ([36, 41, 48, 55].includes(col)) set(ariRow, col, "");
    }
  }

  // Comments
  set(96, 17, continuity_comment ?? "");
  set(105, 2, report_comment ?? "");

  // Report date
  const rd = toDate(report_date);
  if (rd) {
    set(119, 19, rd.getFullYear() - 2018);
    set(119, 53, rd.getMonth() + 1);
    set(119, 57, rd.getDate());
  }

  // Previous comment
  set(126, 2, previous_comment ?? "");

  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent("モニタリング報告書.xlsx")}`,
    },
  });
}
