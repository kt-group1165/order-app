import { NextRequest, NextResponse } from "next/server";
import { v2 } from "@google-cloud/speech";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    // Google Cloud認証情報
    const credentialsJson = process.env.GOOGLE_CREDENTIALS_JSON;
    if (!credentialsJson) {
      return NextResponse.json(
        { error: "transcription failed", detail: "GOOGLE_CREDENTIALS_JSON not set" },
        { status: 500 }
      );
    }
    const credentials = JSON.parse(credentialsJson);
    const projectId = credentials.project_id;

    const formData = await req.formData();
    const audio = formData.get("audio") as File;
    const tenantId = (formData.get("tenantId") as string) ?? "";
    if (!audio) return NextResponse.json({ error: "no audio" }, { status: 400 });

    // 固有名詞をGoogle Speechのカスタム辞書として登録
    const phrases: { value: string; boost: number }[] = [
      // 支払区分・定型語（高いboost）
      { value: "介護保険", boost: 18 },
      { value: "介護", boost: 15 },
      { value: "自費", boost: 18 },
      { value: "特価自費", boost: 18 },
      { value: "以上", boost: 12 },
      { value: "終わり", boost: 10 },
      { value: "なし", boost: 10 },
      { value: "はい", boost: 8 },
    ];

    if (tenantId && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      );
      const [clientsRes, equipmentRes] = await Promise.all([
        supabase.from("clients").select("name, furigana").eq("tenant_id", tenantId),
        supabase.from("equipment").select("name, category").eq("tenant_id", tenantId),
      ]);
      if (clientsRes.data) {
        for (const c of clientsRes.data) {
          if (c.name) phrases.push({ value: c.name, boost: 20 });
          if (c.furigana) phrases.push({ value: c.furigana, boost: 15 });
        }
      }
      if (equipmentRes.data) {
        for (const e of equipmentRes.data) {
          if (e.name) phrases.push({ value: e.name, boost: 18 });
          if (e.category) phrases.push({ value: e.category, boost: 10 });
        }
      }
    }

    // 東京リージョンのSpeech-to-Textクライアント
    const location = "asia-northeast1";
    const client = new v2.SpeechClient({
      credentials,
      apiEndpoint: `${location}-speech.googleapis.com`,
    });

    const audioBuffer = Buffer.from(await audio.arrayBuffer());

    // longモデル + adaptation(カスタム辞書)で固有名詞精度を向上
    const [response] = await client.recognize({
      recognizer: `projects/${projectId}/locations/${location}/recognizers/_`,
      config: {
        autoDecodingConfig: {},
        languageCodes: ["ja-JP"],
        model: "long",
        adaptation: {
          phraseSets: [
            {
              inlinePhraseSet: { phrases },
            },
          ],
        },
      },
      content: audioBuffer,
    });

    const text =
      response.results
        ?.map((r) => r.alternatives?.[0]?.transcript ?? "")
        .join(" ")
        .trim() ?? "";

    return NextResponse.json({ text });
  } catch (e) {
    console.error(e);
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "transcription failed", detail }, { status: 500 });
  }
}
