import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";

// 施工会社の見積 Excel を表 (文字列の 2 次元配列) にして返す。住宅改修の見積の取込 (RenovationDocsModal) で使う。
// 施工会社ごとに書式が違うので、ここでは列の意味を決めない (画面で見出し行と列を選ぶ)。
// DB 書込はしない (パースのみ)。

export const runtime = "nodejs";

const MAX_ROWS = 400;
const MAX_COLS = 30;

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join("");
    // 数式は計算結果を使う (単価・金額が数式のことが多い)
    if ("result" in o) return o.result == null ? "" : String(o.result);
    return "";
  }
  return String(v);
}

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Excel ファイルを選択してください" }, { status: 400 });
  }
  if (/\.xls$/i.test(file.name)) {
    return NextResponse.json({ error: "古い形式 (.xls) は読めません。Excel で開いて .xlsx で保存し直してください" }, { status: 400 });
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(Buffer.from(await file.arrayBuffer()) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    return NextResponse.json({ error: "Excel の読み込みに失敗しました (.xlsx を選択してください)" }, { status: 400 });
  }
  const sheets = wb.worksheets
    .filter((ws) => ws.state === "visible")
    .map((ws) => {
      const rows: string[][] = [];
      const last = Math.min(ws.rowCount, MAX_ROWS);
      for (let r = 1; r <= last; r++) {
        const row = ws.getRow(r);
        const cols = Math.min(Math.max(row.cellCount, 0), MAX_COLS);
        const out: string[] = [];
        for (let c = 1; c <= cols; c++) out.push(cellText(row.getCell(c).value).trim());
        rows.push(out);
      }
      return { name: ws.name, rows, truncated: ws.rowCount > MAX_ROWS };
    })
    .filter((s) => s.rows.some((r) => r.some((c) => c !== "")));
  if (sheets.length === 0) return NextResponse.json({ error: "中身のあるシートが見つかりません" }, { status: 400 });
  return NextResponse.json({ sheets });
}
