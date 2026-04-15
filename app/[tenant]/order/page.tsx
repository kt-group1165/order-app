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
    u.onend = () => setTimeout(resolve, 400); // 読み上げ後少し待つ
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

// ユーザーのタップをPromiseで待つ
let _tapResolve: (() => void) | null = null;
export function triggerVoiceTap() {
  _tapResolve?.();
  _tapResolve = null;
}
function waitForTap(): Promise<void> {
  return new Promise((resolve) => { _tapResolve = resolve; });
}

function listenOnce(): Promise<string> {
  return new Promise((resolve) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { resolve(""); return; }
    const r = new SR();
    r.lang = "ja-JP";
    r.interimResults = false;
    r.maxAlternatives = 1;
    let done = false;
    const finish = (text: string) => { if (!done) { done = true; resolve(text); } };
    const timer = setTimeout(() => finish(""), 10000);
    r.onresult = (e: any) => { clearTimeout(timer); finish(e.results[0][0].transcript as string); };
    r.onerror = (e: any) => { console.warn("SR:", e.error); clearTimeout(timer); finish(""); };
    r.onend = () => { clearTimeout(timer); finish(""); };
    try { r.start(); } catch { finish(""); }
  });
}

// 名前マッチング（部分一致）
function matchClients(text: string, clients: Client[]): Client[] {
  return clients.filter(c =>
    c.name.includes(text) ||
    (c.furigana ?? "").includes(text) ||
    text.includes(c.name.split(" ")[0]) ||
    text.includes((c.furigana ?? "").split(" ")[0])
  );
}

function matchEquipment(text: string, equipment: Equipment[]): Equipment[] {
  const t = text.replace(/\s/g, "");
  return equipment.filter(eq =>
    eq.name.includes(t) ||
    (eq.category ?? "").includes(t) ||
    t.includes(eq.name.substring(0, 4))
  );
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
  const voiceCancelRef = useRef(false);

  useEffect(() => {
    Promise.all([
      getClients(tenantId),
      getEquipment(tenantId),
      getSuppliers(),
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

    const hear = async (): Promise<string> => {
      if (voiceCancelRef.current) return "";
      // ボタン待ち状態にして、ユーザーがタップしたら録音開始
      setVoiceStatus("listening");
      setVoiceMessage("マイクボタンを押して話してください");
      await waitForTap();
      if (voiceCancelRef.current) return "";
      setVoiceMessage("聞いています...");
      const text = await listenOnce();
      if (text) setVoiceMessage(`「${text}」`);
      await new Promise(r => setTimeout(r, 600));
      return text;
    };

    try {
      // ── Step1: 利用者 ──
      let client: Client | null = null;
      while (!client) {
        await say("利用者のお名前を教えてください。");
        const name = await hear();
        if (!name || voiceCancelRef.current) break;

        const matched = matchClients(name, allClients);
        if (matched.length === 0) {
          await say(`${name}さんが見つかりませんでした。もう一度お願いします。`);
        } else if (matched.length === 1) {
          await say(`${matched[0].name}さんでよろしいですか？`);
          const ans = await hear();
          if (ans.includes("はい") || ans.includes("そう") || ans.includes("yes")) {
            client = matched[0];
          } else {
            await say("もう一度名前を教えてください。");
          }
        } else {
          // 複数ヒット
          const names = matched.slice(0, 3).map(c => c.name).join("、それとも");
          await say(`${names}、どちらですか？`);
          const ans = await hear();
          const selected = matched.find(c => ans.includes(c.name.split(/\s/)[0]) || ans.includes((c.furigana ?? "").split(/\s/)[0]));
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
        if (!ans || voiceCancelRef.current) break;
        payment = parsePayment(ans);
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
        if (!ans || voiceCancelRef.current) break;
        if (ans.includes("以上") || ans.includes("ない") || ans.includes("終わり") || ans.includes("なし")) {
          addMore = false;
          break;
        }

        const matched = matchEquipment(ans, allEquipment);
        if (matched.length === 0) {
          await say(`${ans}は見つかりませんでした。もう一度お願いします。`);
          continue;
        }

        let chosen: Equipment | null = null;
        if (matched.length === 1) {
          await say(`${matched[0].name}でよろしいですか？`);
          const conf = await hear();
          if (conf.includes("はい") || conf.includes("そう")) chosen = matched[0];
          else await say("もう一度用具名を教えてください。");
        } else {
          const names = matched.slice(0, 3).map(e => e.name).join("、それとも");
          await say(`${names}、どれですか？`);
          const conf = await hear();
          chosen = matched.find(e => conf.includes(e.name.substring(0, 3))) ?? null;
          if (!chosen) await say("もう一度お願いします。");
        }

        if (chosen) {
          // 金額
          let price = chosen.rental_price ? String(chosen.rental_price) : "";
          if (chosen.rental_price) {
            await say(`月額${chosen.rental_price.toLocaleString()}円でよろしいですか？`);
            const conf = await hear();
            if (!conf.includes("はい") && !conf.includes("そう")) {
              await say("金額を教えてください。");
              const priceAns = await hear();
              const p = parsePrice(priceAns);
              if (p) price = String(p);
            }
          } else {
            await say("月額料金はいくらですか？");
            const priceAns = await hear();
            const p = parsePrice(priceAns);
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
      if (conf.includes("はい") || conf.includes("そう") || conf.includes("お願い")) {
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

  const filteredClients = clients.filter(c =>
    !clientSearch || c.name.includes(clientSearch) || (c.furigana ?? "").includes(clientSearch)
  );

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
            {/* 話すボタン（ボタン待ち時のみ表示） */}
            {voiceStatus === "listening" && voiceMessage === "マイクボタンを押して話してください" && (
              <button
                onClick={triggerVoiceTap}
                className="w-full bg-red-500 text-white py-5 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 mb-4 active:bg-red-600"
              >
                <Mic size={26} /> 話す
              </button>
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
                    <p className="font-semibold text-gray-800 text-base">{client.name}</p>
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
