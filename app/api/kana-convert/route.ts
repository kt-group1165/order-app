import { NextRequest, NextResponse } from "next/server";
import { toKatakanaReadings } from "@/lib/openaiKana";

export const runtime = "nodejs";
export const maxDuration = 30;

// 漢字混じりテキスト配列を一括でカタカナ読みに変換するAPI
// body: { texts: string[], tenantId?: string, purpose?: 'manual_kana' | 'bulk_furigana' }
// res:  { kana: string[] }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const texts = Array.isArray(body?.texts) ? body.texts.map((t: unknown) => String(t ?? "")) : [];
    const tenantId = typeof body?.tenantId === "string" ? body.tenantId : undefined;
    const purpose = typeof body?.purpose === "string" ? body.purpose : (texts.length > 1 ? "bulk_furigana" : "manual_kana");
    if (texts.length === 0) {
      return NextResponse.json({ kana: [] });
    }
    if (texts.length > 500) {
      return NextResponse.json({ error: "too many texts (max 500)" }, { status: 400 });
    }
    const kana = await toKatakanaReadings(texts, { tenantId, purpose });
    return NextResponse.json({ kana });
  } catch (e) {
    console.error("kana-convert error:", e);
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "conversion failed", detail }, { status: 500 });
  }
}
