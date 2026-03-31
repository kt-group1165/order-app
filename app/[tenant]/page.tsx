"use client";

import { useState, useEffect, use, useCallback, Fragment, useRef, useMemo } from "react";
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
  Download,
  ClipboardCheck,
} from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Client, Supplier, Member, EquipmentPriceHistory, ClientDocument, ClientInsuranceRecord, ClientRentalHistory, MonitoringRecord, MonitoringItem } from "@/lib/supabase";
import { getClientDocuments, saveClientDocument, deleteClientDocument } from "@/lib/documents";
import { getOrders, getOrderItems, updateOrderItemStatus, getAllOrderItemsByTenant, createOrder, createOrderItem, getMembers, recordEmailSent, updateSupplierEmail } from "@/lib/orders";
import { getEquipment, getSuppliers, importEquipment, parseEquipmentCSV, updateEquipment, createEquipmentItem, updateEquipmentSortOrders, getPriceHistory, addPriceHistory, getPriceForMonth, type ImportResult } from "@/lib/equipment";
import { getClients } from "@/lib/clients";
import { getTenants, getTenantById, updateTenantInfo, type Tenant } from "@/lib/tenants";
import { verifyPin } from "@/lib/settings";
import { getCarePlanTemplates, upsertCarePlanTemplate, deleteCarePlanTemplate } from "@/lib/carePlanTemplates";
import { CarePlanTemplate } from "@/lib/supabase";

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
  ordered: ["delivered", "rental_started", "cancelled"],
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
  serviceArea: string;
  businessDays: string;
  businessHours: string;
  staffManagerFull: string;
  staffManagerPart: string;
  staffSpecialistFull: string;
  staffSpecialistPart: string;
  staffAdminFull: string;
  staffAdminPart: string;
};

const COMPANY_INFO_DEFAULTS: CompanyInfo = {
  businessNumber: "0000000000",
  companyName: "○○福祉用具",
  companyAddress: "○○県○○市○○1-2-3",
  tel: "000-0000-0000",
  fax: "000-0000-0001",
  staffName: "担当者",
  serviceArea: "",
  businessDays: "月〜土（祝日除く）",
  businessHours: "9:00〜17:00",
  staffManagerFull: "",
  staffManagerPart: "",
  staffSpecialistFull: "",
  staffSpecialistPart: "",
  staffAdminFull: "",
  staffAdminPart: "",
};

// ─── 和暦・単位数ヘルパー ──────────────────────────────────────────────────────

