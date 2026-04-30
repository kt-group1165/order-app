"use client";

import { useState, useEffect, use, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight, Search, Check, X, Plus, Minus, ShoppingCart, Mic, MicOff, Volume2 } from "lucide-react";
import { Client, Equipment, Supplier } from "@/lib/supabase";
import { getClients } from "@/lib/clients";
import { getEquipment, getSuppliers } from "@/lib/equipment";
import { createOrder, createOrderItem } from "@/lib/orders";

type PaymentKind = "介護" | "自費" | "特価自費";

type CartItem = {
  equipment: Equipment;
  rental_price: string;
  supplier_id: string | null;
  quantity: number;
  notes: string;
};

type Step = "client" | "payment" | "equipment" | "detail" | "confirm" | "done";

const STEPS: Step[] = ["client", "payment", "equipment", "detail", "confirm", "done"];
const STEP_LABELS: Record<Step, string> = {
  client: "利用者",
  payment: "支払区分",
  equipment: "用具選択",
  detail: "詳細設定",
  confirm: "確認",
  done: "完了",
};

// ── 音声ユーティリティ ──────────────────────────────────────────
function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.rate = 0.95;
    u.onend = () => {
      // iOSはオーディオセッションの解放に時間が必要
      setTimeout(resolve, isIOS() ? 800 : 300);
    };
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

const isIOS = () => typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;


// 文字列の正規化（ひらがな/カタカナ統一、空白除去）
function normalize(s: string): string {
  if (!s) return "";
  return s
    .replace(/\s/g, "")
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)); // カタカナ→ひらがな
}

// カナマッチング用：ひらがな/カタカナ/長音/中黒/スペースを統一
function kana(s: string): string {
  if (!s) return "";
  return s
    .normalize("NFC")
    .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)) // ひらがな→カタカナ
    .replace(/[ー－―‐\-・]/g, "")
    .replace(/[\s　]+/g, "");
}

// 名前マッチング（姓のみ/名のみ/フリガナ/あいまい一致）
// kanaText: STT結果をカタカナに変換したもの。漢字一致が困難な場合の主軸
function matchClients(text: string, clients: Client[], kanaText?: string): Client[] {
  const t = normalize(text);
  const tk = kana(kanaText ?? text);
  if (!t && !tk) return [];
  const matched = clients.filter((c) => {
    const name = normalize(c.name);
    const furi = normalize(c.furigana ?? "");
    const furiK = kana(c.furigana ?? "");
    const nameK = kana(c.name); // 漢字混じりだがSTTが漢字を返した場合に備える

    // ① カナ同士で比較（漢字→カナ変換した STT 結果と DB のフリガナ）
    if (tk && furiK) {
      if (furiK.includes(tk) || tk.includes(furiK)) return true;
      // 姓だけのカナマッチ（先頭2文字以上）
      const furiParts = (c.furigana ?? "").split(/\s+/).map(kana).filter(Boolean);
      for (const p of furiParts) {
        if (p.length >= 2 && (tk.includes(p) || p.includes(tk))) return true;
      }
      if (furiK.length >= 2 && tk.length >= 2 && furiK.substring(0, 2) === tk.substring(0, 2)) return true;
    }
    // ②（フォールバック）漢字同士の包含・先頭一致
    if (t && name) {
      if (name.includes(t) || t.includes(name)) return true;
      if (name.length >= 2 && t.length >= 2 && name.substring(0, 2) === t.substring(0, 2)) return true;
    }
    if (t && furi) {
      if (furi.includes(t) || t.includes(furi)) return true;
    }
    // ③ STTが漢字を返した時に DB の漢字名でも一致確認
    if (tk && nameK) {
      if (nameK.includes(tk) || tk.includes(nameK)) return true;
    }
    return false;
  });
  return matched;
}

