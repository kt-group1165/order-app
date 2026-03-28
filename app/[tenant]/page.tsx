"use client";

import { useState, useEffect, use, useCallback, Fragment } from "react";
import {
  Package,
  ClipboardList,
  Users,
  Settings,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Search,
  Upload,
  X,
  Plus,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Truck,
  PlayCircle,
  Ban,
  RotateCcw,
  Mail,
  Printer,
  Send,
} from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Client, Supplier, Member } from "@/lib/supabase";
import { getOrders, getOrderItems, updateOrderItemStatus, getAllOrderItemsByTenant, createOrder, createOrderItem, getMembers, recordEmailSent, updateSupplierEmail } from "@/lib/orders";
import { getEquipment, getSuppliers, importEquipment, parseEquipmentCSV, updateEquipment, createEquipmentItem, type ImportResult } from "@/lib/equipment";
import { getClients } from "@/lib/clients";
import { getTenants, type Tenant } from "@/lib/tenants";

// ─── Status helpers ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<OrderItem["status"], string> = {
  ordered: "発注済",
  delivered: "納品済",
  trial: "試用中",
  rental_started: "レンタル中",
  cancelled: "キャンセル",
  terminated: "解約済",
};

const STATUS_COLOR: Record<OrderItem["status"], string> = {
  ordered: "bg-blue-100 text-blue-700",
  delivered: "bg-purple-100 text-purple-700",
  trial: "bg-amber-100 text-amber-700",
  rental_started: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-gray-100 text-gray-500",
  terminated: "bg-red-100 text-red-600",
};

const NEXT_STATUSES: Record<OrderItem["status"], OrderItem["status"][]> = {
  ordered: ["delivered", "cancelled"],
  delivered: ["trial", "rental_started", "cancelled"],
  trial: ["rental_started", "cancelled"],
  rental_started: ["terminated"],
  cancelled: [],
  terminated: [],
};

// ─── Search utils ────────────────────────────────────────────────────────────

/** 半角カタカナ→全角カタカナ変換テーブル */
const HW_KANA: Record<string, string> = {
  ｦ:"ヲ",ｧ:"ァ",ｨ:"ィ",ｩ:"ゥ",ｪ:"ェ",ｫ:"ォ",ｬ:"ャ",ｭ:"ュ",ｮ:"ョ",ｯ:"ッ",ｰ:"ー",
  ｱ:"ア",ｲ:"イ",ｳ:"ウ",ｴ:"エ",ｵ:"オ",ｶ:"カ",ｷ:"キ",ｸ:"ク",ｹ:"ケ",ｺ:"コ",
  ｻ:"サ",ｼ:"シ",ｽ:"ス",ｾ:"セ",ｿ:"ソ",ﾀ:"タ",ﾁ:"チ",ﾂ:"ツ",ﾃ:"テ",ﾄ:"ト",
  ﾅ:"ナ",ﾆ:"ニ",ﾇ:"ヌ",ﾈ:"ネ",ﾉ:"ノ",ﾊ:"ハ",ﾋ:"ヒ",ﾌ:"フ",ﾍ:"ヘ",ﾎ:"ホ",
  ﾏ:"マ",ﾐ:"ミ",ﾑ:"ム",ﾒ:"メ",ﾓ:"モ",ﾔ:"ヤ",ﾕ:"ユ",ﾖ:"ヨ",
  ﾗ:"ラ",ﾘ:"リ",ﾙ:"ル",ﾚ:"レ",ﾛ:"ロ",ﾜ:"ワ",ﾝ:"ン",
};

/**
 * 検索用正規化：
 * 半角カナ→全角カナ → ひらがな→カタカナ → 小文字 → スペース除去
 * これにより「やまだ」「ヤマダ」「ﾔﾏﾀﾞ」がすべて「ヤマダ」に統一される
 */
const normalizeSearch = (str: string) =>
  str
    .normalize("NFC")                                      // 濁点合成（NFD対策）
    .replace(/[ｦ-ﾟ]/g, (c) => HW_KANA[c] ?? c)          // 半角カナ→全角カナ
    .replace(/[\u3041-\u3096]/g, (c) =>                   // ひらがな→カタカナ
      String.fromCharCode(c.charCodeAt(0) + 0x60))
    .toLowerCase()
    .replace(/[\s　]+/g, "");                              // 全角・半角スペース除去

/** 用具名・コード・TAISコード・カテゴリに対してキーワード検索 */
const matchEquipment = (e: Equipment, raw: string): boolean => {
  const q = normalizeSearch(raw);
  if (!q) return true;
  return [e.name, e.product_code, e.tais_code ?? "", e.category ?? ""].some((s) =>
    normalizeSearch(s).includes(q)
  );
};

/** 利用者名・フリガナに対してキーワード検索（かな/カナ両対応） */
const matchClient = (c: Client, raw: string): boolean => {
  const q = normalizeSearch(raw);
  if (!q) return true;
  return [c.name, c.furigana ?? ""].some((s) => normalizeSearch(s).includes(q));
};

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = "orders" | "equipment" | "clients" | "settings";