function toJapaneseEra(date: Date): string {
  if (isNaN(date.getTime())) return "";
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
function calcMonthUnits(item: OrderItem, year: number, month: number, priceOverride?: number): number | null {
  const price = priceOverride ?? item.rental_price;
  if (!price) return null;
  if (item.status === "ordered" || item.status === "delivered" || item.status === "trial") return null;
  if (item.status === "cancelled") return 0;

  const fullUnits = Math.round(price / 10);
  const halfUnits = Math.floor(fullUnits / 2);
  const remUnits  = fullUnits - halfUnits; // ceil(fullUnits / 2)

  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart  = new Date(year, month - 1, 1);
  const monthEnd    = new Date(year, month - 1, daysInMonth);
  const day15       = new Date(year, month - 1, 15);
  const day16       = new Date(year, month - 1, 16);

  const start = item.rental_start_date ? new Date(item.rental_start_date + "T00:00:00") : null;
  const end   = item.rental_end_date   ? new Date(item.rental_end_date   + "T00:00:00") : null;

  if (end   && end   < monthStart) return 0;   // 先月以前終了
  if (start && start > monthEnd) {
    // 解約済みで終了日が今月内なら半月ルール適用（開始日が来月以降の場合）
    if (item.status === "terminated" && end && end <= monthEnd) {
      return end <= day15 ? halfUnits : halfUnits + remUnits;
    }
    return null; // 翌月以降開始
  }

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
    .replace(/[\uFF01-\uFF5E]/g, (c) =>                   // 全角英数字・記号→半角
      String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, " ")                              // 全角スペース→半角
    .toLowerCase()
    .replace(/[\s　]+/g, "");                              // スペース除去

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

type Tab = "orders" | "equipment" | "clients" | "monitoring" | "settings";

type OrderWithItems = Order & { items: OrderItem[] };

// 6ヶ月後の月を計算 "YYYY-MM" → "YYYY-MM"
function calcNextDueMonth(base: string): string {
  const [y, m] = base.split("-").map(Number);
  const total = y * 12 + m - 1 + 6;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

type PendingChange = {
  item: OrderItem;
  newStatus: OrderItem["status"];
  date?: string;        // rental_start_date or rental_end_date
  deliveredAt?: string; // 発注済→レンタル開始ダイレクト時の納品日
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
  const [clientTabTarget, setClientTabTarget] = useState<string | null>(null);
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
        <span className="text-[10px] text-emerald-300 font-mono ml-1">v3.0</span>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "orders" && <OrdersTab tenantId={tenantId} onDirtyChange={setOrdersDirty} onSwitchToClient={(clientId) => { setClientTabTarget(clientId); setActiveTab("clients"); }} />}
        {activeTab === "equipment" && <EquipmentTab tenantId={tenantId} />}
        {activeTab === "clients" && <ClientsTab tenantId={tenantId} initialClientId={clientTabTarget} onClearInitialClient={() => setClientTabTarget(null)} />}
        {activeTab === "monitoring" && <MonitoringTab tenantId={tenantId} />}
        {activeTab === "settings" && <SettingsTab tenantId={tenantId} />}
      </div>

      {/* Bottom Nav */}
      <nav className="bg-white border-t border-gray-200 flex shrink-0">
        {(
          [
            { id: "orders", icon: ClipboardList, label: "発注管理" },
            { id: "equipment", icon: Package, label: "用具マスタ" },
            { id: "clients", icon: Users, label: "利用者別" },
            { id: "monitoring", icon: ClipboardCheck, label: "モニタリング" },
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

function OrdersTab({ tenantId, onDirtyChange, onSwitchToClient }: { tenantId: string; onDirtyChange: (dirty: boolean) => void; onSwitchToClient?: (clientId: string) => void }) {
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<OrderItem["status"] | "all">("all");
  const [showEnded, setShowEnded] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [previewOrder, setPreviewOrder] = useState<{ order: Order; items: OrderItem[]; emailType?: "new_order" | "rental_started" | "terminated" | "cancelled" } | null>(null);
  const [dateInput, setDateInput] = useState<{
    item: OrderItem;
    nextStatus: OrderItem["status"];
    date: string;
    deliveredAt?: string;
  } | null>(null);
  // 一括ステータス変更
  const [bulkDateInput, setBulkDateInput] = useState<{
    orderId: string;
    nextStatus: OrderItem["status"];
    date: string;
    deliveredAt?: string;
  } | null>(null);
  // 未保存変更ステージング
  const [pendingChanges, setPendingChanges] = useState<Map<string, PendingChange>>(new Map());
  // 保存後メールモーダル用
  const [postSaveChanges, setPostSaveChanges] = useState<PendingChange[] | null>(null);
  const [supplierSentIds, setSupplierSentIds] = useState<Set<string>>(new Set());
  const [careSentIds, setCareSentIds] = useState<Set<string>>(new Set());
  const [careManagerModal, setCareManagerModal] = useState<{
    client: Client;
    items: OrderItem[];
    companyInfo: CompanyInfo;
    priceHistory: EquipmentPriceHistory[];
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

    const cmpOrder = (a: OrderWithItems, b: OrderWithItems) => {
      const diff = new Date(b.ordered_at).getTime() - new Date(a.ordered_at).getTime();
      return diff !== 0 ? diff : new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    };

    const groups = Array.from(groupMap.entries()).map(([key, groupOrders]) => {
      const sorted = [...groupOrders].sort(cmpOrder);
      return {
        clientId: key === "__none__" ? null : key,
        name: key === "__none__" ? "利用者未設定" : (clients.find((c) => c.id === key)?.name ?? key),
        furigana: key === "__none__" ? "" : (clients.find((c) => c.id === key)?.furigana ?? ""),
        latestAt: sorted[0].ordered_at,
        latestCreatedAt: sorted[0].created_at,
        orders: sorted,
      };
    });

    // 直近活動順（ordered_at 同日の場合は created_at で比較）
    groups.sort((a, b) => {
      const diff = new Date(b.latestAt).getTime() - new Date(a.latestAt).getTime();
      return diff !== 0 ? diff : new Date(b.latestCreatedAt).getTime() - new Date(a.latestCreatedAt).getTime();
    });
    return groups;
  })();

  const today = new Date().toISOString().split("T")[0];

  const handleStatusClick = (item: OrderItem, nextStatus: OrderItem["status"], parentOrder?: OrderWithItems) => {
    if (nextStatus === "delivered" || nextStatus === "rental_started" || nextStatus === "terminated") {
      let defaultDate = today;
      if (nextStatus === "rental_started" && parentOrder) {
        defaultDate = parentOrder.delivery_date ?? item.delivered_at ?? parentOrder.ordered_at?.split("T")[0] ?? today;
      }
      // 発注済→レンタル開始ダイレクト：納品日も同時入力
      if (nextStatus === "rental_started" && item.status === "ordered") {
        setDateInput({ item, nextStatus, date: today, deliveredAt: today });
      } else {
        setDateInput({ item, nextStatus, date: defaultDate });
      }
    } else {
      stageChange(item, nextStatus);
    }
  };

  /** ステータス変更をステージング（DBには保存しない） */
  const stageChange = (item: OrderItem, newStatus: OrderItem["status"], date?: string, deliveredAt?: string) => {
    setPendingChanges((prev) => {
      const next = new Map(prev);
      next.set(item.id, { item, newStatus, date, deliveredAt });
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
        if (change.newStatus === "rental_started" && change.deliveredAt) extra.delivered_at = change.deliveredAt;
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
        tenantId={tenantId}
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
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-2 overflow-x-auto shrink-0">
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
        <label className="ml-auto shrink-0 flex items-center gap-1.5 cursor-pointer text-xs text-gray-500 whitespace-nowrap">
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
            className="accent-emerald-500 w-3.5 h-3.5"
          />
          キャンセル済み・解約済みを表示
        </label>
      </div>

      {/* Order list - 利用者グループ表示 */}
      <div className="flex-1 overflow-y-auto">
        {clientGroups.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">発注データがありません</p>
        ) : (
          <div>
            {clientGroups.map((group) => {
              const hasVisible = group.orders.some((o) =>
                showEnded ? true : o.items.some((i) => i.status !== "cancelled" && i.status !== "terminated")
              );
              if (!hasVisible) return null;
              return (
              <div key={group.clientId ?? "__none__"}>
                {/* 利用者ヘッダー */}
                <div className="bg-emerald-50 border-b border-emerald-100 px-4 py-2 flex items-center gap-2 sticky top-0 z-10">
                  <span className="text-sm font-bold text-emerald-800">{group.name}</span>
                  {group.furigana && (
                    <span className="text-xs text-emerald-500">{group.furigana}</span>
                  )}
                  {group.clientId && onSwitchToClient && (
                    <button
                      onClick={() => onSwitchToClient(group.clientId!)}
                      className="text-xs text-emerald-600 hover:text-emerald-800 hover:underline"
                    >
                      利用者情報へ
                    </button>
                  )}
                  <span className="ml-auto text-xs text-emerald-400">{group.orders.length}発注</span>
                </div>
                {/* その利用者の発注一覧 */}
                <ul className="flex flex-col gap-4 px-3 pb-3 pt-0">
                  {group.orders.map((order) => {
                    const visibleItems = showEnded
                      ? order.items
                      : order.items.filter((i) => i.status !== "cancelled" && i.status !== "terminated");
                    if (visibleItems.length === 0) return null;
                    const isOpen = expandedIds.has(order.id);
                    const activeItems = order.items.filter((i) => i.status !== "cancelled" && i.status !== "terminated");
                    const toggleExpand = () => setExpandedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(order.id)) next.delete(order.id);
                      else next.add(order.id);
                      return next;
                    });
                    return (
                      <li key={order.id} className="relative bg-white border border-gray-100 rounded-lg pl-1">
                        <div className="absolute left-0 top-2 bottom-5 w-1 rounded-r-full bg-emerald-400" />
                        <div className="overflow-x-auto">
                        {/* 発注ヘッダー行 */}
                        <div className="min-w-[600px] px-4 py-0.5 flex items-center gap-2 hover:bg-gray-50 transition-colors">
                          {/* 折りたたみボタン（固定幅） */}
                          <button
                            onClick={toggleExpand}
                            className="w-44 shrink-0 text-left flex items-center gap-2 min-w-0"
                          >
                            <span className="text-xs text-gray-500 whitespace-nowrap">
                              {new Date(order.ordered_at).toLocaleDateString("ja-JP")}発注
                            </span>
                            <span className="text-xs text-gray-400 whitespace-nowrap">{activeItems.length}点</span>
                            {isOpen ? (
                              <ChevronDown size={16} className="text-gray-400 shrink-0" />
                            ) : (
                              <ChevronRight size={16} className="text-gray-400 shrink-0" />
                            )}
                          </button>
                          {/* 一括操作ボタン（左寄せ） */}
                          {(() => {
                            const bulkTargets = (ns: OrderItem["status"]) =>
                              order.items.filter((i) => NEXT_STATUSES[i.status]?.includes(ns));
                            const buttons: { ns: OrderItem["status"]; label: string; count: number }[] = (
                              [
                                { ns: "delivered"      as const, label: "納品済",       count: bulkTargets("delivered").length },
                                { ns: "rental_started" as const, label: "レンタル開始", count: bulkTargets("rental_started").length },
                                { ns: "terminated"     as const, label: "解約",         count: bulkTargets("terminated").length },
                                { ns: "cancelled"      as const, label: "キャンセル",   count: bulkTargets("cancelled").length },
                              ] as { ns: OrderItem["status"]; label: string; count: number }[]
                            ).filter((b) => b.count >= 2);
                            if (buttons.length === 0) return null;
                            return (
                              <div className="flex gap-1 shrink-0">
                                {buttons.map(({ ns, label, count }) => (
                                  <button
                                    key={ns}
                                    disabled={updatingId === "__saving__"}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (bulkDateInput?.orderId === order.id && bulkDateInput?.nextStatus === ns) {
                                        setBulkDateInput(null);
                                      } else if (ns === "delivered" || ns === "rental_started" || ns === "terminated") {
                                        const isDirect = ns === "rental_started" && bulkTargets("rental_started").some((i) => i.status === "ordered");
                                        setBulkDateInput({ orderId: order.id, nextStatus: ns, date: today, deliveredAt: isDirect ? today : undefined });
                                        setExpandedIds((prev) => { const n = new Set(prev); n.add(order.id); return n; });
                                      } else {
                                        // キャンセルは日付不要
                                        for (const i of bulkTargets(ns)) stageChange(i, ns);
                                      }
                                    }}
                                    className={`text-xs px-2.5 py-0.5 rounded-full border font-medium transition-colors disabled:opacity-50 ${
                                      ns === "cancelled" || ns === "terminated"
                                        ? "border-red-200 text-red-500 hover:bg-red-50"
                                        : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                                    }`}
                                  >
                                    全{count}点→{label}
                                  </button>
                                ))}
                              </div>
                            );
                          })()}
                          {/* メールアイコン（右端） */}
                          <button
                            onClick={(e) => { e.stopPropagation(); setPreviewOrder({ order, items: order.items }); }}
                            title={(order.email_sent_count ?? 0) > 0 ? `メール再送（${order.email_sent_count}回送信済）` : "発注メールを送信・印刷"}
                            className="ml-auto shrink-0 p-1.5 rounded-lg text-emerald-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                          >
                            <Mail size={15} />
                          </button>
                        </div>
                        {/* 一括日付入力パネル */}
                        {bulkDateInput?.orderId === order.id && (
                          <div className="min-w-[600px] px-4 pb-2">
                            <div className="bg-emerald-50 rounded-xl p-3 space-y-2">
                              <p className="text-xs font-medium text-emerald-700">
                                {bulkDateInput.deliveredAt !== undefined ? "納品日・レンタル開始日を入力（一括）"
                                  : bulkDateInput.nextStatus === "delivered" ? "納品日を入力（一括）"
                                  : bulkDateInput.nextStatus === "rental_started" ? "レンタル開始日を入力（一括）"
                                  : "解約日を入力（一括）"}
                              </p>
                              {bulkDateInput.deliveredAt !== undefined ? (
                                <div className="space-y-1.5">
                                  <div className="flex gap-2 items-center">
                                    <span className="text-xs text-gray-500 w-24 shrink-0">納品日</span>
                                    <input type="date" value={bulkDateInput.deliveredAt}
                                      onChange={(e) => setBulkDateInput({ ...bulkDateInput, deliveredAt: e.target.value })}
                                      className="w-44 border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white" />
                                  </div>
                                  <div className="flex gap-2 items-center">
                                    <span className="text-xs text-gray-500 w-24 shrink-0">レンタル開始日</span>
                                    <input type="date" value={bulkDateInput.date}
                                      onChange={(e) => setBulkDateInput({ ...bulkDateInput, date: e.target.value })}
                                      className="w-44 border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white" />
                                  </div>
                                </div>
                              ) : (
                                <input type="date" value={bulkDateInput.date}
                                  onChange={(e) => setBulkDateInput({ ...bulkDateInput, date: e.target.value })}
                                  className="w-44 border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white" />
                              )}
                              <div className="flex gap-2 pt-1">
                                <button
                                  disabled={!bulkDateInput.date}
                                  onClick={() => {
                                    const targets = order.items.filter((i) => NEXT_STATUSES[i.status]?.includes(bulkDateInput.nextStatus));
                                    for (const i of targets) stageChange(i, bulkDateInput.nextStatus, bulkDateInput.date || undefined, bulkDateInput.deliveredAt || undefined);
                                    setBulkDateInput(null);
                                  }}
                                  className="px-4 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40"
                                >確定</button>
                                <button onClick={() => setBulkDateInput(null)} className="px-3 py-1.5 text-xs text-gray-400 border border-gray-200 rounded-lg">戻す</button>
                              </div>
                            </div>
                          </div>
                        )}

                        {isOpen && (
                          <div className="px-3 pb-3 bg-gray-50">
                            {/* アイテム一覧（table で縦列を完全に揃える） */}
                            <table className="min-w-[600px] w-full table-fixed bg-white rounded-xl overflow-hidden text-left">
                              <tbody>
                                {visibleItems.map((item) => {
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
                                              {dateInput.nextStatus === "delivered" ? "納品日（任意）"
                                                : dateInput.nextStatus === "rental_started" && dateInput.deliveredAt !== undefined ? "納品日・レンタル開始日を入力"
                                                : dateInput.nextStatus === "rental_started" ? "レンタル開始日"
                                                : "解約日"}
                                            </p>
                                            {/* ダイレクト（発注→レンタル開始）: 納品日＋開始日 */}
                                            {dateInput.nextStatus === "rental_started" && dateInput.deliveredAt !== undefined ? (
                                              <div className="space-y-1.5">
                                                <div className="flex gap-2 items-center">
                                                  <span className="text-xs text-gray-500 w-24 shrink-0">納品日</span>
                                                  <input
                                                    type="date"
                                                    value={dateInput.deliveredAt}
                                                    onChange={(e) => setDateInput({ ...dateInput, deliveredAt: e.target.value })}
                                                    className="w-44 border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                                                  />
                                                </div>
                                                <div className="flex gap-2 items-center">
                                                  <span className="text-xs text-gray-500 w-24 shrink-0">レンタル開始日</span>
                                                  <input
                                                    type="date"
                                                    value={dateInput.date}
                                                    onChange={(e) => setDateInput({ ...dateInput, date: e.target.value })}
                                                    className="w-44 border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                                                  />
                                                </div>
                                                <div className="flex gap-2 pt-1">
                                                  <button
                                                    disabled={!dateInput.date}
                                                    onClick={() => stageChange(dateInput.item, dateInput.nextStatus, dateInput.date || undefined, dateInput.deliveredAt || undefined)}
                                                    className="px-4 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40"
                                                  >確定</button>
                                                  <button onClick={() => setDateInput(null)} className="px-3 py-1.5 text-xs text-gray-400 border border-gray-200 rounded-lg">戻す</button>
                                                </div>
                                              </div>
                                            ) : (
                                              <div className="flex gap-2 items-center">
                                                <input
                                                  type="date"
                                                  value={dateInput.date}
                                                  onChange={(e) => setDateInput({ ...dateInput, date: e.target.value })}
                                                  className="w-44 border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                                                />
                                                <button
                                                  disabled={dateInput.nextStatus !== "delivered" && !dateInput.date}
                                                  onClick={() => handleStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date || undefined)}
                                                  className="px-4 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40"
                                                >確定</button>
                                                <button onClick={() => setDateInput(null)} className="px-3 py-1.5 text-xs text-gray-400 border border-gray-200 rounded-lg">戻す</button>
                                              </div>
                                            )}
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
                        </div>{/* overflow-x-auto wrapper */}
                      </li>
              );
            })}
          </ul>
        </div>
      ); })}
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

      {/* ケアマネ報告書モーダル（PostSaveModalの上に重なる） */}
      {careManagerModal && (
        <RentalReportModal
          client={careManagerModal.client}
          items={careManagerModal.items}
          equipment={equipment}
          companyInfo={careManagerModal.companyInfo}
          priceHistory={careManagerModal.priceHistory}
          tenantId={tenantId}
          onClose={() => setCareManagerModal(null)}
          onSaved={() => setCareManagerModal(null)}
        />
      )}

      {/* 保存後メールモーダル */}
      {postSaveChanges && (
        <PostSaveModal
          changes={postSaveChanges}
          clients={clients}
          equipment={equipment}
          orders={orders}
          supplierSentIds={supplierSentIds}
          careSentIds={careSentIds}
          onSendEmail={(order) => {
            // 保存した変更からemailTypeを判定
            const orderChanges = (postSaveChanges ?? []).filter((c) =>
              orders.find((o) => o.items.some((i) => i.id === c.item.id))?.id === order.id
            );
            let emailType: "new_order" | "rental_started" | "terminated" | "cancelled" = "new_order";
            if (orderChanges.some((c) => c.newStatus === "rental_started")) emailType = "rental_started";
            else if (orderChanges.some((c) => c.newStatus === "terminated")) emailType = "terminated";
            else if (orderChanges.some((c) => c.newStatus === "cancelled")) emailType = "cancelled";
            setSupplierSentIds((prev) => new Set([...prev, order.id]));
            setPreviewOrder({ order, items: order.items, emailType });
          }}
          onCareManagerEmail={async (order) => {
            const client = clients.find((c) => c.id === order.client_id);
            if (!client) return;
            const allItems = orders
              .filter((o) => o.client_id === order.client_id)
              .flatMap((o) => o.items);
            const codes = [...new Set(allItems.map((i) => i.product_code))];
            const [history, tenant] = await Promise.all([
              getPriceHistory(tenantId, codes),
              getTenantById(tenantId),
            ]);
            const companyInfo: CompanyInfo = tenant ? {
              businessNumber:      tenant.business_number       ?? COMPANY_INFO_DEFAULTS.businessNumber,
              companyName:         tenant.company_name          ?? COMPANY_INFO_DEFAULTS.companyName,
              companyAddress:      tenant.company_address       ?? COMPANY_INFO_DEFAULTS.companyAddress,
              tel:                 tenant.company_tel           ?? COMPANY_INFO_DEFAULTS.tel,
              fax:                 tenant.company_fax           ?? COMPANY_INFO_DEFAULTS.fax,
              staffName:           tenant.staff_name            ?? COMPANY_INFO_DEFAULTS.staffName,
              serviceArea:         tenant.service_area          ?? COMPANY_INFO_DEFAULTS.serviceArea,
              businessDays:        tenant.business_days         ?? COMPANY_INFO_DEFAULTS.businessDays,
              businessHours:       tenant.business_hours        ?? COMPANY_INFO_DEFAULTS.businessHours,
              staffManagerFull:    tenant.staff_manager_full    ?? COMPANY_INFO_DEFAULTS.staffManagerFull,
              staffManagerPart:    tenant.staff_manager_part    ?? COMPANY_INFO_DEFAULTS.staffManagerPart,
              staffSpecialistFull: tenant.staff_specialist_full ?? COMPANY_INFO_DEFAULTS.staffSpecialistFull,
              staffSpecialistPart: tenant.staff_specialist_part ?? COMPANY_INFO_DEFAULTS.staffSpecialistPart,
              staffAdminFull:      tenant.staff_admin_full      ?? COMPANY_INFO_DEFAULTS.staffAdminFull,
              staffAdminPart:      tenant.staff_admin_part      ?? COMPANY_INFO_DEFAULTS.staffAdminPart,
            } : COMPANY_INFO_DEFAULTS;
            setCareSentIds((prev) => new Set([...prev, order.id]));
            setCareManagerModal({ client, items: allItems, companyInfo, priceHistory: history });
          }}
          onClose={() => { setPostSaveChanges(null); setSupplierSentIds(new Set()); setCareSentIds(new Set()); }}
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

  const handleExportCSV = () => {
    const headers = ["用具名", "TAISコード", "カテゴリ", "レンタル価格", "全国平均価格", "限度額", "商品コード"];
    const rows = localEquipment.map(e => [
      e.name,
      e.tais_code ?? "",
      e.category ?? "",
      e.rental_price?.toString() ?? "",
      e.national_avg_price?.toString() ?? "",
      e.price_limit?.toString() ?? "",
      e.product_code,
    ]);
    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "用具マスタ.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

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
          取込
        </button>
        <button
          onClick={handleExportCSV}
          className="shrink-0 flex items-center gap-1 bg-gray-600 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Download size={14} />
          CSV出力
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
        <div className="flex-1 overflow-y-auto overflow-x-auto">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">
              {equipment.length === 0 ? "用具データがありません。CSVからインポートしてください。" : "該当なし"}
            </p>
          ) : (
            <table className="min-w-[680px] w-full table-fixed bg-white text-left">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="pl-3 py-2 text-xs font-semibold text-gray-500 w-[5.5rem]">種目</th>
                  <th className="py-2 text-xs font-semibold text-gray-500">用具名</th>
                  <th className="py-2 px-3 text-xs font-semibold text-gray-500 w-[6.5rem]">コード</th>
                  <th className="py-2 pr-3 text-xs font-semibold text-gray-500 w-[10rem]">TAISコード</th>
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
                    {/* 種目マーク */}
                    <td className="pl-3 py-2.5 w-[5.5rem] overflow-hidden">
                      {item.category && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium block truncate ${catColor(item.category)}`}>
                          {item.category}
                        </span>
                      )}
                    </td>
                    {/* 用具名 */}
                    <td className="py-2.5 text-sm font-medium text-gray-800 max-w-0">
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
  const todayYM = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const [priceEffectiveMonth, setPriceEffectiveMonth] = useState(todayYM);

  const handleSave = async () => {
    if (!name.trim()) { setError("用具名は必須です"); return; }
    setSaving(true);
    setError("");
    try {
      const newRentalPrice = rentalPrice ? parseFloat(rentalPrice) : null;
      const payload = {
        name: name.trim(),
        tais_code: taisCode.trim() || null,
        category: category.trim() || null,
        rental_price: newRentalPrice,
        national_avg_price: nationalAvg ? parseFloat(nationalAvg) : null,
        price_limit: priceLimit ? parseFloat(priceLimit) : null,
        selection_reason: selectionReason.trim() || null,
        proposal_reason: proposalReason.trim() || null,
      };
      const saved = isNew
        ? await createEquipmentItem(tenantId, payload)
        : await updateEquipment(item!.id, payload);
      // 価格が変更された場合（または新規）、履歴を記録（月初日で登録）
      if (newRentalPrice && priceEffectiveMonth) {
        const oldPrice = item?.rental_price ?? null;
        if (isNew || newRentalPrice !== oldPrice) {
          await addPriceHistory(tenantId, saved.product_code, newRentalPrice, `${priceEffectiveMonth}-01`);
        }
      }
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
    setPriceEffectiveMonth(new Date().toISOString().slice(0, 7));
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
            {/* レンタル価格 + 改定日 */}
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">レンタル価格（円/月）</label>
              <input
                value={rentalPrice}
                onChange={(e) => setRentalPrice(e.target.value)}
                placeholder="例：15000"
                type="number"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">価格の適用開始月</label>
              <input
                type="month"
                value={priceEffectiveMonth}
                onChange={(e) => setPriceEffectiveMonth(e.target.value)}
                className="w-44 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
              <p className="text-[11px] text-gray-400 mt-1">価格を変更した場合のみ履歴に記録されます</p>
            </div>
            {[
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

function ClientsTab({ tenantId, initialClientId, onClearInitialClient }: { tenantId: string; initialClientId?: string | null; onClearInitialClient?: () => void }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [kanaFilter, setKanaFilter] = useState("");
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [selectedClientInitialViewMode, setSelectedClientInitialViewMode] = useState<"current" | "insurance" | undefined>(undefined);
  const [viewMode, setViewMode] = useState<"list" | "insurance" | "history">("list");
  const [allInsuranceRecords, setAllInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [newOrderClient, setNewOrderClient] = useState<Client | null>(null);
  const [importing, setImporting] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [c, items, eq, ords, sup, mem] = await Promise.all([
          getClients(tenantId),
          getAllOrderItemsByTenant(tenantId),
          getEquipment(tenantId),
          getOrders(tenantId),
          getSuppliers(),
          getMembers(tenantId),
        ]);
        setClients(c);
        setOrderItems(items);
        setEquipment(eq);
        setOrders(ords);
        setSuppliers(sup);
        setMembers(mem);
        // 保険レコードは件数が多いので全件ページング取得
        const allInsur: ClientInsuranceRecord[] = [];
        let insurFrom = 0;
        while (true) {
          const { data: insurChunk } = await supabase
            .from("client_insurance_records")
            .select("*")
            .eq("tenant_id", tenantId)
            .order("effective_date", { ascending: false })
            .range(insurFrom, insurFrom + 999);
          if (!insurChunk || insurChunk.length === 0) break;
          allInsur.push(...(insurChunk as ClientInsuranceRecord[]));
          if (insurChunk.length < 1000) break;
          insurFrom += 1000;
        }
        setAllInsuranceRecords(allInsur);
        if (initialClientId) {
          const target = c.find((cl) => cl.id === initialClientId);
          if (target) setSelectedClient(target);
          onClearInitialClient?.();
        }
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
        initialViewMode={selectedClientInitialViewMode}
        onBack={() => { setSelectedClient(null); setSelectedClientInitialViewMode(undefined); }}
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

  // 変更履歴を生成
  const changeHistory = (() => {
    type ChangeEvent = { date: string; clientId: string; equipName: string; label: string; color: string };
    const events: ChangeEvent[] = [];
    for (const item of orderItems) {
      const order = orders.find((o) => o.id === item.order_id);
      if (!order?.client_id) continue;
      const eq = equipment.find((e) => e.product_code === item.product_code);
      const name = eq?.name ?? item.product_code;
      if (item.delivered_at) events.push({ date: item.delivered_at.slice(0, 10), clientId: order.client_id, equipName: name, label: "納品", color: "text-blue-600 bg-blue-50" });
      if (item.rental_start_date) events.push({ date: item.rental_start_date, clientId: order.client_id, equipName: name, label: "レンタル開始", color: "text-emerald-600 bg-emerald-50" });
      if (item.rental_end_date) events.push({ date: item.rental_end_date, clientId: order.client_id, equipName: name, label: "解約", color: "text-red-500 bg-red-50" });
      if (item.cancelled_at) events.push({ date: item.cancelled_at.slice(0, 10), clientId: order.client_id, equipName: name, label: "キャンセル", color: "text-gray-500 bg-gray-100" });
    }
    events.sort((a, b) => b.date.localeCompare(a.date));
    // 利用者ごとにグループ化
    const map = new Map<string, ChangeEvent[]>();
    for (const e of events) {
      if (!map.has(e.clientId)) map.set(e.clientId, []);
      map.get(e.clientId)!.push(e);
    }
    return Array.from(map.entries())
      .map(([clientId, evts]) => ({ client: clients.find((c) => c.id === clientId), events: evts }))
      .filter((g) => g.client)
      .sort((a, b) => (b.events[0]?.date ?? "").localeCompare(a.events[0]?.date ?? ""));
  })();

  const CSV_HEADERS = ["利用者番号", "氏名", "ふりがな", "電話番号", "携帯番号", "住所", "介護度", "給付率", "ケアマネ名", "ケアマネ事業所", "認定終了日", "メモ"];

  const handleExportCSV = () => {
    const rows = clients.map((c) => [
      c.user_number ?? "", c.name, c.furigana ?? "",
      c.phone ?? "", c.mobile ?? "", c.address ?? "",
      c.care_level ?? "", c.benefit_rate ?? "",
      c.care_manager ?? "", c.care_manager_org ?? "",
      c.certification_end_date ?? "", c.memo ?? "",
    ]);
    const csvText = [CSV_HEADERS, ...rows]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `利用者一覧_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const parseCsvRow = (line: string): string[] => {
    const result: string[] = [];
    let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ',') { result.push(cur); cur = ""; }
        else cur += ch;
      }
    }
    result.push(cur);
    return result;
  };

  const handleImportCSV = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
      if (lines.length < 2) return;
      const headers = parseCsvRow(lines[0]);
      const col = (name: string) => headers.indexOf(name);

      const maxNum = clients.reduce((mx, c) => {
        const n = parseInt(c.user_number ?? "0");
        return isNaN(n) ? mx : Math.max(mx, n);
      }, 0);
      let nextNum = maxNum + 1;

      const toInsert: Omit<Client, "id" | "created_at">[] = [];
      const toUpdate: { id: string; data: Partial<Client> }[] = [];

      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cols = parseCsvRow(line);
        const name = cols[col("氏名")]?.trim();
        if (!name) continue;
        const userNumber = cols[col("利用者番号")]?.trim() || null;
        const data = {
          tenant_id: tenantId,
          user_number: userNumber ?? String(nextNum++),
          name,
          furigana: cols[col("ふりがな")]?.trim() || null,
          phone: cols[col("電話番号")]?.trim() || null,
          mobile: cols[col("携帯番号")]?.trim() || null,
          address: cols[col("住所")]?.trim() || null,
          care_level: cols[col("介護度")]?.trim() || null,
          benefit_rate: cols[col("給付率")]?.trim() || null,
          care_manager: cols[col("ケアマネ名")]?.trim() || null,
          care_manager_org: cols[col("ケアマネ事業所")]?.trim() || null,
          certification_end_date: cols[col("認定終了日")]?.trim() || null,
          memo: cols[col("メモ")]?.trim() || null,
          insured_number: cols[col("被保険者番号")]?.trim() || null,
          birth_date: cols[col("生年月日")]?.trim() || null,
          certification_start_date: cols[col("認定開始日")]?.trim() || null,
          insurer_number: cols[col("保険者番号")]?.trim() || null,
          copay_rate: cols[col("利用者負担割合")]?.trim() || null,
          public_expense: cols[col("公費負担情報")]?.trim() || null,
          gender: null,
        };
        const existing = userNumber ? clients.find((c) => c.user_number === userNumber) : null;
        if (existing) toUpdate.push({ id: existing.id, data });
        else toInsert.push(data);
      }

      if (toInsert.length > 0) await supabase.from("clients").insert(toInsert);
      for (const { id, data } of toUpdate) await supabase.from("clients").update(data).eq("id", id);

      const newClients = await getClients(tenantId);
      setClients(newClients);
    } finally {
      setImporting(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-2 shrink-0">
        {(viewMode === "list" || viewMode === "insurance") && (
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
        )}
        {viewMode === "history" && <div className="flex-1" />}
        <div className="flex gap-1 shrink-0">
          <button
            onClick={handleExportCSV}
            title="CSVダウンロード"
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
          >
            CSV出力
          </button>
          <button
            onClick={() => csvInputRef.current?.click()}
            disabled={importing}
            title="CSVから利用者を取り込む"
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors disabled:opacity-50"
          >
            {importing ? "取り込み中..." : "CSV取り込み"}
          </button>
          <input ref={csvInputRef} type="file" accept=".csv" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportCSV(f); }} />
          {(["list", "insurance", "history"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === m ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
            >
              {m === "list" ? "基本情報" : m === "insurance" ? "保険情報" : "変更履歴"}
            </button>
          ))}
        </div>
      </div>

      {/* 変更履歴ビュー */}
      {viewMode === "history" && (
        <div className="flex-1 overflow-y-auto bg-white p-3 space-y-3">
          {changeHistory.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-16">変更履歴がありません</p>
          ) : (
            changeHistory.map((g, gi) => (
              <div key={gi} className="bg-gray-50 rounded-xl p-3">
                <button
                  onClick={() => setSelectedClient(g.client!)}
                  className="text-sm font-bold text-gray-800 mb-2 flex items-center gap-1 hover:text-emerald-600"
                >
                  {g.client!.name}
                  <ChevronRight size={13} className="text-gray-400" />
                </button>
                <div className="space-y-1">
                  {g.events.slice(0, 5).map((ev, ei) => (
                    <div key={ei} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-400 w-20 shrink-0">{ev.date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$2/$3")}</span>
                      <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium shrink-0 ${ev.color}`}>{ev.label}</span>
                      <span className="text-gray-700 truncate">{ev.equipName}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 保険情報一覧ビュー */}
      {viewMode === "insurance" && (() => {
        // 各利用者の最新の保険情報レコードを取得
        const insuranceByClient = new Map<string, ClientInsuranceRecord>();
        for (const rec of allInsuranceRecords) {
          if (!insuranceByClient.has(rec.client_id)) {
            insuranceByClient.set(rec.client_id, rec);
          }
        }
        const insuranceFiltered = clients
          .filter((c) => matchClient(c, search))
          .sort((a, b) => (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja"));
        return (
          <div className="flex-1 overflow-y-auto overflow-x-auto bg-white">
            {insuranceFiltered.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-16">該当なし</p>
            ) : (
              <table className="w-full text-xs min-w-[900px]">
                <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">氏名</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-10">性別</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-20">要介護度</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-28">被保険者番号</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-16">負担割合</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">保険者</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">認定開始日</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">認定終了日</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-32">居宅事業所</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-600 w-24">ケアマネ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {insuranceFiltered.map((client) => {
                    const rec = insuranceByClient.get(client.id);
                    const dash = <span className="text-gray-300">—</span>;
                    return (
                      <tr
                        key={client.id}
                        className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => { setSelectedClientInitialViewMode("insurance"); setSelectedClient(client); }}
                      >
                        <td className="px-3 py-2 font-medium text-gray-800">{client.name}</td>
                        <td className="px-3 py-2 text-gray-600">{client.gender ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.care_level ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.insured_number ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.copay_rate ? `${rec.copay_rate}%` : dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.insurer_name ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.certification_start_date ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.certification_end_date ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.care_manager_org ?? dash}</td>
                        <td className="px-3 py-2 text-gray-600">{rec?.care_manager ?? dash}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}

      {/* 利用者一覧ビュー */}
      {viewMode === "list" && <>
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

      <div className="flex-1 overflow-y-auto overflow-x-auto bg-white">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-16">
            {clients.length === 0 ? "利用者データがありません" : "該当なし"}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 min-w-[480px]">
            {filtered.map((client) => {
              const clientOrders = orders.filter(o => o.client_id === client.id);
              const clientOrderIds = new Set(clientOrders.map(o => o.id));
              const activeItems = orderItems.filter(
                item => clientOrderIds.has(item.order_id) &&
                        item.status !== "cancelled" &&
                        item.status !== "terminated"
              );
              const hasKaigo = activeItems.some(item => {
                const pt = item.payment_type ?? clientOrders.find(o => o.id === item.order_id)?.payment_type;
                return pt === "介護";
              });
              const hasJihi = activeItems.some(item => {
                const pt = item.payment_type ?? clientOrders.find(o => o.id === item.order_id)?.payment_type;
                return pt === "自費";
              });
              return (
                <li key={client.id} className="flex items-center pr-3">
                  <button
                    onClick={() => setSelectedClient(client)}
                    className="flex-1 min-w-0 px-4 py-3 flex items-center gap-2 hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0 flex items-center gap-1">
                      <span className="w-20 shrink-0 text-sm font-medium text-gray-800 truncate">{client.name}</span>
                      <span className="w-24 shrink-0 text-xs text-gray-400 truncate">{client.furigana ?? ""}</span>
                      {client.gender && <span className="shrink-0 text-xs text-gray-500 bg-gray-100 px-1 py-0.5 rounded">{client.gender}</span>}
                      <div className="w-8 shrink-0 flex items-center">
                        {hasKaigo && (
                          <span className="text-xs px-1 py-0.5 bg-emerald-100 text-emerald-700 rounded font-medium">介護</span>
                        )}
                      </div>
                      <div className="w-8 shrink-0 flex items-center">
                        {hasJihi && (
                          <span className="text-xs px-1 py-0.5 bg-blue-100 text-blue-700 rounded font-medium">自費</span>
                        )}
                      </div>
                      <span className="flex-1 min-w-0 text-xs text-gray-400 truncate">{client.address ?? ""}</span>
                    </div>
                    <ChevronRight size={16} className="text-gray-300 shrink-0" />
                  </button>
                  <button
                    onClick={() => setNewOrderClient(client)}
                    className="shrink-0 ml-2 px-3 py-1 text-xs font-medium text-emerald-600 border border-emerald-200 rounded-lg hover:bg-emerald-50 transition-colors"
                  >
                    発注
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </>}

      {newOrderClient && (
        <NewOrderModal
          tenantId={tenantId}
          clients={clients}
          equipment={equipment}
          suppliers={suppliers}
          members={members}
          defaultClientId={newOrderClient.id}
          onClose={() => setNewOrderClient(null)}
          onDone={() => setNewOrderClient(null)}
        />
      )}
    </div>
  );
}

// ─── Client Detail ───────────────────────────────────────────────────────────

function ClientDetail({
  client,
  allOrderItems,
  equipment,
  tenantId,
  initialViewMode,
  onBack,
}: {
  client: Client;
  allOrderItems: OrderItem[];
  equipment: Equipment[];
  tenantId: string;
  initialViewMode?: "current" | "insurance";
  onBack: () => void;
}) {
  const [clientItems, setClientItems] = useState<OrderItem[]>([]);
  const [orderPaymentMap, setOrderPaymentMap] = useState<Record<string, "介護" | "自費">>({});
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<"current" | "monthly" | "docs" | "insurance" | "rental_history">(initialViewMode ?? "current");
  // 保険情報（複数レコード）
  const [insuranceRecords, setInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [insuranceForm, setInsuranceForm] = useState<Omit<ClientInsuranceRecord, "id" | "tenant_id" | "client_id" | "created_at"> | null>(null);
  const [editingInsuranceId, setEditingInsuranceId] = useState<string | null>(null);
  const [insuranceSaving, setInsuranceSaving] = useState(false);
  // レンタル履歴（手動登録）
  const [rentalHistoryRecords, setRentalHistoryRecords] = useState<ClientRentalHistory[]>([]);
  const [rentalHistoryForm, setRentalHistoryForm] = useState<Omit<ClientRentalHistory, "id" | "tenant_id" | "client_id" | "source" | "created_at"> | null>(null);
  const [editingRentalHistoryId, setEditingRentalHistoryId] = useState<string | null>(null);
  const [rentalHistorySaving, setRentalHistorySaving] = useState(false);
  const [regenDoc, setRegenDoc] = useState<ClientDocument | null>(null);
  const [showCarePlan, setShowCarePlan] = useState(false);
  const [carePlanInitialParams, setCarePlanInitialParams] = useState<Record<string, unknown> | null>(null);
  const [showProposal, setShowProposal] = useState(false);
  const [proposalInitialParams, setProposalInitialParams] = useState<Record<string, unknown> | null>(null);
  const [emailPreview, setEmailPreview] = useState<{ order: Order; items: OrderItem[]; suppliers: Supplier[]; members: Member[]; sentAt?: string; emailType?: "new_order" | "rental_started" | "terminated" | "cancelled" } | null>(null);
  const [showDocuments, setShowDocuments] = useState(false);
  const [yearMonth, setYearMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [dateInput, setDateInput] = useState<{
    item: OrderItem;
    nextStatus: OrderItem["status"];
    date: string;
    deliveredAt?: string;
  } | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);

  // 会社情報ロード
  useEffect(() => {
    getTenantById(tenantId).then((t) => {
      if (t) {
        setCompanyInfo({
          businessNumber:      t.business_number       ?? COMPANY_INFO_DEFAULTS.businessNumber,
          companyName:         t.company_name          ?? COMPANY_INFO_DEFAULTS.companyName,
          companyAddress:      t.company_address       ?? COMPANY_INFO_DEFAULTS.companyAddress,
          tel:                 t.company_tel           ?? COMPANY_INFO_DEFAULTS.tel,
          fax:                 t.company_fax           ?? COMPANY_INFO_DEFAULTS.fax,
          staffName:           t.staff_name            ?? COMPANY_INFO_DEFAULTS.staffName,
          serviceArea:         t.service_area          ?? COMPANY_INFO_DEFAULTS.serviceArea,
          businessDays:        t.business_days         ?? COMPANY_INFO_DEFAULTS.businessDays,
          businessHours:       t.business_hours        ?? COMPANY_INFO_DEFAULTS.businessHours,
          staffManagerFull:    t.staff_manager_full    ?? COMPANY_INFO_DEFAULTS.staffManagerFull,
          staffManagerPart:    t.staff_manager_part    ?? COMPANY_INFO_DEFAULTS.staffManagerPart,
          staffSpecialistFull: t.staff_specialist_full ?? COMPANY_INFO_DEFAULTS.staffSpecialistFull,
          staffSpecialistPart: t.staff_specialist_part ?? COMPANY_INFO_DEFAULTS.staffSpecialistPart,
          staffAdminFull:      t.staff_admin_full      ?? COMPANY_INFO_DEFAULTS.staffAdminFull,
          staffAdminPart:      t.staff_admin_part      ?? COMPANY_INFO_DEFAULTS.staffAdminPart,
        });
      }
    });
  }, [tenantId]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: ordersData }, insurResult, rentalResult] = await Promise.all([
        supabase.from("orders").select("id, payment_type").eq("tenant_id", tenantId).eq("client_id", client.id),
        supabase.from("client_insurance_records").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("effective_date", { ascending: false }),
        supabase.from("client_rental_history").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("start_date", { ascending: false }),
      ]);
      setInsuranceRecords((insurResult.data ?? []) as ClientInsuranceRecord[]);
      setRentalHistoryRecords((rentalResult.data ?? []) as ClientRentalHistory[]);
      if (ordersData && ordersData.length > 0) {
        const orderIds = ordersData.map((o: { id: string; payment_type: string }) => o.id);
        const payMap: Record<string, "介護" | "自費"> = {};
        ordersData.forEach((o: { id: string; payment_type: string }) => {
          if (o.payment_type === "自費") payMap[o.id] = "自費";
          else payMap[o.id] = "介護";
        });
        setOrderPaymentMap(payMap);
        const { data: items } = await supabase
          .from("order_items")
          .select("*")
          .in("order_id", orderIds);
        const loaded = items ?? [];
        setClientItems(loaded);
        const codes = [...new Set(loaded.map((i) => i.product_code))];
        const [history, docs] = await Promise.all([
          getPriceHistory(tenantId, codes),
          getClientDocuments(tenantId, client.id),
        ]);
        setPriceHistory(history);
        setDocuments(docs);
      } else {
        setClientItems([]);
        setPriceHistory([]);
        setDocuments([]);
      }
    } finally {
      setLoading(false);
    }
  }, [client.id, tenantId]);

  useEffect(() => { loadItems(); }, [loadItems]);

  const today = new Date().toISOString().split("T")[0];

  const handleStatusClick = (item: OrderItem, nextStatus: OrderItem["status"]) => {
    if (nextStatus === "delivered" || nextStatus === "rental_started" || nextStatus === "terminated") {
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
      if (newStatus === "delivered" && date) extra.delivered_at = date;
      if (newStatus === "rental_started" && date) extra.rental_start_date = date;
      if (newStatus === "terminated" && date) extra.rental_end_date = date;
      await updateOrderItemStatus(item.id, newStatus, Object.keys(extra).length ? extra : undefined);
      setDateInput(null);
      await loadItems();
      // レンタル開始・解約・キャンセル時はメール送信画面を表示
      if (newStatus === "rental_started" || newStatus === "terminated" || newStatus === "cancelled") {
        const [{ data: orderData }, orderItems, suppliers, members] = await Promise.all([
          supabase.from("orders").select("*").eq("id", item.order_id).single(),
          getOrderItems(item.order_id),
          getSuppliers(),
          getMembers(tenantId),
        ]);
        if (orderData) {
          setEmailPreview({ order: orderData as Order, items: orderItems, suppliers, members, emailType: newStatus as "rental_started" | "terminated" | "cancelled" });
        }
      }
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
  const orderedItems = clientItems.filter((i) => i.status === "ordered");
  const deliveredItems = clientItems.filter((i) => ["delivered", "trial"].includes(i.status));
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

  const handleSaveInsuranceRecord = async () => {
    if (!insuranceForm) return;
    setInsuranceSaving(true);
    try {
      if (editingInsuranceId) {
        await supabase.from("client_insurance_records").update(insuranceForm).eq("id", editingInsuranceId);
      } else {
        await supabase.from("client_insurance_records").insert({ ...insuranceForm, tenant_id: tenantId, client_id: client.id });
      }
      setInsuranceForm(null);
      setEditingInsuranceId(null);
      await loadItems();
    } finally {
      setInsuranceSaving(false);
    }
  };

  const handleDeleteInsuranceRecord = async (id: string) => {
    if (!confirm("この保険情報を削除しますか？")) return;
    await supabase.from("client_insurance_records").delete().eq("id", id);
    await loadItems();
  };

  const handleSaveRentalHistory = async () => {
    if (!rentalHistoryForm || !rentalHistoryForm.equipment_name.trim()) return;
    setRentalHistorySaving(true);
    try {
      if (editingRentalHistoryId) {
        await supabase.from("client_rental_history").update(rentalHistoryForm).eq("id", editingRentalHistoryId);
      } else {
        await supabase.from("client_rental_history").insert({ ...rentalHistoryForm, tenant_id: tenantId, client_id: client.id, source: "manual" });
      }
      setRentalHistoryForm(null);
      setEditingRentalHistoryId(null);
      await loadItems();
    } finally {
      setRentalHistorySaving(false);
    }
  };

  const handleDeleteRentalHistory = async (id: string) => {
    if (!confirm("このレンタル履歴を削除しますか？")) return;
    await supabase.from("client_rental_history").delete().eq("id", id);
    await loadItems();
  };

  // 用具行共通（ステータス変更ボタン付き）- table行として使用
  const ItemCard = ({ item, dim = false, priceOverride }: { item: OrderItem; dim?: boolean; priceOverride?: number }) => (
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
        <td className="py-2 pr-3 w-[7rem] whitespace-nowrap text-right">
          {(() => { const p = priceOverride ?? item.rental_price; return p ? (
            <span className="text-sm font-bold text-emerald-600">
              ¥{p.toLocaleString()}<span className="text-xs font-normal">/月</span>
            </span>
          ) : null; })()}
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
                {dateInput.nextStatus === "delivered" ? "納品日" : dateInput.nextStatus === "rental_started" ? "レンタル開始日" : "解約日"}を入力
              </p>
              <div className="flex gap-2 items-center">
                <input
                  type="date"
                  value={dateInput.date}
                  onChange={(e) => setDateInput({ ...dateInput, date: e.target.value })}
                  className="w-44 border border-emerald-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white"
                />
                <button
                  disabled={!dateInput.date || updatingId === item.id}
                  onClick={() => execStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date)}
                  className="px-4 bg-emerald-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-1"
                >
                  {updatingId === item.id ? <Loader2 size={12} className="animate-spin" /> : "確定"}
                </button>
                <button onClick={() => setDateInput(null)} className="px-3 py-1.5 text-xs text-gray-400 border border-gray-200 rounded-lg">戻す</button>
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
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-gray-800">{client.name}</h2>
            {client.gender && <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-md">{client.gender}</span>}
          </div>
          {client.furigana && <p className="text-xs text-gray-400">{client.furigana}</p>}
        </div>
        <button
          onClick={() => setShowDocuments(true)}
          title="重要事項説明書・契約書を作成"
          className="flex items-center gap-1.5 text-xs text-blue-600 border border-blue-200 px-2.5 py-1.5 rounded-xl hover:bg-blue-50 transition-colors"
        >
          <FileText size={14} />
          書類作成
        </button>
        <button
          onClick={() => setShowReport(true)}
          title="貸与提供報告書を作成"
          className="flex items-center gap-1.5 text-xs text-emerald-600 border border-emerald-200 px-2.5 py-1.5 rounded-xl hover:bg-emerald-50 transition-colors"
        >
          <FileText size={14} />
          報告書
        </button>
      </div>

      {/* 発注メール再送モーダル */}
      {emailPreview && (
        <OrderEmailPreviewModal
          order={emailPreview.order}
          orderItems={emailPreview.items}
          clients={[client]}
          equipment={equipment}
          suppliers={emailPreview.suppliers}
          members={emailPreview.members}
          emailType={emailPreview.emailType ?? "new_order"}
          tenantId={tenantId}
          sentAt={emailPreview.sentAt}
          onClose={() => setEmailPreview(null)}
          onBack={() => setEmailPreview(null)}
          onDone={() => setEmailPreview(null)}
        />
      )}

      {/* 貸与報告書モーダル */}
      {(showReport || regenDoc) && (
        <RentalReportModal
          client={client}
          items={clientItems}
          orderPaymentMap={orderPaymentMap}
          equipment={equipment}
          companyInfo={companyInfo}
          priceHistory={priceHistory}
          tenantId={tenantId}
          initialParams={regenDoc ? (regenDoc.params as { targetMonth: string; visitDate: string; memo: string; selectedUsage: string[] }) : undefined}
          onClose={() => { setShowReport(false); setRegenDoc(null); }}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
          }}
        />
      )}

      {/* 書類作成モーダル（重要事項説明書＋契約書） */}
      {showDocuments && (
        <ContractDocumentsModal
          client={client}
          clientItems={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          tenantId={tenantId}
          onClose={() => setShowDocuments(false)}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
            setShowDocuments(false);
          }}
        />
      )}

      {/* 個別援助計画書モーダル */}
      {showCarePlan && (
        <CarePlanModal
          client={client}
          clientItems={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          tenantId={tenantId}
          initialParams={carePlanInitialParams ?? undefined}
          onClose={() => setShowCarePlan(false)}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
            setShowCarePlan(false);
          }}
        />
      )}

      {/* 選定提案書モーダル */}
      {showProposal && (
        <ProposalModal
          client={client}
          clientItems={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          tenantId={tenantId}
          initialParams={proposalInitialParams ?? undefined}
          onClose={() => setShowProposal(false)}
          onSaved={async () => {
            const docs = await getClientDocuments(tenantId, client.id);
            setDocuments(docs);
            setShowProposal(false);
          }}
        />
      )}

      {/* View toggle */}
      <div className="bg-white border-b border-gray-100 px-4 py-2 flex gap-1.5 shrink-0">
        <button onClick={() => setViewMode("current")}
          className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "current" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}>
          現在
        </button>
        <button onClick={() => setViewMode("monthly")}
          className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "monthly" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}>
          月別
        </button>
        <button onClick={() => setViewMode("insurance")}
          className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "insurance" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}>
          保険情報
        </button>
        <button onClick={() => setViewMode("rental_history")}
          className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "rental_history" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}>
          履歴
        </button>
        <button onClick={() => setViewMode("docs")}
          className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "docs" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}>
          書類{documents.length > 0 && <span className="ml-1 opacity-70">({documents.length})</span>}
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

          {orderedItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">発注済み</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{orderedItems.map((i) => <ItemCard key={i.id} item={i} />)}</tbody></table>
            </section>
          )}
          {deliveredItems.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">納品済み</h3>
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left"><tbody className="divide-y divide-dashed divide-gray-200">{deliveredItems.map((i) => <ItemCard key={i.id} item={i} />)}</tbody></table>
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
      ) : viewMode === "monthly" ? (
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
              const getHistoricalPrice = (item: OrderItem) =>
                getPriceForMonth(priceHistory, item.product_code, yearMonth) ?? item.rental_price ?? 0;
              const activeTotal = activeMonthly.reduce((s, i) => s + getHistoricalPrice(i), 0);
              return (
                <>
                  {/* レンタル中 */}
                  {activeMonthly.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 px-1">レンタル中</p>
                      <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left">
                        <tbody className="divide-y divide-dashed divide-gray-200">
                          {activeMonthly.map((item) => (
                            <ItemCard key={item.id} item={item}
                              priceOverride={getPriceForMonth(priceHistory, item.product_code, yearMonth) ?? undefined}
                            />
                          ))}
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
                          {terminatedMonthly.map((item) => (
                            <ItemCard key={item.id} item={item} dim
                              priceOverride={getPriceForMonth(priceHistory, item.product_code, yearMonth) ?? undefined}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      ) : viewMode === "docs" ? (
        /* 書類タブ */
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {/* 作成ボタン */}
          <div className="flex gap-2">
            <button
              onClick={() => { setCarePlanInitialParams(null); setShowCarePlan(true); }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium rounded-xl hover:bg-emerald-100"
            >
              <Plus size={13} /> 個別援助計画書
            </button>
            <button
              onClick={() => { setProposalInitialParams(null); setShowProposal(true); }}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium rounded-xl hover:bg-blue-100"
            >
              <Plus size={13} /> 選定提案書
            </button>
          </div>

          {documents.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">保存済みの書類はありません<br /><span className="text-xs">報告書を開いて「履歴に保存」を押すと記録されます</span></p>
          ) : (
            documents.map((doc) => (
              <div key={doc.id} className="bg-white rounded-xl px-3 py-2.5 flex items-center gap-2 shadow-sm">
                <FileText size={16} className={doc.type === "supplier_email" ? "text-blue-400" : doc.type === "care_plan" ? "text-purple-400" : doc.type === "proposal" ? "text-amber-400" : "text-emerald-400"} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 truncate">{doc.title}</p>
                  <p className="text-xs text-gray-400">{new Date(doc.created_at).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })}</p>
                </div>
                <button
                  onClick={async () => {
                    if (doc.type === "rental_report") setRegenDoc(doc);
                    else if (doc.type === "care_plan") { setCarePlanInitialParams(doc.params); setShowCarePlan(true); }
                    else if (doc.type === "proposal") { setProposalInitialParams(doc.params); setShowProposal(true); }
                    else if (doc.type === "rental_contract" || doc.type === "important_matters") setShowDocuments(true);
                    else if (doc.type === "supplier_email") {
                      const orderId = doc.params.orderId as string | undefined;
                      if (!orderId) return;
                      const [{ data: orderData }, items, suppliers, members] = await Promise.all([
                        supabase.from("orders").select("*").eq("id", orderId).single(),
                        getOrderItems(orderId),
                        getSuppliers(),
                        getMembers(tenantId),
                      ]);
                      if (orderData) setEmailPreview({ order: orderData as Order, items, suppliers, members, sentAt: doc.created_at });
                    }
                  }}
                  className="shrink-0 text-xs text-emerald-600 border border-emerald-200 px-2.5 py-1 rounded-lg hover:bg-emerald-50"
                >
                  再生成
                </button>
                <button
                  onClick={async () => {
                    await deleteClientDocument(doc.id);
                    setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
                  }}
                  className="shrink-0 text-xs text-red-400 border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-50"
                >
                  削除
                </button>
              </div>
            ))
          )}
        </div>
      ) : viewMode === "insurance" ? (
        /* 保険情報タブ - 複数レコード管理 */
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 事業所情報（テナント設定から参照） */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 mb-2 flex items-center gap-1">
              事業所情報
              <span className="text-[10px] text-gray-400 font-normal">（設定タブで変更）</span>
            </h3>
            <div className="bg-gray-50 rounded-xl p-3 space-y-1.5">
              {[
                ["事業所番号", companyInfo.businessNumber],
                ["事業所名", companyInfo.companyName],
                ["所在地", companyInfo.companyAddress],
                ["連絡先", companyInfo.tel],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-2 text-xs">
                  <span className="w-24 shrink-0 text-gray-500">{label}</span>
                  <span className="text-gray-800">{value || "—"}</span>
                </div>
              ))}
            </div>
          </section>

          {/* 利用者情報 */}
          <section>
            <h3 className="text-xs font-semibold text-gray-500 mb-2">利用者情報</h3>
            <div className="bg-gray-50 rounded-xl p-3 space-y-1.5">
              {[
                ["氏名", client.name],
                ["フリガナ", client.furigana],
                ["性別", client.gender],
                ["生年月日", insuranceRecords[0]?.birth_date ?? null],
                ["住所", client.address],
                ["電話番号", client.phone ?? client.mobile],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-2 text-xs">
                  <span className="w-24 shrink-0 text-gray-500">{label}</span>
                  <span className="text-gray-800">{value || "—"}</span>
                </div>
              ))}
            </div>
          </section>

          {/* 保険情報一覧 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-500">保険情報</h3>
              {!insuranceForm && (
                <button
                  onClick={() => {
                    setEditingInsuranceId(null);
                    setInsuranceForm({ effective_date: null, insured_number: null, birth_date: null, care_level: client.care_level ?? null, certification_start_date: null, certification_end_date: null, insurer_name: null, insurer_number: null, copay_rate: null, public_expense: null, care_manager: null, care_manager_org: null, notes: null });
                  }}
                  className="text-xs text-emerald-600 border border-emerald-200 px-2.5 py-1 rounded-lg hover:bg-emerald-50"
                >
                  ＋ 新規追加
                </button>
              )}
            </div>

            {/* 編集フォーム */}
            {insuranceForm && (
              <div className="bg-emerald-50 rounded-xl p-4 mb-3 space-y-2.5">
                <p className="text-xs font-semibold text-emerald-700">{editingInsuranceId ? "保険情報を編集" : "保険情報を追加"}</p>
                {([
                  { label: "有効期間開始日", key: "effective_date", type: "date" },
                  { label: "被保険者番号", key: "insured_number" },
                  { label: "生年月日", key: "birth_date", type: "date" },
                  { label: "保険者番号", key: "insurer_number" },
                ] as { label: string; key: keyof typeof insuranceForm; type?: string }[]).map(({ label, key, type }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-xs text-gray-500">{label}</span>
                    <input type={type ?? "text"} value={(insuranceForm[key] as string) ?? ""}
                      onChange={(e) => setInsuranceForm((f) => f && { ...f, [key]: e.target.value || null })}
                      className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white" />
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-xs text-gray-500">要介護度</span>
                  <select value={insuranceForm.care_level ?? ""} onChange={(e) => setInsuranceForm((f) => f && { ...f, care_level: e.target.value || null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white">
                    <option value="">未設定</option>
                    {["要支援1","要支援2","要介護1","要介護2","要介護3","要介護4","要介護5"].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                {([
                  { label: "認定開始日", key: "certification_start_date" },
                  { label: "認定終了日", key: "certification_end_date" },
                ] as { label: string; key: keyof typeof insuranceForm }[]).map(({ label, key }) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 text-xs text-gray-500">{label}</span>
                    <input type="date" value={(insuranceForm[key] as string) ?? ""}
                      onChange={(e) => setInsuranceForm((f) => f && { ...f, [key]: e.target.value || null })}
                      className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white" />
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="w-28 shrink-0 text-xs text-gray-500">利用者負担割合</span>
                  <select value={insuranceForm.copay_rate ?? ""} onChange={(e) => setInsuranceForm((f) => f && { ...f, copay_rate: e.target.value || null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white">
                    <option value="">未設定</option>
                    {["1割","2割","3割"].map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-28 shrink-0 text-xs text-gray-500 pt-0.5">公費負担情報</span>
                  <textarea value={insuranceForm.public_expense ?? ""} onChange={(e) => setInsuranceForm((f) => f && { ...f, public_expense: e.target.value || null })} rows={2}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white resize-none" />
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-28 shrink-0 text-xs text-gray-500 pt-0.5">メモ</span>
                  <textarea value={insuranceForm.notes ?? ""} onChange={(e) => setInsuranceForm((f) => f && { ...f, notes: e.target.value || null })} rows={2}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white resize-none" />
                </div>
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={() => { setInsuranceForm(null); setEditingInsuranceId(null); }}
                    className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-white">
                    キャンセル
                  </button>
                  <button onClick={handleSaveInsuranceRecord} disabled={insuranceSaving}
                    className="text-xs text-white bg-emerald-500 px-4 py-1.5 rounded-lg disabled:opacity-50">
                    {insuranceSaving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            )}

            {/* レコード一覧 */}
            {insuranceRecords.length === 0 && !insuranceForm ? (
              <p className="text-sm text-gray-400 text-center py-6">保険情報がありません</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">被保険者番号</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">要介護度</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">認定開始日</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">認定終了日</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">負担割合</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">保険者</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">居宅事業所</th>
                      <th className="text-left px-2 py-2 font-medium text-gray-500">ケアマネ</th>
                      <th className="px-2 py-2 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {insuranceRecords.map((rec, idx) => (
                      <tr key={rec.id} className={idx === 0 ? "bg-emerald-50" : "bg-white"}>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1.5">
                            {idx === 0 && <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium whitespace-nowrap">現在</span>}
                            <span className="text-gray-700 tabular-nums">{rec.insured_number ?? <span className="text-gray-300">—</span>}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-gray-700">{rec.care_level ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2 text-gray-700">{rec.certification_start_date ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2 text-gray-700">{rec.certification_end_date ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2 text-gray-700">{rec.copay_rate ? `${rec.copay_rate}%` : <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2 text-gray-700">{rec.insurer_name ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2 text-gray-700">{rec.care_manager_org ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2 text-gray-700">{rec.care_manager ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-2 py-2">
                          <div className="flex gap-1">
                            <button
                              onClick={() => { setEditingInsuranceId(rec.id); setInsuranceForm({ effective_date: rec.effective_date, insured_number: rec.insured_number, birth_date: rec.birth_date, care_level: rec.care_level, certification_start_date: rec.certification_start_date, certification_end_date: rec.certification_end_date, insurer_name: rec.insurer_name, insurer_number: rec.insurer_number, copay_rate: rec.copay_rate, public_expense: rec.public_expense, care_manager: rec.care_manager, care_manager_org: rec.care_manager_org, notes: rec.notes }); }}
                              className="text-gray-400 hover:text-gray-600"
                            >編集</button>
                            <button onClick={() => handleDeleteInsuranceRecord(rec.id)} className="text-red-300 hover:text-red-500">削除</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : viewMode === "rental_history" ? (
        /* レンタル履歴タブ */
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-500">レンタル履歴</h3>
              {!rentalHistoryForm && (
                <button
                  onClick={() => {
                    setEditingRentalHistoryId(null);
                    setRentalHistoryForm({ equipment_name: "", model_number: null, start_date: null, end_date: null, monthly_price: null, notes: null });
                  }}
                  className="text-xs text-emerald-600 border border-emerald-200 px-2.5 py-1 rounded-lg hover:bg-emerald-50"
                >
                  ＋ 手動追加
                </button>
              )}
            </div>

            {/* 手動登録フォーム */}
            {rentalHistoryForm && (
              <div className="bg-emerald-50 rounded-xl p-4 mb-3 space-y-2.5">
                <p className="text-xs font-semibold text-emerald-700">{editingRentalHistoryId ? "レンタル履歴を編集" : "レンタル履歴を追加"}</p>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">用具名 <span className="text-red-400">*</span></span>
                  <input type="text" value={rentalHistoryForm.equipment_name}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, equipment_name: e.target.value })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">型番</span>
                  <input type="text" value={rentalHistoryForm.model_number ?? ""}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, model_number: e.target.value || null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white" />
                </div>
                {([["開始日","start_date"],["終了日","end_date"]] as [string,string][]).map(([label, key]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-xs text-gray-500">{label}</span>
                    <input type="date" value={(rentalHistoryForm as Record<string,unknown>)[key] as string ?? ""}
                      onChange={(e) => setRentalHistoryForm((f) => f && { ...f, [key]: e.target.value || null })}
                      className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white" />
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">月額</span>
                  <input type="number" value={rentalHistoryForm.monthly_price ?? ""}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, monthly_price: e.target.value ? Number(e.target.value) : null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white" />
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500 pt-0.5">メモ</span>
                  <textarea value={rentalHistoryForm.notes ?? ""} onChange={(e) => setRentalHistoryForm((f) => f && { ...f, notes: e.target.value || null })} rows={2}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-emerald-400 bg-white resize-none" />
                </div>
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={() => { setRentalHistoryForm(null); setEditingRentalHistoryId(null); }}
                    className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-white">
                    キャンセル
                  </button>
                  <button onClick={handleSaveRentalHistory} disabled={rentalHistorySaving}
                    className="text-xs text-white bg-emerald-500 px-4 py-1.5 rounded-lg disabled:opacity-50">
                    {rentalHistorySaving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            )}

            {/* 合算一覧（システム由来 + 手動） */}
            {(() => {
              const systemEntries = historyItems.map((i) => ({
                id: i.id, source: "system" as const,
                equipment_name: equipName(i.product_code),
                model_number: null as string | null,
                start_date: i.rental_start_date,
                end_date: i.rental_end_date,
                monthly_price: i.rental_price,
                notes: i.notes,
              }));
              const manualEntries = rentalHistoryRecords.map((r) => ({
                id: r.id, source: "manual" as const,
                equipment_name: r.equipment_name,
                model_number: r.model_number,
                start_date: r.start_date,
                end_date: r.end_date,
                monthly_price: r.monthly_price,
                notes: r.notes,
              }));
              const combined = [...systemEntries, ...manualEntries].sort((a, b) =>
                (b.start_date ?? "").localeCompare(a.start_date ?? "")
              );
              if (combined.length === 0) return (
                <p className="text-sm text-gray-400 text-center py-6">レンタル履歴がありません</p>
              );
              return (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[500px]">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">用具名</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">型番</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">開始日</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">終了日</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">月額</th>
                        <th className="text-left px-2 py-2 font-medium text-gray-500">備考</th>
                        <th className="px-2 py-2 w-16"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {combined.map((item) => (
                        <tr key={item.id} className="bg-white">
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1.5">
                              {item.source === "manual" && (
                                <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full whitespace-nowrap">手動</span>
                              )}
                              <span className="text-gray-800 font-medium">{item.equipment_name}</span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-gray-500">{item.model_number ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-2 text-gray-600 whitespace-nowrap">{item.start_date ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-2 py-2 text-gray-600 whitespace-nowrap">{item.end_date ?? "継続中"}</td>
                          <td className="px-2 py-2 text-emerald-600 whitespace-nowrap">
                            {item.monthly_price != null ? `¥${item.monthly_price.toLocaleString()}/月` : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-2 py-2 text-gray-400">{item.notes ?? ""}</td>
                          <td className="px-2 py-2">
                            {item.source === "manual" && (
                              <div className="flex gap-1">
                                <button
                                  onClick={() => {
                                    const rec = rentalHistoryRecords.find((r) => r.id === item.id);
                                    if (!rec) return;
                                    setEditingRentalHistoryId(rec.id);
                                    setRentalHistoryForm({ equipment_name: rec.equipment_name, model_number: rec.model_number, start_date: rec.start_date, end_date: rec.end_date, monthly_price: rec.monthly_price, notes: rec.notes });
                                  }}
                                  className="text-gray-400 hover:text-gray-600"
                                >編集</button>
                                <button onClick={() => handleDeleteRentalHistory(item.id)} className="text-red-300 hover:text-red-500">削除</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </section>
        </div>
      ) : null}
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
  supplierSentIds,
  careSentIds,
  onSendEmail,
  onCareManagerEmail,
  onClose,
}: {
  changes: PendingChange[];
  clients: Client[];
  equipment: Equipment[];
  orders: OrderWithItems[];
  supplierSentIds: Set<string>;
  careSentIds: Set<string>;
  onSendEmail: (order: OrderWithItems) => void;
  onCareManagerEmail: (order: OrderWithItems) => void;
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
          <p className="text-xs text-gray-500">以下の変更が保存されました。卸会社・ケアマネへのメール送信ができます。</p>
          {grouped.map((g, gi) => {
            const order = getOrder(g.changes[0].item.id);
            return (
              <div key={gi} className="bg-gray-50 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold text-gray-800">{clientName(g.clientId)}</span>
                  {order && (() => {
                    const statuses = g.changes.map((c) => c.newStatus);
                    const needsSupplierMail = statuses.some((s) => s === "rental_started" || s === "terminated" || s === "cancelled");
                    const needsCareMail = statuses.some((s) => s === "rental_started" || s === "terminated");
                    if (!needsSupplierMail && !needsCareMail) return null;
                    return (
                      <div className="flex items-center gap-1.5">
                        {needsSupplierMail && (
                          <button
                            onClick={() => onSendEmail(order)}
                            className={`flex items-center gap-1 text-xs border px-2.5 py-1 rounded-xl transition-opacity ${
                              supplierSentIds.has(order.id)
                                ? "opacity-30 text-blue-500 border-blue-200"
                                : "text-blue-600 border-blue-200 hover:bg-blue-50"
                            }`}
                          >
                            <Mail size={12} /> 卸会社にメール
                          </button>
                        )}
                        {needsCareMail && (
                          <button
                            onClick={() => onCareManagerEmail(order)}
                            className={`flex items-center gap-1 text-xs border px-2.5 py-1 rounded-xl transition-opacity ${
                              careSentIds.has(order.id)
                                ? "opacity-30 text-emerald-500 border-emerald-200"
                                : "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                            }`}
                          >
                            <Mail size={12} /> ケアマネにメール
                          </button>
                        )}
                      </div>
                    );
                  })()}
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
  defaultClientId,
  onClose,
  onDone,
}: {
  tenantId: string;
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
  const [deliveryType, setDeliveryType] = useState<"直納" | "自社納品">("直納");
  const [attendanceRequired, setAttendanceRequired] = useState(false);
  const [selectedAttendees, setSelectedAttendees] = useState<string[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");

  // 卸会社デフォルト：日本ケアサプライ
  useEffect(() => {
    if (suppliers.length > 0 && !supplierId) {
      const def = suppliers.find((s) => s.name.includes("日本ケアサプライ"));
      if (def) setSupplierId(def.id);
    }
  }, [suppliers]);

  // 利用者選択時に住所を自動入力
  useEffect(() => {
    if (clientId) {
      const c = clients.find((cl) => cl.id === clientId);
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
      const order = await createOrder({
        tenantId,
        clientId: clientId || undefined,
        notes: notes || undefined,
        paymentType,
        deliveryDate: deliveryDate || undefined,
        deliveryTime: deliveryTime || undefined,
        deliveryAddress: deliveryAddress || undefined,
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

      {/* ── 確認画面 ── */}
      {showConfirm && (() => {
        const clientObj = clients.find((c) => c.id === clientId);
        const supplierObj = suppliers.find((s) => s.id === supplierId);
        const warnings: string[] = [];
        if (!deliveryDate) warnings.push("納品予定日が未入力です");
        if (!deliveryTime) warnings.push("納品時間が未入力です");
        if (!supplierId) warnings.push("卸会社が未選択です");
        const noPriceItems = items.filter((i) => !i.rental_price || parseFloat(i.rental_price) === 0);
        if (noPriceItems.length > 0)
          warnings.push(`価格未入力の用具があります：${noPriceItems.map((i) => i.equipment.name).join("、")}`);

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
                  <Row label="種別" value={paymentType} />
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

                {/* 用具 */}
                <div className="bg-gray-50 rounded-xl p-3 space-y-2">
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">発注用具（{items.length}件）</p>
                  {items.map((item, i) => {
                    const price = item.rental_price ? parseFloat(item.rental_price) : null;
                    const itemSupplier = suppliers.find((s) => s.id === item.supplier_id);
                    return (
                      <div key={i} className="flex items-start justify-between gap-2 py-1 border-b border-gray-100 last:border-0">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-800 truncate">{item.equipment.name}</p>
                          <p className="text-[10px] text-gray-400">{item.equipment.product_code}{itemSupplier ? `　${itemSupplier.name}` : ""}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className={`text-sm font-semibold ${price ? "text-emerald-600" : "text-amber-500"}`}>
                            {price ? `¥${price.toLocaleString()}/月` : "価格未入力"}
                          </p>
                          <p className="text-[10px] text-gray-400">{item.quantity > 1 ? `×${item.quantity}` : ""}{item.payment_type ? `　${item.payment_type}` : ""}</p>
                        </div>
                      </div>
                    );
                  })}
                  {(() => {
                    const total = items.reduce((sum, item) => {
                      const p = item.rental_price ? parseFloat(item.rental_price) : 0;
                      return sum + p * item.quantity;
                    }, 0);
                    return total > 0 ? (
                      <div className="flex justify-between items-center pt-2 mt-1 border-t border-emerald-200">
                        <span className="text-xs font-semibold text-gray-600">月額合計</span>
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

// ─── Order Email Preview Modal ───────────────────────────────────────────────

/** 発注内容を構造化（確認画面・メール共用） */
function buildStatusChangeContent(
  emailType: "rental_started" | "terminated" | "cancelled",
  order: Order,
  orderItems: OrderItem[],
  client: Client | undefined,
  equipment: Equipment[],
  isResend: boolean,
  returnDate?: string,
  returnMethod?: string,
) {
  const clientName = client?.name ?? "（未設定）";
  const clientAddress = client?.address ?? "（未設定）";
  const changedItem = orderItems.find((i) => i.status === emailType);
  const targetItems = emailType === "rental_started"
    ? orderItems.filter((i) => i.status !== "cancelled")
    : orderItems.filter((i) => i.status === emailType);
  const itemLines = targetItems.map((i, idx) => {
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
  } else if (emailType === "terminated") {
    const endDate = returnDate || changedItem?.rental_end_date || null;
    const endDateStr = endDate
      ? new Date(endDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未設定";
    const methodStr = returnMethod || "未定";
    const subject = `【解約・返却${resendMark}】${clientName} 様`;
    const preview = [`利用者：${clientName}`, `住所：${clientAddress}`, "", "── 返却品目 ──", ...itemLines, "", `解約日：${endDateStr}`, `返却方法：${methodStr}`].join("\n");
    const emailBody = [
      `【解約・返却${resendMark}】`, "", "お疲れ様です。",
      "下記の福祉用具につきまして、解約・返却のご連絡をいたします。",
      "────────────────────",
      `利用者名：${clientName}`, `住　　所：${clientAddress}`, "",
      "▼ 返却品目", ...itemLines.map((l) => `  ${l}`), "",
      `解約日　：${endDateStr}`,
      `返却方法：${methodStr}`,
      "────────────────────", "", "お引き取りのほど、よろしくお願いいたします。",
    ].join("\n");
    return { subject, preview, emailBody };
  } else {
    // cancelled
    const cancelDateStr = returnDate
      ? new Date(returnDate).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })
      : "未設定";
    const methodStr = returnMethod || "未定";
    const subject = `【キャンセル・返却${resendMark}】${clientName} 様`;
    const preview = [`利用者：${clientName}`, `住所：${clientAddress}`, "", "── 返却品目 ──", ...itemLines, "", `返却日：${cancelDateStr}`, `返却方法：${methodStr}`].join("\n");
    const emailBody = [
      `【キャンセル・返却${resendMark}】`, "", "お疲れ様です。",
      "下記の福祉用具につきまして、キャンセル・返却のご連絡をいたします。",
      "────────────────────",
      `利用者名：${clientName}`, `住　　所：${clientAddress}`, "",
      "▼ 返却品目", ...itemLines.map((l) => `  ${l}`), "",
      `返却日　：${cancelDateStr}`,
      `返却方法：${methodStr}`,
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
  isResend: boolean,
  suppliers?: Supplier[]
) {
  const clientName = client?.name ?? "（未設定）";
  const clientAddress = order.delivery_address ?? client?.address ?? "（未設定）";
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
  const supplierName = suppliers?.find((s) => s.id === order.supplier_id)?.name;

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
    ...(supplierName ? [`${supplierName}ご担当者様`, ""] : []),
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
  tenantId,
  sentAt,
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
  emailType?: "new_order" | "rental_started" | "terminated" | "cancelled";
  tenantId?: string;
  sentAt?: string;
  onClose: () => void;
  onBack?: () => void;
  onDone: () => void;
}) {
  const isResend = (order.email_sent_count ?? 0) > 0;
  const client = clients.find((c) => c.id === order.client_id);
  const today = new Date().toISOString().split("T")[0];
  // 解約・キャンセルメール用: 返却日・返却方法
  const terminatedItem = orderItems.find((i) => i.status === "terminated");
  const [returnDate, setReturnDate] = useState(
    emailType === "terminated" ? (terminatedItem?.rental_end_date ?? today) : today
  );
  const [returnMethod, setReturnMethod] = useState("");

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
    const { subject, emailBody } = buildOrderContent(order, items, client, equipment, members, isResend, suppliers);
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
      if (tenantId && order.client_id) {
        const emailLabel = supplierObj.name ? `${supplierObj.name}への発注メール` : "発注メール";
        await saveClientDocument({
          tenant_id: tenantId,
          client_id: order.client_id,
          type: "supplier_email",
          title: `${emailLabel}（${subject}）`,
          params: { emailType: "new_order", orderId: order.id, supplierName: supplierObj.name, subject, body: emailBody },
        }).catch(() => {});
      }
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
      ? buildStatusChangeContent(emailType, order, orderItems, client, equipment, isResend, returnDate, returnMethod)
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
      if (tenantId && order.client_id) {
        const typeLabel = emailType === "rental_started" ? "レンタル開始通知" : "解約・返却通知";
        await saveClientDocument({
          tenant_id: tenantId,
          client_id: order.client_id,
          type: "supplier_email",
          title: `${typeLabel}（${scSubject}）`,
          params: { emailType, orderId: order.id, subject: scSubject, body: scEmailBody },
        }).catch(() => {});
      }
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
          const { subject, emailBody } = buildOrderContent(order, g.items, client, equipment, members, isResend, suppliers);
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
          <div>
            <h3 className="font-semibold text-gray-800">
              発注内容確認{isResend && <span className="ml-2 text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">再送</span>}
            </h3>
            {sentAt && (
              <p className="text-xs text-gray-400 mt-0.5">
                送信日時: {new Date(sentAt).toLocaleString("ja-JP", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </p>
            )}
          </div>
          <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {emailType === "new_order" ? (
            /* 卸会社ごとにカード表示 */
            supplierGroups.map((g) => {
              const key = g.supplierId ?? "__none__";
              const { subject, preview } = buildOrderContent(order, g.items, client, equipment, members, isResend, suppliers);
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
              {/* 解約・キャンセル: 返却日・返却方法入力 */}
              {(emailType === "terminated" || emailType === "cancelled") && (
                <div className="bg-white border border-gray-200 rounded-xl p-3 space-y-2.5">
                  <p className="text-xs font-semibold text-gray-600">返却情報</p>
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-sm text-gray-500">返却日</span>
                    <input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)}
                      className="w-44 border border-gray-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white" />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="w-20 shrink-0 text-sm text-gray-500">返却方法</span>
                    <select value={returnMethod} onChange={(e) => setReturnMethod(e.target.value)}
                      className="w-64 border border-gray-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white">
                      <option value="">未選択</option>
                      <option value="直引き">直引き</option>
                      <option value="店引き">店引き</option>
                      <option value="持ち込み">持ち込み</option>
                    </select>
                  </div>
                </div>
              )}
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
    business_number:       COMPANY_INFO_DEFAULTS.businessNumber,
    company_name:          COMPANY_INFO_DEFAULTS.companyName,
    company_address:       COMPANY_INFO_DEFAULTS.companyAddress,
    company_tel:           COMPANY_INFO_DEFAULTS.tel,
    company_fax:           COMPANY_INFO_DEFAULTS.fax,
    staff_name:            COMPANY_INFO_DEFAULTS.staffName,
    legal_name:            "",
    service_area:          COMPANY_INFO_DEFAULTS.serviceArea,
    business_days:         COMPANY_INFO_DEFAULTS.businessDays,
    business_hours:        COMPANY_INFO_DEFAULTS.businessHours,
    staff_manager_full:    COMPANY_INFO_DEFAULTS.staffManagerFull,
    staff_manager_part:    COMPANY_INFO_DEFAULTS.staffManagerPart,
    staff_specialist_full: COMPANY_INFO_DEFAULTS.staffSpecialistFull,
    staff_specialist_part: COMPANY_INFO_DEFAULTS.staffSpecialistPart,
    staff_admin_full:      COMPANY_INFO_DEFAULTS.staffAdminFull,
    staff_admin_part:      COMPANY_INFO_DEFAULTS.staffAdminPart,
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
          business_number:       tenant.business_number       ?? COMPANY_INFO_DEFAULTS.businessNumber,
          company_name:          tenant.company_name          ?? COMPANY_INFO_DEFAULTS.companyName,
          company_address:       tenant.company_address       ?? COMPANY_INFO_DEFAULTS.companyAddress,
          company_tel:           tenant.company_tel           ?? COMPANY_INFO_DEFAULTS.tel,
          company_fax:           tenant.company_fax           ?? COMPANY_INFO_DEFAULTS.fax,
          staff_name:            tenant.staff_name            ?? COMPANY_INFO_DEFAULTS.staffName,
          legal_name:            tenant.legal_name            ?? "",
          service_area:          tenant.service_area          ?? COMPANY_INFO_DEFAULTS.serviceArea,
          business_days:         tenant.business_days         ?? COMPANY_INFO_DEFAULTS.businessDays,
          business_hours:        tenant.business_hours        ?? COMPANY_INFO_DEFAULTS.businessHours,
          staff_manager_full:    tenant.staff_manager_full    ?? COMPANY_INFO_DEFAULTS.staffManagerFull,
          staff_manager_part:    tenant.staff_manager_part    ?? COMPANY_INFO_DEFAULTS.staffManagerPart,
          staff_specialist_full: tenant.staff_specialist_full ?? COMPANY_INFO_DEFAULTS.staffSpecialistFull,
          staff_specialist_part: tenant.staff_specialist_part ?? COMPANY_INFO_DEFAULTS.staffSpecialistPart,
          staff_admin_full:      tenant.staff_admin_full      ?? COMPANY_INFO_DEFAULTS.staffAdminFull,
          staff_admin_part:      tenant.staff_admin_part      ?? COMPANY_INFO_DEFAULTS.staffAdminPart,
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : (err as any)?.message ?? JSON.stringify(err);
      alert("保存に失敗しました: " + msg);
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
    { key: "staff_name",      label: "担当者名（管理者）", placeholder: "山田 太郎" },
    { key: "legal_name",      label: "法人名（事業者名）", placeholder: "株式会社○○福祉用具" },
  ] as const;

  const importantMattersFields = [
    { key: "service_area",   label: "通常の事業の実施地域",  placeholder: "○○市、○○市" },
    { key: "business_days",  label: "営業日",                placeholder: "月〜土（祝日除く）" },
    { key: "business_hours", label: "営業時間",              placeholder: "9:00〜17:00" },
  ] as const;

  const staffRows = [
    { label: "管理者 兼 専門相談員", fullKey: "staff_manager_full",    partKey: "staff_manager_part" },
    { label: "専門相談員",           fullKey: "staff_specialist_full", partKey: "staff_specialist_part" },
    { label: "事務･配送職員",        fullKey: "staff_admin_full",      partKey: "staff_admin_part" },
  ] as const;

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0">
        <h2 className="font-semibold text-gray-800">設定</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-6">

        {/* 会社情報 */}
        <div>
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">会社情報</h3>
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

            <p className="text-xs font-semibold text-gray-400 pt-2 border-t border-gray-100">重要事項説明書用</p>
            {importantMattersFields.map(({ key, label, placeholder }) => (
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

            <div>
              <label className="text-xs text-gray-500 block mb-1">職員体制（常勤 / 非常勤）</label>
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <div className="grid grid-cols-3 bg-gray-50 px-3 py-1.5">
                  <span className="text-xs text-gray-500">職種</span>
                  <span className="text-xs text-gray-500 text-center">常勤</span>
                  <span className="text-xs text-gray-500 text-center">非常勤</span>
                </div>
                {staffRows.map(({ label, fullKey, partKey }) => (
                  <div key={label} className="grid grid-cols-3 items-center border-t border-gray-100 px-3 py-1.5 gap-2">
                    <span className="text-xs text-gray-700">{label}</span>
                    <input
                      value={company[fullKey]}
                      onChange={(e) => setCompany({ ...company, [fullKey]: e.target.value })}
                      placeholder="0"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-center outline-none focus:border-emerald-400"
                    />
                    <input
                      value={company[partKey]}
                      onChange={(e) => setCompany({ ...company, [partKey]: e.target.value })}
                      placeholder="0"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-center outline-none focus:border-emerald-400"
                    />
                  </div>
                ))}
              </div>
            </div>

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

        {/* ── 個別援助計画書テンプレート ── */}
        <CarePlanTemplateSection tenantId={tenantId} />

      </div>
    </div>
  );
}

function CarePlanTemplateSection({ tenantId }: { tenantId: string }) {
  const [templates, setTemplates] = useState<CarePlanTemplate[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // category being edited
  const [newCategory, setNewCategory] = useState("");
  const [form, setForm] = useState<Record<string, { goals: string; precautions: string }>>({});
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getCarePlanTemplates(tenantId), getEquipment(tenantId)]).then(([tmpl, eq]) => {
      setTemplates(tmpl);
      setEquipment(eq);
      const f: Record<string, { goals: string; precautions: string }> = {};
      tmpl.forEach((t) => { f[t.category] = { goals: t.goals, precautions: t.precautions }; });
      setForm(f);
    });
  }, [tenantId]);

  // 用具マスタにある種目一覧
  const categories = Array.from(new Set(equipment.map((e) => e.category).filter(Boolean))) as string[];
  // テンプレートにある種目（用具マスタにないものも含む）
  const allCategories = Array.from(new Set([...categories, ...templates.map((t) => t.category)])).sort();

  const handleSave = async (category: string) => {
    setSaving(category);
    try {
      const { goals, precautions } = form[category] ?? { goals: "", precautions: "" };
      const saved = await upsertCarePlanTemplate(tenantId, category, goals, precautions);
      setTemplates((prev) => {
        const exists = prev.find((t) => t.category === category);
        return exists ? prev.map((t) => t.category === category ? saved : t) : [...prev, saved];
      });
      setEditing(null);
    } finally {
      setSaving(null);
    }
  };

  const handleDelete = async (id: string, category: string) => {
    await deleteCarePlanTemplate(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
    setForm((prev) => { const n = { ...prev }; delete n[category]; return n; });
  };

  const handleAddNew = () => {
    if (!newCategory.trim()) return;
    setForm((prev) => ({ ...prev, [newCategory]: { goals: "", precautions: "" } }));
    setEditing(newCategory);
    setNewCategory("");
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h3 className="font-semibold text-gray-800 text-sm">個別援助計画書テンプレート</h3>
        <p className="text-xs text-gray-400 mt-0.5">種目ごとの利用目標・留意点の例文を設定します</p>
      </div>
      <div className="p-4 space-y-3">
        {allCategories.length === 0 && (
          <p className="text-xs text-gray-400">用具マスタに種目データがありません</p>
        )}
        {allCategories.map((cat) => {
          const tmpl = templates.find((t) => t.category === cat);
          const isEditing = editing === cat;
          const vals = form[cat] ?? { goals: "", precautions: "" };
          return (
            <div key={cat} className="border border-gray-100 rounded-xl overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50">
                <span className="text-xs font-semibold text-gray-700">{cat}</span>
                <div className="flex gap-2">
                  {!isEditing && (
                    <button
                      onClick={() => {
                        setForm((prev) => ({ ...prev, [cat]: { goals: tmpl?.goals ?? "", precautions: tmpl?.precautions ?? "" } }));
                        setEditing(cat);
                      }}
                      className="text-xs text-emerald-600 hover:underline"
                    >編集</button>
                  )}
                  {tmpl && !isEditing && (
                    <button onClick={() => handleDelete(tmpl.id, cat)} className="text-xs text-red-400 hover:underline">削除</button>
                  )}
                </div>
              </div>
              {isEditing ? (
                <div className="p-3 space-y-2">
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 block mb-1">利用目標</label>
                    <textarea
                      value={vals.goals}
                      onChange={(e) => setForm((prev) => ({ ...prev, [cat]: { ...prev[cat], goals: e.target.value } }))}
                      rows={3}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-400 resize-none"
                      placeholder="例：安全に起居動作を行うことができる"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-gray-500 block mb-1">留意点</label>
                    <textarea
                      value={vals.precautions}
                      onChange={(e) => setForm((prev) => ({ ...prev, [cat]: { ...prev[cat], precautions: e.target.value } }))}
                      rows={3}
                      className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-xs outline-none focus:border-emerald-400 resize-none"
                      placeholder="例：ベッドご使用の際はサイドレール等の隙間に注意してください"
                    />
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleSave(cat)}
                      disabled={saving === cat}
                      className="flex-1 py-1.5 bg-emerald-500 text-white text-xs font-medium rounded-lg disabled:opacity-50"
                    >
                      {saving === cat ? "保存中..." : "保存"}
                    </button>
                    <button onClick={() => setEditing(null)} className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs rounded-lg">
                      キャンセル
                    </button>
                  </div>
                </div>
              ) : tmpl ? (
                <div className="p-3 space-y-1.5">
                  <p className="text-[11px] text-gray-400 font-medium">目標</p>
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{tmpl.goals || "—"}</p>
                  <p className="text-[11px] text-gray-400 font-medium mt-1">留意点</p>
                  <p className="text-xs text-gray-700 whitespace-pre-wrap">{tmpl.precautions || "—"}</p>
                </div>
              ) : (
                <div className="px-3 py-2">
                  <p className="text-xs text-gray-400">テンプレート未設定</p>
                </div>
              )}
            </div>
          );
        })}

        {/* 新規カテゴリ追加（用具マスタにない種目用） */}
        <div className="flex gap-2 pt-1">
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="種目名を入力して追加"
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-xs outline-none focus:border-emerald-400"
          />
          <button
            onClick={handleAddNew}
            disabled={!newCategory.trim()}
            className="px-3 py-2 bg-emerald-500 text-white text-xs rounded-xl disabled:opacity-40"
          >追加</button>
        </div>
      </div>
    </div>
  );
}

// ─── Care Plan Modal ─────────────────────────────────────────────────────────

const CHANGE_TYPE_OPTIONS = ["新規納品", "追加納品", "回収", "プラン更新", "プラン変更", "その他"] as const;

function calcAge(birthDateStr: string): number {
  const birth = new Date(birthDateStr + "T00:00:00");
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  if (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate())) age--;
  return age;
}

// ─── CarePlanPages (sub-component to avoid shared JSX node issue) ─────────────
function CarePlanPages({
  selectedItems, getEq, client, companyInfo,
  creationDate, gender, birthDate, certStartDate,
  consultantName, consultantRelation, consultationDate,
  monitoringMonths, goalsText, precautionsText, TD, TH,
}: {
  selectedItems: OrderItem[];
  getEq: (code: string) => Equipment | undefined;
  client: Client;
  companyInfo: CompanyInfo;
  creationDate: string;
  gender: string;
  birthDate: string;
  certStartDate: string;
  consultantName: string;
  consultantRelation: string;
  consultationDate: string;
  monitoringMonths: string;
  goalsText: string;
  precautionsText: string;
  TD: React.CSSProperties;
  TH: React.CSSProperties;
}) {
  // 同一商品をグループ化（product_code単位）
  type GItem = { item: OrderItem; count: number };
  const groupedItems: GItem[] = (() => {
    const map = new Map<string, GItem>();
    for (const item of selectedItems) {
      if (map.has(item.product_code)) {
        map.get(item.product_code)!.count += 1;
      } else {
        map.set(item.product_code, { item, count: 1 });
      }
    }
    return Array.from(map.values());
  })();

  // 選定理由の文字数から行数を推定し、高さベースでページ分割
  const CHARS_PER_LINE = 28;
  const REASON_LINE_H = 14;
  const ITEM_FIXED_H = 32;
  const PAGE_ITEMS_H = 480;

  const estimateItemH = (gi: GItem) => {
    const reason = getEq(gi.item.product_code)?.selection_reason ?? "";
    const lines = Math.max(1, Math.ceil(reason.length / CHARS_PER_LINE));
    return ITEM_FIXED_H + lines * REASON_LINE_H;
  };

  const pages: GItem[][] = [];
  let cur: GItem[] = [];
  let curH = 0;
  for (const gi of groupedItems) {
    const h = estimateItemH(gi);
    if (cur.length > 0 && curH + h > PAGE_ITEMS_H) {
      pages.push(cur);
      cur = [];
      curH = 0;
    }
    cur.push(gi);
    curH += h;
  }
  pages.push(cur.length > 0 ? cur : []);

  // ADL用コンパクトスタイル
  const ADLTH: React.CSSProperties = { border: "1px solid #555", background: "#eee", padding: "1px 3px", textAlign: "center", fontSize: "7pt", whiteSpace: "nowrap" };
  const ADLTD: React.CSSProperties = { border: "1px solid #555", padding: "1px 4px", fontSize: "7pt", whiteSpace: "nowrap" };
  const ADLEM: React.CSSProperties = { border: "1px solid #555", padding: 0, height: "14px" };
  const ADLNONE: React.CSSProperties = { border: "none", padding: "0 3px", width: "6px" };

  const renderLeftCol = () => (
    <div style={{ width: "46%", flexShrink: 0, verticalAlign: "top" }}>
      <p style={{ fontSize: "13pt", fontWeight: "bold", textAlign: "center", margin: "0 0 4px" }}>個別援助計画書（基本情報）</p>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "4px" }}>
        <tbody>
          <tr>
            <td style={{ border: "none", fontSize: "8pt" }}>作成日：{creationDate ? toJapaneseEra(new Date(creationDate + "T00:00:00")) : "　　年　月　日"}</td>
            <td style={{ border: "none", textAlign: "right", fontSize: "8pt" }}>担当者：{companyInfo.staffName}</td>
          </tr>
          <tr>
            <td style={{ border: "none", fontSize: "8pt" }}>事業所名：{companyInfo.companyName}</td>
            <td style={{ border: "none", textAlign: "right", fontSize: "8pt" }}>事業所番号：{companyInfo.businessNumber}</td>
          </tr>
        </tbody>
      </table>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "3px" }}>
        <tbody>
          <tr>
            <th style={{ ...TH, width: "64px" }}>利用者氏名</th>
            <td style={TD} colSpan={3}>{client.name}　様</td>
            <th style={{ ...TH, width: "50px" }}>フリガナ</th>
            <td style={TD} colSpan={2}>{client.furigana ?? ""}</td>
          </tr>
          <tr>
            <th style={TH}>性　別</th>
            <td style={{ ...TD, width: "34px" }}>{gender || "　"}</td>
            <th style={{ ...TH, width: "58px" }}>生年月日</th>
            <td style={TD}>{birthDate ? `${toJapaneseEra(new Date(birthDate + "T00:00:00"))}（${calcAge(birthDate)}歳）` : "　"}</td>
            <th style={{ ...TH, width: "50px" }}>介護度</th>
            <td style={{ ...TD, width: "58px" }} colSpan={2}>{client.care_level ?? ""}</td>
          </tr>
          <tr>
            <th style={TH}>認定期間</th>
            <td style={TD} colSpan={3}>
              {certStartDate ? toJapaneseEra(new Date(certStartDate + "T00:00:00")) : "　"} ～ {client.certification_end_date ? toJapaneseEra(new Date(client.certification_end_date.slice(0, 10) + "T00:00:00")) : "　"}
            </td>
            <th style={TH}>年　齢</th>
            <td style={TD} colSpan={2}>{birthDate ? `${calcAge(birthDate)}歳` : ""}</td>
          </tr>
          <tr>
            <th style={TH}>住　所</th>
            <td style={TD} colSpan={6}>{client.address ?? ""}</td>
          </tr>
          <tr>
            <th style={TH}>電話番号</th>
            <td style={TD} colSpan={3}>{client.phone ?? client.mobile ?? ""}</td>
            <th style={TH}>居宅支援</th>
            <td style={TD} colSpan={2}>{client.care_manager_org ?? ""}</td>
          </tr>
          <tr>
            <th style={TH}>担当CM</th>
            <td style={TD} colSpan={6}>{client.care_manager ?? ""}</td>
          </tr>
        </tbody>
      </table>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "3px" }}>
        <tbody>
          <tr>
            <th style={{ ...TH, width: "56px", verticalAlign: "top" }}>相談内容</th>
            <td style={{ ...TD, verticalAlign: "top" }}>
              <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "8pt", marginBottom: "2px" }}>
                <span>相談者：{consultantName || "　　　　"}</span>
                <span>続柄：{consultantRelation || "　　"}</span>
                <span>相談日：{consultationDate ? toJapaneseEra(new Date(consultationDate + "T00:00:00")) : "　　年　月　日"}</span>
              </div>
              <div style={{ minHeight: "28px" }}></div>
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ fontWeight: "bold", margin: "3px 0 2px", fontSize: "8pt" }}>【介護環境】</p>
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "3px" }}>
        <tbody>
          <tr>
            <th style={{ ...TH, width: "86px" }}>他のサービス<br />利用状況</th>
            <td style={{ ...TD, height: "22px" }} colSpan={3}></td>
          </tr>
          <tr>
            <th style={TH}>家族構成/<br />主介護者</th>
            <td style={{ ...TD, width: "28%" }}></td>
            <th style={{ ...TH, background: "#f5b8c4", width: "54px" }}>疾病・麻痺</th>
            <td style={TD}></td>
          </tr>
          <tr>
            <th style={TH}>その他</th>
            <td style={{ ...TD, height: "22px" }} colSpan={3}></td>
          </tr>
        </tbody>
      </table>
      {/* ADL: 外側レイアウトtableで50/50分割 → flexbox不要で印刷でも安定 */}
      <p style={{ fontWeight: "bold", margin: "3px 0 2px", fontSize: "8pt" }}>【ADL・身体状況】（印刷後に✓記入）</p>
      <table style={{ borderCollapse: "separate", borderSpacing: "4px 0", width: "100%", marginBottom: "3px" }}>
        <tbody>
          <tr>
            {([
              ["起き上がり", "立ち上がり", "移乗", "歩行"],
              ["排泄", "入浴", "食事", "整容"],
            ] as string[][]).map((group, gi) => (
              <td key={gi} style={{ padding: 0, verticalAlign: "top", width: "50%", border: "none" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      <th style={ADLTH}>項目</th>
                      <th style={ADLTH}>自立</th>
                      <th style={ADLTH}>見守り</th>
                      <th style={ADLTH}>一部介助</th>
                      <th style={ADLTH}>全介助</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.map((adl) => (
                      <tr key={adl}>
                        <td style={ADLTD}>{adl}</td>
                        <td style={ADLEM}></td>
                        <td style={ADLEM}></td>
                        <td style={ADLEM}></td>
                        <td style={ADLEM}></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p style={{ fontWeight: "bold", margin: "3px 0 2px", fontSize: "8pt" }}>【福祉用具利用目標】</p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <tr>
            <td style={{ ...TD, whiteSpace: "pre-wrap", verticalAlign: "top", height: "60px" }}>{goalsText}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <div id="care-plan-print-content" className="bg-white shadow mx-auto" style={{ minWidth: "1020px" }}>
      {pages.map((pageItems, pageIdx) => {
        const isLastPage = pageIdx === pages.length - 1;
        const globalOffset = pages.slice(0, pageIdx).reduce((s, p) => s + p.length, 0);
        return (
          <div key={pageIdx} className={!isLastPage ? "page-break" : ""}
            style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", fontSize: "8.5pt", padding: "10px 12px", minHeight: "190mm" }}>
            <div style={{ display: "flex", gap: "10px" }}>
              {renderLeftCol()}
              <div id={pageIdx === 0 ? "care-plan-right-col" : undefined} style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "13pt", fontWeight: "bold", textAlign: "center", margin: "0 0 4px" }}>選定福祉用具（レンタル・販売）</p>
                <p style={{ fontWeight: "bold", margin: "0 0 2px", fontSize: "8pt" }}>【選定した福祉用具】</p>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "4px", tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "24px" }} />
                    <col style={{ width: "38%" }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ ...TH, width: "24px" }}>No</th>
                      <th style={{ ...TH, padding: "0" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 6px", borderBottom: "1px dotted #888" }}>
                          <span>種目</span>
                          <span style={{ borderLeft: "1px dotted #888", paddingLeft: "6px" }}>単位数</span>
                        </div>
                        <div style={{ padding: "2px 6px" }}>機種（型式）</div>
                      </th>
                      <th style={TH}>選定理由</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((gi, idx) => {
                      const { item, count } = gi;
                      const eq = getEq(item.product_code);
                      const unitBase = eq?.rental_price ? Math.round(eq.rental_price / 10) : "";
                      const unitsDisplay = unitBase === "" ? "" : count > 1 ? `${unitBase}×${count}` : String(unitBase);
                      const nameDisplay = count > 1 ? `${eq?.name ?? item.product_code}　×${count}` : (eq?.name ?? item.product_code);
                      return (
                        <tr key={item.id}>
                          <td style={{ ...TD, textAlign: "center" }}>{globalOffset + idx + 1}</td>
                          <td style={{ ...TD, padding: "0", verticalAlign: "top" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 6px", borderBottom: "1px dotted #888", fontSize: "7.5pt", color: "#333" }}>
                              <span style={{ flex: 1, overflow: "hidden", fontSize: eq?.category === "認知症徘徊感知機器" ? "6pt" : undefined }}>{eq?.category ?? ""}</span>
                              <span style={{ borderLeft: "1px dotted #888", paddingLeft: "6px", whiteSpace: "nowrap" }}>{unitsDisplay}</span>
                            </div>
                            <div style={{ padding: "3px 6px", fontSize: "7pt", whiteSpace: "nowrap", overflow: "hidden" }}>{nameDisplay}</div>
                          </td>
                          <td style={TD}>{eq?.selection_reason ?? ""}</td>
                        </tr>
                      );
                    })}
                    {Array.from({ length: Math.max(0, 6 - pageItems.length) }).map((_, i) => (
                      <tr key={`empty-${i}`}>
                        <td style={{ ...TD, height: "26px" }}></td>
                        <td style={{ ...TD, height: "26px" }}></td>
                        <td style={{ ...TD, height: "26px" }}></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontWeight: "bold", margin: "3px 0 2px", fontSize: "8pt" }}>【留意点】</p>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "4px" }}>
                  <tbody>
                    <tr>
                      <td style={{ ...TD, whiteSpace: "pre-wrap", verticalAlign: "top", minHeight: "56px", height: "56px" }}>{precautionsText}</td>
                    </tr>
                  </tbody>
                </table>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "3px" }}>
                  <tbody>
                    <tr>
                      <th style={{ ...TH, width: "98px" }}>モニタリング対象月</th>
                      <td style={TD}>{monitoringMonths}</td>
                    </tr>
                  </tbody>
                </table>
                {isLastPage && (
                  <>
                    <p style={{ fontWeight: "bold", margin: "3px 0 2px", fontSize: "8pt" }}>【同意署名欄】</p>
                    <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "3px", flex: 1 }}>
                      <tbody>
                        <tr>
                          <td style={{ ...TD, width: "38%", verticalAlign: "top", height: "44px" }}>
                            <p style={{ margin: "0 0 1px" }}>上記内容について説明を受け、同意します。</p>
                            <p style={{ margin: 0 }}>　年　月　日</p>
                            <p style={{ margin: "8px 0 0" }}>利用者氏名：</p>
                          </td>
                          <td style={{ ...TD, width: "31%", verticalAlign: "top" }}>
                            <p style={{ margin: "0 0 1px" }}>代理人（続柄：　　　）</p>
                            <p style={{ margin: "14px 0 0" }}>署名：</p>
                          </td>
                          <td style={{ ...TD, width: "31%", verticalAlign: "top" }}>
                            <p style={{ margin: "0 0 1px" }}>福祉用具専門相談員</p>
                            <p style={{ margin: "14px 0 0" }}>署名：</p>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </>
                )}
                <div style={{ textAlign: "right", fontSize: "7.5pt", borderTop: "1px solid #ccc", paddingTop: "3px" }}>
                  {companyInfo.companyName}　{companyInfo.companyAddress}　TEL: {companyInfo.tel}　FAX: {companyInfo.fax}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CarePlanModal({
  client,
  clientItems,
  equipment,
  companyInfo,
  tenantId,
  initialParams,
  onClose,
  onSaved,
}: {
  client: Client;
  clientItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  initialParams?: Record<string, unknown>;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [step, setStep] = useState<1 | 2>(1);
  const [templates, setTemplates] = useState<CarePlanTemplate[]>([]);

  const selectableItems = clientItems.filter((i) => !["ordered", "cancelled"].includes(i.status));

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (initialParams?.selectedIds) return new Set(initialParams.selectedIds as string[]);
    return new Set(selectableItems.filter((i) => i.status === "rental_started").map((i) => i.id));
  });
  const [changeTypes, setChangeTypes] = useState<Record<string, string>>(() => {
    if (initialParams?.changeTypes) return initialParams.changeTypes as Record<string, string>;
    const m: Record<string, string> = {};
    selectableItems.forEach((i) => { m[i.id] = i.status === "terminated" ? "回収" : "新規納品"; });
    return m;
  });

  const [creationDate, setCreationDate] = useState((initialParams?.creationDate as string) ?? todayStr);
  const [gender, setGender] = useState((initialParams?.gender as string) ?? client.gender ?? "");
  const [birthDate, setBirthDate] = useState((initialParams?.birthDate as string) ?? "");
  const [certStartDate, setCertStartDate] = useState((initialParams?.certStartDate as string) ?? "");
  const [consultantName, setConsultantName] = useState((initialParams?.consultantName as string) ?? "");
  const [consultantRelation, setConsultantRelation] = useState((initialParams?.consultantRelation as string) ?? "");
  const [consultationDate, setConsultationDate] = useState((initialParams?.consultationDate as string) ?? todayStr);
  const [monitoringMonths, setMonitoringMonths] = useState((initialParams?.monitoringMonths as string) ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { getCarePlanTemplates(tenantId).then(setTemplates); }, [tenantId]);

  const selectedItems = selectableItems.filter((i) => selectedIds.has(i.id));
  const getEq = (code: string) => equipment.find((e) => e.product_code === code);
  const selectedCategories = [...new Set(
    selectedItems.map((i) => getEq(i.product_code)?.category).filter(Boolean) as string[]
  )];
  const goalsText = selectedCategories.map((cat) => templates.find((t) => t.category === cat)?.goals ?? "").filter(Boolean).join("　");
  const precautionsText = selectedCategories.map((cat) => templates.find((t) => t.category === cat)?.precautions ?? "").filter(Boolean).join("　");

  const handlePrint = () => {
    const el = document.getElementById("care-plan-print-content");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>個別援助計画書</title><style>
      body{font-family:'Meiryo','MS PGothic',sans-serif;font-size:8.5pt;margin:0;padding:0}
      @page{size:A4 landscape;margin:8mm 10mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #555;padding:2px 4px;vertical-align:middle}
      .page-break{page-break-after:always;break-after:page}
    </style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handlePrintRight = () => {
    const el = document.getElementById("care-plan-right-col");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>選定福祉用具</title><style>
      body{font-family:'Meiryo','MS PGothic',sans-serif;font-size:8.5pt;margin:0;padding:0}
      @page{size:A4 portrait;margin:8mm 10mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #555;padding:2px 4px;vertical-align:middle}
      .right-col{display:flex;flex-direction:column;min-height:261mm}
      .right-col>*:last-child{flex:1}
    </style></head><body><div class="right-col">${el.innerHTML}</div></body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveClientDocument({
        tenant_id: tenantId, client_id: client.id, type: "care_plan",
        title: `個別援助計画書 ${creationDate}`,
        params: { creationDate, selectedIds: [...selectedIds], changeTypes, gender, birthDate, certStartDate, consultantName, consultantRelation, consultationDate, monitoringMonths },
      });
      onSaved?.();
    } finally { setSaving(false); }
  };

  const TD: React.CSSProperties = { border: "1px solid #555", padding: "3px 6px", verticalAlign: "middle" as const };
  const TH: React.CSSProperties = { border: "1px solid #555", background: "#eee", padding: "3px 6px", textAlign: "center" as const, whiteSpace: "nowrap" as const, verticalAlign: "middle" as const };

  return (
    <div className="fixed inset-0 bg-black/60 flex flex-col z-50 overflow-hidden">
      <div className="bg-white flex-1 overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <button onClick={step === 2 ? () => setStep(1) : onClose}>
            <ChevronLeft size={20} className="text-gray-500" />
          </button>
          <h2 className="font-semibold text-gray-800 flex-1">個別援助計画書</h2>
          {step === 1 && (
            <button
              disabled={selectedIds.size === 0}
              onClick={() => setStep(2)}
              className="px-4 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40"
            >プレビュー →</button>
          )}
          {step === 2 && (
            <div className="flex gap-2">
              <button onClick={handlePrint} className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 text-white text-sm font-medium rounded-xl">
                <Printer size={14} /> A4横（全体）
              </button>
              <button onClick={handlePrintRight} className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-xl">
                <Printer size={14} /> A4縦（右半分）
              </button>
              <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          )}
        </div>

        {step === 1 ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">書類に含める用具を選択</h3>
              {selectableItems.length === 0 ? (
                <p className="text-sm text-gray-400">対象となる用具がありません</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                  {selectableItems.map((item) => {
                    const eq = getEq(item.product_code);
                    const checked = selectedIds.has(item.id);
                    return (
                      <div key={item.id} className="flex items-center gap-2 px-3 py-2">
                        <input type="checkbox" checked={checked} onChange={(e) => {
                          const n = new Set(selectedIds);
                          e.target.checked ? n.add(item.id) : n.delete(item.id);
                          setSelectedIds(n);
                        }} className="accent-emerald-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-800 mr-1.5">{eq?.name ?? item.product_code}</span>
                          <span className="text-xs text-gray-400">
                            {eq?.category}{item.rental_price ? ` ¥${item.rental_price.toLocaleString()}` : ""}
                            {item.rental_start_date ? ` · 開始${item.rental_start_date}` : ""}
                          </span>
                        </div>
                        {checked && (
                          <select value={changeTypes[item.id] ?? "新規納品"}
                            onChange={(e) => setChangeTypes((p) => ({ ...p, [item.id]: e.target.value }))}
                            className="text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none shrink-0">
                            {CHANGE_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        )}
                        <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${STATUS_COLOR[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-gray-500">基本情報</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">作成日</label>
                  <input type="date" value={creationDate} onChange={(e) => setCreationDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">相談日</label>
                  <input type="date" value={consultationDate} onChange={(e) => setConsultationDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">生年月日</label>
                <input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">認定期間（開始日）</label>
                <input type="date" value={certStartDate} onChange={(e) => setCertStartDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-gray-500 block mb-1">相談者氏名</label>
                  <input value={consultantName} onChange={(e) => setConsultantName(e.target.value)} placeholder="山田花子"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
                </div>
                <div>
                  <label className="text-xs text-gray-500 block mb-1">続柄</label>
                  <input value={consultantRelation} onChange={(e) => setConsultantRelation(e.target.value)} placeholder="長女"
                    className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
                </div>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">モニタリング対象月</label>
                <input value={monitoringMonths} onChange={(e) => setMonitoringMonths(e.target.value)} placeholder="例：3月、6月、9月、12月"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-gray-100 p-4">
            <CarePlanPages
              selectedItems={selectedItems}
              getEq={getEq}
              client={client}
              companyInfo={companyInfo}
              creationDate={creationDate}
              gender={gender}
              birthDate={birthDate}
              certStartDate={certStartDate}
              consultantName={consultantName}
              consultantRelation={consultantRelation}
              consultationDate={consultationDate}
              monitoringMonths={monitoringMonths}
              goalsText={goalsText}
              precautionsText={precautionsText}
              TD={TD}
              TH={TH}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Proposal Modal ──────────────────────────────────────────────────────────

function ProposalModal({
  client,
  clientItems,
  equipment,
  companyInfo,
  tenantId,
  initialParams,
  onClose,
  onSaved,
}: {
  client: Client;
  clientItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  initialParams?: Record<string, unknown>;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [step, setStep] = useState<1 | 2>(1);
  const selectableItems = clientItems.filter((i) =>
    ["ordered", "delivered", "trial", "rental_started"].includes(i.status)
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (initialParams?.selectedIds) return new Set(initialParams.selectedIds as string[]);
    return new Set(selectableItems.map((i) => i.id));
  });
  const [creationDate, setCreationDate] = useState((initialParams?.creationDate as string) ?? todayStr);
  const [saving, setSaving] = useState(false);

  const selectedItems = selectableItems.filter((i) => selectedIds.has(i.id));
  const getEq = (code: string) => equipment.find((e) => e.product_code === code);

  const handlePrint = () => {
    const el = document.getElementById("proposal-print-content");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>選定提案書</title><style>
      body{font-family:'Meiryo','MS PGothic',sans-serif;font-size:9pt;margin:0;padding:0}
      @page{size:A4 portrait;margin:10mm 12mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #555;padding:2px 5px;vertical-align:middle}
    </style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveClientDocument({
        tenant_id: tenantId, client_id: client.id, type: "proposal",
        title: `選定提案書 ${creationDate}`,
        params: { creationDate, selectedIds: [...selectedIds] },
      });
      onSaved?.();
    } finally { setSaving(false); }
  };

  const TD: React.CSSProperties = { border: "1px solid #555", padding: "3px 6px", verticalAlign: "middle" as const };
  const TH: React.CSSProperties = { border: "1px solid #555", background: "#eee", padding: "3px 6px", textAlign: "center" as const, whiteSpace: "nowrap" as const, verticalAlign: "middle" as const };

  return (
    <div className="fixed inset-0 bg-black/60 flex flex-col z-50 overflow-hidden">
      <div className="bg-white flex-1 overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <button onClick={step === 2 ? () => setStep(1) : onClose}>
            <ChevronLeft size={20} className="text-gray-500" />
          </button>
          <h2 className="font-semibold text-gray-800 flex-1">選定提案書</h2>
          {step === 1 && (
            <button
              disabled={selectedIds.size === 0}
              onClick={() => setStep(2)}
              className="px-4 py-1.5 bg-blue-500 text-white text-sm font-medium rounded-xl disabled:opacity-40"
            >プレビュー →</button>
          )}
          {step === 2 && (
            <div className="flex gap-2">
              <button onClick={handlePrint} className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 text-white text-sm font-medium rounded-xl">
                <Printer size={14} /> 印刷
              </button>
              <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 bg-blue-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          )}
        </div>

        {step === 1 ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">提案する用具を選択</h3>
              {selectableItems.length === 0 ? (
                <p className="text-sm text-gray-400">対象となる用具がありません</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                  {selectableItems.map((item) => {
                    const eq = getEq(item.product_code);
                    const checked = selectedIds.has(item.id);
                    return (
                      <label key={item.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={(e) => {
                          const n = new Set(selectedIds);
                          e.target.checked ? n.add(item.id) : n.delete(item.id);
                          setSelectedIds(n);
                        }} className="accent-blue-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-gray-800 mr-1.5">{eq?.name ?? item.product_code}</span>
                          <span className="text-xs text-gray-400">
                            {eq?.category}{item.rental_price ? ` ¥${item.rental_price.toLocaleString()}` : ""}
                            {(eq?.comparison_product_codes?.length ?? 0) > 0 ? ` 比較${eq!.comparison_product_codes.length}件` : ""}
                          </span>
                        </div>
                        <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full ${STATUS_COLOR[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-gray-500">基本情報</h3>
              <div>
                <label className="text-xs text-gray-500 block mb-1">作成日</label>
                <input type="date" value={creationDate} onChange={(e) => setCreationDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-400" />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto bg-gray-100 p-4">
            <div id="proposal-print-content" className="bg-white p-8 max-w-[794px] mx-auto shadow"
              style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", fontSize: "9pt" }}>
              <p style={{ fontSize: "14pt", fontWeight: "bold", textAlign: "center", marginBottom: "10px" }}>選定提案書</p>
              <table style={{ borderCollapse: "collapse" as const, width: "100%", marginBottom: "6px" }}>
                <tbody>
                  <tr>
                    <td style={{ border: "none", width: "50%" }}>作成日：{creationDate ? toJapaneseEra(new Date(creationDate + "T00:00:00")) : "　　年　月　日"}</td>
                    <td style={{ border: "none", textAlign: "right" as const }}>担当者：{companyInfo.staffName}　</td>
                  </tr>
                  <tr>
                    <td style={{ border: "none" }}>事業所名：{companyInfo.companyName}</td>
                    <td style={{ border: "none", textAlign: "right" as const }}>事業所番号：{companyInfo.businessNumber}</td>
                  </tr>
                </tbody>
              </table>
              <table style={{ borderCollapse: "collapse" as const, width: "100%", marginBottom: "6px" }}>
                <tbody>
                  <tr>
                    <th style={{ ...TH, width: "80px" }}>利用者氏名</th>
                    <td style={TD}>{client.name}　様</td>
                    <th style={{ ...TH, width: "60px" }}>フリガナ</th>
                    <td style={TD}>{client.furigana ?? ""}</td>
                  </tr>
                  <tr>
                    <th style={TH}>介護度</th>
                    <td style={{ ...TD, width: "80px" }}>{client.care_level ?? ""}</td>
                    <th style={TH}>担当者</th>
                    <td style={TD}>{companyInfo.staffName}</td>
                  </tr>
                  <tr>
                    <th style={TH}>居宅支援事業所</th>
                    <td style={TD} colSpan={3}>{client.care_manager_org ?? ""}</td>
                  </tr>
                  <tr>
                    <th style={TH}>担当CM</th>
                    <td style={TD} colSpan={3}>{client.care_manager ?? ""}</td>
                  </tr>
                </tbody>
              </table>
              <p style={{ fontWeight: "bold", margin: "8px 0 4px" }}>【貸与を提案する福祉用具】</p>
              <table style={{ borderCollapse: "collapse" as const, width: "100%", marginBottom: "6px" }}>
                <thead>
                  <tr>
                    {["No", "種目名・貸与価格", "商品名", "提案する理由", "採　否"].map((h, i) => (
                      <th key={h} style={{ ...TH, width: i === 0 ? "24px" : i === 1 ? "90px" : i === 4 ? "48px" : undefined }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedItems.map((item, idx) => {
                    const eq = getEq(item.product_code);
                    const price = item.rental_price ?? eq?.rental_price;
                    const compCodes = (eq?.comparison_product_codes ?? []).filter((c) => equipment.find((e) => e.product_code === c));
                    const rowspan = 1 + compCodes.length;
                    return (
                      <Fragment key={item.id}>
                        <tr>
                          <td style={{ ...TD, textAlign: "center" as const }} rowSpan={rowspan}>{idx + 1}</td>
                          <td style={{ ...TD, verticalAlign: "top" as const }} rowSpan={rowspan}>
                            <p style={{ margin: 0 }}>{eq?.category ?? ""}</p>
                            {price && <p style={{ margin: "2px 0 0", fontSize: "7.5pt", color: "#555" }}>¥{price.toLocaleString()}/月</p>}
                          </td>
                          <td style={{ ...TD, fontWeight: "bold" }}>◎ {eq?.name ?? item.product_code}</td>
                          <td style={TD}>{eq?.proposal_reason ?? eq?.selection_reason ?? ""}</td>
                          <td style={{ ...TD, textAlign: "center" as const }}>採　否</td>
                        </tr>
                        {compCodes.map((compCode) => {
                          const compEq = equipment.find((e) => e.product_code === compCode);
                          if (!compEq) return null;
                          return (
                            <tr key={compCode}>
                              <td style={TD}>{compEq.name}</td>
                              <td style={TD}>{compEq.selection_reason ?? ""}</td>
                              <td style={{ ...TD, textAlign: "center" as const }}>採　否</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                  {(() => {
                    const totalRows = selectedItems.reduce((acc, item) => {
                      const eq = getEq(item.product_code);
                      const compCodes = (eq?.comparison_product_codes ?? []).filter((c) => equipment.find((e) => e.product_code === c));
                      return acc + 1 + compCodes.length;
                    }, 0);
                    return Array.from({ length: Math.max(0, 8 - totalRows) }).map((_, i) => (
                      <tr key={`empty-${i}`} style={{ height: "24px" }}>
                        <td style={{ ...TD, textAlign: "center" as const }}>&nbsp;</td>
                        <td style={TD}>&nbsp;</td>
                        <td style={TD}>&nbsp;</td>
                        <td style={TD}>&nbsp;</td>
                        <td style={{ ...TD, textAlign: "center" as const }}>&nbsp;</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
              <div style={{ textAlign: "right" as const, fontSize: "8.5pt", marginTop: "12px", borderTop: "1px solid #ccc", paddingTop: "6px" }}>
                {companyInfo.companyName}　{companyInfo.companyAddress}　TEL: {companyInfo.tel}　FAX: {companyInfo.fax}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Contract Documents Modal (重要事項説明書 + 契約書) ────────────────────────

function ContractDocumentsModal({
  client,
  clientItems,
  equipment,
  companyInfo,
  tenantId,
  onClose,
  onSaved,
}: {
  client: Client;
  clientItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [step, setStep] = useState<1 | 2>(1);
  const [explanationDate, setExplanationDate] = useState(todayStr);
  const [contractDate, setContractDate] = useState(todayStr);
  const [benefitRate, setBenefitRate] = useState<"1" | "2" | "3">("1");
  const [saving, setSaving] = useState(false);

  const selectableItems = clientItems.filter((i) =>
    ["ordered", "delivered", "rental_started"].includes(i.status)
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(selectableItems.map((i) => i.id))
  );
  const selectedItems = selectableItems.filter((i) => selectedIds.has(i.id));
  const getEq = (code: string) => equipment.find((e) => e.product_code === code);

  const explanationDateJa = explanationDate ? toJapaneseEra(new Date(explanationDate + "T00:00:00")) : "　　年　月　日";
  const contractDateJa    = contractDate    ? toJapaneseEra(new Date(contractDate    + "T00:00:00")) : "　　年　月　日";
  const certEndJa = client.certification_end_date
    ? toJapaneseEra(new Date(client.certification_end_date.slice(0, 10) + "T00:00:00"))
    : "　　年　月　日";
  const burdenLabel = benefitRate === "1" ? "１割" : benefitRate === "2" ? "２割" : "３割";

  const handlePrint = () => {
    const el = document.getElementById("combined-docs-print");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>重要事項説明書・契約書</title><style>
      body{font-family:'Meiryo','MS PGothic',sans-serif;font-size:8pt;margin:0;padding:0}
      @page{size:A4 portrait;margin:12mm 12mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #555;padding:2px 5px;vertical-align:top;font-size:8pt}
      h1{font-size:13pt;text-align:center;margin:0 0 6px;font-weight:bold}
      h2{font-size:9pt;margin:6px 0 2px;font-weight:bold;border-bottom:1px solid #333;padding-bottom:1px}
      .page-break{page-break-after:always}
      .article{margin-bottom:5px}
      p{margin:2px 0;line-height:1.5}
    </style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await Promise.all([
        saveClientDocument({
          tenant_id: tenantId, client_id: client.id,
          type: "important_matters",
          title: `重要事項説明書 ${explanationDate}`,
          params: { explanationDate },
        }),
        saveClientDocument({
          tenant_id: tenantId, client_id: client.id,
          type: "rental_contract",
          title: `福祉用具貸与契約書 ${contractDate}`,
          params: { contractDate, benefitRate, selectedIds: [...selectedIds] },
        }),
      ]);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  const TH: React.CSSProperties = { border: "1px solid #555", background: "#eee", padding: "2px 5px", fontWeight: "bold", textAlign: "left" };
  const TD: React.CSSProperties = { border: "1px solid #555", padding: "2px 5px", verticalAlign: "top" };

  return (
    <div className="fixed inset-0 bg-black/60 flex flex-col z-50 overflow-hidden">
      <div className="bg-white flex-1 overflow-hidden flex flex-col">
        {/* ヘッダー */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <button onClick={step === 2 ? () => setStep(1) : onClose}>
            <ChevronLeft size={20} className="text-gray-500" />
          </button>
          <h2 className="font-semibold text-gray-800 flex-1">書類作成（重要事項説明書・契約書）</h2>
          {step === 2 && (
            <div className="flex gap-2">
              <button onClick={handlePrint} className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 text-white text-sm font-medium rounded-xl">
                <Printer size={14} /> 印刷
              </button>
              <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          )}
          {step === 1 && (
            <button disabled={selectedIds.size === 0} onClick={() => setStep(2)}
              className="px-4 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
              プレビュー →
            </button>
          )}
        </div>

        {step === 1 ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">説明日（重要事項）</label>
                <input type="date" value={explanationDate} onChange={(e) => setExplanationDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">契約締結日</label>
                <input type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-400" />
              </div>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">負担割合</label>
              <select value={benefitRate} onChange={(e) => setBenefitRate(e.target.value as "1" | "2" | "3")}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-blue-400">
                <option value="1">１割</option>
                <option value="2">２割</option>
                <option value="3">３割</option>
              </select>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">契約対象の用具</h3>
              <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                {selectableItems.map((item) => {
                  const eq = getEq(item.product_code);
                  return (
                    <div key={item.id} className="flex items-center gap-2 px-3 py-2">
                      <input type="checkbox" checked={selectedIds.has(item.id)} onChange={(e) => {
                        const n = new Set(selectedIds);
                        e.target.checked ? n.add(item.id) : n.delete(item.id);
                        setSelectedIds(n);
                      }} className="accent-blue-500 shrink-0" />
                      <span className="text-sm text-gray-800">{eq?.name ?? item.product_code}</span>
                      {item.rental_price && <span className="ml-auto text-xs text-emerald-600">¥{item.rental_price.toLocaleString()}/月</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-gray-100 p-4">
            <div id="combined-docs-print">

              {/* ─── 重要事項説明書 ─── */}
              <div className="bg-white shadow mx-auto page-break"
                style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", fontSize: "8pt", padding: "12mm 12mm", maxWidth: "210mm", marginBottom: "16px" }}>
                <h1 style={{ fontSize: "13pt", textAlign: "center", fontWeight: "bold", marginBottom: "6px" }}>福祉用具貸与重要事項説明書</h1>
                <p style={{ textAlign: "right", marginBottom: "6px", fontSize: "7.5pt" }}>○管理者　{companyInfo.staffName}　氏名　　　　　　㊞</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>１．事業所の概要</h2>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "4px", fontSize: "8pt" }}><tbody>
                  <tr><th style={{ ...TH, width: "120px" }}>事　業　者　名</th><td style={TD}>{companyInfo.companyName}</td></tr>
                  <tr><th style={TH}>福 祉 用 具 貸 与 事 業 所 名</th><td style={TD}>{companyInfo.companyName}</td></tr>
                  <tr><th style={TH}>事　業　所　所　在　地</th><td style={TD}>{companyInfo.companyAddress}　TEL: {companyInfo.tel}　FAX: {companyInfo.fax}</td></tr>
                  <tr><th style={TH}>介護保険指定番号</th><td style={TD}>{companyInfo.businessNumber}</td></tr>
                  <tr><th style={TH}>管理者・連絡先</th><td style={TD}>{companyInfo.staffName}　TEL: {companyInfo.tel}</td></tr>
                  <tr><th style={TH}>通常の事業の実施地域</th><td style={TD}>{companyInfo.serviceArea || "　"}</td></tr>
                </tbody></table>
                <p style={{ margin: "0 0 4px", fontSize: "7.5pt" }}>※通常のサービス提供地域以外の方も希望される方はご気軽にご相談ください。</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>２．事業所の職員体制</h2>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "4px", fontSize: "8pt" }}>
                  <thead><tr>
                    <th style={{ ...TH, width: "160px" }}>職種</th>
                    <th style={{ ...TH, width: "50px", textAlign: "center" }}>常勤</th>
                    <th style={{ ...TH, width: "50px", textAlign: "center" }}>非常勤</th>
                  </tr></thead>
                  <tbody>
                    <tr><td style={TD}>管理者 兼 専門相談員</td><td style={{ ...TD, textAlign: "center" }}>{companyInfo.staffManagerFull}</td><td style={{ ...TD, textAlign: "center" }}>{companyInfo.staffManagerPart}</td></tr>
                    <tr><td style={TD}>専門相談員</td><td style={{ ...TD, textAlign: "center" }}>{companyInfo.staffSpecialistFull}</td><td style={{ ...TD, textAlign: "center" }}>{companyInfo.staffSpecialistPart}</td></tr>
                    <tr><td style={TD}>事務･配送職員</td><td style={{ ...TD, textAlign: "center" }}>{companyInfo.staffAdminFull}</td><td style={{ ...TD, textAlign: "center" }}>{companyInfo.staffAdminPart}</td></tr>
                  </tbody>
                </table>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>３．営業日・営業時間</h2>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "2px", fontSize: "8pt" }}><tbody>
                  <tr>
                    <th style={{ ...TH, width: "60px" }}>営業日</th><td style={TD}>{companyInfo.businessDays}</td>
                    <th style={{ ...TH, width: "60px" }}>営業時間</th><td style={TD}>{companyInfo.businessHours}</td>
                  </tr>
                </tbody></table>
                <p style={{ margin: "0 0 4px", fontSize: "7.5pt" }}>注）土・日曜、祝祭日、夏期休暇（8／13〜8／15）、年末年始休暇（12／30〜1／3）を休業とする。</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>４．福祉用具貸与の内容等</h2>
                <p style={{ margin: "0 0 2px" }}>　　福祉用具貸与にて取り扱う福祉用具の種目は、以下のとおりです。</p>
                <table style={{ borderCollapse: "collapse", width: "100%", margin: "0 0 4px", fontSize: "8pt" }}><tbody>
                  {[["車いす","車いす付属品","特殊寝台","特殊寝台付属品"],["床ずれ防止用具","体位変換器","手すり","スロープ"],["歩行器","歩行補助つえ","認知症老人徘徊感知機器","移動用リフト"],["自動排泄処理装置","排泄予測支援機器","",""]].map((row,i)=>(
                    <tr key={i}>{row.map((cell,j)=><td key={j} style={{ border:"1px solid #555", padding:"2px 6px", width:"25%" }}>{cell}</td>)}</tr>
                  ))}
                </tbody></table>
                <p style={{ margin: "0 0 2px" }}>　　介護予防福祉用具貸与にて取り扱う福祉用具の種目は、以下のとおりです。</p>
                <table style={{ borderCollapse: "collapse", margin: "0 0 4px", fontSize: "8pt" }}><tbody>
                  <tr>{["手すり","スロープ","歩行器","歩行補助つえ"].map((cell,j)=><td key={j} style={{ border:"1px solid #555", padding:"2px 6px" }}>{cell}</td>)}</tr>
                </tbody></table>
                <p style={{ margin: "0 0 4px", fontSize: "7.5pt" }}>※上記の（介護予防）福祉用具貸与品以外に、腰掛便座、入浴補助用具、等が介護保険制度により購入できます。また、住宅改修につきましても介護保険により支給されますので、希望される方はご相談ください。</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>５．サービスの利用方法</h2>
                <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（１）サービスの利用開始</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "2em" }}>まずは、電話等でご連絡ください。当社の専門相談員がご自宅に訪問させていただきます。重要事項を説明した後、正式に契約を結び、サービスの提供を開始します（居宅介護支援事業者に居宅サービス計画の作成を依頼している場合は、事前に当該介護支援専門員とご相談下さい）。</p>
                <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（２）サービスの終了</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>①お客様の都合によりサービスを終了する場合</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "3em" }}>サービスの終了を希望する日の1週間前までに文書又は口頭で通知することにより、サービスを終了することができます。</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>②当社の都合によりサービスを終了する場合（終了1ヶ月前までに通知します。）</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "3em" }}>やむを得ない事情により、当社よりサービスの提供を終了させていただく場合があります。</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>③自動終了</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "3em" }}>・お客様の要介護認定区分が、更新申請などにより、自立と認定された場合（この場合、条件を変更して再度契約することができます）</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "3em" }}>・お客様が介護保健施設に入所された場合　・医療機関へご入院された場合　・お客様が亡くなられた場合</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>④その他</p>
                <p style={{ margin: "0 0 4px", paddingLeft: "3em" }}>・当社が正当な理由なく適切なサービスを提供しない場合、守秘義務に反した場合などは、文書で解約を通知することによって即座にサービスを終了することができます。・サービス利用料金の支払いを１ヶ月以上遅延し、催告後３０日以内に支払わない場合等は直ちにサービスを終了させていただく場合があります。</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>６．当社の（介護予防）福祉用具貸与の運営の方針</h2>
                <p style={{ margin: "0 0 1px", paddingLeft: "1em" }}>・利用者が、可能な限り居宅において、自立した日常生活を営めるように、利用者の心身の状況、希望及びその置かれている環境を踏まえた適切な福祉用具選定の援助を行います。</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "1em" }}>・利用者の要介護状態の軽減もしくは悪化防止のため、適切な福祉用具貸与の提供を行います。</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "1em" }}>・サービス従業者は、業務上知り得た利用者又はその家族の秘密を保持します。</p>
                <p style={{ margin: "0 0 1px", paddingLeft: "1em" }}>・専門相談員の資質向上のために、定期的に福祉用具に関する適切な研修の機会を設けます。</p>
                <p style={{ margin: "0 0 4px", paddingLeft: "1em" }}>・災害発生時や感染症流行時などの非常時においては、事前に合意した日時・内容通りのサービスが提供できない可能性があります。利用者が避難所に避難された場合には、状況を考慮した上で提供可能と判断した場合にのみサービスを提供するものとします。</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>７．サービス内容に関する相談･苦情</h2>
                <p style={{ margin: "0 0 2px", paddingLeft: "1em" }}>当社福祉用具貸与事業に関する相談、要望、苦情等は、担当の専門相談員又はお客様サービス係までご連絡下さい。</p>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "2px", fontSize: "8pt" }}><tbody>
                  <tr>
                    <th style={{ ...TH, width: "80px" }}>事業所名</th><td style={TD}>{companyInfo.companyName}</td>
                    <th style={{ ...TH, width: "80px" }}>電話番号</th><td style={TD}>{companyInfo.tel}</td>
                  </tr>
                  <tr><th style={TH}>受付時間</th><td style={TD} colSpan={3}>{companyInfo.businessHours}（{companyInfo.businessDays}）</td></tr>
                </tbody></table>
                <p style={{ margin: "0 0 2px" }}>当社以外に、区役所・市役所・町、村役場などでも相談･苦情等に対する窓口があります。</p>
                <table style={{ borderCollapse: "collapse", width: "100%", margin: "0 0 4px", fontSize: "8pt" }}>
                  <tbody>
                    {[
                      ["千葉市",  "介護保険事業課",                  "043－245－5062"],
                      ["市原市",  "保健福祉部　高齢者支援課",        "0436－23－9873"],
                      ["四街道市","福祉サービス部　高齢者支援課",    "043－421－6127"],
                      ["習志野市","保健福祉部　高齢者支援課",        "047－454－7533"],
                      ["木更津市","福祉部　高齢者支援課　高齢者支援担当","0438－23－2630"],
                      ["佐倉市",  "福祉部　高齢者支援課",            "043－484－6243"],
                      ["", "", ""],
                    ].map(([city, dept, tel], i) => (
                      <tr key={i}>
                        <td style={{ border: "1px solid #555", padding: "2px 6px", width: "70px", textAlign: "center" }}>{city}</td>
                        <td style={{ border: "1px solid #555", padding: "2px 6px" }}>{dept}</td>
                        <td style={{ border: "1px solid #555", padding: "2px 6px", width: "110px", textAlign: "center" }}>{tel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* 説明者欄 */}
                <div style={{ border: "1px solid #555", padding: "5px 8px", marginBottom: "4px", fontSize: "7.5pt" }}>
                  <p style={{ margin: "0 0 2px" }}>私は、（介護予防）福祉用具貸与の提供について利用者またはその家族等に対して、契約書及び本書面によって重要事項を説明しました。</p>
                  <p style={{ margin: "0 0 2px" }}>説明日　{explanationDateJa}　　説明者　　　　　　　　　　　　㊞</p>
                  <p style={{ margin: "0 0 1px" }}>事業者　＜住所＞{companyInfo.companyAddress}　＜事業所名＞{companyInfo.companyName}　＜管理者名＞{companyInfo.staffName}　㊞</p>
                </div>
                <div style={{ marginBottom: "4px", fontSize: "7.5pt" }}>
                  <p style={{ margin: "0 0 1px" }}>○　利用者等に福祉用具搬入後、取扱説明書を説明し交付する。</p>
                  <p style={{ margin: "0 0 1px" }}>○　利用者等に貸与する福祉用具を使用しながら、使用方法を説明する。</p>
                  <p style={{ margin: "0 0 3px" }}>○　当該商品の全国平均貸与価格と、その貸与事業所の貸与価格の両方を利用者に説明する。</p>
                </div>
                <div style={{ border: "1px solid #555", padding: "5px 8px", fontSize: "7.5pt" }}>
                  <p style={{ margin: "0 0 2px" }}>私は、契約書及び本書面によって事業者から福祉用具貸与事業について重要事項及び上記について説明を受けました。</p>
                  <p style={{ margin: 0 }}>＜利用者氏名＞{client.name}　　　　　　印　　　　＜代理人氏名＞　　　　　　　　　　　　印</p>
                </div>
              </div>

              {/* ─── 福祉用具貸与契約書 ─── */}
              <div className="bg-white shadow mx-auto"
                style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", fontSize: "8.5pt", padding: "15mm 15mm", maxWidth: "210mm" }}>

                <h1 style={{ fontSize: "14pt", textAlign: "center", fontWeight: "bold", marginBottom: "12px" }}>
                  介護（介護予防）福祉用具貸与サービス契約書
                </h1>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "10px", fontSize: "8pt" }}><tbody>
                  <tr><td style={{ border: "none", paddingBottom: "4px" }}>契約締結日　{contractDateJa}</td></tr>
                  <tr><td style={{ border: "none" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}><tbody>
                      <tr>
                        <td style={{ border: "1px solid #555", padding: "4px 8px", width: "50%", verticalAlign: "top" }}>
                          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>利用者</div>
                          <div>＜住　所＞{client.address ?? ""}</div>
                          <div style={{ marginTop: "4px" }}>＜氏　名＞{client.name}　　　　印</div>
                        </td>
                        <td style={{ border: "1px solid #555", padding: "4px 8px", width: "50%", verticalAlign: "top" }}>
                          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>代理人</div>
                          <div>＜続　柄＞</div>
                          <div style={{ marginTop: "4px" }}>＜氏　名＞　　　　　　　　　　印</div>
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={2} style={{ border: "1px solid #555", padding: "4px 8px" }}>
                          <div style={{ fontWeight: "bold", marginBottom: "2px" }}>事　業　者</div>
                          <div>＜事業所名＞{companyInfo.companyName}</div>
                          <div>＜住　　所＞{companyInfo.companyAddress}</div>
                          <div style={{ marginTop: "2px" }}>＜管理者名＞　　　　　　　　　　㊞　　TEL：{companyInfo.tel}</div>
                        </td>
                      </tr>
                    </tbody></table>
                  </td></tr>
                </tbody></table>

                {[
                  { title: "第１条（契約の目的）", body: "　事業者は、利用者に対し、介護保険認定利用者に対して介護保険法令の趣旨に従って、利用者が可能な限りその居宅において、その有する能力に応じて自立した日常生活を営むことが出来るよう、（介護予防）福祉用具貸与を提供し、利用者は、事業者に対してそのサービスに対する料金を支払います。" },
                  { title: "第２条（契約期間）", body: `１　この契約の契約期間は、${contractDateJa}から利用者の要介護認定又は要支援認定の有効期限満了日（${certEndJa}）までとします。\n２　契約満了の１週間前までに、利用者から事業者に対して、文書又は口頭で契約終了の申し出がない場合、契約は自動更新されるものとします。` },
                  { title: "第３条（専門相談員）", body: "　事業者は、一定の研修を修了した専門相談員を配置し、専門相談員は、利用者の心身の状況、要望及びその置かれている環境を踏まえて、居宅介護支援事業者の作成する「居宅サービス計画」に沿って、福祉用具が適切に選定され、かつ使用されるよう、専門的知識に基づき、利用者からの相談に応じます。" },
                  { title: "第４条（（介護予防）福祉用具貸与の内容）", body: "１　福祉用具が適切に選定され、かつ使用されるよう、専門的知識に基づき、利用者からの相談に応じるとともに、取り扱い説明書等の文書を示して福祉用具の機能、使用方法、利用料金等に関する情報を提供し、個別の福祉用具の貸与に係る同意を得ます。\n２　貸与する福祉用具の機能、安全性、衛生状態などを考慮し、十分な点検を行います。\n３　利用者の心身の状況等に応じて福祉用具の調整を行うとともに、当該福祉用具の使用方法、使用上の留意事項、故障時の対応等を記載した文書を利用者に交付し、十分な説明を行った上で、必要に応じて利用者に実際に当該福祉用具を使用してもらいながら使用方法の指導を行います。\n４　貸与した福祉用具の使用状況の定期的な確認を行い、必要な場合は、使用方法の指導又は修理等を行います。" },
                  { title: "第５条（福祉用具貸与計画の作成）", body: "１　福祉用具専門相談員は、利用者の心身の状況、要望及びその置かれている環境を踏まえ、（介護予防）福祉用具利用計画・目標、当該目標を達成する為の具体的なサービスの内容を記載した福祉用具サービス計画を作成致します。\n２　福祉用具サービス計画は、既に居宅サービス計画が作成されている場合はその計画内容に沿って作成致します。\n３　福祉用具専門相談員は、福祉用具サービス計画の作成にあたり、その内容について利用者又はその家族に対して説明し、利用者様の同意を得てから計画をすすめてまいります。\n４　福祉用具専門相談員は、福祉用具サービス計画を作成した際には、当該福祉用具サービス計画を利用者様に交付致します。" },
                  { title: "第６条（サービス提供の記録）", body: "１　事業者は、サービス提供記録を作成することとし、この契約の終了後２年間保存します。\n２　利用者は、事業所の営業時間内にその事業所にて、当該利用者に関する第１項のサービス提供記録やサービスの実施マニュアル等、サービスの質を利用者が評価するための情報については、いつでも閲覧できます。\n３　利用者は、当該利用者に関する第１項のサービス実施記録等の複写物の交付を無料で受けることができます。" },
                ].map(({ title, body }) => (
                  <div key={title} style={{ marginBottom: "5px" }}>
                    <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>{title}</p>
                    <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{body}</p>
                  </div>
                ))}

                {/* 第７条 料金 */}
                <div style={{ marginBottom: "5px" }}>
                  <p style={{ fontWeight: "bold", margin: "0 0 4px" }}>第７条（料金）</p>
                  <p style={{ margin: "0 0 3px", paddingLeft: "1em", lineHeight: "1.6" }}>１　利用者は、サービスの対価として、下記の（介護予防）福祉用具貸与料金一覧表をもとに、月額料金の1割・2割・3割いずれかの合計額を利用者の負担として支払います。</p>
                  <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6" }}>２　搬出入にかかる費用は、現に福祉用具貸与に要した費用に含まれるものとし、別にいただきません。</p>
                  <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6" }}>３　事業者は当月の利用内容明細を請求書として、使用月の翌月末日までに利用者に交付します。</p>
                  <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6" }}>４　利用者は、事業者が発行した請求書に記載されている口座引き落とし日の前日までに、事前にご記入いただいた預金口座振替依頼書の指定金融機関の口座に、請求された金額をご入金ください。</p>
                  <p style={{ margin: "0 0 4px", paddingLeft: "1em", lineHeight: "1.6" }}>５　事業者は、利用者から料金の支払いを受けたときは、利用者に対し領収書を発行します。介護保険適用の場合、利用者の負担額は原則として下記の（介護予防）福祉用具貸与料金一覧表の1割・2割・3割のいずれかです。ただし、介護保険適用外のサービス利用については、全額が利用者の負担となります。</p>
                  <p style={{ fontWeight: "bold", margin: "0 0 2px", paddingLeft: "1em" }}>（介護予防）福祉用具貸与料金一覧表</p>
                  <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>（１）介護保険の適用がある場合は、料金表のサービス費の1割・2割・3割のいずれかが利用者負担額となります。</p>
                  <p style={{ margin: "0 0 4px", paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>　　下記の「利用者負担額」は介護保険の負担割合が1割の方の場合の負担額となります。介護保険の負担割合が２割または３割の方はこれに２または３を乗じた金額が負担額となります。</p>
                  <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "4px", fontSize: "8pt" }}>
                    <thead><tr>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center" }}>種目</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center" }}>福祉用具貸与商品</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "52px" }}>月額料金</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "32px" }}>数量</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "52px" }}>利用者負担</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "60px" }}>初月利用者負担</th>
                    </tr></thead>
                    <tbody>
                      {selectedItems.map((item) => {
                        const eq = getEq(item.product_code);
                        const price = item.rental_price ?? eq?.rental_price ?? 0;
                        const qty = item.quantity ?? 1;
                        const burden = Math.round(price * parseInt(benefitRate) / 10);
                        const halfBurden = Math.round(burden / 2);
                        return (
                          <tr key={item.id}>
                            <td style={{ border: "1px solid #555", padding: "3px 5px" }}>{eq?.category ?? ""}</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px" }}>{eq?.name ?? item.product_code}</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right" }}>{price ? `¥${price.toLocaleString()}` : ""}</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "center" }}>{qty}</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right" }}>{burden ? `¥${burden.toLocaleString()}` : ""}</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right" }}>{halfBurden ? `¥${halfBurden.toLocaleString()}` : ""}</td>
                          </tr>
                        );
                      })}
                      {(() => {
                        const total = selectedItems.reduce((s, i) => s + (i.rental_price ?? getEq(i.product_code)?.rental_price ?? 0) * (i.quantity ?? 1), 0);
                        const totalBurden = Math.round(total * parseInt(benefitRate) / 10);
                        const totalHalf = Math.round(totalBurden / 2);
                        return (
                          <tr>
                            <td colSpan={2} style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>合　計</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>¥{total.toLocaleString()}</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px" }}></td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>¥{totalBurden.toLocaleString()}</td>
                            <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>¥{totalHalf.toLocaleString()}</td>
                          </tr>
                        );
                      })()}
                    </tbody>
                  </table>
                  <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>（２）利用者負担金は契約開始月については使用月末締めの翌々月６日にご指定の金融機関の口座から引き落としをさせていただきます。（注）金融機関休業日の場合は翌営業日となります。</p>
                  <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>（３）尚、契約起算日が月の１５日以前の場合においては月額の全額を、１６日以降の場合においては１/２の料金を請求させていただきます。解約の場合も同様に月の１５日以前の解約については月額の１/２を、１６日以降の解約については１ヵ月分の料金を請求させていただきます。</p>
                </div>

                {[
                  { title: "第８条（（介護予防）福祉用具貸与の変更）", body: "１　利用者は、身体状況の急変等によって必要とする福祉用具に変更が生じた場合、事業者に対して当該福祉用具の変更を求めることができます。ただし、製品によっては料金の変更が生じる場合がありますのでご了承下さい。\n２　貸与された福祉用具について、万一不良品などで使い勝手が悪く、他に変更したい場合は、すぐにお申し出くだされば、無料で変更します。\n３　前記第２項については、同一製品に限り有効で、他製品への変更は、遠慮させていただきます。" },
                  { title: "第９条（料金の変更）", body: "１　事業者は、利用者に対して１ヵ月前までに文書で通知することにより、料金の変更（増額又は減額）を申し出ることができます。\n２　利用者が料金の変更を承諾する場合、新たな料金表に基づく【契約書別紙】を作成し、お互いに取り交わします。\n３　利用者は料金の変更を承諾しない場合、事業者に対し、文書で通知することにより、この契約を解除することができます。" },
                  { title: "第１０条（契約の終了）", body: "１　利用者は事業者に対して、１週間の予告期間を置いて文書又は口頭で通知することにより､この契約を解約することができます｡但し､利用者の病変、急な入院などやむをえない事情がある場合は､１週間以内の通知でもこの契約を解約することができます｡\n２　事業者は､やむをえない事情がある場合､利用者に対して､１ヵ月間の予告期間をおいて理由を示した文書で通知することにより､この契約を解約することができます｡\n３　次の事由に該当した場合は､利用者は文書で通知することにより､直ちにこの契約を解約することができます｡\n　①　事業者が正当な理由なくサービスを提供しない場合\n　②　事業者が守秘義務に反した場合\n　③　事業者が利用者やその家族などに対して社会理念を逸脱する行為を行った場合\n　④　事業者が破産した場合\n４　次の事由に該当した場合は､事業者は文書で通知することにより､直ちにこの契約を解約することができます｡\n　①　利用者のサービス料金の支払いが１ヵ月以上遅延し､料金を支払うよう催促したにもかかわらず､３０日以内に支払われない場合\n　②　利用者又はその家族などが､事業者やサービス提供者に対して本契約を継続しがたいほどの背信行為を行った場合\n５　次の事由に該当した場合は､この契約は自動的に終了します｡\n　①　利用者が介護保健施設に入所した場合\n　②　利用者の要介護（要支援）認定区分が、非該当（自立）と認定されたとき（この場合、内容を変更して再度契約することができます）\n　③　医療機関への入院\n　④　利用者が亡くなられたとき" },
                  { title: "第１１条（守秘義務）", body: "１　事業者及び事業者の使用する者は､（介護予防）福祉用具貸与を提供する上で知り得た利用者及びその家族に関する秘密を正当な理由なく第三者に漏らしません｡この守秘義務は契約終了後についても同様です｡\n２　事業者は､利用者からあらかじめ文書で同意を得ない限り、サービス担当者会議等において､利用者の個人情報を用いません｡\n３　事業者は､利用者の家族からあらかじめ文書で同意を得ない限り、サービス担当者会議等において、当該家族の個人情報を用いません｡" },
                  { title: "第１２条（利用者及びその家族等の義務）", body: "１　利用者及びその家族等は、レンタル商品について定められた使用方法及び使用上の注意事項を遵守する事とします。\n２　利用者等は、事業者の承諾を得ることなくレンタル商品の仕様変更、加工・改造等を行うことはできません。\n３　利用者等は、事業者の承諾を得ることなく本契約に基づく権利の全部もしくは一部を第三者に譲渡し又は転貸することはできません。" },
                  { title: "第１３条（福祉用具の保管･消毒）", body: "　福祉用具の保管･消毒については、指定居宅サービス等の事業の人員、設置及び運営に関する基準第２０３条第３項の規定に基づき、株式会社インフォゲート、フランスベッド株式会社、野口株式会社、株式会社日本ケアサプライ、ケアレックス株式会社にこの業務を委託し、業務委託契約書を取り交わした上で事業所は委託の契約の内容において、保管及び消毒が適切な方法により行われていることを担保します。" },
                  { title: "第１４条（賠償責任）", body: "　事業者は､福祉用具貸与サービスの提供に伴い、賠償責任を負う場合に備えて損害保険に加入し、納品時に家具に損傷を与えるなど、事業者の責めに帰すべき事由により利用者の生命・身体・財産に損害を及ぼした場合は､利用者に対してその損害を賠償します｡ただし、事業者は自己の責に帰すべからざる事由によって生じた損害については賠償責任を負いません。とりわけ、以下の事由に該当する場合には、損害賠償責任を免れます。\n①　利用者が、その疾患・心身状態及び福祉用具の設置・使用環境等、レンタル商品の選定に必要な事項について故意にこれを告げず、又は不実の告知を行ったことに起因して損害が発生した場合。\n②　利用者の急激な体調の変化等、事業者の実施した（介護予防）福祉用具貸与サービスを原因としない事由に起因して損害が発生した場合。\n③　利用者又はその家族が、事業者及びサービス従事者の指示・説明に反して行った行為に起因して損害が発生した場合。" },
                  { title: "第１５条（災害等発生時のサービス提供）", body: "１　災害発生時や感染症流行時などの非常時においては、事業者は従業員の安全を確保した上でサービスを提供するため、事前に合意した日時・内容通りのサービスが提供できない可能性があります。\n２　利用者が避難所に避難された場合には、サービス提供の場所が変わることになりますので、道路状況・人員体制・避難所の環境等を考慮した上で、サービスの提供が可能と事業者が判断した場合にのみサービスを提供するものとします。" },
                  { title: "第１６条（利用者の損害賠償責任）", body: "　事業者は、利用者の故意又は重大な過失によってレンタル商品が消失し、又は回収したレンタル商品について通常の使用状態を超える著しい破損・汚損等が認められる場合には、利用者等に対して補修費もしくは弁償費相当額の支払を請求することができます。" },
                  { title: "第１７条（身分証携帯義務）", body: "　サービス従業者は、常に身分証を携帯し、初回納品時及び利用者やその家族から提示を求められたときは、いつでも身分証を提示します。" },
                  { title: "第１８条（連携）", body: "１　事業者は、福祉用具貸与の提供にあたり、介護支援専門員及び保健医療サービス又は福祉サービスを提供する者との密接な関係に努めます。\n２　事業者は、本契約の内容が変更された場合又は本契約が終了した場合は、その内容を記した書面の写しを速やかに介護支援専門員に送付します。なお、第１０条２項及び４項に基づいて解約通知をする際は、事前に介護支援専門員に連絡します。" },
                  { title: "第１９条（苦情処理）", body: "１　事業者は、利用者からの相談･苦情に対する窓口を設置し、当該福祉用具の故障・修理依頼など、（介護予防）福祉用具貸与に関する利用者の要望、苦情等に対し、迅速に対応します。\n２　苦情の内容によっては、再発防止のために関係メーカー及び提携先との連携･調整を行います。また、必要に応じて「苦情処理改善会議」を開催します。\n３　事業者は、利用者が苦情等を申し立てた場合であっても、これを理由にしていかなる不利益な扱いをしません。" },
                  { title: "第２０条（信義誠実の原則）", body: "１　利用者及び事業者は、信義に従い誠実に本契約を履行するものとする。\n２　本契約に定める事項に疑義が生じた場合及び本契約に定めのない事項については、介護保険法令その他諸法令の定めるところを尊重し、双方の協議の上定めるものとします。" },
                ].map(({ title, body }) => (
                  <div key={title} style={{ marginBottom: "5px" }}>
                    <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>{title}</p>
                    <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{body}</p>
                  </div>
                ))}

                <p style={{ margin: "10px 0 8px", lineHeight: "1.6", fontSize: "8pt" }}>
                  本契約書の契約内容を証するため、本書２通を作成し、利用者、事業者が署名押印の上、各自１通保有するものとします。同様に、介護保険制度にて義務づけられているサービス担当者会議の開催が必要と認められる場合において、利用者様の個人情報を用いることについての説明を受け、同意するものといたします。
                </p>

                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "8pt" }}><tbody>
                  <tr>
                    <td style={{ border: "1px solid #555", padding: "6px 8px", width: "50%", verticalAlign: "top", height: "60px" }}>
                      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>利用者</div>
                      <div>＜住　所＞{client.address ?? ""}</div>
                      <div style={{ marginTop: "8px" }}>＜氏　名＞{client.name}　　　　　　印</div>
                    </td>
                    <td style={{ border: "1px solid #555", padding: "6px 8px", width: "50%", verticalAlign: "top" }}>
                      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>代理人（続柄：　　　）</div>
                      <div style={{ marginTop: "8px" }}>＜氏　名＞　　　　　　　　　　　　印</div>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={2} style={{ border: "1px solid #555", padding: "6px 8px", verticalAlign: "top" }}>
                      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>事　業　者</div>
                      <div>＜事業所名＞{companyInfo.companyName}</div>
                      <div>＜住　　所＞{companyInfo.companyAddress}　TEL：{companyInfo.tel}</div>
                      <div style={{ marginTop: "8px" }}>＜管理者名＞　　　　　　　　　　　　㊞</div>
                      <div style={{ marginTop: "4px" }}>＜担　　当＞{companyInfo.staffName}　　　　印</div>
                      <div style={{ marginTop: "4px" }}>説　明　者：　　　　　　　　　　　　印</div>
                    </td>
                  </tr>
                </tbody></table>

                <div style={{ marginTop: "10px", border: "1px solid #555", padding: "6px 8px", fontSize: "7.5pt" }}>
                  <p style={{ fontWeight: "bold", margin: "0 0 3px" }}>【個人情報の取り扱いについて】</p>
                  <p style={{ margin: 0, lineHeight: "1.6" }}>当事業所はご利用者様の身体的状況やご家族の状況をケアプラン上必要な情報に限り、ご利用者様担当ケアマネージャーに報告致します。当事業所内においてのお客様に関するサービス内容の検討や、向上の為のケース会議、ケアマネージャー様等関係従事者様とのサービス担当者会議以外に個人情報を用いない事を厳守いたします。</p>
                </div>

              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Important Matters Modal ─────────────────────────────────────────────────

function ImportantMattersModal({
  client,
  companyInfo,
  tenantId,
  onClose,
  onSaved,
}: {
  client: Client;
  companyInfo: CompanyInfo;
  tenantId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [explanationDate, setExplanationDate] = useState(todayStr);
  const [step, setStep] = useState<1 | 2>(1);
  const [saving, setSaving] = useState(false);

  const explanationDateJa = explanationDate
    ? toJapaneseEra(new Date(explanationDate + "T00:00:00"))
    : "　　年　月　日";

  const handlePrint = () => {
    const el = document.getElementById("important-matters-print");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>重要事項説明書</title><style>
      body{font-family:'Meiryo','MS PGothic',sans-serif;font-size:8pt;margin:0;padding:0}
      @page{size:A4 portrait;margin:12mm 12mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #555;padding:2px 5px;vertical-align:top;font-size:8pt}
      h1{font-size:13pt;text-align:center;margin:0 0 6px;font-weight:bold}
      h2{font-size:9pt;margin:8px 0 3px;font-weight:bold;border-bottom:1px solid #333;padding-bottom:1px}
      .section{margin-bottom:6px}
      p{margin:2px 0;line-height:1.5}
      .indent{padding-left:1em}
      .indent2{padding-left:2em}
    </style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveClientDocument({
        tenant_id: tenantId,
        client_id: client.id,
        type: "important_matters",
        title: `重要事項説明書 ${explanationDate}`,
        params: { explanationDate },
      });
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  const TH: React.CSSProperties = { border: "1px solid #555", background: "#eee", padding: "2px 5px", fontWeight: "bold", textAlign: "left" };
  const TD: React.CSSProperties = { border: "1px solid #555", padding: "2px 5px", verticalAlign: "top" };

  return (
    <div className="fixed inset-0 bg-black/60 flex flex-col z-50 overflow-hidden">
      <div className="bg-white flex-1 overflow-hidden flex flex-col">
        {/* ヘッダー */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <button onClick={step === 2 ? () => setStep(1) : onClose}>
            <ChevronLeft size={20} className="text-gray-500" />
          </button>
          <h2 className="font-semibold text-gray-800 flex-1">重要事項説明書</h2>
          {step === 2 && (
            <div className="flex gap-2">
              <button onClick={handlePrint} className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 text-white text-sm font-medium rounded-xl">
                <Printer size={14} /> 印刷
              </button>
              <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          )}
          {step === 1 && (
            <button onClick={() => setStep(2)} className="px-4 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl">
              プレビュー →
            </button>
          )}
        </div>

        {step === 1 ? (
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <label className="text-xs text-gray-500 block mb-1">説明日</label>
              <input type="date" value={explanationDate} onChange={(e) => setExplanationDate(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-purple-400" />
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto bg-gray-100 p-4">
            <div id="important-matters-print" className="bg-white shadow mx-auto"
              style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", fontSize: "8pt", padding: "12mm 12mm", maxWidth: "210mm" }}>

              <h1 style={{ fontSize: "13pt", textAlign: "center", fontWeight: "bold", marginBottom: "8px" }}>
                福祉用具貸与重要事項説明書
              </h1>
              <p style={{ textAlign: "right", marginBottom: "6px", fontSize: "7.5pt" }}>
                ○管理者　{companyInfo.staffName}　氏名　　　　　　㊞
              </p>

              {/* 1. 事業所の概要 */}
              <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>１．事業所の概要</h2>
              <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "6px", fontSize: "8pt" }}>
                <tbody>
                  <tr>
                    <th style={{ ...TH, width: "120px" }}>事　業　者　名</th>
                    <td style={TD}>{companyInfo.companyName}</td>
                  </tr>
                  <tr>
                    <th style={TH}>福 祉 用 具 貸 与 事 業 所 名</th>
                    <td style={TD}>{companyInfo.companyName}</td>
                  </tr>
                  <tr>
                    <th style={TH}>事　業　所　所　在　地</th>
                    <td style={TD}>{companyInfo.companyAddress}　TEL: {companyInfo.tel}　FAX: {companyInfo.fax}</td>
                  </tr>
                  <tr>
                    <th style={TH}>介護保険指定番号及びその他サービス</th>
                    <td style={TD}>{companyInfo.businessNumber}</td>
                  </tr>
                  <tr>
                    <th style={TH}>管理者・連絡先</th>
                    <td style={TD}>{companyInfo.staffName}　TEL: {companyInfo.tel}</td>
                  </tr>
                  <tr>
                    <th style={TH}>通常の事業の実施地域</th>
                    <td style={TD}>&nbsp;</td>
                  </tr>
                </tbody>
              </table>
              <p style={{ margin: "0 0 6px", fontSize: "7.5pt" }}>※通常のサービス提供地域以外の方も希望される方はご気軽にご相談ください。</p>

              {/* 2. 職員体制 */}
              <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>２．事業所の職員体制</h2>
              <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "6px", fontSize: "8pt" }}>
                <thead>
                  <tr>
                    <th style={{ ...TH, width: "160px" }}>職種</th>
                    <th style={{ ...TH, width: "60px", textAlign: "center" }}>常勤</th>
                    <th style={{ ...TH, width: "60px", textAlign: "center" }}>非常勤</th>
                  </tr>
                </thead>
                <tbody>
                  {[["管理者 兼 専門相談員", "", ""], ["専門相談員", "", ""], ["事務･配送職員", "", ""]].map(([role, f, p]) => (
                    <tr key={role}>
                      <td style={TD}>{role}</td>
                      <td style={{ ...TD, textAlign: "center" }}>{f}</td>
                      <td style={{ ...TD, textAlign: "center" }}>{p}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* 3. 営業日・営業時間 */}
              <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>３．営業日・営業時間</h2>
              <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "2px", fontSize: "8pt" }}>
                <tbody>
                  <tr>
                    <th style={{ ...TH, width: "60px" }}>営業日</th>
                    <td style={TD}>月曜日〜土曜日（祝日を除く）</td>
                    <th style={{ ...TH, width: "60px" }}>営業時間</th>
                    <td style={TD}>9:00〜17:00</td>
                  </tr>
                </tbody>
              </table>
              <p style={{ margin: "0 0 6px", fontSize: "7.5pt" }}>注）土・日曜、祝祭日、夏期休暇（8／13〜8／15）、年末年始休暇（12／30〜1／3）を休業とする。</p>

              {/* 4. 福祉用具貸与の内容等 */}
              <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>４．福祉用具貸与の内容等</h2>
              <p style={{ margin: "0 0 2px" }}>　　福祉用具貸与にて取り扱う福祉用具の種目は、以下のとおりです。</p>
              <table style={{ borderCollapse: "collapse", width: "100%", margin: "0 0 4px", fontSize: "8pt" }}><tbody>
                {[["車いす","車いす付属品","特殊寝台","特殊寝台付属品"],["床ずれ防止用具","体位変換器","手すり","スロープ"],["歩行器","歩行補助つえ","認知症老人徘徊感知機器","移動用リフト"],["自動排泄処理装置","排泄予測支援機器","",""]].map((row,i)=>(
                  <tr key={i}>{row.map((cell,j)=><td key={j} style={{ border:"1px solid #555", padding:"2px 6px", width:"25%" }}>{cell}</td>)}</tr>
                ))}
              </tbody></table>
              <p style={{ margin: "0 0 2px" }}>　　介護予防福祉用具貸与にて取り扱う福祉用具の種目は、以下のとおりです。</p>
              <table style={{ borderCollapse: "collapse", margin: "0 0 4px", fontSize: "8pt" }}><tbody>
                <tr>{["手すり","スロープ","歩行器","歩行補助つえ"].map((cell,j)=><td key={j} style={{ border:"1px solid #555", padding:"2px 6px" }}>{cell}</td>)}</tr>
              </tbody></table>
              <p style={{ margin: "0 0 2px", fontSize: "7.5pt" }}>※上記の（介護予防）福祉用具貸与品以外に、腰掛便座、入浴補助用具、等が介護保険制度により購入できます。</p>
              <p style={{ margin: "0 0 6px", fontSize: "7.5pt" }}>※住宅改修につきましても介護保険により支給されますので、希望される方はご相談ください。</p>

              {/* 5. サービスの利用方法 */}
              <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>５．サービスの利用方法</h2>
              <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（１）サービスの利用開始</p>
              <p style={{ margin: "0 0 2px", paddingLeft: "2em" }}>まずは、電話等でご連絡ください。当社の専門相談員がご自宅に訪問させていただきます。重要事項を説明した後、正式に契約を結び、サービスの提供を開始します（居宅介護支援事業者に、居宅サービス計画の作成を依頼している場合は、事前に当該介護支援専門員とご相談下さい）。</p>
              <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（２）サービスの終了</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>①お客様の都合によりサービスを終了する場合</p>
              <p style={{ margin: "0 0 2px", paddingLeft: "3em" }}>サービスの終了を希望する日の1週間前までに文書又は口頭で通知することにより、サービスを終了することができます。この場合、お客様が居宅介護支援事業者に居宅サービス計画の作成を依頼している場合は、当該事業者にも通知してください。</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>②当社の都合によりサービスを終了する場合（終了1ヶ月前までに通知します。）</p>
              <p style={{ margin: "0 0 2px", paddingLeft: "3em" }}>やむを得ない事情により、当社よりサービスの提供を終了させていただく場合があります。</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>③自動終了</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "3em" }}>以下の場合は、文書による通知がなくても、自動的にサービスを終了させて頂きます。</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "3em" }}>・お客様の要介護認定区分が、更新申請などにより、自立と認定された場合（この場合、条件を変更して再度契約することができます）</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "3em" }}>・お客様が介護保健施設に入所された場合</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "3em" }}>・医療機関へご入院された場合</p>
              <p style={{ margin: "0 0 2px", paddingLeft: "3em" }}>・お客様が亡くなられた場合</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>④その他</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "3em" }}>・当社が正当な理由なく適切なサービスを提供しない場合、守秘義務に反した場合、お客様やその家族などに対して社会通念を逸脱する行為を行った場合などは、文書で解約を通知することによって即座にサービスを終了することができます。</p>
              <p style={{ margin: "0 0 6px", paddingLeft: "3em" }}>・お客様が、サービス利用料金の支払いを１ヶ月以上遅延し、料金を支払うよう催告したにもかかわらず、３０日以内に支払わない場合、またはお客様やご家族などが当社のサービス従業者に対して本契約を継続しがたいほどの背信行為を行った場合は、文書で通知することにより、直ちにサービスの提供を終了させていただく場合があります。</p>

              {/* 6. 運営の方針 */}
              <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>６．当社の（介護予防）福祉用具貸与の運営の方針</h2>
              <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（１）運営の方針</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>・利用者が、可能な限り居宅において、その有する能力に応じて、自立した日常生活を営めるように、利用者の心身の状況、希望及びその置かれている環境を踏まえた適切な福祉用具選定の援助を行います。</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>・利用者の要介護状態の軽減もしくは悪化防止又は要介護状態となることの予防に資するよう、適切な福祉用具貸与の提供を行います。</p>
              <p style={{ margin: "0 0 2px", paddingLeft: "2em" }}>・福祉用具貸与の提供にあたっては、貸与する福祉用具の機能、安全性、衛生状態等に関し、十分な説明を行った上で、必要に応じて利用者に実際に福祉用具を使用してもらいながら使用方法の指導を行います。</p>
              <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（２）その他重要事項</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>・サービス従業者は、業務上知り得た利用者又はその家族の秘密を保持します。又、従業者であったものに、従業員でなくなった後においてもこれらの秘密を保持する旨を、従業者との雇用契約の内容とします。</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>・利用者の身体状態の多様性、変化等に対応することができるように、できる限り多くの種類の福祉用具を取り扱うように努めます。</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>・専門相談員の資質向上のために、定期的に福祉用具に関する適切な研修の機会を設けます。</p>
              <p style={{ margin: "0 0 1px", paddingLeft: "2em" }}>・災害発生時や感染症流行時などの非常時においては、事業者は従業員の安全を確保した上でサービスを提供するため、事前に合意した日時・内容通りのサービスが提供できない可能性があります。</p>
              <p style={{ margin: "0 0 6px", paddingLeft: "2em" }}>・利用者が避難所に避難された場合には、サービス提供の場所が変わることになりますので、道路状況・人員体制・避難所の環境等を考慮した上で、サービスの提供が可能と事業者が判断した場合にのみサービスを提供するものとします。</p>

              {/* 7. 苦情処理 */}
              <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>７．サービス内容に関する相談･苦情</h2>
              <p style={{ margin: "0 0 2px", paddingLeft: "1em" }}>当社福祉用具貸与事業に関する相談、要望、苦情等は、担当の専門相談員又はお客様サービス係までご連絡下さい。</p>
              <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "2px", fontSize: "8pt" }}>
                <tbody>
                  <tr>
                    <th style={{ ...TH, width: "80px" }}>事業所名</th>
                    <td style={TD}>{companyInfo.companyName}</td>
                    <th style={{ ...TH, width: "80px" }}>電話番号</th>
                    <td style={TD}>{companyInfo.tel}</td>
                  </tr>
                  <tr>
                    <th style={TH}>受付時間</th>
                    <td style={TD} colSpan={3}>9:00〜17:00（月〜土、祝日除く）</td>
                  </tr>
                </tbody>
              </table>
              <p style={{ margin: "0 0 2px" }}>当社以外に、区役所・市役所・町、村役場などでも相談･苦情等に対する窓口があります。</p>
              <table style={{ borderCollapse: "collapse", width: "100%", margin: "0 0 6px", fontSize: "8pt" }}>
                <tbody>
                  {[
                    ["千葉市",  "介護保険事業課",                  "043－245－5062"],
                    ["市原市",  "保健福祉部　高齢者支援課",        "0436－23－9873"],
                    ["四街道市","福祉サービス部　高齢者支援課",    "043－421－6127"],
                    ["習志野市","保健福祉部　高齢者支援課",        "047－454－7533"],
                    ["木更津市","福祉部　高齢者支援課　高齢者支援担当","0438－23－2630"],
                    ["佐倉市",  "福祉部　高齢者支援課",            "043－484－6243"],
                    ["", "", ""],
                  ].map(([city, dept, tel], i) => (
                    <tr key={i}>
                      <td style={{ border: "1px solid #555", padding: "2px 6px", width: "70px", textAlign: "center" }}>{city}</td>
                      <td style={{ border: "1px solid #555", padding: "2px 6px" }}>{dept}</td>
                      <td style={{ border: "1px solid #555", padding: "2px 6px", width: "110px", textAlign: "center" }}>{tel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* 説明者欄 */}
              <div style={{ border: "1px solid #555", padding: "6px 8px", marginBottom: "6px", fontSize: "7.5pt" }}>
                <p style={{ margin: "0 0 3px" }}>私は、（介護予防）福祉用具貸与の提供について利用者またはその家族等に対して、契約書及び本書面によって重要事項を説明しました。</p>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "8pt" }}>
                  <tbody>
                    <tr>
                      <td style={{ border: "none", padding: "2px 5px", width: "50%" }}>
                        説明日　{explanationDateJa}
                      </td>
                      <td style={{ border: "none", padding: "2px 5px" }}>
                        説明者　　　　　　　　　　　　㊞
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={2} style={{ border: "none", padding: "2px 5px" }}>
                        事業者　＜住　所＞{companyInfo.companyAddress}
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={2} style={{ border: "none", padding: "2px 5px" }}>
                        　　　　＜事業所名＞{companyInfo.companyName}　　＜管理者名＞{companyInfo.staffName}　㊞
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* 確認チェック項目 */}
              <div style={{ marginBottom: "6px", fontSize: "7.5pt" }}>
                <p style={{ margin: "0 0 1px" }}>○　利用者等に福祉用具搬入後、取扱説明書を説明し交付する。</p>
                <p style={{ margin: "0 0 1px" }}>○　利用者等に貸与する福祉用具を使用しながら、使用方法を説明する。</p>
                <p style={{ margin: "0 0 3px" }}>○　当該商品の全国平均貸与価格と、その貸与事業所の貸与価格の両方を利用者に説明する。</p>
              </div>

              {/* 利用者同意欄 */}
              <div style={{ border: "1px solid #555", padding: "6px 8px", fontSize: "7.5pt" }}>
                <p style={{ margin: "0 0 3px" }}>私は、契約書及び本書面によって事業者から福祉用具貸与事業について重要事項及び上記について説明を受けました。</p>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "8pt" }}>
                  <tbody>
                    <tr>
                      <td style={{ border: "none", padding: "4px 5px", width: "50%" }}>
                        ＜利用者氏名＞{client.name}　　　　　　印
                      </td>
                      <td style={{ border: "none", padding: "4px 5px" }}>
                        ＜代理人氏名＞　　　　　　　　　　　　印
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Rental Contract Modal ───────────────────────────────────────────────────

function RentalContractModal({
  client,
  clientItems,
  equipment,
  companyInfo,
  tenantId,
  onClose,
  onSaved,
}: {
  client: Client;
  clientItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [step, setStep] = useState<1 | 2>(1);
  const [contractDate, setContractDate] = useState(todayStr);
  const [benefitRate, setBenefitRate] = useState<"1" | "2" | "3">("1");
  const [saving, setSaving] = useState(false);

  const selectableItems = clientItems.filter((i) =>
    ["ordered", "delivered", "rental_started"].includes(i.status)
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(selectableItems.map((i) => i.id))
  );
  const selectedItems = selectableItems.filter((i) => selectedIds.has(i.id));
  const getEq = (code: string) => equipment.find((e) => e.product_code === code);

  const handlePrint = () => {
    const el = document.getElementById("rental-contract-print");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>福祉用具貸与契約書</title><style>
      body{font-family:'Meiryo','MS PGothic',sans-serif;font-size:8.5pt;margin:0;padding:0}
      @page{size:A4 portrait;margin:15mm 15mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #555;padding:2px 5px;vertical-align:top}
      h1{font-size:13pt;text-align:center;margin:0 0 8px}
      h2{font-size:9.5pt;margin:10px 0 3px;border-bottom:1px solid #333;padding-bottom:2px}
      .article{margin-bottom:6px}
      .article-title{font-weight:bold;margin:0 0 2px}
      .article-body{margin:0;padding-left:1em;white-space:pre-wrap;line-height:1.5}
      .sig-table td{height:40px}
      .no-border td,.no-border th{border:none}
    </style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveClientDocument({
        tenant_id: tenantId,
        client_id: client.id,
        type: "rental_contract",
        title: `福祉用具貸与契約書 ${contractDate}`,
        params: { contractDate, benefitRate, selectedIds: [...selectedIds] },
      });
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  const contractDateJa = contractDate
    ? toJapaneseEra(new Date(contractDate + "T00:00:00"))
    : "　　年　月　日";
  const certEndJa = client.certification_end_date
    ? toJapaneseEra(new Date(client.certification_end_date.slice(0, 10) + "T00:00:00"))
    : "　　年　月　日";

  const burdenLabel = benefitRate === "1" ? "１割" : benefitRate === "2" ? "２割" : "３割";

  return (
    <div className="fixed inset-0 bg-black/60 flex flex-col z-50 overflow-hidden">
      <div className="bg-white flex-1 overflow-hidden flex flex-col">
        {/* ヘッダー */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <button onClick={step === 2 ? () => setStep(1) : onClose}>
            <ChevronLeft size={20} className="text-gray-500" />
          </button>
          <h2 className="font-semibold text-gray-800 flex-1">福祉用具貸与契約書</h2>
          {step === 2 && (
            <div className="flex gap-2">
              <button onClick={handlePrint} className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 text-white text-sm font-medium rounded-xl">
                <Printer size={14} /> 印刷
              </button>
              <button onClick={handleSave} disabled={saving} className="px-3 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          )}
          {step === 1 && (
            <button
              disabled={selectedIds.size === 0}
              onClick={() => setStep(2)}
              className="px-4 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40"
            >プレビュー →</button>
          )}
        </div>

        {step === 1 ? (
          /* ステップ1: 設定 */
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-gray-500 block mb-1">契約締結日</label>
                <input type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400" />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">負担割合</label>
                <select value={benefitRate} onChange={(e) => setBenefitRate(e.target.value as "1" | "2" | "3")}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400">
                  <option value="1">１割</option>
                  <option value="2">２割</option>
                  <option value="3">３割</option>
                </select>
              </div>
            </div>
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">契約対象の用具を選択</h3>
              <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                {selectableItems.map((item) => {
                  const eq = getEq(item.product_code);
                  const checked = selectedIds.has(item.id);
                  return (
                    <div key={item.id} className="flex items-center gap-2 px-3 py-2">
                      <input type="checkbox" checked={checked} onChange={(e) => {
                        const n = new Set(selectedIds);
                        e.target.checked ? n.add(item.id) : n.delete(item.id);
                        setSelectedIds(n);
                      }} className="accent-emerald-500 shrink-0" />
                      <span className="text-sm text-gray-800">{eq?.name ?? item.product_code}</span>
                      {item.rental_price && (
                        <span className="ml-auto text-xs text-emerald-600">¥{item.rental_price.toLocaleString()}/月</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          /* ステップ2: プレビュー */
          <div className="flex-1 overflow-auto bg-gray-100 p-4">
            <div id="rental-contract-print" className="bg-white shadow mx-auto"
              style={{ fontFamily: "'Meiryo','MS PGothic',sans-serif", fontSize: "8.5pt", padding: "15mm 15mm", maxWidth: "210mm" }}>

              <h1 style={{ fontSize: "14pt", textAlign: "center", fontWeight: "bold", marginBottom: "12px" }}>
                介護（介護予防）福祉用具貸与サービス契約書
              </h1>

              {/* 契約締結日・当事者 */}
              <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "10px", fontSize: "8pt" }}><tbody>
                <tr>
                  <td style={{ border: "none", paddingBottom: "4px" }}>
                    契約締結日　{contractDateJa}
                  </td>
                </tr>
                <tr>
                  <td style={{ border: "none" }}>
                    <table style={{ borderCollapse: "collapse", width: "100%" }}><tbody>
                      <tr>
                        <td style={{ border: "1px solid #555", padding: "4px 8px", width: "50%", verticalAlign: "top" }}>
                          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>利用者</div>
                          <div>＜住　所＞{client.address ?? ""}</div>
                          <div style={{ marginTop: "4px" }}>＜氏　名＞{client.name}　　　　印</div>
                        </td>
                        <td style={{ border: "1px solid #555", padding: "4px 8px", width: "50%", verticalAlign: "top" }}>
                          <div style={{ fontWeight: "bold", marginBottom: "4px" }}>代理人</div>
                          <div>＜続　柄＞</div>
                          <div style={{ marginTop: "4px" }}>＜氏　名＞　　　　　　　　　　印</div>
                        </td>
                      </tr>
                      <tr>
                        <td colSpan={2} style={{ border: "1px solid #555", padding: "4px 8px" }}>
                          <div style={{ fontWeight: "bold", marginBottom: "2px" }}>事　業　者</div>
                          <div>＜事業所名＞{companyInfo.companyName}</div>
                          <div>＜住　　所＞{companyInfo.companyAddress}</div>
                          <div style={{ marginTop: "2px" }}>＜管理者名＞　　　　　　　　　　㊞　　TEL：{companyInfo.tel}</div>
                        </td>
                      </tr>
                    </tbody></table>
                  </td>
                </tr>
              </tbody></table>

              {/* 第１条 */}
              <div className="article" style={{ marginBottom: "5px" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>第１条（契約の目的）</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{"　事業者は、利用者に対し、介護保険認定利用者に対して介護保険法令の趣旨に従って、利用者が可能な限りその居宅において、その有する能力に応じて自立した日常生活を営むことが出来るよう、（介護予防）福祉用具貸与を提供し、利用者は、事業者に対してそのサービスに対する料金を支払います。"}</p>
              </div>

              {/* 第２条 */}
              <div style={{ marginBottom: "5px" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>第２条（契約期間）</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>１　この契約の契約期間は、{contractDateJa}から利用者の要介護認定又は要支援認定の有効期限満了日（{certEndJa}）までとします。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>２　契約満了の１週間前までに、利用者から事業者に対して、文書又は口頭で契約終了の申し出がない場合、契約は自動更新されるものとします。</p>
              </div>

              {/* 第３条 */}
              <div style={{ marginBottom: "5px" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>第３条（専門相談員）</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>{"　事業者は、一定の研修を修了した専門相談員を配置し、専門相談員は、利用者の心身の状況、要望及びその置かれている環境を踏まえて、居宅介護支援事業者の作成する「居宅サービス計画」に沿って、福祉用具が適切に選定され、かつ使用されるよう、専門的知識に基づき、利用者からの相談に応じます。"}</p>
              </div>

              {/* 第４条 */}
              <div style={{ marginBottom: "5px" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>第４条（（介護予防）福祉用具貸与の内容）</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>１　福祉用具が適切に選定され、かつ使用されるよう、専門的知識に基づき、利用者からの相談に応じるとともに、取り扱い説明書等の文書を示して福祉用具の機能、使用方法、利用料金等に関する情報を提供し、個別の福祉用具の貸与に係る同意を得ます。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>２　貸与する福祉用具の機能、安全性、衛生状態などを考慮し、十分な点検を行います。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>３　利用者の心身の状況等に応じて福祉用具の調整を行うとともに、当該福祉用具の使用方法、使用上の留意事項、故障時の対応等を記載した文書を利用者に交付し、十分な説明を行った上で、必要に応じて利用者に実際に当該福祉用具を使用してもらいながら使用方法の指導を行います。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>４　貸与した福祉用具の使用状況の定期的な確認を行い、必要な場合は、使用方法の指導又は修理等を行います。</p>
              </div>

              {/* 第５条 */}
              <div style={{ marginBottom: "5px" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>第５条（福祉用具貸与計画の作成）</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>１　福祉用具専門相談員は、利用者の心身の状況、要望及びその置かれている環境を踏まえ、（介護予防）福祉用具利用計画・目標、当該目標を達成する為の具体的なサービスの内容を記載した福祉用具サービス計画を作成致します。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>２　福祉用具サービス計画は、既に居宅サービス計画が作成されている場合はその計画内容に沿って作成致します。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>３　福祉用具専門相談員は、福祉用具サービス計画の作成にあたり、その内容について利用者又はその家族に対して説明し、利用者様の同意を得てから計画をすすめてまいります。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>４　福祉用具専門相談員は、福祉用具サービス計画を作成した際には、当該福祉用具サービス計画を利用者様に交付致します。</p>
              </div>

              {/* 第６条 */}
              <div style={{ marginBottom: "5px" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>第６条（サービス提供の記録）</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>１　事業者は、サービス提供記録を作成することとし、この契約の終了後２年間保存します。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>２　利用者は、事業所の営業時間内にその事業所にて、当該利用者に関する第１項のサービス提供記録やサービスの実施マニュアル等、サービスの質を利用者が評価するための情報については、いつでも閲覧できます。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6" }}>３　利用者は、当該利用者に関する第１項のサービス実施記録等の複写物の交付を無料で受けることができます。</p>
              </div>

              {/* 第７条 料金 */}
              <div style={{ marginBottom: "5px" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 4px" }}>第７条（料金）</p>
                <p style={{ margin: "0 0 3px", paddingLeft: "1em", lineHeight: "1.6" }}>１　利用者は、サービスの対価として、下記の（介護予防）福祉用具貸与料金一覧表をもとに、月額料金の1割・2割・3割いずれかの合計額を利用者の負担として支払います。</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6" }}>２　搬出入にかかる費用は、現に福祉用具貸与に要した費用に含まれるものとし、別にいただきません。</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6" }}>３　事業者は当月の利用内容明細を請求書として、使用月の翌月末日までに利用者に交付します。</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6" }}>４　利用者は、事業者が発行した請求書に記載されている口座引き落とし日の前日までに、事前にご記入いただいた預金口座振替依頼書の指定金融機関の口座に、請求された金額をご入金ください。</p>
                <p style={{ margin: "0 0 4px", paddingLeft: "1em", lineHeight: "1.6" }}>５　事業者は、利用者から料金の支払いを受けたときは、利用者に対し領収書を発行します。介護保険適用の場合、利用者の負担額は原則として下記の（介護予防）福祉用具貸与料金一覧表の1割・2割・3割のいずれかです。ただし、介護保険適用外のサービス利用については、全額が利用者の負担となります。</p>
                <p style={{ fontWeight: "bold", margin: "0 0 2px", paddingLeft: "1em" }}>（介護予防）福祉用具貸与料金一覧表</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>（１）介護保険の適用がある場合は、料金表のサービス費の1割・2割・3割のいずれかが利用者負担額となります。</p>
                <p style={{ margin: "0 0 4px", paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>　　下記の「利用者負担額」は介護保険の負担割合が1割の方の場合の負担額となります。介護保険の負担割合が２割または３割の方はこれに２または３を乗じた金額が負担額となります。</p>
                {/* 料金表 */}
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "4px", fontSize: "8pt" }}>
                  <thead>
                    <tr>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center" }}>種目</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center" }}>福祉用具貸与商品</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "52px" }}>月額料金</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "32px" }}>数量</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "52px" }}>利用者負担</th>
                      <th style={{ border: "1px solid #555", background: "#eee", padding: "3px 5px", textAlign: "center", width: "60px" }}>初月利用者負担</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedItems.map((item) => {
                      const eq = getEq(item.product_code);
                      const price = item.rental_price ?? eq?.rental_price ?? 0;
                      const qty = item.quantity ?? 1;
                      const burden = Math.round(price * parseInt(benefitRate) / 10);
                      const halfBurden = Math.round(burden / 2);
                      return (
                        <tr key={item.id}>
                          <td style={{ border: "1px solid #555", padding: "3px 5px" }}>{eq?.category ?? ""}</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px" }}>{eq?.name ?? item.product_code}</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right" }}>{price ? `¥${price.toLocaleString()}` : ""}</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "center" }}>{qty}</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right" }}>{burden ? `¥${burden.toLocaleString()}` : ""}</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right" }}>{halfBurden ? `¥${halfBurden.toLocaleString()}` : ""}</td>
                        </tr>
                      );
                    })}
                    {/* 合計行 */}
                    {(() => {
                      const total = selectedItems.reduce((s, i) => s + (i.rental_price ?? getEq(i.product_code)?.rental_price ?? 0) * (i.quantity ?? 1), 0);
                      const totalBurden = Math.round(total * parseInt(benefitRate) / 10);
                      const totalHalf = Math.round(totalBurden / 2);
                      return (
                        <tr>
                          <td colSpan={2} style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>合　計</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>¥{total.toLocaleString()}</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px" }}></td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>¥{totalBurden.toLocaleString()}</td>
                          <td style={{ border: "1px solid #555", padding: "3px 5px", textAlign: "right", fontWeight: "bold" }}>¥{totalHalf.toLocaleString()}</td>
                        </tr>
                      );
                    })()}
                  </tbody>
                </table>
                <p style={{ margin: "0 0 2px", paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>（２）利用者負担金は契約開始月については使用月末締めの翌々月６日にご指定の金融機関の口座から引き落としをさせていただきます。（注）金融機関休業日の場合は翌営業日となります。</p>
                <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt" }}>（３）尚、契約起算日が月の１５日以前の場合においては月額の全額を、１６日以降の場合においては１/２の料金を請求させていただきます。解約の場合も同様に月の１５日以前の解約については月額の１/２を、１６日以降の解約については１ヵ月分の料金を請求させていただきます。</p>
              </div>

              {/* 第８〜２０条 */}
              {[
                { title: "第８条（（介護予防）福祉用具貸与の変更）", body: "１　利用者は、身体状況の急変等によって必要とする福祉用具に変更が生じた場合、事業者に対して当該福祉用具の変更を求めることができます。ただし、製品によっては料金の変更が生じる場合がありますのでご了承下さい。\n２　貸与された福祉用具について、万一不良品などで使い勝手が悪く、他に変更したい場合は、すぐにお申し出くだされば、無料で変更します。\n３　前記第２項については、同一製品に限り有効で、他製品への変更は、遠慮させていただきます。" },
                { title: "第９条（料金の変更）", body: "１　事業者は、利用者に対して１ヵ月前までに文書で通知することにより、料金の変更（増額又は減額）を申し出ることができます。\n２　利用者が料金の変更を承諾する場合、新たな料金表に基づく【契約書別紙】を作成し、お互いに取り交わします。\n３　利用者は料金の変更を承諾しない場合、事業者に対し、文書で通知することにより、この契約を解除することができます。" },
                { title: "第１０条（契約の終了）", body: "１　利用者は事業者に対して、１週間の予告期間を置いて文書又は口頭で通知することにより､この契約を解約することができます｡但し､利用者の病変、急な入院などやむをえない事情がある場合は､１週間以内の通知でもこの契約を解約することができます｡\n２　事業者は､やむをえない事情がある場合､利用者に対して､１ヵ月間の予告期間をおいて理由を示した文書で通知することにより､この契約を解約することができます｡\n３　次の事由に該当した場合は､利用者は文書で通知することにより､直ちにこの契約を解約することができます｡\n　①　事業者が正当な理由なくサービスを提供しない場合\n　②　事業者が守秘義務に反した場合\n　③　事業者が利用者やその家族などに対して社会理念を逸脱する行為を行った場合\n　④　事業者が破産した場合\n４　次の事由に該当した場合は､事業者は文書で通知することにより､直ちにこの契約を解約することができます｡\n　①　利用者のサービス料金の支払いが１ヵ月以上遅延し､料金を支払うよう催促したにもかかわらず､３０日以内に支払われない場合\n　②　利用者又はその家族などが､事業者やサービス提供者に対して本契約を継続しがたいほどの背信行為を行った場合\n５　次の事由に該当した場合は､この契約は自動的に終了します｡\n　①　利用者が介護保健施設に入所した場合\n　②　利用者の要介護（要支援）認定区分が、非該当（自立）と認定されたとき（この場合、内容を変更して再度契約することができます）\n　③　医療機関への入院\n　④　利用者が亡くなられたとき" },
                { title: "第１１条（守秘義務）", body: "１　事業者及び事業者の使用する者は､（介護予防）福祉用具貸与を提供する上で知り得た利用者及びその家族に関する秘密を正当な理由なく第三者に漏らしません｡この守秘義務は契約終了後についても同様です｡\n２　事業者は､利用者からあらかじめ文書で同意を得ない限り、サービス担当者会議等において､利用者の個人情報を用いません｡\n３　事業者は､利用者の家族からあらかじめ文書で同意を得ない限り、サービス担当者会議等において、当該家族の個人情報を用いません｡" },
                { title: "第１２条（利用者及びその家族等の義務）", body: "１　利用者及びその家族等は、レンタル商品について定められた使用方法及び使用上の注意事項を遵守する事とします。\n２　利用者等は、事業者の承諾を得ることなくレンタル商品の仕様変更、加工・改造等を行うことはできません。\n３　利用者等は、事業者の承諾を得ることなく本契約に基づく権利の全部もしくは一部を第三者に譲渡し又は転貸することはできません。" },
                { title: "第１３条（福祉用具の保管･消毒）", body: "　福祉用具の保管･消毒については、指定居宅サービス等の事業の人員、設置及び運営に関する基準第２０３条第３項の規定に基づき、株式会社インフォゲート、フランスベッド株式会社、野口株式会社、株式会社日本ケアサプライ、ケアレックス株式会社にこの業務を委託し、業務委託契約書を取り交わした上で事業所は委託の契約の内容において、保管及び消毒が適切な方法により行われていることを担保します。" },
                { title: "第１４条（賠償責任）", body: "　事業者は､福祉用具貸与サービスの提供に伴い、賠償責任を負う場合に備えて損害保険に加入し、納品時に家具に損傷を与えるなど、事業者の責めに帰すべき事由により利用者の生命・身体・財産に損害を及ぼした場合は､利用者に対してその損害を賠償します｡ただし、事業者は自己の責に帰すべからざる事由によって生じた損害については賠償責任を負いません。とりわけ、以下の事由に該当する場合には、損害賠償責任を免れます。\n①　利用者が、その疾患・心身状態及び福祉用具の設置・使用環境等、レンタル商品の選定に必要な事項について故意にこれを告げず、又は不実の告知を行ったことに起因して損害が発生した場合。\n②　利用者の急激な体調の変化等、事業者の実施した（介護予防）福祉用具貸与サービスを原因としない事由に起因して損害が発生した場合。\n③　利用者又はその家族が、事業者及びサービス従事者の指示・説明に反して行った行為に起因して損害が発生した場合。" },
                { title: "第１５条（災害等発生時のサービス提供）", body: "１　災害発生時や感染症流行時などの非常時においては、事業者は従業員の安全を確保した上でサービスを提供するため、事前に合意した日時・内容通りのサービスが提供できない可能性があります。\n２　利用者が避難所に避難された場合には、サービス提供の場所が変わることになりますので、道路状況・人員体制・避難所の環境等を考慮した上で、サービスの提供が可能と事業者が判断した場合にのみサービスを提供するものとします。" },
                { title: "第１６条（利用者の損害賠償責任）", body: "　事業者は、利用者の故意又は重大な過失によってレンタル商品が消失し、又は回収したレンタル商品について通常の使用状態を超える著しい破損・汚損等が認められる場合には、利用者等に対して補修費もしくは弁償費相当額の支払を請求することができます。" },
                { title: "第１７条（身分証携帯義務）", body: "　サービス従業者は、常に身分証を携帯し、初回納品時及び利用者やその家族から提示を求められたときは、いつでも身分証を提示します。" },
                { title: "第１８条（連携）", body: "１　事業者は、福祉用具貸与の提供にあたり、介護支援専門員及び保健医療サービス又は福祉サービスを提供する者との密接な関係に努めます。\n２　事業者は、本契約の内容が変更された場合又は本契約が終了した場合は、その内容を記した書面の写しを速やかに介護支援専門員に送付します。なお、第１０条２項及び４項に基づいて解約通知をする際は、事前に介護支援専門員に連絡します。" },
                { title: "第１９条（苦情処理）", body: "１　事業者は、利用者からの相談･苦情に対する窓口を設置し、当該福祉用具の故障・修理依頼など、（介護予防）福祉用具貸与に関する利用者の要望、苦情等に対し、迅速に対応します。\n２　苦情の内容によっては、再発防止のために関係メーカー及び提携先との連携･調整を行います。また、必要に応じて「苦情処理改善会議」を開催します。\n３　事業者は、利用者が苦情等を申し立てた場合であっても、これを理由にしていかなる不利益な扱いをしません。" },
                { title: "第２０条（信義誠実の原則）", body: "１　利用者及び事業者は、信義に従い誠実に本契約を履行するものとする。\n２　本契約に定める事項に疑義が生じた場合及び本契約に定めのない事項については、介護保険法令その他諸法令の定めるところを尊重し、双方の協議の上定めるものとします。" },
              ].map(({ title, body }) => (
                <div key={title} style={{ marginBottom: "5px" }}>
                  <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>{title}</p>
                  <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{body}</p>
                </div>
              ))}

              {/* 締結文・署名欄 */}
              <p style={{ margin: "10px 0 8px", lineHeight: "1.6", fontSize: "8pt" }}>
                本契約書の契約内容を証するため、本書２通を作成し、利用者、事業者が署名押印の上、各自１通保有するものとします。同様に、介護保険制度にて義務づけられているサービス担当者会議の開催が必要と認められる場合において、利用者様の個人情報を用いることについての説明を受け、同意するものといたします。
              </p>

              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "8pt" }}>
                <tbody>
                  <tr>
                    <td style={{ border: "1px solid #555", padding: "6px 8px", width: "50%", verticalAlign: "top", height: "60px" }}>
                      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>利用者</div>
                      <div>＜住　所＞{client.address ?? ""}</div>
                      <div style={{ marginTop: "8px" }}>＜氏　名＞{client.name}　　　　　　印</div>
                    </td>
                    <td style={{ border: "1px solid #555", padding: "6px 8px", width: "50%", verticalAlign: "top" }}>
                      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>代理人（続柄：　　　）</div>
                      <div style={{ marginTop: "8px" }}>＜氏　名＞　　　　　　　　　　　　印</div>
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={2} style={{ border: "1px solid #555", padding: "6px 8px", verticalAlign: "top" }}>
                      <div style={{ fontWeight: "bold", marginBottom: "4px" }}>事　業　者</div>
                      <div>＜事業所名＞{companyInfo.companyName}</div>
                      <div>＜住　　所＞{companyInfo.companyAddress}　TEL：{companyInfo.tel}</div>
                      <div style={{ marginTop: "8px" }}>＜管理者名＞　　　　　　　　　　　　㊞</div>
                      <div style={{ marginTop: "4px" }}>＜担　　当＞{companyInfo.staffName}　　　　印</div>
                      <div style={{ marginTop: "4px" }}>説　明　者：　　　　　　　　　　　　印</div>
                    </td>
                  </tr>
                </tbody>
              </table>

              {/* 個人情報 */}
              <div style={{ marginTop: "10px", border: "1px solid #555", padding: "6px 8px", fontSize: "7.5pt" }}>
                <p style={{ fontWeight: "bold", margin: "0 0 3px" }}>【個人情報の取り扱いについて】</p>
                <p style={{ margin: 0, lineHeight: "1.6" }}>当事業所はご利用者様の身体的状況やご家族の状況をケアプラン上必要な情報に限り、ご利用者様担当ケアマネージャーに報告致します。当事業所内においてのお客様に関するサービス内容の検討や、向上の為のケース会議、ケアマネージャー様等関係従事者様とのサービス担当者会議以外に個人情報を用いない事を厳守いたします。</p>
              </div>

            </div>
          </div>
        )}
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
  orderPaymentMap = {},
  equipment,
  companyInfo,
  priceHistory,
  tenantId,
  initialParams,
  onClose,
  onSaved,
}: {
  client: Client;
  items: OrderItem[];
  orderPaymentMap?: Record<string, "介護" | "自費">;
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  priceHistory: EquipmentPriceHistory[];
  tenantId: string;
  initialParams?: { targetMonth: string; visitDate: string; memo: string; selectedUsage: string[] };
  onClose: () => void;
  onSaved?: () => void;
}) {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");

  const [targetMonth, setTargetMonth] = useState(
    initialParams?.targetMonth ?? `${today.getFullYear()}-${pad(today.getMonth() + 1)}`
  );
  const [visitDate, setVisitDate] = useState(
    initialParams?.visitDate ?? `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  );
  const [selectedUsage, setSelectedUsage] = useState<Set<UsageType>>(
    new Set<UsageType>((initialParams?.selectedUsage ?? []) as UsageType[])
  );
  const [memo, setMemo] = useState(initialParams?.memo ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checkedReqs, setCheckedReqs] = useState<Set<number>>(new Set());

  const m1Year  = parseInt(targetMonth.split("-")[0]);
  const m1Month = parseInt(targetMonth.split("-")[1]);
  const m2next  = new Date(m1Year, m1Month, 1);
  const m2Year  = m2next.getFullYear();
  const m2Month = m2next.getMonth() + 1;
  const m2YM    = `${m2Year}-${String(m2Month).padStart(2, "0")}`;

  const getEq = (code: string) => equipment.find((e) => e.product_code === code);
  const histPrice = (code: string, ym: string) =>
    getPriceForMonth(priceHistory, code, ym) ?? undefined;

  const handleSaveDoc = async () => {
    setSaving(true);
    try {
      const [y, m] = targetMonth.split("-").map(Number);
      const m2n = new Date(y, m, 1);
      const titleM2 = `${m2n.getFullYear()}年${m2n.getMonth() + 1}月`;
      const title = `貸与報告書 ${y}年${m}月・${titleM2}分`;
      await saveClientDocument({
        tenant_id: tenantId,
        client_id: client.id,
        type: "rental_report",
        title,
        params: { targetMonth, visitDate, memo, selectedUsage: Array.from(selectedUsage) },
      });
      setSaved(true);
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

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

  const resolvePayType = (i: OrderItem) => i.payment_type ?? orderPaymentMap[i.order_id] ?? "介護";
  const careItems    = reportItems.filter((i) => resolvePayType(i) !== "自費");
  const selfPayItems = reportItems.filter((i) => resolvePayType(i) === "自費");

  const m1Total = careItems.reduce((s, i) => s + (calcMonthUnits(i, m1Year, m1Month, histPrice(i.product_code, targetMonth)) ?? 0), 0);
  const m2Total = careItems.reduce((s, i) => s + (calcMonthUnits(i, m2Year, m2Month, histPrice(i.product_code, m2YM)) ?? 0), 0);

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
        <button onClick={handleSaveDoc} disabled={saving || saved}
          className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium border transition-colors ${saved ? "bg-gray-100 text-gray-400 border-gray-200" : "bg-white text-emerald-600 border-emerald-300 hover:bg-emerald-50"}`}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? "✓ 保存済" : "履歴に保存"}
        </button>
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
                const price = getPriceForMonth(priceHistory, item.product_code, targetMonth) ?? item.rental_price ?? 0;
                const u1 = calcMonthUnits(item, m1Year, m1Month, histPrice(item.product_code, targetMonth));
                const u2 = calcMonthUnits(item, m2Year, m2Month, histPrice(item.product_code, m2YM));
                return (
                  <tr key={item.id}>
                    <td style={RPT_TD}>{eq?.category ?? ""}</td>
                    <td style={RPT_TD}>{eq?.tais_code ?? ""}</td>
                    <td style={{ ...RPT_TD, color: "#0000cc" }}>{eq?.name ?? item.product_code}</td>
                    <td style={{ ...RPT_TD, textAlign: "center" }}>1</td>
                    <td style={{ ...RPT_TD, textAlign: "right" }}>¥{price.toLocaleString()}</td>
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
                const selfPrice = getPriceForMonth(priceHistory, item.product_code, targetMonth) ?? item.rental_price ?? 0;
                return (
                  <tr key={item.id}>
                    <td style={RPT_TD}>{eq?.category ?? ""}</td>
                    <td style={{ ...RPT_TD, color: "#0000cc" }}>{eq?.name ?? item.product_code}</td>
                    <td style={RPT_TD} />
                    <td style={{ ...RPT_TD, fontSize: "8pt", textAlign: "center" }}>
                      {item.rental_start_date && <div>{fmtDate(item.rental_start_date)} 契約</div>}
                      {item.rental_end_date   && <div>{fmtDate(item.rental_end_date)} 解約</div>}
                    </td>
                    <td style={{ ...RPT_TD, textAlign: "right" }}>¥{selfPrice.toLocaleString()}</td>
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

// ─── MonitoringTab ────────────────────────────────────────────────────────────

function MonitoringTab({ tenantId }: { tenantId: string }) {
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [clients, setClients] = useState<Client[]>([]);
  const [clientOrders, setClientOrders] = useState<{ id: string; client_id: string }[]>([]);
  const [activeItems, setActiveItems] = useState<OrderItem[]>([]);
  const [monitoringRecords, setMonitoringRecords] = useState<MonitoringRecord[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [formClient, setFormClient] = useState<Client | null>(null);

  useEffect(() => { loadData(); }, [tenantId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [clientsRes, ordersRes, monRes, eqRes, tenantData] = await Promise.all([
        supabase.from("clients").select("*").eq("tenant_id", tenantId),
        supabase.from("orders").select("id, client_id").eq("tenant_id", tenantId),
        supabase.from("monitoring_records").select("*").eq("tenant_id", tenantId).order("target_month", { ascending: false }),
        supabase.from("equipment").select("*").eq("tenant_id", tenantId),
        getTenantById(tenantId),
      ]);
      const cls = (clientsRes.data ?? []) as Client[];
      const ords = (ordersRes.data ?? []) as { id: string; client_id: string }[];
      setClients(cls);
      setClientOrders(ords);
      setMonitoringRecords((monRes.data ?? []) as MonitoringRecord[]);
      setEquipment((eqRes.data ?? []) as Equipment[]);
      if (tenantData) {
        setCompanyInfo({
          businessNumber:      tenantData.business_number       ?? COMPANY_INFO_DEFAULTS.businessNumber,
          companyName:         tenantData.company_name          ?? COMPANY_INFO_DEFAULTS.companyName,
          companyAddress:      tenantData.company_address       ?? COMPANY_INFO_DEFAULTS.companyAddress,
          tel:                 tenantData.company_tel           ?? COMPANY_INFO_DEFAULTS.tel,
          fax:                 tenantData.company_fax           ?? COMPANY_INFO_DEFAULTS.fax,
          staffName:           tenantData.staff_name            ?? COMPANY_INFO_DEFAULTS.staffName,
          serviceArea:         tenantData.service_area          ?? COMPANY_INFO_DEFAULTS.serviceArea,
          businessDays:        tenantData.business_days         ?? COMPANY_INFO_DEFAULTS.businessDays,
          businessHours:       tenantData.business_hours        ?? COMPANY_INFO_DEFAULTS.businessHours,
          staffManagerFull:    tenantData.staff_manager_full    ?? COMPANY_INFO_DEFAULTS.staffManagerFull,
          staffManagerPart:    tenantData.staff_manager_part    ?? COMPANY_INFO_DEFAULTS.staffManagerPart,
          staffSpecialistFull: tenantData.staff_specialist_full ?? COMPANY_INFO_DEFAULTS.staffSpecialistFull,
          staffSpecialistPart: tenantData.staff_specialist_part ?? COMPANY_INFO_DEFAULTS.staffSpecialistPart,
          staffAdminFull:      tenantData.staff_admin_full      ?? COMPANY_INFO_DEFAULTS.staffAdminFull,
          staffAdminPart:      tenantData.staff_admin_part      ?? COMPANY_INFO_DEFAULTS.staffAdminPart,
        });
      }
      const orderIds = ords.map(o => o.id);
      if (orderIds.length > 0) {
        const items: OrderItem[] = [];
        for (let i = 0; i < orderIds.length; i += 500) {
          const { data } = await supabase
            .from("order_items")
            .select("*")
            .in("order_id", orderIds.slice(i, i + 500))
            .eq("status", "rental_started");
          if (data) items.push(...(data as OrderItem[]));
        }
        setActiveItems(items);
      }
    } finally {
      setLoading(false);
    }
  };

  const clientItemsMap = useMemo(() => {
    const orderToClient = new Map(clientOrders.map(o => [o.id, o.client_id]));
    const map = new Map<string, OrderItem[]>();
    for (const item of activeItems) {
      const clientId = orderToClient.get(item.order_id);
      if (!clientId) continue;
      if (!map.has(clientId)) map.set(clientId, []);
      map.get(clientId)!.push(item);
    }
    return map;
  }, [clientOrders, activeItems]);

  const schedule = useMemo(() => {
    return clients
      .filter(c => (clientItemsMap.get(c.id) ?? []).length > 0)
      .map(client => {
        const items = clientItemsMap.get(client.id)!;
        const earliestStart = items
          .map(i => i.rental_start_date)
          .filter((d): d is string => !!d)
          .sort()[0] ?? null;
        const clientRecords = monitoringRecords.filter(r => r.client_id === client.id);
        const lastRecord = clientRecords[0] ?? null;
        const base = lastRecord?.target_month ?? earliestStart?.slice(0, 7) ?? null;
        const nextDue = base ? calcNextDueMonth(base) : null;
        const doneThisMonth = clientRecords.find(r => r.target_month === selectedMonth) ?? null;
        return { client, items, nextDue, lastRecord, doneThisMonth };
      });
  }, [clients, clientItemsMap, monitoringRecords, selectedMonth]);

  const dueThisMonth = schedule.filter(s => s.nextDue === selectedMonth && !s.doneThisMonth);
  const completedThisMonth = schedule.filter(s => s.doneThisMonth);
  const overdue = schedule.filter(s => s.nextDue && s.nextDue < selectedMonth && !s.doneThisMonth);

  const changeMonth = (delta: number) => {
    const [y, m] = selectedMonth.split("-").map(Number);
    const total = y * 12 + m - 1 + delta;
    setSelectedMonth(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`);
  };

  if (formClient) {
    const clientItems = clientItemsMap.get(formClient.id) ?? [];
    const clientRecords = monitoringRecords.filter(r => r.client_id === formClient.id);
    const lastRecord = clientRecords[0] ?? null;
    return (
      <MonitoringFormModal
        client={formClient}
        clientItems={clientItems}
        equipment={equipment}
        companyInfo={companyInfo}
        tenantId={tenantId}
        lastRecord={lastRecord}
        targetMonth={selectedMonth}
        onClose={() => setFormClient(null)}
        onSaved={() => { setFormClient(null); loadData(); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-gray-800">モニタリング管理</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => changeMonth(-1)} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <ChevronLeft size={16} className="text-gray-500" />
            </button>
            <span className="text-sm font-medium text-gray-700 w-20 text-center">
              {selectedMonth.replace("-", "年")}月
            </span>
            <button onClick={() => changeMonth(1)} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <ChevronRight size={16} className="text-gray-500" />
            </button>
          </div>
        </div>
        <div className="flex gap-3 mt-2 text-xs">
          <span className="text-amber-600 font-medium">未実施 {dueThisMonth.length}名</span>
          <span className="text-emerald-600 font-medium">完了 {completedThisMonth.length}名</span>
          {overdue.length > 0 && <span className="text-red-500 font-medium">期限超過 {overdue.length}名</span>}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 期限超過 */}
          {overdue.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-red-500 mb-2">期限超過</h3>
              <div className="space-y-1">
                {overdue.map(({ client, nextDue }) => (
                  <div key={client.id} className="bg-red-50 border border-red-100 rounded-xl px-3 py-2.5 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-gray-800">{client.name}</span>
                      <span className="ml-2 text-xs text-gray-500">{client.care_level}</span>
                      <span className="ml-2 text-xs text-red-500">予定: {nextDue?.replace("-", "年")}月</span>
                    </div>
                    <button
                      onClick={() => setFormClient(client)}
                      className="text-xs text-white bg-red-500 px-3 py-1 rounded-lg hover:bg-red-600"
                    >
                      記録入力
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 今月対象（未実施） */}
          {dueThisMonth.length > 0 ? (
            <section>
              <h3 className="text-xs font-semibold text-amber-600 mb-2">今月対象（未実施）</h3>
              <div className="space-y-1">
                {dueThisMonth.map(({ client }) => (
                  <div key={client.id} className="bg-amber-50 border border-amber-100 rounded-xl px-3 py-2.5 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-gray-800">{client.name}</span>
                      <span className="ml-2 text-xs text-gray-500">{client.care_level}</span>
                      {client.gender && <span className="ml-1 text-xs text-gray-400">{client.gender}</span>}
                    </div>
                    <button
                      onClick={() => setFormClient(client)}
                      className="text-xs text-white bg-emerald-500 px-3 py-1 rounded-lg hover:bg-emerald-600"
                    >
                      記録入力
                    </button>
                  </div>
                ))}
              </div>
            </section>
          ) : (
            <p className="text-sm text-gray-400 text-center py-4">今月の対象者はいません</p>
          )}

          {/* 今月完了済み */}
          {completedThisMonth.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-emerald-600 mb-2">完了済み</h3>
              <div className="space-y-1">
                {completedThisMonth.map(({ client, doneThisMonth: rec }) => (
                  <div key={client.id} className="bg-emerald-50 border border-emerald-100 rounded-xl px-3 py-2.5 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-medium text-gray-800">{client.name}</span>
                      <span className="ml-2 text-xs text-gray-500">{client.care_level}</span>
                      {rec?.visit_date && <span className="ml-2 text-xs text-gray-400">訪問: {rec.visit_date}</span>}
                    </div>
                    <CheckCircle2 size={18} className="text-emerald-500" />
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MonitoringFormModal ──────────────────────────────────────────────────────

type MonitoringItemCheck = {
  order_item_id: string;
  product_code: string;
  equipment_name: string;
  category: string;
  quantity: number;
  no_issue: boolean;
  has_malfunction: boolean;
  has_deterioration: boolean;
  needs_replacement: boolean;
};

function MonitoringFormModal({
  client, clientItems, equipment, companyInfo, tenantId, lastRecord, targetMonth, onClose, onSaved,
}: {
  client: Client;
  clientItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  lastRecord: MonitoringRecord | null;
  targetMonth: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [visitDate, setVisitDate] = useState(todayStr);
  const [reportDate, setReportDate] = useState(todayStr);
  const [staffName, setStaffName] = useState(companyInfo.staffName ?? "");
  const [tm, setTm] = useState(targetMonth);
  const [continuityComment, setContinuityComment] = useState(
    "怪我無く、安全にお過ごし頂く為に、継続して福祉用具の利用が必要と思われます。"
  );
  const [reportComment, setReportComment] = useState("");
  const [previousComment, setPreviousComment] = useState(lastRecord?.report_comment ?? "");
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [insuranceRecord, setInsuranceRecord] = useState<ClientInsuranceRecord | null>(null);

  const [itemChecks, setItemChecks] = useState<MonitoringItemCheck[]>(() =>
    clientItems.map(item => {
      const eq = equipment.find(e => e.product_code === item.product_code);
      return {
        order_item_id: item.id,
        product_code: item.product_code,
        equipment_name: eq?.name ?? item.product_code,
        category: eq?.category ?? "",
        quantity: item.quantity ?? 1,
        no_issue: true,
        has_malfunction: false,
        has_deterioration: false,
        needs_replacement: false,
      };
    })
  );

  useEffect(() => {
    supabase.from("client_insurance_records")
      .select("*").eq("tenant_id", tenantId).eq("client_id", client.id)
      .order("effective_date", { ascending: false }).limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) setInsuranceRecord(data[0] as ClientInsuranceRecord);
      });
  }, [client.id, tenantId]);

  const updateCheck = (idx: number, field: keyof MonitoringItemCheck, value: boolean) => {
    setItemChecks(prev => prev.map((c, i) => i === idx ? { ...c, [field]: value } : c));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const { data: rec, error } = await supabase.from("monitoring_records").insert({
        tenant_id: tenantId,
        client_id: client.id,
        visit_date: visitDate || null,
        target_month: tm || null,
        report_date: reportDate || null,
        staff_name: staffName || null,
        continuity_comment: continuityComment || null,
        report_comment: reportComment || null,
        previous_comment: previousComment || null,
        status: "completed",
      }).select().single();
      if (error || !rec) { console.error(error); return; }
      for (const check of itemChecks) {
        await supabase.from("monitoring_items").insert({
          monitoring_id: rec.id,
          tenant_id: tenantId,
          order_item_id: check.order_item_id,
          product_code: check.product_code,
          equipment_name: check.equipment_name,
          category: check.category,
          quantity: check.quantity,
          no_issue: check.no_issue,
          has_malfunction: check.has_malfunction,
          has_deterioration: check.has_deterioration,
          needs_replacement: check.needs_replacement,
        });
      }
      setSavedId(rec.id);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const payload = {
        client: {
          name: client.name,
          care_level: client.care_level,
          care_manager_org: client.care_manager_org,
          certification_start_date: insuranceRecord?.certification_start_date ?? null,
          certification_end_date: insuranceRecord?.certification_end_date ?? client.certification_end_date ?? null,
        },
        visit_date: visitDate,
        target_month: tm,
        report_date: reportDate,
        staff_name: staffName,
        company: {
          name: companyInfo.companyName,
          tel: companyInfo.tel,
          fax: companyInfo.fax,
        },
        items: itemChecks.map(c => ({
          category: c.category,
          equipment_name: c.equipment_name,
          quantity: c.quantity,
          no_issue: c.no_issue,
          has_malfunction: c.has_malfunction,
          has_deterioration: c.has_deterioration,
          needs_replacement: c.needs_replacement,
        })),
        continuity_comment: continuityComment,
        report_comment: reportComment,
        previous_comment: previousComment,
      };
      const res = await fetch("/api/monitoring-excel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) { console.error("Excel生成エラー"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `モニタリング_${client.name}_${tm}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const CHECK_COLS: { key: keyof MonitoringItemCheck; label: string }[] = [
    { key: "no_issue", label: "問題なし" },
    { key: "has_malfunction", label: "不具合" },
    { key: "has_deterioration", label: "劣化" },
    { key: "needs_replacement", label: "交換" },
  ];

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 shrink-0">
        <button onClick={onClose}><ChevronLeft size={20} className="text-gray-500" /></button>
        <div className="flex-1">
          <h2 className="font-semibold text-gray-800">モニタリング記録</h2>
          <p className="text-xs text-gray-400">{client.name}　{client.care_level}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* 基本情報 */}
        <div className="bg-gray-50 rounded-xl p-3 space-y-2">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">基本情報</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 block mb-1">訪問日</label>
              <input type="date" value={visitDate} onChange={e => setVisitDate(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">対象月</label>
              <input type="month" value={tm} onChange={e => setTm(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">報告日</label>
              <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400" />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">担当者</label>
              <input value={staffName} onChange={e => setStaffName(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400" />
            </div>
          </div>
        </div>

        {/* 用具チェック */}
        <div className="bg-gray-50 rounded-xl p-3 space-y-2">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">用具チェック</p>
          {itemChecks.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">レンタル中の用具がありません</p>
          )}
          {itemChecks.map((check, idx) => (
            <div key={check.order_item_id} className="bg-white rounded-lg p-3 space-y-2">
              <div className="flex items-start gap-2">
                <span className="text-xs text-gray-400 w-16 shrink-0 pt-0.5">{check.category}</span>
                <span className="text-sm text-gray-800 font-medium leading-tight">{check.equipment_name}</span>
              </div>
              <div className="grid grid-cols-4 gap-1">
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={check.no_issue}
                    onChange={e => updateCheck(idx, "no_issue", e.target.checked)}
                    className="w-3.5 h-3.5 accent-emerald-500" />
                  <span className="text-xs text-gray-600">問題なし</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={check.has_malfunction}
                    onChange={e => updateCheck(idx, "has_malfunction", e.target.checked)}
                    className="w-3.5 h-3.5 accent-red-500" />
                  <span className="text-xs text-gray-600">不具合</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={check.has_deterioration}
                    onChange={e => updateCheck(idx, "has_deterioration", e.target.checked)}
                    className="w-3.5 h-3.5 accent-amber-500" />
                  <span className="text-xs text-gray-600">劣化</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={check.needs_replacement}
                    onChange={e => updateCheck(idx, "needs_replacement", e.target.checked)}
                    className="w-3.5 h-3.5 accent-blue-500" />
                  <span className="text-xs text-gray-600">交換</span>
                </label>
              </div>
            </div>
          ))}
        </div>

        {/* コメント */}
        <div className="bg-gray-50 rounded-xl p-3 space-y-3">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">コメント</p>
          <div>
            <label className="text-xs text-gray-500 block mb-1">継続・必要性</label>
            <textarea value={continuityComment} onChange={e => setContinuityComment(e.target.value)}
              rows={2}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 resize-none" />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">報告コメント</label>
            <textarea value={reportComment} onChange={e => setReportComment(e.target.value)}
              rows={4}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 resize-none"
              placeholder="モニタリング内容を入力..." />
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">前回コメント（引継ぎ）</label>
            <textarea value={previousComment} onChange={e => setPreviousComment(e.target.value)}
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 resize-none"
              placeholder="前回のコメントが自動入力されます" />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="bg-white border-t border-gray-100 px-4 py-3 flex gap-2 shrink-0">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 bg-emerald-500 text-white text-sm font-medium py-2.5 rounded-xl hover:bg-emerald-600 disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle2 size={16} />}
          保存
        </button>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-1.5 text-sm text-blue-600 border border-blue-200 px-4 py-2.5 rounded-xl hover:bg-blue-50 disabled:opacity-50"
        >
          {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          Excel
        </button>
      </div>
    </div>
  );
}
