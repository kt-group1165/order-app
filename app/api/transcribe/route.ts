import { NextRequest, NextResponse } from "next/server";
import { v2 } from "@google-cloud/speech";
import { createClient } from "@supabase/supabase-js";
import { toKatakanaReadings } from "@/lib/openaiKana";

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
    // Google Speech-to-Text v2 adaptation の boost 上限は 20
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
        supabase.from("equipment_master").select("name, furigana, category").eq("tenant_id", tenantId),
      ]);

      // Google PhraseSet は最大1200件のため優先度順で追加しキャップする
      const MAX_PHRASES = 1200;
      // 方針: 利用者・用具ともに読み(フリガナ)のみ登録してSTTの出力を読みに寄せる
      // 漢字は登録しない(STTが誤った漢字を出力する原因になる)
      const clientFuri: { value: string; boost: number }[] = [];
      const equipFuri: { value: string; boost: number }[] = [];
      const equipNames: { value: string; boost: number }[] = [];
      const equipCats = new Map<string, number>();

      if (clientsRes.data) {
        for (const c of clientsRes.data) {
          if (c.furigana) {
            // フリガナはスペースなし版も追加して変換耐性向上
            clientFuri.push({ value: c.furigana, boost: 20 });
            const noSpace = c.furigana.replace(/\s/g, "");
            if (noSpace !== c.furigana) {
              clientFuri.push({ value: noSpace, boost: 20 });
            }
          }
        }
      }
      if (equipmentRes.data) {
        for (const e of equipmentRes.data) {
          // フリガナがあれば最優先で登録（STTを読みに寄せる）
          if (e.furigana) {
            equipFuri.push({ value: e.furigana, boost: 20 });
          } else if (e.name) {
            // フリガナ未登録の場合はフォールバックで用具名そのまま
            equipNames.push({ value: e.name, boost: 18 });
          }
          if (e.category) equipCats.set(e.category, 12);
        }
      }

      // 追加順: 定型語 → 利用者フリガナ → 用具カテゴリ → 用具フリガナ → 用具名
      const catPhrases = Array.from(equipCats, ([value, boost]) => ({ value, boost }));
      const reserved = phrases.length + clientFuri.length + catPhrases.length + equipFuri.length;
      const equipBudget = Math.max(0, MAX_PHRASES - reserved);
      phrases.push(...clientFuri);
      phrases.push(...catPhrases);
      phrases.push(...equipFuri);
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

    // OpenAI で漢字混じりテキストをカタカナの読みに変換（マッチング精度向上のため）
    // text と alternatives の各候補を一括で変換 → 配列の対応位置に格納
    const toConvert = [text, ...alternatives];
    let kanaText = "";
    let kanaAlternatives: string[] = [];
    if (toConvert.some((t) => t.length > 0)) {
      try {
        const converted = await toKatakanaReadings(toConvert);
        kanaText = converted[0] ?? "";
        kanaAlternatives = converted.slice(1);
      } catch (e) {
        console.error("kana conversion failed:", e);
        // フォールバック：元の文字列をそのまま返す
        kanaText = text;
        kanaAlternatives = alternatives;
      }
    }

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

    return NextResponse.json({ text, alternatives, kana: kanaText, kanaAlternatives });
  } catch (e) {
    console.error(e);
    const detail = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: "transcription failed", detail }, { status: 500 });
  }
}