function matchEquipment(text: string, equipment: Equipment[], kanaText?: string): Equipment[] {
  const t = normalize(text);
  const tk = kana(kanaText ?? text);
  if (!t && !tk) return [];
  return equipment.filter((eq) => {
    const name = normalize(eq.name);
    const cat = normalize(eq.category ?? "");
    const furiK = kana(eq.furigana ?? "");
    const nameK = kana(eq.name);
    const catK = kana(eq.category ?? "");

    // ① カナ比較（DB のフリガナ優先 → 用具名のカナ化）
    if (tk) {
      if (furiK) {
        if (furiK.includes(tk) || tk.includes(furiK)) return true;
        // 連続3文字一致
        for (let i = 0; i + 3 <= tk.length; i++) {
          if (furiK.includes(tk.substring(i, i + 3))) return true;
        }
      }
      if (nameK) {
        if (nameK.includes(tk) || tk.includes(nameK)) return true;
        for (let i = 0; i + 3 <= tk.length; i++) {
          if (nameK.includes(tk.substring(i, i + 3))) return true;
        }
      }
      if (catK && (catK.includes(tk) || tk.includes(catK))) return true;
    }
    // ② 漢字同士のフォールバック
    if (t && name) {
      if (name.includes(t) || t.includes(name)) return true;
      if (name.length >= 3 && t.length >= 3 && name.substring(0, 3) === t.substring(0, 3)) return true;
      for (let i = 0; i + 3 <= t.length; i++) {
        if (name.includes(t.substring(i, i + 3))) return true;
      }
    }
    if (t && cat && (cat.includes(t) || t.includes(cat))) return true;
    return false;
  });
}

function parsePrice(text: string): number | null {
  const num = text.replace(/[^0-9]/g, "");
  return num ? parseInt(num, 10) : null;
}

function parsePayment(text: string): PaymentKind | null {
  if (text.includes("介護") || text.includes("保険")) return "介護";
  if (text.includes("特価") || text.includes("特別")) return "特価自費";
  if (text.includes("自費") || text.includes("じひ")) return "自費";
  return null;
}

