"use client";

import { useState, useEffect } from "react";
import { Search, X, Plus, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import type { Order, OrderItem, Equipment, Client, Supplier, Member } from "@/lib/supabase";
import { matchEquipment, matchClient } from "./search-utils";
import { KANA_ROWS } from "./kana-rows";
import { createOrder, createOrderItem } from "@/lib/orders";
import { getEquipmentSetItems, getPurchasePrices, getPurchasePriceForMonth } from "@/lib/equipment";

// ─── New Order Modal ─────────────────────────────────────────────────────────

type PaymentKind = "介護" | "自費" | "特価自費";
const PAYMENT_KINDS: PaymentKind[] = ["介護", "自費", "特価自費"];

type NewOrderItem = {
  equipment: Equipment;
  rental_price: string;
  notes: string;
  payment_type: PaymentKind;
  supplier_id: string | null;
  quantity: number;
  tokka_group: string | null;
  tokka_group_price: string;
  /** セット親の product_code (構成品展開行のみ)。同 tokka_group を親 TAIS で束ねて請求 */
  tokka_bill_product_code?: string | null;
};

const TOKKA_GROUP_LETTERS = ["A", "B", "C", "D", "E", "F"];

function getNextTokkaGroup(tokkaItems: NewOrderItem[]): string {
  const used = new Set(tokkaItems.map((i) => i.tokka_group).filter(Boolean));
  return TOKKA_GROUP_LETTERS.find((l) => !used.has(l)) ?? "A";
}

// 自動グループ割り当て：特殊寝台付属品→特殊寝台グループ、車いす付属品→車いすグループ
function autoTokkaGroup(equipment: Equipment, currentTokkaItems: NewOrderItem[]): string | null {
  const cat = equipment.category ?? "";
  if (cat === "特殊寝台付属品" || cat === "床ずれ防止用具") {
    const parent = currentTokkaItems.find((i) => i.equipment.category === "特殊寝台");
    return parent?.tokka_group ?? null;
  }
  if (cat === "車いす付属品" || cat === "車椅子付属品") {
    const parent = currentTokkaItems.find(
      (i) => i.equipment.category === "車いす" || i.equipment.category === "車椅子"
    );
    return parent?.tokka_group ?? null;
  }
  if (cat === "特殊寝台") {
    const existing = currentTokkaItems.find((i) => i.equipment.category === "特殊寝台");
    return existing?.tokka_group ?? getNextTokkaGroup(currentTokkaItems);
  }
  if (cat === "車いす" || cat === "車椅子") {
    const existing = currentTokkaItems.find(
      (i) => i.equipment.category === "車いす" || i.equipment.category === "車椅子"
    );
    return existing?.tokka_group ?? getNextTokkaGroup(currentTokkaItems);
  }
  return null;
}

export default function NewOrderModal({
  tenantId,
  currentOfficeId,
  clients,
  equipment,
  suppliers,
  members,
  defaultClientId,
  onClose,
  onDone,
}: {
  tenantId: string;
  currentOfficeId: string | null;
  clients: Client[];
  equipment: Equipment[];
  suppliers: Supplier[];
  members: Member[];
  defaultClientId?: string;
  onClose: () => void;
  onDone: (order: Order, items: OrderItem[]) => void;
}) {
  const [clientId, setClientId] = useState(defaultClientId ?? "");
  const [clientSearch, setClientSearch] = useState(() => {
    if (defaultClientId) {
      return clients.find((c) => c.id === defaultClientId)?.name ?? "";
    }
    return "";
  });
  const [clientKanaFilter, setClientKanaFilter] = useState<string>("");
  const [showClientList, setShowClientList] = useState(false);
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<NewOrderItem[]>([]);
  const [showEquipModal, setShowEquipModal] = useState(false);
  const [equipModalSearch, setEquipModalSearch] = useState("");
  const [equipModalCategory, setEquipModalCategory] = useState<string | null>(null);
  const [equipModalSelected, setEquipModalSelected] = useState<{ equipment: Equipment; quantity: number }[]>([]);
  const [activeModalKind, setActiveModalKind] = useState<PaymentKind>("介護");
  // セット商品 (kind='set') 追加時の「セットのまま / 構成品に展開」選択キュー
  const [pendingSets, setPendingSets] = useState<{ equipment: Equipment; quantity: number; kind: PaymentKind }[]>([]);
  const [pendingSetLoading, setPendingSetLoading] = useState(false);

  // 新規フィールド
  const [selectedKinds, setSelectedKinds] = useState<Set<PaymentKind>>(new Set(["介護"]));
  const [deliveryDate, setDeliveryDate] = useState("");
  const [deliveryHour, setDeliveryHour] = useState("");
  const [deliveryMinute, setDeliveryMinute] = useState("");
  const deliveryTime = deliveryHour && deliveryMinute ? `${deliveryHour}:${deliveryMinute}` : "";
  const [deliveryType, setDeliveryType] = useState<"直納" | "自社納品">("直納");
  const [attendanceRequired, setAttendanceRequired] = useState(false);
  const [selectedAttendees, setSelectedAttendees] = useState<string[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");

  // 卸会社デフォルト：日本ケアサプライ
  useEffect(() => {
    if (suppliers.length > 0 && !supplierId) {
      const def = suppliers.find((s) => s.name.includes("日本ケアサプライ"));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
      if (def) setSupplierId(def.id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, [suppliers]);

  // 利用者選択時に住所を自動入力
  useEffect(() => {
    if (clientId) {
      const c = clients.find((cl) => cl.id === clientId);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
      setDeliveryAddress(c?.address ?? "");
    } else {
      setDeliveryAddress("");
    }
  }, [clientId, clients]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const FAVORITES_KEY = `equip_favorites_${tenantId}`;
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]")); } catch { return new Set(); }
  });
  const toggleFavorite = (code: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = new Set(prev);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
      next.has(code) ? next.delete(code) : next.add(code);
      localStorage.setItem(FAVORITES_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const equipCategories = Array.from(new Set(equipment.map((e) => e.category).filter(Boolean))) as string[];
  const filteredEquipModal = (() => {
    const base = equipment.filter((e) =>
      matchEquipment(e, equipModalSearch) && (equipModalCategory === null || e.category === equipModalCategory)
    );
    const favs = base.filter((e) => favorites.has(e.product_code));
    const rest = base.filter((e) => !favorites.has(e.product_code));
    return [...favs, ...rest];
  })();

  // 戻るボタンでモーダルを閉じる
  useEffect(() => {
    history.pushState(null, "", location.href);
    const handlePop = () => onClose();
    window.addEventListener("popstate", handlePop);
    return () => window.removeEventListener("popstate", handlePop);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, []);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const addItem = (eq: Equipment, kind: PaymentKind) => {
    if (items.find((i) => i.equipment.id === eq.id && i.payment_type === kind)) return;
    const currentTokka = items.filter((i) => i.payment_type === "特価自費");
    const group = kind === "特価自費" ? autoTokkaGroup(eq, currentTokka) : null;
    setItems([
      ...items,
      {
        equipment: eq,
        rental_price: eq.rental_price ? String(eq.rental_price) : "",
        notes: "",
        payment_type: kind,
        supplier_id: supplierId || null,
        quantity: 1,
        tokka_group: group,
        tokka_group_price: "",
      },
    ]);
  };

  // セット商品をセットのまま 1 行追加 (= C 単体請求、tokka_bill_product_code なし)
  const addSetAsSingleRow = (eq: Equipment, quantity: number, kind: PaymentKind) => {
    setItems((prev) => {
      if (prev.some((i) => i.equipment.product_code === eq.product_code)) return prev;
      const group = kind === "特価自費" ? autoTokkaGroup(eq, prev.filter((i) => i.payment_type === "特価自費")) : null;
      return [
        ...prev,
        {
          equipment: eq,
          rental_price: eq.rental_price != null ? String(eq.rental_price) : "",
          notes: "",
          payment_type: kind,
          supplier_id: supplierId || null,
          quantity,
          tokka_group: group,
          tokka_group_price: "",
        },
      ];
    });
  };

  // セット商品を構成品に展開して追加 (= 各構成品を明細化し、親 C の TAIS で束ねて請求)
  const expandSetToComponents = async (eq: Equipment, kind: PaymentKind) => {
    setPendingSetLoading(true);
    try {
      const bom = await getEquipmentSetItems(tenantId, eq.product_code);
      if (bom.length === 0) {
        alert(`「${eq.name}」の構成品が未登録です。セットのまま追加します。`);
        addSetAsSingleRow(eq, 1, kind);
        return;
      }
      const group = `set-${eq.product_code}-${Date.now()}`;
      const setPrice = eq.rental_price != null ? String(eq.rental_price) : "";
      const missing: string[] = [];
      const rows: NewOrderItem[] = [];
      for (const bi of bom) {
        const comp = equipment.find((e2) => e2.product_code === bi.component_product_code);
        if (!comp) {
          missing.push(bi.component_product_code);
          continue;
        }
        rows.push({
          equipment: comp,
          rental_price: comp.rental_price != null ? String(comp.rental_price) : "",
          notes: "",
          payment_type: kind,
          supplier_id: supplierId || null,
          quantity: bi.quantity,
          tokka_group: group,
          tokka_group_price: setPrice,
          tokka_bill_product_code: eq.product_code,
        });
      }
      if (rows.length === 0) {
        alert(`「${eq.name}」の構成品が用具マスタに見つかりません。セットのまま追加します。`);
        addSetAsSingleRow(eq, 1, kind);
        return;
      }
      if (missing.length > 0) {
        alert(`用具マスタに無い構成品をスキップしました: ${missing.join("、")}`);
      }
      setItems((prev) => [...prev, ...rows]);
    } catch (e) {
      console.error("セット構成の取得に失敗:", e);
      alert("セット構成の取得に失敗しました。セットのまま追加します。");
      addSetAsSingleRow(eq, 1, kind);
    } finally {
      setPendingSetLoading(false);
    }
  };

  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const updateItem = (idx: number, field: "rental_price" | "notes" | "supplier_id", value: string | null) => {
    setItems(items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const updateQuantity = (idx: number, delta: number) => {
    setItems(items.map((item, i) => i === idx ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item));
  };

  const toggleKind = (kind: PaymentKind) => {
    setSelectedKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) {
        if (next.size === 1) return prev; // 最低1つ選択
        next.delete(kind);
        setItems(cur => cur.filter(i => i.payment_type !== kind)); // その種別の用具も削除
      } else {
        next.add(kind);
      }
      return next;
    });
  };

  const toggleAttendee = (id: string) => {
    setSelectedAttendees((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  const handleConfirm = () => {
    if (!clientId) {
      setError("利用者を選択してください");
      return;
    }
    if (items.length === 0) {
      setError("用具を1つ以上選択してください");
      return;
    }
    setError("");
    setShowConfirm(true);
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError("");
    try {
      // 利用者の office を優先 (発注は利用者と同じ office に紐付くべき)、
      // 利用者未指定なら currentOfficeId を fallback
      const clientOffice = clientId ? clients.find((c) => c.id === clientId)?.office_id ?? null : null;
      const order = await createOrder({
        tenantId,
        officeId: clientOffice ?? currentOfficeId,
        clientId: clientId || undefined,
        notes: notes || undefined,
        paymentType: Array.from(selectedKinds)[0],
        deliveryDate: deliveryDate || undefined,
        deliveryTime: deliveryTime || undefined,
        deliveryAddress: deliveryAddress || undefined,
        deliveryType,
        attendanceRequired,
        attendeeIds: selectedAttendees,
        supplierId: supplierId || undefined,
      });
      // 仕入価格を発注時点でスナップショット (卸別・月次カタログから。実効卸 = 明細 or ヘッダー)
      const snapCodes = [...new Set(items.map((i) => i.equipment.product_code))];
      const snapRows = await getPurchasePrices(tenantId, snapCodes).catch(() => []);
      const snapYM = new Date().toISOString().slice(0, 7);
      // グループ代表判定（グループ内で最初に現れたアイテムが代表）
      const seenGroupsSubmit = new Set<string>();
      const createdItems: OrderItem[] = [];
      for (const item of items) {
        const isGroupRep = item.tokka_group !== null && !seenGroupsSubmit.has(item.tokka_group);
        if (item.tokka_group) seenGroupsSubmit.add(item.tokka_group);
        const tokkaGroupPrice = isGroupRep && item.tokka_group_price ? parseInt(item.tokka_group_price, 10) : undefined;
        const rentalPrice = item.payment_type !== "特価自費" && item.rental_price ? parseFloat(item.rental_price) : undefined;
        const effSupplier = item.supplier_id || supplierId || null;
        const purchasePrice = effSupplier
          ? getPurchasePriceForMonth(snapRows, item.equipment.product_code, effSupplier, snapYM) ?? undefined
          : undefined;
        const oi = await createOrderItem({
          orderId: order.id,
          tenantId,
          productCode: item.equipment.product_code,
          supplierId: item.supplier_id || undefined,
          purchasePrice,
          rentalPrice,
          notes: item.notes || undefined,
          paymentType: item.payment_type,
          quantity: item.quantity,
          tokkaGroup: item.tokka_group ?? undefined,
          tokkaGroupPrice,
          tokkaBillProductCode: item.tokka_bill_product_code ?? undefined,
        });
        createdItems.push(oi);
      }
      onDone(order, createdItems);
    } catch {
      setError("発注の作成に失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end z-50">
      <div className="bg-white w-full rounded-t-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <h3 className="font-semibold text-gray-800">新規発注</h3>
          <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">

          {/* ── 基本情報 ── */}
          <div className="bg-gray-50 rounded-2xl p-3 space-y-3">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">基本情報</p>

            {/* 種別 + 卸会社 + 納品方法 横並び */}
            <div className="flex gap-2 items-end flex-wrap">
              {/* 介護 / 自費 / 特価自費（複数選択可） */}
              <div className="shrink-0">
                <label className="text-xs font-medium text-gray-600 block mb-1.5">種別 <span className="text-gray-400 font-normal">（複数選択可）</span></label>
                <div className="flex gap-1.5">
                  {PAYMENT_KINDS.map((t) => (
                    <button
                      key={t}
                      onClick={() => toggleKind(t)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                        selectedKinds.has(t)
                          ? "bg-emerald-500 text-white border-emerald-500"
                          : "bg-white text-gray-600 border-gray-200"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {/* 卸会社 */}
              <div className="shrink-0">
                <label className="text-xs font-medium text-gray-600 block mb-1.5">卸会社</label>
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm font-medium outline-none focus:border-emerald-400 bg-white text-gray-600 h-[38px]"
                >
                  <option value="">選択しない</option>
                  {suppliers.filter((s) => s.is_active !== false).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              {/* 納品方法 */}
              <div className="shrink-0">
                <label className="text-xs font-medium text-gray-600 block mb-1.5">納品方法</label>
                <div className="flex gap-1.5">
                  {(["自社納品", "直納"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => { setDeliveryType(t); if (t === "自社納品") { setAttendanceRequired(false); setSelectedAttendees([]); } }}
                      className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                        deliveryType === t
                          ? "bg-emerald-500 text-white border-emerald-500"
                          : "bg-white text-gray-600 border-gray-200"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              {/* 立ち会い（直納のみ） */}
              {deliveryType === "直納" && (
                <div className="shrink-0">
                  <label className="text-xs font-medium text-gray-600 block mb-1.5">立ち会い</label>
                  <div className="flex gap-1.5">
                    {([false, true] as const).map((v) => (
                      <button
                        key={String(v)}
                        onClick={() => { setAttendanceRequired(v); if (!v) setSelectedAttendees([]); }}
                        className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
                          attendanceRequired === v
                            ? "bg-emerald-500 text-white border-emerald-500"
                            : "bg-white text-gray-600 border-gray-200"
                        }`}
                      >
                        {v ? "あり" : "なし"}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* 立ち合い者（直納かつ立ち会いありのみ） */}
              {deliveryType === "直納" && attendanceRequired && (
                <div className="shrink-0">
                  <label className="text-xs font-medium text-gray-600 block mb-1.5">立ち合い者</label>
                  <div className="flex flex-wrap gap-1.5">
                    {members.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => toggleAttendee(m.id)}
                        className={`flex items-center gap-1 px-3 py-2 rounded-xl text-sm font-medium border transition-colors ${
                          selectedAttendees.includes(m.id)
                            ? "text-white border-transparent"
                            : "bg-white text-gray-600 border-gray-200"
                        }`}
                        style={selectedAttendees.includes(m.id) ? { backgroundColor: m.color, borderColor: m.color } : {}}
                      >
                        {m.name}
                        {selectedAttendees.includes(m.id) && <CheckCircle2 size={12} />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 利用者 */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">利用者 <span className="text-red-400">*必須</span></label>
              {clientId && !showClientList ? (
                <div className="flex items-center justify-between border border-emerald-300 bg-emerald-50 rounded-xl px-3 py-2">
                  <button
                    onClick={() => { setClientSearch(""); setShowClientList(true); }}
                    className="text-sm font-medium text-emerald-800 flex-1 text-left"
                  >
                    {clients.find((c) => c.id === clientId)?.name ?? ""}
                  </button>
                  <button onClick={() => { setClientId(""); setClientSearch(""); setShowClientList(false); }} className="text-emerald-400 hover:text-red-400 ml-2">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div>
                  <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2 bg-white">
                    <Search size={14} className="text-gray-400 shrink-0" />
                    <input
                      value={clientSearch}
                      onChange={(e) => { setClientSearch(e.target.value); setShowClientList(true); }}
                      onFocus={() => setShowClientList(true)}
                      placeholder="名前・かな・カナで検索"
                      className="flex-1 text-sm outline-none bg-transparent"
                    />
                    {clientSearch && <button onClick={() => setClientSearch("")}><X size={14} className="text-gray-400" /></button>}
                  </div>
                  {/* かな行フィルター (検索と併用可) */}
                  <div className="flex gap-1 mt-1.5 overflow-x-auto">
                    <button
                      onClick={() => { setClientKanaFilter(""); setShowClientList(true); }}
                      className={`shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${!clientKanaFilter ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
                    >
                      全
                    </button>
                    {KANA_ROWS.map((row) => (
                      <button
                        key={row.label}
                        onClick={() => { setClientKanaFilter(clientKanaFilter === row.label ? "" : row.label); setShowClientList(true); }}
                        className={`shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${clientKanaFilter === row.label ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
                      >
                        {row.label}
                      </button>
                    ))}
                  </div>
                  {showClientList && (
                    <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden max-h-40 overflow-y-auto bg-white">
                      <button
                        onClick={() => { setClientId(""); setShowClientList(false); setClientSearch(""); }}
                        className="w-full px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50 border-b border-gray-50"
                      >
                        選択しない
                      </button>
                      {clients
                        .filter((c) => {
                          if (!matchClient(c, clientSearch)) return false;
                          if (clientKanaFilter) {
                            const row = KANA_ROWS.find((r) => r.label === clientKanaFilter);
                            if (row) {
                              const first = (c.furigana ?? c.name ?? "").charAt(0);
                              const firstKata = first.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
                              if (!row.chars.includes(firstKata)) return false;
                            }
                          }
                          return true;
                        })
                        .sort((a, b) => {
                          const fa = a.is_facility ? 1 : 0;
                          const fb = b.is_facility ? 1 : 0;
                          if (fa !== fb) return fa - fb;
                          return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
                        })
                        .slice(0, 50).map((c) => (
                        <button
                          key={c.id}
                          onClick={() => { setClientId(c.id); setShowClientList(false); setClientSearch(""); }}
                          className="w-full px-3 py-2 text-left hover:bg-emerald-50 transition-colors border-b border-gray-50 last:border-0"
                        >
                          <p className="text-sm font-medium text-gray-800">{c.name}</p>
                          {c.furigana && <p className="text-xs text-gray-400">{c.furigana}</p>}
                        </button>
                      ))}
                      {clients.filter((c) => matchClient(c, clientSearch)).length === 0 && (
                        <p className="text-xs text-gray-400 px-3 py-2">該当なし</p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── 納品情報 ── */}
          <div className="bg-gray-50 rounded-2xl p-3 space-y-3">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">納品情報</p>

            {/* 納品先住所 */}
            {clientId && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-gray-600">納品先住所</label>
                  <button
                    onClick={() => {
                      const c = clients.find((cl) => cl.id === clientId);
                      setDeliveryAddress(c?.address ?? "");
                    }}
                    className="text-[11px] text-emerald-600 hover:underline"
                  >
                    利用者住所に戻す
                  </button>
                </div>
                <input
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  placeholder="納品先住所"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400 bg-white"
                />
              </div>
            )}

            {/* 納品予定日・時間 */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">納品予定日・時間</label>
              <div className="flex gap-2 items-center">
                <input
                  type="date"
                  value={deliveryDate}
                  onChange={(e) => setDeliveryDate(e.target.value)}
                  className="w-40 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400 bg-white"
                />
                <select
                  value={deliveryHour}
                  onChange={(e) => setDeliveryHour(e.target.value)}
                  className="w-16 border border-gray-200 rounded-xl px-2 py-2 text-sm outline-none focus:border-emerald-400 bg-white"
                >
                  <option value="">時</option>
                  {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span className="text-gray-400 text-sm font-medium">:</span>
                <select
                  value={deliveryMinute}
                  onChange={(e) => setDeliveryMinute(e.target.value)}
                  className="w-16 border border-gray-200 rounded-xl px-2 py-2 text-sm outline-none focus:border-emerald-400 bg-white"
                >
                  <option value="">分</option>
                  {["00","05","10","15","20","25","30","35","40","45","50","55"].map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            </div>

          </div>{/* ── 納品情報 セクション終わり ── */}

          {/* ── 発注用具 ── */}
          <div className="bg-gray-50 rounded-2xl p-3 space-y-3">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">発注用具</p>

            {/* 備考 */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">備考</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="備考・メモ"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400 bg-white"
              />
            </div>

            {/* 種別ごとの用具セクション */}
            {equipment.length === 0 && (
              <p className="text-xs text-amber-500 px-1">用具マスタにデータがありません。先にCSVインポートしてください。</p>
            )}
            {PAYMENT_KINDS.filter(k => selectedKinds.has(k)).map(kind => {
              const kindItems = items.map((item, idx) => ({ item, idx })).filter(({ item }) => item.payment_type === kind);
              const kindColor = kind === "介護" ? "emerald" : kind === "自費" ? "blue" : "amber";
              const colorCls = {
                emerald: { border: "border-emerald-200", bg: "bg-emerald-50", text: "text-emerald-700", btn: "border-emerald-300 text-emerald-700 bg-emerald-50 hover:bg-emerald-100", badge: "bg-emerald-500" },
                blue:    { border: "border-blue-200",    bg: "bg-blue-50",    text: "text-blue-700",    btn: "border-blue-300 text-blue-700 bg-blue-50 hover:bg-blue-100",       badge: "bg-blue-500" },
                amber:   { border: "border-amber-200",   bg: "bg-amber-50",   text: "text-amber-700",   btn: "border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100",    badge: "bg-amber-500" },
              }[kindColor];
              return (
                <div key={kind} className={`border ${colorCls.border} rounded-xl overflow-hidden`}>
                  <div className={`flex items-center gap-2 px-3 py-2 border-b ${colorCls.border} ${colorCls.bg}`}>
                    <span className={`text-xs font-semibold ${colorCls.text}`}>{kind}</span>
                    {kindItems.length > 0 && <span className={`${colorCls.badge} text-white text-[10px] font-bold px-2 py-0.5 rounded-full`}>{kindItems.length}件</span>}
                  </div>
                  <div className="p-2 space-y-2">
                    <button
                      onClick={() => { setActiveModalKind(kind); setShowEquipModal(true); setEquipModalSearch(""); setEquipModalCategory(null); setEquipModalSelected([]); }}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-sm font-medium transition-colors ${colorCls.btn}`}
                    >
                      <Plus size={14} />
                      {kind}の用具を追加
                    </button>
                    {kindItems.length > 0 && (
                      <table className="w-full table-fixed text-left">
                        <thead className="bg-gray-50 border-b border-gray-100">
                          <tr>
                            <th className="pl-3 py-1.5 text-[10px] font-semibold text-gray-400">用具名</th>
                            <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[5rem]">個数</th>
                            {kind !== "特価自費" && <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[6.5rem]">卸会社</th>}
                            {kind === "特価自費"
                              ? <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[4rem]">グループ</th>
                              : null}
                            <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[5.5rem]">{kind === "特価自費" ? "グループ価格" : "価格(円/月)"}</th>
                            <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[5rem]">備考</th>
                            <th className="w-7"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {(() => {
                            const seenGroups = new Set<string>();
                            return kindItems.map(({ item, idx }) => {
                              const isGroupRep = item.tokka_group !== null && !seenGroups.has(item.tokka_group);
                              if (item.tokka_group) seenGroups.add(item.tokka_group);
                              const showPrice = kind !== "特価自費" || item.tokka_group === null || isGroupRep;
                              return (
                            <tr key={idx}>
                              <td className="pl-3 py-2 max-w-0">
                                <p className="text-xs font-semibold text-gray-800 truncate">{item.equipment.name}</p>
                                <p className="text-[10px] text-gray-400">{item.equipment.product_code}</p>
                                {item.tokka_bill_product_code && (
                                  <p className="text-[10px] text-indigo-500 font-medium truncate">
                                    セット請求: {equipment.find((e2) => e2.product_code === item.tokka_bill_product_code)?.name ?? item.tokka_bill_product_code}
                                  </p>
                                )}
                              </td>
                              <td className="py-2 px-1 w-[5rem]">
                                <div className="flex items-center gap-0.5">
                                  <button onClick={() => updateQuantity(idx, -1)} className="w-5 h-5 rounded-full bg-gray-100 text-gray-600 text-xs font-bold flex items-center justify-center hover:bg-gray-200">−</button>
                                  <span className="w-5 text-center text-xs font-semibold text-gray-800">{item.quantity}</span>
                                  <button onClick={() => updateQuantity(idx, 1)} className="w-5 h-5 rounded-full bg-gray-100 text-gray-600 text-xs font-bold flex items-center justify-center hover:bg-gray-200">＋</button>
                                </div>
                              </td>
                              {kind !== "特価自費" && (
                              <td className="py-2 px-1 w-[6.5rem]">
                                <select
                                  value={item.supplier_id ?? ""}
                                  onChange={(e) => updateItem(idx, "supplier_id", e.target.value || null)}
                                  className="w-full border border-gray-200 rounded-lg px-1.5 py-1 text-[11px] outline-none focus:border-emerald-400 bg-white text-gray-600"
                                >
                                  <option value="">なし</option>
                                  {suppliers.filter((s) => s.is_active !== false).map((s) => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                  ))}
                                </select>
                              </td>
                              )}
                              {kind === "特価自費" && (
                              <td className="py-2 px-1 w-[4rem]">
                                {item.tokka_bill_product_code ? (
                                  <span className="text-[10px] text-indigo-500 font-semibold px-1">セット</span>
                                ) : (
                                <select
                                  value={item.tokka_group ?? ""}
                                  onChange={(e) => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, tokka_group: e.target.value || null } : it))}
                                  className="w-full border border-amber-200 rounded-lg px-1 py-1 text-[11px] outline-none focus:border-amber-400 bg-white text-amber-700 font-semibold"
                                >
                                  <option value="">なし</option>
                                  {TOKKA_GROUP_LETTERS.map((g) => (
                                    <option key={g} value={g}>{g}</option>
                                  ))}
                                </select>
                                )}
                              </td>
                              )}
                              <td className="py-2 px-1 w-[5.5rem]">
                                {showPrice ? (
                                <input
                                  value={kind === "特価自費" && item.tokka_group !== null ? item.tokka_group_price : item.rental_price}
                                  onChange={(e) => {
                                    if (kind === "特価自費" && item.tokka_group !== null) {
                                      // グループ内全アイテムのtokka_group_priceを更新（代表のみ実際に使うが同期）
                                      setItems((prev) => prev.map((it, i) => i === idx ? { ...it, tokka_group_price: e.target.value } : it));
                                    } else {
                                      updateItem(idx, "rental_price", e.target.value);
                                    }
                                  }}
                                  placeholder="—"
                                  type="number"
                                  className="w-full border border-gray-200 rounded-lg px-1.5 py-1 text-[11px] outline-none focus:border-emerald-400 bg-white"
                                />
                                ) : (
                                  <span className="text-[10px] text-amber-500 px-1">グループ内</span>
                                )}
                              </td>
                              <td className="py-2 px-1 w-[5rem]">
                                <input
                                  value={item.notes}
                                  onChange={(e) => updateItem(idx, "notes", e.target.value)}
                                  placeholder="—"
                                  className="w-full border border-gray-200 rounded-lg px-1.5 py-1 text-[11px] outline-none focus:border-emerald-400 bg-white"
                                />
                              </td>
                              <td className="py-2 pr-2 w-7 text-right">
                                <button onClick={() => removeItem(idx)} className="text-gray-300 hover:text-red-400 transition-colors">
                                  <X size={14} />
                                </button>
                              </td>
                            </tr>
                              );
                            });
                          })()}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              );
            })}

          </div>{/* ── 発注用具 セクション終わり ── */}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </div>

        <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0">
          <button
            onClick={handleConfirm}
            disabled={items.length === 0}
            className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm disabled:opacity-40 flex items-center justify-center gap-2"
          >
            <CheckCircle2 size={16} />
            確認画面へ
          </button>
        </div>
      </div>

      {/* ── 用具選択モーダル ── */}
      {showEquipModal && (
        <div className="fixed inset-0 bg-black/60 flex items-end z-[60]">
          <div className="bg-white w-full rounded-t-2xl h-screen flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
              <h3 className="font-semibold text-gray-800">用具を選択</h3>
              <button onClick={() => setShowEquipModal(false)}><X size={20} className="text-gray-400" /></button>
            </div>

            {/* 検索 + 種目フィルター */}
            <div className="px-4 pt-3 pb-2 shrink-0 space-y-2">
              <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2 bg-gray-50">
                <Search size={14} className="text-gray-400 shrink-0" />
                <input
                  autoFocus
                  value={equipModalSearch}
                  onChange={(e) => setEquipModalSearch(e.target.value)}
                  placeholder="商品名・商品コードで検索"
                  className="flex-1 text-sm outline-none bg-transparent"
                />
                {equipModalSearch && (
                  <button onClick={() => setEquipModalSearch("")}><X size={14} className="text-gray-400" /></button>
                )}
              </div>
              {equipCategories.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    onClick={() => setEquipModalCategory(null)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
                      equipModalCategory === null
                        ? "bg-emerald-500 text-white border-emerald-500"
                        : "bg-white text-gray-500 border-gray-200"
                    }`}
                  >
                    全種目
                  </button>
                  {equipCategories.map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setEquipModalCategory(equipModalCategory === cat ? null : cat)}
                      className={`text-[11px] px-2.5 py-1 rounded-full border font-medium transition-colors ${
                        equipModalCategory === cat
                          ? "bg-emerald-500 text-white border-emerald-500"
                          : "bg-white text-gray-500 border-gray-200"
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 候補リスト */}
            <div className="flex-1 overflow-y-auto pb-2">
              {filteredEquipModal.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">
                  {equipModalSearch ? "該当する用具がありません" : "用具マスタにデータがありません"}
                </p>
              ) : (
                <table className="w-full table-fixed text-left">
                  <thead className="bg-gray-50 border-y border-gray-100 sticky top-0">
                    <tr>
                      <th className="w-8"></th>
                      <th className="pl-1 py-1.5 text-[10px] font-semibold text-gray-400 w-[4.5rem]">種目</th>
                      <th className="py-1.5 px-2 text-[10px] font-semibold text-gray-400">用具名・価格</th>
                      <th className="py-1.5 px-2 text-[10px] font-semibold text-gray-400 w-[5.5rem]">コード</th>
                      <th className="w-[7.5rem]"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredEquipModal.slice(0, 2000).map((eq) => {
                      const sel = equipModalSelected.find((s) => s.equipment.product_code === eq.product_code);
                      const isFav = favorites.has(eq.product_code);
                      return (
                        <tr
                          key={eq.product_code}
                          onClick={() => setEquipModalSelected((prev) =>
                            sel ? prev.filter((s) => s.equipment.product_code !== eq.product_code) : [...prev, { equipment: eq, quantity: 1 }]
                          )}
                          className={`cursor-pointer transition-colors ${sel ? "bg-emerald-50" : isFav ? "bg-amber-50/40" : "hover:bg-gray-50"}`}
                        >
                          <td className="w-8 pl-2 py-2 text-center">
                            <button
                              onClick={(e) => toggleFavorite(eq.product_code, e)}
                              className={`text-lg leading-none transition-colors ${isFav ? "text-amber-400" : "text-gray-200 hover:text-amber-300"}`}
                            >
                              ★
                            </button>
                          </td>
                          <td className="pl-1 py-2 w-[4.5rem]">
                            {eq.category && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">
                                {eq.category}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 max-w-0">
                            <p className={`text-sm font-medium truncate ${sel ? "text-emerald-800" : "text-gray-800"}`}>{eq.name}</p>
                            {eq.rental_price ? (
                              <p className="text-[11px] text-emerald-600 font-semibold">¥{eq.rental_price.toLocaleString()}/月</p>
                            ) : null}
                          </td>
                          <td className="py-2 px-2 text-[11px] text-gray-400 w-[5.5rem] whitespace-nowrap">{eq.product_code}</td>
                          {/* 個数 or チェック */}
                          <td className="py-2 pr-2 w-[7.5rem] text-right" onClick={(e) => e.stopPropagation()}>
                            {sel ? (
                              <div className="flex items-center justify-end gap-1">
                                <button
                                  onClick={() => setEquipModalSelected((prev) =>
                                    sel.quantity <= 1
                                      ? prev.filter((s) => s.equipment.product_code !== eq.product_code)
                                      : prev.map((s) => s.equipment.product_code === eq.product_code ? { ...s, quantity: s.quantity - 1 } : s)
                                  )}
                                  className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-sm font-bold flex items-center justify-center hover:bg-emerald-200"
                                >
                                  −
                                </button>
                                <span className="w-5 text-center text-sm font-semibold text-emerald-700">{sel.quantity}</span>
                                <button
                                  onClick={() => setEquipModalSelected((prev) =>
                                    prev.map((s) => s.equipment.product_code === eq.product_code ? { ...s, quantity: s.quantity + 1 } : s)
                                  )}
                                  className="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 text-sm font-bold flex items-center justify-center hover:bg-emerald-200"
                                >
                                  ＋
                                </button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* 追加ボタン */}
            <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0">
              {equipModalSelected.length > 0 && (
                <p className="text-xs text-emerald-600 font-medium mb-2">
                  {equipModalSelected.length}種類（計{equipModalSelected.reduce((s, x) => s + x.quantity, 0)}個）選択中
                </p>
              )}
              <button
                disabled={equipModalSelected.length === 0}
                onClick={() => {
                  const kind = activeModalKind;
                  // セット商品 (kind='set') は「セットのまま / 構成品に展開」の選択キューに回す
                  const sets = equipModalSelected.filter(
                    (sel) => sel.equipment.kind === "set" && !items.some((it) => it.equipment.product_code === sel.equipment.product_code)
                  );
                  setItems((prev) => {
                    const toAdd = equipModalSelected.filter(
                      (sel) => sel.equipment.kind !== "set" && !prev.some((it) => it.equipment.product_code === sel.equipment.product_code)
                    );
                    const newItems: NewOrderItem[] = [];
                    for (const sel of toAdd) {
                      const currentTokka = [
                        ...prev.filter((i) => i.payment_type === "特価自費"),
                        ...newItems.filter((i) => i.payment_type === "特価自費"),
                      ];
                      const group = kind === "特価自費" ? autoTokkaGroup(sel.equipment, currentTokka) : null;
                      newItems.push({
                        equipment: sel.equipment,
                        rental_price: sel.equipment.rental_price != null ? String(sel.equipment.rental_price) : "",
                        notes: "",
                        payment_type: kind,
                        supplier_id: supplierId || null,
                        quantity: sel.quantity,
                        tokka_group: group,
                        tokka_group_price: "",
                      });
                    }
                    return [...prev, ...newItems];
                  });
                  if (sets.length > 0) {
                    setPendingSets(sets.map((sel) => ({ equipment: sel.equipment, quantity: sel.quantity, kind })));
                  }
                  setShowEquipModal(false);
                }}
                className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm disabled:opacity-40 flex items-center justify-center gap-2"
              >
                <Plus size={16} />
                {equipModalSelected.length > 0
                  ? `${equipModalSelected.length}種類を追加する`
                  : "用具を選択してください"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── セット商品 追加方法の選択 ── */}
      {pendingSets.length > 0 && (() => {
        const ps = pendingSets[0];
        const advance = () => setPendingSets((prev) => prev.slice(1));
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[80] px-4">
            <div className="bg-white w-full max-w-sm rounded-2xl shadow-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <h3 className="font-semibold text-gray-800 text-sm">セット商品の追加方法</h3>
              </div>
              <div className="p-4 space-y-2">
                <p className="text-xs text-gray-600 mb-3">
                  「<span className="font-semibold text-gray-800">{ps.equipment.name}</span>」はセット商品です。追加方法を選択してください。
                </p>
                <button
                  disabled={pendingSetLoading}
                  onClick={() => { addSetAsSingleRow(ps.equipment, ps.quantity, ps.kind); advance(); }}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-left hover:bg-gray-50 transition-colors disabled:opacity-40"
                >
                  <p className="text-sm font-medium text-gray-800">セットのまま追加</p>
                  <p className="text-[11px] text-gray-400">1 明細として追加（セット商品の TAIS で請求）</p>
                </button>
                <button
                  disabled={pendingSetLoading}
                  onClick={async () => { await expandSetToComponents(ps.equipment, ps.kind); advance(); }}
                  className="w-full border border-indigo-200 bg-indigo-50 rounded-xl px-3 py-2.5 text-left hover:bg-indigo-100 transition-colors disabled:opacity-40"
                >
                  <p className="text-sm font-medium text-indigo-700">{pendingSetLoading ? "構成品を取得中…" : "構成品に展開"}</p>
                  <p className="text-[11px] text-indigo-400">構成品ごとに明細化し、セット商品の TAIS で束ねて請求</p>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── 確認画面 ── */}
      {showConfirm && (() => {
        const clientObj = clients.find((c) => c.id === clientId);
        const supplierObj = suppliers.find((s) => s.id === supplierId);
        const warnings: string[] = [];
        if (!deliveryDate) warnings.push("納品予定日が未入力です");
        if (!deliveryTime) warnings.push("納品時間が未入力です");
        if (!supplierId) warnings.push("卸会社が未選択です");
        // 特価自費：グループ代表の価格チェック
        const tokkaGroupsWithPrice = new Set(
          items.filter((i) => i.payment_type === "特価自費" && i.tokka_group && i.tokka_group_price).map((i) => i.tokka_group)
        );
        const noPriceItems = items.filter((i) => {
          if (i.payment_type === "特価自費") {
            if (i.tokka_group === null) return !i.rental_price || parseFloat(i.rental_price) === 0;
            // グループ内で代表アイテムが価格を持っているか
            return !tokkaGroupsWithPrice.has(i.tokka_group);
          }
          return !i.rental_price || parseFloat(i.rental_price) === 0;
        });
        // 重複除去（グループは1回だけ警告）
        const noPriceNames = Array.from(new Set(noPriceItems.map((i) =>
          i.payment_type === "特価自費" && i.tokka_group ? `グループ${i.tokka_group}` : i.equipment.name
        )));
        if (noPriceNames.length > 0)
          warnings.push(`価格未入力の用具があります：${noPriceNames.join("、")}`);

        return (
          <div className="fixed inset-0 bg-black/60 flex items-end z-[70]">
            <div className="bg-white w-full rounded-t-2xl max-h-[88vh] flex flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
                <h3 className="font-semibold text-gray-800">発注内容の確認</h3>
                <button onClick={() => setShowConfirm(false)}><X size={20} className="text-gray-400" /></button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {/* 警告 */}
                {warnings.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 space-y-1">
                    <p className="text-xs font-semibold text-amber-700 flex items-center gap-1">
                      <AlertCircle size={13} /> 未入力の項目があります（登録は可能です）
                    </p>
                    {warnings.map((w, i) => (
                      <p key={i} className="text-xs text-amber-600 pl-4">・{w}</p>
                    ))}
                  </div>
                )}

                {/* 基本情報 */}
                <div className="bg-gray-50 rounded-xl p-3 space-y-1.5">
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">基本情報</p>
                  <Row label="利用者" value={clientObj?.name ?? "—"} />
                  <Row label="種別" value={Array.from(selectedKinds).join("・")} />
                  <Row label="卸会社" value={supplierObj?.name ?? "未選択"} warn={!supplierId} />
                  <Row label="納品方法" value={deliveryType} />
                  {deliveryAddress && <Row label="納品先住所" value={deliveryAddress} />}
                  <Row label="納品予定日" value={deliveryDate ? new Date(deliveryDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" }) : "未入力"} warn={!deliveryDate} />
                  <Row label="納品時間" value={deliveryTime || "未入力"} warn={!deliveryTime} />
                  {deliveryType === "直納" && (
                    <Row label="立ち会い" value={attendanceRequired ? `あり（${selectedAttendees.map((id) => members.find((m) => m.id === id)?.name ?? id).join("・")}）` : "なし"} />
                  )}
                  {notes && <Row label="備考" value={notes} />}
                </div>

                {/* 用具（種別ごとに分割） */}
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-1">発注用具（{items.length}件）</p>
                  {PAYMENT_KINDS.filter(k => selectedKinds.has(k)).map(kind => {
                    const kindItems = items.filter(item => item.payment_type === kind);
                    if (kindItems.length === 0) return null;
                    const kindColor = kind === "介護" ? "emerald" : kind === "自費" ? "blue" : "amber";
                    const colorCls = {
                      emerald: { border: "border-emerald-200", bg: "bg-emerald-50", text: "text-emerald-700", price: "text-emerald-600", subtotal: "text-emerald-700 bg-emerald-50" },
                      blue:    { border: "border-blue-200",    bg: "bg-blue-50",    text: "text-blue-700",    price: "text-blue-600",    subtotal: "text-blue-700 bg-blue-50" },
                      amber:   { border: "border-amber-200",   bg: "bg-amber-50",   text: "text-amber-700",   price: "text-amber-600",   subtotal: "text-amber-700 bg-amber-50" },
                    }[kindColor];
                    const isTokka = kind === "特価自費";

                    // 特価自費：グループ化して表示
                    if (isTokka) {
                      const groups: Record<string, { items: NewOrderItem[]; price: number }> = {};
                      const ungrouped: NewOrderItem[] = [];
                      for (const item of kindItems) {
                        if (item.tokka_group) {
                          if (!groups[item.tokka_group]) groups[item.tokka_group] = { items: [], price: 0 };
                          groups[item.tokka_group].items.push(item);
                          if (item.tokka_group_price) groups[item.tokka_group].price = parseInt(item.tokka_group_price, 10);
                        } else {
                          ungrouped.push(item);
                        }
                      }
                      const tokkaTotal =
                        Object.values(groups).reduce((s, g) => s + g.price, 0) +
                        ungrouped.reduce((s, item) => s + (item.rental_price ? parseFloat(item.rental_price) : 0) * item.quantity, 0);
                      return (
                        <div key={kind} className={`border ${colorCls.border} rounded-xl overflow-hidden`}>
                          <div className={`px-3 py-1.5 ${colorCls.bg} border-b ${colorCls.border}`}>
                            <span className={`text-xs font-semibold ${colorCls.text}`}>{kind}</span>
                          </div>
                          <div className="bg-white divide-y divide-gray-100">
                            {Object.entries(groups).map(([letter, g]) => (
                              <div key={letter} className="px-3 py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="flex-1 min-w-0">
                                    <span className="text-[10px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded mr-1">グループ{letter}</span>
                                    <span className="text-xs text-gray-500">{g.items.map((it) => it.equipment.name).join(" / ")}</span>
                                  </div>
                                  <p className={`text-sm font-semibold shrink-0 ${g.price > 0 ? colorCls.price : "text-amber-500"}`}>
                                    {g.price > 0 ? `¥${g.price.toLocaleString()}/月` : "価格未入力"}
                                  </p>
                                </div>
                              </div>
                            ))}
                            {ungrouped.map((item, i) => {
                              const price = item.rental_price ? parseFloat(item.rental_price) : null;
                              return (
                                <div key={i} className="flex items-start justify-between gap-2 py-2 px-3">
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-gray-800 truncate">{item.equipment.name}</p>
                                    <p className="text-[10px] text-gray-400">{item.equipment.product_code}{item.quantity > 1 ? `　×${item.quantity}` : ""}</p>
                                  </div>
                                  <p className={`text-sm font-semibold shrink-0 ${price ? colorCls.price : "text-amber-500"}`}>
                                    {price ? `¥${price.toLocaleString()}/月` : "価格未入力"}
                                  </p>
                                </div>
                              );
                            })}
                          </div>
                          {tokkaTotal > 0 && (
                            <div className={`flex justify-between items-center px-3 py-1.5 border-t ${colorCls.border} ${colorCls.subtotal}`}>
                              <span className="text-[11px] font-semibold">{kind}合計</span>
                              <span className="text-sm font-bold">¥{tokkaTotal.toLocaleString()}/月</span>
                            </div>
                          )}
                        </div>
                      );
                    }

                    const kindTotal = kindItems.reduce((sum, item) => {
                      return sum + (item.rental_price ? parseFloat(item.rental_price) : 0) * item.quantity;
                    }, 0);
                    return (
                      <div key={kind} className={`border ${colorCls.border} rounded-xl overflow-hidden`}>
                        <div className={`px-3 py-1.5 ${colorCls.bg} border-b ${colorCls.border}`}>
                          <span className={`text-xs font-semibold ${colorCls.text}`}>{kind}</span>
                        </div>
                        <div className="bg-white px-3 divide-y divide-gray-100">
                          {kindItems.map((item, i) => {
                            const price = item.rental_price ? parseFloat(item.rental_price) : null;
                            const itemSupplier = suppliers.find((s) => s.id === item.supplier_id);
                            return (
                              <div key={i} className="flex items-start justify-between gap-2 py-2">
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-gray-800 truncate">{item.equipment.name}</p>
                                  <p className="text-[10px] text-gray-400">{item.equipment.product_code}{itemSupplier ? `　${itemSupplier.name}` : ""}{item.quantity > 1 ? `　×${item.quantity}` : ""}</p>
                                </div>
                                <p className={`text-sm font-semibold shrink-0 ${price ? colorCls.price : "text-amber-500"}`}>
                                  {price ? `¥${price.toLocaleString()}/月` : "価格未入力"}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                        {kindTotal > 0 && (
                          <div className={`flex justify-between items-center px-3 py-1.5 border-t ${colorCls.border} ${colorCls.subtotal}`}>
                            <span className="text-[11px] font-semibold">{kind}合計</span>
                            <span className="text-sm font-bold">¥{kindTotal.toLocaleString()}/月</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {(() => {
                    // 特価自費：グループ代表の価格を使用、グループなしは個別価格
                    const seenGroupsTotal = new Set<string>();
                    const total = items.reduce((sum, item) => {
                      if (item.payment_type === "特価自費") {
                        if (item.tokka_group) {
                          if (!seenGroupsTotal.has(item.tokka_group)) {
                            seenGroupsTotal.add(item.tokka_group);
                            return sum + (item.tokka_group_price ? parseInt(item.tokka_group_price, 10) : 0);
                          }
                          return sum;
                        }
                        return sum + (item.rental_price ? parseFloat(item.rental_price) : 0) * item.quantity;
                      }
                      const p = item.rental_price ? parseFloat(item.rental_price) : 0;
                      return sum + p * item.quantity;
                    }, 0);
                    return total > 0 ? (
                      <div className="flex justify-between items-center px-1 pt-1 border-t border-gray-200 mt-1">
                        <span className="text-xs font-semibold text-gray-600">月額総合計</span>
                        <span className="text-base font-bold text-emerald-600">¥{total.toLocaleString()}/月</span>
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>

              <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0 flex gap-2">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 py-3 bg-gray-100 text-gray-600 rounded-xl font-medium text-sm"
                >
                  修正する
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={loading}
                  className="flex-1 py-3 bg-emerald-500 text-white rounded-xl font-medium text-sm disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
                  登録する
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-gray-500 shrink-0 w-20">{label}</span>
      <span className={`text-xs font-medium ${warn ? "text-amber-500" : "text-gray-800"}`}>{value}</span>
    </div>
  );
}
