"use client";

import { useState, useEffect, use, useRef } from "react";
import { ChevronLeft, ChevronRight, Search, Check, X, Plus, Minus, ShoppingCart } from "lucide-react";
import { supabase, Client, Equipment, Supplier } from "@/lib/supabase";
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

  const clientSearchRef = useRef<HTMLInputElement>(null);
  const equipSearchRef = useRef<HTMLInputElement>(null);

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
    <div className="min-h-screen bg-gray-50 flex flex-col max-w-lg mx-auto">
      {/* ヘッダー */}
      <div className="bg-emerald-600 text-white px-4 pt-safe-top pb-3">
        <div className="flex items-center justify-between mb-3 pt-2">
          <h1 className="text-lg font-bold">発注</h1>
          {step !== "done" && step !== "client" && (
            <button
              onClick={() => setStep(STEPS[stepIndex - 1])}
              className="flex items-center gap-1 text-emerald-100 text-sm"
            >
              <ChevronLeft size={16} /> 戻る
            </button>
          )}
        </div>
        {/* ステップインジケーター */}
        {step !== "done" && (
          <div className="flex items-center gap-1">
            {(["client", "payment", "equipment", "detail", "confirm"] as Step[]).map((s, i) => (
              <div key={s} className="flex items-center gap-1 flex-1">
                <div className={`flex-1 h-1 rounded-full transition-colors ${
                  STEPS.indexOf(step) > i ? "bg-white" :
                  step === s ? "bg-white" : "bg-emerald-400"
                }`} />
              </div>
            ))}
          </div>
        )}
        {step !== "done" && (
          <p className="text-emerald-100 text-xs mt-1">{STEP_LABELS[step]}</p>
        )}
      </div>

      {/* コンテンツ */}
      <div className="flex-1 overflow-y-auto">

        {/* Step 1: 利用者選択 */}
        {step === "client" && (
          <div className="p-4">
            <p className="text-sm text-gray-500 mb-3">発注する利用者を選択してください</p>
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={clientSearchRef}
                type="text"
                value={clientSearch}
                onChange={e => setClientSearch(e.target.value)}
                placeholder="名前・ふりがなで検索"
                className="w-full pl-9 pr-4 py-3 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-300"
                autoFocus
              />
            </div>
            <div className="space-y-2">
              {filteredClients.map(client => (
                <button
                  key={client.id}
                  onClick={() => { setSelectedClient(client); setStep("payment"); }}
                  className="w-full bg-white rounded-xl border border-gray-200 px-4 py-3.5 text-left flex items-center justify-between active:bg-emerald-50 transition-colors"
                >
                  <div>
                    <p className="font-semibold text-gray-800">{client.name}</p>
                    {client.furigana && <p className="text-xs text-gray-400">{client.furigana}</p>}
                  </div>
                  <ChevronRight size={18} className="text-gray-300" />
                </button>
              ))}
              {filteredClients.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-8">該当する利用者がいません</p>
              )}
            </div>
          </div>
        )}

        {/* Step 2: 支払区分 */}
        {step === "payment" && (
          <div className="p-4">
            <div className="bg-emerald-50 rounded-xl px-4 py-3 mb-6">
              <p className="text-xs text-gray-500">利用者</p>
              <p className="font-semibold text-gray-800">{selectedClient?.name}</p>
            </div>
            <p className="text-sm text-gray-500 mb-4">支払区分を選択してください</p>
            <div className="space-y-3">
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
                    <p className="font-bold text-gray-800 text-lg">{kind}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {kind === "介護" ? "介護保険適用" : kind === "自費" ? "全額自己負担" : "特別価格での自費"}
                    </p>
                  </div>
                  {paymentKind === kind && <Check size={22} className="text-emerald-500" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3: 用具選択 */}
        {step === "equipment" && (
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm text-gray-500">用具を選択（複数可）</p>
              {cart.length > 0 && (
                <button
                  onClick={() => setStep("detail")}
                  className="flex items-center gap-1.5 bg-emerald-500 text-white text-sm font-medium px-4 py-2 rounded-xl"
                >
                  <ShoppingCart size={15} />
                  {cart.length}件 次へ
                </button>
              )}
            </div>
            <div className="relative mb-3">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                ref={equipSearchRef}
                type="text"
                value={equipSearch}
                onChange={e => setEquipSearch(e.target.value)}
                placeholder="用具名・カテゴリで検索"
                className="w-full pl-9 pr-4 py-3 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-300"
                autoFocus
              />
            </div>
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
            <div className="space-y-2">
              {filteredEquipment.map(eq => {
                const inCart = cart.some(c => c.equipment.id === eq.id);
                return (
                  <button
                    key={eq.id}
                    onClick={() => toggleEquipment(eq)}
                    className={`w-full rounded-xl border-2 px-4 py-3 text-left flex items-center justify-between transition-all ${
                      inCart ? "border-emerald-400 bg-emerald-50" : "border-gray-200 bg-white"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-800 text-sm leading-snug">{eq.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {eq.category && <span className="text-xs text-gray-400">{eq.category}</span>}
                        {eq.rental_price && (
                          <span className="text-xs text-emerald-600 font-medium">¥{eq.rental_price.toLocaleString()}/月</span>
                        )}
                      </div>
                    </div>
                    <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 ml-2 ${
                      inCart ? "border-emerald-500 bg-emerald-500" : "border-gray-300"
                    }`}>
                      {inCart && <Check size={13} className="text-white" />}
                    </div>
                  </button>
                );
              })}
              {filteredEquipment.length === 0 && (
                <p className="text-center text-sm text-gray-400 py-8">該当する用具がありません</p>
              )}
            </div>
            {cart.length > 0 && (
              <div className="mt-4">
                <button
                  onClick={() => setStep("detail")}
                  className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-4 rounded-xl text-base transition-colors"
                >
                  次へ（{cart.length}件選択中）
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: 詳細設定 */}
        {step === "detail" && (
          <div className="p-4 space-y-4">
            <p className="text-sm text-gray-500">各用具の詳細を設定してください</p>
            {cart.map((item, idx) => (
              <div key={item.equipment.id} className="bg-white rounded-xl border border-gray-200 p-4">
                <div className="flex items-start justify-between mb-3">
                  <p className="font-semibold text-gray-800 text-sm leading-snug flex-1">{item.equipment.name}</p>
                  <button
                    onClick={() => setCart(prev => prev.filter((_, i) => i !== idx))}
                    className="text-gray-300 hover:text-red-400 ml-2"
                  >
                    <X size={18} />
                  </button>
                </div>

                {/* 数量 */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-gray-500">数量</span>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => updateCartItem(idx, { quantity: Math.max(1, item.quantity - 1) })}
                      className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center text-gray-500"
                    >
                      <Minus size={14} />
                    </button>
                    <span className="font-bold text-gray-800 w-4 text-center">{item.quantity}</span>
                    <button
                      onClick={() => updateCartItem(idx, { quantity: item.quantity + 1 })}
                      className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center text-gray-500"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>

                {/* レンタル料 */}
                <div className="mb-3">
                  <label className="text-xs text-gray-500 block mb-1">月額レンタル料（円）</label>
                  <input
                    type="number"
                    value={item.rental_price}
                    onChange={e => updateCartItem(idx, { rental_price: e.target.value })}
                    placeholder="例: 9000"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
                    inputMode="numeric"
                  />
                </div>

                {/* 卸会社 */}
                <div className="mb-3">
                  <label className="text-xs text-gray-500 block mb-1">卸会社</label>
                  <select
                    value={item.supplier_id ?? ""}
                    onChange={e => updateCartItem(idx, { supplier_id: e.target.value || null })}
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white"
                  >
                    <option value="">未設定</option>
                    {suppliers.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>

                {/* 備考 */}
                <div>
                  <label className="text-xs text-gray-500 block mb-1">備考</label>
                  <input
                    type="text"
                    value={item.notes}
                    onChange={e => updateCartItem(idx, { notes: e.target.value })}
                    placeholder="任意"
                    className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
                  />
                </div>
              </div>
            ))}

            {cart.length === 0 && (
              <div className="text-center py-8">
                <p className="text-sm text-gray-400 mb-3">用具が選択されていません</p>
                <button onClick={() => setStep("equipment")} className="text-emerald-600 text-sm font-medium">
                  用具を選ぶ
                </button>
              </div>
            )}

            {cart.length > 0 && (
              <button
                onClick={() => setStep("confirm")}
                className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-4 rounded-xl text-base transition-colors"
              >
                確認へ
              </button>
            )}
          </div>
        )}

        {/* Step 5: 確認 */}
        {step === "confirm" && (
          <div className="p-4">
            <p className="text-sm text-gray-500 mb-4">内容を確認してください</p>
            <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100 mb-4">
              <div className="px-4 py-3">
                <p className="text-xs text-gray-400">利用者</p>
                <p className="font-semibold text-gray-800 mt-0.5">{selectedClient?.name}</p>
              </div>
              <div className="px-4 py-3">
                <p className="text-xs text-gray-400">支払区分</p>
                <p className="font-semibold text-gray-800 mt-0.5">{paymentKind}</p>
              </div>
            </div>

            <div className="space-y-2 mb-6">
              {cart.map((item, idx) => {
                const supplier = suppliers.find(s => s.id === item.supplier_id);
                return (
                  <div key={idx} className="bg-white rounded-xl border border-gray-200 px-4 py-3">
                    <p className="font-medium text-gray-800 text-sm">{item.equipment.name}</p>
                    <div className="mt-1.5 space-y-0.5">
                      <p className="text-xs text-gray-500">数量: {item.quantity}</p>
                      {item.rental_price && (
                        <p className="text-xs text-gray-500">¥{parseInt(item.rental_price).toLocaleString()}/月</p>
                      )}
                      {supplier && <p className="text-xs text-gray-500">卸: {supplier.name}</p>}
                      {item.notes && <p className="text-xs text-gray-500">備考: {item.notes}</p>}
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-bold py-4 rounded-xl text-base transition-colors"
            >
              {submitting ? "発注中..." : "発注する"}
            </button>
          </div>
        )}

        {/* Step 6: 完了 */}
        {step === "done" && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
            <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-5">
              <Check size={40} className="text-emerald-500" />
            </div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">発注完了</h2>
            <p className="text-sm text-gray-500 mb-1">{selectedClient?.name}</p>
            <p className="text-sm text-gray-500 mb-8">{cart.length}件の用具を発注しました</p>
            <button
              onClick={reset}
              className="w-full bg-emerald-500 hover:bg-emerald-600 text-white font-bold py-4 rounded-xl text-base transition-colors"
            >
              続けて発注する
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