type OrderWithItems = Order & { items: OrderItem[] };

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function TenantPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: tenantId } = use(params);
  const [activeTab, setActiveTab] = useState<Tab>("orders");
  const [tenantName, setTenantName] = useState(tenantId);

  useEffect(() => {
    getTenants().then((list) => {
      const found = list.find((t) => t.id === tenantId);
      if (found) setTenantName(found.name);
    });
  }, [tenantId]);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-emerald-600 text-white px-4 py-3 flex items-center gap-2 shrink-0">
        <Package size={20} />
        <h1 className="text-base font-semibold flex-1 truncate">{tenantName}</h1>
        <span className="text-xs text-emerald-200">用具・発注管理</span>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "orders" && <OrdersTab tenantId={tenantId} />}
        {activeTab === "equipment" && <EquipmentTab tenantId={tenantId} />}
        {activeTab === "clients" && <ClientsTab tenantId={tenantId} />}
        {activeTab === "settings" && <SettingsTab tenantId={tenantId} />}
      </div>

      {/* Bottom Nav */}
      <nav className="bg-white border-t border-gray-200 flex shrink-0">
        {(
          [
            { id: "orders", icon: ClipboardList, label: "発注管理" },
            { id: "equipment", icon: Package, label: "用具マスタ" },
            { id: "clients", icon: Users, label: "利用者別" },
            { id: "settings", icon: Settings, label: "設定" },
          ] as { id: Tab; icon: React.ElementType; label: string }[]
        ).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex-1 flex flex-col items-center py-2 gap-0.5 text-xs transition-colors ${
              activeTab === id
                ? "text-emerald-600"
                : "text-gray-400 hover:text-gray-600"
            }`}
          >
            <Icon size={22} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ─── Orders Tab ─────────────────────────────────────────────────────────────

function OrdersTab({ tenantId }: { tenantId: string }) {
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<OrderItem["status"] | "all">("all");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [previewOrder, setPreviewOrder] = useState<{ order: Order; items: OrderItem[]; emailType?: "new_order" | "rental_started" | "terminated" } | null>(null);
  const [dateInput, setDateInput] = useState<{
    item: OrderItem;
    nextStatus: OrderItem["status"];
    date: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ordersData, clientsData, equipData, suppliersData, membersData] = await Promise.all([
        getOrders(tenantId),
        getClients(tenantId),
        getEquipment(tenantId),
        getSuppliers(),
        getMembers(tenantId),
      ]);
      // Load items for each order
      const withItems: OrderWithItems[] = await Promise.all(
        ordersData.map(async (o) => ({
          ...o,
          items: await getOrderItems(o.id),
        }))
      );
      setOrders(withItems);
      setExpandedIds(new Set(withItems.map((o) => o.id)));
      setClients(clientsData);
      setEquipment(equipData);
      setSuppliers(suppliersData);
      setMembers(membersData);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const clientName = (id: string | null) =>
    id ? (clients.find((c) => c.id === id)?.name ?? id) : "（利用者未設定）";

  const equipName = (code: string) =>
    equipment.find((e) => e.product_code === code)?.name ?? code;

  // 利用者ごとにグループ化して直近活動順に並べる
  const clientGroups = (() => {
    const filtered = filter === "all"
      ? orders
      : orders.filter((o) => o.items.some((i) => i.status === filter));

    const groupMap = new Map<string, OrderWithItems[]>();
    for (const order of filtered) {
      const key = order.client_id ?? "__none__";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(order);
    }

    const groups = Array.from(groupMap.entries()).map(([key, groupOrders]) => {
      const sorted = [...groupOrders].sort(
        (a, b) => new Date(b.ordered_at).getTime() - new Date(a.ordered_at).getTime()
      );
      return {
        clientId: key === "__none__" ? null : key,
        name: key === "__none__" ? "利用者未設定" : (clients.find((c) => c.id === key)?.name ?? key),
        furigana: key === "__none__" ? "" : (clients.find((c) => c.id === key)?.furigana ?? ""),
        latestAt: sorted[0].ordered_at,
        orders: sorted,
      };
    });

    // 直近活動順
    groups.sort((a, b) => new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime());
    return groups;
  })();

  const today = new Date().toISOString().split("T")[0];

  const handleStatusClick = (item: OrderItem, nextStatus: OrderItem["status"]) => {
    // レンタル中・解約済は日付入力が必要
    if (nextStatus === "rental_started" || nextStatus === "terminated") {
      setDateInput({ item, nextStatus, date: today });
    } else {
      handleStatusChange(item, nextStatus);
    }
  };

  const handleStatusChange = async (
    item: OrderItem,
    newStatus: OrderItem["status"],
    date?: string
  ) => {
    setUpdatingId(item.id);
    try {
      const extra: Record<string, string> = {};
      if (newStatus === "rental_started" && date) extra.rental_start_date = date;
      if (newStatus === "terminated" && date) extra.rental_end_date = date;
      await updateOrderItemStatus(item.id, newStatus, Object.keys(extra).length ? extra : undefined);
      setDateInput(null);
      // レンタル開始・解約時はメールプレビューを表示
      if (newStatus === "rental_started" || newStatus === "terminated") {
        const parentOrder = orders.find((o) => o.items.some((i) => i.id === item.id));
        if (parentOrder) {
          const updatedItems = parentOrder.items.map((i) =>
            i.id === item.id
              ? { ...i, status: newStatus,
                  ...(newStatus === "rental_started" && date ? { rental_start_date: date } : {}),
                  ...(newStatus === "terminated" && date ? { rental_end_date: date } : {}) }
              : i
          );
          setPreviewOrder({ order: parentOrder, items: updatedItems, emailType: newStatus });
          return;
        }
      }
      await load();
    } finally {
      setUpdatingId(null);
    }
  };

  // プレビューモーダルはloadingに関わらず常に表示（新規登録後のload()競合を防ぐ）
  if (previewOrder) {
    return (
      <OrderEmailPreviewModal
        order={previewOrder.order}
        orderItems={previewOrder.items}
        clients={clients}
        equipment={equipment}
        suppliers={suppliers}
        members={members}
        emailType={previewOrder.emailType ?? "new_order"}
        onClose={() => { setPreviewOrder(null); load(); }}
        onBack={() => setPreviewOrder(null)}
        onDone={() => { setPreviewOrder(null); load(); }}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-emerald-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar: filter + new order */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-2 shrink-0">
        <button
          onClick={() => setShowNewOrder(true)}
          className="shrink-0 flex items-center gap-1 bg-emerald-500 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Plus size={14} />
          新規発注
        </button>
      </div>

      {/* Filter bar */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-2 overflow-x-auto shrink-0">
        {(["all", "ordered", "delivered", "trial", "rental_started", "terminated"] as const).map(
          (s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                filter === s
                  ? "bg-emerald-500 text-white"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {s === "all" ? "すべて" : STATUS_LABEL[s]}
            </button>
          )
        )}
      </div>

      {/* Order list - 利用者グループ表示 */}
      <div className="flex-1 overflow-y-auto">
        {clientGroups.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">発注データがありません</p>
        ) : (
          <div>
            {clientGroups.map((group) => (
              <div key={group.clientId ?? "__none__"}>
                {/* 利用者ヘッダー */}
                <div className="bg-emerald-50 border-b border-emerald-100 px-4 py-2 flex items-center gap-2 sticky top-0 z-10">
                  <span className="text-sm font-bold text-emerald-800">{group.name}</span>
                  {group.furigana && (
                    <span className="text-xs text-emerald-500">{group.furigana}</span>
                  )}
                  <span className="ml-auto text-xs text-emerald-400">{group.orders.length}発注</span>
                </div>
                {/* その利用者の発注一覧 */}
                <ul className="divide-y divide-gray-100">
                  {group.orders.map((order) => {
                    const isOpen = expandedIds.has(order.id);
                    const activeItems = order.items.filter((i) => i.status !== "cancelled");
                    const toggleExpand = () => setExpandedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(order.id)) next.delete(order.id);
                      else next.add(order.id);
                      return next;
                    });
                    return (
                      <li key={order.id} className="bg-white">
                        {/* 発注ヘッダー行（クリックで折りたたみ） */}
                        <button
                          onClick={toggleExpand}
                          className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-gray-50 transition-colors"
                        >
                          <div className="flex-1 text-left flex items-center gap-2">
                            <span className="text-xs text-gray-500">
                              {new Date(order.ordered_at).toLocaleDateString("ja-JP")}発注
                            </span>
                            <span className="text-xs text-gray-400">{activeItems.length}点</span>
                            {order.notes && (
                              <span className="text-xs text-gray-400 truncate max-w-[100px]">{order.notes}</span>
                            )}
                          </div>
                          {isOpen ? (
                            <ChevronDown size={16} className="text-gray-400 shrink-0" />
                          ) : (
                            <ChevronRight size={16} className="text-gray-400 shrink-0" />
                          )}
                        </button>

                        {isOpen && (
                          <div className="px-3 pb-3 bg-gray-50">
                            {/* メール送信ボタン */}
                            <button
                              onClick={() => setPreviewOrder({ order, items: order.items })}
                              className="w-full flex items-center justify-center gap-2 py-2 mb-2 rounded-xl border border-emerald-200 text-emerald-600 text-xs font-medium hover:bg-emerald-50 transition-colors"
                            >
                              <Mail size={14} />
                              {(order.email_sent_count ?? 0) > 0
                                ? `メール再送（${order.email_sent_count}回送信済）`
                                : "発注メールを送信・印刷"}
                            </button>
                            {/* アイテム一覧（table で縦列を完全に揃える） */}
                            <table className="w-full table-fixed bg-white rounded-xl overflow-hidden text-left">
                              <tbody>
                                {order.items.map((item) => (
                                  <Fragment key={item.id}>
                                    <tr className="border-b border-gray-50 last:border-0">
                                      {/* ステータス（最左列） */}
                                      <td className="pl-3 py-2 pr-2 w-[4.5rem]">
                                        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_COLOR[item.status]}`}>
                                          {STATUS_LABEL[item.status]}
                                        </span>
                                      </td>
                                      {/* 用具名 */}
                                      <td className="py-2 text-sm font-medium text-gray-800 max-w-0">
                                        <span className="block truncate">{equipName(item.product_code)}</span>
                                      </td>
                                      {/* コード */}
                                      <td className="py-2 px-3 text-xs text-gray-400 whitespace-nowrap w-[6.5rem]">
                                        {item.product_code}
                                      </td>
                                      {/* レンタル価格 */}
                                      <td className="py-2 pr-3 text-xs text-gray-400 whitespace-nowrap w-[5.5rem]">
                                        {item.rental_price ? `¥${item.rental_price.toLocaleString()}/月` : ""}
                                      </td>
                                      {/* アクションボタン */}
                                      <td className="py-2 pr-3 whitespace-nowrap">
                                        {NEXT_STATUSES[item.status].length > 0 && dateInput?.item.id !== item.id && (
                                          <div className="flex gap-1.5">
                                            {NEXT_STATUSES[item.status].map((next) => (
                                              <button
                                                key={next}
                                                disabled={updatingId === item.id}
                                                onClick={() => handleStatusClick(item, next)}
                                                className={`text-xs px-3 py-1 rounded-full border font-medium transition-colors disabled:opacity-50 ${
                                                  next === "cancelled" || next === "terminated"
                                                    ? "border-red-200 text-red-500 hover:bg-red-50"
                                                    : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                                                }`}
                                              >
                                                {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : `→ ${STATUS_LABEL[next]}`}
                                              </button>
                                            ))}
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                    {/* 開始・終了日（あれば次行に表示） */}
                                    {(item.rental_start_date || item.rental_end_date) && (
                                      <tr className="border-b border-gray-50 last:border-0">
                                        <td colSpan={5} className="px-3 pb-1.5 text-xs text-gray-400">
                                          {item.rental_start_date && <span className="mr-4">開始: {item.rental_start_date}</span>}
                                          {item.rental_end_date && <span>終了: {item.rental_end_date}</span>}
                                        </td>
                                      </tr>
                                    )}
                                    {/* 日付入力（レンタル開始・解約時） */}
                                    {dateInput?.item.id === item.id && (
                                      <tr>
                                        <td colSpan={5} className="px-3 pb-2">
                                          <div className="bg-emerald-50 rounded-xl p-3 space-y-2">
                                            <p className="text-xs font-medium text-emerald-700">
                                              {dateInput.nextStatus === "rental_started" ? "レンタル開始日" : "解約日"}を入力
                                            </p>
                                            <input
                                              type="date"
                                              value={dateInput.date}
                                              onChange={(e) => setDateInput({ ...dateInput, date: e.target.value })}
                                              className="w-full border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                                            />
                                            <div className="flex gap-2">
                                              <button
                                                disabled={!dateInput.date || updatingId === item.id}
                                                onClick={() => handleStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date)}
                                                className="flex-1 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-1"
                                              >
                                                {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : "確定"}
                                              </button>
                                              <button
                                                onClick={() => setDateInput(null)}
                                                className="px-3 text-xs text-gray-400 border border-gray-200 rounded-lg"
                                              >
                                                戻す
                                              </button>
                                            </div>
                                          </div>
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
        )}
      </div>

      {showNewOrder && (
        <NewOrderModal
          tenantId={tenantId}
          clients={clients}
          equipment={equipment}
          suppliers={suppliers}
          members={members}
          onClose={() => setShowNewOrder(false)}
          onDone={(order, items) => {
            setShowNewOrder(false);
            setPreviewOrder({ order, items });
            // load() はプレビューモーダルを閉じた後に呼ばれる
          }}
        />
      )}

    </div>
  );
}

