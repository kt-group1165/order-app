import { NextRequest, NextResponse } from "next/server";
import { v2 } from "@google-cloud/speech";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    // 環境変数からGoogle Cloudサービスアカウント認証情報を取得
    const credentialsJson = process.env.GOOGLE_CREDENTIALS_JSON;
    if (!credentialsJson) {
      return NextResponse.json(
        { error: "transcription failed", detail: "GOOGLE_CREDENTIALS_JSON not set" },
        { status: 500 }
      );
    }
    const credentials = JSON.parse(credentialsJson);
    const projectId = credentials.project_id;

    const client = new v2.SpeechClient({ credentials });

    const formData = await req.formData();
    const audio = formData.get("audio") as File;
    if (!audio) return NextResponse.json({ error: "no audio" }, { status: 400 });

    const audioBuffer = Buffer.from(await audio.arrayBuffer());

    // Google Cloud Speech-to-Text v2 API (自動デコード + chirp_2モデル)
    const [response] = await client.recognize({
      recognizer: `projects/${projectId}/locations/global/recognizers/_`,
      config: {
        autoDecodingConfig: {},
        languageCodes: ["ja-JP"],
        model: "chirp_2",
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
