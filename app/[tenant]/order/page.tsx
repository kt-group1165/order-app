"use client";

import { useState, useEffect, use, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight, Search, Check, X, Plus, Minus, ShoppingCart, Mic, MicOff } from "lucide-react";
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

// 音声入力フック
function useSpeechInput(onResult: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);

  const start = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("このブラウザは音声入力に対応していません"); return; }
    const r = new SR();
    r.lang = "ja-JP";
    r.interimResults = false;
    r.onresult = (e: any) => {
      const text = e.results[0][0].transcript;
      onResult(text);
      setListening(false);
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    recogRef.current = r;
    r.start();
    setListening(true);
  }, [onResult]);

  const stop = useCallback(() => {
    recogRef.current?.stop();
    setListening(false);
  }, []);

  return { listening, start, stop };
}

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

  // 音声入力
  const clientSpeech = useSpeechInput((text) => setClientSearch(text));
  const equipSpeech = useSpeechInput((text) => setEquipSearch(text));

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

  const filteredClients = clients.filter(c =>
    !clientSearch ||
    c.name.includes(clientSearch) ||
    (c.furigana ?? "").includes(clientSearch)
  );

  const filteredEquipment = equipment.filter(eq =>
    !equipSearch ||
    eq.name.toLowerCase().includes(equipSearch.toLowerCase()) ||
    (eq.category ?? "").includes(equipSearch) ||
    (eq.product_code ?? "").includes(equipSearch)
  );

  const toggleEquipment = (eq: Equipment) => {
    const exists = cart.find(c => c.equipment.id === eq.id);
    if (exists) {
      setCart(prev => prev.filter(c => c.equipment.id !== eq.id));
    } else {
      setCart(prev => [...prev, {
        equipment: eq,
        rental_price: eq.rental_price ? String(eq.rental_price) : "",
        supplier_id: null,
        quantity: 1,
        notes: "",
      }]);
    }
  };

  const updateCartItem = (idx: number, updates: Partial<CartItem>) => {
    setCart(prev => prev.map((c, i) => i === idx ? { ...c, ...updates } : c));
  };

  const handleSubmit = async () => {
    if (!selectedClient || cart.length === 0) return;
    setSubmitting(true);
    try {
      const order = await createOrder({
        tenantId,
        clientId: selectedClient.id,
        paymentType: paymentKind,
        deliveryType: "自社納品",
      });
      for (const item of cart) {
        await createOrderItem({
          orderId: order.id,
          tenantId,
          productCode: item.equipment.product_code,
          supplierId: item.supplier_id ?? undefined,
          rentalPrice: item.rental_price ? parseInt(item.rental_price, 10) : undefined,
          paymentType: paymentKind,
          quantity: item.quantity,
          notes: item.notes || undefined,
        });
      }
      setStep("done");
    } catch (e) {
      alert("エラーが発生しました。もう一度お試しください。");
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setStep("client");
    setSelectedClient(null);
    setPaymentKind("介護");
    setCart([]);
    setClientSearch("");
    setEquipSearch("");
  };

  const stepIndex = STEPS.indexOf(step);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">読み込み中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-gray-50 flex flex-col">
      {/* ヘッダー */}
      <div className="bg-emerald-600 text-white w-full px-4 pb-3 pt-3">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-bold">発注</h1>
          {step !== "done" && step !== "client" && (
            <button
              onClick={() => setStep(STEPS[stepIndex - 1])}
              className="flex items-center gap-1 text-emerald-100 text-sm py-1 px-2"
            >
              <ChevronLeft size={18} /> 戻る
            </button>
          )}
        </div>
        {/* ステップバー */}
        {step !== "done" && (
          <>
            <div className="flex gap-1 w-full">
              {(["client", "payment", "equipment", "detail", "confirm"] as Step[]).map((s, i) => (
                <div
                  key={s}
                  className={`flex-1 h-1.5 rounded-full transition-colors ${
                    stepIndex > i ? "bg-white" : step === s ? "bg-white" : "bg-emerald-400/60"
                  }`}
                />
              ))}
            </div>
            <p className="text-emerald-100 text-xs mt-1.5">{STEP_LABELS[step]}</p>
          </>
        )}
      </div>

      {/* コンテンツ */}
      <div className="flex-1 overflow-y-auto w-full">

        {/* Step 1: 利用者選択 */}
        {step === "client" && (
          <div className="p-4 w-full">
            <p className="text-sm text-gray-500 mb-3">発注する利用者を選択してください</p>
            {/* 検索バー */}
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={clientSearch}
                  onChange={e => setClientSearch(e.target.value)}
                  placeholder="名前・ふりがなで検索"
                  className="w-full pl-9 pr-4 py-3 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-300"
                />
              </div>
              <button
                onPointerDown={clientSpeech.listening ? clientSpeech.stop : clientSpeech.start}
                className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                  clientSpeech.listening
                    ? "bg-red-500 text-white animate-pulse"
                    : "bg-white border border-gray-200 text-gray-400"
                }`}
              >
                {clientSpeech.listening ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
            </div>
            {clientSpeech.listening && (
              <p className="text-xs text-red-500 text-center mb-2 animate-pulse">聞いています...</p>
            )}
            <div className="space-y-2 w-full">
              {filteredClients.map(client => (
                <button
                  key={client.id}
                  onClick={() => { setSelectedClient(client); setStep("payment"); }}
                  className="w-full bg-white rounded-xl border border-gray-200 px-4 py-4 text-left flex items-center justify-between active:bg-emerald-50 transition-colors"
                >
                  <div>
                    <p className="font-semibold text-gray-800 text-base">{client.name}</p>
                    {client.furigana && <p className="text-xs text-gray-400 mt-0.5">{client.furigana}</p>}
                  </div>
                  <ChevronRight size={20} className="text-gray-300 shrink-0" />
                </button>
              ))}
              {filteredClients.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-10">該当する利用者がいません</p>
              )}
            </div>
          </div>
        )}

        {/* Step 2: 支払区分 */}
        {step === "payment" && (
          <div className="p-4 w-full">
            <div className="bg-emerald-50 rounded-xl px-4 py-3 mb-6 w-full">
              <p className="text-xs text-gray-500">利用者</p>
              <p className="font-semibold text-gray-800 text-lg mt-0.5">{selectedClient?.name}</p>
            </div>
            <p className="text-sm text-gray-500 mb-4">支払区分を選択してください</p>
            <div className="space-y-3 w-full">
              {(["介護", "自費", "特価自費"] as PaymentKind[]).map(kind => (
                <button
                  key={kind}
                  onClick={() => { setPaymentKind(kind); setStep("equipment"); }}
                  className={`w-full rounded-xl border-2 px-5 py-5 text-left flex items-center justify-between transition-all ${
                    paymentKind === kind
                      ? "border-emerald-500 bg-emerald-50"
                      : "border-gray-200 bg-white"
                  }`}
                >
                  <div>
                    <p className="font-bold text-gray-800 text-xl">{kind}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {kind === "介護" ? "介護保険適用" : kind === "自費" ? "全額自己負担" : "特別価格での自費"}
                    </p>
                  </div>
                  {paymentKind === kind && <Check size={24} className="text-emerald-500 shrink-0" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: 用具選択 */}
        {step === "equipment" && (
          <div className="p-4 w-full">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-gray-500">用具を選択（複数可）</p>
              {cart.length > 0 && (
                <button
                  onClick={() => setStep("detail")}
                  className="flex items-center gap-1.5 bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-xl shrink-0"
                >
                  <ShoppingCart size={15} />
                  {cart.length}件 次へ
                </button>
              )}
            </div>
            {/* 検索バー */}
            <div className="flex gap-2 mb-3">
              <div className="relative flex-1">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  value={equipSearch}
                  onChange={e => setEquipSearch(e.target.value)}
                  placeholder="用具名・カテゴリで検索"
                  className="w-full pl-9 pr-4 py-3 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-300"
                />
              </div>
              <button
                onPointerDown={equipSpeech.listening ? equipSpeech.stop : equipSpeech.start}
                className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
                  equipSpeech.listening
                    ? "bg-red-500 text-white animate-pulse"
                    : "bg-white border border-gray-200 text-gray-400"
                }`}
              >
                {equipSpeech.listening ? <MicOff size={20} /> : <Mic size={20} />}
              </button>
            </div>
            {equipSpeech.listening && (
              <p className="text-xs text-red-500 text-center mb-2 animate-pulse">聞いています...</p>
            )}
            {cart.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {cart.map(item => (
                  <span key={item.equipment.id} className="flex items-center gap-1 bg-emerald-100 text-emerald-700 text-xs px-2.5 py-1 rounded-full">
                    {item.equipment.name}
                    <button onClick={() => toggleEquipment(item.equipment)}><X size={12} /></button>
                  </span>
                ))}
              </div>
            )}
            <div className="space-y-2 w-full">
              {filteredEquipment.map(eq => {
                const inCart = cart.some(c => c.equipment.id === eq.id);
                return (
                  <button
                    key={eq.id}
                    onClick={() => toggleEquipment(eq)}
                    className={`w-full rounded-xl border-2 px-4 py-3.5 text-left flex items-center justify-between transition-all ${
                      inCart ? "border-emerald-400 bg-emerald-50" : "border-gray-200 bg-white"
                    }`}
                  >
                    <div className="flex-1 min-w-0 mr-3">
                      <p className="font-medium text-gray-800 text-sm leading-snug">{eq.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {eq.category && <span className="text-xs text-gray-400">{eq.category}</span>}
                        {eq.rental_price && (
                          <span className="text-xs text-emerald-600 font-medium">¥{eq.rental_price.toLocaleString()}/月</span>
                        )}
                      </div>
                    </div>
                    <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center shrink-0 ${
                      inCart ? "border-emerald-500 bg-emerald-500" : "border-gray-300"
                    }`}>
                      {inCart && <Check size={14} className="text-white" />}
                    </div>
                  </button>
                );
              })}
              {filteredEquipment.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-10">該当する用具がありません</p>
              )}
            </div>
            {cart.length > 0 && (
              <div className="mt-4 w-full">
                <button
                  onClick={() => setStep("detail")}
                  className="w-full bg-emerald-500 text-white font-bold py-4 rounded-xl text-base"
                >
                  次へ（{cart.length}件選択中）
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: 詳細設定 */}
        {step === "detail" && (
          <div className="p-4 space-y-4 w-full">
            <p className="text-sm text-gray-500">各用具の詳細を設定してください</p>
            {cart.map((item, idx) => (
              <div key={item.equipment.id} className="bg-white rounded-xl border border-gray-200 p-4 w-full">
                <div className="flex items-start justify-between mb-3">
                  <p className="font-semibold text-gray-800 text-sm leading-snug flex-1 mr-2">{item.equipment.name}</p>
                  <button onClick={() => setCart(prev => prev.filter((_, i) => i !== idx))} className="text-gray-300 active:text-red-400 p-1">
                    <X size={18} />
                  </button>
                </div>
                {/* 数量 */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm text-gray-500">数量</span>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => updateCartItem(idx, { quantity: Math.max(1, item.quantity - 1) })}
                      className="w-10 h-10 rounded-full border-2 border-gray-200 flex items-center justify-center text-gray-500 active:bg-gray-100"
                    >
                      <Minus size={16} />
                    </button>
                    <span className="font-bold text-gray-800 text-lg w-6 text-center">{item.quantity}</span>
                    <button
                      onClick={() => updateCartItem(idx, { quantity: item.quantity + 1 })}
                      className="w-10 h-10 rounded-full border-2 border-gray-200 flex items-center justify-center text-gray-500 active:bg-gray-100"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
                {/* レンタル料 */}
                <div className="mb-3">
                  <label className="text-xs text-gray-500 block mb-1.5">月額レンタル料（円）</label>
                  <input
                    type="number"
                    value={item.rental_price}
                    onChange={e => updateCartItem(idx, { rental_price: e.target.value })}
                    placeholder="例: 9000"
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-300"
                    inputMode="numeric"
                  />
                </div>
                {/* 卸会社 */}
                <div className="mb-3">
                  <label className="text-xs text-gray-500 block mb-1.5">卸会社</label>
                  <select
                    value={item.supplier_id ?? ""}
                    onChange={e => updateCartItem(idx, { supplier_id: e.target.value || null })}
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white"
                  >
                    <option value="">未設定</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                {/* 備考 */}
                <div>
                  <label className="text-xs text-gray-500 block mb-1.5">備考</label>
                  <input
                    type="text"
                    value={item.notes}
                    onChange={e => updateCartItem(idx, { notes: e.target.value })}
                    placeholder="任意"
                    className="w-full border border-gray-200 rounded-xl px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-300"
                  />
                </div>
              </div>
            ))}
            {cart.length === 0 && (
              <div className="text-center py-10">
                <p className="text-sm text-gray-400 mb-3">用具が選択されていません</p>
                <button onClick={() => setStep("equipment")} className="text-emerald-600 text-sm font-medium">用具を選ぶ</button>
              </div>
            )}
            {cart.length > 0 && (
              <button
                onClick={() => setStep("confirm")}
                className="w-full bg-emerald-500 text-white font-bold py-4 rounded-xl text-base"
              >
                確認へ
              </button>
            )}
          </div>
        )}

        {/* Step 5: 確認 */}
        {step === "confirm" && (
          <div className="p-4 w-full">
            <p className="text-sm text-gray-500 mb-4">内容を確認してください</p>
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 mb-4 w-full">
              <div className="px-4 py-3.5">
                <p className="text-xs text-gray-400">利用者</p>
                <p className="font-semibold text-gray-800 text-base mt-0.5">{selectedClient?.name}</p>
              </div>
              <div className="px-4 py-3.5">
                <p className="text-xs text-gray-400">支払区分</p>
                <p className="font-semibold text-gray-800 text-base mt-0.5">{paymentKind}</p>
              </div>
            </div>
            <div className="space-y-2 mb-6 w-full">
              {cart.map((item, idx) => {
                const supplier = suppliers.find(s => s.id === item.supplier_id);
                return (
                  <div key={idx} className="bg-white rounded-xl border border-gray-200 px-4 py-3.5">
                    <p className="font-medium text-gray-800">{item.equipment.name}</p>
                    <div className="mt-1.5 space-y-0.5">
                      <p className="text-sm text-gray-500">数量: {item.quantity}</p>
                      {item.rental_price && (
                        <p className="text-sm text-gray-500">¥{parseInt(item.rental_price).toLocaleString()}/月</p>
                      )}
                      {supplier && <p className="text-sm text-gray-500">卸: {supplier.name}</p>}
                      {item.notes && <p className="text-sm text-gray-500">備考: {item.notes}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full bg-emerald-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl text-base"
            >
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
            <button
              onClick={reset}
              className="w-full bg-emerald-500 text-white font-bold py-4 rounded-xl text-base"
            >
              続けて発注する
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
