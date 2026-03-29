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
  FileText,
  Lock,
} from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Client, Supplier, Member } from "@/lib/supabase";
import { getOrders, getOrderItems, updateOrderItemStatus, getAllOrderItemsByTenant, createOrder, createOrderItem, getMembers, recordEmailSent, updateSupplierEmail } from "@/lib/orders";
import { getEquipment, getSuppliers, importEquipment, parseEquipmentCSV, updateEquipment, createEquipmentItem, updateEquipmentSortOrders, type ImportResult } from "@/lib/equipment";
import { getClients } from "@/lib/clients";
import { getTenants, getTenantById, updateTenantInfo, type Tenant } from "@/lib/tenants";
import { verifyPin } from "@/lib/settings";

// ─── Status helpers ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<OrderItem["status"], string> = {
  ordered: "発注済",
  delivered: "納品済",
  trial: "納品済",          // 試用中は廃止→納品済と統一
  rental_started: "レンタル中",
  cancelled: "キャンセル",
  terminated: "解約済",
};

const STATUS_COLOR: Record<OrderItem["status"], string> = {
  ordered: "bg-blue-100 text-blue-700",
  delivered: "bg-purple-100 text-purple-700",
  trial: "bg-purple-100 text-purple-700", // 試用中=納品済扱い
  rental_started: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-gray-100 text-gray-500",
  terminated: "bg-red-100 text-red-600",
};

const NEXT_STATUSES: Record<OrderItem["status"], OrderItem["status"][]> = {
  ordered: ["delivered", "cancelled"],
  delivered: ["rental_started", "cancelled"], // 試用中は廃止
  trial: ["rental_started", "cancelled"],     // DB後方互換のため残す
  rental_started: ["terminated"],
  cancelled: [],
  terminated: [],
};

// ─── Company info ─────────────────────────────────────────────────────────────

type CompanyInfo = {
  businessNumber: string;
  companyName: string;
  companyAddress: string;
  tel: string;
  fax: string;
  staffName: string;
};

const COMPANY_INFO_DEFAULTS: CompanyInfo = {
  businessNumber: "0000000000",
  companyName: "○○福祉用具",
  companyAddress: "○○県○○市○○1-2-3",
  tel: "000-0000-0000",
  fax: "000-0000-0001",
  staffName: "担当者",
};

// ─── 和暦・単位数ヘルパー ──────────────────────────────────────────────────────

function toJapaneseEra(date: Date): string {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  if (y > 2019 || (y === 2019 && m >= 5)) return `令和${y - 2018}年${m}月${d}日`;
  if (y > 1989 || (y === 1989 && m >= 1 && d >= 8)) return `平成${y - 1988}年${m}月${d}日`;
  return `${y}年${m}月${d}日`;
}
function toJapaneseEraYM(year: number, month: number): string {
  if (year > 2019 || (year === 2019 && month >= 5)) return `令和${year - 2018}年${month}月`;
  if (year > 1989) return `平成${year - 1988}年${month}月`;
  return `${year}年${month}月`;
}

/**
 * 半月ルール単位数計算
 * ・1〜15日のいずれかに利用あり → 半月分単位数
 * ・16〜末日のいずれかに利用あり → 半月分単位数
 */
function calcMonthUnits(item: OrderItem, year: number, month: number): number | null {
  if (!item.rental_price) return null;
  if (item.status === "ordered" || item.status === "delivered" || item.status === "trial") return null;
  if (item.status === "cancelled") return 0;

  const fullUnits = Math.round(item.rental_price / 10);
  const halfUnits = Math.floor(fullUnits / 2);
  const remUnits  = fullUnits - halfUnits; // ceil(fullUnits / 2)

  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart  = new Date(year, month - 1, 1);
  const monthEnd    = new Date(year, month - 1, daysInMonth);
  const day15       = new Date(year, month - 1, 15);
  const day16       = new Date(year, month - 1, 16);

  const start = item.rental_start_date ? new Date(item.rental_start_date + "T00:00:00") : null;
  const end   = item.rental_end_date   ? new Date(item.rental_end_date   + "T00:00:00") : null;

  if (start && start > monthEnd)  return null; // 翌月以降開始
  if (end   && end   < monthStart) return 0;   // 先月以前終了

  // 上半期（1〜15日）に1日でも利用
  const inUpper = (!start || start <= day15) && (!end || end >= monthStart);
  // 下半期（16〜末日）に1日でも利用
  const inLower = (!start || start <= monthEnd) && (!end || end >= day16);

  return (inUpper ? halfUnits : 0) + (inLower ? remUnits : 0);
}

/** 報告書用短縮日付: R8.3.15 形式 */
function toShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (y > 2019 || (y === 2019 && m >= 5)) return `R${y - 2018}.${m}.${day}`;
  if (y > 1989 || (y === 1989 && m >= 1 && day >= 8)) return `H${y - 1988}.${m}.${day}`;
  return `S${y - 1925}.${m}.${day}`;
}

// 貸与報告書テーブルスタイル定数
const RPT_TD: React.CSSProperties = { border: "1px solid #aaa", padding: "2px 5px", verticalAlign: "middle" };
const RPT_TH: React.CSSProperties = { border: "1px solid #888", padding: "3px 4px", background: "#e8e8e8", textAlign: "center" as const, verticalAlign: "middle" };
const RPT_TABLE: React.CSSProperties = { borderCollapse: "collapse" as const, width: "100%" };

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

type PendingChange = {
  item: OrderItem;
  newStatus: OrderItem["status"];
  date?: string; // rental_start_date or rental_end_date
};

// ─── Main Page ──────────────────────────────────────────────────────────────

const PIN_AUTH_KEY = (tenantId: string) => `order_pin_verified_${tenantId}`;

export default function TenantPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: tenantId } = use(params);
  const [activeTab, setActiveTab] = useState<Tab>("orders");
  const [tenantName, setTenantName] = useState(tenantId);
  const [ordersDirty, setOrdersDirty] = useState(false);
  const [pendingTabChange, setPendingTabChange] = useState<Tab | null>(null);
  const [pinVerified, setPinVerified] = useState(false);
  const [pinChecked, setPinChecked] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);
  const [pinLoading, setPinLoading] = useState(false);

  useEffect(() => {
    getTenants().then((list) => {
      const found = list.find((t) => t.id === tenantId);
      if (found) setTenantName(found.name);
    });
  }, [tenantId]);

  // localStorageで認証済みか確認
  useEffect(() => {
    if (typeof window !== "undefined") {
      if (localStorage.getItem(PIN_AUTH_KEY(tenantId)) === "true") {
        setPinVerified(true);
      }
      setPinChecked(true);
    }
  }, [tenantId]);

  async function handlePinSubmit() {
    if (!pin.trim()) return;
    setPinLoading(true);
    setPinError(false);
    try {
      const ok = await verifyPin(pin.trim(), tenantId);
      if (ok) {
        localStorage.setItem(PIN_AUTH_KEY(tenantId), "true");
        setPinVerified(true);
      } else {
        setPinError(true);
        setPin("");
      }
    } finally {
      setPinLoading(false);
    }
  }

  // 初期チェック前はブランク
  if (!pinChecked) return null;

  // PIN未認証→ログイン画面
  if (!pinVerified) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-white flex items-center justify-center p-6">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-6 space-y-5">
          <div className="flex flex-col items-center gap-3">
            <div className="w-14 h-14 bg-emerald-100 rounded-2xl flex items-center justify-center">
              <Lock size={26} className="text-emerald-600" />
            </div>
            <div className="text-center">
              <h1 className="text-lg font-bold text-gray-800">用具・発注管理</h1>
              <p className="text-sm text-gray-400 mt-0.5">PINを入力してください</p>
            </div>
          </div>

          <div>
            <input
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setPinError(false); }}
              onKeyDown={(e) => e.key === "Enter" && handlePinSubmit()}
              autoFocus
              className={`w-full text-center text-xl tracking-widest border-2 rounded-xl px-4 py-3 focus:outline-none transition-colors ${
                pinError ? "border-red-400 bg-red-50" : "border-gray-200 focus:border-emerald-400"
              }`}
            />
            {pinError && <p className="text-xs text-red-500 mt-1.5 text-center">PINが正しくありません</p>}
          </div>

          <button
            onClick={handlePinSubmit}
            disabled={pinLoading || !pin.trim()}
            className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors flex items-center justify-center gap-2"
          >
            {pinLoading && <Loader2 size={16} className="animate-spin" />}
            ログイン
          </button>
        </div>
      </div>
    );
  }

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
        {activeTab === "orders" && <OrdersTab tenantId={tenantId} onDirtyChange={setOrdersDirty} />}
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
            onClick={() => {
              if (id !== activeTab && activeTab === "orders" && ordersDirty) {
                setPendingTabChange(id);
              } else {
                setActiveTab(id);
              }
            }}
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

      {/* 未保存確認ダイアログ */}
      {pendingTabChange && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-2xl shadow-xl p-5 w-full max-w-xs space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle size={20} className="text-amber-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-gray-800 text-sm">保存されていない変更があります</p>
                <p className="text-xs text-gray-500 mt-1">ステータス変更が保存されていません。このまま移動しますか？</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingTabChange(null)}
                className="flex-1 py-2.5 rounded-xl border border-gray-200 text-sm text-gray-600 font-medium"
              >
                キャンセル
              </button>
              <button
                onClick={() => { setActiveTab(pendingTabChange); setPendingTabChange(null); setOrdersDirty(false); }}
                className="flex-1 py-2.5 rounded-xl bg-amber-500 text-white text-sm font-medium"
              >
                移動する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Orders Tab ─────────────────────────────────────────────────────────────

