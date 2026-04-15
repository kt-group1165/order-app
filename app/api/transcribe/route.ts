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

      // Google PhraseSet は最大1200件のため優先度順で追加しキャップする
      const MAX_PHRASES = 1200;
      // 方針: 利用者は読み(フリガナ)のみ登録してSTTの出力を読みに寄せる
      // 漢字は登録しない(STTが誤った漢字を出力する原因になる)
      const clientFuri: { value: string; boost: number }[] = [];
      const equipNames: { value: string; boost: number }[] = [];
      const equipCats = new Map<string, number>();

      if (clientsRes.data) {
        for (const c of clientsRes.data) {
          if (c.furigana) {
            // フリガナはスペースなし・ひらがな版も追加して変換耐性向上
            clientFuri.push({ value: c.furigana, boost: 30 });
            const noSpace = c.furigana.replace(/\s/g, "");
            if (noSpace !== c.furigana) {
              clientFuri.push({ value: noSpace, boost: 28 });
            }
          }
        }
      }
      if (equipmentRes.data) {
        for (const e of equipmentRes.data) {
          // 用具名は通常カタカナ/型番なのでそのまま登録
          if (e.name) equipNames.push({ value: e.name, boost: 22 });
          if (e.category) equipCats.set(e.category, 12);
        }
      }

      // 追加順: 定型語 → 利用者フリガナ → 用具カテゴリ → 用具名
      const catPhrases = Array.from(equipCats, ([value, boost]) => ({ value, boost }));
      const reserved = phrases.length + clientFuri.length + catPhrases.length;
      const equipBudget = Math.max(0, MAX_PHRASES - reserved);
      phrases.push(...clientFuri);
      phrases.push(...catPhrases);
      phrases.push(...equipNames.slice(0, equipBudget));

      if (phrases.length > MAX_PHRASES) {
        phrases.length = MAX_PHRASES;
      }
    }

    // adaptation (カスタム辞書) は global エンドポイント + long モデルでのみ動作する
    const location = "global";
    const client = new v2.SpeechClient({ credentials });

    const audioBuffer = Buffer.from(await audio.arrayBuffer());

    // long モデル + adaptation で固有名詞の認識精度を向上
    const [response] = await client.recognize({
      recognizer: `projects/${projectId}/locations/${location}/recognizers/_`,
      config: {
        autoDecodingConfig: {},
        languageCodes: ["ja-JP"],
        model: "long",
        features: {
          maxAlternatives: 5, // 複数候補を取得して一致検出精度向上
        },
        adaptation: {
          phraseSets: [
            { inlinePhraseSet: { phrases } },
          ],
        },
      },
      content: audioBuffer,
    });

    // 最初のセグメントの全候補と、全体の結合テキストを取得
    const firstResult = response.results?.[0];
    const alternatives = (firstResult?.alternatives ?? [])
      .map((a) => (a.transcript ?? "").trim())
      .filter((t) => t.length > 0);

    const text =
      response.results
        ?.map((r) => r.alternatives?.[0]?.transcript ?? "")
        .join(" ")
        .trim() ?? "";

    // 使用量を記録（totalBilledDurationから課金対象秒数を取得）
    try {
      const dur = response.metadata?.totalBilledDuration;
      const seconds =
        dur && typeof dur === "object"
          ? Number(dur.seconds ?? 0) + Number(dur.nanos ?? 0) / 1e9
          : 0;
      // long モデル: $0.016/分 ≒ ¥2.4/分（¥150/USD想定）
      const costJpy = (seconds / 60) * 2.4;
      if (tenantId && seconds > 0 && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
        const supabase = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
        );
        await supabase.from("speech_usage").insert({
          tenant_id: tenantId,
          billed_seconds: Number(seconds.toFixed(3)),
          cost_jpy: Number(costJpy.toFixed(4)),
          model: "long",
          text_length: text.length,
        });
      }
    } catch (logErr) {
      console.error("usage log error:", logErr);
    }

    return NextResponse.json({ text, alternatives });
  } catch (e) {
    console.error(e);
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "transcription failed", detail }, { status: 500 });
  }
}