// ─── Equipment Tab ───────────────────────────────────────────────────────────

function EquipmentTab({ tenantId }: { tenantId: string }) {
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Equipment | null>(null);
  const [showNewItem, setShowNewItem] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<"idle" | "confirm1" | "confirm2">("idle");
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAll = async () => {
    if (deleteConfirm === "idle") { setDeleteConfirm("confirm1"); return; }
    if (deleteConfirm === "confirm1") { setDeleteConfirm("confirm2"); return; }
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("equipment_master")
        .delete()
        .eq("tenant_id", tenantId);
      if (error) throw error;
      setDeleteConfirm("idle");
      await load();
    } catch {
      alert("削除に失敗しました");
    } finally {
      setDeleting(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setEquipment(await getEquipment(tenantId));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = equipment.filter((e) => matchEquipment(e, search));

  const CATEGORY_COLOR: Record<string, string> = {
    車いす: "bg-blue-100 text-blue-700",
    歩行器: "bg-purple-100 text-purple-700",
    ベッド: "bg-amber-100 text-amber-700",
    手すり: "bg-green-100 text-green-700",
    スロープ: "bg-orange-100 text-orange-700",
  };
  const catColor = (cat: string | null) =>
    cat ? (CATEGORY_COLOR[cat] ?? "bg-gray-100 text-gray-600") : "";

  if (selectedItem) {
    return (
      <EquipmentDetail
        item={selectedItem}
        tenantId={tenantId}
        onBack={() => setSelectedItem(null)}
        onSave={(saved) => { setSelectedItem(saved); load(); }}
      />
    );
  }

  if (showNewItem) {
    return (
      <EquipmentDetail
        item={null}
        tenantId={tenantId}
        onBack={() => setShowNewItem(false)}
        onSave={(saved) => { setShowNewItem(false); setSelectedItem(saved); load(); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Search + Import */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-2 shrink-0">
        <div className="flex-1 flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1.5">
          <Search size={14} className="text-gray-400 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="用具名・コードで検索"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          {search && (
            <button onClick={() => setSearch("")}>
              <X size={14} className="text-gray-400" />
            </button>
          )}
        </div>
        <button
          onClick={() => setShowNewItem(true)}
          className="shrink-0 flex items-center gap-1 bg-emerald-500 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Plus size={14} />
          新規
        </button>
        <button
          onClick={() => setShowImport(true)}
          className="shrink-0 flex items-center gap-1 bg-gray-600 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Upload size={14} />
          CSV
        </button>
        <button
          onClick={handleDeleteAll}
          disabled={deleting}
          className={`shrink-0 flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-xl transition-colors ${
            deleteConfirm === "idle"
              ? "bg-gray-100 text-gray-500 hover:bg-red-50 hover:text-red-500"
              : deleteConfirm === "confirm1"
              ? "bg-red-100 text-red-500"
              : "bg-red-500 text-white"
          }`}
        >
          {deleting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <X size={14} />
          )}
          {deleteConfirm === "idle" && "全削除"}
          {deleteConfirm === "confirm1" && "本当に？"}
          {deleteConfirm === "confirm2" && "実行する"}
        </button>
        {deleteConfirm !== "idle" && (
          <button
            onClick={() => setDeleteConfirm("idle")}
            className="shrink-0 text-xs text-gray-400 underline"
          >
            戻す
          </button>
        )}
      </div>

      <div className="px-3 py-2 bg-white border-b border-gray-100 shrink-0">
        <p className="text-xs text-gray-400">{filtered.length}件</p>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">
              {equipment.length === 0 ? "用具データがありません。CSVからインポートしてください。" : "該当なし"}
            </p>
          ) : (
            <ul className="divide-y divide-gray-100 bg-white">
              {filtered.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => setSelectedItem(item)}
                    className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {item.name}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <span className="text-xs text-gray-400">
                          {item.product_code}
                        </span>
                        {item.tais_code && (
                          <span className="text-xs text-gray-400">
                            TAIS: {item.tais_code}
                          </span>
                        )}
                        {item.category && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${catColor(item.category)}`}
                          >
                            {item.category}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {item.rental_price && (
                        <p className="text-sm font-semibold text-emerald-600">
                          ¥{item.rental_price.toLocaleString()}
                        </p>
                      )}
                      <p className="text-xs text-gray-400">/月</p>
                    </div>
                    <ChevronRight size={16} className="text-gray-300 shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showImport && (
        <ImportModal
          tenantId={tenantId}
          onClose={() => setShowImport(false)}
          onDone={() => {
            setShowImport(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ─── Equipment Detail ────────────────────────────────────────────────────────

function EquipmentDetail({
  item,
  tenantId,
  onBack,
  onSave,
}: {
  item: Equipment | null;
  tenantId: string;
  onBack: () => void;
  onSave: (saved: Equipment) => void;
}) {
  const isNew = item === null;
  const [isEditing, setIsEditing] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // フォーム state
  const [name, setName] = useState(item?.name ?? "");
  const [taisCode, setTaisCode] = useState(item?.tais_code ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [rentalPrice, setRentalPrice] = useState(item?.rental_price ? String(item.rental_price) : "");
  const [nationalAvg, setNationalAvg] = useState(item?.national_avg_price ? String(item.national_avg_price) : "");
  const [priceLimit, setPriceLimit] = useState(item?.price_limit ? String(item.price_limit) : "");
  const [selectionReason, setSelectionReason] = useState(item?.selection_reason ?? "");
  const [proposalReason, setProposalReason] = useState(item?.proposal_reason ?? "");

  const handleSave = async () => {
    if (!name.trim()) { setError("用具名は必須です"); return; }
    setSaving(true);
    setError("");
    try {
      const payload = {
        name: name.trim(),
        tais_code: taisCode.trim() || null,
        category: category.trim() || null,
        rental_price: rentalPrice ? parseFloat(rentalPrice) : null,
        national_avg_price: nationalAvg ? parseFloat(nationalAvg) : null,
        price_limit: priceLimit ? parseFloat(priceLimit) : null,
        selection_reason: selectionReason.trim() || null,
        proposal_reason: proposalReason.trim() || null,
      };
      const saved = isNew
        ? await createEquipmentItem(tenantId, payload)
        : await updateEquipment(item!.id, payload);
      onSave(saved);
      setIsEditing(false);
    } catch {
      setError("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (isNew) { onBack(); return; }
    // 元に戻す
    setName(item!.name);
    setTaisCode(item!.tais_code ?? "");
    setCategory(item!.category ?? "");
    setRentalPrice(item!.rental_price ? String(item!.rental_price) : "");
    setNationalAvg(item!.national_avg_price ? String(item!.national_avg_price) : "");
    setPriceLimit(item!.price_limit ? String(item!.price_limit) : "");
    setSelectionReason(item!.selection_reason ?? "");
    setProposalReason(item!.proposal_reason ?? "");
    setIsEditing(false);
    setError("");
  };

  const Field = ({ label, value }: { label: string; value: string | number | null | undefined }) =>
    value != null && value !== "" ? (
      <div className="bg-gray-50 rounded-xl p-3">
        <p className="text-xs text-gray-400 mb-0.5">{label}</p>
        <p className="text-sm text-gray-800">{value}</p>
      </div>
    ) : null;

  return (
    <div className="flex flex-col h-full">
      {/* ヘッダー */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={isEditing && !isNew ? handleCancel : onBack}>
          <ChevronLeft size={20} className="text-gray-500" />
        </button>
        <h2 className="font-semibold text-gray-800 flex-1 truncate">
          {isNew ? "用具 新規登録" : (isEditing ? "用具を編集" : (item?.name ?? ""))}
        </h2>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="text-xs font-medium text-emerald-600 bg-emerald-50 px-3 py-1.5 rounded-xl"
          >
            編集
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isEditing ? (
          /* 編集フォーム */
          <>
            {[
              { label: "用具名 *", value: name, setter: setName, placeholder: "例：電動ベッド", type: "text" },
              { label: "TAISコード", value: taisCode, setter: setTaisCode, placeholder: "例：07-0001-01", type: "text" },
              { label: "カテゴリ", value: category, setter: setCategory, placeholder: "例：ベッド", type: "text" },
              { label: "レンタル価格（円/月）", value: rentalPrice, setter: setRentalPrice, placeholder: "例：15000", type: "number" },
              { label: "全国平均価格（円）", value: nationalAvg, setter: setNationalAvg, placeholder: "例：12000", type: "number" },
              { label: "限度額（円）", value: priceLimit, setter: setPriceLimit, placeholder: "例：18000", type: "number" },
            ].map(({ label, value, setter, placeholder, type }) => (
              <div key={label}>
                <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
                <input
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  placeholder={placeholder}
                  type={type}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
              </div>
            ))}
            {[
              { label: "選定理由", value: selectionReason, setter: setSelectionReason },
              { label: "提案理由", value: proposalReason, setter: setProposalReason },
            ].map(({ label, value, setter }) => (
              <div key={label}>
                <label className="text-xs font-medium text-gray-600 block mb-1">{label}</label>
                <textarea
                  value={value}
                  onChange={(e) => setter(e.target.value)}
                  rows={3}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400 resize-none"
                />
              </div>
            ))}
            {error && (
              <div className="flex items-center gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                <AlertCircle size={14} />
                {error}
              </div>
            )}
          </>
        ) : (
          /* 表示モード */
          <>
            <Field label="商品コード" value={item?.product_code} />
            <Field label="TAISコード" value={item?.tais_code} />
            <Field label="カテゴリ" value={item?.category} />
            <Field label="レンタル価格" value={item?.rental_price ? `¥${item.rental_price.toLocaleString()}/月` : null} />
            <Field label="全国平均価格" value={item?.national_avg_price ? `¥${item.national_avg_price.toLocaleString()}` : null} />
            <Field label="限度額" value={item?.price_limit ? `¥${item.price_limit.toLocaleString()}` : null} />
            <Field label="選定理由" value={item?.selection_reason} />
            <Field label="提案理由" value={item?.proposal_reason} />
            {item && (
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-0.5">更新日</p>
                <p className="text-sm text-gray-800">{new Date(item.updated_at).toLocaleDateString("ja-JP")}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* 編集時フッター */}
      {isEditing && (
        <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0 flex gap-2">
          <button
            onClick={handleCancel}
            className="flex-1 py-3 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            保存
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Import Modal ────────────────────────────────────────────────────────────

function ImportModal({
  tenantId,
  onClose,
  onDone,
}: {
  tenantId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [csvText, setCsvText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleImport = async () => {
    if (!csvText.trim()) {
      setError("CSVテキストを入力してください");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const rows = parseEquipmentCSV(csvText);
      if (rows.length === 0) {
        setError("有効なデータが見つかりませんでした。CSVの形式を確認してください。");
        return;
      }
      const res = await importEquipment(tenantId, rows);
      setResult(res);
    } catch (e) {
      setError("インポート中にエラーが発生しました");
    } finally {
      setLoading(false);
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    // UTF-8で試してダメならShift-JIS
    let text = new TextDecoder("utf-8").decode(buffer);
    if (text.includes("\uFFFD")) {
      try {
        text = new TextDecoder("shift-jis").decode(buffer);
      } catch {}
    }
    setCsvText(text);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end z-50">
      <div className="bg-white w-full rounded-t-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">用具CSVインポート</h3>
          <button onClick={onClose}>
            <X size={20} className="text-gray-400" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!result ? (
            <>
              <div className="bg-emerald-50 rounded-xl p-3 text-xs text-emerald-700 space-y-1">
                <p className="font-semibold">CSVの列（1行目がヘッダー）</p>
                <p>用具名（必須）、TAISコード、カテゴリ、レンタル価格、全国平均価格、限度額</p>
                <p>既存のTAISコードまたは用具名が一致する場合は上書き更新されます</p>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  ファイルを選択
                </label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleFile}
                  className="text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-emerald-100 file:text-emerald-700 file:text-xs file:font-medium"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">
                  またはCSVをここに貼り付け
                </label>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder={"用具名,TAISコード,カテゴリ,レンタル価格\n電動ベッド,17-0671-00,ベッド,15000"}
                  className="w-full h-32 text-xs font-mono border border-gray-200 rounded-xl p-2 outline-none focus:border-emerald-400 resize-none"
                />
              </div>

              {error && (
                <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  {error}
                </div>
              )}

              <button
                onClick={handleImport}
                disabled={loading}
                className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Upload size={16} />
                )}
                インポート実行
              </button>
            </>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-emerald-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-600">{result.inserted}</p>
                  <p className="text-xs text-emerald-600">新規追加</p>
                </div>
                <div className="bg-blue-50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-blue-600">{result.updated}</p>
                  <p className="text-xs text-blue-600">更新</p>
                </div>
              </div>

              {result.changes.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">変更内容</p>
                  <div className="space-y-1 max-h-40 overflow-y-auto">
                    {result.changes.map((c, i) => (
                      <div key={i} className="text-xs bg-amber-50 rounded-lg p-2">
                        <span className="font-medium">{c.name}</span>の{c.field}:{" "}
                        <span className="line-through text-gray-400">{c.old || "（空）"}</span>
                        {" → "}
                        <span className="text-amber-700">{c.new}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.errors.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-500 mb-2">
                    エラー ({result.errors.length}件)
                  </p>
                  <div className="space-y-1">
                    {result.errors.map((e, i) => (
                      <p key={i} className="text-xs text-red-500 bg-red-50 rounded-lg p-2">
                        {e}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              <button
                onClick={onDone}
                className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-2"
              >
                <CheckCircle2 size={16} />
                完了
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Clients Tab ─────────────────────────────────────────────────────────────

const KANA_ROWS = [
  { label: "ア", chars: "アイウエオ" },
  { label: "カ", chars: "カキクケコ" },
  { label: "サ", chars: "サシスセソ" },
  { label: "タ", chars: "タチツテト" },
  { label: "ナ", chars: "ナニヌネノ" },
  { label: "ハ", chars: "ハヒフヘホ" },
  { label: "マ", chars: "マミムメモ" },
  { label: "ヤ", chars: "ヤユヨ" },
  { label: "ラ", chars: "ラリルレロ" },
  { label: "ワ", chars: "ワヲン" },
];

function ClientsTab({ tenantId }: { tenantId: string }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [kanaFilter, setKanaFilter] = useState("");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [c, items, eq] = await Promise.all([
          getClients(tenantId),
          getAllOrderItemsByTenant(tenantId),
          getEquipment(tenantId),
        ]);
        setClients(c);
        setOrderItems(items);
        setEquipment(eq);
      } finally {
        setLoading(false);
      }
    })();
  }, [tenantId]);

  if (selectedClient) {
    return (
      <ClientDetail
        client={selectedClient}
        allOrderItems={orderItems}
        equipment={equipment}
        tenantId={tenantId}
        onBack={() => setSelectedClient(null)}
      />
    );
  }

  const filtered = clients
    .filter((c) => {
      if (kanaFilter) {
        const row = KANA_ROWS.find((r) => r.label === kanaFilter);
        // ひらがな→カタカナ変換してから比較
        const toKata = (s: string) =>
          s.normalize("NFC")
           .replace(/[ｦ-ﾟ]/g, (ch) => HW_KANA[ch] ?? ch)          // 半角カナ→全角
           .replace(/[\u3041-\u3096]/g, (ch) =>                     // ひらがな→カタカナ
             String.fromCharCode(ch.charCodeAt(0) + 0x60));
        const first = toKata((c.furigana ?? "").trim().charAt(0));
        if (row && (!first || !row.chars.includes(first))) return false;
      }
      return matchClient(c, search);
    })
    .sort((a, b) => (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja"));

  // Count active rentals per client
  const activeCount = (clientId: string) =>
    orderItems.filter(
      (i) => i.status === "rental_started"
    ).length; // simplified — real app would join through orders

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-emerald-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-2 shrink-0">
        <div className="flex-1 flex items-center gap-2 bg-gray-100 rounded-xl px-3 py-1.5">
          <Search size={14} className="text-gray-400 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="名前・かな・カナで検索"
            className="flex-1 bg-transparent text-sm outline-none"
          />
          {search && (
            <button onClick={() => setSearch("")}>
              <X size={14} className="text-gray-400" />
            </button>
          )}
        </div>
      </div>
      {/* ア行・カ行フィルター */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-1.5 overflow-x-auto shrink-0">
        <button
          onClick={() => setKanaFilter("")}
          className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${!kanaFilter ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
        >すべて</button>
        {KANA_ROWS.map((row) => (
          <button
            key={row.label}
            onClick={() => setKanaFilter(kanaFilter === row.label ? "" : row.label)}
            className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${kanaFilter === row.label ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
          >{row.label}行</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto bg-white">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">
            {clients.length === 0 ? "利用者データがありません" : "該当なし"}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {filtered.map((client) => (
              <li key={client.id}>
                <button
                  onClick={() => setSelectedClient(client)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
                >
                  <div className="w-9 h-9 bg-gray-100 rounded-full flex items-center justify-center shrink-0 text-sm font-semibold text-gray-500">
                    {client.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800">{client.name}</p>
                    {client.furigana && (
                      <p className="text-xs text-gray-400">{client.furigana}</p>
                    )}
                  </div>
                  <ChevronRight size={16} className="text-gray-300 shrink-0" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Client Detail ───────────────────────────────────────────────────────────

function ClientDetail({
  client,
  allOrderItems,
  equipment,
  tenantId,
  onBack,
}: {
  client: Client;
  allOrderItems: OrderItem[];
  equipment: Equipment[];
  tenantId: string;
  onBack: () => void;
}) {
  const [clientItems, setClientItems] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"current" | "monthly">("current");
  const [yearMonth, setYearMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [dateInput, setDateInput] = useState<{
    item: OrderItem;
    nextStatus: OrderItem["status"];
    date: string;
  } | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const { data: ordersData } = await supabase
        .from("orders")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("client_id", client.id);
      if (ordersData && ordersData.length > 0) {
        const orderIds = ordersData.map((o: { id: string }) => o.id);
        const { data: items } = await supabase
          .from("order_items")
          .select("*")
          .in("order_id", orderIds);
        setClientItems(items ?? []);
      } else {
        setClientItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, [client.id, tenantId]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const today = new Date().toISOString().split("T")[0];

  const handleStatusClick = (item: OrderItem, nextStatus: OrderItem["status"]) => {
    if (nextStatus === "rental_started" || nextStatus === "terminated") {
      setDateInput({ item, nextStatus, date: today });
    } else {
      execStatusChange(item, nextStatus);
    }
  };

  const execStatusChange = async (
    item: OrderItem,
    newStatus: OrderItem["status"],
    date?: string
  ) => {
    setUpdatingId(item.id);
    try {
      const extra: Record<string, string> = {};
      if (newStatus === "rental_started" && date) extra.rental_start_date = date;
      if (newStatus === "terminated" && date) extra.rental_end_date = date;
      await updateOrderItemStatus(item.id, newStatus, Object.keys(extra).length ? extra : undefined);
      setDateInput(null);
      await loadItems();
    } finally {
      setUpdatingId(null);
    }
  };

  const equipName = (code: string) =>
    equipment.find((e) => e.product_code === code)?.name ?? code;

  // 指定年月にレンタル中だった用具（開始日 <= 月末 かつ 終了日 >= 月初 or まだ終了していない）
  const monthlyItems = (() => {
    const [y, m] = yearMonth.split("-").map(Number);
    const monthStart = `${yearMonth}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const monthEnd = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
    return clientItems.filter((i) => {
      if (i.status === "cancelled") return false;
      const start = i.rental_start_date;
      const end = i.rental_end_date;
      if (!start) return false;
      if (start > monthEnd) return false;
      if (end && end < monthStart) return false;
      return true;
    });
  })();

  const activeItems = clientItems.filter((i) => i.status === "rental_started");
  const pendingItems = clientItems.filter((i) =>
    ["ordered", "delivered", "trial"].includes(i.status)
  );
  const historyItems = clientItems.filter((i) =>
    i.status === "terminated" || i.status === "cancelled"
  );
  const monthlyTotal = activeItems.reduce((sum, i) => sum + (i.rental_price ?? 0), 0);

  const changeYearMonth = (delta: number) => {
    const [y, m] = yearMonth.split("-").map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    setYearMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  // 用具カード共通（ステータス変更ボタン付き）
  const ItemCard = ({ item, dim = false }: { item: OrderItem; dim?: boolean }) => (
    <div className={`bg-white rounded-xl p-3 shadow-sm border-l-4 ${dim ? "border-gray-200 opacity-75" : "border-emerald-400"}`}>
      <div className="flex items-start justify-between gap-2">
        <p className={`text-sm font-medium ${dim ? "text-gray-600" : "text-gray-800"}`}>
          {equipName(item.product_code)}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {item.rental_price && (
            <span className="text-sm font-bold text-emerald-600">
              ¥{item.rental_price.toLocaleString()}<span className="text-xs font-normal">/月</span>
            </span>
          )}
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[item.status]}`}>
            {STATUS_LABEL[item.status]}
          </span>
        </div>
      </div>
      <div className="text-xs text-gray-400 mt-1 flex gap-3 flex-wrap">
        {item.rental_start_date && <span>開始: {item.rental_start_date}</span>}
        {item.rental_end_date && <span>終了: {item.rental_end_date}</span>}
      </div>

      {/* 日付入力 */}
      {dateInput?.item.id === item.id && (
        <div className="mt-2 bg-emerald-50 rounded-xl p-3 space-y-2">
          <p className="text-xs font-medium text-emerald-700">
            {dateInput.nextStatus === "rental_started" ? "レンタル開始日" : "解約日"}を入力
          </p>
          <input
            type="date"
            value={dateInput.date}
            onChange={(e) => setDateInput({ ...dateInput, date: e.target.value })}
            className="w-full border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
          />
          <div className="flex gap-2">
            <button
              disabled={!dateInput.date || updatingId === item.id}
              onClick={() => execStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date)}
              className="flex-1 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-1"
            >
              {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : "確定"}
            </button>
            <button onClick={() => setDateInput(null)} className="px-3 text-xs text-gray-400 border border-gray-200 rounded-lg">戻す</button>
          </div>
        </div>
      )}

      {/* ステータス変更ボタン */}
      {NEXT_STATUSES[item.status].length > 0 && dateInput?.item.id !== item.id && (
        <div className="flex gap-2 mt-2 overflow-x-auto">
          {NEXT_STATUSES[item.status].map((next) => (
            <button
              key={next}
              disabled={updatingId === item.id}
              onClick={() => handleStatusClick(item, next)}
              className={`shrink-0 text-xs px-3 py-1 rounded-full border font-medium transition-colors disabled:opacity-50 ${
                next === "cancelled" || next === "terminated"
                  ? "border-red-200 text-red-500 hover:bg-red-50"
                  : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"
              }`}
            >
              {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : `→ ${STATUS_LABEL[next]}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onBack}>
          <ChevronLeft size={20} className="text-gray-500" />
        </button>
        <div className="flex-1">
          <h2 className="font-semibold text-gray-800">{client.name}</h2>
          {client.furigana && <p className="text-xs text-gray-400">{client.furigana}</p>}
        </div>
      </div>

      {/* View toggle */}
      <div className="bg-white border-b border-gray-100 px-4 py-2 flex gap-2 shrink-0">
        <button
          onClick={() => setViewMode("current")}
          className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "current" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
        >
          現在の状況
        </button>
        <button
          onClick={() => setViewMode("monthly")}
          className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "monthly" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
        >
          月別レンタル
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : viewMode === "current" ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Summary */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-emerald-50 rounded-xl p-3 text-center">
              <p className="text-2xl font-bold text-emerald-600">{activeItems.length}</p>
              <p className="text-xs text-emerald-600">レンタル中</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-gray-700">¥{monthlyTotal.toLocaleString()}</p>
              <p className="text-xs text-gray-500">月額合計</p>
            </div>
          </div>

          {pendingItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">進行中</h3>
              <div className="space-y-2">{pendingItems.map((i) => <ItemCard key={i.id} item={i} />)}</div>
            </section>
          )}
          {activeItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">レンタル中</h3>
              <div className="space-y-2">{activeItems.map((i) => <ItemCard key={i.id} item={i} />)}</div>
            </section>
          )}
          {historyItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">過去のレンタル</h3>
              <div className="space-y-2">{historyItems.map((i) => <ItemCard key={i.id} item={i} dim />)}</div>
            </section>
          )}
          {clientItems.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-8">発注データがありません</p>
          )}
        </div>
      ) : (
        /* 月別ビュー */
        <div className="flex flex-col h-full">
          {/* 年月切り替え */}
          <div className="bg-white border-b border-gray-100 px-4 py-2 flex items-center justify-between shrink-0">
            <button onClick={() => changeYearMonth(-1)} className="p-2 hover:bg-gray-100 rounded-xl">
              <ChevronLeft size={18} className="text-gray-500" />
            </button>
            <div className="text-center">
              <p className="text-base font-semibold text-gray-800">
                {yearMonth.replace("-", "年")}月
              </p>
              <p className="text-xs text-gray-400">{monthlyItems.length}点レンタル</p>
            </div>
            <button onClick={() => changeYearMonth(1)} className="p-2 hover:bg-gray-100 rounded-xl">
              <ChevronRight size={18} className="text-gray-500" />
            </button>
          </div>

          {/* 月額合計 */}
          <div className="bg-emerald-50 mx-4 mt-3 rounded-xl p-3 flex items-center justify-between shrink-0">
            <span className="text-xs text-emerald-700 font-medium">月額合計</span>
            <span className="text-lg font-bold text-emerald-700">
              ¥{monthlyItems.reduce((s, i) => s + (i.rental_price ?? 0), 0).toLocaleString()}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-2">
            {monthlyItems.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">この月のレンタルはありません</p>
            ) : (
              monthlyItems.map((item) => <ItemCard key={item.id} item={item} dim={item.status === "terminated"} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── New Order Modal ─────────────────────────────────────────────────────────

type NewOrderItem = {
  equipment: Equipment;
  rental_price: string;
  notes: string;
  payment_type: "介護" | "自費" | null; // null = 発注全体に従う
};

function NewOrderModal({
  tenantId,
  clients,
  equipment,
  suppliers,
  members,
  onClose,
  onDone,
}: {
  tenantId: string;
  clients: Client[];
  equipment: Equipment[];
  suppliers: Supplier[];
  members: Member[];
  onClose: () => void;
  onDone: (order: Order, items: OrderItem[]) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSearch, setClientSearch] = useState("");
  const [showClientList, setShowClientList] = useState(false);
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<NewOrderItem[]>([]);
  const [equipSearch, setEquipSearch] = useState("");

  // 新規フィールド
  const [paymentType, setPaymentType] = useState<"介護" | "自費">("介護");
  const [deliveryDate, setDeliveryDate] = useState("");
  const [deliveryHour, setDeliveryHour] = useState("");
  const [deliveryMinute, setDeliveryMinute] = useState("");
  const deliveryTime = deliveryHour && deliveryMinute ? `${deliveryHour}:${deliveryMinute}` : "";
  const [deliveryType, setDeliveryType] = useState<"直納" | "自社納品">("自社納品");
  const [attendanceRequired, setAttendanceRequired] = useState(false);
  const [selectedAttendees, setSelectedAttendees] = useState<string[]>([]);
  const [supplierId, setSupplierId] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const filteredEquip = equipment.filter((e) => matchEquipment(e, equipSearch));

  const addItem = (eq: Equipment) => {
    if (items.find((i) => i.equipment.id === eq.id)) return;
    setItems([
      ...items,
      {
        equipment: eq,
        rental_price: eq.rental_price ? String(eq.rental_price) : "",
        notes: "",
        payment_type: null,
      },
    ]);
    setEquipSearch("");
  };

  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const updateItem = (idx: number, field: "rental_price" | "notes", value: string) => {
    setItems(items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const toggleItemPaymentType = (idx: number) => {
    setItems(items.map((item, i) => {
      if (i !== idx) return item;
      if (item.payment_type === null) {
        // null → 反対の種別に固定
        return { ...item, payment_type: paymentType === "介護" ? "自費" : "介護" };
      }
      return { ...item, payment_type: null }; // 固定解除
    }));
  };

  const toggleAttendee = (id: string) => {
    setSelectedAttendees((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  const handleSubmit = async () => {
    if (!clientId) {
      setError("利用者を選択してください");
      return;
    }
    if (items.length === 0) {
      setError("用具を1つ以上選択してください");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const order = await createOrder({
        tenantId,
        clientId: clientId || undefined,
        notes: notes || undefined,
        paymentType,
        deliveryDate: deliveryDate || undefined,
        deliveryTime: deliveryTime || undefined,
        deliveryType,
        attendanceRequired,
        attendeeIds: selectedAttendees,
        supplierId: supplierId || undefined,
      });
      const createdItems: OrderItem[] = [];
      for (const item of items) {
        const oi = await createOrderItem({
          orderId: order.id,
          tenantId,
          productCode: item.equipment.product_code,
          rentalPrice: item.rental_price ? parseFloat(item.rental_price) : undefined,
          notes: item.notes || undefined,
          paymentType: item.payment_type,
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

        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {/* 自費 / 介護 */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">種別</label>
            <div className="flex gap-2">
              {(["介護", "自費"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setPaymentType(t)}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${
                    paymentType === t
                      ? "bg-emerald-500 text-white border-emerald-500"
                      : "bg-white text-gray-600 border-gray-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* 利用者 */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">利用者 <span className="text-red-400">*必須</span></label>
            {clientId ? (
              <div className="flex items-center justify-between border border-emerald-300 bg-emerald-50 rounded-xl px-3 py-2">
                <span className="text-sm font-medium text-emerald-800">
                  {clients.find((c) => c.id === clientId)?.name ?? ""}
                </span>
                <button onClick={() => { setClientId(""); setClientSearch(""); }} className="text-emerald-400 hover:text-red-400">
                  <X size={14} />
                </button>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2">
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
                {showClientList && (
                  <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden max-h-40 overflow-y-auto">
                    <button
                      onClick={() => { setClientId(""); setShowClientList(false); setClientSearch(""); }}
                      className="w-full px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50 border-b border-gray-50"
                    >
                      選択しない
                    </button>
                    {clients.filter((c) => matchClient(c, clientSearch)).slice(0, 20).map((c) => (
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

          {/* 卸会社 */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">卸会社</label>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400 bg-white"
            >
              <option value="">選択しない</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* 納品予定日・時間 */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">納品予定日・時間</label>
            <div className="flex gap-2">
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
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
              <span className="text-gray-400 text-sm">:</span>
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

          {/* 直納 / 自社納品 */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">納品方法</label>
            <div className="flex gap-2">
              {(["自社納品", "直納"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => { setDeliveryType(t); if (t === "自社納品") { setAttendanceRequired(false); setSelectedAttendees([]); } }}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${
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
            <div className="bg-gray-50 rounded-xl p-3 space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1">立ち会い</label>
                <div className="flex gap-2">
                  {([false, true] as const).map((v) => (
                    <button
                      key={String(v)}
                      onClick={() => { setAttendanceRequired(v); if (!v) setSelectedAttendees([]); }}
                      className={`flex-1 py-2 rounded-xl text-sm font-medium border transition-colors ${
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

              {attendanceRequired && (
                <div>
                  <label className="text-xs font-medium text-gray-600 block mb-1">立ち会い担当者</label>
                  <div className="flex flex-wrap gap-2">
                    {members.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => toggleAttendee(m.id)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
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
                    {members.length === 0 && (
                      <p className="text-xs text-gray-400">担当者が登録されていません</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 備考 */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">備考</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="備考・メモ"
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
          </div>

          {/* 発注用具検索 */}
          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">発注用具</label>
            <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-2">
              <Search size={14} className="text-gray-400 shrink-0" />
              <input
                value={equipSearch}
                onChange={(e) => setEquipSearch(e.target.value)}
                placeholder="用具名・コードで検索して追加"
                className="flex-1 text-sm outline-none bg-transparent"
              />
              {equipSearch && (
                <button onClick={() => setEquipSearch("")}>
                  <X size={14} className="text-gray-400" />
                </button>
              )}
            </div>
            {filteredEquip.length > 0 ? (
              <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden max-h-44 overflow-y-auto">
                {(equipSearch ? filteredEquip : filteredEquip.slice(0, 20)).map((eq) => (
                  <button
                    key={eq.id}
                    onClick={() => { addItem(eq); setEquipSearch(""); }}
                    className="w-full px-3 py-2.5 text-left hover:bg-emerald-50 transition-colors border-b border-gray-50 last:border-0"
                  >
                    <p className="text-sm font-medium text-gray-800">{eq.name}</p>
                    <p className="text-xs text-gray-400">
                      {eq.product_code}
                      {eq.rental_price && ` ・ ¥${eq.rental_price.toLocaleString()}/月`}
                    </p>
                  </button>
                ))}
              </div>
            ) : equipSearch ? (
              <p className="text-xs text-gray-400 mt-2 px-1">「{equipSearch}」に一致する用具が見つかりません</p>
            ) : equipment.length === 0 ? (
              <p className="text-xs text-amber-500 mt-2 px-1">用具マスタにデータがありません。先にCSVインポートしてください。</p>
            ) : null}
          </div>

          {/* 選択済み用具 */}
          {items.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-emerald-700">✓ 選択中の用具</span>
                <span className="bg-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">{items.length}件</span>
              </div>
              {items.map((item, idx) => {
                const effectiveType = item.payment_type ?? paymentType;
                const isOverridden = item.payment_type !== null;
                return (
                  <div key={idx} className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 space-y-2">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-emerald-900">{item.equipment.name}</p>
                        <p className="text-xs text-emerald-600">{item.equipment.product_code}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <button
                          onClick={() => toggleItemPaymentType(idx)}
                          className={`text-[10px] px-2 py-0.5 rounded-full font-medium border transition-colors ${
                            isOverridden
                              ? "bg-amber-100 text-amber-700 border-amber-200"
                              : "bg-emerald-100 text-emerald-700 border-emerald-200"
                          }`}
                        >
                          {effectiveType}{isOverridden ? "（個別）" : ""}
                        </button>
                        <button onClick={() => removeItem(idx)} className="text-emerald-300 hover:text-red-400 transition-colors">
                          <X size={16} />
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="text-[10px] text-emerald-600">レンタル価格（円/月）</label>
                        <input
                          value={item.rental_price}
                          onChange={(e) => updateItem(idx, "rental_price", e.target.value)}
                          placeholder="15000"
                          type="number"
                          className="w-full border border-emerald-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-[10px] text-emerald-600">備考</label>
                        <input
                          value={item.notes}
                          onChange={(e) => updateItem(idx, "notes", e.target.value)}
                          placeholder="サイズ等"
                          className="w-full border border-emerald-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              {error}
            </div>
          )}
        </div>

        <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0">
          <button
            onClick={handleSubmit}
            disabled={loading || items.length === 0}
            className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            発注を登録する
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Order Email Preview Modal ───────────────────────────────────────────────

/** 発注内容を構造化（確認画面・メール共用） */
function buildStatusChangeContent(
  emailType: "rental_started" | "terminated",
  order: Order,
  orderItems: OrderItem[],
  client: Client | undefined,
  equipment: Equipment[],
  isResend: boolean
) {
  const clientName = client?.name ?? "（未設定）";
  const clientAddress = client?.address ?? "（未設定）";
  const changedItem = orderItems.find((i) => i.status === emailType);
  const allItems = orderItems.filter((i) => i.status !== "cancelled");
  const itemLines = allItems.map((i, idx) => {
    const eq = equipment.find((e) => e.product_code === i.product_code);
    return `${idx + 1}. ${eq?.name ?? i.product_code}`;
  });
  const resendMark = isResend ? "（再送）" : "";

  if (emailType === "rental_started") {
    const startDate = changedItem?.rental_start_date ?? null;
    const startDateStr = startDate
      ? new Date(startDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未設定";
    const subject = `【レンタル開始${resendMark}】${clientName} 様`;
    const preview = [`利用者：${clientName}`, `住所：${clientAddress}`, "", "── 品目 ──", ...itemLines, "", `レンタル開始日：${startDateStr}`].join("\n");
    const emailBody = [
      `【レンタル開始${resendMark}】`, "", "お疲れ様です。",
      "下記の通り、福祉用具のレンタルが開始となりましたのでご連絡いたします。",
      "────────────────────",
      `利用者名：${clientName}`, `住　　所：${clientAddress}`, "",
      "▼ 対象品目", ...itemLines.map((l) => `  ${l}`), "",
      `レンタル開始日：${startDateStr}`,
      "────────────────────", "", "よろしくお願いいたします。",
    ].join("\n");
    return { subject, preview, emailBody };
  } else {
    const endDate = changedItem?.rental_end_date ?? null;
    const endDateStr = endDate
      ? new Date(endDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未設定";
    const subject = `【解約・返却${resendMark}】${clientName} 様`;
    const preview = [`利用者：${clientName}`, `住所：${clientAddress}`, "", "── 返却品目 ──", ...itemLines, "", `解約日：${endDateStr}`].join("\n");
    const emailBody = [
      `【解約・返却${resendMark}】`, "", "お疲れ様です。",
      "下記の福祉用具につきまして、解約・返却のご連絡をいたします。",
      "────────────────────",
      `利用者名：${clientName}`, `住　　所：${clientAddress}`, "",
      "▼ 返却品目", ...itemLines.map((l) => `  ${l}`), "",
      `解約日：${endDateStr}`,
      "────────────────────", "", "お引き取りのほど、よろしくお願いいたします。",
    ].join("\n");
    return { subject, preview, emailBody };
  }
}

function buildOrderContent(
  order: Order,
  orderItems: OrderItem[],
  client: Client | undefined,
  equipment: Equipment[],
  members: Member[],
  isResend: boolean
) {
  const clientName = client?.name ?? "（未設定）";
  const clientAddress = client?.address ?? "（未設定）";
  const activeItems = orderItems.filter((i) => i.status !== "cancelled");
  const itemLines = activeItems.map((i, idx) => {
    const eq = equipment.find((e) => e.product_code === i.product_code);
    const name = eq?.name ?? i.product_code;
    const price = i.rental_price ? `¥${i.rental_price.toLocaleString()}/月` : "";
    const pt = i.payment_type ?? order.payment_type;
    return `${idx + 1}. ${name}${price ? `　${price}` : ""}　[${pt}]`;
  });

  const deliveryDateStr = order.delivery_date
    ? new Date(order.delivery_date).toLocaleDateString("ja-JP", {
        year: "numeric", month: "long", day: "numeric", weekday: "short",
      })
    : "未設定";
  const deliveryTimeStr = order.delivery_time ?? "未設定";
  const attendeeNames =
    order.attendee_ids.length > 0
      ? order.attendee_ids.map((id) => members.find((m) => m.id === id)?.name ?? id).join("・")
      : "未定";
  const attendanceStr =
    order.delivery_type === "直納"
      ? order.attendance_required ? `あり（${attendeeNames}）` : "なし"
      : "―";

  const resendMark = isResend ? "（再送）" : "";
  const subject = `【発注依頼${resendMark}】${clientName} 様`;

  /** 確認画面用：シンプルな内容のみ */
  const preview = [
    `利用者：${clientName}`,
    `住所：${clientAddress}`,
    "",
    "── 発注品目 ──",
    ...itemLines,
    "",
    "── 配送 ──",
    `方法：${order.delivery_type}`,
    `日時：${deliveryDateStr}　${deliveryTimeStr}`,
    ...(order.delivery_type === "直納" ? [`立ち会い：${attendanceStr}`] : []),
    ...(order.notes ? ["", `備考：${order.notes}`] : []),
  ].join("\n");

  /** メール・印刷用：フォーマルな文言付き */
  const emailBody = [
    `【発注依頼${resendMark}】`,
    "",
    "お疲れ様です。",
    "下記の通り、福祉用具の発注をお願いいたします。",
    "────────────────────",
    `利用者名：${clientName}`,
    `住　　所：${clientAddress}`,
    "",
    "▼ 発注品目",
    ...itemLines.map((l) => `  ${l}`),
    "",
    "▼ 配送情報",
    `配送方法：${order.delivery_type}`,
    `配送予定：${deliveryDateStr}　${deliveryTimeStr}`,
    ...(order.delivery_type === "直納" ? [`立ち会い：${attendanceStr}`] : []),
    "────────────────────",
    ...(order.notes ? ["", "【備考】", order.notes] : []),
    "",
    "ご確認のほど、よろしくお願いいたします。",
  ].join("\n");

  return { subject, preview, emailBody };
}

function OrderEmailPreviewModal({
  order,
  orderItems,
  clients,
  equipment,
  suppliers,
  members,
  emailType = "new_order",
  onClose,
  onBack,
  onDone,
}: {
  order: Order;
  orderItems: OrderItem[];
  clients: Client[];
  equipment: Equipment[];
  suppliers: Supplier[];
  members: Member[];
  emailType?: "new_order" | "rental_started" | "terminated";
  onClose: () => void;
  onBack?: () => void;
  onDone: () => void;
}) {
  const isResend = (order.email_sent_count ?? 0) > 0;
  const client = clients.find((c) => c.id === order.client_id);
  const supplier = suppliers.find((s) => s.id === order.supplier_id);
  const { subject, preview, emailBody } =
    emailType === "new_order"
      ? buildOrderContent(order, orderItems, client, equipment, members, isResend)
      : buildStatusChangeContent(emailType, order, orderItems, client, equipment, isResend);

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSendEmail = async () => {
    if (!supplier?.email) {
      setError("卸会社のメールアドレスが設定されていません。設定タブで登録してください。");
      return;
    }
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/send-order-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: supplier.email, subject, body: emailBody }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await recordEmailSent(order.id);
      setSent(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setSending(false);
    }
  };

  const handlePrint = () => {
    const win = window.open("", "_blank", "width=700,height=800");
    if (!win) return;
    win.document.write(`
      <html><head><title>発注書</title>
      <style>body{font-family:sans-serif;padding:32px;white-space:pre-wrap;font-size:14px;line-height:1.7;}</style>
      </head><body>${subject}\n\n${emailBody}</body></html>
    `);
    win.document.close();
    win.print();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end z-50">
      <div className="bg-white w-full rounded-t-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div>
            <h3 className="font-semibold text-gray-800">
              発注内容確認{isResend && <span className="ml-2 text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">再送</span>}
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">
              送信先：{supplier ? `${supplier.name}${supplier.email ? `（${supplier.email}）` : "（メール未設定）"}` : "卸会社未選択"}
            </p>
          </div>
          <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </div>

        {/* 確認内容（シンプル表示） */}
        <div className="flex-1 overflow-y-auto p-4">
          <div className="bg-gray-50 rounded-xl p-4">
            <pre className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{preview}</pre>
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              {error}
            </div>
          )}

          {sent && (
            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-xl p-3">
              <CheckCircle2 size={14} />
              メールを送信しました
            </div>
          )}
        </div>

        {/* ボタン */}
        <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0 space-y-2">
          {sent ? (
            <button
              onClick={onDone}
              className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium flex items-center justify-center gap-2"
            >
              <CheckCircle2 size={16} />
              閉じる
            </button>
          ) : (
            <>
              <button
                onClick={handleSendEmail}
                disabled={sending}
                className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {isResend ? "再送信する" : "メール送信"}
              </button>
              <button
                onClick={handlePrint}
                className="w-full py-3 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium flex items-center justify-center gap-2"
              >
                <Printer size={16} />
                印刷（FAX用）
              </button>
              {onBack && (
                <button
                  onClick={onBack}
                  className="w-full py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors"
                >
                  ← 戻る
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

function SettingsTab({ tenantId }: { tenantId: string }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [emailMap, setEmailMap] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSuppliers().then((list) => {
      setSuppliers(list);
      const map: Record<string, string> = {};
      list.forEach((s) => { map[s.id] = s.email ?? ""; });
      setEmailMap(map);
    }).finally(() => setLoading(false));
  }, []);

  const handleSave = async (supplierId: string) => {
    setSaving(supplierId);
    setSaved(null);
    try {
      await updateSupplierEmail(supplierId, emailMap[supplierId] ?? "");
      setSaved(supplierId);
      setTimeout(() => setSaved(null), 2000);
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-emerald-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0">
        <h2 className="font-semibold text-gray-800">設定</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">卸会社メールアドレス</h3>
          <div className="space-y-3">
            {suppliers.map((s) => (
              <div key={s.id} className="bg-white rounded-xl p-4 space-y-2">
                <p className="text-sm font-semibold text-gray-800">{s.name}</p>
                <div className="flex gap-2">
                  <input
                    type="email"
                    value={emailMap[s.id] ?? ""}
                    onChange={(e) => setEmailMap({ ...emailMap, [s.id]: e.target.value })}
                    placeholder="example@wholesaler.co.jp"
                    className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                  />
                  <button
                    onClick={() => handleSave(s.id)}
                    disabled={saving === s.id}
                    className="shrink-0 px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center gap-1"
                  >
                    {saving === s.id ? <Loader2 size={14} className="animate-spin" /> : "保存"}
                  </button>
                </div>
                {saved === s.id && (
                  <p className="text-xs text-emerald-600 font-medium">✓ 保存完了しました</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