function OrdersTab({ tenantId, onDirtyChange }: { tenantId: string; onDirtyChange: (dirty: boolean) => void }) {
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
  // 未保存変更ステージング
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  // 保存後メールモーダル用
  const [postSaveChanges, setPostSaveChanges] = useState<PendingChange[] | null>(null);

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

  // 未保存変更があるときにブラウザ離脱警告
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (pendingChanges.size > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pendingChanges]);

  // タブ切り替え警告用にdirty状態を親に通知
  useEffect(() => {
    onDirtyChange(pendingChanges.size > 0);
  }, [pendingChanges, onDirtyChange]);

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

  const handleStatusClick = (item: OrderItem, nextStatus: OrderItem["status"], parentOrder?: OrderWithItems) => {
    // 納品済・レンタル中・解約済は日付入力
    if (nextStatus === "delivered" || nextStatus === "rental_started" || nextStatus === "terminated") {
      let defaultDate = today;
      if (nextStatus === "rental_started" && parentOrder) {
        defaultDate = parentOrder.delivery_date ?? item.delivered_at ?? parentOrder.ordered_at?.split("T")[0] ?? today;
      }
      setDateInput({ item, nextStatus, date: defaultDate });
    } else {
      stageChange(item, nextStatus);
    }
  };

  /** ステータス変更をステージング（DBには保存しない） */
  const stageChange = (item: OrderItem, newStatus: OrderItem["status"], date?: string) => {
    setPendingChanges((prev) => {
      const next = new Map(prev);
      next.set(item.id, { item, newStatus, date });
      return next;
    });
    setDateInput(null);
  };

  // 旧 handleStatusChange は新規発注後のプレビューフローでは不要になったが
  // 引数互換のため残す（直接呼び出し箇所がないため内部でstageChangeへ移譲）
  const handleStatusChange = (item: OrderItem, newStatus: OrderItem["status"], date?: string) => {
    stageChange(item, newStatus, date);
  };

  /** 全ての未保存変更をまとめてDBに保存 */
  const handleSaveAll = async () => {
    if (pendingChanges.size === 0) return;
    setUpdatingId("__saving__");
    const saved: PendingChange[] = [];
    try {
      for (const [, change] of pendingChanges) {
        const extra: Record<string, string> = {};
        if (change.newStatus === "delivered" && change.date) extra.delivered_at = change.date;
        if (change.newStatus === "rental_started" && change.date) extra.rental_start_date = change.date;
        if (change.newStatus === "terminated" && change.date) extra.rental_end_date = change.date;
        await updateOrderItemStatus(
          change.item.id,
          change.newStatus,
          Object.keys(extra).length ? extra : undefined
        );
        saved.push(change);
      }
      setPendingChanges(new Map());
      setPostSaveChanges(saved);
      await load();
    } catch {
      alert("保存に失敗しました。もう一度試してください。");
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
      {/* Top bar: filter + new order + save */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-2 shrink-0">
        <button
          onClick={() => setShowNewOrder(true)}
          className="shrink-0 flex items-center gap-1 bg-emerald-500 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Plus size={14} />
          新規発注
        </button>
        {/* 未保存変更がある場合に保存ボタンを表示 */}
        {pendingChanges.size > 0 && (
          <button
            onClick={handleSaveAll}
            disabled={updatingId === "__saving__"}
            className="shrink-0 flex items-center gap-1.5 bg-amber-500 text-white text-xs font-semibold px-4 py-1.5 rounded-xl shadow-sm disabled:opacity-60 animate-pulse"
          >
            {updatingId === "__saving__" ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <CheckCircle2 size={14} />
            )}
            保存 ({pendingChanges.size}件)
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-2 overflow-x-auto shrink-0">
        {(["all", "ordered", "delivered", "rental_started", "terminated"] as const).map(
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
                        {/* 発注ヘッダー行 */}
                        <div className="px-4 py-2.5 flex items-center gap-2 hover:bg-gray-50 transition-colors">
                          {/* 折りたたみボタン（大部分） */}
                          <button
                            onClick={toggleExpand}
                            className="flex-1 text-left flex items-center gap-2 min-w-0"
                          >
                            <span className="text-xs text-gray-500">
                              {new Date(order.ordered_at).toLocaleDateString("ja-JP")}発注
                            </span>
                            <span className="text-xs text-gray-400">{activeItems.length}点</span>
                            {order.notes && (
                              <span className="text-xs text-gray-400 truncate max-w-[100px]">{order.notes}</span>
                            )}
                            {isOpen ? (
                              <ChevronDown size={16} className="text-gray-400 shrink-0 ml-1" />
                            ) : (
                              <ChevronRight size={16} className="text-gray-400 shrink-0 ml-1" />
                            )}
                          </button>
                          {/* メールアイコン（ツールチップ付き） */}
                          <button
                            onClick={(e) => { e.stopPropagation(); setPreviewOrder({ order, items: order.items }); }}
                            title={(order.email_sent_count ?? 0) > 0 ? `メール再送（${order.email_sent_count}回送信済）` : "発注メールを送信・印刷"}
                            className="shrink-0 p-1.5 rounded-lg text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                          >
                            <Mail size={15} />
                          </button>
                        </div>

                        {isOpen && (
                          <div className="px-3 pb-3 bg-gray-50">
                            {/* アイテム一覧（table で縦列を完全に揃える） */}
                            <table className="w-full table-fixed bg-white rounded-xl overflow-hidden text-left">
                              <tbody>
                                {order.items.map((item) => {
                                  const pending = pendingChanges.get(item.id);
                                  // 表示ステータス：未保存変更があれば仮表示
                                  const displayStatus = pending ? pending.newStatus : item.status;
                                  const displayDate = pending?.date;
                                  return (
                                  <Fragment key={item.id}>
                                    <tr className={`border-b border-dashed border-gray-200 last:border-0 ${pending ? "bg-amber-50" : ""}`}>
                                      {/* ステータス（最左列） */}
                                      <td className="pl-3 py-2 pr-2 w-[5.5rem] shrink-0">
                                        <div className="flex flex-col gap-0.5">
                                          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_COLOR[displayStatus]}`}>
                                            {STATUS_LABEL[displayStatus]}
                                          </span>
                                          {pending && (
                                            <span className="text-[10px] text-amber-600 font-semibold px-1">未保存</span>
                                          )}
                                        </div>
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
                                      {/* 納品日・開始・終了日（未保存分も仮表示） */}
                                      <td className="py-2 pr-3 text-xs text-gray-400 whitespace-nowrap">
                                        {(pending?.newStatus === "delivered" ? displayDate : item.delivered_at) && (
                                          <span className={`mr-2 ${pending?.newStatus === "delivered" ? "text-amber-600" : ""}`}>
                                            納品: {pending?.newStatus === "delivered" ? displayDate : item.delivered_at}
                                          </span>
                                        )}
                                        {(pending?.newStatus === "rental_started" ? displayDate : item.rental_start_date) && (
                                          <span className={`mr-2 ${pending?.newStatus === "rental_started" ? "text-amber-600" : ""}`}>
                                            開始: {pending?.newStatus === "rental_started" ? displayDate : item.rental_start_date}
                                          </span>
                                        )}
                                        {(pending?.newStatus === "terminated" ? displayDate : item.rental_end_date) && (
                                          <span className={pending?.newStatus === "terminated" ? "text-amber-600" : ""}>
                                            終了: {pending?.newStatus === "terminated" ? displayDate : item.rental_end_date}
                                          </span>
                                        )}
                                      </td>
                                      {/* アクションボタン（未保存中は取消ボタンのみ） */}
                                      <td className="py-2 pr-3 whitespace-nowrap">
                                        {pending ? (
                                          <button
                                            onClick={() => setPendingChanges((prev) => { const n = new Map(prev); n.delete(item.id); return n; })}
                                            className="text-xs px-3 py-1 rounded-full border border-gray-300 text-gray-500 hover:bg-gray-100"
                                          >
                                            取消
                                          </button>
                                        ) : NEXT_STATUSES[item.status].length > 0 && dateInput?.item.id !== item.id && (
                                          <div className="flex gap-1.5">
                                            {NEXT_STATUSES[item.status].map((next) => (
                                              <button
                                                key={next}
                                                disabled={updatingId === "__saving__"}
                                                onClick={() => handleStatusClick(item, next, order)}
                                                className={`text-xs px-3 py-1 rounded-full border font-medium transition-colors disabled:opacity-50 ${
                                                  next === "cancelled" || next === "terminated"
                                                    ? "border-red-200 text-red-500 hover:bg-red-50"
                                                    : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                                                }`}
                                              >
                                                {`→ ${STATUS_LABEL[next]}`}
                                              </button>
                                            ))}
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                    {/* 日付入力（レンタル開始・解約時） */}
                                    {dateInput?.item.id === item.id && (
                                      <tr>
                                        <td colSpan={6} className="px-3 pb-2">
                                          <div className="bg-emerald-50 rounded-xl p-3 space-y-2">
                                            <p className="text-xs font-medium text-emerald-700">
                                              {dateInput.nextStatus === "delivered" ? "納品日（任意）" : dateInput.nextStatus === "rental_started" ? "レンタル開始日" : "解約日"}を入力
                                            </p>
                                            <input
                                              type="date"
                                              value={dateInput.date}
                                              onChange={(e) => setDateInput({ ...dateInput, date: e.target.value })}
                                              className="w-full border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                                            />
                                            <div className="flex gap-2">
                                              <button
                                                disabled={dateInput.nextStatus !== "delivered" && !dateInput.date}
                                                onClick={() => handleStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date || undefined)}
                                                className="flex-1 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-1"
                                              >
                                                確定
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
                                  ); })}
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

      {/* 保存後ケアマネメールモーダル */}
      {postSaveChanges && (
        <PostSaveModal
          changes={postSaveChanges}
          clients={clients}
          equipment={equipment}
          orders={orders}
          onSendEmail={(order) => {
            setPostSaveChanges(null);
            setPreviewOrder({ order, items: order.items, emailType: "rental_started" });
          }}
          onClose={() => setPostSaveChanges(null)}
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
  type SortMode = "default" | "name" | "category" | "price_asc" | "price_desc";
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [dragId, setDragId] = useState<string | null>(null);
  const [localEquipment, setLocalEquipment] = useState<Equipment[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [orderChanged, setOrderChanged] = useState(false);
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

  // equipmentが変わったらlocalEquipmentも更新（デフォルト順）
  useEffect(() => {
    setLocalEquipment(equipment);
    setOrderChanged(false);
  }, [equipment]);

  const sortedEquipment = (() => {
    if (sortMode === "default") return localEquipment;
    const arr = [...localEquipment];
    if (sortMode === "name") arr.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    else if (sortMode === "category") arr.sort((a, b) => {
      const ca = a.category ?? "zzz", cb = b.category ?? "zzz";
      if (ca !== cb) return ca.localeCompare(cb, "ja");
      return a.name.localeCompare(b.name, "ja");
    });
    else if (sortMode === "price_asc") arr.sort((a, b) => (a.rental_price ?? 0) - (b.rental_price ?? 0));
    else if (sortMode === "price_desc") arr.sort((a, b) => (b.rental_price ?? 0) - (a.rental_price ?? 0));
    return arr;
  })();
  const filtered = sortedEquipment.filter((e) => matchEquipment(e, search));

  const handleDragStart = (id: string) => {
    if (sortMode !== "default") return;
    setDragId(id);
  };
  const handleDragOver = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!dragId || dragId === targetId || sortMode !== "default") return;
    setLocalEquipment((prev) => {
      const arr = [...prev];
      const fromIdx = arr.findIndex((x) => x.id === dragId);
      const toIdx   = arr.findIndex((x) => x.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
    setOrderChanged(true);
  };
  const handleDragEnd = () => setDragId(null);

  const saveOrder = async () => {
    setSavingOrder(true);
    try {
      const updates = localEquipment.map((e, i) => ({ id: e.id, sort_order: (i + 1) * 10 }));
      await updateEquipmentSortOrders(updates);
      setOrderChanged(false);
      await load();
    } catch {
      alert("並び順の保存に失敗しました");
    } finally {
      setSavingOrder(false);
    }
  };

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

      <div className="px-3 py-2 bg-white border-b border-gray-100 shrink-0 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs text-gray-400 mr-1">{filtered.length}件</p>
          {/* 並び替えボタン */}
          {(["default","name","category","price_asc","price_desc"] as const).map((mode) => {
            const labels: Record<string, string> = {
              default: "CSV順", name: "名前順", category: "カテゴリ順",
              price_asc: "価格↑", price_desc: "価格↓"
            };
            return (
              <button key={mode} onClick={() => setSortMode(mode)}
                className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                  sortMode === mode
                    ? "bg-emerald-500 text-white border-emerald-500"
                    : "bg-white text-gray-500 border-gray-200 hover:border-emerald-300"
                }`}>
                {labels[mode]}
              </button>
            );
          })}
          {/* 並び順保存ボタン（CSV順かつ変更あり時） */}
          {sortMode === "default" && orderChanged && (
            <button onClick={saveOrder} disabled={savingOrder}
              className="ml-auto flex items-center gap-1 text-xs bg-amber-500 text-white px-3 py-1 rounded-xl disabled:opacity-60">
              {savingOrder ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
              順番を保存
            </button>
          )}
        </div>
        {sortMode === "default" && (
          <p className="text-[10px] text-gray-400 mt-0.5">CSV順のとき行をドラッグして並び替え可能</p>
        )}
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
            <table className="w-full table-fixed bg-white text-left">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="pl-4 py-2 text-xs font-semibold text-gray-500">用具名</th>
                  <th className="py-2 px-3 text-xs font-semibold text-gray-500 w-[6.5rem]">コード</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-[10rem]">TAISコード</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-[7rem]">カテゴリ</th>
                  <th className="py-2 pr-2 text-xs font-semibold text-gray-500 w-[5.5rem] text-right">レンタル価格</th>
                  <th className="w-6"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dashed divide-gray-200">
                {filtered.map((item) => (
                  <tr key={item.id}
                    draggable={sortMode === "default"}
                    onDragStart={() => handleDragStart(item.id)}
                    onDragOver={(e) => handleDragOver(e, item.id)}
                    onDragEnd={handleDragEnd}
                    className={`hover:bg-gray-50 transition-colors cursor-pointer ${dragId === item.id ? "opacity-40" : ""}`}
                    onClick={() => setSelectedItem(item)}>
                    {/* 用具名 */}
                    <td className="pl-4 py-2.5 text-sm font-medium text-gray-800 max-w-0">
                      <span className="block truncate">{item.name}</span>
                    </td>
                    {/* コード */}
                    <td className="py-2.5 px-3 text-xs text-gray-400 whitespace-nowrap w-[6.5rem]">
                      {item.product_code}
                    </td>
                    {/* TAISコード */}
                    <td className="py-2.5 pr-3 text-xs text-gray-400 whitespace-nowrap w-[10rem]">
                      {item.tais_code ? `TAIS: ${item.tais_code}` : ""}
                    </td>
                    {/* カテゴリ */}
                    <td className="py-2.5 pr-3 whitespace-nowrap w-[7rem]">
                      {item.category && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${catColor(item.category)}`}>
                          {item.category}
                        </span>
                      )}
                    </td>
                    {/* レンタル価格 */}
                    <td className="py-2.5 pr-2 text-sm font-semibold text-emerald-600 whitespace-nowrap w-[5.5rem] text-right">
                      {item.rental_price ? `¥${item.rental_price.toLocaleString()}` : ""}
                      <span className="text-xs font-normal text-gray-400">{item.rental_price ? "/月" : ""}</span>
                    </td>
                    {/* 矢印 */}
                    <td className="py-2.5 pr-3 w-6">
                      <ChevronRight size={16} className="text-gray-300" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
  const [showReport, setShowReport] = useState(false);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);

  // 会社情報ロード
  useEffect(() => {
    getTenantById(tenantId).then((t) => {
      if (t) {
        setCompanyInfo({
          businessNumber: t.business_number ?? COMPANY_INFO_DEFAULTS.businessNumber,
          companyName:    t.company_name    ?? COMPANY_INFO_DEFAULTS.companyName,
          companyAddress: t.company_address ?? COMPANY_INFO_DEFAULTS.companyAddress,
          tel:            t.company_tel     ?? COMPANY_INFO_DEFAULTS.tel,
          fax:            t.company_fax     ?? COMPANY_INFO_DEFAULTS.fax,
          staffName:      t.staff_name      ?? COMPANY_INFO_DEFAULTS.staffName,
        });
      }
    });
  }, [tenantId]);

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

  // 用具行共通（ステータス変更ボタン付き）- table行として使用
  const ItemCard = ({ item, dim = false }: { item: OrderItem; dim?: boolean }) => (
    <Fragment>
      <tr className={dim ? "opacity-75" : ""}>
        {/* ステータス（左ボーダー付き） */}
        <td className={`pl-2 py-2 w-[5.5rem] border-l-4 ${dim ? "border-gray-200" : "border-emerald-400"}`}>
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${STATUS_COLOR[item.status]}`}>
            {STATUS_LABEL[item.status]}
          </span>
        </td>
        {/* 用具名 */}
        <td className="py-2 pr-2 max-w-0">
          <span className={`block truncate text-sm font-medium ${dim ? "text-gray-600" : "text-gray-800"}`}>
            {equipName(item.product_code)}
          </span>
        </td>
        {/* レンタル価格 */}
        <td className="py-2 pr-3 w-[6rem] whitespace-nowrap">
          {item.rental_price ? (
            <span className="text-sm font-bold text-emerald-600">
              ¥{item.rental_price.toLocaleString()}<span className="text-xs font-normal">/月</span>
            </span>
          ) : null}
        </td>
        {/* 開始・終了日 */}
        <td className="py-2 pr-2 w-[15rem] text-xs text-gray-400 whitespace-nowrap">
          {item.rental_start_date && <span className="mr-3">開始: {item.rental_start_date}</span>}
          {item.rental_end_date && <span>終了: {item.rental_end_date}</span>}
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
        </td>
      </tr>
      {/* 日付入力行 */}
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
                  onClick={() => execStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date)}
                  className="flex-1 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : "確定"}
                </button>
                <button onClick={() => setDateInput(null)} className="px-3 text-xs text-gray-400 border border-gray-200 rounded-lg">戻す</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
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
        <button
          onClick={() => setShowReport(true)}
          title="貸与提供報告書を作成"
          className="flex items-center gap-1.5 text-xs text-emerald-600 border border-emerald-200 px-2.5 py-1.5 rounded-xl hover:bg-emerald-50 transition-colors"
        >
          <FileText size={14} />
          報告書
        </button>
      </div>

      {/* 貸与報告書モーダル */}
      {showReport && (
        <RentalReportModal
          client={client}
          items={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          onClose={() => setShowReport(false)}
        />
      )}

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
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{pendingItems.map((i) => <ItemCard key={i.id} item={i} />)}</tbody></table>
            </section>
          )}
          {activeItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">レンタル中</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{activeItems.map((i) => <ItemCard key={i.id} item={i} />)}</tbody></table>
            </section>
          )}
          {historyItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">過去のレンタル</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{historyItems.map((i) => <ItemCard key={i.id} item={i} dim />)}</tbody></table>
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
              <p className="text-xs text-gray-400">{monthlyItems.filter(i => i.status !== "terminated").length}点レンタル中</p>
            </div>
            <button onClick={() => changeYearMonth(1)} className="p-2 hover:bg-gray-100 rounded-xl">
              <ChevronRight size={18} className="text-gray-500" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {monthlyItems.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">この月のレンタルはありません</p>
            ) : (() => {
              const activeMonthly = monthlyItems.filter((i) => i.status !== "terminated");
              const terminatedMonthly = monthlyItems.filter((i) => i.status === "terminated");
              const activeTotal = activeMonthly.reduce((s, i) => s + (i.rental_price ?? 0), 0);
              return (
                <>
                  {/* レンタル中 */}
                  {activeMonthly.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 px-1">レンタル中</p>
                      <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left">
                        <tbody className="divide-y divide-dashed divide-gray-200">
                          {activeMonthly.map((item) => <ItemCard key={item.id} item={item} />)}
                        </tbody>
                      </table>
                      {/* 月額合計 */}
                      <div className="bg-emerald-50 rounded-xl px-3 py-2.5 mt-2 flex items-center justify-between">
                        <span className="text-xs text-emerald-700 font-medium">月額合計</span>
                        <span className="text-base font-bold text-emerald-700">
                          ¥{activeTotal.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}
                  {/* 解約済 */}
                  {terminatedMonthly.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 px-1">解約済</p>
                      <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left">
                        <tbody className="divide-y divide-dashed divide-gray-200">
                          {terminatedMonthly.map((item) => <ItemCard key={item.id} item={item} dim />)}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              );
            })()}
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
  payment_type: "介護" | "自費" | null;
  supplier_id: string | null;
  quantity: number;
};

// ─── PostSaveModal ────────────────────────────────────────────────────────────

function PostSaveModal({
  changes,
  clients,
  equipment,
  orders,
  onSendEmail,
  onClose,
}: {
  changes: PendingChange[];
  clients: Client[];
  equipment: Equipment[];
  orders: OrderWithItems[];
  onSendEmail: (order: OrderWithItems) => void;
  onClose: () => void;
}) {
  const clientName = (id: string | null) =>
    id ? (clients.find((c) => c.id === id)?.name ?? id) : "利用者未設定";
  const equipName = (code: string) =>
    equipment.find((e) => e.product_code === code)?.name ?? code;
  const getOrder = (itemId: string) =>
    orders.find((o) => o.items.some((i) => i.id === itemId));

  // 利用者別にグループ化
  const grouped = (() => {
    const map = new Map<string, { clientId: string | null; changes: PendingChange[] }>();
    for (const c of changes) {
      const order = getOrder(c.item.id);
      const key = order?.client_id ?? "__none__";
      if (!map.has(key)) map.set(key, { clientId: order?.client_id ?? null, changes: [] });
      map.get(key)!.changes.push(c);
    }
    return Array.from(map.values());
  })();

  const statusLabel = (s: OrderItem["status"]) => STATUS_LABEL[s];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <CheckCircle2 size={18} className="text-emerald-500" />
          <h3 className="font-semibold text-gray-800">保存完了</h3>
          <button onClick={onClose} className="ml-auto"><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="px-4 py-3 max-h-[60vh] overflow-y-auto space-y-3">
          <p className="text-xs text-gray-500">以下の変更が保存されました。ケアマネにメールで通知できます。</p>
          {grouped.map((g, gi) => {
            const order = getOrder(g.changes[0].item.id);
            return (
              <div key={gi} className="bg-gray-50 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-800">{clientName(g.clientId)}</span>
                  {order && (
                    <button
                      onClick={() => onSendEmail(order)}
                      className="flex items-center gap-1 text-xs text-emerald-600 border border-emerald-200 px-2.5 py-1 rounded-xl hover:bg-emerald-50"
                    >
                      <Mail size={12} /> ケアマネにメール
                    </button>
                  )}
                </div>
                <ul className="space-y-1">
                  {g.changes.map((c, ci) => (
                    <li key={ci} className="text-xs text-gray-600 flex items-center gap-2">
                      <span className="text-gray-400">・</span>
                      <span className="flex-1 truncate">{equipName(c.item.product_code)}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_COLOR[c.newStatus]}`}>
                        {statusLabel(c.newStatus)}
                      </span>
                      {c.date && <span className="text-gray-400">{c.date}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
        <div className="px-4 py-3 border-t border-gray-100">
          <button
            onClick={onClose}
            className="w-full py-2 bg-gray-100 text-gray-600 text-sm font-medium rounded-xl"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const [showEquipModal, setShowEquipModal] = useState(false);
  const [equipModalSearch, setEquipModalSearch] = useState("");
  const [equipModalCategory, setEquipModalCategory] = useState<string | null>(null);
  const [equipModalSelected, setEquipModalSelected] = useState<{ equipment: Equipment; quantity: number }[]>([]);

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

  const FAVORITES_KEY = `equip_favorites_${tenantId}`;
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? "[]")); } catch { return new Set(); }
  });
  const toggleFavorite = (code: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = new Set(prev);
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
  }, []);

  const addItem = (eq: Equipment) => {
    if (items.find((i) => i.equipment.id === eq.id)) return;
    setItems([
      ...items,
      {
        equipment: eq,
        rental_price: eq.rental_price ? String(eq.rental_price) : "",
        notes: "",
        payment_type: null,
        supplier_id: supplierId || null,
        quantity: 1,
      },
    ]);
  };

  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const updateItem = (idx: number, field: "rental_price" | "notes" | "supplier_id", value: string | null) => {
    setItems(items.map((item, i) => (i === idx ? { ...item, [field]: value } : item)));
  };

  const updateQuantity = (idx: number, delta: number) => {
    setItems(items.map((item, i) => i === idx ? { ...item, quantity: Math.max(1, item.quantity + delta) } : item));
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
          supplierId: item.supplier_id || undefined,
          rentalPrice: item.rental_price ? parseFloat(item.rental_price) : undefined,
          notes: item.notes || undefined,
          paymentType: item.payment_type,
          quantity: item.quantity,
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
              {/* 介護 / 自費 */}
              <div className="shrink-0">
                <label className="text-xs font-medium text-gray-600 block mb-1.5">種別</label>
                <div className="flex gap-1.5">
                  {(["介護", "自費"] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setPaymentType(t)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${
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
              {/* 卸会社 */}
              <div className="shrink-0">
                <label className="text-xs font-medium text-gray-600 block mb-1.5">卸会社</label>
                <select
                  value={supplierId}
                  onChange={(e) => setSupplierId(e.target.value)}
                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm font-medium outline-none focus:border-emerald-400 bg-white text-gray-600 h-[38px]"
                >
                  <option value="">選択しない</option>
                  {suppliers.map((s) => (
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
            </div>

            {/* 利用者 */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1.5">利用者 <span className="text-red-400">*必須</span></label>
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
                  {showClientList && (
                    <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden max-h-40 overflow-y-auto bg-white">
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
          </div>

          {/* ── 納品情報 ── */}
          <div className="bg-gray-50 rounded-2xl p-3 space-y-3">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">納品情報</p>

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

            {/* 立ち会い（直納のみ） */}
            {deliveryType === "直納" && (
              <div className="flex gap-3 items-end">
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
              </div>
            )}
            {deliveryType === "直納" && attendanceRequired && (
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-1.5">立ち会い担当者</label>
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

            {/* 用具追加ボタン */}
            <div>
              <button
                onClick={() => { setShowEquipModal(true); setEquipModalSearch(""); setEquipModalCategory(null); setEquipModalSelected([]); }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-emerald-300 text-emerald-700 text-sm font-medium bg-emerald-50 hover:bg-emerald-100 transition-colors"
              >
                <Plus size={15} />
                用具を追加
              </button>
              {equipment.length === 0 && (
                <p className="text-xs text-amber-500 mt-2 px-1">用具マスタにデータがありません。先にCSVインポートしてください。</p>
              )}
            </div>

            {/* 選択済み用具 */}
            {items.length > 0 && (
              <div className="bg-white border border-emerald-200 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 border-b border-emerald-100 bg-emerald-50">
                  <span className="text-xs font-semibold text-emerald-700">✓ 選択中の用具</span>
                  <span className="bg-emerald-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">{items.length}件</span>
                </div>
                <table className="w-full table-fixed text-left">
                  <thead className="bg-gray-50 border-b border-gray-100">
                    <tr>
                      <th className="pl-3 py-1.5 text-[10px] font-semibold text-gray-400">用具名</th>
                      <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[5rem]">個数</th>
                      <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[6.5rem]">卸会社</th>
                      <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[5.5rem]">価格(円/月)</th>
                      <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[5rem]">備考</th>
                      <th className="py-1.5 px-1 text-[10px] font-semibold text-gray-400 w-[3rem]">種別</th>
                      <th className="w-7"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {items.map((item, idx) => {
                      const effectiveType = item.payment_type ?? paymentType;
                      const isTypeOverridden = item.payment_type !== null;
                      return (
                        <tr key={idx}>
                          <td className="pl-3 py-2 max-w-0">
                            <p className="text-xs font-semibold text-gray-800 truncate">{item.equipment.name}</p>
                            <p className="text-[10px] text-gray-400">{item.equipment.product_code}</p>
                          </td>
                          <td className="py-2 px-1 w-[5rem]">
                            <div className="flex items-center gap-0.5">
                              <button onClick={() => updateQuantity(idx, -1)} className="w-5 h-5 rounded-full bg-gray-100 text-gray-600 text-xs font-bold flex items-center justify-center hover:bg-gray-200">−</button>
                              <span className="w-5 text-center text-xs font-semibold text-gray-800">{item.quantity}</span>
                              <button onClick={() => updateQuantity(idx, 1)} className="w-5 h-5 rounded-full bg-gray-100 text-gray-600 text-xs font-bold flex items-center justify-center hover:bg-gray-200">＋</button>
                            </div>
                          </td>
                          <td className="py-2 px-1 w-[6.5rem]">
                            <select
                              value={item.supplier_id ?? ""}
                              onChange={(e) => updateItem(idx, "supplier_id", e.target.value || null)}
                              className="w-full border border-gray-200 rounded-lg px-1.5 py-1 text-[11px] outline-none focus:border-emerald-400 bg-white text-gray-600"
                            >
                              <option value="">なし</option>
                              {suppliers.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
                              ))}
                            </select>
                          </td>
                          <td className="py-2 px-1 w-[5.5rem]">
                            <input
                              value={item.rental_price}
                              onChange={(e) => updateItem(idx, "rental_price", e.target.value)}
                              placeholder="—"
                              type="number"
                              className="w-full border border-gray-200 rounded-lg px-1.5 py-1 text-[11px] outline-none focus:border-emerald-400 bg-white"
                            />
                          </td>
                          <td className="py-2 px-1 w-[5rem]">
                            <input
                              value={item.notes}
                              onChange={(e) => updateItem(idx, "notes", e.target.value)}
                              placeholder="—"
                              className="w-full border border-gray-200 rounded-lg px-1.5 py-1 text-[11px] outline-none focus:border-emerald-400 bg-white"
                            />
                          </td>
                          <td className="py-2 px-1 w-[3rem]">
                            <button
                              onClick={() => toggleItemPaymentType(idx)}
                              className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium border transition-colors whitespace-nowrap ${
                                isTypeOverridden
                                  ? "bg-amber-100 text-amber-700 border-amber-200"
                                  : "bg-emerald-100 text-emerald-700 border-emerald-200"
                              }`}
                            >
                              {effectiveType}
                            </button>
                          </td>
                          <td className="py-2 pr-2 w-7 text-right">
                            <button onClick={() => removeItem(idx)} className="text-gray-300 hover:text-red-400 transition-colors">
                              <X size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
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
            onClick={handleSubmit}
            disabled={loading || items.length === 0}
            className="w-full bg-emerald-500 text-white py-3 rounded-xl font-medium text-sm disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
            発注を登録する
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
                      <th className="pl-1 py-1.5 text-[10px] font-semibold text-gray-400 w-[5rem]">種目</th>
                      <th className="py-1.5 px-2 text-[10px] font-semibold text-gray-400">用具名</th>
                      <th className="py-1.5 px-2 text-[10px] font-semibold text-gray-400 w-[6rem]">コード</th>
                      <th className="py-1.5 pr-3 text-[10px] font-semibold text-gray-400 w-[5.5rem] text-right">価格/月</th>
                      <th className="w-8"></th>
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
                          <td className="pl-1 py-2 w-[5rem]">
                            {eq.category && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 font-medium">
                                {eq.category}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-2 max-w-0">
                            <p className={`text-sm font-medium truncate ${sel ? "text-emerald-800" : "text-gray-800"}`}>{eq.name}</p>
                          </td>
                          <td className="py-2 px-2 text-[11px] text-gray-400 w-[6rem] whitespace-nowrap">{eq.product_code}</td>
                          <td className="py-2 pr-2 text-sm font-semibold text-emerald-600 w-[5.5rem] text-right whitespace-nowrap">
                            {eq.rental_price ? `¥${eq.rental_price.toLocaleString()}` : ""}
                          </td>
                          {/* 個数 or チェック */}
                          <td className="py-2 pr-2 w-[6rem] text-right" onClick={(e) => e.stopPropagation()}>
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
                  setItems((prev) => [
                    ...prev,
                    ...equipModalSelected
                      .filter((sel) => !prev.some((it) => it.equipment.product_code === sel.equipment.product_code))
                      .map((sel) => ({
                        equipment: sel.equipment,
                        rental_price: sel.equipment.rental_price != null ? String(sel.equipment.rental_price) : "",
                        notes: "",
                        payment_type: null,
                        supplier_id: supplierId || null,
                        quantity: sel.quantity,
                      })),
                  ]);
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

  // 卸会社ごとにアイテムをグループ化（new_order のみ）
  const supplierGroups: { supplierId: string | null; supplier: Supplier | undefined; items: OrderItem[] }[] = [];
  if (emailType === "new_order") {
    const activeItems = orderItems.filter((i) => i.status !== "cancelled");
    const groupMap = new Map<string, OrderItem[]>();
    for (const item of activeItems) {
      const key = item.supplier_id ?? order.supplier_id ?? "__none__";
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(item);
    }
    for (const [key, items] of groupMap) {
      const supplierId = key === "__none__" ? null : key;
      supplierGroups.push({ supplierId, supplier: suppliers.find((s) => s.id === supplierId), items });
    }
  }

  // 送信状態を卸会社IDごとに管理
  const [sentSet, setSentSet] = useState<Set<string>>(new Set());
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  // ステータス変更メール用（単一）
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const sendToSupplier = async (groupKey: string, supplierObj: Supplier | undefined, items: OrderItem[]) => {
    if (!supplierObj?.email) {
      setErrors((prev) => new Map(prev).set(groupKey, "メールアドレスが設定されていません"));
      return;
    }
    setSendingId(groupKey);
    setErrors((prev) => { const n = new Map(prev); n.delete(groupKey); return n; });
    const { subject, emailBody } = buildOrderContent(order, items, client, equipment, members, isResend);
    try {
      const res = await fetch("/api/send-order-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: supplierObj.email, subject, body: emailBody }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      await recordEmailSent(order.id);
      setSentSet((prev) => new Set(prev).add(groupKey));
    } catch (e: unknown) {
      setErrors((prev) => new Map(prev).set(groupKey, e instanceof Error ? e.message : "送信に失敗しました"));
    } finally {
      setSendingId(null);
    }
  };

  const sendAll = async () => {
    for (const g of supplierGroups) {
      const key = g.supplierId ?? "__none__";
      if (!sentSet.has(key)) await sendToSupplier(key, g.supplier, g.items);
    }
  };

  // ステータス変更メール送信（単一）
  const { subject: scSubject, preview: scPreview, emailBody: scEmailBody } =
    emailType !== "new_order"
      ? buildStatusChangeContent(emailType, order, orderItems, client, equipment, isResend)
      : { subject: "", preview: "", emailBody: "" };

  const handleSendStatusEmail = async () => {
    const supplier = suppliers.find((s) => s.id === order.supplier_id);
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
        body: JSON.stringify({ to: supplier.email, subject: scSubject, body: scEmailBody }),
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
    const groups = emailType === "new_order" ? supplierGroups : null;
    const win = window.open("", "_blank", "width=700,height=800");
    if (!win) return;
    const content = groups
      ? groups.map((g) => {
          const { subject, emailBody } = buildOrderContent(order, g.items, client, equipment, members, isResend);
          return `${subject}\n\n${emailBody}`;
        }).join("\n\n" + "─".repeat(40) + "\n\n")
      : `${scSubject}\n\n${scEmailBody}`;
    win.document.write(`<html><head><title>発注書</title>
      <style>body{font-family:sans-serif;padding:32px;white-space:pre-wrap;font-size:14px;line-height:1.7;}</style>
      </head><body>${content}</body></html>`);
    win.document.close();
    win.print();
  };

  const allSent = emailType === "new_order"
    ? supplierGroups.every((g) => sentSet.has(g.supplierId ?? "__none__"))
    : sent;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end z-50">
      <div className="bg-white w-full rounded-t-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <h3 className="font-semibold text-gray-800">
            発注内容確認{isResend && <span className="ml-2 text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">再送</span>}
          </h3>
          <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {emailType === "new_order" ? (
            /* 卸会社ごとにカード表示 */
            supplierGroups.map((g) => {
              const key = g.supplierId ?? "__none__";
              const { subject, preview } = buildOrderContent(order, g.items, client, equipment, members, isResend);
              const isSent = sentSet.has(key);
              const isSending = sendingId === key;
              const err = errors.get(key);
              return (
                <div key={key} className={`border rounded-xl overflow-hidden ${isSent ? "border-emerald-200 bg-emerald-50/30" : "border-gray-200"}`}>
                  <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
                    <div>
                      <p className="text-sm font-semibold text-gray-800">
                        {g.supplier?.name ?? "卸会社未設定"}
                      </p>
                      <p className="text-[11px] text-gray-400">
                        {g.supplier?.email ?? "メールアドレス未設定"} · {g.items.length}品目
                      </p>
                    </div>
                    {isSent ? (
                      <span className="flex items-center gap-1 text-xs text-emerald-600 font-medium">
                        <CheckCircle2 size={14} />送信済
                      </span>
                    ) : (
                      <button
                        onClick={() => sendToSupplier(key, g.supplier, g.items)}
                        disabled={isSending || sendingId !== null}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-xs font-medium rounded-lg disabled:opacity-40"
                      >
                        {isSending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                        送信
                      </button>
                    )}
                  </div>
                  <div className="px-3 py-2">
                    <pre className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">{preview}</pre>
                  </div>
                  {err && (
                    <div className="flex items-center gap-1.5 text-xs text-red-500 bg-red-50 px-3 py-2 border-t border-red-100">
                      <AlertCircle size={12} className="shrink-0" />{err}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            /* ステータス変更メール（単一） */
            <>
              <div className="bg-gray-50 rounded-xl p-4">
                <pre className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{scPreview}</pre>
              </div>
              {error && (
                <div className="flex items-start gap-2 text-xs text-red-500 bg-red-50 rounded-xl p-3">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />{error}
                </div>
              )}
              {sent && (
                <div className="flex items-center gap-2 text-xs text-emerald-600 bg-emerald-50 rounded-xl p-3">
                  <CheckCircle2 size={14} />メールを送信しました
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 pb-6 pt-3 border-t border-gray-100 shrink-0 space-y-2">
          {allSent ? (
            <button onClick={onDone} className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium flex items-center justify-center gap-2">
              <CheckCircle2 size={16} />閉じる
            </button>
          ) : emailType === "new_order" ? (
            <>
              {supplierGroups.length > 1 && (
                <button
                  onClick={sendAll}
                  disabled={sendingId !== null}
                  className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2"
                >
                  {sendingId !== null ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  全卸会社に一括送信
                </button>
              )}
              <button onClick={handlePrint} className="w-full py-3 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium flex items-center justify-center gap-2">
                <Printer size={16} />印刷（FAX用）
              </button>
              {onBack && <button onClick={onBack} className="w-full py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors">← 戻る</button>}
            </>
          ) : (
            <>
              <button onClick={handleSendStatusEmail} disabled={sending} className="w-full py-3 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2">
                {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                {isResend ? "再送信する" : "メール送信"}
              </button>
              <button onClick={handlePrint} className="w-full py-3 rounded-xl border border-gray-200 text-gray-600 text-sm font-medium flex items-center justify-center gap-2">
                <Printer size={16} />印刷（FAX用）
              </button>
              {onBack && <button onClick={onBack} className="w-full py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors">← 戻る</button>}
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

  // 会社情報
  const [company, setCompany] = useState({
    business_number: COMPANY_INFO_DEFAULTS.businessNumber,
    company_name:    COMPANY_INFO_DEFAULTS.companyName,
    company_address: COMPANY_INFO_DEFAULTS.companyAddress,
    company_tel:     COMPANY_INFO_DEFAULTS.tel,
    company_fax:     COMPANY_INFO_DEFAULTS.fax,
    staff_name:      COMPANY_INFO_DEFAULTS.staffName,
  });
  const [savingCompany, setSavingCompany] = useState(false);
  const [savedCompany, setSavedCompany] = useState(false);

  useEffect(() => {
    Promise.all([
      getSuppliers(),
      getTenantById(tenantId),
    ]).then(([list, tenant]) => {
      setSuppliers(list);
      const map: Record<string, string> = {};
      list.forEach((s) => { map[s.id] = s.email ?? ""; });
      setEmailMap(map);
      if (tenant) {
        setCompany({
          business_number: tenant.business_number ?? COMPANY_INFO_DEFAULTS.businessNumber,
          company_name:    tenant.company_name    ?? COMPANY_INFO_DEFAULTS.companyName,
          company_address: tenant.company_address ?? COMPANY_INFO_DEFAULTS.companyAddress,
          company_tel:     tenant.company_tel     ?? COMPANY_INFO_DEFAULTS.tel,
          company_fax:     tenant.company_fax     ?? COMPANY_INFO_DEFAULTS.fax,
          staff_name:      tenant.staff_name      ?? COMPANY_INFO_DEFAULTS.staffName,
        });
      }
    }).finally(() => setLoading(false));
  }, [tenantId]);

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

  const handleSaveCompany = async () => {
    setSavingCompany(true);
    setSavedCompany(false);
    try {
      await updateTenantInfo(tenantId, company);
      setSavedCompany(true);
      setTimeout(() => setSavedCompany(false), 2500);
    } finally {
      setSavingCompany(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 size={28} className="animate-spin text-emerald-400" />
      </div>
    );
  }

  const companyFields = [
    { key: "business_number", label: "指定事業所NO",  placeholder: "1234567890" },
    { key: "company_name",    label: "会社名",         placeholder: "○○福祉用具" },
    { key: "company_address", label: "所在地",         placeholder: "○○県○○市○○1-2-3" },
    { key: "company_tel",     label: "TEL",            placeholder: "000-0000-0000" },
    { key: "company_fax",     label: "FAX",            placeholder: "000-0000-0001" },
    { key: "staff_name",      label: "担当者名",       placeholder: "山田 太郎" },
  ] as const;

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0">
        <h2 className="font-semibold text-gray-800">設定</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-6">

        {/* 会社情報 */}
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">会社情報（貸与報告書に使用）</h3>
          <div className="bg-white rounded-xl p-4 space-y-3">
            {companyFields.map(({ key, label, placeholder }) => (
              <div key={key}>
                <label className="text-xs text-gray-500 block mb-1">{label}</label>
                <input
                  value={company[key]}
                  onChange={(e) => setCompany({ ...company, [key]: e.target.value })}
                  placeholder={placeholder}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
              </div>
            ))}
            <button
              onClick={handleSaveCompany}
              disabled={savingCompany}
              className="w-full py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center justify-center gap-2 mt-2"
            >
              {savingCompany ? <Loader2 size={14} className="animate-spin" /> : "会社情報を保存"}
            </button>
            {savedCompany && <p className="text-xs text-emerald-600 font-medium text-center">✓ 保存完了しました</p>}
          </div>
        </div>

        {/* 卸会社メールアドレス */}
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

// ─── Rental Report Modal ─────────────────────────────────────────────────────

const USAGE_TYPE_LABELS = ["新規納品", "追加納品", "一式回収", "一部回収", "特定福祉用具購入", "継続"] as const;
type UsageType = (typeof USAGE_TYPE_LABELS)[number];

const REQUEST_LABELS = [
  "保険証をお送りください。",
  "介護保険負担割合証をお送り下さい。",
  "上記内容のサービス計画書（1）〜（3）をお送り下さい。",
  "当月分のサービス提供票をお送りください。",
  "この度の変更後のサービス提供票をお送り下さい。",
];

function RentalReportModal({
  client,
  items,
  equipment,
  companyInfo,
  onClose,
}: {
  client: Client;
  items: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  onClose: () => void;
}) {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  const [targetMonth, setTargetMonth] = useState(
    `${today.getFullYear()}-${pad(today.getMonth() + 1)}`
  );
  const [visitDate, setVisitDate] = useState(
    `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  );
  const [selectedUsage, setSelectedUsage] = useState<Set<UsageType>>(new Set<UsageType>());
  const [memo, setMemo] = useState("");
  const [checkedReqs, setCheckedReqs] = useState<Set<number>>(new Set());

  const m1Year  = parseInt(targetMonth.split("-")[0]);
  const m1Month = parseInt(targetMonth.split("-")[1]);
  const m2next  = new Date(m1Year, m1Month, 1);
  const m2Year  = m2next.getFullYear();
  const m2Month = m2next.getMonth() + 1;

  const getEq = (code: string) => equipment.find((e) => e.product_code === code);

  const reportItems = items
    .filter((i) =>
      i.status === "rental_started" ||
      (i.status === "terminated" && i.rental_start_date) ||
      (i.status === "cancelled"  && i.rental_start_date)
    )
    .sort((a, b) => {
      const ca = getEq(a.product_code)?.category ?? "zzz";
      const cb = getEq(b.product_code)?.category ?? "zzz";
      if (ca !== cb) return ca.localeCompare(cb, "ja");
      return (getEq(a.product_code)?.name ?? "").localeCompare(getEq(b.product_code)?.name ?? "", "ja");
    });

  const careItems    = reportItems.filter((i) => i.payment_type !== "自費");
  const selfPayItems = reportItems.filter((i) => i.payment_type === "自費");

  const m1Total = careItems.reduce((s, i) => s + (calcMonthUnits(i, m1Year, m1Month) ?? 0), 0);
  const m2Total = careItems.reduce((s, i) => s + (calcMonthUnits(i, m2Year, m2Month) ?? 0), 0);

  // 貸与利用項目・訪問日は通常の和暦、表セル内は短縮形式
  const fmtDateFull  = (d: string | null) => d ? toJapaneseEra(new Date(d + "T00:00:00")) : "";
  const fmtDate      = (d: string | null) => d ? toShortDate(d) : "";

  useEffect(() => {
    const style = document.createElement("style");
    style.id = "__rpt_print__";
    style.textContent = `
      @media print {
        body > * { visibility: hidden !important; }
        #rental-report-modal, #rental-report-modal * { visibility: visible !important; }
        #rental-report-modal {
          position: fixed !important; top: 0 !important; left: 0 !important;
          width: 100% !important; height: auto !important;
          background: white !important; z-index: 99999 !important;
          overflow: visible !important;
        }
        .no-print { display: none !important; }
      }
    `;
    document.head.appendChild(style);
    return () => { document.getElementById("__rpt_print__")?.remove(); };
  }, []);

  // 対象月・アイテムが変わるたびに貸与利用項目を自動判定
  useEffect(() => {
    const [y, m] = targetMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const monthStart = `${targetMonth}-01`;
    const monthEnd   = `${targetMonth}-${String(lastDay).padStart(2, "0")}`;

    // レンタル実績のある全アイテム（キャンセル除く）
    const allRentalItems = items.filter(
      (i) => i.status !== "cancelled" && i.rental_start_date
    );
    // 対象月中に解約になったアイテム
    const terminatedThisMonth = allRentalItems.filter(
      (i) => i.status === "terminated" && i.rental_end_date &&
             i.rental_end_date >= monthStart && i.rental_end_date <= monthEnd
    );
    // 対象月中に契約開始したアイテム
    const startedThisMonth = allRentalItems.filter(
      (i) => i.rental_start_date! >= monthStart && i.rental_start_date! <= monthEnd
    );
    // 対象月をまたいで継続中のアイテム（前月以前に開始かつ解約なし or 月末以降に解約）
    const continuingItems = allRentalItems.filter(
      (i) => i.rental_start_date! < monthStart &&
             (!i.rental_end_date || i.rental_end_date > monthEnd)
    );

    const usage = new Set<UsageType>();

    // 解約判定：全件解約 → 一式回収、一部解約 → 一部回収
    if (terminatedThisMonth.length > 0) {
      const activeRemaining = allRentalItems.filter(
        (i) => i.status === "rental_started" ||
               (i.status === "terminated" && i.rental_end_date && i.rental_end_date > monthEnd)
      );
      if (activeRemaining.length === 0) {
        usage.add("一式回収");
      } else {
        usage.add("一部回収");
      }
    }

    // 新規・追加判定
    if (startedThisMonth.length > 0) {
      if (continuingItems.length > 0) {
        usage.add("追加納品");
      } else {
        usage.add("新規納品");
      }
    }

    // 継続判定
    if (continuingItems.length > 0) {
      usage.add("継続");
    }

    if (usage.size === 0) usage.add("継続");
    setSelectedUsage(usage);
  }, [targetMonth, items]);

  const EMPTY_CARE = Math.max(0, 8 - careItems.length);
  const EMPTY_SELF = Math.max(0, 4 - selfPayItems.length);

  return (
    <div id="rental-report-modal" className="fixed inset-0 bg-black/70 z-[60] flex flex-col">

      {/* 操作バー */}
      <div className="no-print bg-white border-b border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
        <button onClick={onClose}><X size={20} className="text-gray-500" /></button>
        <span className="font-semibold text-gray-800 flex-1">貸与提供報告書</span>
        <label className="text-xs text-gray-500">対象月</label>
        <input type="month" value={targetMonth} onChange={(e) => setTargetMonth(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none" />
        <label className="text-xs text-gray-500">訪問日</label>
        <input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none" />
        <button onClick={() => window.print()}
          className="flex items-center gap-1.5 bg-emerald-500 text-white px-4 py-2 rounded-xl text-sm font-medium">
          <Printer size={14} /> 印刷
        </button>
      </div>

      {/* 貸与利用項目トグル */}
      <div className="no-print bg-gray-50 border-b border-gray-100 px-4 py-2 flex flex-wrap gap-2 shrink-0">
        <span className="text-xs text-gray-500 self-center">貸与利用項目：</span>
        {USAGE_TYPE_LABELS.map((t) => (
          <button key={t}
            onClick={() => setSelectedUsage((prev) => {
              const next = new Set(prev);
              next.has(t) ? next.delete(t) : next.add(t);
              return next;
            })}
            className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${
              selectedUsage.has(t)
                ? "bg-red-100 text-red-700 border-red-300"
                : "bg-white text-gray-500 border-gray-200"
            }`}
          >
            {selectedUsage.has(t) ? `◯ ${t}` : t}
          </button>
        ))}
      </div>

      {/* 帳票本体 */}
      <div className="flex-1 overflow-y-auto bg-gray-100">
        <div className="max-w-4xl mx-auto my-6 bg-white shadow-lg px-10 py-8"
          style={{ fontFamily: "'MS Mincho','Yu Mincho','ＭＳ 明朝',serif", fontSize: "11pt", lineHeight: "1.5" }}>

          <h1 style={{ textAlign: "center", fontSize: "15pt", fontWeight: "bold", marginBottom: "18px" }}>
            （介護予防）福祉用具貸与提供報告書
          </h1>

          {/* 宛先 ↔ 会社情報 */}
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "14px" }}>
            <div style={{ fontSize: "10pt" }}>
              <div style={{ display: "flex", gap: "10px", alignItems: "flex-start", marginBottom: "10px" }}>
                <span>宛先</span>
                <div>
                  <p style={{ fontWeight: "bold" }}>{client.care_manager_org ?? "居宅介護支援センター"}&nbsp;&nbsp;御中</p>
                  <div style={{ borderBottom: "1px dotted #888", margin: "3px 0", width: "220px" }} />
                  <p>&emsp;{client.care_manager ?? "ケアマネジャー"}&nbsp;&nbsp;CM&nbsp;&nbsp;様</p>
                  <div style={{ borderBottom: "1px dotted #888", margin: "3px 0", width: "220px" }} />
                </div>
              </div>
              <p style={{ fontSize: "9pt", maxWidth: "320px", lineHeight: "1.7" }}>
                いつも大変お世話になっております。<br />
                ご依頼いただきましたサービス提供連絡及びご利用明細を送付致しますのでご確認をお願い申し上げます。
              </p>
            </div>
            <div style={{ textAlign: "right", fontSize: "9pt", minWidth: "190px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "8px", marginBottom: "5px" }}>
                <span>報告日</span>
                <span style={{ border: "1px solid #c53030", color: "#c53030", padding: "1px 8px", fontWeight: "bold" }}>
                  {fmtDateFull(visitDate)}
                </span>
              </div>
              <p style={{ color: "#666" }}>指定事業所NO/{companyInfo.businessNumber}</p>
              <p style={{ fontWeight: "bold", fontSize: "13pt", margin: "4px 0" }}>{companyInfo.companyName}</p>
              <p>{companyInfo.companyAddress}</p>
              <p>TEL {companyInfo.tel}&nbsp;&nbsp;FAX {companyInfo.fax}</p>
              <p>担当&nbsp;{companyInfo.staffName}</p>
            </div>
          </div>

          {/* 利用者・対象月 */}
          <table style={{ ...RPT_TABLE, marginBottom: "4px" }}>
            <tbody>
              <tr>
                <th style={{ ...RPT_TH, width: "100px" }}>ご利用者名</th>
                <td style={{ ...RPT_TD, textAlign: "center", fontWeight: "bold", fontSize: "13pt", width: "160px" }}>
                  {client.name}&nbsp;様
                </td>
                <th style={{ ...RPT_TH, width: "130px" }}>サービス提供対象月</th>
                <td style={{ ...RPT_TD, textAlign: "center" }}>
                  {toJapaneseEraYM(m1Year, m1Month)}・{m2Month}月分
                </td>
              </tr>
            </tbody>
          </table>

          {/* 貸与利用項目 */}
          <table style={{ ...RPT_TABLE, marginBottom: "14px" }}>
            <tbody>
              <tr>
                <th style={{ ...RPT_TH, width: "100px" }}>貸与利用項目</th>
                <td style={{ ...RPT_TD, padding: "5px 10px" }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "12px", fontSize: "10pt" }}>
                    {USAGE_TYPE_LABELS.map((t) =>
                      selectedUsage.has(t) ? (
                        <span key={t} style={{ border: "1px solid currentColor", borderRadius: "50%", padding: "0 8px", fontWeight: "bold" }}>{t}</span>
                      ) : (
                        <span key={t}>{t}</span>
                      )
                    )}
                    <span style={{ marginLeft: "16px" }}>訪問日&nbsp;{fmtDateFull(visitDate)}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          {/* 介護保険対象 */}
          <table style={{ ...RPT_TABLE, marginBottom: "4px", fontSize: "9pt" }}>
            <thead>
              <tr>
                <th style={{ ...RPT_TH, width: "60px" }}>種目</th>
                <th style={{ ...RPT_TH, width: "88px" }}>TAISコード</th>
                <th style={RPT_TH}>福祉用具名・仕様・規格</th>
                <th style={{ ...RPT_TH, width: "28px" }}>数量</th>
                <th style={{ ...RPT_TH, width: "72px" }}>月額<br />レンタル料金</th>
                <th style={{ ...RPT_TH, width: "86px" }}>契約日・解約日</th>
                <th style={{ ...RPT_TH, width: "50px" }}>{m1Month}月<br />単位数</th>
                <th style={{ ...RPT_TH, width: "50px" }}>{m2Month}月<br />単位数</th>
              </tr>
            </thead>
            <tbody>
              {careItems.map((item) => {
                const eq = getEq(item.product_code);
                const u1 = calcMonthUnits(item, m1Year, m1Month);
                const u2 = calcMonthUnits(item, m2Year, m2Month);
                return (
                  <tr key={item.id}>
                    <td style={RPT_TD}>{eq?.category ?? ""}</td>
                    <td style={RPT_TD}>{eq?.tais_code ?? ""}</td>
                    <td style={{ ...RPT_TD, color: "#0000cc" }}>{eq?.name ?? item.product_code}</td>
                    <td style={{ ...RPT_TD, textAlign: "center" }}>1</td>
                    <td style={{ ...RPT_TD, textAlign: "right" }}>¥{(item.rental_price ?? 0).toLocaleString()}</td>
                    <td style={{ ...RPT_TD, fontSize: "8.5pt", textAlign: "center", whiteSpace: "nowrap" }}>
                      {item.rental_start_date && <div>{fmtDate(item.rental_start_date)}&nbsp;契約</div>}
                      {item.rental_end_date   && <div>{fmtDate(item.rental_end_date)}&nbsp;解約</div>}
                    </td>
                    <td style={{ ...RPT_TD, textAlign: "right" }}>{u1 !== null ? u1 : ""}</td>
                    <td style={{ ...RPT_TD, textAlign: "right" }}>{u2 !== null ? u2 : ""}</td>
                  </tr>
                );
              })}
              {Array.from({ length: EMPTY_CARE }).map((_, i) => (
                <tr key={`ec${i}`}>
                  {Array.from({ length: 8 }).map((_, j) => <td key={j} style={{ ...RPT_TD, height: "22px" }} />)}
                </tr>
              ))}
              <tr>
                <td colSpan={6} style={{ ...RPT_TD, textAlign: "right", fontWeight: "bold" }}>合&nbsp;&nbsp;計</td>
                <td style={{ ...RPT_TD, textAlign: "right", fontWeight: "bold" }}>{m1Total || ""}</td>
                <td style={{ ...RPT_TD, textAlign: "right", fontWeight: "bold" }}>{m2Total || ""}</td>
              </tr>
            </tbody>
          </table>

          {/* 保険対象外（自費）レンタル */}
          <p style={{ fontSize: "9pt", fontWeight: "bold", margin: "10px 0 3px" }}>【保険対象外（自費）レンタル】</p>
          <table style={{ ...RPT_TABLE, marginBottom: "10px", fontSize: "9pt" }}>
            <thead>
              <tr>
                <th style={{ ...RPT_TH, width: "60px" }}>種目</th>
                <th style={RPT_TH}>福祉用具名・仕様・規格</th>
                <th style={{ ...RPT_TH, width: "80px" }}>初月利用者負担</th>
                <th style={{ ...RPT_TH, width: "86px" }}>契約日・解約日</th>
                <th style={{ ...RPT_TH, width: "80px" }}>月額レンタル料金（税込）</th>
              </tr>
            </thead>
            <tbody>
              {selfPayItems.map((item) => {
                const eq = getEq(item.product_code);
                return (
                  <tr key={item.id}>
                    <td style={RPT_TD}>{eq?.category ?? ""}</td>
                    <td style={{ ...RPT_TD, color: "#0000cc" }}>{eq?.name ?? item.product_code}</td>
                    <td style={RPT_TD} />
                    <td style={{ ...RPT_TD, fontSize: "8pt", textAlign: "center" }}>
                      {item.rental_start_date && <div>{fmtDate(item.rental_start_date)} 契約</div>}
                      {item.rental_end_date   && <div>{fmtDate(item.rental_end_date)} 解約</div>}
                    </td>
                    <td style={{ ...RPT_TD, textAlign: "right" }}>¥{(item.rental_price ?? 0).toLocaleString()}</td>
                  </tr>
                );
              })}
              {Array.from({ length: EMPTY_SELF }).map((_, i) => (
                <tr key={`es${i}`}>
                  {Array.from({ length: 5 }).map((_, j) => <td key={j} style={{ ...RPT_TD, height: "22px" }} />)}
                </tr>
              ))}
              <tr>
                <td colSpan={2} style={RPT_TD} />
                <td style={{ ...RPT_TD, textAlign: "right", fontWeight: "bold" }}>¥0</td>
                <td style={RPT_TD} />
                <td style={{ ...RPT_TD, textAlign: "right", fontWeight: "bold" }}>¥0</td>
              </tr>
            </tbody>
          </table>

          {/* 特定福祉用具購入履歴 */}
          <p style={{ fontSize: "9pt", fontWeight: "bold", margin: "10px 0 3px" }}>【特定福祉用具購入履歴】</p>
          <table style={{ ...RPT_TABLE, marginBottom: "16px", fontSize: "9pt" }}>
            <thead>
              <tr>
                <th style={{ ...RPT_TH, width: "80px" }}>種目</th>
                <th style={RPT_TH}>商品名</th>
                <th style={{ ...RPT_TH, width: "80px" }}>購入金額</th>
                <th style={{ ...RPT_TH, width: "90px" }}>購入日</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>{Array.from({ length: 4 }).map((_, j) => <td key={j} style={{ ...RPT_TD, height: "22px" }} />)}</tr>
              ))}
              <tr>
                <td colSpan={2} style={RPT_TD} />
                <td style={{ ...RPT_TD, textAlign: "right", fontWeight: "bold" }}>¥0</td>
                <td style={RPT_TD} />
              </tr>
            </tbody>
          </table>

          {/* フッター */}
          <div style={{ display: "flex", gap: "32px", alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <p style={{ fontSize: "9pt", marginBottom: "8px" }}>上記ご確認頂き、</p>
              <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                {REQUEST_LABELS.map((label, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "9pt" }}>
                    <span className="no-print"
                      onClick={() => setCheckedReqs((prev) => {
                        const next = new Set(prev); next.has(idx) ? next.delete(idx) : next.add(idx); return next;
                      })}
                      style={{ cursor: "pointer", userSelect: "none", fontSize: "14pt", lineHeight: "1" }}
                    >
                      {checkedReqs.has(idx) ? "☑" : "□"}
                    </span>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: "9pt", marginTop: "12px" }}>以上宜しくお願い申し上げます。</p>
            </div>
            <div style={{ width: "200px" }}>
              <p style={{ fontSize: "9pt", fontWeight: "bold", marginBottom: "4px" }}>【備考】</p>
              <textarea
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                className="no-print w-full border border-gray-300 rounded p-2"
                style={{ height: "90px", fontSize: "9pt", resize: "none" }}
                placeholder="備考欄"
              />
              {memo && (
                <p style={{ fontSize: "9pt", borderBottom: "1px solid #aaa", minHeight: "90px", whiteSpace: "pre-wrap" }}>
                  {memo}
                </p>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