// ── メインページ ────────────────────────────────────────────────
export default function MobileOrderPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: tenantId } = use(params);

  const [clients, setClients] = useState<Client[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);

  const [step, setStep] = useState<Step>("client");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [paymentKind, setPaymentKind] = useState<PaymentKind>("介護");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [clientSearch, setClientSearch] = useState("");
  const [equipSearch, setEquipSearch] = useState("");

  // 音声Q&Aモード
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "speaking" | "listening">("idle");
  const [voiceMessage, setVoiceMessage] = useState("");
  const [voiceInput, setVoiceInput] = useState("");
  const voiceCancelRef = useRef(false);
  const micTapRef = useRef<(() => void) | null>(null);
  // STT結果は text(認識テキスト) と kana(カタカナ化したもの) の両方を持つ
  type HeardResult = { text: string; kana: string };
  const voiceInputResolveRef = useRef<((r: HeardResult) => void) | null>(null);

  useEffect(() => {
    // 音声発注ではフリガナが命なので、キャッシュを無視して必ず最新を取得する
    Promise.all([
      getClients(tenantId, { bypassCache: true }),
      getEquipment(tenantId, true),
      getSuppliers(true),
    ]).then(([c, eq, sup]) => {
      setClients(c);
      setEquipment(eq);
      setSuppliers(sup);
    }).finally(() => setLoading(false));
  }, [tenantId]);

  // ── 音声Q&Aフロー ────────────────────────────────────────────
  const runVoiceFlow = useCallback(async (
    allClients: Client[],
    allEquipment: Equipment[],
    allSuppliers: Supplier[]
  ) => {
    voiceCancelRef.current = false;
    setVoiceActive(true);

    const say = async (text: string) => {
      if (voiceCancelRef.current) return;
      setVoiceStatus("speaking");
      setVoiceMessage(text);
      await speak(text);
    };

    // MediaRecorder で録音 → Speech-to-Text API で文字起こし
    // 結果は "primary textkana1 kana2 ..." の形式で resolve（区切り文字 ）
    const hear = (): Promise<HeardResult> => {
      if (voiceCancelRef.current) return Promise.resolve({ text: "", kana: "" });
      setVoiceStatus("listening");
      setVoiceInput("");
      return new Promise((resolve) => {
        voiceInputResolveRef.current = (r: HeardResult) => {
          voiceInputResolveRef.current = null;
          setVoiceInput("");
          if (r.text) setVoiceMessage(`「${r.text}」`);
          setTimeout(() => resolve(r), r.text ? 500 : 0);
        };

        // マイクボタン押下でMediaRecorder録音開始
        micTapRef.current = async () => {
          micTapRef.current = null;
          setVoiceMessage("録音中... 話し終わったら「止める」を押してください");
          let stream: MediaStream;
          try {
            // エコー・ノイズ・ゲイン自動調整を有効化して認識精度を向上
            stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
              } as MediaTrackConstraints,
            });
          } catch {
            setVoiceMessage("マイクの使用を許可してください");
            return;
          }

          // iOSはaudio/mp4、AndroidはWebM、対応形式を自動選択
          const mimeType = [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/mp4",
            "audio/ogg",
          ].find(t => MediaRecorder.isTypeSupported(t)) ?? "";
          // iOS SafariはisTypeSupportedが全てfalseでもデフォルトでmp4録音する
          const effectiveMime = mimeType || (isIOS() ? "audio/mp4" : "audio/webm");
          const ext = effectiveMime.includes("mp4") ? "m4a" : effectiveMime.includes("ogg") ? "ogg" : "webm";

          const chunks: BlobPart[] = [];
          const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
          mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
          mr.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            const totalBytes = chunks.reduce((s, c) => s + (c as Blob).size, 0);
            // デバッグ: チャンク数・バイト数・形式を表示
            setVoiceMessage(`認識中... [${chunks.length}ch / ${totalBytes}B / ${ext}]`);
            if (totalBytes === 0) {
              setVoiceMessage(`録音データなし [mime:${effectiveMime}] テキスト入力で入力してください`);
              setTimeout(() => { if (voiceInputResolveRef.current) voiceInputResolveRef.current({ text: "", kana: "" }); }, 2000);
              return;
            }
            const blob = new Blob(chunks, { type: effectiveMime });
            const fd = new FormData();
            fd.append("audio", blob, `audio.${ext}`);
            fd.append("tenantId", tenantId); // カスタム辞書用にテナントIDを送信
            try {
              const res = await fetch("/api/transcribe", { method: "POST", body: fd });
              const data = await res.json();
              const primary = (data.text ?? "").trim();
              const alts: string[] = Array.isArray(data.alternatives) ? data.alternatives : [];
              const kanaPrimary = (data.kana ?? "").trim();
              const kanaAlts: string[] = Array.isArray(data.kanaAlternatives) ? data.kanaAlternatives : [];
              // 全候補を結合してマッチングに使う(漢字誤変換対策)
              const uniqueAlts = alts.filter((a) => a && a !== primary);
              const uniqueKanaAlts = kanaAlts.filter((a) => a && a !== kanaPrimary);
              const combinedText = [primary, ...uniqueAlts].join(" ").trim();
              const combinedKana = [kanaPrimary, ...uniqueKanaAlts].join(" ").trim();
              // デバッグ: プライマリとカナ化結果を表示
              const altDisplay = uniqueAlts.length > 0 ? ` +候補:${uniqueAlts.slice(0, 3).join("/")}` : "";
              const kanaDisplay = kanaPrimary ? ` (カナ:${kanaPrimary})` : "";
              setVoiceMessage(`結果: "${primary}"${altDisplay}${kanaDisplay} / err: ${data.error ?? "なし"} ${data.detail ?? ""}`);
              setTimeout(() => { if (voiceInputResolveRef.current) voiceInputResolveRef.current({ text: combinedText, kana: combinedKana }); }, 1500);
            } catch (e) {
              console.error("transcribe error:", e);
              setVoiceMessage(`通信エラー: ${String(e)}`);
              setTimeout(() => { if (voiceInputResolveRef.current) voiceInputResolveRef.current({ text: "", kana: "" }); }, 2000);
            }
          };
          mr.start(100); // timeslice指定でiOSのondataavailableを確実に発火

          // 止めるボタン用のコールバックを設定
          micTapRef.current = () => {
            micTapRef.current = null;
            mr.stop();
          };
          setVoiceMessage("録音中... 話し終わったら「止める」を押してください");
        };
      });
    };

    // 「はい」「以上」等のキーワード判定用：text と kana の両方をチェック
    const has = (r: HeardResult, ...kws: string[]) =>
      kws.some((kw) => (r.text ?? "").includes(kw) || (r.kana ?? "").includes(kw));

    try {
      // ── Step1: 利用者 ──
      let client: Client | null = null;
      while (!client) {
        await say("利用者のお名前を教えてください。");
        const ans = await hear();
        if (voiceCancelRef.current) break;
        if (!ans.text && !ans.kana) { await say("聞こえませんでした。もう一度お願いします。"); continue; }

        const matched = matchClients(ans.text, allClients, ans.kana);
        if (matched.length === 0) {
          await say(`${ans.text || ans.kana}さんが見つかりませんでした。もう一度お願いします。`);
        } else if (matched.length === 1) {
          await say(`${matched[0].name}さんでよろしいですか？`);
          const conf = await hear();
          if (has(conf, "はい", "そう", "yes")) {
            client = matched[0];
          } else {
            await say("もう一度名前を教えてください。");
          }
        } else {
          // 複数ヒット
          const names = matched.slice(0, 3).map(c => c.name).join("、それとも");
          await say(`${names}、どちらですか？`);
          const conf = await hear();
          const selected = matched.find(c =>
            has(conf, c.name.split(/\s/)[0]) ||
            has(conf, (c.furigana ?? "").split(/\s/)[0])
          );
          if (selected) {
            client = selected;
          } else {
            await say("もう一度お願いします。");
          }
        }
      }
      if (!client || voiceCancelRef.current) { setVoiceActive(false); setVoiceStatus("idle"); return; }
      setSelectedClient(client);
      setStep("payment");

      // ── Step2: 支払区分 ──
      let payment: PaymentKind | null = null;
      while (!payment) {
        await say("介護保険ですか、自費ですか？");
        const ans = await hear();
        if (voiceCancelRef.current) break;
        if (!ans.text && !ans.kana) { await say("聞こえませんでした。もう一度お願いします。"); continue; }
        // text/kana の両方で支払区分判定（「カイゴ」「ジヒ」も拾えるように）
        payment = parsePayment(`${ans.text} ${ans.kana}`);
        if (!payment) await say("介護、または自費とお答えください。");
      }
      if (!payment || voiceCancelRef.current) { setVoiceActive(false); setVoiceStatus("idle"); return; }
      setPaymentKind(payment);
      setStep("equipment");

      // ── Step3: 用具（複数対応）──
      const newCart: CartItem[] = [];
      let addMore = true;
      while (addMore) {
        await say(newCart.length === 0 ? "用具を教えてください。" : "他に用具はありますか？あれば名前を、なければ「以上」と言ってください。");
        const ans = await hear();
        if (voiceCancelRef.current) break;
        if (!ans.text && !ans.kana) { await say("聞こえませんでした。もう一度お願いします。"); continue; }
        if (has(ans, "以上", "ない", "終わり", "なし", "イジョウ", "オワリ")) {
          addMore = false;
          break;
        }

        const matched = matchEquipment(ans.text, allEquipment, ans.kana);
        if (matched.length === 0) {
          await say(`${ans.text || ans.kana}は見つかりませんでした。もう一度お願いします。`);
          continue;
        }

        let chosen: Equipment | null = null;
        if (matched.length === 1) {
          await say(`${matched[0].name}でよろしいですか？`);
          const conf = await hear();
          if (has(conf, "はい", "そう")) chosen = matched[0];
          else await say("もう一度用具名を教えてください。");
        } else {
          const names = matched.slice(0, 3).map(e => e.name).join("、それとも");
          await say(`${names}、どれですか？`);
          const conf = await hear();
          chosen = matched.find(e =>
            has(conf, e.name.substring(0, 3)) ||
            (e.furigana ? has(conf, e.furigana.substring(0, 3)) : false)
          ) ?? null;
          if (!chosen) await say("もう一度お願いします。");
        }

        if (chosen) {
          // 金額
          let price = chosen.rental_price ? String(chosen.rental_price) : "";
          if (chosen.rental_price) {
            await say(`月額${chosen.rental_price.toLocaleString()}円でよろしいですか？`);
            const conf = await hear();
            if (!has(conf, "はい", "そう")) {
              await say("金額を教えてください。");
              const priceAns = await hear();
              const p = parsePrice(`${priceAns.text} ${priceAns.kana}`);
              if (p) price = String(p);
            }
          } else {
            await say("月額料金はいくらですか？");
            const priceAns = await hear();
            const p = parsePrice(`${priceAns.text} ${priceAns.kana}`);
            if (p) price = String(p);
          }
          newCart.push({ equipment: chosen, rental_price: price, supplier_id: null, quantity: 1, notes: "" });
          await say(`${chosen.name}を追加しました。`);
        }
      }

      if (newCart.length === 0 || voiceCancelRef.current) { setVoiceActive(false); setVoiceStatus("idle"); return; }
      setCart(newCart);
      setStep("confirm");

      // ── Step4: 確認 ──
      const summary = `${client.name}さん、${payment}、${newCart.map(i => i.equipment.name).join("と")}、合計${newCart.length}件。よろしいですか？`;
      await say(summary);
      const conf = await hear();
      if (has(conf, "はい", "そう", "お願い")) {
        setVoiceStatus("speaking");
        setVoiceMessage("発注中...");
        // 発注実行
        const order = await createOrder({ tenantId, clientId: client.id, paymentType: payment, deliveryType: "自社納品" });
        for (const item of newCart) {
          await createOrderItem({
            orderId: order.id, tenantId,
            productCode: item.equipment.product_code,
            rentalPrice: item.rental_price ? parseInt(item.rental_price, 10) : undefined,
            paymentType: payment,
            quantity: item.quantity,
          });
        }
        setStep("done");
        await say("発注が完了しました。");
      } else {
        await say("発注をキャンセルしました。");
      }
    } catch (e) {
      console.error(e);
      await say("エラーが発生しました。");
    } finally {
      setVoiceActive(false);
      setVoiceStatus("idle");
      setVoiceMessage("");
    }
  }, [tenantId]);

  const startVoice = () => {
    runVoiceFlow(clients, equipment, suppliers);
  };

  const stopVoice = () => {
    voiceCancelRef.current = true;
    window.speechSynthesis?.cancel();
    setVoiceActive(false);
    setVoiceStatus("idle");
    setVoiceMessage("");
  };

  const filteredClients = clients
    .filter(c =>
      !clientSearch || c.name.includes(clientSearch) || (c.furigana ?? "").includes(clientSearch)
    )
    // 事業所・施設は末尾、個人利用者は先頭
    .sort((a, b) => {
      const fa = a.is_facility ? 1 : 0;
      const fb = b.is_facility ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
    });

  const filteredEquipment = equipment.filter(eq =>
    !equipSearch ||
    eq.name.toLowerCase().includes(equipSearch.toLowerCase()) ||
    (eq.category ?? "").includes(equipSearch)
  );

  const toggleEquipment = (eq: Equipment) => {
    const exists = cart.find(c => c.equipment.id === eq.id);
    if (exists) setCart(prev => prev.filter(c => c.equipment.id !== eq.id));
    else setCart(prev => [...prev, { equipment: eq, rental_price: eq.rental_price ? String(eq.rental_price) : "", supplier_id: null, quantity: 1, notes: "" }]);
  };

  const updateCartItem = (idx: number, updates: Partial<CartItem>) =>
    setCart(prev => prev.map((c, i) => i === idx ? { ...c, ...updates } : c));

  const handleSubmit = async () => {
    if (!selectedClient || cart.length === 0) return;
    setSubmitting(true);
    try {
      const order = await createOrder({ tenantId, clientId: selectedClient.id, paymentType: paymentKind, deliveryType: "自社納品" });
      for (const item of cart) {
        await createOrderItem({ orderId: order.id, tenantId, productCode: item.equipment.product_code, supplierId: item.supplier_id ?? undefined, rentalPrice: item.rental_price ? parseInt(item.rental_price, 10) : undefined, paymentType: paymentKind, quantity: item.quantity, notes: item.notes || undefined });
      }
      setStep("done");
    } catch (e) { alert("エラーが発生しました。"); console.error(e); }
    finally { setSubmitting(false); }
  };

  const reset = () => { setStep("client"); setSelectedClient(null); setPaymentKind("介護"); setCart([]); setClientSearch(""); setEquipSearch(""); };

  const stepIndex = STEPS.indexOf(step);

  if (loading) return <div className="min-h-screen bg-gray-50 flex items-center justify-center"><div className="text-gray-400 text-sm">読み込み中...</div></div>;

  return (
    <div className="min-h-screen w-full bg-gray-50 flex flex-col">
      {/* ヘッダー */}
      <div className="bg-emerald-600 text-white w-full px-4 pb-3 pt-3">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-bold">発注</h1>
          {step !== "done" && step !== "client" && (
            <button onClick={() => setStep(STEPS[stepIndex - 1])} className="flex items-center gap-1 text-emerald-100 text-sm py-1 px-2">
              <ChevronLeft size={18} /> 戻る
            </button>
          )}
        </div>
        {step !== "done" && (
          <>
            <div className="flex gap-1 w-full">
              {(["client", "payment", "equipment", "detail", "confirm"] as Step[]).map((s, i) => (
                <div key={s} className={`flex-1 h-1.5 rounded-full transition-colors ${stepIndex > i ? "bg-white" : step === s ? "bg-white" : "bg-emerald-400/60"}`} />
              ))}
            </div>
            <p className="text-emerald-100 text-xs mt-1.5">{STEP_LABELS[step]}</p>
          </>
        )}
      </div>

      {/* 音声Q&Aオーバーレイ */}
      {voiceActive && (
        <div className="fixed inset-0 bg-black/80 z-50 flex flex-col items-center justify-center px-6">
          <div className="w-full max-w-sm">
            {/* アイコン */}
            <div className="flex justify-center mb-6">
              <div className={`relative w-24 h-24 rounded-full flex items-center justify-center ${
                voiceStatus === "listening" && voiceMessage === "聞いています..." ? "bg-red-500" : "bg-emerald-500"
              }`}>
                {voiceStatus === "speaking" && <Volume2 size={44} className="text-white" />}
                {voiceStatus === "listening" && voiceMessage !== "聞いています..." && <Mic size={44} className="text-white" />}
                {voiceStatus === "listening" && voiceMessage === "聞いています..." && <Mic size={44} className="text-white animate-pulse" />}
                {voiceStatus === "speaking" && (
                  <div className="absolute inset-0 rounded-full border-4 border-emerald-300 animate-ping opacity-40" />
                )}
              </div>
            </div>
            {/* メッセージ */}
            <div className="bg-white rounded-2xl p-5 mb-5 min-h-[70px] flex items-center justify-center">
              <p className="text-gray-800 text-base text-center font-medium leading-relaxed">{voiceMessage}</p>
            </div>
            {/* 録音ボタン */}
            {voiceStatus === "listening" && voiceInputResolveRef.current && (
              <div className="w-full mb-4 space-y-2">
                {/* 話す / 止めるボタン */}
                <button
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); micTapRef.current?.(); }}
                  className={`w-full py-5 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 active:opacity-80 ${
                    voiceMessage.includes("録音中") ? "bg-gray-700 text-white" : "bg-red-500 text-white"
                  }`}
                >
                  <Mic size={26} />
                  {voiceMessage.includes("録音中") ? "止める" : "話す"}
                </button>
                {/* テキスト入力（補助） */}
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={voiceInput}
                    onChange={e => setVoiceInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && voiceInput.trim()) voiceInputResolveRef.current?.({ text: voiceInput.trim(), kana: voiceInput.trim() }); }}
                    placeholder="またはここに入力"
                    className="flex-1 border border-gray-300 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white"
                  />
                  <button
                    onClick={() => { if (voiceInput.trim()) voiceInputResolveRef.current?.({ text: voiceInput.trim(), kana: voiceInput.trim() }); }}
                    disabled={!voiceInput.trim()}
                    className="px-4 bg-emerald-500 disabled:opacity-40 text-white font-bold rounded-xl text-sm"
                  >
                    送信
                  </button>
                </div>
              </div>
            )}
            <button
              onClick={stopVoice}
              className="w-full bg-gray-700 text-white py-4 rounded-xl font-medium text-base"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 音声発注ボタン（常時表示） */}
      {step !== "done" && !voiceActive && (
        <div className="w-full px-4 pt-4">
          <button
            onClick={startVoice}
            className="w-full bg-indigo-600 text-white py-4 rounded-xl font-bold text-base flex items-center justify-center gap-2 shadow-md active:bg-indigo-700"
          >
            <Mic size={22} />
            音声で発注する
          </button>
          <div className="flex items-center gap-3 my-4">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-xs text-gray-400">または手動で入力</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
        </div>
      )}

      {/* コンテンツ */}
      <div className="flex-1 overflow-y-auto w-full">

        {/* Step 1: 利用者選択 */}
        {step === "client" && (
          <div className="px-4 pb-4 w-full">
            <p className="text-sm text-gray-500 mb-3">発注する利用者を選択してください</p>
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={clientSearch} onChange={e => setClientSearch(e.target.value)} placeholder="名前・ふりがなで検索"
                className="w-full pl-9 pr-4 py-3 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-300" />
            </div>
            <div className="space-y-2 w-full">
              {filteredClients.map(client => (
                <button key={client.id} onClick={() => { setSelectedClient(client); setStep("payment"); }}
                  className="w-full bg-white rounded-xl border border-gray-200 px-4 py-4 text-left flex items-center justify-between active:bg-emerald-50">
                  <div>
                    <p className="font-semibold text-gray-800 text-base flex items-center gap-1.5">
                      {client.name}
                      {client.is_provisional && <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">仮</span>}
                    </p>
                    {client.furigana && <p className="text-xs text-gray-400 mt-0.5">{client.furigana}</p>}
                  </div>
                  <ChevronRight size={20} className="text-gray-300 shrink-0" />
                </button>
              ))}
              {filteredClients.length === 0 && <p className="text-center text-sm text-gray-400 py-10">該当する利用者がいません</p>}
            </div>
          </div>
        )}

        {/* Step 2: 支払区分 */}
        {step === "payment" && (
          <div className="px-4 pb-4 w-full">
            <div className="bg-emerald-50 rounded-xl px-4 py-3 mb-6 w-full">
              <p className="text-xs text-gray-500">利用者</p>
              <p className="font-semibold text-gray-800 text-lg mt-0.5">{selectedClient?.name}</p>
            </div>
            <p className="text-sm text-gray-500 mb-4">支払区分を選択してください</p>
            <div className="space-y-3 w-full">
              {(["介護", "自費", "特価自費"] as PaymentKind[]).map(kind => (
                <button key={kind} onClick={() => { setPaymentKind(kind); setStep("equipment"); }}
                  className={`w-full rounded-xl border-2 px-5 py-5 text-left flex items-center justify-between transition-all ${paymentKind === kind ? "border-emerald-500 bg-emerald-50" : "border-gray-200 bg-white"}`}>
                  <div>
                    <p className="font-bold text-gray-800 text-xl">{kind}</p>
                    <p className="text-xs text-gray-400 mt-1">{kind === "介護" ? "介護保険適用" : kind === "自費" ? "全額自己負担" : "特別価格での自費"}</p>
                  </div>
                  {paymentKind === kind && <Check size={24} className="text-emerald-500 shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: 用具選択 */}
        {step === "equipment" && (
          <div className="px-4 pb-4 w-full">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-gray-500">用具を選択（複数可）</p>
              {cart.length > 0 && (
                <button onClick={() => setStep("detail")} className="flex items-center gap-1.5 bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-xl shrink-0">
                  <ShoppingCart size={15} />{cart.length}件 次へ
                </button>
              )}
            </div>
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={equipSearch} onChange={e => setEquipSearch(e.target.value)} placeholder="用具名・カテゴリで検索"
                className="w-full pl-9 pr-4 py-3 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-300" />
            </div>
            {cart.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {cart.map(item => (
                  <span key={item.equipment.id} className="flex items-center gap-1 bg-emerald-100 text-emerald-700 text-xs px-2.5 py-1 rounded-full">
                    {item.equipment.name}<button onClick={() => toggleEquipment(item.equipment)}><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="space-y-2 w-full">
              {filteredEquipment.map(eq => {
                const inCart = cart.some(c => c.equipment.id === eq.id);
                return (
                  <button key={eq.id} onClick={() => toggleEquipment(eq)}
                    className={`w-full rounded-xl border-2 px-4 py-3.5 text-left flex items-center justify-between transition-all ${inCart ? "border-emerald-400 bg-emerald-50" : "border-gray-200 bg-white"}`}>
                    <div className="flex-1 min-w-0 mr-3">
                      <p className="font-medium text-gray-800 text-sm leading-snug">{eq.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {eq.category && <span className="text-xs text-gray-400">{eq.category}</span>}
                        {eq.rental_price && <span className="text-xs text-emerald-600 font-medium">¥{eq.rental_price.toLocaleString()}/月</span>}
                      </div>
                    </div>
                    <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 ${inCart ? "border-emerald-500 bg-emerald-500" : "border-gray-300"}`}>
                      {inCart && <Check size={14} className="text-white" />}
                    </div>
                  </button>
                );
              })}
              {filteredEquipment.length === 0 && <p className="text-center text-sm text-gray-400 py-10">該当する用具がありません</p>}
            </div>
            {cart.length > 0 && (
              <div className="mt-4 w-full">
                <button onClick={() => setStep("detail")} className="w-full bg-emerald-500 text-white font-bold py-4 rounded-xl text-base">
                  次へ（{cart.length}件選択中）
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: 詳細設定 */}
        {step === "detail" && (
          <div className="px-4 pb-4 space-y-4 w-full">
            <p className="text-sm text-gray-500">各用具の詳細を設定してください</p>
            {cart.map((item, idx) => (
              <div key={item.equipment.id} className="bg-white rounded-xl border border-gray-200 p-4 w-full">
                <div className="flex items-start justify-between mb-3">
                  <p className="font-semibold text-gray-800 text-sm leading-snug flex-1 mr-2">{item.equipment.name}</p>
                  <button onClick={() => setCart(prev => prev.filter((_, i) => i !== idx))} className="text-gray-300 active:text-red-400 p-1"><X size={18} /></button>
                </div>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-gray-500">数量</span>
                  <div className="flex items-center gap-4">
                    <button onClick={() => updateCartItem(idx, { quantity: Math.max(1, item.quantity - 1) })} className="w-10 h-10 rounded-full border-2 border-gray-200 flex items-center justify-center"><Minus size={16} /></button>
                    <span className="font-bold text-gray-800 text-lg w-6 text-center">{item.quantity}</span>
                    <button onClick={() => updateCartItem(idx, { quantity: item.quantity + 1 })} className="w-10 h-10 rounded-full border-2 border-gray-200 flex items-center justify-center"><Plus size={16} /></button>
                  </div>
                </div>
                <div className="mb-3">
                  <label className="text-xs text-gray-500 block mb-1.5">月額レンタル料（円）</label>
                  <input type="number" value={item.rental_price} onChange={e => updateCartItem(idx, { rental_price: e.target.value })} placeholder="例: 9000" inputMode="numeric"
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-300" />
                </div>
                <div className="mb-3">
                  <label className="text-xs text-gray-500 block mb-1.5">卸会社</label>
                  <select value={item.supplier_id ?? ""} onChange={e => updateCartItem(idx, { supplier_id: e.target.value || null })}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white">
                    <option value="">未設定</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1.5">備考</label>
                  <input type="text" value={item.notes} onChange={e => updateCartItem(idx, { notes: e.target.value })} placeholder="任意"
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-300" />
                </div>
              </div>
            ))}
            {cart.length > 0 && <button onClick={() => setStep("confirm")} className="w-full bg-emerald-500 text-white font-bold py-4 rounded-xl text-base">確認へ</button>}
          </div>
        )}

        {/* Step 5: 確認 */}
        {step === "confirm" && (
          <div className="px-4 pb-4 w-full">
            <p className="text-sm text-gray-500 mb-4">内容を確認してください</p>
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 mb-4 w-full">
              <div className="px-4 py-3.5"><p className="text-xs text-gray-400">利用者</p><p className="font-semibold text-gray-800 text-base mt-0.5">{selectedClient?.name}</p></div>
              <div className="px-4 py-3.5"><p className="text-xs text-gray-400">支払区分</p><p className="font-semibold text-gray-800 text-base mt-0.5">{paymentKind}</p></div>
            </div>
            <div className="space-y-2 mb-6 w-full">
              {cart.map((item, idx) => {
                const supplier = suppliers.find(s => s.id === item.supplier_id);
                return (
                  <div key={idx} className="bg-white rounded-xl border border-gray-200 px-4 py-3.5">
                    <p className="font-medium text-gray-800">{item.equipment.name}</p>
                    <div className="mt-1.5 space-y-0.5">
                      <p className="text-sm text-gray-500">数量: {item.quantity}</p>
                      {item.rental_price && <p className="text-sm text-gray-500">¥{parseInt(item.rental_price).toLocaleString()}/月</p>}
                      {supplier && <p className="text-sm text-gray-500">卸: {supplier.name}</p>}
                      {item.notes && <p className="text-sm text-gray-500">備考: {item.notes}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={handleSubmit} disabled={submitting} className="w-full bg-emerald-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl text-base">
              {submitting ? "発注中..." : "発注する"}
            </button>
          </div>
        )}

        {/* Step 6: 完了 */}
        {step === "done" && (
          <div className="flex flex-col items-center justify-center min-h-[70vh] p-8 text-center w-full">
            <div className="w-24 h-24 bg-emerald-100 rounded-full flex items-center justify-center mb-6">
              <Check size={48} className="text-emerald-500" />
            </div>
            <h2 className="text-2xl font-bold text-gray-800 mb-2">発注完了</h2>
            <p className="text-base text-gray-500 mb-1">{selectedClient?.name}</p>
            <p className="text-sm text-gray-400 mb-10">{cart.length}件の用具を発注しました</p>
            <button onClick={reset} className="w-full bg-emerald-500 text-white font-bold py-4 rounded-xl text-base">続けて発注する</button>
          </div>
        )}
      </div>
    </div>
  );
}
