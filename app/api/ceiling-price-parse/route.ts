import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import type { CeilingImportRow } from "@/lib/ceilingPrices";

// 厚労省「福祉用具の全国平均貸与価格及び貸与価格の上限一覧」Excel をパースする。
// 想定形式:
//   A1: タイトル「… （令和8年7月）」  ← 適用月
//   A2: 「※ 令和8年7月貸与分より …」   ← 適用月 (フォールバック)
//   ヘッダー行 (A列=「商品コード」): 商品コード / 法人名 / 商品名 / 型番 / 全国平均貸与価格 / 貸与価格の上限
//   以降がデータ行
// DB 書込はしない (パースのみ)。呼び出し側でプレビュー→確定 upsert する。

export const runtime = "nodejs";

type WS = ExcelJS.Worksheet;

function cellText(ws: WS, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value;
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    if ("result" in o) return String(o.result ?? "");
    return "";
  }
  return String(v);
}

function cellNum(ws: WS, row: number, col: number): number | null {
  const t = cellText(ws, row, col)
    .replace(/[，、,\s円¥￥]/g, "")
    .replace(/[０-９]/g, (d) => String("０１２３４５６７８９".indexOf(d)));
  if (!t) return null;
  const n = parseInt(t, 10);
  return isNaN(n) ? null : n;
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Excelファイルを選択してください" }, { status: 400 });
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(
      Buffer.from(await file.arrayBuffer()) as unknown as Parameters<typeof wb.xlsx.load>[0]
    );
  } catch {
    return NextResponse.json({ error: "Excelの読み込みに失敗しました (.xlsx を選択してください)" }, { status: 400 });
  }
  const ws = wb.worksheets[0];
  if (!ws) return NextResponse.json({ error: "シートが見つかりません" }, { status: 400 });

  // 適用月: 上部セル (A1〜A6) のテキストから「令和N年M月」を探す
  let effectiveFrom: string | null = null;
  let monthLabel = "";
  for (let r = 1; r <= 6; r++) {
    const t = cellText(ws, r, 1);
    const mm = t.match(/令和\s*(\d+)\s*年\s*(\d+)\s*月/);
    if (mm) {
      const y = 2018 + parseInt(mm[1], 10);
      const mo = parseInt(mm[2], 10);
      effectiveFrom = `${y}-${String(mo).padStart(2, "0")}-01`;
      monthLabel = `令和${mm[1]}年${mm[2]}月`;
      break;
    }
  }

  // ヘッダー行 (A列 = 「商品コード」) を探す
  let headerRow = 0;
  for (let r = 1; r <= 12; r++) {
    if (cellText(ws, r, 1).replace(/\s/g, "") === "商品コード") { headerRow = r; break; }
  }
  if (!headerRow) {
    return NextResponse.json(
      { error: "ヘッダー行（A列=「商品コード」）が見つかりません。想定形式のExcelか確認してください。" },
      { status: 400 }
    );
  }

  const rows: CeilingImportRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const tais = cellText(ws, r, 1).trim();
    if (!tais) continue;
    const ceiling = cellNum(ws, r, 6);
    if (ceiling == null) continue; // 上限価格が無い行はスキップ
    rows.push({
      tais_code: tais,
      corp_name: cellText(ws, r, 2).trim() || null,
      product_name: cellText(ws, r, 3).trim() || null,
      model_number: cellText(ws, r, 4).trim() || null,
      average_price: cellNum(ws, r, 5),
      ceiling_price: ceiling,
    });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "データ行が0件でした。形式を確認してください。" }, { status: 400 });
  }

  const publicationLabel = (ws.name || "").trim() || monthLabel || null;
  return NextResponse.json({
    effectiveFrom,
    monthLabel,
    publicationLabel,
    sheetName: ws.name,
    count: rows.length,
    rows,
  });
}
