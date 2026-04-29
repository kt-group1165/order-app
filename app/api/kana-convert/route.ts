import { NextRequest, NextResponse } from "next/server";
import { toKatakanaReadings } from "@/lib/openaiKana";

export const runtime = "nodejs";
export const maxDuration = 30;

// 漢字混じりテキスト配列を一括でカタカナ読みに変換するAPI
// body: { texts: string[] } → res: { kana: string[] }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const texts = Array.isArray(body?.texts) ? body.texts.map((t: unknown) => String(t ?? "")) : [];
    if (texts.length === 0) {
      return NextResponse.json({ kana: [] });
    }
    if (texts.length > 500) {
      return NextResponse.json({ error: "too many texts (max 500)" }, { status: 400 });
    }
    const kana = await toKatakanaReadings(texts);
    return NextResponse.json({ kana });
  } catch (e) {
    console.error("kana-convert error:", e);
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "conversion failed", detail }, { status: 500 });
  }
}
