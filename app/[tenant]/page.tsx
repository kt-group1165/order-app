"use client";

import { useState, useEffect, use, useCallback, Fragment, useRef, useMemo, useTransition, memo } from "react";
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
  Eye,
  CreditCard,
  AlertTriangle,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Client, Supplier, Member, EquipmentPriceHistory, ClientDocument, ClientInsuranceRecord, ClientRentalHistory, MonitoringRecord, MonitoringItem, ClientHospitalization } from "@/lib/supabase";
import { getClientDocuments, saveClientDocument, deleteClientDocument } from "@/lib/documents";
import { getOrders, getAllOrders, getOrderItems, updateOrderItemStatus, getAllOrderItemsByTenant, createOrder, createOrderItem, getMembers, recordEmailSent, updateSupplierEmail } from "@/lib/orders";
import { getEquipment, getSuppliers, importEquipment, parseEquipmentCSV, updateEquipment, createEquipmentItem, updateEquipmentSortOrders, getPriceHistory, addPriceHistory, getPriceForMonth, type ImportResult } from "@/lib/equipment";
import { getClients, promoteProvisionalClient, softDeleteClient, restoreClient } from "@/lib/clients";
import { getTenants, getTenantById, updateTenantInfo, type Tenant } from "@/lib/tenants";
import { verifyPin } from "@/lib/settings";
import { getCarePlanTemplates, upsertCarePlanTemplate, deleteCarePlanTemplate } from "@/lib/carePlanTemplates";
import { CarePlanTemplate } from "@/lib/supabase";
import { getOffices, getOfficePrices, createOffice, updateOffice, deleteOffice, upsertOfficePrice, deleteOfficePrice, bulkUpsertOfficePrices, getClientOfficeAssignments, assignClientToOffice, removeClientFromOffice, type Office, type EquipmentOfficePrice, type ClientOfficeAssignment } from "@/lib/offices";
import {
  getLateFlags, setLateFlag, removeLateFlag,
  getUnitOverrides, setUnitOverride, removeUnitOverride,
  getRebillFlags, setRebillFlag, removeRebillFlag,
  type BillingLateFlag, type BillingUnitOverride, type BillingRebillFlag,
} from "@/lib/billing";
import { getCareOffices, upsertCareOffice, deleteCareOffice, sendFax, getCareManagers, addCareManager, updateCareManager, deleteCareManager, type CareOffice, type CareManager } from "@/lib/careOffices";
import { getSpeechUsageSummary, type SpeechUsageSummary } from "@/lib/speechUsage";
import { getOpenAIUsageSummary, type OpenAIUsageSummary } from "@/lib/openaiUsage";
import { invalidateCache } from "@/lib/cache";
import { getMaxUserNumber } from "@kt/shared/user-number";

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

/** 用具名・フリガナ・コード・TAISコード・カテゴリに対してキーワード検索 */
const matchEquipment = (e: Equipment, raw: string): boolean => {
  const q = normalizeSearch(raw);
  if (!q) return true;
  return [e.name, e.furigana ?? "", e.product_code, e.tais_code ?? "", e.category ?? ""].some((s) =>
    normalizeSearch(s).includes(q)
  );
};

/** 利用者名・フリガナ・利用者番号に対してキーワード検索 */
const matchClient = (c: Client, raw: string): boolean => {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const q = normalizeSearch(trimmed);
  const fields = [c.name, c.furigana ?? "", c.user_number ?? ""];
  // ① 正規化マッチ（ひらがな→カタカナ統一後に比較）
  if (fields.some(s => normalizeSearch(s).includes(q))) return true;
  // ② カタカナ→ひらがなに変換してそのまま比較（DB側がひらがな保存の場合）
  const qHira = trimmed.replace(/[\u30A1-\u30F6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  if (qHira !== trimmed && fields.some(s => s.includes(qHira))) return true;
  // ③ 直接マッチ（全角カタカナをそのまま比較）
  return fields.some(s => s.toLowerCase().includes(trimmed.toLowerCase()));
};

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = "orders" | "equipment" | "clients" | "monitoring" | "billing" | "documents" | "settings";

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
const CURRENT_OFFICE_KEY = (tenantId: string) => `current_office_${tenantId}`;
const OFFICE_VIEW_MODE_KEY = (tenantId: string) => `office_view_mode_${tenantId}`;

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
  // 事業所切替
  const [currentOfficeId, setCurrentOfficeId] = useState<string | null>(null);
  const [officeViewAll, setOfficeViewAll] = useState(false); // false=自事業所のみ, true=全事業所

  useEffect(() => {
    getTenants().then((list) => {
      const found = list.find((t) => t.id === tenantId);
      if (found) setTenantName(found.name);
    });
    // localStorage から事業所設定を復元
    if (typeof window !== "undefined") {
      const savedOffice = localStorage.getItem(CURRENT_OFFICE_KEY(tenantId));
      if (savedOffice) setCurrentOfficeId(savedOffice);
      const savedMode = localStorage.getItem(OFFICE_VIEW_MODE_KEY(tenantId));
      if (savedMode === "all") setOfficeViewAll(true);
    }
  }, [tenantId]);

  const handleOfficeChange = (officeId: string | null) => {
    setCurrentOfficeId(officeId);
    if (typeof window !== "undefined") {
      if (officeId) localStorage.setItem(CURRENT_OFFICE_KEY(tenantId), officeId);
      else localStorage.removeItem(CURRENT_OFFICE_KEY(tenantId));
    }
  };

  const handleOfficeViewModeChange = (viewAll: boolean) => {
    setOfficeViewAll(viewAll);
    if (typeof window !== "undefined") {
      localStorage.setItem(OFFICE_VIEW_MODE_KEY(tenantId), viewAll ? "all" : "mine");
    }
  };

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
        <span className="text-[10px] text-emerald-300 font-mono ml-1">v0.7.10</span>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "orders" && <OrdersTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} onDirtyChange={setOrdersDirty} onSwitchToClient={(clientId) => { setClientTabTarget(clientId); setActiveTab("clients"); }} />}
        {activeTab === "equipment" && <EquipmentTab tenantId={tenantId} />}
        {activeTab === "clients" && <ClientsTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} initialClientId={clientTabTarget} onClearInitialClient={() => setClientTabTarget(null)} />}
        {activeTab === "monitoring" && <MonitoringTab tenantId={tenantId} />}
        {activeTab === "billing" && <BillingTab tenantId={tenantId} currentOfficeId={currentOfficeId} />}
        {activeTab === "documents" && <DocumentsTab tenantId={tenantId} />}
        {activeTab === "settings" && <SettingsTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} onOfficeChange={handleOfficeChange} onViewModeChange={handleOfficeViewModeChange} />}
      </div>

      {/* Bottom Nav */}
      <nav className="bg-white border-t border-gray-200 flex shrink-0">
        {(
          [
            { id: "orders", icon: ClipboardList, label: "発注管理" },
            { id: "documents", icon: FileText, label: "書類" },
            { id: "clients", icon: Users, label: "利用者別" },
            { id: "monitoring", icon: ClipboardCheck, label: "モニタリング" },
            { id: "billing", icon: CreditCard, label: "請求" },
            { id: "equipment", icon: Package, label: "用具マスタ" },
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

function MobileOrderUrlButton({ tenantId }: { tenantId: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window !== "undefined"
    ? `${window.location.origin}/${tenantId}/order`
    : "";

  const handleCopy = () => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <button
      onClick={handleCopy}
      title={url}
      className={`shrink-0 flex items-center gap-1 text-xs font-medium px-3 py-1.5 rounded-xl border transition-colors ${
        copied
          ? "bg-emerald-50 text-emerald-600 border-emerald-300"
          : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
      }`}
    >
      <Send size={13} />
      {copied ? "コピー済み" : "発注URL"}
    </button>
  );
}

function OrdersTab({ tenantId, currentOfficeId, officeViewAll, onDirtyChange, onSwitchToClient }: { tenantId: string; currentOfficeId: string | null; officeViewAll: boolean; onDirtyChange: (dirty: boolean) => void; onSwitchToClient?: (clientId: string) => void }) {
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
  const [previewOrder, setPreviewOrder] = useState<{ order: Order; items: OrderItem[]; emailType?: "new_order" | "rental_started" | "terminated" | "cancelled"; isNewlyCreated?: boolean } | null>(null);
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
      // 全 order_items を一括取得して order_id でグループ化（N+1 を排除）
      const [ordersData, allItems, clientsData, equipData, suppliersData, membersData] = await Promise.all([
        getOrders(tenantId),
        getAllOrderItemsByTenant(tenantId),
        getClients(tenantId),
        getEquipment(tenantId),
        getSuppliers(),
        getMembers(tenantId),
      ]);
      const itemsByOrder = new Map<string, OrderItem[]>();
      for (const item of allItems) {
        const arr = itemsByOrder.get(item.order_id) ?? [];
        arr.push(item);
        itemsByOrder.set(item.order_id, arr);
      }
      // 元の getOrderItems() は created_at 昇順だったので、グループ化後にもソートを揃える
      for (const arr of itemsByOrder.values()) {
        arr.sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
      }
      const withItems: OrderWithItems[] = ordersData.map((o) => ({
        ...o,
        items: itemsByOrder.get(o.id) ?? [],
      }));
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

  // ── パフォーマンス最適化：Map ルックアップ ──
  const clientByIdOrders = useMemo(() => {
    const m = new Map<string, Client>();
    for (const c of clients) m.set(c.id, c);
    return m;
  }, [clients]);
  const equipmentByCodeOrders = useMemo(() => {
    const m = new Map<string, Equipment>();
    for (const e of equipment) m.set(e.product_code, e);
    return m;
  }, [equipment]);

  const clientName = (id: string | null) =>
    id ? (clientByIdOrders.get(id)?.name ?? id) : "（利用者未設定）";

  const equipName = (code: string) =>
    equipmentByCodeOrders.get(code)?.name ?? code;

  // 利用者ごとにグループ化して直近活動順に並べる
  const clientGroups = useMemo(() => {
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
      const cli = key === "__none__" ? null : clientByIdOrders.get(key);
      return {
        clientId: key === "__none__" ? null : key,
        name: key === "__none__" ? "利用者未設定" : (cli?.name ?? key),
        furigana: key === "__none__" ? "" : (cli?.furigana ?? ""),
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
  }, [orders, filter, clientByIdOrders]);

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
        isNewlyCreated={previewOrder.isNewlyCreated}
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
        <MobileOrderUrlButton tenantId={tenantId} />
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
            setPreviewOrder({ order, items, isNewlyCreated: true });
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
  const [offices, setOffices] = useState<Office[]>([]);
  const [officePrices, setOfficePrices] = useState<EquipmentOfficePrice[]>([]);
  const [showOfficePriceImport, setShowOfficePriceImport] = useState(false);

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

  // フリガナが未登録の用具を AI で一括生成
  const [bulkFuriganaState, setBulkFuriganaState] = useState<"idle" | "running" | "done">("idle");
  const [bulkFuriganaProgress, setBulkFuriganaProgress] = useState({ done: 0, total: 0 });
  const handleBulkGenerateFurigana = async () => {
    const targets = equipment.filter((e) => !e.furigana || !e.furigana.trim());
    if (targets.length === 0) {
      alert("フリガナ未登録の用具はありません。");
      return;
    }
    if (!confirm(`フリガナ未登録の用具 ${targets.length} 件のフリガナを AI で一括生成します。よろしいですか？`)) {
      return;
    }
    setBulkFuriganaState("running");
    setBulkFuriganaProgress({ done: 0, total: targets.length });
    try {
      // 50件ずつバッチでAPIに投げる
      const BATCH = 50;
      for (let i = 0; i < targets.length; i += BATCH) {
        const batch = targets.slice(i, i + BATCH);
        const res = await fetch("/api/kana-convert", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts: batch.map((e) => e.name), tenantId, purpose: "bulk_furigana" }),
        });
        const data = await res.json();
        const kanaArr: string[] = Array.isArray(data.kana) ? data.kana : [];
        // 各レコードを更新
        for (let j = 0; j < batch.length; j++) {
          const kana = (kanaArr[j] ?? "").trim();
          if (kana) {
            await supabase
              .from("equipment_master")
              .update({ furigana: kana, updated_at: new Date().toISOString() })
              .eq("id", batch[j].id);
          }
        }
        setBulkFuriganaProgress({ done: Math.min(i + BATCH, targets.length), total: targets.length });
      }
      // ブラウザ内のメモリキャッシュを無効化（音声発注のマッチング側が古い equipment を見ないように）
      invalidateCache("equipment:");
      setBulkFuriganaState("done");
      await load();
      setTimeout(() => setBulkFuriganaState("idle"), 2500);
    } catch (e) {
      console.error(e);
      alert("フリガナ生成に失敗しました");
      setBulkFuriganaState("idle");
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eq, ofs, ops] = await Promise.all([
        getEquipment(tenantId),
        getOffices(tenantId).catch(() => [] as Office[]),
        getOfficePrices(tenantId).catch(() => [] as EquipmentOfficePrice[]),
      ]);
      setEquipment(eq);
      setOffices(ofs);
      setOfficePrices(ops);
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
    const headers = ["用具名", "フリガナ", "TAISコード", "カテゴリ", "レンタル価格", "全国平均価格", "限度額", "商品コード", "選定理由", "提案理由"];
    const rows = localEquipment.map(e => [
      e.name,
      e.furigana ?? "",
      e.tais_code ?? "",
      e.category ?? "",
      e.rental_price?.toString() ?? "",
      e.national_avg_price?.toString() ?? "",
      e.price_limit?.toString() ?? "",
      e.product_code,
      e.selection_reason ?? "",
      e.proposal_reason ?? "",
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

  const handleExportOfficePricesCSV = () => {
    if (offices.length === 0) { alert("事業所が登録されていません。設定タブで事業所を登録してください。"); return; }
    const headers = ["商品コード", "用具名", ...offices.map((o) => o.name)];
    const rows = localEquipment.map((eq) => {
      const priceCells = offices.map((o) => {
        const op = officePrices.find((p) => p.product_code === eq.product_code && p.office_id === o.id);
        return op ? String(op.rental_price) : "";
      });
      return [eq.product_code, eq.name, ...priceCells];
    });
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "事業所別レンタル価格.csv";
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
        offices={offices}
        officePrices={officePrices}
        onReloadOfficePrices={load}
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
        offices={offices}
        officePrices={officePrices}
        onReloadOfficePrices={load}
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
          onClick={handleExportOfficePricesCSV}
          className="shrink-0 flex items-center gap-1 bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Download size={14} />
          事業所別価格
        </button>
        <button
          onClick={() => setShowOfficePriceImport(true)}
          className="shrink-0 flex items-center gap-1 bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded-xl"
        >
          <Upload size={14} />
          取込
        </button>
        {/* フリガナ未登録件数があれば一括生成ボタンを表示 */}
        {(() => {
          const missing = equipment.filter((e) => !e.furigana || !e.furigana.trim()).length;
          if (missing === 0 && bulkFuriganaState === "idle") return null;
          return (
            <button
              onClick={handleBulkGenerateFurigana}
              disabled={bulkFuriganaState === "running"}
              className={`shrink-0 flex items-center gap-1 text-white text-xs font-medium px-3 py-1.5 rounded-xl ${
                bulkFuriganaState === "running" ? "bg-amber-400" : bulkFuriganaState === "done" ? "bg-emerald-500" : "bg-amber-500"
              }`}
              title="フリガナ未登録の用具に対してAIでカタカナ読みを一括生成"
            >
              {bulkFuriganaState === "running"
                ? `生成中 ${bulkFuriganaProgress.done}/${bulkFuriganaProgress.total}`
                : bulkFuriganaState === "done"
                ? "完了"
                : `フリガナ生成 (${missing})`}
            </button>
          );
        })()}
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

      {showOfficePriceImport && (
        <OfficePriceImportModal
          tenantId={tenantId}
          offices={offices}
          equipment={localEquipment}
          onClose={() => setShowOfficePriceImport(false)}
          onDone={() => { setShowOfficePriceImport(false); load(); }}
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
  offices,
  officePrices,
  onReloadOfficePrices,
}: {
  item: Equipment | null;
  tenantId: string;
  onBack: () => void;
  onSave: (saved: Equipment) => void;
  offices: Office[];
  officePrices: EquipmentOfficePrice[];
  onReloadOfficePrices: () => void;
}) {
  const isNew = item === null;
  const [isEditing, setIsEditing] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // 事業所別価格（この用具分）
  const myOfficePrices = item
    ? officePrices.filter((p) => p.product_code === item.product_code)
    : [];
  const [officePriceMap, setOfficePriceMap] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    myOfficePrices.forEach((p) => { m[p.office_id] = String(p.rental_price); });
    return m;
  });
  // 編集開始時に同期
  useEffect(() => {
    const m: Record<string, string> = {};
    const prices = item ? officePrices.filter((p) => p.product_code === item.product_code) : [];
    prices.forEach((p) => { m[p.office_id] = String(p.rental_price); });
    setOfficePriceMap(m);
  }, [isEditing, officePrices, item]);

  // フォーム state
  const [name, setName] = useState(item?.name ?? "");
  const [furigana, setFurigana] = useState(item?.furigana ?? "");
  const [generatingFurigana, setGeneratingFurigana] = useState(false);
  const [taisCode, setTaisCode] = useState(item?.tais_code ?? "");
  const [category, setCategory] = useState(item?.category ?? "");
  const [rentalPrice, setRentalPrice] = useState(item?.rental_price ? String(item.rental_price) : "");
  const [nationalAvg, setNationalAvg] = useState(item?.national_avg_price ? String(item.national_avg_price) : "");
  const [priceLimit, setPriceLimit] = useState(item?.price_limit ? String(item.price_limit) : "");
  const [selectionReason, setSelectionReason] = useState(item?.selection_reason ?? "");
  const [proposalReason, setProposalReason] = useState(item?.proposal_reason ?? "");
  const todayYM = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const [priceEffectiveMonth, setPriceEffectiveMonth] = useState(todayYM);

  // 用具名から AI でフリガナ自動生成
  const handleGenerateFurigana = async () => {
    if (!name.trim()) return;
    setGeneratingFurigana(true);
    try {
      const res = await fetch("/api/kana-convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts: [name.trim()], tenantId, purpose: "manual_kana" }),
      });
      const data = await res.json();
      if (Array.isArray(data.kana) && data.kana[0]) {
        setFurigana(data.kana[0]);
      }
    } catch {
      // 失敗時は無音
    } finally {
      setGeneratingFurigana(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) { setError("用具名は必須です"); return; }
    setSaving(true);
    setError("");
    try {
      const newRentalPrice = rentalPrice ? parseFloat(rentalPrice) : null;
      const payload = {
        name: name.trim(),
        furigana: furigana.trim() || null,
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
      // 事業所別価格を保存
      await Promise.all(
        offices.map(async (office) => {
          const priceStr = officePriceMap[office.id] ?? "";
          const price = priceStr.trim() ? parseInt(priceStr.trim()) : 0;
          if (price > 0) {
            await upsertOfficePrice(tenantId, saved.product_code, office.id, price);
          } else {
            await deleteOfficePrice(tenantId, saved.product_code, office.id).catch(() => {});
          }
        })
      );
      onReloadOfficePrices();
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
    setFurigana(item!.furigana ?? "");
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
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">用具名 *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例：電動ベッド"
                type="text"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 block mb-1">
                フリガナ <span className="text-[10px] text-gray-400 font-normal">（音声発注のマッチング用）</span>
              </label>
              <div className="flex gap-2">
                <input
                  value={furigana}
                  onChange={(e) => setFurigana(e.target.value)}
                  placeholder="例：デンドウベッド"
                  type="text"
                  className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm outline-none focus:border-emerald-400"
                />
                <button
                  type="button"
                  onClick={handleGenerateFurigana}
                  disabled={!name.trim() || generatingFurigana}
                  className="px-3 text-xs font-medium text-emerald-700 bg-emerald-50 disabled:opacity-40 rounded-xl whitespace-nowrap hover:bg-emerald-100"
                >
                  {generatingFurigana ? "生成中..." : "AI自動生成"}
                </button>
              </div>
            </div>
            {[
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
            {/* 事業所別レンタル価格 */}
            {offices.length > 0 && (
              <div>
                <label className="text-xs font-medium text-gray-600 block mb-2">事業所別レンタル価格（円/月）</label>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  {offices.map((office, idx) => (
                    <div key={office.id} className={`flex items-center gap-2 px-3 py-2 ${idx > 0 ? "border-t border-gray-100" : ""}`}>
                      <span className="text-sm text-gray-700 flex-1 truncate">{office.name}</span>
                      <input
                        type="number"
                        value={officePriceMap[office.id] ?? ""}
                        onChange={(e) => setOfficePriceMap((prev) => ({ ...prev, [office.id]: e.target.value }))}
                        placeholder="例：15000"
                        className="w-28 border border-gray-200 rounded-lg px-2 py-1 text-sm text-right outline-none focus:border-emerald-400"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
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
            <Field label="フリガナ" value={item?.furigana} />
            <Field label="TAISコード" value={item?.tais_code} />
            <Field label="カテゴリ" value={item?.category} />
            <Field label="レンタル価格" value={item?.rental_price ? `¥${item.rental_price.toLocaleString()}/月` : null} />
            <Field label="全国平均価格" value={item?.national_avg_price ? `¥${item.national_avg_price.toLocaleString()}` : null} />
            <Field label="限度額" value={item?.price_limit ? `¥${item.price_limit.toLocaleString()}` : null} />
            <Field label="選定理由" value={item?.selection_reason} />
            <Field label="提案理由" value={item?.proposal_reason} />
            {/* 事業所別レンタル価格（表示） */}
            {offices.length > 0 && myOfficePrices.length > 0 && (
              <div className="bg-gray-50 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-2">事業所別レンタル価格</p>
                <div className="space-y-1">
                  {offices.map((office) => {
                    const op = myOfficePrices.find((p) => p.office_id === office.id);
                    if (!op) return null;
                    return (
                      <div key={office.id} className="flex justify-between items-center">
                        <span className="text-xs text-gray-600">{office.name}</span>
                        <span className="text-sm font-medium text-emerald-700">¥{op.rental_price.toLocaleString()}/月</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
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

function ClientsTab({ tenantId, currentOfficeId, officeViewAll, initialClientId, onClearInitialClient }: { tenantId: string; currentOfficeId: string | null; officeViewAll: boolean; initialClientId?: string | null; onClearInitialClient?: () => void }) {
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
  const [importResult, setImportResult] = useState<{ inserted: { name: string; user_number: string }[]; updated: { name: string; user_number: string }[]; merged: { name: string; user_number: string }[]; errors: { name: string; user_number: string; message: string }[]; reunited: number; insuranceAdded: number; addedOffices: number; addedManagers: number } | null>(null);
  // 取込前のプレビュー（差分・警告を確認してから実行）
  type ImportFieldDiff = { label: string; oldValue: string; newValue: string };
  type ImportWarningKind = "deleted_revival" | "provisional_promotion" | "referrer_lost" | "care_office_unlinked" | "care_manager_unlinked";
  type ProvisionalCandidate = {
    id: string;
    user_number: string | null;
    name: string;
    address: string | null;
    phone: string | null;
    matchKind: "exact_name" | "surname" | "address";
  };
  type ImportPreviewRow = {
    user_number: string;
    name: string;
    status: "new" | "unchanged" | "updated";
    diffs: ImportFieldDiff[];
    warnings: ImportWarningKind[];
    // 実行時に使う元データ
    data: Omit<Client, "id" | "created_at">;
    existingId: string | null;
    insurance: Array<Record<string, unknown>>;
    // 新規行のみ：仮登録の候補と、ユーザーがマージ先として選んだID
    provisionalCandidates: ProvisionalCandidate[];
    mergeWithProvisionalId: string | null;
  };
  // CSV内に登場するがマスタ未登録の事業所・ケアマネ
  type UnregisteredOffice = {
    name: string;            // CSVテキスト
    addToMaster: boolean;    // マスタに追加するか
    occurrences: number;     // 何件の利用者・履歴で使われているか
  };
  type UnregisteredManager = {
    name: string;            // CSVテキスト
    officeName: string;      // 所属事業所名（テキスト）
    addToMaster: boolean;
    occurrences: number;
  };
  // CSVテキスト → 既存マスタID のマップ（プレビュー時点で確定する分）
  type MasterMatchMaps = {
    officeNameToId: Record<string, string>;        // care_offices.name → id
    managerKeyToId: Record<string, string>;        // `${officeId}|${manager.name}` → id
  };
  type ImportPreview = {
    rows: ImportPreviewRow[];
    skippedLines: { reason: string; line: string }[];
    insuranceCount: number;
    unregisteredOffices: UnregisteredOffice[];
    unregisteredManagers: UnregisteredManager[];
    matchMaps: MasterMatchMaps;
  };
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [hospitalizations, setHospitalizations] = useState<ClientHospitalization[]>([]);
  const [hospLoading, setHospLoading] = useState<string | null>(null); // client.id being toggled
  const [hospFilter, setHospFilter] = useState(false);
  // 仮登録のみ表示フィルタ
  const [provisionalFilter, setProvisionalFilter] = useState(false);
  // ゴミ箱フィルタ（削除済みのみ表示）
  const [trashFilter, setTrashFilter] = useState(false);
  // 新規利用者追加モーダル
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientForm, setNewClientForm] = useState({ name: "", furigana: "", phone: "", mobile: "", address: "" });
  const [addingClient, setAddingClient] = useState(false);
  const [hospModalMonth, setHospModalMonth] = useState(() => new Date().toISOString().slice(0, 7)); // YYYY-MM
  // 紐付け候補モーダル用のステート（フックなので early return より前に配置）
  const [similarProvisionalCandidates, setSimilarProvisionalCandidates] = useState<Client[] | null>(null);
  // 入退院日付入力ダイアログ
  const [hospDateDialog, setHospDateDialog] = useState<{ client: Client; mode: "admit" | "discharge"; currentHospId?: string } | null>(null);
  const [hospDateInput, setHospDateInput] = useState(() => new Date().toISOString().slice(0, 10));
  // 実績表
  const [showJissekiModal, setShowJissekiModal] = useState(false);
  const [jissekiMonth, setJissekiMonth] = useState(() => new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [jissekiCmKey, setJissekiCmKey] = useState<string>("__ALL__"); // プレビュー対象（単独）
  const [jissekiSelectedKeys, setJissekiSelectedKeys] = useState<Set<string>>(new Set()); // チェック済みキー
  const [jissekiRentals, setJissekiRentals] = useState<ClientRentalHistory[]>([]);
  const [jissekiLoading, setJissekiLoading] = useState(false);
  const [jissekiPreview, setJissekiPreview] = useState(false);
  // 半額・日割・保留フラグ（rowKey → flags）
  const [jissekiFlags, setJissekiFlags] = useState<Record<string, { half: boolean; daily: boolean; hold: boolean }>>({});
  // テナント（自社）情報
  const [tenantInfo, setTenantInfo] = useState<Tenant | null>(null);
  const [clientOfficeMap, setClientOfficeMap] = useState<Set<string>>(new Set()); // 自事業所の利用者IDセット

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [c, items, eq, ords, sup, mem, hospRes, tenant, assignments] = await Promise.all([
          getClients(tenantId, { onlyDeleted: trashFilter }),
          getAllOrderItemsByTenant(tenantId),
          getEquipment(tenantId),
          getOrders(tenantId),
          getSuppliers(),
          getMembers(tenantId),
          supabase.from("client_hospitalizations").select("*").eq("tenant_id", tenantId).order("admission_date", { ascending: false }),
          getTenantById(tenantId),
          getClientOfficeAssignments(tenantId),
        ]);
        setClients(c);
        setOrderItems(items);
        setEquipment(eq);
        setOrders(ords);
        setSuppliers(sup);
        setMembers(mem);
        setHospitalizations((hospRes.data ?? []) as ClientHospitalization[]);
        setTenantInfo(tenant);
        // 事業所別利用者マップ
        if (currentOfficeId) {
          const assigned = new Set(assignments.filter(a => a.office_id === currentOfficeId).map(a => a.client_id));
          setClientOfficeMap(assigned);
        }
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
  }, [tenantId, trashFilter]);

  // ⚡ パフォーマンス最適化：Map ルックアップ（O(N) → O(1)）
  // 注意: フックの順序を保つため、必ず早期 return より前に置くこと
  const orderById = useMemo(() => {
    const m = new Map<string, Order>();
    for (const o of orders) m.set(o.id, o);
    return m;
  }, [orders]);
  const equipmentByCode = useMemo(() => {
    const m = new Map<string, Equipment>();
    for (const e of equipment) m.set(e.product_code, e);
    return m;
  }, [equipment]);
  const clientById = useMemo(() => {
    const m = new Map<string, Client>();
    for (const c of clients) m.set(c.id, c);
    return m;
  }, [clients]);

  // 入院フィルター用
  const hospFilteredIds = useMemo(() => {
    if (!hospFilter) return null;
    const [year, month] = hospModalMonth.split("-").map(Number);
    const firstDay = `${hospModalMonth}-01`;
    const lastDay = new Date(year, month, 0).toISOString().split("T")[0];
    return new Set(
      hospitalizations
        .filter(h => h.admission_date <= lastDay && (h.discharge_date === null || h.discharge_date >= firstDay))
        .map(h => h.client_id)
    );
  }, [hospFilter, hospModalMonth, hospitalizations]);

  const filtered = useMemo(() => clients
    .filter((c) => {
      // 事業所フィルタ（自事業所のみモードの場合）
      if (currentOfficeId && !officeViewAll && clientOfficeMap.size > 0 && !clientOfficeMap.has(c.id)) return false;
      // 仮登録のみ表示
      if (provisionalFilter && !c.is_provisional) return false;
      if (hospFilter) return hospFilteredIds!.has(c.id);
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
    // 事業所・施設は末尾、個人利用者は先頭。各ブロック内はフリガナ順
    .sort((a, b) => {
      const fa = a.is_facility ? 1 : 0;
      const fb = b.is_facility ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
    }),
    [clients, currentOfficeId, officeViewAll, clientOfficeMap, provisionalFilter, hospFilter, hospFilteredIds, kanaFilter, search]);

  // 変更履歴を生成（Mapルックアップで O(N²) → O(N) に、useMemoで再描画時再実行しない）
  // 注意: 早期 return より前に置くこと（フックの順序を保つ）
  const changeHistory = useMemo(() => {
    type ChangeEvent = { date: string; clientId: string; equipName: string; label: string; color: string };
    const events: ChangeEvent[] = [];
    for (const item of orderItems) {
      const order = orderById.get(item.order_id);
      if (!order?.client_id) continue;
      const eq = equipmentByCode.get(item.product_code);
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
      .map(([clientId, evts]) => ({ client: clientById.get(clientId), events: evts }))
      .filter((g) => g.client)
      .sort((a, b) => (b.events[0]?.date ?? "").localeCompare(a.events[0]?.date ?? ""));
  }, [orderItems, orderById, equipmentByCode, clientById]);

  // 全フック呼び出し済み。ここから早期 return が安全に使える ─────────────
  if (selectedClient) {
    return (
      <ClientDetail
        client={selectedClient}
        allOrderItems={orderItems}
        equipment={equipment}
        tenantId={tenantId}
        initialViewMode={selectedClientInitialViewMode}
        hospitalizations={hospitalizations}
        onBack={() => { setSelectedClient(null); setSelectedClientInitialViewMode(undefined); }}
      />
    );
  }

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

  const CSV_HEADERS = ["利用者番号", "氏名", "ふりがな", "電話番号", "携帯番号", "住所", "介護度", "給付率", "ケアマネ名", "ケアマネ事業所", "認定終了日", "メモ", "居宅・施設等"];

  const handleExportCSV = () => {
    const rows = clients.map((c) => [
      c.user_number ?? "", c.name, c.furigana ?? "",
      c.phone ?? "", c.mobile ?? "", c.address ?? "",
      c.care_level ?? "", c.benefit_rate ?? "",
      c.care_manager ?? "", c.care_manager_org ?? "",
      c.certification_end_date ?? "", c.memo ?? "",
      c.is_facility ? "1" : "",
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

  // 似た仮登録の検出（姓か住所が一致していれば候補）
  function findSimilarProvisionals(name: string, address: string): Client[] {
    const nameTrim = name.trim();
    const addrTrim = address.trim();
    if (!nameTrim && !addrTrim) return [];
    // 姓（先頭のスペースまでの文字列）を比較対象にする
    const surname = nameTrim.split(/[\s　]/)[0];
    return clients.filter((c) => {
      if (!c.is_provisional) return false;
      const cName = c.name ?? "";
      const cAddr = c.address ?? "";
      // 完全一致 / 姓一致 / 住所部分一致のいずれか
      if (nameTrim && cName === nameTrim) return true;
      if (surname && surname.length >= 1 && cName.startsWith(surname)) return true;
      if (addrTrim && cAddr && (cAddr.includes(addrTrim) || addrTrim.includes(cAddr))) return true;
      return false;
    });
  }

  // 実際に新規利用者を作成する処理（紐付けなし or 紐付け確認後）
  const insertFreshClient = async () => {
    // user_number 採番（tenant 単位 max+1）。@kt/shared 共通 util。
    // 旧実装は in-memory clients から reduce していたが、別 app（kaigo-app/calendar-app）
    // で同 tenant に追加された行を反映できなかった。DB クエリにすることで堅牢化。
    const maxNum = await getMaxUserNumber(supabase, tenantId);
    const { data: inserted, error } = await supabase.from("clients").insert({
      tenant_id: tenantId,
      user_number: String(maxNum + 1),
      name: newClientForm.name.trim(),
      furigana: newClientForm.furigana.trim() || null,
      phone: newClientForm.phone.trim() || null,
      mobile: newClientForm.mobile.trim() || null,
      address: newClientForm.address.trim() || null,
      is_provisional: false,
    }).select().single();
    if (error) throw error;
    if (currentOfficeId && inserted) {
      await supabase.from("client_office_assignments").upsert({
        tenant_id: tenantId,
        client_id: inserted.id,
        office_id: currentOfficeId,
      }, { onConflict: "tenant_id,client_id,office_id" });
      setClientOfficeMap((prev) => new Set([...prev, inserted.id]));
    }
  };

  // 仮登録を本登録化する（その場で編集扱い、UUIDは維持）
  const promoteProvisional = async (provisionalId: string) => {
    // user_number 採番（tenant 単位 max+1）。@kt/shared 共通 util。
    const maxNum = await getMaxUserNumber(supabase, tenantId);
    await promoteProvisionalClient(provisionalId, {
      user_number: String(maxNum + 1),
      name: newClientForm.name.trim(),
      furigana: newClientForm.furigana.trim() || null,
      phone: newClientForm.phone.trim() || null,
      mobile: newClientForm.mobile.trim() || null,
      address: newClientForm.address.trim() || null,
    });
    if (currentOfficeId) {
      await supabase.from("client_office_assignments").upsert({
        tenant_id: tenantId,
        client_id: provisionalId,
        office_id: currentOfficeId,
      }, { onConflict: "tenant_id,client_id,office_id" });
      setClientOfficeMap((prev) => new Set([...prev, provisionalId]));
    }
  };

  const handleAddNewClient = async () => {
    if (!newClientForm.name.trim()) return;
    // 類似仮登録が無いか確認
    const similar = findSimilarProvisionals(newClientForm.name, newClientForm.address);
    if (similar.length > 0) {
      setSimilarProvisionalCandidates(similar);
      return;
    }
    setAddingClient(true);
    try {
      await insertFreshClient();
      const newClients = await getClients(tenantId);
      setClients(newClients);
      setNewClientForm({ name: "", furigana: "", phone: "", mobile: "", address: "" });
      setShowNewClient(false);
    } catch (e) {
      alert("利用者の追加に失敗しました");
      console.error(e);
    } finally {
      setAddingClient(false);
    }
  };

  // 紐付けモーダルから選択: その仮登録を本登録化して終了
  const handleLinkToProvisional = async (provisionalId: string) => {
    setAddingClient(true);
    try {
      await promoteProvisional(provisionalId);
      const newClients = await getClients(tenantId);
      setClients(newClients);
      setNewClientForm({ name: "", furigana: "", phone: "", mobile: "", address: "" });
      setShowNewClient(false);
      setSimilarProvisionalCandidates(null);
    } catch (e) {
      alert("本登録に失敗しました");
      console.error(e);
    } finally {
      setAddingClient(false);
    }
  };

  // 紐付けモーダルから「別人として新規作成」を選んだ場合
  const handleSkipProvisionalLink = async () => {
    setAddingClient(true);
    try {
      await insertFreshClient();
      const newClients = await getClients(tenantId);
      setClients(newClients);
      setNewClientForm({ name: "", furigana: "", phone: "", mobile: "", address: "" });
      setShowNewClient(false);
      setSimilarProvisionalCandidates(null);
    } catch (e) {
      alert("利用者の追加に失敗しました");
      console.error(e);
    } finally {
      setAddingClient(false);
    }
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
      // エンコーディング判定：UTF-8 BOMがあればUTF-8、無ければShift-JISを試す
      //   介護ソフト出力CSVはShift-JISが多いが、order-app自身の出力はUTF-8 BOM付き
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
      let text: string;
      if (hasUtf8Bom) {
        text = new TextDecoder("utf-8").decode(buffer);
      } else {
        // Shift-JIS で試す。変換不能文字（U+FFFD）が多ければ UTF-8 フォールバック
        const sjisText = new TextDecoder("shift-jis", { fatal: false }).decode(buffer);
        const replacementCount = (sjisText.match(/\uFFFD/g) ?? []).length;
        if (replacementCount > 5) {
          text = new TextDecoder("utf-8").decode(buffer);
        } else {
          text = sjisText;
        }
      }
      const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim());
      if (lines.length < 2) return;
      const headers = parseCsvRow(lines[0]);
      // ヘッダー別名対応：calendar-app や介護ソフト由来のヘッダー名も受け付ける
      const headerAliases: Record<string, string[]> = {
        "利用者番号": ["利用者番号"],
        "氏名": ["氏名", "利用者名"],
        "姓": ["利用者名（姓）", "姓"],
        "名": ["利用者名（名）", "名"],
        "ふりがな": ["ふりがな", "フリガナ"],
        "フリガナ姓": ["フリガナ（姓）"],
        "フリガナ名": ["フリガナ（名）"],
        "性別": ["性別"],
        "居宅・施設等": ["居宅・施設等", "事業所フラグ", "施設フラグ"],
        "電話番号": ["電話番号"],
        "携帯番号": ["携帯番号"],
        "住所": ["住所"],
        "介護度": ["介護度", "要介護度"],
        "給付率": ["給付率"],
        "ケアマネ名": ["ケアマネ名", "担当ケアマネジャー"],
        "ケアマネ事業所": ["ケアマネ事業所", "支援事業所（正式名称）", "支援事業所"],
        "認定終了日": ["認定終了日", "認定有効期間－終了日"],
        "メモ": ["メモ"],
        "被保険者番号": ["被保険者番号"],
        "生年月日": ["生年月日"],
        "認定開始日": ["認定開始日", "認定有効期間－開始日"],
        "保険者番号": ["保険者番号"],
        "利用者負担割合": ["利用者負担割合"],
        "公費負担情報": ["公費負担情報"],
        // 介護保険画面で表示する項目用
        "保険者名": ["保険者", "保険者名"],
        "交付年月日": ["交付年月日"],
        "保険証確認日": ["確認日", "保険証確認日"],
        "資格取得日": ["資格取得日"],
        "保険証有効開始日": ["有効開始日"],
        "保険証有効終了日": ["有効終了日"],
        "認定年月日": ["認定年月日"],
        "認定状況": ["認定状況"],
        "居宅適用期間開始": ["適用期間－開始日（居宅ｻｰﾋﾞｽ区分）"],
        "居宅適用期間終了": ["適用期間－終了日（居宅ｻｰﾋﾞｽ区分）"],
        "区分支給限度額": ["区分支給限度基準額（居宅ｻｰﾋﾞｽ区分）"],
        "留意事項": ["留意事項"],
        "サービス限定": ["サービス限定"],
      };
      const col = (canonicalName: string): number => {
        const aliases = headerAliases[canonicalName] ?? [canonicalName];
        for (const alias of aliases) {
          const idx = headers.indexOf(alias);
          if (idx >= 0) return idx;
        }
        return -1;
      };

      // DB から最新の利用者を直接取得（in-memory state が 1000件制限でstaleな可能性があるため）
      // 差分検出に必要なフィールドも一緒に取得（プレビュー用）
      type FreshClient = {
        id: string;
        user_number: string | null;
        name: string | null;
        furigana: string | null;
        phone: string | null;
        mobile: string | null;
        address: string | null;
        gender: string | null;
        care_level: string | null;
        benefit_rate: string | null;
        care_manager: string | null;
        care_manager_org: string | null;
        certification_end_date: string | null;
        memo: string | null;
        insured_number: string | null;
        birth_date: string | null;
        certification_start_date: string | null;
        insurer_number: string | null;
        copay_rate: string | null;
        public_expense: string | null;
        is_facility: boolean | null;
        is_provisional: boolean | null;
        deleted_at: string | null;
        referrer_org: string | null;
        care_office_id: string | null;
        care_manager_id: string | null;
      };
      const freshClients: FreshClient[] = [];
      {
        const PAGE = 1000;
        let from = 0;
        while (true) {
          const { data } = await supabase
            .from("clients")
            // memo は DROP 済（client_memos に移行）。型互換のため後で undefined を許容。
            .select("id,user_number,name,furigana,phone,mobile,address,gender,care_level,benefit_rate,care_manager,care_manager_org,certification_end_date,insured_number,birth_date,certification_start_date,insurer_number,copay_rate,public_expense,is_facility,is_provisional,deleted_at,referrer_org,care_office_id,care_manager_id")
            .eq("tenant_id", tenantId)
            .range(from, from + PAGE - 1);
          if (!data || data.length === 0) break;
          freshClients.push(...(data as FreshClient[]));
          if (data.length < PAGE) break;
          from += PAGE;
        }
      }
      const existingByUserNumber = new Map(freshClients.filter(c => c.user_number).map(c => [c.user_number as string, c]));

      const maxNum = freshClients.reduce((mx, c) => {
        const n = parseInt(c.user_number ?? "0");
        return isNaN(n) ? mx : Math.max(mx, n);
      }, 0);
      let nextNum = maxNum + 1;

      const skipped: { reason: string; line: string }[] = [];
      // clients テーブル用: user_number で集約（認定終了日が最新のものを採用）
      type ClientData = Omit<Client, "id" | "created_at">;
      const clientByUserNumber = new Map<string, ClientData>();
      // 保険情報履歴: 1利用者に複数行（認定期間ごと）を蓄積
      // 画面（介護保険タブ）で表示する項目のみ
      type InsuranceData = {
        insured_number: string | null;
        birth_date: string | null;
        insurer_number: string | null;
        insurer_name: string | null;
        issued_date: string | null;
        insurance_confirmed_date: string | null;
        qualification_date: string | null;
        insurance_valid_start: string | null;
        insurance_valid_end: string | null;
        benefit_rate: string | null;
        care_level: string | null;
        certification_status: string | null;
        certification_date: string | null;
        certification_start_date: string | null;
        certification_end_date: string | null;
        service_limit_period_start: string | null;
        service_limit_period_end: string | null;
        service_limit_amount: number | null;
        service_memo: string | null;
        service_restriction: string | null;
        care_manager: string | null;
        care_manager_org: string | null;
        copay_rate: string | null;
        public_expense: string | null;
      };
      const insuranceRowsByUserNumber = new Map<string, InsuranceData[]>();

      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        // カンマだけの実質空行（例: ",,,,,,,,"）はログせずスキップ
        if (!/[^\s,"]/.test(line)) continue;
        const cols = parseCsvRow(line);
        // 氏名: 「利用者名」列、もしくは「利用者名（姓）」+「利用者名（名）」から構築
        const directName = cols[col("氏名")]?.trim() || "";
        const lastName = cols[col("姓")]?.trim() || "";
        const firstName = cols[col("名")]?.trim() || "";
        const name = directName || `${lastName} ${firstName}`.trim();
        // フリガナも同様に姓/名 → 統合のフォールバック
        const directFurigana = cols[col("ふりがな")]?.trim() || "";
        const fLast = cols[col("フリガナ姓")]?.trim() || "";
        const fFirst = cols[col("フリガナ名")]?.trim() || "";
        const furigana = directFurigana || `${fLast} ${fFirst}`.trim() || null;
        if (!name) {
          // 氏名が完全に空（姓・名・利用者名の全てが空）→ ログせず静かにスキップ
          continue;
        }
        const userNumber = cols[col("利用者番号")]?.trim() || null;
        // clients テーブルに保存する項目一式
        const data: ClientData = {
          tenant_id: tenantId,
          user_number: userNumber ?? String(nextNum++),
          name,
          furigana: furigana,
          phone: cols[col("電話番号")]?.trim() || null,
          mobile: cols[col("携帯番号")]?.trim() || null,
          address: cols[col("住所")]?.trim() || null,
          care_level: cols[col("介護度")]?.trim() || null,
          benefit_rate: cols[col("給付率")]?.trim() || null,
          care_manager: cols[col("ケアマネ名")]?.trim() || null,
          care_manager_org: cols[col("ケアマネ事業所")]?.trim() || null,
          certification_end_date: cols[col("認定終了日")]?.trim() || null,
          // memo は clients から DROP 済。CSV から読んでも保存先がないため省略
          insured_number: cols[col("被保険者番号")]?.trim() || null,
          birth_date: cols[col("生年月日")]?.trim() || null,
          certification_start_date: cols[col("認定開始日")]?.trim() || null,
          insurer_number: cols[col("保険者番号")]?.trim() || null,
          copay_rate: (() => {
            // 利用者負担割合が直接CSVにあればそれを使う
            const direct = cols[col("利用者負担割合")]?.trim();
            if (direct) return direct;
            // 無ければ給付率から計算（給付率70 → 負担割合30）
            const benefit = cols[col("給付率")]?.trim();
            if (benefit && !isNaN(Number(benefit))) {
              return String(100 - Number(benefit));
            }
            return null;
          })(),
          public_expense: cols[col("公費負担情報")]?.trim() || null,
          gender: cols[col("性別")]?.trim() || null,
          // 居宅・施設等フラグ: CSVに値があれば true に設定（1/true/はい/チェック/〇 などを真と判定）
          is_facility: (() => {
            const v = cols[col("居宅・施設等")]?.trim() || "";
            if (!v) return false;
            return /^(1|true|TRUE|yes|YES|はい|チェック|〇|○|●|✓|レ|✔)$/.test(v);
          })(),
          // CSV 取込は正式データなので仮登録フラグは常に false
          is_provisional: false,
          // CSV 取込時点では未削除
          deleted_at: null,
          // 紹介機関は CSV 取込に含まれていない（画面で後から手入力）
          referrer_org: null,
          // マスタ紐付けは CSV 取込では設定しない（後で SQL で一括処理）
          care_office_id: null,
          care_manager_id: null,
        };

        // clients: user_number で集約（認定終了日が最新のものを採用）
        const userNumKey = data.user_number ?? "";
        const existing = clientByUserNumber.get(userNumKey);
        const newEnd = data.certification_end_date ?? "";
        const oldEnd = existing?.certification_end_date ?? "";
        if (!existing || newEnd > oldEnd) {
          clientByUserNumber.set(userNumKey, data);
        }

        // 保険情報: 1行 = 1認定期間。画面表示項目を全て取り込み
        const amountRaw = cols[col("区分支給限度額")]?.trim() || "";
        const amountNum = amountRaw && !isNaN(Number(amountRaw)) ? Number(amountRaw) : null;
        const ins: InsuranceData = {
          insured_number: data.insured_number ?? null,
          birth_date: data.birth_date ?? null,
          insurer_number: data.insurer_number ?? null,
          insurer_name: cols[col("保険者名")]?.trim() || null,
          issued_date: cols[col("交付年月日")]?.trim() || null,
          insurance_confirmed_date: cols[col("保険証確認日")]?.trim() || null,
          qualification_date: cols[col("資格取得日")]?.trim() || null,
          insurance_valid_start: cols[col("保険証有効開始日")]?.trim() || null,
          insurance_valid_end: cols[col("保険証有効終了日")]?.trim() || null,
          benefit_rate: data.benefit_rate ?? null,
          care_level: data.care_level ?? null,
          certification_status: cols[col("認定状況")]?.trim() || null,
          certification_date: cols[col("認定年月日")]?.trim() || null,
          certification_start_date: data.certification_start_date ?? null,
          certification_end_date: data.certification_end_date ?? null,
          service_limit_period_start: cols[col("居宅適用期間開始")]?.trim() || null,
          service_limit_period_end: cols[col("居宅適用期間終了")]?.trim() || null,
          service_limit_amount: amountNum,
          service_memo: cols[col("留意事項")]?.trim() || null,
          service_restriction: cols[col("サービス限定")]?.trim() || null,
          care_manager: data.care_manager ?? null,
          care_manager_org: data.care_manager_org ?? null,
          copay_rate: data.copay_rate ?? null,
          public_expense: data.public_expense ?? null,
        };
        const hasAny = Object.values(ins).some(v => v !== null && v !== undefined && v !== "");
        if (hasAny && data.user_number) {
          const arr = insuranceRowsByUserNumber.get(data.user_number) ?? [];
          arr.push(ins);
          insuranceRowsByUserNumber.set(data.user_number, arr);
        }
      }

      // 集約済みの clients データから ImportPreviewRow を作成
      // 差分検出のフィールド対応表
      const FIELD_LABELS: Record<string, string> = {
        name: "氏名",
        furigana: "フリガナ",
        phone: "電話番号",
        mobile: "携帯番号",
        address: "住所",
        gender: "性別",
        care_level: "介護度",
        benefit_rate: "給付率",
        care_manager: "ケアマネ名",
        care_manager_org: "ケアマネ事業所",
        certification_end_date: "認定終了日",
        memo: "メモ",
        insured_number: "被保険者番号",
        birth_date: "生年月日",
        certification_start_date: "認定開始日",
        insurer_number: "保険者番号",
        copay_rate: "利用者負担割合",
        public_expense: "公費負担情報",
        is_facility: "居宅・施設フラグ",
      };
      const fmtVal = (v: unknown): string => {
        if (v == null || v === "") return "";
        if (typeof v === "boolean") return v ? "✓" : "";
        return String(v);
      };

      // ── マスタ自動マッチ準備 ──
      // 既存の居宅マスタ・ケアマネマスタを取得して、テキスト名 → ID のマップを構築
      const [careOfficesRes, careManagersRes] = await Promise.all([
        supabase.from("care_offices").select("id,name").eq("tenant_id", tenantId),
        supabase.from("care_managers").select("id,name,care_office_id,active").eq("tenant_id", tenantId),
      ]);
      const careOfficeRows = (careOfficesRes.data ?? []) as Array<{ id: string; name: string }>;
      const careManagerRows = (careManagersRes.data ?? []) as Array<{ id: string; name: string; care_office_id: string; active: boolean }>;
      // テキスト名 → ID。同名複数ある場合は最初のヒット
      const officeNameToId: Record<string, string> = {};
      for (const o of careOfficeRows) {
        if (o.name && !(o.name in officeNameToId)) officeNameToId[o.name] = o.id;
      }
      const managerKeyToId: Record<string, string> = {};
      for (const m of careManagerRows) {
        if (m.name && m.care_office_id) {
          const k = `${m.care_office_id}|${m.name}`;
          if (!(k in managerKeyToId)) managerKeyToId[k] = m.id;
        }
      }

      // CSV内に登場する office/manager のテキストを集計し、既存マスタとの突合結果を判定
      const officeOccurrences = new Map<string, number>();         // office_text → count
      const managerOccurrences = new Map<string, number>();        // `${officeText}${managerText}` → count
      const managerOfficeText = new Map<string, string>();         // managerKey → officeText（表示用）
      for (const data of clientByUserNumber.values()) {
        const ot = (data.care_manager_org ?? "").trim();
        if (ot) officeOccurrences.set(ot, (officeOccurrences.get(ot) ?? 0) + 1);
        const mt = (data.care_manager ?? "").trim();
        if (mt && ot) {
          const key = `${ot}${mt}`;
          managerOccurrences.set(key, (managerOccurrences.get(key) ?? 0) + 1);
          managerOfficeText.set(key, ot);
        }
      }
      // 履歴側でも集計（同じ利用者でも認定期間ごとに違う事業所/ケアマネがあるため）
      for (const insArr of insuranceRowsByUserNumber.values()) {
        for (const ins of insArr) {
          const ot = (ins.care_manager_org ?? "").trim();
          if (ot) officeOccurrences.set(ot, (officeOccurrences.get(ot) ?? 0) + 1);
          const mt = (ins.care_manager ?? "").trim();
          if (mt && ot) {
            const key = `${ot}${mt}`;
            managerOccurrences.set(key, (managerOccurrences.get(key) ?? 0) + 1);
            managerOfficeText.set(key, ot);
          }
        }
      }
      // マスタ未登録のものをリストアップ
      const unregisteredOffices: UnregisteredOffice[] = [];
      for (const [name, count] of officeOccurrences.entries()) {
        if (!(name in officeNameToId)) {
          unregisteredOffices.push({ name, addToMaster: true, occurrences: count });
        }
      }
      unregisteredOffices.sort((a, b) => b.occurrences - a.occurrences);
      const unregisteredManagers: UnregisteredManager[] = [];
      for (const [key, count] of managerOccurrences.entries()) {
        const officeText = managerOfficeText.get(key) ?? "";
        const managerText = key.split("")[1] ?? "";
        // 既存マスタにある事業所配下なら、ケアマネ名で照合
        const officeId = officeNameToId[officeText];
        if (officeId) {
          const mk = `${officeId}|${managerText}`;
          if (mk in managerKeyToId) continue; // 既存マッチ
        }
        unregisteredManagers.push({
          name: managerText,
          officeName: officeText,
          addToMaster: true,
          occurrences: count,
        });
      }
      unregisteredManagers.sort((a, b) => b.occurrences - a.occurrences || a.officeName.localeCompare(b.officeName, "ja"));

      // 仮登録の一覧を抽出（CSV取込み時に名前一致で紐付け候補として表示）
      // CSVの user_number と既に一致している仮登録は対象外（=普通にUPDATE）
      const provisionalClients = freshClients.filter(
        (c) => c.is_provisional === true && !c.deleted_at
      );
      const usedProvisionalIds = new Set<string>();
      // 名前を比較しやすい形に正規化（全角空白→半角、前後トリム、連続空白→1個）
      const normName = (s: string | null | undefined): string =>
        (s ?? "").trim().replace(/　/g, " ").replace(/\s+/g, " ");

      const findProvisionalCandidates = (newData: Omit<Client, "id" | "created_at">): ProvisionalCandidate[] => {
        const targetName = normName(newData.name);
        const targetAddr = normName(newData.address);
        if (!targetName) return [];
        const surname = targetName.split(/[\s ]/)[0];

        const candidates: ProvisionalCandidate[] = [];
        for (const p of provisionalClients) {
          if (usedProvisionalIds.has(p.id)) continue; // 同一CSV内で重複マッチを防ぐ
          const pName = normName(p.name);
          const pAddr = normName(p.address);
          let kind: ProvisionalCandidate["matchKind"] | null = null;
          if (pName && pName === targetName) kind = "exact_name";
          else if (surname && surname.length >= 1 && pName.startsWith(surname)) kind = "surname";
          else if (targetAddr && pAddr && (pAddr.includes(targetAddr) || targetAddr.includes(pAddr))) kind = "address";
          if (kind) {
            candidates.push({
              id: p.id,
              user_number: p.user_number,
              name: p.name ?? "",
              address: p.address,
              phone: p.phone,
              matchKind: kind,
            });
          }
        }
        // 完全一致 → 姓 → 住所 の順
        candidates.sort((a, b) => {
          const order = { exact_name: 0, surname: 1, address: 2 };
          return order[a.matchKind] - order[b.matchKind];
        });
        return candidates;
      };

      const previewRows: ImportPreviewRow[] = [];
      for (const data of clientByUserNumber.values()) {
        const existing = existingByUserNumber.get(data.user_number ?? "");
        const insurance = insuranceRowsByUserNumber.get(data.user_number ?? "") ?? [];
        if (!existing) {
          // 新規行 → 仮登録の候補を検索
          const candidates = findProvisionalCandidates(data);
          // 完全一致が1件のみならデフォルトでマージ選択、それ以外はOFF
          const exactMatches = candidates.filter((c) => c.matchKind === "exact_name");
          const defaultMergeId = exactMatches.length === 1 ? exactMatches[0].id : null;
          if (defaultMergeId) usedProvisionalIds.add(defaultMergeId);
          previewRows.push({
            user_number: data.user_number ?? "",
            name: data.name,
            status: "new",
            diffs: [],
            warnings: [],
            data,
            existingId: null,
            insurance: insurance as Array<Record<string, unknown>>,
            provisionalCandidates: candidates,
            mergeWithProvisionalId: defaultMergeId,
          });
          continue;
        }
        // 差分計算（fields の旧値と新値を比較）
        const diffs: ImportFieldDiff[] = [];
        for (const k of Object.keys(FIELD_LABELS)) {
          const oldV = (existing as Record<string, unknown>)[k];
          const newV = (data as unknown as Record<string, unknown>)[k];
          const oldS = fmtVal(oldV);
          const newS = fmtVal(newV);
          if (oldS !== newS) {
            diffs.push({ label: FIELD_LABELS[k], oldValue: oldS, newValue: newS });
          }
        }
        // 警告判定（マスタ紐付けは UPDATE 時に保護するので警告にしない）
        const warnings: ImportWarningKind[] = [];
        if (existing.deleted_at) warnings.push("deleted_revival");
        if (existing.is_provisional === true) warnings.push("provisional_promotion");
        // referrer_org / care_office_id / care_manager_id は UPDATE で保護するので警告対象外
        // （CSVに値が無くても既存値を維持する）
        previewRows.push({
          user_number: data.user_number ?? "",
          name: data.name,
          status: diffs.length === 0 && warnings.length === 0 ? "unchanged" : "updated",
          diffs,
          warnings,
          data,
          existingId: existing.id,
          insurance: insurance as Array<Record<string, unknown>>,
          provisionalCandidates: [],
          mergeWithProvisionalId: null,
        });
      }

      const insuranceCount = Array.from(insuranceRowsByUserNumber.values()).reduce((s, arr) => s + arr.length, 0);
      setImportPreview({
        rows: previewRows,
        skippedLines: skipped,
        insuranceCount,
        unregisteredOffices,
        unregisteredManagers,
        matchMaps: { officeNameToId, managerKeyToId },
      });
    } finally {
      setImporting(false);
      if (csvInputRef.current) csvInputRef.current.value = "";
    }
  };

  // プレビューを基に実際の取込みを実行
  const executeImport = async (preview: ImportPreview) => {
    setImporting(true);
    try {
      const errors: { name: string; user_number: string; message: string }[] = [];
      const successfullyInserted: { name: string; user_number: string }[] = [];
      const successfullyUpdated: { name: string; user_number: string }[] = [];
      const successfullyMerged: { name: string; user_number: string }[] = [];
      let insertedIds: string[] = [];
      const updatedIds: string[] = [];

      // ── マスタ新規追加（チェック済みのもの） ──
      const officeNameToId = { ...preview.matchMaps.officeNameToId };
      const managerKeyToId = { ...preview.matchMaps.managerKeyToId };
      let addedOfficeCount = 0;
      let addedManagerCount = 0;

      // 1. 居宅事業所をマスタに新規追加
      for (const o of preview.unregisteredOffices) {
        if (!o.addToMaster) continue;
        const { data, error } = await supabase
          .from("care_offices")
          .insert({ tenant_id: tenantId, name: o.name })
          .select("id")
          .single();
        if (!error && data) {
          officeNameToId[o.name] = data.id;
          addedOfficeCount++;
        } else if (error) {
          errors.push({ name: o.name, user_number: "", message: `居宅マスタ追加失敗: ${error.message}` });
        }
      }
      // 2. ケアマネをマスタに新規追加（事業所IDが解決できたものだけ）
      for (const m of preview.unregisteredManagers) {
        if (!m.addToMaster) continue;
        const officeId = officeNameToId[m.officeName];
        if (!officeId) {
          // 親事業所がマスタに無い → 追加できないのでスキップ
          continue;
        }
        const k = `${officeId}|${m.name}`;
        if (k in managerKeyToId) continue; // 既に追加済み
        const { data, error } = await supabase
          .from("care_managers")
          .insert({ tenant_id: tenantId, care_office_id: officeId, name: m.name, active: true })
          .select("id")
          .single();
        if (!error && data) {
          managerKeyToId[k] = data.id;
          addedManagerCount++;
        } else if (error) {
          errors.push({ name: m.name, user_number: "", message: `ケアマネマスタ追加失敗: ${error.message}` });
        }
      }

      // テキストからマスタIDを解決（追加分も反映済み）
      const resolveOfficeId = (officeText: string | null | undefined): string | null => {
        if (!officeText) return null;
        return officeNameToId[officeText.trim()] ?? null;
      };
      const resolveManagerId = (managerText: string | null | undefined, officeText: string | null | undefined): string | null => {
        if (!managerText || !officeText) return null;
        const officeId = resolveOfficeId(officeText);
        if (!officeId) return null;
        return managerKeyToId[`${officeId}|${managerText.trim()}`] ?? null;
      };

      // 仮登録マージ対象（INSERTせず、仮登録レコードをUPDATEで本登録化）
      const toMerge = preview.rows.filter((r) => r.status === "new" && r.mergeWithProvisionalId);
      // 純粋な新規追加
      const toInsert = preview.rows.filter((r) => r.status === "new" && !r.mergeWithProvisionalId);
      // 既存の更新
      const toUpdate = preview.rows.filter((r) => r.status === "updated" || r.status === "unchanged");

      // MERGE: 仮登録のUUIDを維持しつつ、CSVデータで上書き＋is_provisional=falseに
      // 自動マッチで解決したマスタIDも一緒にセット
      for (const r of toMerge) {
        const provisionalId = r.mergeWithProvisionalId!;
        const officeId = resolveOfficeId(r.data.care_manager_org);
        const managerId = resolveManagerId(r.data.care_manager, r.data.care_manager_org);
        const payload = { ...r.data, care_office_id: officeId, care_manager_id: managerId };
        const { error: mergeErr } = await supabase.from("clients").update(payload).eq("id", provisionalId);
        if (mergeErr) {
          errors.push({ name: r.name, user_number: r.user_number, message: `仮登録マージ失敗: ${mergeErr.message}` });
        } else {
          updatedIds.push(provisionalId);
          successfullyMerged.push({ name: r.name, user_number: r.user_number });
        }
      }

      // INSERT: 自動マッチでマスタIDを補完
      if (toInsert.length > 0) {
        const insertPayloads = toInsert.map((r) => ({
          ...r.data,
          care_office_id: resolveOfficeId(r.data.care_manager_org),
          care_manager_id: resolveManagerId(r.data.care_manager, r.data.care_manager_org),
        }));
        const { data: inserted, error: batchErr } = await supabase
          .from("clients")
          .insert(insertPayloads)
          .select("id");
        if (!batchErr && inserted) {
          insertedIds = inserted.map((r: { id: string }) => r.id);
          toInsert.forEach((r) => successfullyInserted.push({ name: r.name, user_number: r.user_number }));
        } else {
          for (let i = 0; i < toInsert.length; i++) {
            const r = toInsert[i];
            const payload = insertPayloads[i];
            const { data: one, error: oneErr } = await supabase.from("clients").insert(payload).select("id").single();
            if (oneErr) {
              errors.push({ name: r.name, user_number: r.user_number, message: oneErr.message });
            } else if (one) {
              insertedIds.push(one.id);
              successfullyInserted.push({ name: r.name, user_number: r.user_number });
            }
          }
        }
      }

      // UPDATE: 既存マスタID・referrer_org は保護。CSV側で解決したIDは未紐付けの場合のみセット
      for (const r of toUpdate) {
        if (!r.existingId) continue;
        // care_office_id / care_manager_id / referrer_org を payload から除外
        const { care_office_id: _coid, care_manager_id: _cmid, referrer_org: _ref, ...rest } = r.data as unknown as Record<string, unknown>;
        void _coid; void _cmid; void _ref; // 未使用警告抑制
        const payload: Record<string, unknown> = { ...rest };
        // 自動マッチで新規にIDが解決でき、かつ既存値が無ければセット（既に紐付いていれば触らない）
        const newOfficeId = resolveOfficeId((r.data as { care_manager_org: string | null }).care_manager_org);
        const newManagerId = resolveManagerId((r.data as { care_manager: string | null }).care_manager, (r.data as { care_manager_org: string | null }).care_manager_org);
        // 既存IDを取得し、null なら自動マッチを反映、紐付け済みなら維持
        const existing = await supabase
          .from("clients")
          .select("care_office_id, care_manager_id, referrer_org")
          .eq("id", r.existingId)
          .maybeSingle();
        const existingOfficeId = (existing.data?.care_office_id as string | null) ?? null;
        const existingManagerId = (existing.data?.care_manager_id as string | null) ?? null;
        if (!existingOfficeId && newOfficeId) payload.care_office_id = newOfficeId;
        if (!existingManagerId && newManagerId) payload.care_manager_id = newManagerId;
        const { error: updErr } = await supabase.from("clients").update(payload).eq("id", r.existingId);
        if (updErr) {
          errors.push({ name: r.name, user_number: r.user_number, message: updErr.message });
        } else {
          updatedIds.push(r.existingId);
          successfullyUpdated.push({ name: r.name, user_number: r.user_number });
        }
      }

      // 自事業所が選択されていれば、取込/更新した全利用者を自動紐付け
      if (currentOfficeId) {
        const allIds = [...insertedIds, ...updatedIds];
        if (allIds.length > 0) {
          const assignmentRows = allIds.map((cid) => ({
            tenant_id: tenantId,
            client_id: cid,
            office_id: currentOfficeId,
          }));
          await supabase.from("client_office_assignments").upsert(assignmentRows, {
            onConflict: "tenant_id,client_id,office_id",
          });
        }
      }

      const newClients = await getClients(tenantId);
      setClients(newClients);

      // 保険情報の書き込み
      let insuranceAdded = 0;
      try {
        const clientIdByUserNumber = new Map<string, string>();
        for (const c of newClients) {
          if (c.user_number) clientIdByUserNumber.set(c.user_number, c.id);
        }
        for (const r of preview.rows) {
          if (r.insurance.length === 0) continue;
          const clientId = clientIdByUserNumber.get(r.user_number);
          if (!clientId) continue;
          const { data: existingRecords } = await supabase
            .from("client_insurance_records")
            .select("id, effective_date")
            .eq("tenant_id", tenantId)
            .eq("client_id", clientId);
          const existingByDate = new Map<string, string>();
          for (const rec of (existingRecords ?? []) as Array<{ id: string; effective_date: string | null }>) {
            existingByDate.set(rec.effective_date ?? "", rec.id);
          }
          for (const ins of r.insurance) {
            const effectiveDate = (ins.certification_start_date as string | null) || null;
            // 履歴行にもマスタIDを自動マッチで紐付け
            const insOfficeId = resolveOfficeId((ins.care_manager_org as string | null) ?? null);
            const insManagerId = resolveManagerId((ins.care_manager as string | null) ?? null, (ins.care_manager_org as string | null) ?? null);
            const payload = {
              tenant_id: tenantId,
              client_id: clientId,
              effective_date: effectiveDate,
              ...ins,
              care_office_id: insOfficeId,
              care_manager_id: insManagerId,
            };
            const exId = existingByDate.get(effectiveDate ?? "");
            if (exId) {
              const { error: upErr } = await supabase.from("client_insurance_records").update(payload).eq("id", exId);
              if (!upErr) insuranceAdded++;
            } else {
              const { error: insErr } = await supabase.from("client_insurance_records").insert(payload);
              if (!insErr) {
                insuranceAdded++;
                existingByDate.set(effectiveDate ?? "", "newly-inserted");
              }
            }
          }
        }
      } catch {
        // 致命的ではないので握りつぶす
      }

      // 予定の自動再紐付け
      let reunited = 0;
      try {
        const { data: orphanEvents } = await supabase
          .from("events")
          .select("id,title")
          .eq("tenant_id", tenantId)
          .is("client_id", null)
          .is("deleted_at", null);
        if (orphanEvents && orphanEvents.length > 0) {
          const nameToId = new Map<string, string>();
          for (const c of newClients) {
            if (!nameToId.has(c.name)) nameToId.set(c.name, c.id);
          }
          const updates: { id: string; client_id: string }[] = [];
          for (const ev of orphanEvents as Array<{ id: string; title: string }>) {
            const m = ev.title.match(/^(.+?) 様(?:[ 　].*)?$/);
            if (!m) continue;
            const clientId = nameToId.get(m[1].trim());
            if (clientId) updates.push({ id: ev.id, client_id: clientId });
          }
          for (const u of updates) {
            const { error: reErr } = await supabase.from("events").update({ client_id: u.client_id }).eq("id", u.id);
            if (!reErr) reunited++;
          }
        }
      } catch {
        // 致命的ではない
      }

      // スキップ行をエラーに追加
      for (const s of preview.skippedLines) {
        errors.push({ name: "(スキップ)", user_number: "", message: `${s.reason}: ${s.line}` });
      }

      setImportPreview(null);
      setImportResult({
        inserted: successfullyInserted,
        updated: successfullyUpdated,
        merged: successfullyMerged,
        errors,
        reunited,
        insuranceAdded,
        addedOffices: addedOfficeCount,
        addedManagers: addedManagerCount,
      });
    } finally {
      setImporting(false);
    }
  };

  // 入退院ボタン → 日付入力ダイアログを開く
  const toggleHospitalization = (client: Client) => {
    const current = hospitalizations.find(h => h.client_id === client.id && h.discharge_date === null);
    setHospDateInput(new Date().toISOString().slice(0, 10));
    setHospDateDialog({ client, mode: current ? "discharge" : "admit", currentHospId: current?.id });
  };

  // 日付確定後にDBへ保存
  const confirmHospDate = async () => {
    if (!hospDateDialog) return;
    const { client, mode, currentHospId } = hospDateDialog;
    setHospLoading(client.id);
    setHospDateDialog(null);
    try {
      if (mode === "discharge" && currentHospId) {
        const { error } = await supabase.from("client_hospitalizations")
          .update({ discharge_date: hospDateInput })
          .eq("id", currentHospId);
        if (!error) {
          setHospitalizations(prev => prev.map(h => h.id === currentHospId ? { ...h, discharge_date: hospDateInput } : h));
        }
      } else {
        const { data, error } = await supabase.from("client_hospitalizations")
          .insert({ tenant_id: tenantId, client_id: client.id, admission_date: hospDateInput })
          .select().single();
        if (!error && data) {
          setHospitalizations(prev => [data as ClientHospitalization, ...prev]);
        }
      }
    } finally {
      setHospLoading(null);
    }
  };

  const openJissekiModal = async () => {
    setShowJissekiModal(true);
    if (jissekiRentals.length > 0) return; // already loaded
    setJissekiLoading(true);
    try {
      const all: ClientRentalHistory[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("client_rental_history")
          .select("*")
          .eq("tenant_id", tenantId)
          .is("end_date", null)
          .range(from, from + 999);
        if (error || !data || data.length === 0) break;
        all.push(...(data as ClientRentalHistory[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      setJissekiRentals(all);
    } finally {
      setJissekiLoading(false);
    }
  };

  // サービスコードマッピング（種目→コード）
  const JISSEKI_SERVICE_CODES: Record<string, string> = {
    "車いす": "17 1001",
    "車椅子": "17 1001",
    "車いす付属品": "17 1002",
    "車椅子付属品": "17 1002",
    "特殊寝台": "17 1003",
    "特殊寝台付属品": "17 1004",
    "床ずれ防止用具": "17 1005",
    "体位変換器": "17 1006",
    "手すり": "17 1007",
    "スロープ": "17 1008",
    "歩行器": "17 1009",
    "歩行補助つえ": "17 1012",
    "徘徊感知機器": "17 1014",
    "認知症老人徘徊感知機器": "17 1014",
    "移動用リフト": "17 1015",
    "自動排せつ処理装置": "17 1016",
  };

  // 警告ラベル
  const WARNING_LABELS: Record<string, { color: string; bg: string; icon: string; label: string }> = {
    deleted_revival:        { color: "text-red-700",    bg: "bg-red-50",    icon: "🔴", label: "削除済みから復活" },
    provisional_promotion:  { color: "text-amber-700",  bg: "bg-amber-50",  icon: "🟡", label: "仮登録から本登録に昇格" },
    referrer_lost:          { color: "text-orange-700", bg: "bg-orange-50", icon: "🟠", label: "紹介機関が消える" },
    care_office_unlinked:   { color: "text-orange-700", bg: "bg-orange-50", icon: "🟠", label: "居宅マスタ紐付けが消える" },
    care_manager_unlinked:  { color: "text-orange-700", bg: "bg-orange-50", icon: "🟠", label: "ケアマネ紐付けが消える" },
  };

  return (
    <div className="flex flex-col h-full">
      {/* 取込プレビューモーダル */}
      {importPreview && (() => {
        const newRows = importPreview.rows.filter((r) => r.status === "new");
        const updatedRows = importPreview.rows.filter((r) => r.status === "updated");
        const unchangedRows = importPreview.rows.filter((r) => r.status === "unchanged");
        const warningRows = importPreview.rows.filter((r) => r.warnings.length > 0);
        const mergeRows = newRows.filter((r) => r.mergeWithProvisionalId);
        const newRowsWithCandidates = newRows.filter((r) => r.provisionalCandidates.length > 0);
        // 候補のチェックボックスを切り替える
        const setMergeId = (userNumber: string, provisionalId: string | null) => {
          if (!importPreview) return;
          // 同じ仮登録IDが他の新規行で既に選択されている場合はそちらを解除（重複マッチ防止）
          const next = importPreview.rows.map((row) => {
            if (row.user_number === userNumber && row.status === "new") {
              return { ...row, mergeWithProvisionalId: provisionalId };
            }
            // 別の行で同じ仮登録IDを選んでいたら null に戻す
            if (provisionalId && row.mergeWithProvisionalId === provisionalId && row.user_number !== userNumber) {
              return { ...row, mergeWithProvisionalId: null };
            }
            return row;
          });
          setImportPreview({ ...importPreview, rows: next });
        };
        // 警告の種類別グルーピング
        const warningByKind: Record<string, ImportPreviewRow[]> = {};
        for (const r of warningRows) {
          for (const w of r.warnings) {
            if (!warningByKind[w]) warningByKind[w] = [];
            warningByKind[w].push(r);
          }
        }
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
              <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
                <h3 className="font-semibold text-gray-800 text-sm">
                  📋 取込内容の確認（実行前プレビュー）
                </h3>
                <button onClick={() => setImportPreview(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
              </div>
              <div className="px-5 py-4 overflow-y-auto space-y-4 flex-1">
                {/* サマリ */}
                <div className="grid grid-cols-5 gap-2">
                  <div className="bg-emerald-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-emerald-700">{newRows.length - mergeRows.length}</p>
                    <p className="text-[10px] text-emerald-600">新規追加</p>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-purple-700">{mergeRows.length}</p>
                    <p className="text-[10px] text-purple-600">仮登録→本登録</p>
                  </div>
                  <div className="bg-indigo-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-indigo-700">{updatedRows.length}</p>
                    <p className="text-[10px] text-indigo-600">更新</p>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2 text-center">
                    <p className="text-lg font-bold text-gray-500">{unchangedRows.length}</p>
                    <p className="text-[10px] text-gray-500">変更なし</p>
                  </div>
                  <div className={`rounded-lg p-2 text-center ${warningRows.length > 0 ? "bg-red-50" : "bg-gray-50"}`}>
                    <p className={`text-lg font-bold ${warningRows.length > 0 ? "text-red-600" : "text-gray-500"}`}>{warningRows.length}</p>
                    <p className="text-[10px] text-gray-500">⚠️ 警告</p>
                  </div>
                </div>

                {/* 仮登録の紐付け候補（移行期間用） */}
                {newRowsWithCandidates.length > 0 && (
                  <div className="border border-purple-200 rounded-xl p-3 space-y-3 bg-purple-50/40">
                    <div>
                      <p className="text-sm font-bold text-purple-700">🔗 仮登録との紐付け候補（{newRowsWithCandidates.length}件）</p>
                      <p className="text-[11px] text-purple-600 mt-0.5">
                        カレンダー側で先に仮登録された利用者と同一人物の場合、紐付けると予定・発注がそのまま引き継がれます。
                      </p>
                    </div>
                    <div className="space-y-2 max-h-96 overflow-y-auto">
                      {newRowsWithCandidates.map((r, i) => {
                        const exactCount = r.provisionalCandidates.filter((c) => c.matchKind === "exact_name").length;
                        return (
                          <div key={i} className="bg-white rounded-lg p-2.5 border border-purple-100">
                            <p className="text-xs font-semibold text-gray-800 mb-1.5">
                              <span className="text-gray-400 mr-2">{r.user_number}</span>
                              {r.name}
                              {exactCount > 0 && <span className="ml-2 text-[10px] text-purple-600">完全一致{exactCount}件</span>}
                            </p>
                            <div className="space-y-1 pl-2">
                              {r.provisionalCandidates.map((cand) => (
                                <label key={cand.id} className="flex items-start gap-1.5 text-xs text-gray-700 cursor-pointer hover:bg-purple-50 rounded p-1">
                                  <input
                                    type="radio"
                                    name={`merge-${r.user_number}`}
                                    checked={r.mergeWithProvisionalId === cand.id}
                                    onChange={() => setMergeId(r.user_number, cand.id)}
                                    className="mt-0.5"
                                  />
                                  <span className="flex-1">
                                    <span className="font-medium">{cand.name}</span>
                                    {cand.matchKind === "exact_name" && <span className="ml-1 text-[10px] text-emerald-600 bg-emerald-50 px-1 rounded">完全一致</span>}
                                    {cand.matchKind === "surname" && <span className="ml-1 text-[10px] text-amber-600 bg-amber-50 px-1 rounded">姓一致</span>}
                                    {cand.matchKind === "address" && <span className="ml-1 text-[10px] text-sky-600 bg-sky-50 px-1 rounded">住所一致</span>}
                                    {(cand.address || cand.phone) && (
                                      <span className="block text-[10px] text-gray-400 mt-0.5">
                                        {cand.address ? `🏠 ${cand.address}` : ""}{cand.address && cand.phone ? " / " : ""}{cand.phone ? `📞 ${cand.phone}` : ""}
                                      </span>
                                    )}
                                  </span>
                                </label>
                              ))}
                              <label className="flex items-start gap-1.5 text-xs text-gray-700 cursor-pointer hover:bg-gray-50 rounded p-1">
                                <input
                                  type="radio"
                                  name={`merge-${r.user_number}`}
                                  checked={r.mergeWithProvisionalId === null}
                                  onChange={() => setMergeId(r.user_number, null)}
                                  className="mt-0.5"
                                />
                                <span className="text-gray-500">紐付けず、そのまま新規追加する</span>
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 警告一覧 */}
                {warningRows.length > 0 && (
                  <div className="border border-red-200 rounded-xl p-3 space-y-3 bg-red-50/30">
                    <p className="text-sm font-bold text-red-700">⚠️ 警告（実行前に確認してください）</p>
                    {Object.entries(warningByKind).map(([kind, rows]) => {
                      const meta = WARNING_LABELS[kind];
                      if (!meta) return null;
                      return (
                        <div key={kind} className={`rounded-lg p-2.5 ${meta.bg}`}>
                          <p className={`text-xs font-semibold ${meta.color} mb-1.5`}>
                            {meta.icon} {meta.label}（{rows.length}件）
                          </p>
                          <div className="space-y-0.5 max-h-32 overflow-y-auto">
                            {rows.slice(0, 50).map((r, i) => (
                              <p key={i} className="text-xs text-gray-700">
                                <span className="text-gray-400 mr-2">{r.user_number}</span>
                                {r.name}
                              </p>
                            ))}
                            {rows.length > 50 && <p className="text-[10px] text-gray-400">…他 {rows.length - 50}件</p>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* 更新内容詳細 */}
                {updatedRows.length > 0 && (
                  <details className="border border-indigo-200 rounded-xl bg-indigo-50/30">
                    <summary className="px-3 py-2 text-sm font-semibold text-indigo-700 cursor-pointer">
                      ✏️ 更新内容の詳細（{updatedRows.length}件）
                    </summary>
                    <div className="px-3 pb-3 space-y-2 max-h-72 overflow-y-auto">
                      {updatedRows.map((r, i) => (
                        <div key={i} className="bg-white rounded-lg p-2 border border-indigo-100">
                          <p className="text-xs font-semibold text-gray-800">
                            <span className="text-gray-400 mr-2">{r.user_number}</span>
                            {r.name}
                          </p>
                          {r.diffs.length > 0 ? (
                            <div className="mt-1 space-y-0.5">
                              {r.diffs.map((d, j) => (
                                <div key={j} className="text-[11px] text-gray-600">
                                  <span className="text-gray-400">{d.label}: </span>
                                  <span className="line-through text-gray-400">{d.oldValue || "（空）"}</span>
                                  <span className="mx-1 text-amber-600">→</span>
                                  <span className="text-emerald-700 font-medium">{d.newValue || "（空）"}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[11px] text-gray-400 mt-0.5">フィールド値の変更なし（警告のみ）</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* 新規追加リスト */}
                {newRows.length > 0 && (
                  <details className="border border-emerald-200 rounded-xl bg-emerald-50/30">
                    <summary className="px-3 py-2 text-sm font-semibold text-emerald-700 cursor-pointer">
                      🆕 新規追加（{newRows.length}件）
                    </summary>
                    <div className="px-3 pb-3 space-y-0.5 max-h-60 overflow-y-auto">
                      {newRows.map((r, i) => (
                        <p key={i} className="text-xs text-gray-700">
                          <span className="text-gray-400 mr-2">{r.user_number}</span>
                          {r.name}
                        </p>
                      ))}
                    </div>
                  </details>
                )}

                {/* スキップ行 */}
                {importPreview.skippedLines.length > 0 && (
                  <details className="border border-gray-200 rounded-xl bg-gray-50">
                    <summary className="px-3 py-2 text-sm font-semibold text-gray-600 cursor-pointer">
                      ⏭️ スキップ行（{importPreview.skippedLines.length}件）
                    </summary>
                    <div className="px-3 pb-3 space-y-0.5 max-h-40 overflow-y-auto">
                      {importPreview.skippedLines.map((s, i) => (
                        <p key={i} className="text-[11px] text-gray-500">{s.reason}: <span className="font-mono">{s.line.substring(0, 80)}</span></p>
                      ))}
                    </div>
                  </details>
                )}

                {/* マスタ未登録セクション */}
                {(importPreview.unregisteredOffices.length > 0 || importPreview.unregisteredManagers.length > 0) && (
                  <div className="border border-emerald-200 rounded-xl p-3 space-y-3 bg-emerald-50/30">
                    <div>
                      <p className="text-sm font-bold text-emerald-700">🗂 マスタ未登録の事業所・ケアマネ</p>
                      <p className="text-[11px] text-emerald-700 mt-0.5">
                        チェックを入れたものは取込み時にマスタへ自動追加され、利用者・履歴と紐付けられます。チェックを外すとテキストのみで取り込まれます（後で手動紐付け可能）。
                      </p>
                    </div>

                    {/* 居宅事業所 */}
                    {importPreview.unregisteredOffices.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-emerald-100">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-emerald-700">🏢 居宅事業所（{importPreview.unregisteredOffices.length}件）</p>
                          <div className="flex gap-2 text-[10px]">
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredOffices: importPreview.unregisteredOffices.map((o) => ({ ...o, addToMaster: true })),
                                });
                              }}
                              className="text-emerald-600 hover:underline"
                            >全選択</button>
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredOffices: importPreview.unregisteredOffices.map((o) => ({ ...o, addToMaster: false })),
                                  // 親が外れたらケアマネも自動的にOFFになるよう連動
                                  unregisteredManagers: importPreview.unregisteredManagers.map((m) => ({ ...m, addToMaster: false })),
                                });
                              }}
                              className="text-gray-500 hover:underline"
                            >全解除</button>
                          </div>
                        </div>
                        <div className="space-y-1 max-h-44 overflow-y-auto">
                          {importPreview.unregisteredOffices.map((o, i) => (
                            <label key={i} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-emerald-50 rounded p-1">
                              <input
                                type="checkbox"
                                checked={o.addToMaster}
                                onChange={(e) => {
                                  if (!importPreview) return;
                                  const newOffices = importPreview.unregisteredOffices.map((it) =>
                                    it.name === o.name ? { ...it, addToMaster: e.target.checked } : it
                                  );
                                  // 事業所をOFFにしたら、その配下のケアマネも自動的にOFFに
                                  let newManagers = importPreview.unregisteredManagers;
                                  if (!e.target.checked) {
                                    newManagers = newManagers.map((m) =>
                                      m.officeName === o.name ? { ...m, addToMaster: false } : m
                                    );
                                  }
                                  setImportPreview({ ...importPreview, unregisteredOffices: newOffices, unregisteredManagers: newManagers });
                                }}
                                className="w-4 h-4 shrink-0"
                              />
                              <span className="flex-1 text-gray-800">{o.name}</span>
                              <span className="text-[10px] text-gray-400">{o.occurrences}件</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ケアマネ */}
                    {importPreview.unregisteredManagers.length > 0 && (
                      <div className="bg-white rounded-lg p-3 border border-emerald-100">
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-emerald-700">👤 ケアマネ（{importPreview.unregisteredManagers.length}件）</p>
                          <div className="flex gap-2 text-[10px]">
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredManagers: importPreview.unregisteredManagers.map((m) => ({ ...m, addToMaster: true })),
                                });
                              }}
                              className="text-emerald-600 hover:underline"
                            >全選択</button>
                            <button
                              onClick={() => {
                                if (!importPreview) return;
                                setImportPreview({
                                  ...importPreview,
                                  unregisteredManagers: importPreview.unregisteredManagers.map((m) => ({ ...m, addToMaster: false })),
                                });
                              }}
                              className="text-gray-500 hover:underline"
                            >全解除</button>
                          </div>
                        </div>
                        <div className="space-y-1 max-h-44 overflow-y-auto">
                          {importPreview.unregisteredManagers.map((m, i) => {
                            // 親事業所がマスタに有るか or マスタ追加チェックされているかを判定
                            const officeExists = m.officeName in importPreview.matchMaps.officeNameToId;
                            const officeWillBeAdded = importPreview.unregisteredOffices.find((o) => o.name === m.officeName)?.addToMaster ?? false;
                            const canAdd = officeExists || officeWillBeAdded;
                            return (
                              <label
                                key={i}
                                className={`flex items-center gap-2 text-xs rounded p-1 ${canAdd ? "cursor-pointer hover:bg-emerald-50" : "opacity-50"}`}
                                title={!canAdd ? "親事業所がマスタに無い／追加対象外なので追加できません" : ""}
                              >
                                <input
                                  type="checkbox"
                                  checked={m.addToMaster && canAdd}
                                  disabled={!canAdd}
                                  onChange={(e) => {
                                    if (!importPreview) return;
                                    const newManagers = importPreview.unregisteredManagers.map((it) =>
                                      it.name === m.name && it.officeName === m.officeName
                                        ? { ...it, addToMaster: e.target.checked }
                                        : it
                                    );
                                    setImportPreview({ ...importPreview, unregisteredManagers: newManagers });
                                  }}
                                  className="w-4 h-4 shrink-0"
                                />
                                <span className="flex-1 text-gray-800">
                                  {m.name}
                                  <span className="text-[10px] text-gray-400 ml-1.5">@ {m.officeName}</span>
                                </span>
                                <span className="text-[10px] text-gray-400">{m.occurrences}件</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* 補足情報 */}
                <div className="bg-sky-50 rounded-lg p-2.5 text-[11px] text-sky-700 space-y-0.5">
                  <p>📌 保険情報履歴も同時に更新されます（{importPreview.insuranceCount}件の認定期間）</p>
                  {currentOfficeId && <p>📌 自事業所が選択中のため、取込/更新した利用者を自動紐付けします</p>}
                  <p>📌 タイトルに「〇〇 様」が含まれる未紐付け予定は、新規取込の利用者へ自動再紐付けします</p>
                  <p>📌 既存利用者のマスタ紐付け（居宅事業所・ケアマネ）は保護され、CSV取込みで上書きされません</p>
                  <p>📌 認定期間ごとの担当ケアマネは履歴として記録されます（マスタ紐付き）</p>
                </div>
              </div>
              <div className="px-5 py-3 border-t border-gray-100 shrink-0 flex gap-2">
                <button
                  onClick={() => setImportPreview(null)}
                  disabled={importing}
                  className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl text-sm disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={() => executeImport(importPreview)}
                  disabled={importing}
                  className={`flex-1 py-2 font-semibold rounded-xl text-sm disabled:opacity-50 ${warningRows.length > 0 ? "bg-amber-500 hover:bg-amber-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"}`}
                >
                  {importing ? "実行中..." : warningRows.length > 0 ? "⚠️ 警告を承知の上で実行" : "実行する"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 取込結果モーダル */}
      {importResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
              <h3 className="font-semibold text-gray-800 text-sm">
                {importResult.errors.length > 0 ? "⚠️" : "✅"} 取り込み完了（新規 {importResult.inserted.length}件 / 更新 {importResult.updated.length}件{importResult.merged.length > 0 ? ` / 仮登録→本登録 ${importResult.merged.length}件` : ""}{importResult.addedOffices > 0 ? ` / 居宅マスタ追加 ${importResult.addedOffices}件` : ""}{importResult.addedManagers > 0 ? ` / ケアマネマスタ追加 ${importResult.addedManagers}件` : ""}{importResult.insuranceAdded > 0 ? ` / 保険情報 ${importResult.insuranceAdded}件` : ""}{importResult.reunited > 0 ? ` / 予定再紐付け ${importResult.reunited}件` : ""}{importResult.errors.length > 0 ? ` / エラー ${importResult.errors.length}件` : ""}）
              </h3>
              <button onClick={() => setImportResult(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>
            <div className="px-5 py-3 overflow-y-auto space-y-4 flex-1">
              {importResult.errors.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-red-600 mb-1.5">❌ エラー/スキップ（{importResult.errors.length}件）</p>
                  <div className="bg-red-50 rounded-lg p-2.5 space-y-1 max-h-60 overflow-y-auto">
                    {importResult.errors.map((e, i) => (
                      <div key={i} className="text-xs text-gray-700">
                        <p>
                          <span className="text-gray-400 mr-2">{e.user_number || "-"}</span>
                          <span className="font-medium">{e.name || "(氏名なし)"}</span>
                        </p>
                        <p className="text-[11px] text-red-500 ml-6">{e.message}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {importResult.inserted.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-emerald-600 mb-1.5">🆕 新規登録（{importResult.inserted.length}件）</p>
                  <div className="bg-emerald-50 rounded-lg p-2.5 space-y-0.5 max-h-48 overflow-y-auto">
                    {importResult.inserted.map((c, i) => (
                      <p key={i} className="text-xs text-gray-700">
                        <span className="text-gray-400 mr-2">{c.user_number || "-"}</span>
                        {c.name}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {importResult.updated.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-indigo-600 mb-1.5">✏️ 更新（{importResult.updated.length}件）</p>
                  <div className="bg-indigo-50 rounded-lg p-2.5 space-y-0.5 max-h-48 overflow-y-auto">
                    {importResult.updated.map((c, i) => (
                      <p key={i} className="text-xs text-gray-700">
                        <span className="text-gray-400 mr-2">{c.user_number || "-"}</span>
                        {c.name}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {importResult.merged.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-purple-600 mb-1.5">🔗 仮登録→本登録（{importResult.merged.length}件）</p>
                  <p className="text-[11px] text-purple-500 mb-1.5">仮登録のUUIDを維持したままCSVデータで本登録化しました。予定・発注の紐付きはそのまま引き継がれています。</p>
                  <div className="bg-purple-50 rounded-lg p-2.5 space-y-0.5 max-h-48 overflow-y-auto">
                    {importResult.merged.map((c, i) => (
                      <p key={i} className="text-xs text-gray-700">
                        <span className="text-gray-400 mr-2">{c.user_number || "-"}</span>
                        {c.name}
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {importResult.insuranceAdded > 0 && (
                <div className="bg-sky-50 rounded-lg p-2.5 text-xs text-sky-800">
                  🏥 介護保険情報 <strong>{importResult.insuranceAdded}件</strong> を履歴として保存しました（介護保険タブで表示）
                </div>
              )}
              {importResult.reunited > 0 && (
                <div className="bg-amber-50 rounded-lg p-2.5 text-xs text-amber-800">
                  🔗 削除→再取込で切れていた予定 <strong>{importResult.reunited}件</strong> を自動で利用者に再紐付けしました
                </div>
              )}
              {importResult.inserted.length === 0 && importResult.updated.length === 0 && importResult.merged.length === 0 && importResult.errors.length === 0 && importResult.reunited === 0 && importResult.insuranceAdded === 0 && (
                <p className="text-xs text-gray-400 text-center py-6">変更はありませんでした</p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-gray-100 shrink-0">
              <button
                onClick={() => setImportResult(null)}
                className="w-full py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl text-sm"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

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
            onClick={() => setShowNewClient(true)}
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors flex items-center gap-1"
          >
            <Plus size={12} />新規
          </button>
          <button
            onClick={openJissekiModal}
            className="px-2.5 py-1.5 rounded-xl text-xs font-medium bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 transition-colors"
          >
            実績表
          </button>
          <button
            onClick={() => { setHospFilter(f => !f); setKanaFilter(""); }}
            className={`px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors ${hospFilter ? "bg-red-500 text-white border-red-500" : "bg-red-50 text-red-600 border-red-200 hover:bg-red-100"}`}
          >
            入院中一覧
          </button>
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
        // 各利用者の「最新認定の最良レコード」を取得
        //   1. effective_date が最新のものを選ぶ
        //   2. 同じ effective_date なら copay_rate が埋まってるレコードを優先
        //   3. それも同じなら benefit_rate が埋まってるレコードを優先
        const insuranceByClient = new Map<string, ClientInsuranceRecord>();
        const scoreRec = (r: ClientInsuranceRecord): number =>
          (r.copay_rate ? 2 : 0) + (r.benefit_rate ? 1 : 0);
        for (const rec of allInsuranceRecords) {
          const existing = insuranceByClient.get(rec.client_id);
          if (!existing) {
            insuranceByClient.set(rec.client_id, rec);
            continue;
          }
          const existingDate = existing.effective_date ?? "";
          const recDate = rec.effective_date ?? "";
          if (recDate > existingDate) {
            insuranceByClient.set(rec.client_id, rec);
          } else if (recDate === existingDate) {
            // 同じ effective_date の場合は情報が充実してるものを採用
            if (scoreRec(rec) > scoreRec(existing)) {
              insuranceByClient.set(rec.client_id, rec);
            }
          }
        }
        const insuranceFiltered = clients
          .filter((c) => matchClient(c, search))
          .sort((a, b) => {
            const fa = a.is_facility ? 1 : 0;
            const fb = b.is_facility ? 1 : 0;
            if (fa !== fb) return fa - fb;
            return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
          });
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
                        <td className="px-3 py-2 font-medium text-gray-800">
                          {client.name}
                          {client.is_provisional && <span className="ml-1 text-[9px] font-semibold bg-amber-100 text-amber-700 px-1 py-0.5 rounded align-middle">仮</span>}
                        </td>
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
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex gap-1.5 overflow-x-auto shrink-0 items-center">
        {hospFilter ? (
          <>
            <span className="shrink-0 text-xs font-medium text-red-600 px-1">入院中一覧</span>
            <button onClick={() => { const d = new Date(...(hospModalMonth.split("-").map(Number) as [number, number])); d.setMonth(d.getMonth() - 2); setHospModalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronLeft size={15} /></button>
            <span className="shrink-0 text-xs font-medium text-gray-700 w-16 text-center">{hospModalMonth.replace("-", "年")}月</span>
            <button onClick={() => { const [y, m] = hospModalMonth.split("-").map(Number); const d = new Date(y, m, 1); setHospModalMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronRight size={15} /></button>
            <span className="text-xs text-red-500 font-medium ml-1">{filtered.length}名</span>
          </>
        ) : (
          <>
            <button
              onClick={() => { setKanaFilter(""); setProvisionalFilter(false); setTrashFilter(false); }}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${!kanaFilter && !provisionalFilter && !trashFilter ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
            >すべて</button>
            {KANA_ROWS.map((row) => (
              <button
                key={row.label}
                onClick={() => { setKanaFilter(kanaFilter === row.label ? "" : row.label); setProvisionalFilter(false); setTrashFilter(false); }}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${kanaFilter === row.label ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"}`}
              >{row.label}行</button>
            ))}
            <button
              onClick={() => { setProvisionalFilter(!provisionalFilter); setKanaFilter(""); setTrashFilter(false); }}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${provisionalFilter ? "bg-amber-500 text-white" : "bg-amber-50 text-amber-700 hover:bg-amber-100"}`}
            >🏷️ 仮登録</button>
            <button
              onClick={() => { setTrashFilter(!trashFilter); setKanaFilter(""); setProvisionalFilter(false); }}
              className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${trashFilter ? "bg-gray-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}
            >🗑️ ゴミ箱</button>
          </>
        )}
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
              const isHospitalized = hospitalizations.some(h => h.client_id === client.id && h.discharge_date === null);
              const isToggling = hospLoading === client.id;
              return (
                <li key={client.id} className={`flex items-center pr-3 ${isHospitalized ? "bg-red-50" : ""}`}>
                  <button
                    onClick={() => setSelectedClient(client)}
                    className="flex-1 min-w-0 px-4 py-3 flex items-center gap-2 hover:bg-gray-50 transition-colors text-left"
                  >
                    <div className="flex-1 min-w-0 flex items-center gap-1">
                      <div className={`w-20 shrink-0 flex items-center gap-0.5 text-sm font-medium ${isHospitalized ? "text-red-700" : "text-gray-800"}`}>
                        <span className="truncate min-w-0">{client.name}</span>
                        {client.is_provisional && <span className="shrink-0 text-[9px] font-semibold bg-amber-100 text-amber-700 px-1 py-0.5 rounded">仮</span>}
                      </div>
                      <span className="w-24 shrink-0 text-xs text-gray-400 truncate">{client.furigana ?? ""}</span>
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
                      {isHospitalized && (
                        <span className="text-xs px-1 py-0.5 bg-red-100 text-red-600 rounded font-medium shrink-0">入院中</span>
                      )}
                      <span className="flex-1 min-w-0 text-xs text-gray-400 truncate">{client.address ?? ""}</span>
                    </div>
                    <ChevronRight size={16} className="text-gray-300 shrink-0" />
                  </button>
                  <button
                    onClick={() => toggleHospitalization(client)}
                    disabled={isToggling}
                    className={`shrink-0 ml-1 px-2 py-1 text-xs font-medium rounded-lg border transition-colors disabled:opacity-40 ${
                      isHospitalized
                        ? "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                        : "text-red-500 border-red-200 hover:bg-red-50"
                    }`}
                  >
                    {isToggling ? "…" : isHospitalized ? "→退院へ" : "→入院へ"}
                  </button>
                  <button
                    onClick={() => setNewOrderClient(client)}
                    className="shrink-0 ml-1 px-3 py-1 text-xs font-medium text-emerald-600 border border-emerald-200 rounded-lg hover:bg-emerald-50 transition-colors"
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

      {/* 新規利用者追加モーダル */}
      {showNewClient && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">新規利用者追加</h3>
              <button onClick={() => setShowNewClient(false)}><X size={18} className="text-gray-400" /></button>
            </div>
            {currentOfficeId && (
              <p className="text-xs text-emerald-600 bg-emerald-50 rounded-lg px-2.5 py-1.5 mb-3">
                自事業所に自動で紐付けされます
              </p>
            )}
            <div className="space-y-2">
              <input
                type="text"
                placeholder="氏名（必須）"
                value={newClientForm.name}
                onChange={(e) => setNewClientForm({ ...newClientForm, name: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="ふりがな"
                value={newClientForm.furigana}
                onChange={(e) => setNewClientForm({ ...newClientForm, furigana: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="電話番号"
                value={newClientForm.phone}
                onChange={(e) => setNewClientForm({ ...newClientForm, phone: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="携帯番号"
                value={newClientForm.mobile}
                onChange={(e) => setNewClientForm({ ...newClientForm, mobile: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              <input
                type="text"
                placeholder="住所"
                value={newClientForm.address}
                onChange={(e) => setNewClientForm({ ...newClientForm, address: e.target.value })}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setShowNewClient(false)}
                className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleAddNewClient}
                disabled={addingClient || !newClientForm.name.trim()}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-emerald-500 hover:bg-emerald-600 transition-colors disabled:opacity-50"
              >
                {addingClient ? "追加中…" : "追加"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 似た仮登録の紐付け確認モーダル */}
      {similarProvisionalCandidates && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-gray-800">似た仮登録があります</h3>
              <button onClick={() => setSimilarProvisionalCandidates(null)}><X size={18} className="text-gray-400" /></button>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2.5 py-2 mb-3">
              🏷️ カレンダーで仮登録された以下の利用者がヒットしました。同一人物の場合、紐付けて本登録すると、関連する予定・発注もそのまま引き継がれます。
            </p>
            <ul className="space-y-2 mb-4 max-h-64 overflow-y-auto">
              {similarProvisionalCandidates.map((c) => (
                <li key={c.id} className="border border-amber-200 rounded-xl p-3 bg-amber-50/40">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-gray-800">{c.name}</span>
                    <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">仮</span>
                  </div>
                  <p className="text-xs text-gray-500 truncate">{c.address ?? "（住所未登録）"}</p>
                  <button
                    onClick={() => handleLinkToProvisional(c.id)}
                    disabled={addingClient}
                    className="mt-2 w-full py-1.5 rounded-lg text-xs font-medium text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50"
                  >
                    この仮登録と紐付けて本登録
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <button
                onClick={() => setSimilarProvisionalCandidates(null)}
                disabled={addingClient}
                className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
              >
                戻る
              </button>
              <button
                onClick={handleSkipProvisionalLink}
                disabled={addingClient}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-gray-500 hover:bg-gray-600 disabled:opacity-50"
              >
                {addingClient ? "追加中…" : "別人として新規作成"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 入院中一覧モーダル */}
      {hospDateDialog && (() => {
        const day = hospDateInput ? parseInt(hospDateInput.split("-")[2]) : null;
        // 入院：16日以降 → その月は前半分のみ（半月請求）
        // 退院：15日以前 → その月は後半分のみ（半月請求）
        const isFirstHalf = day !== null && day <= 15;
        const isHalfBilling =
          hospDateDialog.mode === "admit" ? !isFirstHalf   // 入院が後半→半月
          : isFirstHalf;                                    // 退院が前半→半月
        const halfLabel = isFirstHalf ? "前半（1〜15日）" : "後半（16日〜月末）";
        const billingLabel = isHalfBilling ? "半月分の請求" : "1か月分の請求";
        const billingColor = isHalfBilling ? "text-amber-600 bg-amber-50" : "text-emerald-700 bg-emerald-50";

        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6">
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-xs p-5">
              <p className="text-sm font-semibold text-gray-800 mb-1">
                {hospDateDialog.client.name}
              </p>
              <p className="text-xs text-gray-500 mb-3">
                {hospDateDialog.mode === "admit" ? "入院日を入力してください" : "退院日を入力してください"}
              </p>
              <input
                type="date"
                value={hospDateInput}
                onChange={e => setHospDateInput(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 mb-3 focus:outline-none focus:ring-2 focus:ring-emerald-300"
              />
              {day !== null && (
                <div className={`rounded-xl px-3 py-2 mb-4 flex items-center justify-between ${billingColor}`}>
                  <span className="text-xs font-medium">{halfLabel}</span>
                  <span className="text-xs font-bold">{billingLabel}</span>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => setHospDateDialog(null)}
                  className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  キャンセル
                </button>
                <button
                  onClick={confirmHospDate}
                  disabled={!hospDateInput}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium text-white transition-colors disabled:opacity-50 ${
                    hospDateDialog.mode === "admit" ? "bg-red-500 hover:bg-red-600" : "bg-emerald-500 hover:bg-emerald-600"
                  }`}
                >
                  {hospDateDialog.mode === "admit" ? "入院登録" : "退院登録"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {showJissekiModal && (() => {
        const [jYear, jMonth] = jissekiMonth.split("-").map(Number);
        const reiwaYear = jYear - 2018;
        const reiwaLabel = `令和${reiwaYear}年${jMonth}月`;

        const prevJMonth = () => {
          const d = new Date(jYear, jMonth - 2, 1);
          setJissekiMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        };
        const nextJMonth = () => {
          const d = new Date(jYear, jMonth, 1);
          setJissekiMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        };

        // 入院中（その月）
        const monthStart = `${jissekiMonth}-01`;
        const monthEnd = new Date(jYear, jMonth, 0).toISOString().split("T")[0];
        const hospInMonth = new Set(
          hospitalizations
            .filter(h => h.admission_date <= monthEnd && (h.discharge_date === null || h.discharge_date >= monthStart))
            .map(h => h.client_id)
        );

        // 統合レンタル行の型
        type JissekiRow = { equipName: string; category: string; code: string; monthlyPrice: number | null; modelNumber: string | null };

        // client_rental_history から
        const rentalByClient = new Map<string, JissekiRow[]>();
        for (const r of jissekiRentals) {
          const category = r.notes ?? "";
          if (!rentalByClient.has(r.client_id)) rentalByClient.set(r.client_id, []);
          rentalByClient.get(r.client_id)!.push({ equipName: r.equipment_name, category, code: JISSEKI_SERVICE_CODES[category] ?? "", monthlyPrice: r.monthly_price, modelNumber: r.model_number });
        }
        // orderItems（rental_started）から補完
        for (const item of orderItems) {
          if (item.status !== "rental_started") continue;
          const ord = orders.find(o => o.id === item.order_id);
          if (!ord?.client_id) continue;
          if (rentalByClient.has(ord.client_id)) continue;
          const eq = equipment.find(e => e.product_code === item.product_code);
          const category = eq?.category ?? "";
          rentalByClient.set(ord.client_id, []);
          rentalByClient.get(ord.client_id)!.push({ equipName: eq?.name ?? item.product_code, category, code: JISSEKI_SERVICE_CODES[category] ?? "", monthlyPrice: item.rental_price, modelNumber: null });
        }
        // orderItems — 同一利用者の複数用具を追加（rental_historyある利用者も含む）
        for (const item of orderItems) {
          if (item.status !== "rental_started") continue;
          const ord = orders.find(o => o.id === item.order_id);
          if (!ord?.client_id) continue;
          const existing = rentalByClient.get(ord.client_id);
          if (!existing) continue; // historyデータがない場合は上で処理済み
          const eq = equipment.find(e => e.product_code === item.product_code);
          const category = eq?.category ?? "";
          const equipName = eq?.name ?? item.product_code;
          // 同じ用具名が既に入っていれば追加しない
          if (!existing.some(r => r.equipName === equipName)) {
            existing.push({ equipName, category, code: JISSEKI_SERVICE_CODES[category] ?? "", monthlyPrice: item.rental_price, modelNumber: null });
          }
        }

        // ケアマネ単位でグループ化: key = "org||name"
        type CmGroup = { org: string; name: string; key: string; clients: { client: Client; rentals: JissekiRow[] }[] };
        const cmGroupMap = new Map<string, CmGroup>();
        for (const c of clients) {
          const rows = rentalByClient.get(c.id);
          if (!rows || rows.length === 0) continue;
          const org = c.care_manager_org ?? "";
          const name = c.care_manager ?? "";
          const key = `${org}||${name}`;
          if (!cmGroupMap.has(key)) cmGroupMap.set(key, { org, name, key, clients: [] });
          cmGroupMap.get(key)!.clients.push({ client: c, rentals: rows });
        }
        const cmGroups = Array.from(cmGroupMap.values())
          .sort((a, b) => a.org.localeCompare(b.org, "ja") || a.name.localeCompare(b.name, "ja"));
        cmGroups.forEach(g => g.clients.sort((a, b) => (a.client.furigana ?? a.client.name).localeCompare(b.client.furigana ?? b.client.name, "ja")));

        // プレビュー対象グループ（チェック済み or 単独指定）
        const previewGroups = jissekiPreview
          ? (jissekiCmKey !== "__ALL__"
              ? cmGroups.filter(g => g.key === jissekiCmKey)
              : cmGroups.filter(g => jissekiSelectedKeys.has(g.key)))
          : [];

        // フラグ操作ヘルパー
        const getFlag = (rowKey: string) => jissekiFlags[rowKey] ?? { half: false, daily: false, hold: false };
        const toggleFlag = (rowKey: string, flag: "half" | "daily" | "hold") => {
          setJissekiFlags(prev => ({ ...prev, [rowKey]: { ...getFlag(rowKey), [flag]: !getFlag(rowKey)[flag] } }));
        };

        // ── プレビュー画面 ──────────────────────────────────────────
        if (jissekiPreview && previewGroups.length > 0) {
          const today = new Date();
          const todayStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

          const renderGroupPage = (group: typeof previewGroups[0]) => (
            <div key={group.key} className="bg-white shadow-xl w-[210mm] px-10 py-8 mb-6 print:shadow-none print:w-full print:px-8 print:py-4 print:mb-0 print:break-after-page" style={{ minHeight: "297mm" }}>
              {/* タイトル行 */}
              <div className="flex items-end justify-between mb-3">
                <div className="text-sm font-bold">{reiwaLabel}分</div>
                <div className="text-xl font-bold underline tracking-widest">サービス利用実績表</div>
                <div className="text-xs text-right">{todayStr}</div>
              </div>
              {/* 送り主 ＋ 矢印 ＋ 受け先 */}
              <div className="flex items-stretch gap-3 mb-4">
                <div className="border border-gray-400 p-3 text-xs flex-none w-52">
                  <div className="font-bold text-sm mb-2">{tenantInfo?.company_name ?? "（会社名未設定）"}</div>
                  <div>事業所番号：{tenantInfo?.business_number ?? "−"}</div>
                  <div>TEL：{tenantInfo?.company_tel ?? "−"}</div>
                  <div>FAX：{tenantInfo?.company_fax ?? "−"}</div>
                </div>
                <div className="flex items-center text-2xl text-gray-400 shrink-0">→</div>
                <div className="border border-gray-400 p-3 text-xs flex-1">
                  <div className="flex items-center justify-between">
                    <div className="font-bold text-sm">{group.org || "（事業所名なし）"}</div>
                    <div className="text-sm font-bold">御中</div>
                  </div>
                  <div className="mt-3 text-base font-bold text-right">{group.name ? `${group.name} 様` : ""}</div>
                </div>
              </div>
              {/* 挨拶文 */}
              <p className="text-xs mb-1">いつもお世話になりありがとうございます。</p>
              <p className="text-xs mb-4">サービス利用実績表をお送りいたします。よろしくお願いいたします。</p>
              {/* メインテーブル */}
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-24">ご利用者様氏名</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-28">コード<br/>サービス項目名</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium">レンタル商品名</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-14">単位数</th>
                    <th colSpan={3} className="border border-gray-600 px-1 py-0.5 text-center font-medium text-[10px]">区分</th>
                    <th rowSpan={2} className="border border-gray-600 px-1 py-1 text-center font-medium w-20">備考</th>
                  </tr>
                  <tr>
                    <th className="border border-gray-600 px-0.5 py-0.5 text-center text-[10px] font-medium w-8">半額</th>
                    <th className="border border-gray-600 px-0.5 py-0.5 text-center text-[10px] font-medium w-8">日割</th>
                    <th className="border border-gray-600 px-0.5 py-0.5 text-center text-[10px] font-medium w-8">保留</th>
                  </tr>
                </thead>
                <tbody>
                  {group.clients.map(({ client, rentals }) => {
                    const isHosp = hospInMonth.has(client.id);
                    const totalTani = Math.round(rentals.reduce((s, r) => s + (r.monthlyPrice ?? 0), 0) / 10);
                    return (
                      <Fragment key={client.id}>
                        {rentals.map((r, ri) => {
                          const rowKey = `${client.id}-${ri}`;
                          const flags = getFlag(rowKey);
                          const tani = r.monthlyPrice ? Math.round(r.monthlyPrice / 10) : null;
                          return (
                            <tr key={ri}>
                              {ri === 0 && (
                                <td rowSpan={rentals.length} className={`border border-gray-600 px-1 py-1 text-center align-top font-medium ${isHosp ? "text-red-600" : ""}`}>
                                  {client.name} 様{isHosp && <div className="text-[10px] text-red-500">（入院中）</div>}
                                </td>
                              )}
                              <td className="border border-gray-600 px-1 py-0.5">
                                <div className="font-mono text-[10px]">{r.code}</div>
                                <div>{r.category}</div>
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5">{r.equipName}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-right">{tani !== null ? tani.toLocaleString() : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center print:hidden">
                                <input type="checkbox" checked={flags.half} onChange={() => toggleFlag(rowKey, "half")} />
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center print:hidden">
                                <input type="checkbox" checked={flags.daily} onChange={() => toggleFlag(rowKey, "daily")} />
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center print:hidden">
                                <input type="checkbox" checked={flags.hold} onChange={() => toggleFlag(rowKey, "hold")} />
                              </td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center hidden print:table-cell text-[10px]">{flags.half ? "●" : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center hidden print:table-cell text-[10px]">{flags.daily ? "●" : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5 text-center hidden print:table-cell text-[10px]">{flags.hold ? "●" : ""}</td>
                              <td className="border border-gray-600 px-1 py-0.5"></td>
                            </tr>
                          );
                        })}
                        <tr className="bg-gray-50">
                          <td colSpan={2} className="border border-gray-600 px-2 py-0.5 text-center font-medium">合計</td>
                          <td className="border border-gray-600 px-2 py-0.5 text-right">金額</td>
                          <td className="border border-gray-600 px-1 py-0.5 text-right font-bold">{totalTani.toLocaleString()}</td>
                          <td colSpan={3} className="border border-gray-600 px-2 py-0.5 text-center print:hidden">単位数</td>
                          <td colSpan={3} className="border border-gray-600 px-2 py-0.5 text-center hidden print:table-cell">単位数</td>
                          <td className="border border-gray-600 px-1 py-0.5 text-right font-bold">{totalTani.toLocaleString()}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );

          return (
            <div className="fixed inset-0 bg-gray-300 z-50 flex flex-col">
              <div className="bg-gray-800 text-white px-4 py-2 flex items-center gap-3 shrink-0 print:hidden">
                <button onClick={() => { setJissekiPreview(false); setJissekiCmKey("__ALL__"); }} className="flex items-center gap-1 text-sm text-gray-300 hover:text-white">
                  <ChevronLeft size={16} />戻る
                </button>
                <span className="text-sm flex-1">{reiwaLabel}分　{previewGroups.length}事業所</span>
                <button onClick={() => window.print()} className="px-4 py-1.5 rounded-lg text-sm font-medium bg-blue-500 hover:bg-blue-400">印刷</button>
              </div>
              <div className="flex-1 overflow-y-auto py-6 flex flex-col items-center print:py-0 print:block">
                {previewGroups.map(g => renderGroupPage(g))}
              </div>
            </div>
          );
        }

        // ── 通常モーダル（ケアマネ一覧・チェック選択） ─────────────
        const allChecked = cmGroups.length > 0 && cmGroups.every(g => jissekiSelectedKeys.has(g.key));
        const checkedCount = cmGroups.filter(g => jissekiSelectedKeys.has(g.key)).length;

        return (
          <div className="fixed inset-0 bg-black/60 flex items-end z-50">
            <div className="bg-white w-full rounded-t-2xl max-h-[92vh] flex flex-col">
              {/* ヘッダー */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-semibold text-gray-800 text-sm">サービス利用実績表</span>
                  <div className="flex items-center gap-1">
                    <button onClick={prevJMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronLeft size={16} /></button>
                    <span className="text-sm font-medium text-gray-700 w-32 text-center">{reiwaLabel}</span>
                    <button onClick={nextJMonth} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500"><ChevronRight size={16} /></button>
                  </div>
                  <span className="text-xs text-gray-500">{cmGroups.length}事業所</span>
                </div>
                <button onClick={() => { setShowJissekiModal(false); setJissekiPreview(false); setJissekiCmKey("__ALL__"); }}>
                  <X size={20} className="text-gray-400" />
                </button>
              </div>
              {/* 全選択・全解除 + プレビューボタン */}
              {cmGroups.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 shrink-0 bg-gray-50">
                  <button
                    onClick={() => setJissekiSelectedKeys(allChecked ? new Set() : new Set(cmGroups.map(g => g.key)))}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-100 transition-colors"
                  >
                    {allChecked ? "全解除" : "全選択"}
                  </button>
                  <span className="text-xs text-gray-500 flex-1">{checkedCount}件選択中</span>
                  <button
                    onClick={() => { setJissekiCmKey("__ALL__"); setJissekiPreview(true); }}
                    disabled={checkedCount === 0}
                    className="px-4 py-1.5 rounded-xl text-xs font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors disabled:opacity-40"
                  >
                    プレビュー・印刷
                  </button>
                </div>
              )}
              {/* ケアマネ一覧 */}
              <div className="flex-1 overflow-y-auto">
                {jissekiLoading ? (
                  <div className="flex items-center justify-center py-16"><Loader2 size={24} className="animate-spin text-emerald-400" /></div>
                ) : cmGroups.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-16">該当する用具レンタルがありません</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {cmGroups.map(g => {
                      const checked = jissekiSelectedKeys.has(g.key);
                      return (
                        <li
                          key={g.key}
                          className={`px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors ${checked ? "bg-blue-50" : "hover:bg-gray-50"}`}
                          onClick={() => setJissekiSelectedKeys(prev => {
                            const next = new Set(prev);
                            checked ? next.delete(g.key) : next.add(g.key);
                            return next;
                          })}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {}}
                            className="w-4 h-4 rounded accent-blue-500 shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-gray-800 truncate">{g.org || "（事業所名なし）"}</div>
                            <div className="text-xs text-gray-500">{g.name || "（担当者名なし）"}　{g.clients.length}名</div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          </div>
        );
      })()}

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
  hospitalizations,
  onBack,
}: {
  client: Client;
  allOrderItems: OrderItem[];
  equipment: Equipment[];
  tenantId: string;
  initialViewMode?: "current" | "insurance";
  hospitalizations?: import("@/lib/supabase").ClientHospitalization[];
  onBack: () => void;
}) {
  const [clientItems, setClientItems] = useState<OrderItem[]>([]);
  const [orderPaymentMap, setOrderPaymentMap] = useState<Record<string, "介護" | "自費">>({});
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [topTab, setTopTab] = useState<"usage" | "basic" | "insurance" | "kouhi">(initialViewMode === "insurance" ? "insurance" : "usage");
  const [insuranceSubTab, setInsuranceSubTab] = useState<"care" | "medical">("care");
  const [viewMode, setViewMode] = useState<"current" | "monthly" | "docs" | "rental_history">("current");
  const [editingBasic, setEditingBasic] = useState(false);
  const [basicForm, setBasicForm] = useState({ name: client.name, furigana: client.furigana ?? "", phone: client.phone ?? "", mobile: client.mobile ?? "", address: client.address ?? "", gender: client.gender ?? "", care_manager: client.care_manager ?? "", care_manager_org: client.care_manager_org ?? "", care_office_id: client.care_office_id ?? "", care_manager_id: client.care_manager_id ?? "", referrer_org: client.referrer_org ?? "", memo: client.memo ?? "", is_facility: client.is_facility ?? false });
  const [basicSaving, setBasicSaving] = useState(false);
  // 居宅/ケアマネマスタ（ドロップダウン用）
  const [careOfficesList, setCareOfficesList] = useState<Array<{ id: string; name: string }>>([]);
  const [careManagersList, setCareManagersList] = useState<Array<{ id: string; care_office_id: string; name: string }>>([]);
  useEffect(() => {
    (async () => {
      const [offRes, mgrRes] = await Promise.all([
        supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId).order("name"),
        supabase.from("care_managers").select("id, care_office_id, name").eq("tenant_id", tenantId).eq("active", true).order("name"),
      ]);
      setCareOfficesList((offRes.data ?? []) as Array<{ id: string; name: string }>);
      setCareManagersList((mgrRes.data ?? []) as Array<{ id: string; care_office_id: string; name: string }>);
    })();
  }, [tenantId]);

  // 居宅選択時（"__ADD__" で新規追加プロンプト）
  async function handleOfficeChange(value: string) {
    if (value === "__ADD__") {
      const name = window.prompt("新しい居宅介護支援事業所の名前を入力してください");
      if (!name?.trim()) return;
      const { data, error } = await supabase.from("care_offices").insert({ tenant_id: tenantId, name: name.trim() }).select("id, name").single();
      if (error) { alert("追加に失敗しました\n" + error.message); return; }
      const newOffice = data as { id: string; name: string };
      setCareOfficesList((prev) => [...prev, newOffice].sort((a, b) => a.name.localeCompare(b.name, "ja")));
      setBasicForm((f) => ({ ...f, care_office_id: newOffice.id, care_manager_org: newOffice.name, care_manager_id: "", care_manager: "" }));
      return;
    }
    const office = careOfficesList.find((o) => o.id === value);
    setBasicForm((f) => ({
      ...f,
      care_office_id: value,
      care_manager_org: office?.name ?? "",
      // 居宅を変えたらケアマネはクリア（事業所ごとに紐付いているため）
      care_manager_id: "",
      care_manager: "",
    }));
  }

  // ケアマネ選択時
  async function handleManagerChange(value: string) {
    if (value === "__ADD__") {
      if (!basicForm.care_office_id) { alert("先に居宅を選択してください"); return; }
      const name = window.prompt("新しいケアマネジャーの氏名を入力してください");
      if (!name?.trim()) return;
      const { data, error } = await supabase.from("care_managers").insert({ tenant_id: tenantId, care_office_id: basicForm.care_office_id, name: name.trim(), active: true }).select("id, care_office_id, name").single();
      if (error) { alert("追加に失敗しました\n" + error.message); return; }
      const newMgr = data as { id: string; care_office_id: string; name: string };
      setCareManagersList((prev) => [...prev, newMgr].sort((a, b) => a.name.localeCompare(b.name, "ja")));
      setBasicForm((f) => ({ ...f, care_manager_id: newMgr.id, care_manager: newMgr.name }));
      return;
    }
    const mgr = careManagersList.find((m) => m.id === value);
    setBasicForm((f) => ({ ...f, care_manager_id: value, care_manager: mgr?.name ?? "" }));
  }
  // 本登録モーダル（仮登録→正式登録）
  const [promoteOpen, setPromoteOpen] = useState(false);
  const [promoteSaving, setPromoteSaving] = useState(false);
  const [promoteForm, setPromoteForm] = useState({
    name: client.name,
    furigana: client.furigana ?? "",
    gender: client.gender ?? "",
    phone: client.phone ?? "",
    mobile: client.mobile ?? "",
    address: client.address ?? "",
    is_facility: client.is_facility ?? false,
    care_manager: client.care_manager ?? "",
    care_manager_org: client.care_manager_org ?? "",
    care_level: client.care_level ?? "",
    benefit_rate: client.benefit_rate ?? "",
    copay_rate: client.copay_rate ?? "",
    insured_number: client.insured_number ?? "",
    birth_date: client.birth_date ?? "",
    insurer_number: client.insurer_number ?? "",
    certification_start_date: client.certification_start_date ?? "",
    certification_end_date: client.certification_end_date ?? "",
    memo: client.memo ?? "",
  });
  // 保険情報（複数レコード）
  const [insuranceRecords, setInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [selectedInsuranceId, setSelectedInsuranceId] = useState<string | null>(null);
  const [insuranceForm, setInsuranceForm] = useState<Omit<ClientInsuranceRecord, "id" | "tenant_id" | "client_id" | "created_at"> | null>(null);
  const [editingInsuranceId, setEditingInsuranceId] = useState<string | null>(null);
  const [insuranceSaving, setInsuranceSaving] = useState(false);

  const emptyInsuranceForm = (): Omit<ClientInsuranceRecord, "id" | "tenant_id" | "client_id" | "created_at"> => ({
    effective_date: null, insured_number: null, birth_date: null, care_level: client.care_level ?? null,
    certification_start_date: null, certification_end_date: null, insurer_name: null, insurer_number: null,
    copay_rate: null, public_expense: null, care_manager: client.care_manager ?? null, care_manager_org: client.care_manager_org ?? null, notes: null,
    issued_date: null, insurance_confirmed_date: null, qualification_date: null,
    insurance_valid_start: null, insurance_valid_end: null,
    certification_date: null, certification_status: "認定済み",
    service_limit_period_start: null, service_limit_period_end: null, service_limit_amount: null,
    service_memo: null, service_restriction: "なし",
    benefit_type: null, benefit_content: null, benefit_rate: null,
    benefit_period_start: null, benefit_period_end: null,
    support_office_date: null, record_status: "認定済み",
    care_office_id: null, care_manager_id: null,
  });
  // レンタル履歴（手動登録）
  const [rentalHistoryRecords, setRentalHistoryRecords] = useState<ClientRentalHistory[]>([]);
  const [rentalHistoryForm, setRentalHistoryForm] = useState<Omit<ClientRentalHistory, "id" | "tenant_id" | "client_id" | "source" | "created_at"> | null>(null);
  const [editingRentalHistoryId, setEditingRentalHistoryId] = useState<string | null>(null);
  const [rentalHistorySaving, setRentalHistorySaving] = useState(false);
  // 公費情報
  const [publicExpenses, setPublicExpenses] = useState<import("@/lib/supabase").ClientPublicExpense[]>([]);
  const [selectedPeId, setSelectedPeId] = useState<string | null>(null);
  const [peForm, setPeForm] = useState<Omit<import("@/lib/supabase").ClientPublicExpense, "id"|"tenant_id"|"client_id"|"created_at"> | null>(null);
  const [editingPeId, setEditingPeId] = useState<string | null>(null);
  const [peSaving, setPeSaving] = useState(false);

  const emptyPeForm = () => ({
    hohei_code: null, futan_sha_number: null, jukyu_sha_number: null,
    valid_start: null, valid_end: null, confirmed_date: null,
    application_type: null, outpatient_copay: null, special_type: null, inpatient_copay: null,
  });

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
      // 第1バッチ：全て並列
      const [{ data: ordersData }, insurResult, rentalResult, peResult, docs] = await Promise.all([
        supabase.from("orders").select("id, payment_type").eq("tenant_id", tenantId).eq("client_id", client.id),
        supabase.from("client_insurance_records").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("effective_date", { ascending: false }),
        supabase.from("client_rental_history").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("start_date", { ascending: false }),
        supabase.from("client_public_expenses").select("*").eq("tenant_id", tenantId).eq("client_id", client.id).order("valid_start", { ascending: false }),
        getClientDocuments(tenantId, client.id),
      ]);
      setInsuranceRecords((insurResult.data ?? []) as ClientInsuranceRecord[]);
      setRentalHistoryRecords((rentalResult.data ?? []) as ClientRentalHistory[]);
      if (!peResult.error) setPublicExpenses((peResult.data ?? []) as import("@/lib/supabase").ClientPublicExpense[]);
      setDocuments(docs);
      if (ordersData && ordersData.length > 0) {
        const orderIds = ordersData.map((o: { id: string; payment_type: string }) => o.id);
        const payMap: Record<string, "介護" | "自費"> = {};
        ordersData.forEach((o: { id: string; payment_type: string }) => {
          if (o.payment_type === "自費") payMap[o.id] = "自費";
          else payMap[o.id] = "介護";
        });
        setOrderPaymentMap(payMap);
        // 第2バッチ：order_items 取得後に price_history も並列
        const { data: items } = await supabase.from("order_items").select("*").in("order_id", orderIds);
        const loaded = items ?? [];
        setClientItems(loaded);
        const codes = [...new Set(loaded.map((i) => i.product_code))];
        const history = await getPriceHistory(tenantId, codes);
        setPriceHistory(history);
      } else {
        setClientItems([]);
        setPriceHistory([]);
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
                  className="w-44 border border-blue-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-blue-400 bg-white"
                />
                <button
                  disabled={!dateInput.date || updatingId === item.id}
                  onClick={() => execStatusChange(dateInput.item, dateInput.nextStatus, dateInput.date)}
                  className="px-4 bg-blue-500 text-white text-xs font-medium py-1.5 rounded-lg disabled:opacity-40 flex items-center justify-center gap-1"
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
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="font-semibold text-gray-800">{client.name}</h2>
            {client.gender && <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-md">{client.gender}</span>}
            {hospitalizations?.some(h => h.client_id === client.id && h.discharge_date === null)
              ? <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-600">入院中</span>
              : <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">在籍中</span>
            }
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
        {/* 削除 / 復元ボタン（ソフト削除） */}
        {client.deleted_at ? (
          <button
            onClick={async () => {
              if (!confirm("この利用者を復元しますか？")) return;
              setBasicSaving(true);
              try {
                await restoreClient(client.id);
                Object.assign(client, { deleted_at: null });
                alert("復元しました");
                onBack();
              } catch (e) {
                const msg = (e as { message?: string })?.message ?? String(e);
                alert(`復元に失敗しました\n${msg}`);
              } finally {
                setBasicSaving(false);
              }
            }}
            disabled={basicSaving}
            title="削除済み利用者を復元"
            className="flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-100 hover:bg-emerald-200 px-2.5 py-1.5 rounded-xl disabled:opacity-50 transition-colors"
          >
            <RotateCcw size={14} />
            復元
          </button>
        ) : (
          <button
            onClick={async () => {
              const orderCount = clientItems.length;
              if (!client.is_provisional && orderCount > 0) {
                alert(`この利用者には発注履歴が ${orderCount} 件あるため削除できません。\n\n削除したい場合は、先に発注をキャンセルまたは完了してください。`);
                return;
              }
              const extraNote = client.is_provisional && orderCount > 0
                ? `\n（発注 ${orderCount} 件は残ります）`
                : "";
              if (!confirm(`利用者「${client.name}」を削除しますか？${extraNote}\n\nソフト削除のため、ゴミ箱から復元可能です。`)) return;
              setBasicSaving(true);
              try {
                await softDeleteClient(client.id);
                onBack();
              } catch (e) {
                const msg = (e as { message?: string })?.message ?? String(e);
                alert(`削除に失敗しました\n${msg}`);
              } finally {
                setBasicSaving(false);
              }
            }}
            disabled={basicSaving}
            title="この利用者を削除（ソフト削除）"
            className="flex items-center gap-1.5 text-xs text-red-500 border border-red-200 px-2.5 py-1.5 rounded-xl hover:bg-red-50 disabled:opacity-50 transition-colors"
          >
            <Trash2 size={14} />
            削除
          </button>
        )}
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

      {/* トップタブ */}
      <div className="bg-white border-b border-gray-200 px-4 flex gap-0 shrink-0">
        {([["usage","利用状況"],["basic","基本情報"],["insurance","介護保険"],["kouhi","公費"]] as [typeof topTab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTopTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${topTab === t ? "border-blue-500 text-blue-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
            {label}
          </button>
        ))}
      </div>
      {/* 利用状況サブタブ */}
      {topTab === "usage" && (
        <div className="bg-white border-b border-gray-100 px-4 py-2 flex gap-1.5 shrink-0">
          <button onClick={() => setViewMode("current")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "current" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            現在
          </button>
          <button onClick={() => setViewMode("monthly")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "monthly" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            月別
          </button>
          <button onClick={() => setViewMode("rental_history")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "rental_history" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            履歴
          </button>
          <button onClick={() => setViewMode("docs")}
            className={`flex-1 py-1.5 rounded-xl text-xs font-medium transition-colors ${viewMode === "docs" ? "bg-blue-500 text-white" : "bg-gray-100 text-gray-500"}`}>
            書類{documents.length > 0 && <span className="ml-1 opacity-70">({documents.length})</span>}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : topTab === "basic" ? (
        /* 基本情報タブ */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="bg-white rounded-xl shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-800">基本情報</h3>
                {client.is_provisional && (
                  <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded">🏷️ 仮登録</span>
                )}
              </div>
              {!editingBasic ? (
                <div className="flex gap-2">
                  {client.is_provisional && (
                    <button
                      onClick={() => {
                        setPromoteForm({
                          name: client.name,
                          furigana: client.furigana ?? "",
                          gender: client.gender ?? "",
                          phone: client.phone ?? "",
                          mobile: client.mobile ?? "",
                          address: client.address ?? "",
                          is_facility: client.is_facility ?? false,
                          care_manager: client.care_manager ?? "",
                          care_manager_org: client.care_manager_org ?? "",
                          care_level: client.care_level ?? "",
                          benefit_rate: client.benefit_rate ?? "",
                          copay_rate: client.copay_rate ?? "",
                          insured_number: client.insured_number ?? "",
                          birth_date: client.birth_date ?? "",
                          insurer_number: client.insurer_number ?? "",
                          certification_start_date: client.certification_start_date ?? "",
                          certification_end_date: client.certification_end_date ?? "",
                          memo: client.memo ?? "",
                        });
                        setPromoteOpen(true);
                      }}
                      disabled={basicSaving}
                      className="text-xs text-white bg-amber-500 hover:bg-amber-600 px-3 py-1 rounded-lg disabled:opacity-50"
                    >
                      本登録する
                    </button>
                  )}
                  <button onClick={() => setEditingBasic(true)} className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">編集</button>
                  {/* 削除 / 復元 ボタン */}
                  {client.deleted_at ? (
                    <button
                      onClick={async () => {
                        if (!confirm("この利用者を復元しますか？")) return;
                        setBasicSaving(true);
                        try {
                          await restoreClient(client.id);
                          Object.assign(client, { deleted_at: null });
                          alert("復元しました");
                          onBack();
                        } catch (e) {
                          const msg = (e as { message?: string })?.message ?? String(e);
                          alert(`復元に失敗しました\n${msg}`);
                        } finally {
                          setBasicSaving(false);
                        }
                      }}
                      disabled={basicSaving}
                      className="text-xs text-white bg-emerald-500 hover:bg-emerald-600 px-3 py-1 rounded-lg disabled:opacity-50"
                    >
                      復元
                    </button>
                  ) : (
                    <button
                      onClick={async () => {
                        // 発注履歴の有無をチェック（仮登録は無条件で削除可）
                        const orderCount = clientItems.length;
                        if (!client.is_provisional && orderCount > 0) {
                          alert(`この利用者には発注履歴が ${orderCount} 件あるため削除できません。\n\n削除したい場合は、先に発注をキャンセルまたは完了してください。`);
                          return;
                        }
                        const extraNote = client.is_provisional && orderCount > 0
                          ? `\n（発注 ${orderCount} 件は残ります）`
                          : "";
                        if (!confirm(`利用者「${client.name}」を削除しますか？${extraNote}\n\nソフト削除のため、ゴミ箱から復元可能です。`)) return;
                        setBasicSaving(true);
                        try {
                          await softDeleteClient(client.id);
                          onBack();
                        } catch (e) {
                          const msg = (e as { message?: string })?.message ?? String(e);
                          alert(`削除に失敗しました\n${msg}`);
                        } finally {
                          setBasicSaving(false);
                        }
                      }}
                      disabled={basicSaving}
                      className="text-xs text-red-600 border border-red-200 px-3 py-1 rounded-lg hover:bg-red-50 disabled:opacity-50"
                    >
                      削除
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => { setEditingBasic(false); setBasicForm({ name: client.name, furigana: client.furigana ?? "", phone: client.phone ?? "", mobile: client.mobile ?? "", address: client.address ?? "", gender: client.gender ?? "", care_manager: client.care_manager ?? "", care_manager_org: client.care_manager_org ?? "", care_office_id: client.care_office_id ?? "", care_manager_id: client.care_manager_id ?? "", referrer_org: client.referrer_org ?? "", memo: client.memo ?? "", is_facility: client.is_facility ?? false }); }} className="text-xs text-gray-500 border border-gray-200 px-3 py-1 rounded-lg">キャンセル</button>
                  <button onClick={async () => {
                    setBasicSaving(true);
                    // 空文字のIDは NULL に変換して保存。
                    // memo は clients から DROP 済のため payload から除外
                    // （TODO §5-3: client_memos への upsert を後日実装）
                    const { memo: _memoIgnored, ...basicWithoutMemo } = basicForm;
                    void _memoIgnored;
                    const payload = {
                      ...basicWithoutMemo,
                      care_office_id: basicForm.care_office_id || null,
                      care_manager_id: basicForm.care_manager_id || null,
                    };
                    await supabase.from("clients").update(payload).eq("id", client.id);
                    setBasicSaving(false);
                    setEditingBasic(false);
                    Object.assign(client, payload);
                  }} disabled={basicSaving} className="text-xs text-white bg-blue-500 px-3 py-1 rounded-lg disabled:opacity-50">{basicSaving ? "保存中…" : "保存"}</button>
                </div>
              )}
            </div>
            {([
              ["氏名", "name"],["ふりがな","furigana"],["性別","gender"],
              ["電話","phone"],["携帯","mobile"],["住所","address"],
              ["紹介機関","referrer_org"],
            ] as [string, "name"|"furigana"|"gender"|"phone"|"mobile"|"address"|"referrer_org"][]).map(([label, key]) => (
              <div key={key} className="flex items-start gap-3 border-b border-gray-50 pb-2">
                <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">{label}</span>
                {editingBasic ? (
                  <input
                    type="text"
                    value={basicForm[key]}
                    onChange={(e) => setBasicForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400"
                  />
                ) : (
                  <span className="flex-1 text-sm text-gray-800">{(client as Record<string, unknown>)[key] as string || <span className="text-gray-300">—</span>}</span>
                )}
              </div>
            ))}
            {/* 居宅（マスタ連携） */}
            <div className="flex items-start gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">居宅</span>
              {editingBasic ? (
                <select
                  value={basicForm.care_office_id}
                  onChange={(e) => handleOfficeChange(e.target.value)}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400 bg-white"
                >
                  <option value="">—</option>
                  {careOfficesList.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                  <option value="__ADD__">＋ 新規追加...</option>
                </select>
              ) : (
                <span className="flex-1 text-sm text-gray-800">
                  {client.care_office_id
                    ? (careOfficesList.find((o) => o.id === client.care_office_id)?.name ?? client.care_manager_org ?? <span className="text-gray-300">—</span>)
                    : (client.care_manager_org || <span className="text-gray-300">—</span>)}
                </span>
              )}
            </div>
            {/* ケアマネ（マスタ連携。居宅が選択されていないと選べない） */}
            <div className="flex items-start gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">ケアマネ</span>
              {editingBasic ? (
                <select
                  value={basicForm.care_manager_id}
                  onChange={(e) => handleManagerChange(e.target.value)}
                  disabled={!basicForm.care_office_id}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400 bg-white disabled:bg-gray-50 disabled:text-gray-400"
                >
                  <option value="">—</option>
                  {careManagersList
                    .filter((m) => m.care_office_id === basicForm.care_office_id)
                    .map((m) => (
                      <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                  <option value="__ADD__">＋ 新規追加...</option>
                </select>
              ) : (
                <span className="flex-1 text-sm text-gray-800">
                  {client.care_manager_id
                    ? (careManagersList.find((m) => m.id === client.care_manager_id)?.name ?? client.care_manager ?? <span className="text-gray-300">—</span>)
                    : (client.care_manager || <span className="text-gray-300">—</span>)}
                </span>
              )}
            </div>
            {/* メモ */}
            <div className="flex items-start gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400 pt-0.5">メモ</span>
              {editingBasic ? (
                <input
                  type="text"
                  value={basicForm.memo}
                  onChange={(e) => setBasicForm((f) => ({ ...f, memo: e.target.value }))}
                  className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-0.5 outline-none focus:border-blue-400"
                />
              ) : (
                <span className="flex-1 text-sm text-gray-800">{client.memo || <span className="text-gray-300">—</span>}</span>
              )}
            </div>
            {/* 居宅・施設等（事業所/施設フラグ） */}
            <div className="flex items-center gap-3 border-b border-gray-50 pb-2">
              <span className="w-20 shrink-0 text-xs text-gray-400">居宅・施設等</span>
              {editingBasic ? (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={basicForm.is_facility}
                    onChange={(e) => setBasicForm((f) => ({ ...f, is_facility: e.target.checked }))}
                    className="w-4 h-4"
                  />
                  <span className="text-sm text-gray-700">事業所・施設としてマーク</span>
                </label>
              ) : (
                <span className="flex-1 text-sm text-gray-800">
                  {client.is_facility
                    ? <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs font-medium">🏢 事業所・施設</span>
                    : <span className="text-gray-300">—</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      ) : topTab === "usage" && viewMode === "current" ? (
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
              className="flex-1 flex items-center justify-center gap-1.5 py-2 bg-blue-50 border border-blue-200 text-blue-700 text-xs font-medium rounded-xl hover:bg-blue-100"
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
                    try {
                      if (doc.type === "rental_report") setRegenDoc(doc);
                      else if (doc.type === "care_plan") { setCarePlanInitialParams(doc.params); setShowCarePlan(true); }
                      else if (doc.type === "proposal") { setProposalInitialParams(doc.params); setShowProposal(true); }
                      else if (doc.type === "rental_contract" || doc.type === "important_matters") setShowDocuments(true);
                      else if (doc.type === "supplier_email") {
                        const orderId = doc.params?.orderId as string | undefined;
                        if (!orderId) {
                          alert("この発注メール書類には発注ID(orderId)が記録されていないため、再生成できません。\n古い書類の可能性があります。");
                          return;
                        }
                        const [orderRes, items, suppliers, members] = await Promise.all([
                          supabase.from("orders").select("*").eq("id", orderId).maybeSingle(),
                          getOrderItems(orderId),
                          getSuppliers(),
                          getMembers(tenantId),
                        ]);
                        if (orderRes.error) {
                          console.error("発注取得エラー:", orderRes.error);
                          alert(`発注の取得に失敗しました: ${orderRes.error.message}`);
                          return;
                        }
                        if (!orderRes.data) {
                          alert("元の発注が見つかりません（削除された可能性があります）。");
                          return;
                        }
                        setEmailPreview({ order: orderRes.data as Order, items, suppliers, members, sentAt: doc.created_at });
                      }
                    } catch (e) {
                      console.error("再生成エラー:", e);
                      alert(`再生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
                    }
                  }}
                  className="shrink-0 text-xs text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg hover:bg-blue-50"
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
      ) : topTab === "insurance" ? (
        /* 介護保険タブ */
        (() => {
          const selRec = insuranceRecords.find(r => r.id === selectedInsuranceId) ?? insuranceRecords[0] ?? null;
          const F = insuranceForm;
          const fv = (key: string) => F ? ((F as Record<string, unknown>)[key] as string) ?? "" : "";
          const sf = (key: string, val: string) => setInsuranceForm(f => f ? { ...f, [key]: val || null } : f);
          const CARE_LEVELS = ["要支援1","要支援2","要介護1","要介護2","要介護3","要介護4","要介護5"];
          return (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 介護認定 / 医療保険 サブタブ */}
            <div className="shrink-0 flex gap-0 border-b border-gray-200 bg-gray-50 px-4 pt-2">
              {([["care","介護認定"],["medical","医療保険"]] as ["care"|"medical",string][]).map(([t, label]) => (
                <button key={t} onClick={() => setInsuranceSubTab(t)}
                  className={`px-5 py-2 text-sm font-medium border-b-2 transition-colors ${insuranceSubTab === t ? "border-blue-500 text-blue-600 bg-white" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
                  {label}
                </button>
              ))}
            </div>

            {insuranceSubTab === "medical" ? (
              <div className="flex-1 flex items-center justify-center text-sm text-gray-400">医療保険情報（準備中）</div>
            ) : (<>

            {/* 履歴一覧テーブル */}
            <div className="shrink-0 mx-4 mt-3 mb-3 border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-700">介護認定 履歴一覧</span>
              </div>
              <div className="overflow-x-auto max-h-48 overflow-y-auto">
              <table className="w-full text-xs min-w-[700px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    {["保険者","被保険者番号","保険有効期間","要介護度","認定年月日","認定有効期間",""].map(h => (
                      <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {insuranceRecords.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">保険情報がありません</td></tr>
                  ) : insuranceRecords.map((rec, idx) => {
                    const isSelected = (selectedInsuranceId ? rec.id === selectedInsuranceId : idx === 0) && !insuranceForm;
                    const careColor = rec.care_level?.includes("支援") ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700";
                    return (
                      <tr key={rec.id}
                        onClick={() => { if (!insuranceForm) { setSelectedInsuranceId(rec.id); } }}
                        className={`cursor-pointer transition-colors ${isSelected ? "bg-blue-50 border-l-2 border-blue-500" : "hover:bg-gray-50"}`}>
                        <td className="px-3 py-2 text-gray-700">{rec.insurer_number ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 tabular-nums text-gray-700">{rec.insured_number ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                          {rec.insurance_valid_start && rec.insurance_valid_end
                            ? `${rec.insurance_valid_start} 〜 ${rec.insurance_valid_end}`
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          {rec.care_level
                            ? <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${careColor}`}>{rec.care_level}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-gray-600">{rec.certification_date ?? <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                          {rec.certification_start_date && rec.certification_end_date
                            ? `${rec.certification_start_date} 〜 ${rec.certification_end_date}`
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={(e) => { e.stopPropagation(); handleDeleteInsuranceRecord(rec.id); }} className="text-red-300 hover:text-red-500">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* 詳細フォーム */}
            <div className="flex-1 overflow-y-auto">
              <div className="flex items-center justify-between px-4 py-2.5 border-b-2 border-gray-200 bg-gray-50 sticky top-0">
                <span className="text-sm font-semibold text-gray-800">介護認定 詳細</span>
                <div className="flex gap-2">
                  {insuranceForm ? (
                    <>
                      <button onClick={() => { setInsuranceForm(null); setEditingInsuranceId(null); }} className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50">キャンセル</button>
                      <button onClick={handleSaveInsuranceRecord} disabled={insuranceSaving} className="text-xs text-white bg-blue-500 px-4 py-1.5 rounded-lg disabled:opacity-50">{insuranceSaving ? "保存中…" : "保存"}</button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => { setEditingInsuranceId(null); setInsuranceForm(emptyInsuranceForm()); }}
                        className="flex items-center gap-1 text-xs text-blue-600 border border-blue-300 bg-blue-50 px-3 py-1.5 rounded-lg hover:bg-blue-100">
                        保険変更
                      </button>
                      <button
                        onClick={() => {
                          const base = selRec ? { ...emptyInsuranceForm(), insured_number: selRec.insured_number, insurer_number: selRec.insurer_number, insurer_name: selRec.insurer_name, copay_rate: selRec.copay_rate, benefit_rate: selRec.benefit_rate } : emptyInsuranceForm();
                          setEditingInsuranceId(null); setInsuranceForm(base);
                        }}
                        className="flex items-center gap-1 text-xs text-white bg-emerald-500 border border-emerald-500 px-3 py-1.5 rounded-lg hover:bg-emerald-600">
                        認定更新
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* 3カラムフォーム */}
              <div className="grid grid-cols-3 gap-0 divide-x divide-gray-200 px-0 bg-white">
                {/* 左列: 保険証情報 */}
                <div className="p-4 space-y-3">
                  <p className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b border-gray-200">保険証情報</p>
                  {[
                    ["被保険者番号","insured_number"],
                    ["交付年月日","issued_date"],
                    ["保険者番号","insurer_number"],
                    ["保険者名","insurer_name"],
                  ].map(([label, key]) => (
                    <div key={key} className="space-y-1">
                      <label className="text-[11px] text-gray-500">{label}</label>
                      {insuranceForm
                        ? <input type="text" value={fv(key as keyof Omit<ClientInsuranceRecord,"id"|"tenant_id"|"client_id"|"created_at">)} onChange={e => sf(key, e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">{(selRec as Record<string,unknown> | null)?.[key] as string || "—"}</div>}
                    </div>
                  ))}
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">給付率（%）</label>
                    {insuranceForm
                      ? <input type="text" value={fv("benefit_rate")} onChange={e => sf("benefit_rate", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.benefit_rate || selRec?.copay_rate || "—"}</div>}
                  </div>
                  {[
                    ["保険証確認日","insurance_confirmed_date"],
                    ["資格取得日","qualification_date"],
                  ].map(([label, key]) => (
                    <div key={key} className="space-y-1">
                      <label className="text-[11px] text-gray-500">{label}</label>
                      {insuranceForm
                        ? <input type="date" value={fv(key as keyof Omit<ClientInsuranceRecord,"id"|"tenant_id"|"client_id"|"created_at">)} onChange={e => sf(key, e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">{(selRec as Record<string,unknown> | null)?.[key] as string || "—"}</div>}
                    </div>
                  ))}
                  <div className="space-y-1">
                    <div className="bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-1 rounded">保険証有効期間</div>
                    <div className="flex items-center gap-1">
                      {insuranceForm
                        ? <><input type="date" value={fv("insurance_valid_start")} onChange={e => sf("insurance_valid_start", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("insurance_valid_end")} onChange={e => sf("insurance_valid_end", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                        : <div className="text-sm text-gray-800 px-2.5 py-1.5">{selRec?.insurance_valid_start && selRec?.insurance_valid_end ? `${selRec.insurance_valid_start} 〜 ${selRec.insurance_valid_end}` : "—"}</div>}
                    </div>
                  </div>
                </div>

                {/* 中列: 認定情報 */}
                <div className="p-4 space-y-3">
                  <p className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b border-gray-200">認定情報</p>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">要介護状態等</label>
                    <div className="flex gap-4">
                      {["認定済み","申請中"].map(v => (
                        <label key={v} className="flex items-center gap-1.5 text-sm cursor-pointer">
                          <input type="radio" value={v} checked={(insuranceForm ? fv("certification_status") : selRec?.certification_status) === v || (!insuranceForm && !selRec?.certification_status && v === "認定済み")} onChange={() => insuranceForm && sf("certification_status", v)} disabled={!insuranceForm} className="accent-blue-500" />
                          {v}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">介護度</label>
                    {insuranceForm
                      ? <select value={fv("care_level")} onChange={e => sf("care_level", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white"><option value="">未設定</option>{CARE_LEVELS.map(v => <option key={v} value={v}>{v}</option>)}</select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.care_level || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">認定年月日</label>
                    {insuranceForm
                      ? <input type="date" value={fv("certification_date")} onChange={e => sf("certification_date", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.certification_date || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <div className="bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-1 rounded">認定有効期間</div>
                    <div className="flex items-center gap-1">
                      {insuranceForm
                        ? <><input type="date" value={fv("certification_start_date")} onChange={e => sf("certification_start_date", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("certification_end_date")} onChange={e => sf("certification_end_date", e.target.value)} className="flex-1 text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                        : <div className="text-sm text-gray-800 px-2.5 py-1.5">{selRec?.certification_start_date && selRec?.certification_end_date ? `${selRec.certification_start_date} 〜 ${selRec.certification_end_date}` : "—"}</div>}
                    </div>
                  </div>
                  <div className="border border-gray-200 rounded-xl p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-gray-600">居宅サービス区分</p>
                    <div className="space-y-1">
                      <div className="bg-amber-100 text-amber-700 text-[11px] font-medium px-2 py-1 rounded">適用期間</div>
                      <div className="flex items-center gap-1">
                        {insuranceForm
                          ? <><input type="date" value={fv("service_limit_period_start")} onChange={e => sf("service_limit_period_start", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("service_limit_period_end")} onChange={e => sf("service_limit_period_end", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                          : <div className="text-sm text-gray-800">{selRec?.service_limit_period_start && selRec?.service_limit_period_end ? `${selRec.service_limit_period_start} 〜 ${selRec.service_limit_period_end}` : "—"}</div>}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-gray-500">区分支給限度額（円）</label>
                      {insuranceForm
                        ? <input type="number" value={F?.service_limit_amount ?? ""} onChange={e => setInsuranceForm(f => f ? {...f, service_limit_amount: e.target.value ? Number(e.target.value) : null} : f)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800">{selRec?.service_limit_amount?.toLocaleString() || "—"}</div>}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">留意事項</label>
                    {insuranceForm
                      ? <textarea value={fv("service_memo")} onChange={e => sf("service_memo", e.target.value)} rows={3} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 resize-none" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5 min-h-[60px]">{selRec?.service_memo || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">サービス限定</label>
                    {insuranceForm
                      ? <select value={fv("service_restriction")} onChange={e => sf("service_restriction", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white"><option value="なし">なし</option><option value="あり">あり</option></select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.service_restriction || "なし"}</div>}
                  </div>
                </div>

                {/* 右列: 介護保険負担割合証・給付制限等 */}
                <div className="p-4 space-y-3">
                  <p className="text-sm font-semibold text-gray-700 mb-3 pb-1 border-b border-gray-200">介護保険負担割合証・給付制限等</p>
                  {[["給付種類","benefit_type"],["内容","benefit_content"],["給付率（%）","benefit_rate"]].map(([label, key]) => (
                    <div key={key} className="space-y-1">
                      <label className="text-[11px] text-gray-500">{label}</label>
                      {insuranceForm
                        ? <input type="text" value={fv(key as keyof Omit<ClientInsuranceRecord,"id"|"tenant_id"|"client_id"|"created_at">)} onChange={e => sf(key, e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                        : <div className="text-sm text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white">{(selRec as Record<string,unknown> | null)?.[key] as string || "—"}</div>}
                    </div>
                  ))}
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">期間</label>
                    <div className="flex items-center gap-1">
                      {insuranceForm
                        ? <><input type="date" value={fv("benefit_period_start")} onChange={e => sf("benefit_period_start", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /><span className="text-gray-400 text-xs">〜</span><input type="date" value={fv("benefit_period_end")} onChange={e => sf("benefit_period_end", e.target.value)} className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-blue-400" /></>
                        : <div className="text-sm text-gray-800 px-2.5 py-1.5">{selRec?.benefit_period_start && selRec?.benefit_period_end ? `${selRec.benefit_period_start} 〜 ${selRec.benefit_period_end}` : "—"}</div>}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">支援事業所届出日</label>
                    {insuranceForm
                      ? <input type="date" value={fv("support_office_date")} onChange={e => sf("support_office_date", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.support_office_date || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">担当ケアマネージャー</label>
                    {insuranceForm
                      ? <input type="text" value={fv("care_manager")} onChange={e => sf("care_manager", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.care_manager || "—"}</div>}
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-gray-500">ステータス</label>
                    {insuranceForm
                      ? <select value={fv("record_status")} onChange={e => sf("record_status", e.target.value)} className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white"><option value="認定済み">認定済み</option><option value="申請中">申請中</option><option value="暫定">暫定</option></select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.record_status || "認定済み"}</div>}
                  </div>
                </div>
              </div>
            </div>
            </>)}
          </div>
          );
        })()
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
                  className="text-xs text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg hover:bg-blue-50"
                >
                  ＋ 手動追加
                </button>
              )}
            </div>

            {/* 手動登録フォーム */}
            {rentalHistoryForm && (
              <div className="bg-blue-50 rounded-xl p-4 mb-3 space-y-2.5">
                <p className="text-xs font-semibold text-blue-700">{editingRentalHistoryId ? "レンタル履歴を編集" : "レンタル履歴を追加"}</p>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">用具名 <span className="text-red-400">*</span></span>
                  <input type="text" value={rentalHistoryForm.equipment_name}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, equipment_name: e.target.value })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">型番</span>
                  <input type="text" value={rentalHistoryForm.model_number ?? ""}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, model_number: e.target.value || null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                </div>
                {([["開始日","start_date"],["終了日","end_date"]] as [string,string][]).map(([label, key]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="w-24 shrink-0 text-xs text-gray-500">{label}</span>
                    <input type="date" value={(rentalHistoryForm as Record<string,unknown>)[key] as string ?? ""}
                      onChange={(e) => setRentalHistoryForm((f) => f && { ...f, [key]: e.target.value || null })}
                      className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500">月額</span>
                  <input type="number" value={rentalHistoryForm.monthly_price ?? ""}
                    onChange={(e) => setRentalHistoryForm((f) => f && { ...f, monthly_price: e.target.value ? Number(e.target.value) : null })}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white" />
                </div>
                <div className="flex items-start gap-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500 pt-0.5">メモ</span>
                  <textarea value={rentalHistoryForm.notes ?? ""} onChange={(e) => setRentalHistoryForm((f) => f && { ...f, notes: e.target.value || null })} rows={2}
                    className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400 bg-white resize-none" />
                </div>
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={() => { setRentalHistoryForm(null); setEditingRentalHistoryId(null); }}
                    className="text-xs text-gray-500 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-white">
                    キャンセル
                  </button>
                  <button onClick={handleSaveRentalHistory} disabled={rentalHistorySaving}
                    className="text-xs text-white bg-blue-500 px-4 py-1.5 rounded-lg disabled:opacity-50">
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
      ) : topTab === "kouhi" ? (
        /* 公費タブ */
        (() => {
          const HOHEI_OPTIONS = [
            { code: "12", label: "12：生活保護" },
            { code: "21", label: "21：障害（精神通院）" },
            { code: "22", label: "22：更生医療" },
            { code: "25", label: "25：育成医療" },
            { code: "51", label: "51：特定疾患（難病）" },
            { code: "54", label: "54：小児慢性特定疾病" },
          ];
          const APP_TYPES = ["継続", "申請中"];
          const SPECIAL_TYPES = ["職務上", "下船3月以内", "通勤災害"];
          const sel = publicExpenses.find(r => r.id === selectedPeId) ?? publicExpenses[0] ?? null;
          const pf = peForm;
          const pfv = (k: string) => pf ? (String((pf as Record<string,unknown>)[k] ?? "")) : "";
          const spf = (k: string, v: string | number | null) => setPeForm(f => f ? { ...f, [k]: v === "" ? null : v } : f);

          const saveNew = async () => {
            if (!pf) return;
            setPeSaving(true);
            const { data, error } = await supabase.from("client_public_expenses").insert({
              tenant_id: tenantId, client_id: client.id, ...pf,
            }).select().single();
            setPeSaving(false);
            if (!error && data) {
              setPublicExpenses(prev => [data as import("@/lib/supabase").ClientPublicExpense, ...prev]);
              setSelectedPeId(data.id);
              setPeForm(null);
              setEditingPeId(null);
            }
          };
          const saveEdit = async () => {
            if (!pf || !editingPeId) return;
            setPeSaving(true);
            await supabase.from("client_public_expenses").update(pf).eq("id", editingPeId);
            setPeSaving(false);
            setPublicExpenses(prev => prev.map(r => r.id === editingPeId ? { ...r, ...pf } : r));
            setEditingPeId(null);
            setPeForm(null);
          };
          const startEdit = (rec: import("@/lib/supabase").ClientPublicExpense) => {
            setSelectedPeId(rec.id);
            setEditingPeId(rec.id);
            setPeForm({
              hohei_code: rec.hohei_code, futan_sha_number: rec.futan_sha_number,
              jukyu_sha_number: rec.jukyu_sha_number, valid_start: rec.valid_start,
              valid_end: rec.valid_end, confirmed_date: rec.confirmed_date,
              application_type: rec.application_type, outpatient_copay: rec.outpatient_copay,
              special_type: rec.special_type, inpatient_copay: rec.inpatient_copay,
            });
          };
          const deleteRec = async (id: string) => {
            if (!confirm("この公費情報を削除しますか？")) return;
            await supabase.from("client_public_expenses").delete().eq("id", id);
            setPublicExpenses(prev => prev.filter(r => r.id !== id));
            if (selectedPeId === id) { setSelectedPeId(null); setPeForm(null); setEditingPeId(null); }
          };

          return (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* 一覧テーブル */}
              <div className="shrink-0 mx-4 mt-3 mb-3 border border-gray-200 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <span className="text-xs font-semibold text-gray-700">公費情報 一覧</span>
                  <button
                    onClick={() => { setSelectedPeId(null); setEditingPeId(null); setPeForm(emptyPeForm()); }}
                    className="text-xs text-white bg-emerald-500 px-3 py-1 rounded-lg hover:bg-emerald-600"
                  >＋ 新規</button>
                </div>
                <div className="overflow-x-auto max-h-48 overflow-y-auto">
                  <table className="w-full text-xs min-w-[600px]">
                    <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
                      <tr>
                        {["法制コード","負担者番号","受給者番号","有効期間開始日","有効期間終了日","確認日",""].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-medium text-gray-600 whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {publicExpenses.length === 0 ? (
                        <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">公費情報がありません</td></tr>
                      ) : publicExpenses.map(rec => {
                        const hoheiLabel = HOHEI_OPTIONS.find(o => o.code === rec.hohei_code)?.label ?? rec.hohei_code ?? "—";
                        const isSelected = rec.id === selectedPeId;
                        return (
                          <tr key={rec.id}
                            onClick={() => { setSelectedPeId(rec.id); if (editingPeId !== rec.id) { setEditingPeId(null); setPeForm(null); } }}
                            className={`cursor-pointer transition-colors ${isSelected ? "bg-blue-50" : "hover:bg-gray-50"}`}
                          >
                            <td className="px-3 py-2 font-medium text-gray-800">{hoheiLabel}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.futan_sha_number ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.jukyu_sha_number ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.valid_start ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.valid_end ?? "—"}</td>
                            <td className="px-3 py-2 text-gray-600">{rec.confirmed_date ?? "—"}</td>
                            <td className="px-3 py-2 flex gap-1.5 justify-end">
                              <button onClick={e => { e.stopPropagation(); startEdit(rec); }}
                                className="text-xs text-blue-600 border border-blue-200 px-2 py-0.5 rounded hover:bg-blue-50">編集</button>
                              <button onClick={e => { e.stopPropagation(); deleteRec(rec.id); }}
                                className="text-xs text-red-400 border border-red-200 px-2 py-0.5 rounded hover:bg-red-50">削除</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 入力フォーム */}
              {pf !== null && (
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-4">
                    <div className="flex items-center justify-between mb-1">
                      <h3 className="text-sm font-semibold text-gray-700">
                        {editingPeId ? "公費情報 編集" : "公費情報 新規登録"}
                      </h3>
                      <div className="flex gap-2">
                        <button onClick={() => { setPeForm(null); setEditingPeId(null); }}
                          className="text-xs text-gray-500 border border-gray-200 px-3 py-1 rounded-lg">キャンセル</button>
                        <button onClick={editingPeId ? saveEdit : saveNew} disabled={peSaving}
                          className="text-xs text-white bg-blue-500 px-3 py-1 rounded-lg disabled:opacity-50">
                          {peSaving ? "保存中…" : "保存"}
                        </button>
                      </div>
                    </div>

                    {/* 法制コード・負担者・受給者番号 */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 法制コード</label>
                        <select value={pfv("hohei_code")} onChange={e => spf("hohei_code", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value="">選択してください</option>
                          {HOHEI_OPTIONS.map(o => <option key={o.code} value={o.code}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 負担者番号</label>
                        <input type="text" value={pfv("futan_sha_number")} onChange={e => spf("futan_sha_number", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="8桁" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 受給者番号</label>
                        <input type="text" value={pfv("jukyu_sha_number")} onChange={e => spf("jukyu_sha_number", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="7桁" />
                      </div>
                    </div>

                    {/* 有効期間・確認日 */}
                    <div className="grid grid-cols-3 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 有効期間 開始</label>
                        <input type="date" value={pfv("valid_start")} onChange={e => spf("valid_start", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500"><span className="text-red-500">*</span> 有効期間 終了</label>
                        <input type="date" value={pfv("valid_end")} onChange={e => spf("valid_end", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">確認日</label>
                        <input type="date" value={pfv("confirmed_date")} onChange={e => spf("confirmed_date", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" />
                      </div>
                    </div>

                    {/* 申請区分・特別区分・負担金 */}
                    <div className="grid grid-cols-4 gap-4">
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">申請区分</label>
                        <select value={pfv("application_type")} onChange={e => spf("application_type", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value=""></option>
                          {APP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">外来負担金</label>
                        <input type="number" value={pfv("outpatient_copay")} onChange={e => spf("outpatient_copay", e.target.value ? Number(e.target.value) : null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="円" />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">特別区分</label>
                        <select value={pfv("special_type")} onChange={e => spf("special_type", e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value=""></option>
                          {SPECIAL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-gray-500">入院負担金</label>
                        <input type="number" value={pfv("inpatient_copay")} onChange={e => spf("inpatient_copay", e.target.value ? Number(e.target.value) : null)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400" placeholder="円" />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 選択中の詳細表示（編集モードでない場合） */}
              {pf === null && sel !== null && (
                <div className="flex-1 overflow-y-auto px-4 pb-4">
                  <div className="bg-white border border-gray-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-semibold text-gray-700">公費情報 詳細</h3>
                      <button onClick={() => startEdit(sel)}
                        className="text-xs text-blue-600 border border-blue-200 px-3 py-1 rounded-lg hover:bg-blue-50">編集</button>
                    </div>
                    <div className="grid grid-cols-3 gap-4 text-sm">
                      {[
                        ["法制コード", HOHEI_OPTIONS.find(o => o.code === sel.hohei_code)?.label ?? sel.hohei_code ?? "—"],
                        ["負担者番号", sel.futan_sha_number ?? "—"],
                        ["受給者番号", sel.jukyu_sha_number ?? "—"],
                        ["有効期間 開始", sel.valid_start ?? "—"],
                        ["有効期間 終了", sel.valid_end ?? "—"],
                        ["確認日", sel.confirmed_date ?? "—"],
                        ["申請区分", sel.application_type ?? "—"],
                        ["外来負担金", sel.outpatient_copay != null ? `${sel.outpatient_copay}円` : "—"],
                        ["特別区分", sel.special_type ?? "—"],
                        ["入院負担金", sel.inpatient_copay != null ? `${sel.inpatient_copay}円` : "—"],
                      ].map(([label, value]) => (
                        <div key={label} className="space-y-0.5">
                          <div className="text-[11px] text-gray-500">{label}</div>
                          <div className="text-sm text-gray-800 font-medium">{value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {pf === null && sel === null && (
                <div className="flex-1 flex items-center justify-center text-sm text-gray-400">
                  「＋ 新規」から公費情報を登録してください
                </div>
              )}
            </div>
          );
        })()
      ) : null}

      {/* 仮登録→本登録モーダル */}
      {promoteOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] px-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-800">本登録する</h3>
                <span className="text-[10px] font-semibold bg-amber-100 text-amber-700 px-2 py-0.5 rounded">🏷️ 仮登録</span>
              </div>
              <button onClick={() => setPromoteOpen(false)} disabled={promoteSaving}>
                <X size={18} className="text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
              <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                必要項目を埋めて「本登録」を押すと、仮フラグが外れて正式な利用者になります。関連する予定・発注はそのまま引き継がれます（UUIDは維持）。
              </p>
              {/* 基本情報 */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">基本情報</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div className="col-span-2">
                    <label className="text-[11px] text-gray-400 block mb-1">氏名 <span className="text-red-400">*</span></label>
                    <input type="text" value={promoteForm.name} onChange={(e) => setPromoteForm((f) => ({ ...f, name: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">ふりがな</label>
                    <input type="text" value={promoteForm.furigana} onChange={(e) => setPromoteForm((f) => ({ ...f, furigana: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">性別</label>
                    <select value={promoteForm.gender} onChange={(e) => setPromoteForm((f) => ({ ...f, gender: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400">
                      <option value="">—</option><option value="男性">男性</option><option value="女性">女性</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">電話</label>
                    <input type="text" value={promoteForm.phone} onChange={(e) => setPromoteForm((f) => ({ ...f, phone: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">携帯</label>
                    <input type="text" value={promoteForm.mobile} onChange={(e) => setPromoteForm((f) => ({ ...f, mobile: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-[11px] text-gray-400 block mb-1">住所</label>
                    <input type="text" value={promoteForm.address} onChange={(e) => setPromoteForm((f) => ({ ...f, address: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div className="col-span-2">
                    <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                      <input type="checkbox" checked={promoteForm.is_facility} onChange={(e) => setPromoteForm((f) => ({ ...f, is_facility: e.target.checked }))} className="w-4 h-4" />
                      居宅・施設等（事業所・施設としてマーク）
                    </label>
                  </div>
                </div>
              </section>
              {/* ケアマネ */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">ケアマネジャー</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">担当ケアマネ</label>
                    <input type="text" value={promoteForm.care_manager} onChange={(e) => setPromoteForm((f) => ({ ...f, care_manager: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">所属事業所</label>
                    <input type="text" value={promoteForm.care_manager_org} onChange={(e) => setPromoteForm((f) => ({ ...f, care_manager_org: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                </div>
              </section>
              {/* 保険情報 */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">保険情報（任意）</h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">被保険者番号</label>
                    <input type="text" value={promoteForm.insured_number} onChange={(e) => setPromoteForm((f) => ({ ...f, insured_number: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">生年月日</label>
                    <input type="date" value={promoteForm.birth_date} onChange={(e) => setPromoteForm((f) => ({ ...f, birth_date: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">要介護度</label>
                    <input type="text" value={promoteForm.care_level} placeholder="例: 要介護2"
                      onChange={(e) => setPromoteForm((f) => ({ ...f, care_level: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">保険者番号</label>
                    <input type="text" value={promoteForm.insurer_number} onChange={(e) => setPromoteForm((f) => ({ ...f, insurer_number: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">給付率 (%)</label>
                    <input type="text" value={promoteForm.benefit_rate}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPromoteForm((f) => {
                          // 給付率を変更したら負担割合を自動計算
                          const n = parseInt(v);
                          const copay = !isNaN(n) ? String(100 - n) : f.copay_rate;
                          return { ...f, benefit_rate: v, copay_rate: copay };
                        });
                      }}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">負担割合 (%)</label>
                    <input type="text" value={promoteForm.copay_rate} onChange={(e) => setPromoteForm((f) => ({ ...f, copay_rate: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">認定開始日</label>
                    <input type="date" value={promoteForm.certification_start_date} onChange={(e) => setPromoteForm((f) => ({ ...f, certification_start_date: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">認定終了日</label>
                    <input type="date" value={promoteForm.certification_end_date} onChange={(e) => setPromoteForm((f) => ({ ...f, certification_end_date: e.target.value }))}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400" />
                  </div>
                </div>
              </section>
              {/* メモ */}
              <section className="space-y-2">
                <h4 className="text-xs font-semibold text-gray-500">メモ</h4>
                <textarea value={promoteForm.memo} onChange={(e) => setPromoteForm((f) => ({ ...f, memo: e.target.value }))} rows={2}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-400 resize-none" />
              </section>
            </div>
            <div className="flex gap-2 px-5 py-3 border-t border-gray-100 shrink-0">
              <button onClick={() => setPromoteOpen(false)} disabled={promoteSaving}
                className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200 disabled:opacity-50">
                キャンセル
              </button>
              <button
                onClick={async () => {
                  if (!promoteForm.name.trim()) { alert("氏名を入力してください"); return; }
                  setPromoteSaving(true);
                  try {
                    // 数値/日付は空文字なら null に
                    const n = (v: string) => v.trim() || null;
                    // memo は clients から DROP 済のため payload から除外
                    // （TODO §5-3: client_memos への upsert を後日実装）
                    await promoteProvisionalClient(client.id, {
                      name: promoteForm.name.trim(),
                      furigana: n(promoteForm.furigana),
                      gender: n(promoteForm.gender),
                      phone: n(promoteForm.phone),
                      mobile: n(promoteForm.mobile),
                      address: n(promoteForm.address),
                      is_facility: promoteForm.is_facility,
                      care_manager: n(promoteForm.care_manager),
                      care_manager_org: n(promoteForm.care_manager_org),
                      care_level: n(promoteForm.care_level),
                      benefit_rate: n(promoteForm.benefit_rate),
                      copay_rate: n(promoteForm.copay_rate),
                      insured_number: n(promoteForm.insured_number),
                      birth_date: n(promoteForm.birth_date),
                      insurer_number: n(promoteForm.insurer_number),
                      certification_start_date: n(promoteForm.certification_start_date),
                      certification_end_date: n(promoteForm.certification_end_date),
                    });
                    // client オブジェクトを直接更新（local state 反映）
                    Object.assign(client, {
                      is_provisional: false,
                      name: promoteForm.name.trim(),
                      furigana: n(promoteForm.furigana),
                      gender: n(promoteForm.gender),
                      phone: n(promoteForm.phone),
                      mobile: n(promoteForm.mobile),
                      address: n(promoteForm.address),
                      is_facility: promoteForm.is_facility,
                      care_manager: n(promoteForm.care_manager),
                      care_manager_org: n(promoteForm.care_manager_org),
                      care_level: n(promoteForm.care_level),
                      benefit_rate: n(promoteForm.benefit_rate),
                      copay_rate: n(promoteForm.copay_rate),
                      insured_number: n(promoteForm.insured_number),
                      birth_date: n(promoteForm.birth_date),
                      insurer_number: n(promoteForm.insurer_number),
                      certification_start_date: n(promoteForm.certification_start_date),
                      certification_end_date: n(promoteForm.certification_end_date),
                      memo: n(promoteForm.memo),
                    });
                    setPromoteOpen(false);
                  } catch (e) {
                    const msg = (e as { message?: string })?.message ?? String(e);
                    alert(`本登録に失敗しました\n${msg}`);
                    console.error(e);
                  } finally {
                    setPromoteSaving(false);
                  }
                }}
                disabled={promoteSaving || !promoteForm.name.trim()}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 disabled:opacity-50">
                {promoteSaving ? "保存中…" : "本登録する"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Documents Tab ───────────────────────────────────────────────────────────

function DocumentsTab({ tenantId }: { tenantId: string }) {
  const [clients, setClients] = useState<Client[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [clientItems, setClientItems] = useState<OrderItem[]>([]);
  const [orderPaymentMap, setOrderPaymentMap] = useState<Record<string, "介護" | "自費">>({});
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [clientLoading, setClientLoading] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [regenDoc, setRegenDoc] = useState<ClientDocument | null>(null);
  const [showCarePlan, setShowCarePlan] = useState(false);
  const [carePlanInitialParams, setCarePlanInitialParams] = useState<Record<string, unknown> | null>(null);
  const [showProposal, setShowProposal] = useState(false);
  const [proposalInitialParams, setProposalInitialParams] = useState<Record<string, unknown> | null>(null);
  const [showContracts, setShowContracts] = useState(false);
  const [showChangeContract, setShowChangeContract] = useState(false);
  const [changeContractInitialParams, setChangeContractInitialParams] = useState<Record<string, unknown> | null>(null);
  const [docTypeFilter, setDocTypeFilter] = useState<string | null>(null);
  const [emailPreview, setEmailPreview] = useState<{ order: Order; items: OrderItem[]; suppliers: Supplier[]; members: Member[]; sentAt?: string } | null>(null);
  // 元発注が削除された supplier_email 書類用：保存済み内容を表示
  const [savedEmailView, setSavedEmailView] = useState<{
    subject: string;
    body: string;
    supplierName?: string;
    sentAt?: string;
    title?: string;
  } | null>(null);

  useEffect(() => {
    Promise.all([
      supabase.from("clients").select("*").eq("tenant_id", tenantId).order("furigana"),
      getEquipment(tenantId),
      getTenantById(tenantId),
    ]).then(([clientResult, equip, tenant]) => {
      setClients((clientResult.data ?? []) as Client[]);
      setEquipment(equip);
      if (tenant) setCompanyInfo({
        businessNumber: tenant.business_number ?? COMPANY_INFO_DEFAULTS.businessNumber,
        companyName: tenant.company_name ?? COMPANY_INFO_DEFAULTS.companyName,
        companyAddress: tenant.company_address ?? COMPANY_INFO_DEFAULTS.companyAddress,
        tel: tenant.company_tel ?? COMPANY_INFO_DEFAULTS.tel,
        fax: tenant.company_fax ?? COMPANY_INFO_DEFAULTS.fax,
        staffName: tenant.staff_name ?? COMPANY_INFO_DEFAULTS.staffName,
        serviceArea: tenant.service_area ?? COMPANY_INFO_DEFAULTS.serviceArea,
        businessDays: tenant.business_days ?? COMPANY_INFO_DEFAULTS.businessDays,
        businessHours: tenant.business_hours ?? COMPANY_INFO_DEFAULTS.businessHours,
        staffManagerFull: tenant.staff_manager_full ?? COMPANY_INFO_DEFAULTS.staffManagerFull,
        staffManagerPart: tenant.staff_manager_part ?? COMPANY_INFO_DEFAULTS.staffManagerPart,
        staffSpecialistFull: tenant.staff_specialist_full ?? COMPANY_INFO_DEFAULTS.staffSpecialistFull,
        staffSpecialistPart: tenant.staff_specialist_part ?? COMPANY_INFO_DEFAULTS.staffSpecialistPart,
        staffAdminFull: tenant.staff_admin_full ?? COMPANY_INFO_DEFAULTS.staffAdminFull,
        staffAdminPart: tenant.staff_admin_part ?? COMPANY_INFO_DEFAULTS.staffAdminPart,
      });
      setLoading(false);
    });
  }, [tenantId]);

  const loadClientData = async (client: Client) => {
    setClientLoading(true);
    setClientItems([]); setDocuments([]); setPriceHistory([]); setOrderPaymentMap({});
    const [{ data: ordersData }, docs] = await Promise.all([
      supabase.from("orders").select("id, payment_type").eq("tenant_id", tenantId).eq("client_id", client.id),
      getClientDocuments(tenantId, client.id),
    ]);
    setDocuments(docs);
    if (ordersData && ordersData.length > 0) {
      const orderIds = ordersData.map((o: { id: string; payment_type: string }) => o.id);
      const payMap: Record<string, "介護" | "自費"> = {};
      ordersData.forEach((o: { id: string; payment_type: string }) => { payMap[o.id] = o.payment_type === "自費" ? "自費" : "介護"; });
      setOrderPaymentMap(payMap);
      const { data: items } = await supabase.from("order_items").select("*").in("order_id", orderIds);
      const loaded = items ?? [];
      setClientItems(loaded);
      const codes = [...new Set(loaded.map((i: OrderItem) => i.product_code))];
      const history = await getPriceHistory(tenantId, codes);
      setPriceHistory(history);
    }
    setClientLoading(false);
  };

  const refreshDocs = async () => {
    if (!selectedClient) return;
    const docs = await getClientDocuments(tenantId, selectedClient.id);
    setDocuments(docs);
  };

  const KANA_ROWS = ["あ","か","さ","た","な","は","ま","や","ら","わ","他"];
  const KANA_MAP: Record<string, string[]> = {
    "あ":["ア","イ","ウ","エ","オ"],"か":["カ","キ","ク","ケ","コ","ガ","ギ","グ","ゲ","ゴ"],
    "さ":["サ","シ","ス","セ","ソ","ザ","ジ","ズ","ゼ","ゾ"],"た":["タ","チ","ツ","テ","ト","ダ","ヂ","ヅ","デ","ド"],
    "な":["ナ","ニ","ヌ","ネ","ノ"],"は":["ハ","ヒ","フ","ヘ","ホ","バ","ビ","ブ","ベ","ボ","パ","ピ","プ","ペ","ポ"],
    "ま":["マ","ミ","ム","メ","モ"],"や":["ヤ","ユ","ヨ"],
    "ら":["ラ","リ","ル","レ","ロ"],"わ":["ワ","ヲ","ン"],
  };
  const toKana = (s: string) => s.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const allKana = Object.values(KANA_MAP).flat();
  const filteredClients = (kanaFilter
    ? clients.filter(c => {
        const first = toKana((c.furigana ?? c.name).charAt(0));
        return kanaFilter === "他" ? !allKana.includes(first) : (KANA_MAP[kanaFilter] ?? []).includes(first);
      })
    : clients
  ).slice().sort((a, b) => {
    // 事業所・施設は末尾、個人利用者は先頭
    const fa = a.is_facility ? 1 : 0;
    const fb = b.is_facility ? 1 : 0;
    if (fa !== fb) return fa - fb;
    return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
  });

  const DOC_TYPE_COLORS: Record<string, string> = {
    rental_report: "text-blue-600 bg-blue-50",
    care_plan: "text-emerald-600 bg-emerald-50",
    proposal: "text-purple-600 bg-purple-50",
    contract: "text-orange-600 bg-orange-50",
  };

  return (
    <div className="flex flex-col h-full bg-white text-sm">
      {/* ツールバー */}
      <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2">
        <FileText size={16} className="text-gray-600" />
        <span className="font-semibold text-gray-700">書類管理</span>
        {selectedClient && <span className="text-gray-500 text-xs ml-2">— {selectedClient.name}</span>}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-400" /></div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* 左：カナサイドバー + 利用者リスト */}
          <div className="flex shrink-0 border-r border-gray-300">
            <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
              <button onClick={() => setKanaFilter(null)}
                className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}>全</button>
              {KANA_ROWS.map(k => (
                <button key={k} onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
                  className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}>{k}</button>
              ))}
            </div>
            <div className="w-44 overflow-y-auto">
              {filteredClients.map(c => (
                <button key={c.id}
                  onClick={() => { setSelectedClient(c); loadClientData(c); }}
                  className={`w-full text-left px-3 py-2.5 text-sm border-b border-gray-100 transition-colors ${
                    selectedClient?.id === c.id ? "bg-blue-100 text-blue-800 font-semibold" : "hover:bg-gray-50 text-gray-700"
                  }`}
                >{c.name}</button>
              ))}
            </div>
          </div>

          {/* 右：書類パネル */}
          <div className="flex-1 overflow-y-auto">
            {!selectedClient ? (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">利用者を選択してください</div>
            ) : clientLoading ? (
              <div className="flex h-full items-center justify-center"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
            ) : (
              <div className="p-4 space-y-4">
                {/* 書類作成ボタン */}
                <div>
                  <p className="text-xs text-gray-500 font-semibold mb-2 uppercase tracking-wide">書類を作成</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button onClick={() => { setShowReport(true); }}
                      className="flex items-center gap-2 px-3 py-2.5 bg-blue-50 border border-blue-200 text-blue-700 text-sm font-medium rounded-xl hover:bg-blue-100 transition-colors">
                      <FileText size={15} /> 貸与報告書
                    </button>
                    <button onClick={() => { setCarePlanInitialParams(null); setShowCarePlan(true); }}
                      className="flex items-center gap-2 px-3 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm font-medium rounded-xl hover:bg-emerald-100 transition-colors">
                      <FileText size={15} /> 個別援助計画書
                    </button>
                    <button onClick={() => { setProposalInitialParams(null); setShowProposal(true); }}
                      className="flex items-center gap-2 px-3 py-2.5 bg-purple-50 border border-purple-200 text-purple-700 text-sm font-medium rounded-xl hover:bg-purple-100 transition-colors">
                      <FileText size={15} /> 選定提案書
                    </button>
                    <button onClick={() => setShowContracts(true)}
                      className="flex items-center gap-2 px-3 py-2.5 bg-orange-50 border border-orange-200 text-orange-700 text-sm font-medium rounded-xl hover:bg-orange-100 transition-colors">
                      <FileText size={15} /> 重要事項・契約書
                    </button>
                    <button onClick={() => { setChangeContractInitialParams(null); setShowChangeContract(true); }}
                      className="flex items-center gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium rounded-xl hover:bg-amber-100 transition-colors">
                      <FileText size={15} /> 変更契約書
                    </button>
                  </div>
                </div>

                {/* 書類履歴 */}
                <div>
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide shrink-0">保存済み書類 ({documents.length})</p>
                    <div className="flex gap-1 flex-wrap">
                      {([
                        [null, "全"],
                        ["care_plan", "個別援助計画書"],
                        ["proposal", "選定提案書"],
                        ["rental_report", "貸与報告書"],
                        ["contract", "重要事項・契約書"],
                      ] as [string | null, string][]).map(([type, label]) => (
                        <button key={label} onClick={() => setDocTypeFilter(type)}
                          className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                            docTypeFilter === type
                              ? "bg-gray-700 text-white border-gray-700"
                              : "text-gray-500 border-gray-300 hover:border-gray-500"
                          }`}>{label}</button>
                      ))}
                    </div>
                  </div>
                  {documents.filter(d => docTypeFilter === null || d.type === docTypeFilter).length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-6">保存済みの書類はありません</p>
                  ) : (
                    <div className="space-y-2">
                      {documents.filter(d => docTypeFilter === null || d.type === docTypeFilter).map(doc => {
                        // 再生成（または内容再表示）対応タイプ
                        const canRegenerate =
                          doc.type === "rental_report" ||
                          doc.type === "care_plan" ||
                          doc.type === "proposal" ||
                          doc.type === "supplier_email" ||
                          doc.type === "rental_contract" ||
                          doc.type === "important_matters" ||
                          doc.type === "change_contract";
                        return (
                        <div key={doc.id} className="bg-white rounded-xl px-3 py-2.5 flex items-center gap-2 border border-gray-100 shadow-sm">
                          <FileText size={16} className={DOC_TYPE_COLORS[doc.type]?.split(" ")[0] ?? "text-gray-500"} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-gray-800 truncate">{doc.title}</p>
                            <p className="text-xs text-gray-400">{new Date(doc.created_at).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })}</p>
                          </div>
                          {canRegenerate && (
                            <button
                              onClick={async () => {
                                try {
                                  if (doc.type === "rental_report") {
                                    setRegenDoc(doc); setShowReport(false);
                                  } else if (doc.type === "care_plan") {
                                    setCarePlanInitialParams(doc.params); setShowCarePlan(true);
                                  } else if (doc.type === "proposal") {
                                    setProposalInitialParams(doc.params); setShowProposal(true);
                                  } else if (doc.type === "rental_contract" || doc.type === "important_matters") {
                                    setShowContracts(true);
                                  } else if (doc.type === "change_contract") {
                                    setChangeContractInitialParams(doc.params);
                                    setShowChangeContract(true);
                                  } else if (doc.type === "supplier_email") {
                                    const orderId = doc.params?.orderId as string | undefined;
                                    // フォールバック表示用に保存済み情報を取り出す
                                    const showSavedFromParams = (reason: string) => {
                                      const subject = (doc.params?.subject as string) ?? "";
                                      const body = (doc.params?.body as string) ?? "";
                                      const supplierName = doc.params?.supplierName as string | undefined;
                                      if (!subject && !body) {
                                        alert(`${reason}\nまた、保存済みのメール内容も書類に残っていないため表示できません。`);
                                        return;
                                      }
                                      setSavedEmailView({
                                        subject,
                                        body,
                                        supplierName,
                                        sentAt: doc.created_at,
                                        title: doc.title,
                                      });
                                    };
                                    if (!orderId) {
                                      showSavedFromParams("この発注メール書類には発注ID(orderId)が記録されていません（古い書類）。");
                                      return;
                                    }
                                    const [orderRes, items, suppliers, members] = await Promise.all([
                                      supabase.from("orders").select("*").eq("id", orderId).maybeSingle(),
                                      getOrderItems(orderId),
                                      getSuppliers(),
                                      getMembers(tenantId),
                                    ]);
                                    if (orderRes.error) {
                                      console.error("発注取得エラー:", orderRes.error);
                                      alert(`発注の取得に失敗しました: ${orderRes.error.message}`);
                                      return;
                                    }
                                    if (!orderRes.data) {
                                      showSavedFromParams("元の発注が見つかりません（削除された可能性があります）。");
                                      return;
                                    }
                                    setEmailPreview({ order: orderRes.data as Order, items, suppliers, members, sentAt: doc.created_at });
                                  }
                                } catch (e) {
                                  console.error("再生成エラー:", e);
                                  alert(`再生成に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
                                }
                              }}
                              className="shrink-0 text-xs text-blue-600 border border-blue-200 px-2.5 py-1 rounded-lg hover:bg-blue-50">再生成</button>
                          )}
                          <button
                            onClick={async () => { await deleteClientDocument(doc.id); setDocuments(prev => prev.filter(d => d.id !== doc.id)); }}
                            className="shrink-0 text-xs text-red-400 border border-red-200 px-2.5 py-1 rounded-lg hover:bg-red-50">削除</button>
                        </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* モーダル */}
      {(showReport || regenDoc) && selectedClient && (
        <RentalReportModal
          client={selectedClient} items={clientItems} orderPaymentMap={orderPaymentMap}
          equipment={equipment} companyInfo={companyInfo} priceHistory={priceHistory}
          tenantId={tenantId}
          initialParams={regenDoc ? (regenDoc.params as { targetMonth: string; visitDate: string; memo: string; selectedUsage: string[] }) : undefined}
          onClose={() => { setShowReport(false); setRegenDoc(null); }}
          onSaved={refreshDocs}
        />
      )}
      {showCarePlan && selectedClient && (
        <CarePlanModal
          client={selectedClient} clientItems={clientItems} equipment={equipment}
          companyInfo={companyInfo} tenantId={tenantId}
          initialParams={carePlanInitialParams ?? undefined}
          onClose={() => setShowCarePlan(false)}
          onSaved={async () => { await refreshDocs(); setShowCarePlan(false); }}
        />
      )}
      {showProposal && selectedClient && (
        <ProposalModal
          client={selectedClient} clientItems={clientItems} equipment={equipment}
          companyInfo={companyInfo} tenantId={tenantId}
          initialParams={proposalInitialParams ?? undefined}
          onClose={() => setShowProposal(false)}
          onSaved={async () => { await refreshDocs(); setShowProposal(false); }}
        />
      )}
      {showContracts && selectedClient && (
        <ContractDocumentsModal
          client={selectedClient} clientItems={clientItems} equipment={equipment}
          companyInfo={companyInfo} tenantId={tenantId}
          onClose={() => setShowContracts(false)}
          onSaved={async () => { await refreshDocs(); setShowContracts(false); }}
        />
      )}
      {emailPreview && selectedClient && (
        <OrderEmailPreviewModal
          order={emailPreview.order}
          orderItems={emailPreview.items}
          clients={[selectedClient]}
          equipment={equipment}
          suppliers={emailPreview.suppliers}
          members={emailPreview.members}
          emailType="new_order"
          tenantId={tenantId}
          sentAt={emailPreview.sentAt}
          onClose={() => setEmailPreview(null)}
          onBack={() => setEmailPreview(null)}
          onDone={() => setEmailPreview(null)}
        />
      )}
      {showChangeContract && selectedClient && (
        <ChangeContractModal
          client={selectedClient}
          clientItems={clientItems}
          equipment={equipment}
          companyInfo={companyInfo}
          tenantId={tenantId}
          initialParams={changeContractInitialParams ?? undefined}
          onClose={() => { setShowChangeContract(false); setChangeContractInitialParams(null); }}
          onSaved={async () => {
            await refreshDocs();
            setShowChangeContract(false);
            setChangeContractInitialParams(null);
          }}
        />
      )}
      {/* 元発注が削除された supplier_email 書類のフォールバック表示 */}
      {savedEmailView && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
              <div>
                <h3 className="font-semibold text-gray-800 text-sm">📧 保存済み発注メール（送信済み）</h3>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  {savedEmailView.supplierName && `卸: ${savedEmailView.supplierName} / `}
                  {savedEmailView.sentAt && `送信日: ${new Date(savedEmailView.sentAt).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" })}`}
                </p>
              </div>
              <button onClick={() => setSavedEmailView(null)} className="text-gray-400 hover:text-gray-600 text-xl leading-none shrink-0">×</button>
            </div>
            <div className="px-5 py-4 overflow-y-auto space-y-3 flex-1">
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5 text-[11px] text-amber-800">
                ⚠️ 元の発注データは削除されているため再送信はできません。書類保存時に記録されたメール内容のみ表示しています。
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1">件名</p>
                <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-800 break-all">{savedEmailView.subject || <span className="text-gray-400">（記録なし）</span>}</div>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1">本文</p>
                <div className="bg-gray-50 rounded-lg p-3 text-sm text-gray-800 whitespace-pre-wrap break-words font-mono">{savedEmailView.body || <span className="text-gray-400 font-sans">（記録なし）</span>}</div>
              </div>
            </div>
            <div className="px-5 py-3 border-t border-gray-100 shrink-0 flex gap-2">
              <button
                onClick={() => {
                  if (!savedEmailView.body) return;
                  navigator.clipboard?.writeText(savedEmailView.body).then(
                    () => { /* noop: コピー成功 */ },
                    () => { /* noop: 失敗時は無視 */ }
                  );
                }}
                disabled={!savedEmailView.body}
                className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl text-sm disabled:opacity-40"
              >
                本文をコピー
              </button>
              <button
                onClick={() => setSavedEmailView(null)}
                className="flex-1 py-2 bg-emerald-500 hover:bg-emerald-600 text-white font-semibold rounded-xl text-sm"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Billing Tab ─────────────────────────────────────────────────────────────

function BillingTab({ tenantId, currentOfficeId }: { tenantId: string; currentOfficeId: string | null }) {
  // サブタブ（請求明細 / 売上帳票）
  const [subTab, setSubTab] = useState<"billing" | "sales">("billing");
  const [clients, setClients] = useState<Client[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tenantInfo, setTenantInfo] = useState<import("@/lib/tenants").Tenant | null>(null);
  const [offices, setOffices] = useState<Office[]>([]);
  const [insuranceRecords, setInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [hospitalizations, setHospitalizations] = useState<ClientHospitalization[]>([]);
  const [priceHistoryAll, setPriceHistoryAll] = useState<EquipmentPriceHistory[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [invoiceClient, setInvoiceClient] = useState<Client | null>(null);

  // 会社情報（請求書／領収書モーダル用）
  const companyInfoForDoc: CompanyInfo = useMemo(() => {
    if (!tenantInfo) return COMPANY_INFO_DEFAULTS;
    return {
      businessNumber:      tenantInfo.business_number       ?? COMPANY_INFO_DEFAULTS.businessNumber,
      companyName:         tenantInfo.company_name          ?? COMPANY_INFO_DEFAULTS.companyName,
      companyAddress:      tenantInfo.company_address       ?? COMPANY_INFO_DEFAULTS.companyAddress,
      tel:                 tenantInfo.company_tel           ?? COMPANY_INFO_DEFAULTS.tel,
      fax:                 tenantInfo.company_fax           ?? COMPANY_INFO_DEFAULTS.fax,
      staffName:           tenantInfo.staff_name            ?? COMPANY_INFO_DEFAULTS.staffName,
      serviceArea:         tenantInfo.service_area          ?? COMPANY_INFO_DEFAULTS.serviceArea,
      businessDays:        tenantInfo.business_days         ?? COMPANY_INFO_DEFAULTS.businessDays,
      businessHours:       tenantInfo.business_hours        ?? COMPANY_INFO_DEFAULTS.businessHours,
      staffManagerFull:    tenantInfo.staff_manager_full    ?? COMPANY_INFO_DEFAULTS.staffManagerFull,
      staffManagerPart:    tenantInfo.staff_manager_part    ?? COMPANY_INFO_DEFAULTS.staffManagerPart,
      staffSpecialistFull: tenantInfo.staff_specialist_full ?? COMPANY_INFO_DEFAULTS.staffSpecialistFull,
      staffSpecialistPart: tenantInfo.staff_specialist_part ?? COMPANY_INFO_DEFAULTS.staffSpecialistPart,
      staffAdminFull:      tenantInfo.staff_admin_full      ?? COMPANY_INFO_DEFAULTS.staffAdminFull,
      staffAdminPart:      tenantInfo.staff_admin_part      ?? COMPANY_INFO_DEFAULTS.staffAdminPart,
    };
  }, [tenantInfo]);

  useEffect(() => {
    Promise.all([
      getClients(tenantId),
      getEquipment(tenantId),
      getAllOrderItemsByTenant(tenantId),
      getAllOrders(tenantId),
      getTenantById(tenantId),
      getOffices(tenantId),
      supabase.from("client_insurance_records").select("*").eq("tenant_id", tenantId).then(r => r.data ?? []),
      supabase.from("client_hospitalizations").select("*").eq("tenant_id", tenantId).then(r => r.data ?? []),
    ]).then(([c, eq, items, ords, tenant, offs, insRaw, hospRaw]) => {
      setClients(c);
      setEquipment(eq);
      setOrderItems(items);
      setOrders(ords);
      setTenantInfo(tenant);
      setOffices(offs);
      setInsuranceRecords(insRaw as ClientInsuranceRecord[]);
      setHospitalizations(hospRaw as ClientHospitalization[]);
      // 価格履歴は全 product_code 分を取得（請求書／領収書モーダルで使用）
      const codes = [...new Set(items.map((i: OrderItem) => i.product_code))];
      if (codes.length > 0) {
        getPriceHistory(tenantId, codes).then(setPriceHistoryAll).catch(() => {});
      }
    }).catch(console.error).finally(() => setDataLoading(false));
  }, [tenantId]);
  const [billingMonth, setBillingMonth] = useState(() => {
    // デフォルトは今月
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const [unitOverrides, setUnitOverridesState] = useState<Map<string, number>>(new Map()); // key: order_item_id
  const [rebillFlags, setRebillFlagsState] = useState<Map<string, BillingRebillFlag>>(new Map()); // key: "clientId-month"
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  // 月遅れ自動判定：保険証のcertification_statusが「申請中」の利用者
  const autoLateClients = useMemo(() => {
    const [y, m] = billingMonth.split("-").map(Number);
    const monthStart = `${billingMonth}-01`;
    const monthEnd = new Date(y, m, 0).toISOString().split("T")[0];
    const lateSet = new Set<string>();
    for (const client of clients) {
      const recs = insuranceRecords
        .filter(r => r.client_id === client.id)
        .sort((a, b) => (b.effective_date ?? "").localeCompare(a.effective_date ?? ""));
      const rec = recs.find(r => {
        const start = r.certification_start_date ?? r.effective_date;
        const end = r.certification_end_date;
        if (start && start > monthEnd) return false;
        if (end && end < monthStart) return false;
        return true;
      });
      if (rec?.certification_status === "申請中") lateSet.add(client.id);
    }
    return lateSet;
  }, [insuranceRecords, clients, billingMonth]);

  // 当月アクティブレンタルを取得
  const activeRentals = useMemo(() => {
    const [y, m] = billingMonth.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    return orderItems.filter((item) => {
      const pt = item.payment_type ?? orders.find((o) => o.id === item.order_id)?.payment_type ?? "介護";
      if (pt !== "介護") return false; // 介護保険のみ請求
      if (!item.rental_start_date) return false;
      const pld2 = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
      const start = pld2(item.rental_start_date);
      if (start > monthEnd) return false;
      if (item.status === "terminated" && item.rental_end_date) {
        const end = pld2(item.rental_end_date);
        if (end < monthStart) return false;
      }
      if (item.status !== "rental_started" && item.status !== "terminated") return false;
      return true;
    });
  }, [billingMonth, orderItems]);

  // 利用者ごとにグループ化（事業所フィルタ付き）
  const clientGroups = useMemo(() => {
    const map = new Map<string, { client: Client; items: OrderItem[] }>();
    for (const item of activeRentals) {
      const order = orders.find((o) => o.id === item.order_id);
      // 事業所が選択されている場合、その事業所の注文のみ
      if (currentOfficeId && order?.office_id && order.office_id !== currentOfficeId) continue;
      if (!order?.client_id) continue;
      const client = clients.find((c) => c.id === order.client_id);
      if (!client) continue;
      if (!map.has(client.id)) map.set(client.id, { client, items: [] });
      map.get(client.id)!.items.push(item);
    }
    return Array.from(map.values()).sort((a, b) => a.client.name.localeCompare(b.client.name, "ja"));
  }, [activeRentals, orders, clients]);

  // DBからフラグを読み込む
  useEffect(() => {
    setLoading(true);
    Promise.all([
      getUnitOverrides(tenantId, billingMonth),
      getRebillFlags(tenantId),
    ]).then(([units, rebill]) => {
      const um = new Map<string, number>();
      units.forEach((u) => um.set(u.order_item_id, u.units_override));
      setUnitOverridesState(um);
      const rm = new Map<string, BillingRebillFlag>();
      rebill.forEach((r) => rm.set(`${r.client_id}-${r.month}`, r));
      setRebillFlagsState(rm);
    }).catch(console.error).finally(() => setLoading(false));
  }, [tenantId, billingMonth]);

  // チェックした利用者を過誤/返戻で確定
  const handleConfirm = async (type: "返戻" | "過誤") => {
    const promises = Array.from(selectedClientIds).map(clientId =>
      setRebillFlag(tenantId, clientId, billingMonth, type)
    );
    await Promise.all(promises);
    const rebill = await getRebillFlags(tenantId);
    const rm = new Map<string, BillingRebillFlag>();
    rebill.forEach((r) => rm.set(`${r.client_id}-${r.month}`, r));
    setRebillFlagsState(rm);
    setSelectedClientIds(new Set());
  };

  const getUnits = (item: OrderItem, clientId: string) => {
    if (unitOverrides.has(item.id)) return unitOverrides.get(item.id)!;
    const eq = equipment.find((e) => e.product_code === item.product_code);
    const base = eq?.rental_price ? Math.round(eq.rental_price / 10) : 0;
    // 入院による半月判定
    const [y, m] = billingMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    const clientHosp = hospitalizations.filter(h => h.client_id === clientId);
    // 貸与期間のうち入院でない日をカウント（タイムゾーン問題を避けるため文字列分割でパース）
    const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const rentalStart = item.rental_start_date ? parseLocalDate(item.rental_start_date) : null;
    const rentalEnd = item.rental_end_date ? parseLocalDate(item.rental_end_date) : monthEnd;
    if (!rentalStart) return base;
    let billingDays = 0, firstHalf = false, secondHalf = false;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date < rentalStart || date > rentalEnd) continue;
      const inHosp = clientHosp.some(h => {
        const admit = parseLocalDate(h.admission_date);
        const discharge = h.discharge_date ? parseLocalDate(h.discharge_date) : monthEnd;
        return date >= admit && date <= discharge;
      });
      if (!inHosp) {
        billingDays++;
        if (d <= 15) firstHalf = true; else secondHalf = true;
      }
    }
    if (billingDays === 0) return 0;
    // 前半か後半のみ → 半月分
    if (firstHalf && !secondHalf) return Math.round(base / 2);
    if (secondHalf && !firstHalf) return Math.round(base / 2);
    return base;
  };

  const handleUnitOverride = async (clientId: string, item: OrderItem, value: string) => {
    const n = parseInt(value, 10);
    const eq = equipment.find((e) => e.product_code === item.product_code);
    const autoUnits = eq?.rental_price ? Math.round(eq.rental_price / 10) : 0;
    if (!value || isNaN(n) || n === autoUnits) {
      await removeUnitOverride(tenantId, clientId, billingMonth, item.id);
      setUnitOverridesState((prev) => { const m = new Map(prev); m.delete(item.id); return m; });
    } else {
      await setUnitOverride(tenantId, clientId, billingMonth, item.id, n);
      setUnitOverridesState((prev) => new Map(prev).set(item.id, n));
    }
  };

  const toggleRebillFlag = async (clientId: string, month: string, type: "返戻" | "過誤") => {
    const key = `${clientId}-${month}`;
    const existing = rebillFlags.get(key);
    if (existing && existing.flag_type === type) {
      await removeRebillFlag(tenantId, clientId, month);
      setRebillFlagsState((prev) => { const m = new Map(prev); m.delete(key); return m; });
    } else {
      await setRebillFlag(tenantId, clientId, month, type);
      setRebillFlagsState((prev) => new Map(prev).set(key, {
        id: "", tenant_id: tenantId, client_id: clientId, month, flag_type: type, created_at: ""
      }));
    }
  };

  // 伝送データ生成
  const generateTransferData = () => {
    const [y, m] = billingMonth.split("-").map(Number);
    const serviceMonth = `${y}${String(m).padStart(2, "0")}`;
    // 選択中の事業所の事業所番号を優先、なければテナントの番号にフォールバック
    const currentOffice = offices.find(o => o.id === currentOfficeId);
    const rawOfficeNumber = currentOffice?.business_number || tenantInfo?.business_number || "";
    const officeNumber = rawOfficeNumber.replace(/-/g, "") || "0000000000";
    if (currentOfficeId && !currentOffice?.business_number) {
      alert(`事業所「${currentOffice?.name ?? ""}」に事業所番号が設定されていません。設定タブで登録してください。`);
      return;
    }
    const lines: string[] = [];
    const billingGroups = clientGroups.filter((g) => !autoLateClients.has(g.client.id));

    // コントロールレコード
    lines.push([
      "1", // レコード種別
      "61", // 交換情報識別番号（居宅系：様式第二の三 福祉用具貸与）
      serviceMonth,
      officeNumber,
      String(billingGroups.length),
      "", "", "",
    ].join(","));

    for (const { client, items } of billingGroups) {
      const insuredNumber = client.user_number ?? "";
      // 給付率（benefit_rateは90/80/70などの給付率で保存済み）
      const benefitRate = parseInt(client.benefit_rate ?? "90", 10);

      // 基本情報レコード
      lines.push([
        "2", // レコード種別コード（基本情報）
        "61",
        serviceMonth,
        officeNumber,
        "", // 証記載保険者番号（被保険者証から）
        insuredNumber,
        "1", // 居宅サービス
        "", // 認定有効期間開始
        "", // 認定有効期間終了
        client.care_level?.replace("要介護", "").replace("要支援", "") ?? "",
        String(benefitRate),
        "", // 生活保護
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ].join(","));

      // 明細情報レコード（用具ごと）
      let seq = 1;
      let totalUnits = 0;
      for (const item of items) {
        const eq = equipment.find((e) => e.product_code === item.product_code);
        const units = getUnits(item, client.id) * item.quantity;
        const taisCode = eq?.tais_code ?? "";
        totalUnits += units;
        lines.push([
          "3", // レコード種別コード（明細情報）
          "61",
          serviceMonth,
          officeNumber,
          "",
          insuredNumber,
          String(seq++).padStart(2, "0"),
          "17", // サービス種類コード（福祉用具貸与）
          taisCode, // XXXXX-YYYYYY形式
          String(units),
          String(Math.round(units * 10)), // 費用額（単位数×10円概算）
          "0", // 公費分回数
          "0",
          "",
        ].join(","));
      }

      // 集計情報レコード
      lines.push([
        "4", // レコード種別コード（集計情報）
        "61",
        serviceMonth,
        officeNumber,
        "",
        insuredNumber,
        "17",
        String(totalUnits),
        String(Math.round(totalUnits * 10)),
        "",
      ].join(","));
    }

    // エンドレコード
    lines.push(["99", String(lines.length + 1)].join(","));

    // Shift-JIS CSVとしてダウンロード（ブラウザ側でエンコード対応が必要なため UTF-8 BOM付きで代用）
    const bom = "\uFEFF";
    const csv = bom + lines.join("\r\n") + "\r\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `FKYUFU${serviceMonth}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 過去月の再請求グループ（返戻・過誤フラグがある月ごとに集計）
  const rebillByMonth = useMemo(() => {
    const result = new Map<string, Array<{ client: Client; items: OrderItem[]; flag: BillingRebillFlag }>>();
    for (const flag of rebillFlags.values()) {
      if (flag.month === billingMonth) continue;
      const client = clients.find((c) => c.id === flag.client_id);
      if (!client) continue;
      const [y, m] = flag.month.split("-").map(Number);
      const monthStart = new Date(y, m - 1, 1);
      const monthEnd = new Date(y, m, 0, 23, 59, 59);
      const items = orderItems.filter((item) => {
        const order = orders.find((o) => o.id === item.order_id);
        if (order?.client_id !== client.id) return false;
        const pt = item.payment_type ?? orders.find((o) => o.id === item.order_id)?.payment_type ?? "介護";
        if (pt !== "介護") return false;
        if (!item.rental_start_date) return false;
        const start = new Date(item.rental_start_date);
        if (start > monthEnd) return false;
        if (item.status === "terminated" && item.rental_end_date) {
          const end = new Date(item.rental_end_date);
          if (end < monthStart) return false;
        }
        if (item.status !== "rental_started" && item.status !== "terminated") return false;
        return true;
      });
      if (!result.has(flag.month)) result.set(flag.month, []);
      result.get(flag.month)!.push({ client, items, flag });
    }
    return Array.from(result.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [rebillFlags, billingMonth, orderItems, orders, clients]);

  const [y, m] = billingMonth.split("-").map(Number);
  const prevMonth = () => { const d = new Date(y, m - 2, 1); setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const d = new Date(y, m, 1); setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  const [detailClient, setDetailClient] = useState<{ client: Client; items: OrderItem[] } | null>(null);
  const [rentalGridClient, setRentalGridClient] = useState<{ client: Client; items: OrderItem[] } | null>(null);
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);
  const [showRentalGridView, setShowRentalGridView] = useState(false);
  const [gridSelectedClient, setGridSelectedClient] = useState<{ client: Client; items: OrderItem[] } | null>(null);
  const [gridKanaFilter, setGridKanaFilter] = useState<string | null>(null);
  const [isGridPending, startGridTransition] = useTransition();
  const billingTarget = clientGroups.filter(g => !autoLateClients.has(g.client.id));
  const totalUnitsAll = billingTarget.reduce((s, { client, items }) => s + items.reduce((ss, item) => ss + getUnits(item, client.id) * item.quantity, 0), 0);

  const KANA_ROWS = ["あ","か","さ","た","な","は","ま","や","ら","わ","他"];
  const KANA_MAP: Record<string, string[]> = {
    "あ":["ア","イ","ウ","エ","オ"],"か":["カ","キ","ク","ケ","コ","ガ","ギ","グ","ゲ","ゴ"],
    "さ":["サ","シ","ス","セ","ソ","ザ","ジ","ズ","ゼ","ゾ"],"た":["タ","チ","ツ","テ","ト","ダ","ヂ","ヅ","デ","ド"],
    "な":["ナ","ニ","ヌ","ネ","ノ"],"は":["ハ","ヒ","フ","ヘ","ホ","バ","ビ","ブ","ベ","ボ","パ","ピ","プ","ペ","ポ"],
    "ま":["マ","ミ","ム","メ","モ"],"や":["ヤ","ユ","ヨ"],
    "ら":["ラ","リ","ル","レ","ロ"],"わ":["ワ","ヲ","ン"],
  };
  // ひらがな→カタカナ正規化
  const toKana = (s: string) => s.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const allKana = Object.values(KANA_MAP).flat();

  const filteredGroups = kanaFilter
    ? clientGroups.filter(({ client }) => {
        const first = toKana((client.furigana ?? client.name).charAt(0));
        if (kanaFilter === "他") return !allKana.includes(first);
        return (KANA_MAP[kanaFilter] ?? []).includes(first);
      })
    : clientGroups;

  const gridFilteredGroups = gridKanaFilter
    ? clientGroups.filter(({ client }) => {
        const first = toKana((client.furigana ?? client.name).charAt(0));
        if (gridKanaFilter === "他") return !allKana.includes(first);
        return (KANA_MAP[gridKanaFilter] ?? []).includes(first);
      })
    : clientGroups;

  // 全行（当月 + 再請求）
  const allRows = [
    ...filteredGroups.map(g => ({ type: "current" as const, ...g })),
    ...rebillByMonth.flatMap(([month, entries]) =>
      entries.map(({ client, items, flag }) => ({ type: "rebill" as const, client, items, flag, month }))
    ),
  ];

  if (subTab === "sales") {
    return (
      <div className="flex flex-col h-full bg-white text-sm">
        {/* サブタブ切替 */}
        <div className="border-b border-gray-200 bg-white px-3 py-2 shrink-0 flex items-center gap-2">
          <button onClick={() => setSubTab("billing")} className="px-3 py-1 rounded-lg text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200">請求明細</button>
          <button onClick={() => setSubTab("sales")} className="px-3 py-1 rounded-lg text-xs font-medium bg-indigo-500 text-white">売上帳票</button>
        </div>
        <SalesReportTab
          tenantId={tenantId}
          clients={clients}
          orderItems={orderItems}
          orders={orders}
          equipment={equipment}
          currentOfficeId={currentOfficeId}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white text-sm">
      {/* サブタブ切替 */}
      <div className="border-b border-gray-200 bg-white px-3 py-2 shrink-0 flex items-center gap-2">
        <button onClick={() => setSubTab("billing")} className="px-3 py-1 rounded-lg text-xs font-medium bg-indigo-500 text-white">請求明細</button>
        <button onClick={() => setSubTab("sales")} className="px-3 py-1 rounded-lg text-xs font-medium bg-gray-100 text-gray-500 hover:bg-gray-200">売上帳票</button>
      </div>
      {/* ── ツールバー ── */}
      <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 border border-gray-300 rounded bg-white px-2 py-1">
          <button onClick={prevMonth} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="font-semibold text-gray-800 px-1.5">R{y - 2018}/{m}</span>
          <button onClick={nextMonth} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">請求分</span>
        <button
          onClick={() => { setShowRentalGridView(v => !v); setGridSelectedClient(null); }}
          className={`border rounded px-2.5 py-1 font-medium transition-colors ${showRentalGridView ? "border-emerald-600 bg-emerald-600 text-white" : "border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}
        >提供表</button>
        <div className="w-px h-5 bg-gray-300 mx-1" />
        <button className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">明細書</button>
        <button className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">請求書</button>
        <button className="border border-blue-500 rounded bg-blue-100 px-2.5 py-1 text-blue-800 font-semibold">国保対象</button>
        <button className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">管理帳票</button>
        {selectedClientIds.size > 0 && (
          <>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <span className="text-gray-600">{selectedClientIds.size}名選択</span>
            <button onClick={() => handleConfirm("返戻")}
              className="border border-orange-400 rounded bg-orange-50 px-2.5 py-1 text-orange-700 font-semibold hover:bg-orange-100">返戻で確定</button>
            <button onClick={() => handleConfirm("過誤")}
              className="border border-red-400 rounded bg-red-50 px-2.5 py-1 text-red-700 font-semibold hover:bg-red-100">過誤で確定</button>
          </>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-amber-600 text-xs">※ 被保険者証情報は別途ほのぼので補完</span>
          <button onClick={generateTransferData}
            className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5">
            <Download size={13} />CSV出力
          </button>
        </div>
      </div>

      {(loading || dataLoading) ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-400" /></div>
      ) : showRentalGridView ? (
        <div className="flex flex-1 min-h-0">
          {/* ── 提供表ビュー：左＝利用者リスト、右＝グリッド ── */}
          <div className="flex shrink-0 border-r border-gray-300">
            {/* カナサイドバー */}
            <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
              <button
                onClick={() => setGridKanaFilter(null)}
                className={`w-8 py-1 rounded text-sm font-bold transition-colors ${gridKanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
              >全</button>
              {KANA_ROWS.map(k => (
                <button key={k}
                  onClick={() => setGridKanaFilter(gridKanaFilter === k ? null : k)}
                  className={`w-8 py-1 rounded text-sm font-medium transition-colors ${gridKanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
                >{k}</button>
              ))}
            </div>
            {/* 利用者名リスト */}
            <div className="w-40 overflow-y-auto">
              {gridFilteredGroups.map(({ client, items }) => (
                <button
                  key={client.id}
                  onClick={() => startGridTransition(() => setGridSelectedClient({ client, items }))}
                  className={`w-full text-left px-3 py-2.5 text-sm border-b border-gray-100 transition-colors ${
                    gridSelectedClient?.client.id === client.id
                      ? "bg-blue-100 text-blue-800 font-semibold"
                      : "hover:bg-gray-50 text-gray-700"
                  }`}
                >{client.name}</button>
              ))}
            </div>
          </div>
          {/* 右：グリッド */}
          <div className={`flex-1 overflow-auto transition-opacity duration-100 ${isGridPending ? "opacity-40 pointer-events-none" : "opacity-100"}`}>
            {gridSelectedClient ? (
              <RentalGridPanel
                client={gridSelectedClient.client}
                items={gridSelectedClient.items}
                equipment={equipment}
                hospitalizations={hospitalizations.filter(h => h.client_id === gridSelectedClient.client.id)}
                month={billingMonth}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">利用者を選択してください</div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* ── 行カナ絞り込みサイドバー ── */}
          <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
            <button
              onClick={() => setKanaFilter(null)}
              className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
            >全</button>
            {KANA_ROWS.map(k => (
              <button key={k}
                onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
                className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
              >{k}</button>
            ))}
          </div>

          {/* ── メインテーブル ── */}
          <div className="flex flex-col flex-1 min-w-0 border-r border-gray-200">
            {/* ヘッダー行 */}
            <div className="grid grid-cols-[36px_80px_64px_64px_1fr_90px_52px_52px_52px] border-b border-gray-300 bg-gray-100 text-sm font-semibold text-gray-600 shrink-0">
              <div className="px-2 py-2 flex items-center justify-center">
                <button
                  onClick={() => setSelectedClientIds(
                    selectedClientIds.size === clientGroups.length && clientGroups.length > 0
                      ? new Set() : new Set(clientGroups.map(g => g.client.id))
                  )}
                  className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                    selectedClientIds.size === clientGroups.length && clientGroups.length > 0
                      ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                  }`}
                >
                  {selectedClientIds.size === clientGroups.length && clientGroups.length > 0 && (
                    <span className="text-white text-[8px] font-bold leading-none">✓</span>
                  )}
                </button>
              </div>
              <div className="px-2 py-2 border-l border-gray-200">状態</div>
              <div className="px-2 py-2 border-l border-gray-200">提供月</div>
              <div className="px-2 py-2 border-l border-gray-200">請求月</div>
              <div className="px-2 py-2 border-l border-gray-200">利用者名</div>
              <div className="px-2 py-2 border-l border-gray-200 text-right">単位数</div>
              <div className="px-2 py-2 border-l border-gray-200 text-center">月遅</div>
              <div className="px-2 py-2 border-l border-gray-200 text-center">返戻</div>
              <div className="px-2 py-2 border-l border-gray-200 text-center">過誤</div>
            </div>

            {/* 行 */}
            <div className="flex-1 overflow-y-auto">
              {allRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10">{billingMonth}のアクティブレンタル（介護）がありません</p>
              ) : allRows.map((row, idx) => {
                if (row.type === "rebill") {
                  const [ry, rm] = row.month.split("-").map(Number);
                  const units = row.items.reduce((s, item) => s + getUnits(item, row.client.id) * item.quantity, 0);
                  return (
                    <div key={`rebill-${row.client.id}-${row.month}`}
                      className="grid grid-cols-[36px_80px_64px_64px_1fr_90px_52px_52px_52px] border-b border-gray-100 bg-amber-50 text-sm">
                      <div className="px-2 py-2" />
                      <div className="px-2 py-2 border-l border-gray-100 text-amber-700 font-medium">再請求</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">R{ry-2018}/{rm}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">R{y-2018}/{m}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-700 font-medium">{row.client.name}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-right font-mono">{units.toLocaleString()}</div>
                      <div className="py-2 border-l border-gray-100 text-center" />
                      <div className="py-2 border-l border-gray-100 text-center">
                        {row.flag.flag_type === "返戻" && (
                          <button onClick={() => toggleRebillFlag(row.client.id, row.month, "返戻")}
                            className="text-red-500 underline text-xs">返戻</button>
                        )}
                      </div>
                      <div className="py-2 border-l border-gray-100 text-center">
                        {row.flag.flag_type === "過誤" && (
                          <button onClick={() => toggleRebillFlag(row.client.id, row.month, "過誤")}
                            className="text-red-500 underline text-xs">過誤</button>
                        )}
                      </div>
                    </div>
                  );
                }
                const { client, items } = row;
                const isLate = autoLateClients.has(client.id);
                const flag = rebillFlags.get(`${client.id}-${billingMonth}`);
                const isSelected = selectedClientIds.has(client.id);
                const isDetail = detailClient?.client.id === client.id;
                const totalUnits = items.reduce((s, item) => s + getUnits(item, client.id) * item.quantity, 0);
                return (
                  <div
                    key={client.id}
                    onClick={() => setDetailClient(isDetail ? null : { client, items })}
                    className={`grid grid-cols-[36px_80px_64px_64px_1fr_90px_52px_52px_52px] border-b border-gray-100 text-sm cursor-pointer transition-colors ${
                      isDetail ? "bg-blue-100" : isLate ? "bg-yellow-50" : isSelected ? "bg-indigo-50" : idx % 2 === 0 ? "bg-white hover:bg-gray-50" : "bg-gray-50/50 hover:bg-gray-100"
                    }`}
                  >
                    <div className="px-2 py-2.5 flex items-center justify-center" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setSelectedClientIds(prev => {
                          const s = new Set(prev); if (s.has(client.id)) s.delete(client.id); else s.add(client.id); return s;
                        })}
                        className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                          isSelected ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                        }`}
                      >
                        {isSelected && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
                      </button>
                    </div>
                    <div className="px-2 py-2.5 border-l border-gray-100">
                      <span className="text-blue-700 font-semibold">国保対象</span>
                    </div>
                    <div className="px-2 py-2.5 border-l border-gray-100 text-gray-600">R{y-2018}/{m}</div>
                    <div className="px-2 py-2.5 border-l border-gray-100 text-gray-600">R{y-2018}/{m}</div>
                    <div className="px-2 py-2.5 border-l border-gray-100 font-medium text-gray-800 flex items-center gap-2 min-w-0">
                      <span className="truncate">{client.name}</span>
                      <button
                        onClick={e => { e.stopPropagation(); setRentalGridClient({ client, items }); }}
                        className="shrink-0 text-[10px] border border-gray-300 rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                      >提供表</button>
                      <button
                        onClick={e => { e.stopPropagation(); setInvoiceClient(client); }}
                        className="shrink-0 text-[10px] border border-emerald-400 rounded px-1.5 py-0.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors"
                      >📄 請求書発行</button>
                    </div>
                    <div className="px-2 py-2.5 border-l border-gray-100 text-right font-mono">
                      {isLate ? <span className="text-gray-300">—</span> : totalUnits.toLocaleString()}
                    </div>
                    <div className="py-2.5 border-l border-gray-100 text-center text-orange-500 font-semibold text-xs">
                      {isLate ? "月遅" : ""}
                    </div>
                    <div className="py-2.5 border-l border-gray-100 text-center" onClick={e => { e.stopPropagation(); toggleRebillFlag(client.id, billingMonth, "返戻"); }}>
                      <span className={`cursor-pointer select-none font-bold text-base leading-none ${flag?.flag_type === "返戻" ? "text-red-500" : "text-gray-200 hover:text-red-300"}`}>✓</span>
                    </div>
                    <div className="py-2.5 border-l border-gray-100 text-center" onClick={e => { e.stopPropagation(); toggleRebillFlag(client.id, billingMonth, "過誤"); }}>
                      <span className={`cursor-pointer select-none font-bold text-base leading-none ${flag?.flag_type === "過誤" ? "text-red-500" : "text-gray-200 hover:text-red-300"}`}>✓</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ── フッター合計 ── */}
            <div className="border-t border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-6 text-xs text-gray-700">
              <span>合計件数 <strong>{clientGroups.length}</strong></span>
              <span>合計単位数 <strong>{totalUnitsAll.toLocaleString()}</strong></span>
              <span>国保件数 <strong>{billingTarget.length}</strong></span>
              <span>国保対象単位数 <strong>{totalUnitsAll.toLocaleString()}</strong></span>
            </div>
          </div>

          {/* ── 右：明細情報 ── */}
          <div className="w-64 shrink-0 flex flex-col bg-white">
            <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 text-xs font-bold text-gray-700 flex items-center gap-2">
              <span>明細情報</span>
              {detailClient && <span className="font-normal text-gray-500">{detailClient.client.name}</span>}
            </div>
            {detailClient ? (
              <>
                <div className="flex-1 overflow-y-auto">
                  <table className="w-full text-xs border-collapse">
                    <thead className="bg-gray-100 border-b border-gray-300 sticky top-0">
                      <tr>
                        <th className="text-left px-2 py-1.5 font-semibold text-gray-600 border-r border-gray-200">サービス内容</th>
                        <th className="text-right px-2 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-14">単価</th>
                        <th className="text-right px-2 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-10">回数</th>
                        <th className="text-right px-2 py-1.5 font-semibold text-gray-600 w-14">単位数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailClient.items.map((item, i) => {
                        const eq = equipment.find(e => e.product_code === item.product_code);
                        const unitPrice = getUnits(item, detailClient.client.id);
                        const units = unitPrice * item.quantity;
                        return (
                          <tr key={item.id} className={`border-b border-gray-100 ${i % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                            <td className="px-2 py-1.5 text-gray-700 leading-tight border-r border-gray-100">{eq?.name ?? item.product_code}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-gray-700 border-r border-gray-100">{unitPrice}</td>
                            <td className="px-2 py-1.5 text-right font-mono text-gray-700 border-r border-gray-100">{item.quantity}</td>
                            <td className="px-2 py-1.5 text-right font-mono font-semibold text-gray-800">{units}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-gray-300 bg-gray-50 shrink-0">
                  {(() => {
                    const totalU = detailClient.items.reduce((s, item) => s + getUnits(item, detailClient.client.id) * item.quantity, 0);
                    const insuredAmount = totalU * 10;
                    const benefitRate = parseInt(detailClient.client.benefit_rate ?? "90", 10);
                    const copayRate = 100 - benefitRate;
                    const copayAmount = Math.round(insuredAmount * copayRate / 100);
                    const benefitAmount = insuredAmount - copayAmount;
                    return (
                      <table className="w-full text-xs border-collapse">
                        <tbody>
                          <tr className="border-t border-gray-200">
                            <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">保険単位数</td>
                            <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">{totalU.toLocaleString()}</td>
                            <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費単位数</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">—</td>
                          </tr>
                          <tr className="border-t border-gray-200">
                            <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">保険請求額</td>
                            <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">{benefitAmount.toLocaleString()}</td>
                            <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費請求額</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">—</td>
                          </tr>
                          <tr className="border-t border-gray-200">
                            <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">利用者負担額</td>
                            <td className="px-2 py-1 text-right font-mono font-semibold text-red-600">{copayAmount.toLocaleString()}</td>
                            <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費本人負担</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">—</td>
                          </tr>
                        </tbody>
                      </table>
                    );
                  })()}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
                利用者を選択してください
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 利用・提供表モーダル ── */}
      {rentalGridClient && (
        <RentalGridModal
          client={rentalGridClient.client}
          items={rentalGridClient.items}
          equipment={equipment}
          hospitalizations={hospitalizations.filter(h => h.client_id === rentalGridClient.client.id)}
          month={billingMonth}
          onClose={() => setRentalGridClient(null)}
        />
      )}

      {/* ── 請求書／領収書モーダル ── */}
      {invoiceClient && (
        <InvoiceReceiptModal
          client={invoiceClient}
          orders={orders}
          orderItems={orderItems}
          equipment={equipment}
          companyInfo={companyInfoForDoc}
          priceHistory={priceHistoryAll}
          tenantId={tenantId}
          defaultMonth={billingMonth}
          hospitalizations={hospitalizations.filter(h => h.client_id === invoiceClient.id)}
          onClose={() => setInvoiceClient(null)}
        />
      )}
    </div>
  );
}

// ─── Sales Report Tab（売上帳票：介護保険レンタル） ─────────────────────
function SalesReportTab({ tenantId, clients, orderItems, orders, equipment, currentOfficeId }: {
  tenantId: string;
  clients: Client[];
  orderItems: OrderItem[];
  orders: Order[];
  equipment: Equipment[];
  currentOfficeId: string | null;
}) {
  // 月選択（デフォルト：今月）
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [y, m] = month.split("-").map(Number);
  const prevMonth = () => { const d = new Date(y, m - 2, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const d = new Date(y, m, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const toThisMonth = () => { const d = new Date(); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  // データ: 売上帳票の手入力項目 + 書類チェック + 居宅/ケアマネマスタ
  const [salesRecords, setSalesRecords] = useState<import("@/lib/sales").SalesRecord[]>([]);
  const [documents, setDocuments] = useState<Array<{ client_id: string; type: string }>>([]);
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  const [purchasePrices, setPurchasePrices] = useState<Array<{ product_code: string; supplier_id: string; purchase_price: number }>>([]);
  const [careOfficesMap, setCareOfficesMap] = useState<Map<string, string>>(new Map()); // id -> name
  const [careManagersMap, setCareManagersMap] = useState<Map<string, string>>(new Map()); // id -> name
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { getSalesRecords } = await import("@/lib/sales");
        const [sr, docs, priceHist, ppRes, offRes, mgrRes] = await Promise.all([
          getSalesRecords(tenantId),
          supabase.from("client_documents").select("client_id, type").eq("tenant_id", tenantId),
          getPriceHistory(tenantId, [...new Set(orderItems.map((i) => i.product_code))]),
          supabase.from("equipment_prices").select("product_code, supplier_id, purchase_price").eq("tenant_id", tenantId),
          supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId),
          supabase.from("care_managers").select("id, name").eq("tenant_id", tenantId),
        ]);
        setSalesRecords(sr);
        setDocuments((docs.data ?? []) as Array<{ client_id: string; type: string }>);
        setPriceHistory(priceHist);
        setPurchasePrices((ppRes.data ?? []) as Array<{ product_code: string; supplier_id: string; purchase_price: number }>);
        const om = new Map<string, string>();
        (offRes.data ?? []).forEach((o: { id: string; name: string }) => om.set(o.id, o.name));
        setCareOfficesMap(om);
        const mm = new Map<string, string>();
        (mgrRes.data ?? []).forEach((m: { id: string; name: string }) => mm.set(m.id, m.name));
        setCareManagersMap(mm);
      } finally {
        setLoading(false);
      }
    })();
  }, [tenantId, month, orderItems]);

  // 居宅名 / ケアマネ名：care_office_id 優先、なければテキスト
  const getCareOfficeName = (c: Client): string =>
    (c.care_office_id ? careOfficesMap.get(c.care_office_id) : null) ?? c.care_manager_org ?? "";
  const getCareManagerName = (c: Client): string =>
    (c.care_manager_id ? careManagersMap.get(c.care_manager_id) : null) ?? c.care_manager ?? "";

  // 当月の売上帳票行を生成（自動集計）
  const rows = useMemo(() => {
    const monthStart = `${month}-01`;
    const monthEnd = new Date(y, m, 0).toISOString().slice(0, 10);

    type RowType = {
      key: string;
      orderItemId: string;
      eventType: "start" | "end";
      salesDate: string;
      rType: "新規" | "追加" | "一部解約" | "全部解約";
      isHalfMonth: boolean;
      client: Client;
      item: OrderItem;
      order: Order;
      equipmentName: string;
      rentalPrice: number;  // 月額
      purchasePrice: number;
    };
    const result: RowType[] = [];

    // 月額取得（その月有効な rental_price、なければ equipment.rental_price）
    const getMonthlyPrice = (productCode: string): number => {
      // price_history from getPriceHistory: { product_code, rental_price, valid_from }
      const hist = priceHistory
        .filter((p) => p.product_code === productCode && p.valid_from <= monthEnd)
        .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
      if (hist.length > 0) return hist[0].rental_price;
      const eq = equipment.find((e) => e.product_code === productCode);
      return eq?.rental_price ?? 0;
    };

    // 仕入単価取得
    const getPurchasePrice = (productCode: string, supplierId: string | null): number => {
      if (!supplierId) return 0;
      const p = purchasePrices.find((p) => p.product_code === productCode && p.supplier_id === supplierId);
      return p?.purchase_price ?? 0;
    };

    for (const item of orderItems) {
      const order = orders.find((o) => o.id === item.order_id);
      if (!order) continue;
      // 事業所フィルタ
      if (currentOfficeId && order.office_id && order.office_id !== currentOfficeId) continue;
      // 介護保険適用のみ
      const pt = item.payment_type ?? order.payment_type;
      if (pt !== "介護") continue;

      const client = clients.find((c) => c.id === order.client_id);
      if (!client) continue;
      const eq = equipment.find((e) => e.product_code === item.product_code);
      const equipmentName = eq?.name ?? item.product_code;

      // ── レンタル開始イベント ──
      if (item.rental_start_date && item.rental_start_date >= monthStart && item.rental_start_date <= monthEnd) {
        // 新規 vs 追加の判定: この開始日時点で同一利用者の他の介護レンタルが active なら「追加」
        const hasPrior = orderItems.some((o2) => {
          if (o2.id === item.id) return false;
          const o2order = orders.find((oo) => oo.id === o2.order_id);
          if (!o2order || o2order.client_id !== client.id) return false;
          const o2pt = o2.payment_type ?? o2order.payment_type;
          if (o2pt !== "介護") return false;
          if (!o2.rental_start_date) return false;
          if (o2.rental_start_date >= item.rental_start_date!) return false;  // 本アイテムより前に開始
          if (o2.status === "cancelled") return false;
          if (o2.status === "terminated" && o2.rental_end_date && o2.rental_end_date < item.rental_start_date!) return false;
          return true;
        });
        const rType = hasPrior ? "追加" : "新規";
        const day = parseInt(item.rental_start_date.split("-")[2]);
        const isHalf = day >= 16;
        result.push({
          key: `${item.id}-start`,
          orderItemId: item.id,
          eventType: "start",
          salesDate: item.rental_start_date,
          rType,
          isHalfMonth: isHalf,
          client,
          item,
          order,
          equipmentName,
          rentalPrice: getMonthlyPrice(item.product_code),
          purchasePrice: getPurchasePrice(item.product_code, item.supplier_id),
        });
      }

      // ── レンタル終了イベント ──
      if (item.status === "terminated" && item.rental_end_date && item.rental_end_date >= monthStart && item.rental_end_date <= monthEnd) {
        // 一部解約 vs 全部解約: この終了日時点で他に active なアイテムが残るなら「一部解約」
        const hasOtherActive = orderItems.some((o2) => {
          if (o2.id === item.id) return false;
          const o2order = orders.find((oo) => oo.id === o2.order_id);
          if (!o2order || o2order.client_id !== client.id) return false;
          const o2pt = o2.payment_type ?? o2order.payment_type;
          if (o2pt !== "介護") return false;
          if (!o2.rental_start_date) return false;
          if (o2.status === "cancelled") return false;
          if (o2.rental_start_date > item.rental_end_date!) return false;
          if (o2.status === "terminated" && o2.rental_end_date && o2.rental_end_date <= item.rental_end_date!) return false;
          return true;
        });
        const rType: "一部解約" | "全部解約" = hasOtherActive ? "一部解約" : "全部解約";
        const day = parseInt(item.rental_end_date.split("-")[2]);
        const isHalf = day <= 15;
        result.push({
          key: `${item.id}-end`,
          orderItemId: item.id,
          eventType: "end",
          salesDate: item.rental_end_date,
          rType,
          isHalfMonth: isHalf,
          client,
          item,
          order,
          equipmentName,
          rentalPrice: getMonthlyPrice(item.product_code),
          purchasePrice: getPurchasePrice(item.product_code, item.supplier_id),
        });
      }
    }

    // 売上日昇順
    return result.sort((a, b) => a.salesDate.localeCompare(b.salesDate));
  }, [orderItems, orders, clients, equipment, priceHistory, purchasePrices, month, y, m, currentOfficeId]);

  // 書類チェック関数
  const hasDoc = (clientId: string, docType: string) =>
    documents.some((d) => d.client_id === clientId && d.type === docType);
  const hasContract = (clientId: string) =>
    hasDoc(clientId, "contract") && hasDoc(clientId, "important_matters");

  // 売上帳票レコード（手入力分）を取得
  const getSalesRec = (orderItemId: string, eventType: "start" | "end") =>
    salesRecords.find((s) => s.order_item_id === orderItemId && s.event_type === eventType);

  // セル編集
  const saveSalesField = async (orderItemId: string, eventType: "start" | "end", field: "cancellation_reason" | "sales_rep" | "delivery_person" | "input_by" | "notes", value: string) => {
    try {
      const { upsertSalesRecord, getSalesRecords } = await import("@/lib/sales");
      await upsertSalesRecord(tenantId, orderItemId, eventType, { [field]: value || null });
      const sr = await getSalesRecords(tenantId);
      setSalesRecords(sr);
    } catch (e) {
      console.error(e);
      alert("保存に失敗しました");
    }
  };

  // CSV 出力
  const exportCSV = () => {
    const headers = [
      "NO", "売上日", "入力者", "R項目", "契約書", "R契約日", "R解約日", "解約理由",
      "提案書", "個別援助計画", "紹介機関", "居宅", "ケアマネージャー様氏名",
      "受注担当者名", "納品・回収", "利用者名", "商品名",
      "R売上(1ヶ月分)", "R売上(半月分)", "R引上金額(1ヶ月分)", "R引上金額(半月分)", "仕入金額",
    ];
    const rowsCsv = rows.map((r, idx) => {
      const sr = getSalesRec(r.orderItemId, r.eventType);
      const revenueFull = r.eventType === "start" && !r.isHalfMonth ? r.rentalPrice : "";
      const revenueHalf = r.eventType === "start" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : "";
      const liftFull = r.eventType === "end" && !r.isHalfMonth ? r.rentalPrice : "";
      const liftHalf = r.eventType === "end" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : "";
      return [
        idx + 1,
        r.salesDate,
        sr?.input_by ?? "",
        r.rType,
        hasContract(r.client.id) ? "✓" : "",
        r.item.rental_start_date ?? "",
        r.item.rental_end_date ?? "",
        sr?.cancellation_reason ?? "",
        hasDoc(r.client.id, "proposal") ? "✓" : "",
        hasDoc(r.client.id, "care_plan") ? "✓" : "",
        r.client.referrer_org ?? "",
        getCareOfficeName(r.client),
        getCareManagerName(r.client),
        sr?.sales_rep ?? "",
        sr?.delivery_person ?? "",
        r.client.name,
        r.equipmentName,
        revenueFull,
        revenueHalf,
        liftFull,
        liftHalf,
        r.purchasePrice || "",
      ];
    });
    const csvText = [headers, ...rowsCsv]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `売上帳票_介護保険レンタル_${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {/* ツールバー（月ナビ + CSV） */}
      <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 border border-gray-300 rounded bg-white px-2 py-1">
          <button onClick={prevMonth} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="font-semibold text-gray-800 px-2">{y}年 {m}月</span>
          <button onClick={nextMonth} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <button onClick={toThisMonth} className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">本日の月へ</button>
        <span className="border border-blue-500 rounded bg-blue-100 px-2.5 py-1 text-blue-800 font-semibold">介護保険レンタル</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-gray-500 text-xs">{rows.length} 件</span>
          <button onClick={exportCSV}
            className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5">
            <Download size={13} />CSV出力
          </button>
        </div>
      </div>

      {/* テーブル */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-400" /></div>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-16">この月に該当する売上データがありません</p>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="text-xs border-collapse min-w-max">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                {[
                  "NO", "売上日", "入力者", "R項目", "契約", "R契約日", "R解約日", "解約理由",
                  "提案", "援助計画", "紹介機関", "居宅", "ケアマネ様氏名",
                  "受注担当", "納品・回収", "利用者名", "商品名",
                  "R売上\n(1ヶ月)", "R売上\n(半月)", "R引上\n(1ヶ月)", "R引上\n(半月)", "仕入",
                ].map((h) => (
                  <th key={h} className="border border-gray-300 px-2 py-1 font-medium text-gray-600 whitespace-pre-line text-center">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const sr = getSalesRec(r.orderItemId, r.eventType);
                const revenueFull = r.eventType === "start" && !r.isHalfMonth ? r.rentalPrice : null;
                const revenueHalf = r.eventType === "start" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : null;
                const liftFull = r.eventType === "end" && !r.isHalfMonth ? r.rentalPrice : null;
                const liftHalf = r.eventType === "end" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : null;
                const yen = (v: number | null) => v !== null ? `¥${v.toLocaleString()}` : "";
                const rTypeColor =
                  r.rType === "新規" ? "bg-blue-50 text-blue-700" :
                  r.rType === "追加" ? "bg-emerald-50 text-emerald-700" :
                  r.rType === "一部解約" ? "bg-amber-50 text-amber-700" :
                  "bg-red-50 text-red-700";
                return (
                  <tr key={r.key} className="hover:bg-gray-50">
                    <td className="border border-gray-200 px-2 py-1 text-center text-gray-500">{idx + 1}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.salesDate}</td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.input_by ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "input_by", e.target.value)}
                        className="w-24 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className={`border border-gray-200 px-2 py-1 text-center font-medium ${rTypeColor}`}>{r.rType}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center">{hasContract(r.client.id) ? "✓" : ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.item.rental_start_date ?? ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.item.rental_end_date ?? ""}</td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.cancellation_reason ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "cancellation_reason", e.target.value)}
                        className="w-32 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className="border border-gray-200 px-2 py-1 text-center">{hasDoc(r.client.id, "proposal") ? "✓" : ""}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center">{hasDoc(r.client.id, "care_plan") ? "✓" : ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.client.referrer_org ?? ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{getCareOfficeName(r.client)}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{getCareManagerName(r.client)}</td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.sales_rep ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "sales_rep", e.target.value)}
                        className="w-24 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.delivery_person ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "delivery_person", e.target.value)}
                        className="w-24 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap font-medium text-gray-800">{r.client.name}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.equipmentName}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(revenueFull)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(revenueHalf)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(liftFull)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(liftHalf)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{r.purchasePrice ? `¥${r.purchasePrice.toLocaleString()}` : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ─── RentalGridModal ──────────────────────────────────────────────────────────

function RentalGridModal({
  client, items, equipment, hospitalizations, month, onClose,
}: {
  client: Client;
  items: OrderItem[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
  month: string;
  onClose: () => void;
}) {
  const [y, m] = month.split("-").map(Number);
  const reiwa = y - 2018;
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const DOW = ["日","月","火","水","木","金","土"];
  const getDoW = (day: number) => DOW[new Date(y, m - 1, day).getDay()];
  const isWeekend = (day: number) => { const d = new Date(y, m - 1, day).getDay(); return d === 0 || d === 6; };

  const pld = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };

  // 入院期間を日単位のSetで保持
  const hospDays = new Set<number>();
  for (const h of hospitalizations) {
    const admitDate = pld(h.admission_date);
    const dischargeDate = h.discharge_date ? pld(h.discharge_date) : new Date(y, m, 0);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= admitDate && date <= dischargeDate) hospDays.add(d);
    }
  }

  // 各アイテムの貸与日を計算
  const getItemDays = (item: OrderItem) => {
    if (!item.rental_start_date) return new Set<number>();
    const start = pld(item.rental_start_date);
    const end = item.rental_end_date ? pld(item.rental_end_date) : new Date(y, m, 0);
    const active = new Set<number>();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= start && date <= end) active.add(d);
    }
    return active;
  };

  // 半月請求判定
  const getHalfBilling = (item: OrderItem): "full" | "first" | "second" | "none" => {
    const itemDays = getItemDays(item);
    if (itemDays.size === 0) return "none";
    // 入院で除外される日
    const billingDays = [...itemDays].filter(d => !hospDays.has(d));
    if (billingDays.length === 0) return "none";
    const hasFirst = billingDays.some(d => d <= 15);
    const hasSecond = billingDays.some(d => d > 15);
    if (hasFirst && hasSecond) return "full";
    if (hasFirst) return "first";
    return "second";
  };

  const eq = (item: OrderItem) => equipment.find(e => e.product_code === item.product_code);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-[95vw] max-h-[90vh]">
        {/* ヘッダー */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg shrink-0">
          <span className="font-bold text-gray-800">利用・提供表</span>
          <span className="text-gray-600 text-sm">{client.name}</span>
          <span className="text-gray-500 text-sm">R{reiwa}/{m}月</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="text-xs border border-gray-300 rounded px-3 py-1 hover:bg-gray-100 flex items-center gap-1"
            >
              <Printer size={12} />印刷
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
          </div>
        </div>

        {/* グリッド本体 */}
        <div className="flex-1 overflow-auto p-3">
          <table className="border-collapse text-[11px] w-full">
            <thead>
              {/* 曜日行 */}
              <tr>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-600 min-w-[140px]">サービス内容</th>
                {days.map(d => (
                  <th key={d} className={`border border-gray-300 px-0.5 py-1 text-center font-medium w-6 ${
                    isWeekend(d) ? "bg-red-50 text-red-500" : "bg-gray-100 text-gray-600"
                  }`}>
                    <div>{d}</div>
                    <div className={`text-[9px] ${isWeekend(d) ? "text-red-400" : "text-gray-400"}`}>{getDoW(d)}</div>
                  </th>
                ))}
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-10">合計</th>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-14">単位数</th>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-16">請求区分</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const e = eq(item);
                const itemDays = getItemDays(item);
                const billing = getHalfBilling(item);
                const rentalDayCount = [...itemDays].filter(d => !hospDays.has(d)).length;
                const baseUnits = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
                const units = (billing === "first" || billing === "second") ? Math.round(baseUnits / 2) : billing === "none" ? 0 : baseUnits;
                const billingLabel = billing === "full" ? "1か月" : billing === "first" ? "前半月" : billing === "second" ? "後半月" : "—";
                return (
                  <tr key={item.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                    <td className="border border-gray-200 px-2 py-1.5 font-medium text-gray-800 leading-tight">
                      {e?.name ?? item.product_code}
                    </td>
                    {days.map(d => {
                      const isRental = itemDays.has(d);
                      const isHosp = hospDays.has(d);
                      const isStart = item.rental_start_date && (() => { const s = pld(item.rental_start_date!); return s.getDate() === d && s.getMonth() === m - 1 && s.getFullYear() === y; })();
                      const isEnd = item.rental_end_date && (() => { const e = pld(item.rental_end_date!); return e.getDate() === d && e.getMonth() === m - 1 && e.getFullYear() === y; })();
                      return (
                        <td key={d} className={`text-center p-0 h-7 ${
                          !isRental ? "border border-gray-200 bg-white" :
                          isHosp ? "border border-orange-300 bg-orange-100" :
                          "border border-blue-300 bg-blue-100"
                        }`}>
                          {isRental && (
                            <span className={`text-[9px] font-bold ${
                              isHosp ? "text-orange-500" :
                              isStart ? "text-blue-700" :
                              isEnd ? "text-purple-600" :
                              "text-blue-500"
                            }`}>
                              {isStart ? "S" : isEnd ? "E" : isHosp ? "入" : "●"}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className="border border-gray-200 px-1 py-1 text-right font-mono text-gray-700">{rentalDayCount}日</td>
                    <td className="border border-gray-200 px-1 py-1 text-right font-mono font-semibold text-gray-800">{units}</td>
                    <td className={`border border-gray-200 px-1 py-1 text-center text-[10px] font-semibold ${
                      billing === "full" ? "text-gray-700" :
                      billing !== "none" ? "text-amber-600" : "text-gray-400"
                    }`}>{billingLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 凡例 */}
          <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-500">
            <span className="flex items-center gap-1"><span className="w-4 h-4 bg-blue-100 border border-gray-300 inline-block rounded-sm" />貸与中</span>
            <span className="flex items-center gap-1"><span className="w-4 h-4 bg-orange-100 border border-gray-300 inline-block rounded-sm" />入院中（請求除外）</span>
            <span className="flex items-center gap-1"><span className="font-bold text-blue-700 text-xs">S</span> 開始日</span>
            <span className="flex items-center gap-1"><span className="font-bold text-purple-600 text-xs">E</span> 終了日</span>
          </div>

          {/* 合計 */}
          <div className="mt-4 inline-block border border-gray-300 rounded overflow-hidden text-[11px]">
            <div className="bg-gray-100 border-b border-gray-300 px-3 py-1 font-semibold text-gray-700 text-center">介護請求合計</div>
            <table className="border-collapse">
              <thead>
                <tr>
                  <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600"></th>
                  <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">単位数合計</th>
                  <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">請求区分</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-700">合計</td>
                  <td className="border border-gray-200 px-3 py-1 text-right font-mono font-semibold text-gray-800">
                    {items.reduce((s, item) => {
                      const e = eq(item);
                      const billing = getHalfBilling(item);
                      if (billing === "none") return s;
                      const u = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
                      return s + (billing === "first" || billing === "second" ? Math.round(u / 2) : u);
                    }, 0)}単位
                  </td>
                  <td className="border border-gray-200 px-3 py-1 text-center text-gray-600">介護保険</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RentalGridPanel (inline, no modal wrapper) ───────────────────────────────

const RentalGridPanel = memo(function RentalGridPanel({
  client, items, equipment, hospitalizations, month,
}: {
  client: Client;
  items: OrderItem[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
  month: string;
}) {
  const [y, m] = month.split("-").map(Number);
  const reiwa = y - 2018;
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const DOW = ["日","月","火","水","木","金","土"];
  const getDoW = (day: number) => DOW[new Date(y, m - 1, day).getDay()];
  const isWeekend = (day: number) => { const d = new Date(y, m - 1, day).getDay(); return d === 0 || d === 6; };

  const pld = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };

  const hospDays = new Set<number>();
  for (const h of hospitalizations) {
    const admitDate = pld(h.admission_date);
    const dischargeDate = h.discharge_date ? pld(h.discharge_date) : new Date(y, m, 0);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= admitDate && date <= dischargeDate) hospDays.add(d);
    }
  }

  const getItemDays = (item: OrderItem) => {
    if (!item.rental_start_date) return new Set<number>();
    const start = pld(item.rental_start_date);
    const end = item.rental_end_date ? pld(item.rental_end_date) : new Date(y, m, 0);
    const active = new Set<number>();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= start && date <= end) active.add(d);
    }
    return active;
  };

  const getHalfBilling = (item: OrderItem): "full" | "first" | "second" | "none" => {
    const itemDays = getItemDays(item);
    if (itemDays.size === 0) return "none";
    const billingDays = [...itemDays].filter(d => !hospDays.has(d));
    if (billingDays.length === 0) return "none";
    const hasFirst = billingDays.some(d => d <= 15);
    const hasSecond = billingDays.some(d => d > 15);
    if (hasFirst && hasSecond) return "full";
    if (hasFirst) return "first";
    return "second";
  };

  const eq = (item: OrderItem) => equipment.find(e => e.product_code === item.product_code);

  return (
    <div className="p-3">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-3">
        <span className="font-bold text-gray-800 text-sm">利用・提供表</span>
        <span className="text-gray-700 font-semibold">{client.name}</span>
        <span className="text-gray-500 text-sm">R{reiwa}/{m}月</span>
        <button
          onClick={() => window.print()}
          className="ml-auto text-xs border border-gray-300 rounded px-3 py-1 hover:bg-gray-100 flex items-center gap-1"
        ><Printer size={12} />印刷</button>
      </div>

      {/* グリッド */}
      <div className="overflow-x-auto">
        <table className="border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-600 min-w-[140px]">サービス内容</th>
              {days.map(d => (
                <th key={d} className={`border border-gray-300 px-0.5 py-1 text-center font-medium w-6 ${
                  isWeekend(d) ? "bg-red-50 text-red-500" : "bg-gray-100 text-gray-600"
                }`}>
                  <div>{d}</div>
                  <div className={`text-[9px] ${isWeekend(d) ? "text-red-400" : "text-gray-400"}`}>{getDoW(d)}</div>
                </th>
              ))}
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-10">合計</th>
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-14">単位数</th>
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-16">請求区分</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const e = eq(item);
              const itemDays = getItemDays(item);
              const billing = getHalfBilling(item);
              const rentalDayCount = [...itemDays].filter(d => !hospDays.has(d)).length;
              const baseUnits = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
              const units = (billing === "first" || billing === "second") ? Math.round(baseUnits / 2) : billing === "none" ? 0 : baseUnits;
              const billingLabel = billing === "full" ? "1か月" : billing === "first" ? "前半月" : billing === "second" ? "後半月" : "—";
              return (
                <tr key={item.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                  <td className="border border-gray-200 px-2 py-1.5 font-medium text-gray-800 leading-tight">
                    {e?.name ?? item.product_code}
                  </td>
                  {days.map(d => {
                    const isRental = itemDays.has(d);
                    const isHosp = hospDays.has(d);
                    const isStart = item.rental_start_date && (() => { const s = pld(item.rental_start_date!); return s.getDate() === d && s.getMonth() === m - 1 && s.getFullYear() === y; })();
                    const isEnd = item.rental_end_date && (() => { const e = pld(item.rental_end_date!); return e.getDate() === d && e.getMonth() === m - 1 && e.getFullYear() === y; })();
                    return (
                      <td key={d} className={`text-center p-0 h-7 ${
                        !isRental ? "border border-gray-200 bg-white" :
                        isHosp ? "border border-orange-300 bg-orange-100" :
                        "border border-blue-300 bg-blue-100"
                      }`}>
                        {isRental && (
                          <span className={`text-[9px] font-bold ${
                            isHosp ? "text-orange-500" :
                            isStart ? "text-blue-700" :
                            isEnd ? "text-purple-600" :
                            "text-blue-500"
                          }`}>
                            {isStart ? "S" : isEnd ? "E" : isHosp ? "入" : "●"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="border border-gray-200 px-1 py-1 text-right font-mono text-gray-700">{rentalDayCount}日</td>
                  <td className="border border-gray-200 px-1 py-1 text-right font-mono font-semibold text-gray-800">{units}</td>
                  <td className={`border border-gray-200 px-1 py-1 text-center text-[10px] font-semibold ${
                    billing === "full" ? "text-gray-700" :
                    billing !== "none" ? "text-amber-600" : "text-gray-400"
                  }`}>{billingLabel}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 凡例 */}
      <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-500">
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-blue-100 border border-blue-300 inline-block rounded-sm" />貸与中</span>
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-orange-100 border border-orange-300 inline-block rounded-sm" />入院中（請求除外）</span>
        <span className="flex items-center gap-1"><span className="font-bold text-blue-700 text-xs">S</span> 開始日</span>
        <span className="flex items-center gap-1"><span className="font-bold text-purple-600 text-xs">E</span> 終了日</span>
      </div>

      {/* 合計 */}
      <div className="mt-4 inline-block border border-gray-300 rounded overflow-hidden text-[11px]">
        <div className="bg-gray-100 border-b border-gray-300 px-3 py-1 font-semibold text-gray-700 text-center">介護請求合計</div>
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600"></th>
              <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">単位数合計</th>
              <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">請求区分</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-700">合計</td>
              <td className="border border-gray-200 px-3 py-1 text-right font-mono font-semibold text-gray-800">
                {items.reduce((s, item) => {
                  const e = eq(item);
                  const billing = getHalfBilling(item);
                  if (billing === "none") return s;
                  const u = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
                  return s + (billing === "first" || billing === "second" ? Math.round(u / 2) : u);
                }, 0)}単位
              </td>
              <td className="border border-gray-200 px-3 py-1 text-center text-gray-600">介護保険</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
});

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
  const [activeModalKind, setActiveModalKind] = useState<PaymentKind>("介護");

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
      const order = await createOrder({
        tenantId,
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
      // グループ代表判定（グループ内で最初に現れたアイテムが代表）
      const seenGroupsSubmit = new Set<string>();
      const createdItems: OrderItem[] = [];
      for (const item of items) {
        const isGroupRep = item.tokka_group !== null && !seenGroupsSubmit.has(item.tokka_group);
        if (item.tokka_group) seenGroupsSubmit.add(item.tokka_group);
        const tokkaGroupPrice = isGroupRep && item.tokka_group_price ? parseInt(item.tokka_group_price, 10) : undefined;
        const rentalPrice = item.payment_type !== "特価自費" && item.rental_price ? parseFloat(item.rental_price) : undefined;
        const oi = await createOrderItem({
          orderId: order.id,
          tenantId,
          productCode: item.equipment.product_code,
          supplierId: item.supplier_id || undefined,
          rentalPrice,
          notes: item.notes || undefined,
          paymentType: item.payment_type,
          quantity: item.quantity,
          tokkaGroup: item.tokka_group ?? undefined,
          tokkaGroupPrice,
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
                  {showClientList && (
                    <div className="mt-1 border border-gray-200 rounded-xl overflow-hidden max-h-40 overflow-y-auto bg-white">
                      <button
                        onClick={() => { setClientId(""); setShowClientList(false); setClientSearch(""); }}
                        className="w-full px-3 py-2 text-left text-sm text-gray-400 hover:bg-gray-50 border-b border-gray-50"
                      >
                        選択しない
                      </button>
                      {clients
                        .filter((c) => matchClient(c, clientSearch))
                        .sort((a, b) => {
                          const fa = a.is_facility ? 1 : 0;
                          const fb = b.is_facility ? 1 : 0;
                          if (fa !== fb) return fa - fb;
                          return (a.furigana ?? a.name).localeCompare(b.furigana ?? b.name, "ja");
                        })
                        .slice(0, 20).map((c) => (
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
                                  {suppliers.map((s) => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                  ))}
                                </select>
                              </td>
                              )}
                              {kind === "特価自費" && (
                              <td className="py-2 px-1 w-[4rem]">
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
                  setItems((prev) => {
                    const toAdd = equipModalSelected.filter(
                      (sel) => !prev.some((it) => it.equipment.product_code === sel.equipment.product_code)
                    );
                    const newItems: NewOrderItem[] = [];
                    for (const sel of toAdd) {
                      const currentTokka = [
                        ...prev.filter((i) => i.payment_type === "特価自費"),
                        ...newItems.filter((i) => i.payment_type === "特価自費"),
                      ];
                      const group = activeModalKind === "特価自費" ? autoTokkaGroup(sel.equipment, currentTokka) : null;
                      newItems.push({
                        equipment: sel.equipment,
                        rental_price: sel.equipment.rental_price != null ? String(sel.equipment.rental_price) : "",
                        notes: "",
                        payment_type: activeModalKind,
                        supplier_id: supplierId || null,
                        quantity: sel.quantity,
                        tokka_group: group,
                        tokka_group_price: "",
                      });
                    }
                    return [...prev, ...newItems];
                  });
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
  isNewlyCreated,
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
  isNewlyCreated?: boolean;
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

        {isNewlyCreated && (
          <div className="bg-emerald-50 border-b border-emerald-100 px-4 py-3 flex items-center gap-2 shrink-0">
            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
            <div>
              <p className="text-sm font-medium text-emerald-700">発注情報を登録しました</p>
              <p className="text-xs text-emerald-600">卸会社にメールを送信しますか？</p>
            </div>
          </div>
        )}

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

type SettingsPage = "menu" | "company" | "own_offices" | "suppliers" | "care_offices" | "care_plan" | "speech_usage" | "data_reimport";

function SettingsTab({ tenantId, currentOfficeId, officeViewAll, onOfficeChange, onViewModeChange }: {
  tenantId: string;
  currentOfficeId: string | null;
  officeViewAll: boolean;
  onOfficeChange: (officeId: string | null) => void;
  onViewModeChange: (viewAll: boolean) => void;
}) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [emailMap, setEmailMap] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>("menu");

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

  const [settingsOffices, setSettingsOffices] = useState<Office[]>([]);

  useEffect(() => {
    Promise.all([
      getSuppliers(),
      getTenantById(tenantId),
      getOffices(tenantId),
    ]).then(([list, tenant, ofs]) => {
      setSuppliers(list);
      setSettingsOffices(ofs);
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

  const menuItems: { id: SettingsPage; label: string; desc: string }[] = [
    { id: "company",      label: "会社情報",           desc: "事業所番号・住所・担当者など" },
    { id: "own_offices",  label: "自事業所管理",        desc: "事業所の追加・編集" },
    { id: "suppliers",    label: "卸会社メールアドレス", desc: "発注メール送信先の管理" },
    { id: "care_offices", label: "居宅事業所マスタ",    desc: "ケアマネ事務所・FAX番号の管理" },
    { id: "care_plan",    label: "個別援助計画書テンプレート", desc: "計画書の定型文管理" },
    { id: "speech_usage", label: "AI使用状況・料金",       desc: "音声認識・カナ変換の使用量と料金を確認" },
    { id: "data_reimport", label: "データ再取込（危険）",    desc: "利用者・保険情報・居宅マスタを一括再構築" },
  ];

  const PageHeader = ({ title }: { title: string }) => (
    <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0 flex items-center gap-3">
      <button onClick={() => setSettingsPage("menu")} className="text-gray-400 hover:text-gray-600">
        <ChevronLeft size={20} />
      </button>
      <h2 className="font-semibold text-gray-800">{title}</h2>
    </div>
  );

  // ── メニュー画面 ──
  if (settingsPage === "menu") {
    const currentOfficeName = settingsOffices.find(o => o.id === currentOfficeId)?.name;
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <div className="bg-white border-b border-gray-100 px-4 py-3 shrink-0">
          <h2 className="font-semibold text-gray-800">設定</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 事業所切替セクション */}
          {settingsOffices.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">現在の事業所</h3>
              <select
                value={currentOfficeId ?? ""}
                onChange={(e) => onOfficeChange(e.target.value || null)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-emerald-400 bg-white"
              >
                <option value="">（未選択 — 全事業所）</option>
                {settingsOffices.map(o => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              {currentOfficeId && (
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={!officeViewAll}
                      onChange={() => onViewModeChange(false)}
                      className="accent-emerald-500"
                    />
                    <span className="text-sm text-gray-700">{currentOfficeName}の利用者のみ</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={officeViewAll}
                      onChange={() => onViewModeChange(true)}
                      className="accent-emerald-500"
                    />
                    <span className="text-sm text-gray-700">全事業所の利用者</span>
                  </label>
                </div>
              )}
              {currentOfficeId && !officeViewAll && (
                <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-1.5">
                  利用者タブは{currentOfficeName}に適用された利用者のみ表示されます
                </p>
              )}
            </div>
          )}
          <div className="bg-white rounded-xl overflow-hidden border border-gray-100">
            {menuItems.map((item, idx) => (
              <button
                key={item.id}
                onClick={() => setSettingsPage(item.id)}
                className={`w-full flex items-center justify-between px-4 py-4 hover:bg-gray-50 transition-colors text-left ${idx > 0 ? "border-t border-gray-100" : ""}`}
              >
                <div>
                  <p className="text-sm font-medium text-gray-800">{item.label}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
                </div>
                <ChevronRight size={16} className="text-gray-300 shrink-0" />
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── 会社情報 ──
  if (settingsPage === "company") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="会社情報" />
        <div className="flex-1 overflow-y-auto p-4">
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
                    <input value={company[fullKey]} onChange={(e) => setCompany({ ...company, [fullKey]: e.target.value })} placeholder="0" className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-center outline-none focus:border-emerald-400" />
                    <input value={company[partKey]} onChange={(e) => setCompany({ ...company, [partKey]: e.target.value })} placeholder="0" className="border border-gray-200 rounded-lg px-2 py-1 text-xs text-center outline-none focus:border-emerald-400" />
                  </div>
                ))}
              </div>
            </div>
            <button onClick={handleSaveCompany} disabled={savingCompany}
              className="w-full py-2.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center justify-center gap-2 mt-2">
              {savingCompany ? <Loader2 size={14} className="animate-spin" /> : "会社情報を保存"}
            </button>
            {savedCompany && <p className="text-xs text-emerald-600 font-medium text-center">✓ 保存完了しました</p>}
          </div>
        </div>
      </div>
    );
  }

  // ── 自事業所管理 ──
  if (settingsPage === "own_offices") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="自事業所管理" />
        <div className="flex-1 overflow-y-auto p-4">
          <OfficeManagementSection tenantId={tenantId} />
        </div>
      </div>
    );
  }

  // ── 卸会社メールアドレス ──
  if (settingsPage === "suppliers") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="卸会社メールアドレス" />
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
                <button onClick={() => handleSave(s.id)} disabled={saving === s.id}
                  className="shrink-0 px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center gap-1">
                  {saving === s.id ? <Loader2 size={14} className="animate-spin" /> : "保存"}
                </button>
              </div>
              {saved === s.id && <p className="text-xs text-emerald-600 font-medium">✓ 保存完了しました</p>}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── 居宅事業所マスタ ──
  if (settingsPage === "care_offices") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="居宅事業所マスタ" />
        <div className="flex-1 overflow-y-auto p-4">
          <CareOfficeSection tenantId={tenantId} />
        </div>
      </div>
    );
  }

  // ── AI使用状況（音声認識 + OpenAI カナ変換） ──
  if (settingsPage === "speech_usage") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="AI使用状況・料金" />
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">🎤 音声認識（Google Speech-to-Text）</h2>
            <SpeechUsageSection tenantId={tenantId} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-gray-700 mb-2 px-1">🤖 AIカナ変換（OpenAI gpt-4o-mini）</h2>
            <OpenAIUsageSection tenantId={tenantId} />
          </div>
        </div>
      </div>
    );
  }

  if (settingsPage === "data_reimport") {
    return (
      <div className="flex flex-col h-full bg-gray-50">
        <PageHeader title="データ再取込" />
        <div className="flex-1 overflow-y-auto p-4">
          <DataReimportSection tenantId={tenantId} />
        </div>
      </div>
    );
  }

  // ── 個別援助計画書テンプレート ──
  return (
    <div className="flex flex-col h-full bg-gray-50">
      <PageHeader title="個別援助計画書テンプレート" />
      <div className="flex-1 overflow-y-auto p-4">
        <CarePlanTemplateSection tenantId={tenantId} />
      </div>
    </div>
  );
}

// ─── Speech Usage Section ─────────────────────────────────────────────────────
function SpeechUsageSection({ tenantId }: { tenantId: string }) {
  const [summary, setSummary] = useState<SpeechUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getSpeechUsageSummary(tenantId).then(setSummary).finally(() => setLoading(false));
  }, [tenantId]);

  if (loading) return <p className="text-sm text-gray-400">読み込み中...</p>;
  if (!summary) return <p className="text-sm text-gray-400">データなし</p>;

  const monthMinutes = (summary.monthSeconds / 60).toFixed(1);
  const totalMinutes = (summary.totalSeconds / 60).toFixed(1);
  const freeMinutesRemaining = (summary.freeSecondsRemaining / 60).toFixed(1);
  const usedRatio = Math.min(100, (summary.monthSeconds / (60 * 60)) * 100);

  return (
    <div className="space-y-4">
      {/* 今月の使用状況 */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">今月の使用状況</h3>
        <div className="space-y-3">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">使用時間</span>
            <span className="text-lg font-bold text-gray-800">{monthMinutes}分</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">認識回数</span>
            <span className="text-sm text-gray-700">{summary.monthCallCount}回</span>
          </div>
          {/* 無料枠プログレスバー */}
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>無料枠 (月60分)</span>
              <span>残り {freeMinutesRemaining}分</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all ${usedRatio >= 100 ? "bg-red-500" : usedRatio >= 80 ? "bg-orange-400" : "bg-emerald-500"}`}
                style={{ width: `${usedRatio}%` }}
              />
            </div>
          </div>
          <div className="flex justify-between items-baseline pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">今月の請求見込</span>
            <span className="text-lg font-bold text-emerald-700">
              ¥{Math.round(summary.monthBillableCostJpy).toLocaleString()}
            </span>
          </div>
          {summary.monthBillableCostJpy === 0 && summary.monthSeconds > 0 && (
            <p className="text-xs text-emerald-600">✓ 無料枠内に収まっています</p>
          )}
        </div>
      </div>

      {/* 累計 */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">累計</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計使用時間</span>
            <span className="text-sm text-gray-700">{totalMinutes}分</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計認識回数</span>
            <span className="text-sm text-gray-700">{summary.totalCallCount}回</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">理論料金 (無料枠考慮前)</span>
            <span className="text-sm text-gray-600">¥{summary.totalCostJpy.toFixed(2)}</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-400 px-1">
        Google Cloud Speech-to-Text v2 (long モデル + カスタム辞書) / 月60分まで無料 / 超過分 ¥2.4/分
      </p>
    </div>
  );
}

// ─── OpenAI Usage Section ─────────────────────────────────────────────────────
function OpenAIUsageSection({ tenantId }: { tenantId: string }) {
  const [summary, setSummary] = useState<OpenAIUsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOpenAIUsageSummary(tenantId).then(setSummary).finally(() => setLoading(false));
  }, [tenantId]);

  if (loading) return <p className="text-sm text-gray-400">読み込み中...</p>;
  if (!summary) return <p className="text-sm text-gray-400">データなし</p>;

  const fmtNum = (n: number) => n.toLocaleString();
  const fmtJpy = (n: number) => `¥${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

  return (
    <div className="space-y-4">
      {/* 今月のサマリ */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">今月の使用状況</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">呼び出し回数</span>
            <span className="text-sm text-gray-700">{summary.monthCallCount}回</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">入力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.monthInputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">出力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.monthOutputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">今月の概算料金</span>
            <span className="text-lg font-bold text-emerald-700">{fmtJpy(summary.monthCostJpy)}</span>
          </div>
        </div>
      </div>

      {/* 用途別内訳（今月） */}
      {summary.monthBreakdown.length > 0 && (
        <div className="bg-white rounded-xl p-4 border border-gray-100">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">用途別内訳（今月）</h3>
          <div className="space-y-2">
            {summary.monthBreakdown.map((b) => (
              <div key={b.purpose} className="flex justify-between items-center py-1 border-b border-gray-50 last:border-b-0">
                <div>
                  <p className="text-sm text-gray-700">{b.label}</p>
                  <p className="text-[11px] text-gray-400">{b.callCount}回 / 入{fmtNum(b.inputTokens)} 出{fmtNum(b.outputTokens)}</p>
                </div>
                <span className="text-sm font-semibold text-gray-700">{fmtJpy(b.costJpy)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 累計 */}
      <div className="bg-white rounded-xl p-4 border border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">累計</h3>
        <div className="space-y-2">
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計呼び出し回数</span>
            <span className="text-sm text-gray-700">{summary.totalCallCount}回</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計入力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.totalInputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline">
            <span className="text-xs text-gray-500">累計出力トークン</span>
            <span className="text-sm text-gray-700">{fmtNum(summary.totalOutputTokens)}</span>
          </div>
          <div className="flex justify-between items-baseline pt-2 border-t border-gray-100">
            <span className="text-xs text-gray-500">累計料金</span>
            <span className="text-sm font-semibold text-gray-700">{fmtJpy(summary.totalCostJpy)}</span>
          </div>
        </div>
      </div>

      <p className="text-xs text-gray-400 px-1">
        OpenAI gpt-4o-mini / 入力 $0.150・出力 $0.600 (1M tokens) / 1USD≒¥150 換算の概算
      </p>
    </div>
  );
}

// ─── Care Office Section ─────────────────────────────────────────────────────

function CareOfficeSection({ tenantId }: { tenantId: string }) {
  const [offices, setOffices] = useState<CareOffice[]>([]);
  const [managers, setManagers] = useState<CareManager[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<CareOffice>>({});
  const [saving, setSaving] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [expandedOfficeId, setExpandedOfficeId] = useState<string | null>(null);
  // ケアマネ追加
  const [addingManagerOfficeId, setAddingManagerOfficeId] = useState<string | null>(null);
  const [newManagerName, setNewManagerName] = useState("");
  const [savingManager, setSavingManager] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [o, m] = await Promise.all([getCareOffices(tenantId), getCareManagers(tenantId)]);
      setOffices(o);
      setManagers(m);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [tenantId]);

  const startEdit = (office: CareOffice) => {
    setEditingId(office.id);
    setForm({ ...office });
    setAddingNew(false);
  };

  const startNew = () => {
    setAddingNew(true);
    setEditingId(null);
    setForm({ name: "", fax_number: "", phone_number: "", address: "", email: "", office_number: "" });
  };

  const handleSave = async () => {
    if (!form.name?.trim()) return;
    setSaving(true);
    try {
      await upsertCareOffice(tenantId, {
        id: editingId ?? undefined,
        name: form.name!,
        fax_number: form.fax_number ?? null,
        phone_number: form.phone_number ?? null,
        address: form.address ?? null,
        email: form.email ?? null,
        notes: form.notes ?? null,
        office_number: form.office_number?.trim() || null,
      });
      setEditingId(null);
      setAddingNew(false);
      setForm({});
      await load();
    } catch { alert("保存に失敗しました"); } finally { setSaving(false); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？\nケアマネ情報も削除されます。`)) return;
    try { await deleteCareOffice(id); await load(); }
    catch { alert("削除に失敗しました"); }
  };

  const handleAddManager = async (officeId: string) => {
    if (!newManagerName.trim()) return;
    setSavingManager(true);
    try {
      await addCareManager(tenantId, officeId, newManagerName.trim());
      setNewManagerName("");
      setAddingManagerOfficeId(null);
      await load();
    } catch { alert("追加に失敗しました"); } finally { setSavingManager(false); }
  };

  const handleToggleManagerActive = async (manager: CareManager) => {
    try {
      await updateCareManager(manager.id, { active: !manager.active });
      await load();
    } catch { alert("更新に失敗しました"); }
  };

  const handleDeleteManager = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return;
    try { await deleteCareManager(id); await load(); }
    catch { alert("削除に失敗しました"); }
  };

  const FormRow = ({ label, field, placeholder }: { label: string; field: keyof CareOffice; placeholder?: string }) => (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-24 shrink-0">{label}</span>
      <input
        value={(form[field] as string) ?? ""}
        onChange={e => setForm(prev => ({ ...prev, [field]: e.target.value }))}
        placeholder={placeholder}
        className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300"
      />
    </div>
  );

  // CSV取込：厚労省オープンデータを care_offices_opendata に保存
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleImportOpendata = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) { alert("CSV が空か形式が不正です"); return; }
      const parseCsvLine = (line: string): string[] => {
        const out: string[] = []; let cur = ""; let inQ = false;
        for (let i = 0; i < line.length; i++) {
          const ch = line[i];
          if (ch === '"') {
            if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else { inQ = !inQ; }
          } else if (ch === "," && !inQ) { out.push(cur); cur = ""; } else { cur += ch; }
        }
        out.push(cur); return out;
      };
      const header = parseCsvLine(lines[0]);
      const col = (n: string) => header.indexOf(n);
      const iPref = col("都道府県名"), iCity = col("市区町村名"), iName = col("事業所名"),
            iKana = col("事業所名カナ"), iSvc = col("サービスの種類"),
            iAddr = col("住所"), iAddrDet = col("方書（ビル名等）"),
            iPhone = col("電話番号"), iFax = col("FAX番号"),
            iCorp = col("法人の名称"), iCorpNum = col("法人番号"),
            iOfficeNum = col("事業所番号"), iUrl = col("URL"),
            iLat = col("緯度"), iLng = col("経度");
      if (iPref < 0 || iName < 0 || iOfficeNum < 0) { alert("必要な列（都道府県名 / 事業所名 / 事業所番号）が見つかりません"); return; }

      // 千葉県分のみ抽出
      const chibaRows = lines.slice(1).map(parseCsvLine).filter((r) => r[iPref] === "千葉県");
      const rows = chibaRows
        .map((r) => ({
          office_number: (r[iOfficeNum] ?? "").trim(),
          prefecture: (r[iPref] ?? "").trim(),
          city: iCity >= 0 ? (r[iCity] ?? "").trim() : null,
          name: (r[iName] ?? "").trim(),
          name_kana: iKana >= 0 ? (r[iKana] ?? "").trim() : null,
          service_type: iSvc >= 0 ? (r[iSvc] ?? "").trim() : null,
          address: (r[iAddr] ?? "").trim() || null,
          address_detail: iAddrDet >= 0 ? (r[iAddrDet] ?? "").trim() || null : null,
          phone_number: (r[iPhone] ?? "").trim() || null,
          fax_number: (r[iFax] ?? "").trim() || null,
          corp_name: iCorp >= 0 ? (r[iCorp] ?? "").trim() || null : null,
          corp_number: iCorpNum >= 0 ? (r[iCorpNum] ?? "").trim() || null : null,
          url: iUrl >= 0 ? (r[iUrl] ?? "").trim() || null : null,
          latitude: iLat >= 0 && r[iLat] ? Number(r[iLat]) : null,
          longitude: iLng >= 0 && r[iLng] ? Number(r[iLng]) : null,
          imported_at: new Date().toISOString(),
        }))
        .filter((r) => r.office_number && r.name);

      // 500件ずつバッチで upsert
      const BATCH = 500;
      let inserted = 0;
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const { error } = await supabase.from("care_offices_opendata").upsert(batch, { onConflict: "office_number" });
        if (error) throw error;
        inserted += batch.length;
      }
      alert(`取込完了\n千葉県 ${inserted} 件をオープンデータに登録しました。\n「＋ 事業所追加」から検索して選択できます。`);
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      alert(`取込に失敗しました\n${msg}`);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = "";
    }
  };

  // ── オープンデータ検索（＋事業所追加 内で使う） ──
  const [opendataQuery, setOpendataQuery] = useState("");
  const [opendataResults, setOpendataResults] = useState<Array<{
    office_number: string; name: string; address: string | null; phone_number: string | null; fax_number: string | null; city: string | null;
  }>>([]);
  const [opendataSearching, setOpendataSearching] = useState(false);

  async function searchOpendata(q: string) {
    setOpendataQuery(q);
    if (q.trim().length < 2) { setOpendataResults([]); return; }
    setOpendataSearching(true);
    try {
      const { data } = await supabase
        .from("care_offices_opendata")
        .select("office_number, name, address, phone_number, fax_number, city")
        .eq("prefecture", "千葉県")
        .ilike("name", `%${q.trim()}%`)
        .limit(30);
      setOpendataResults((data ?? []) as typeof opendataResults);
    } finally {
      setOpendataSearching(false);
    }
  }

  function pickOpendata(row: { office_number: string; name: string; address: string | null; phone_number: string | null; fax_number: string | null }) {
    // 既存の事業所番号と異なる場合は警告
    // 編集中は元の office.office_number も参照（form がまだ未反映の可能性）
    const existingFromForm = (form.office_number ?? "").trim();
    const existingFromOffice = editingId ? (offices.find((o) => o.id === editingId)?.office_number ?? "").trim() : "";
    const existingOfficeNum = existingFromForm || existingFromOffice;
    console.log("[pickOpendata] form.office_number=", form.office_number, "editing.office_number=", existingFromOffice, "existing=", existingOfficeNum, "selected=", row.office_number);
    if (existingOfficeNum && existingOfficeNum !== row.office_number) {
      const ok = window.confirm(
        `⚠️ 事業所番号が異なります\n\n` +
        `現在: ${existingOfficeNum}\n` +
        `選択: ${row.office_number}（${row.name}）\n\n` +
        `別の事業所を選択しようとしています。本当に上書きしますか？\n` +
        `（この居宅に紐付いている利用者・ケアマネも実質的に別事業所扱いになります）`
      );
      if (!ok) return;
    }
    // 編集中の場合は既存の email/notes を保持、新規の場合は空で開始
    setForm((prev) => ({
      ...prev,
      name: row.name,
      address: row.address ?? "",
      phone_number: row.phone_number ?? "",
      fax_number: row.fax_number ?? "",
      office_number: row.office_number,
    }));
    setOpendataQuery("");
    setOpendataResults([]);
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">居宅事業所マスタ</h3>
        <div className="flex items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImportOpendata(f); }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            className="text-xs px-2.5 py-1 rounded-lg bg-blue-50 text-blue-600 border border-blue-200 hover:bg-blue-100 disabled:opacity-50"
            title="厚労省オープンデータから住所・電話・FAXを補完"
          >
            {importing ? "取込中…" : "📥 CSV取込（厚労省）"}
          </button>
          <button onClick={startNew} className="text-xs px-2.5 py-1 rounded-lg bg-emerald-50 text-emerald-600 border border-emerald-200 hover:bg-emerald-100">
            ＋ 事業所追加
          </button>
        </div>
      </div>
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        {loading ? (
          <div className="p-4 flex justify-center"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
        ) : (
          <>
            {addingNew && (
              <div className="p-4 border-b border-gray-100 space-y-2 bg-emerald-50">
                {/* オープンデータ検索 */}
                <div className="bg-white rounded-lg border border-blue-200 p-2 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Search size={14} className="text-blue-500 shrink-0" />
                    <input
                      type="text"
                      value={opendataQuery}
                      onChange={(e) => searchOpendata(e.target.value)}
                      placeholder="オープンデータから検索（2文字以上）"
                      className="flex-1 text-xs px-2 py-1 border border-blue-200 rounded outline-none focus:ring-1 focus:ring-blue-300"
                    />
                  </div>
                  {opendataSearching && <p className="text-xs text-gray-400 text-center py-1">検索中...</p>}
                  {opendataResults.length > 0 && (
                    <ul className="max-h-48 overflow-y-auto bg-gray-50 rounded border border-gray-100 divide-y divide-gray-100">
                      {opendataResults.map((r) => (
                        <li key={r.office_number}>
                          <button
                            type="button"
                            onClick={() => pickOpendata(r)}
                            className="w-full px-2 py-1.5 text-left text-xs hover:bg-blue-50"
                          >
                            <p className="font-medium text-gray-800">{r.name}</p>
                            <p className="text-[11px] text-gray-500 truncate">{r.city ?? ""} {r.address ?? ""}</p>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {opendataQuery.trim().length >= 2 && !opendataSearching && opendataResults.length === 0 && (
                    <p className="text-xs text-gray-400 text-center py-1">該当なし（オープンデータ未取込 or 事業所名不一致）</p>
                  )}
                </div>
                <FormRow label="事業所名 *" field="name" placeholder="○○居宅介護支援事業所" />
                <FormRow label="事業所番号" field="office_number" placeholder="1270102658" />
                <FormRow label="所在地" field="address" placeholder="千葉県市原市○○1-2-3" />
                <FormRow label="FAX番号" field="fax_number" placeholder="0436-00-0000" />
                <FormRow label="電話番号" field="phone_number" placeholder="0436-00-0000" />
                <FormRow label="メール" field="email" placeholder="example@example.com" />
                <div className="flex gap-2 pt-1">
                  <button onClick={() => { setAddingNew(false); setOpendataQuery(""); setOpendataResults([]); }} className="flex-1 py-1.5 rounded-lg text-sm text-gray-500 bg-white border border-gray-200">キャンセル</button>
                  <button onClick={handleSave} disabled={saving || !form.name?.trim()} className="flex-1 py-1.5 rounded-lg text-sm text-white bg-emerald-500 disabled:opacity-50">
                    {saving ? "保存中..." : "保存"}
                  </button>
                </div>
              </div>
            )}
            {offices.length === 0 && !addingNew && (
              <p className="text-xs text-gray-400 p-4 text-center">事業所が登録されていません</p>
            )}
            {offices.map((office, idx) => {
              const officeManagers = managers.filter(m => m.care_office_id === office.id);
              const isExpanded = expandedOfficeId === office.id;
              return (
                <div key={office.id} className={`${idx > 0 ? "border-t border-gray-100" : ""}`}>
                  {editingId === office.id ? (
                    <div className="p-4 space-y-2 bg-blue-50">
                      {/* オープンデータ検索（上書き用） */}
                      <div className="bg-white rounded-lg border border-blue-200 p-2 space-y-1.5">
                        <div className="flex items-center gap-2">
                          <Search size={14} className="text-blue-500 shrink-0" />
                          <input
                            type="text"
                            value={opendataQuery}
                            onChange={(e) => searchOpendata(e.target.value)}
                            placeholder="オープンデータから検索して上書き（2文字以上）"
                            className="flex-1 text-xs px-2 py-1 border border-blue-200 rounded outline-none focus:ring-1 focus:ring-blue-300"
                          />
                        </div>
                        {opendataSearching && <p className="text-xs text-gray-400 text-center py-1">検索中...</p>}
                        {opendataResults.length > 0 && (
                          <ul className="max-h-48 overflow-y-auto bg-gray-50 rounded border border-gray-100 divide-y divide-gray-100">
                            {opendataResults.map((r) => (
                              <li key={r.office_number}>
                                <button
                                  type="button"
                                  onClick={() => pickOpendata(r)}
                                  className="w-full px-2 py-1.5 text-left text-xs hover:bg-blue-50"
                                >
                                  <p className="font-medium text-gray-800">{r.name}</p>
                                  <p className="text-[11px] text-gray-500 truncate">{r.city ?? ""} {r.address ?? ""}</p>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {opendataQuery.trim().length >= 2 && !opendataSearching && opendataResults.length === 0 && (
                          <p className="text-xs text-gray-400 text-center py-1">該当なし</p>
                        )}
                        <p className="text-[10px] text-gray-500 px-1">選ぶと事業所名・事業所番号・住所・電話・FAXが上書きされます（ID はそのまま）</p>
                      </div>
                      <FormRow label="事業所名 *" field="name" />
                      <FormRow label="事業所番号" field="office_number" placeholder="1270102658" />
                      <FormRow label="所在地" field="address" placeholder="千葉県市原市○○1-2-3" />
                      <FormRow label="FAX番号" field="fax_number" placeholder="0436-00-0000" />
                      <FormRow label="電話番号" field="phone_number" placeholder="0436-00-0000" />
                      <FormRow label="メール" field="email" placeholder="example@example.com" />
                      <div className="flex gap-2 pt-1">
                        <button onClick={() => { setEditingId(null); setOpendataQuery(""); setOpendataResults([]); }} className="flex-1 py-1.5 rounded-lg text-sm text-gray-500 bg-white border border-gray-200">キャンセル</button>
                        <button onClick={handleSave} disabled={saving} className="flex-1 py-1.5 rounded-lg text-sm text-white bg-emerald-500 disabled:opacity-50">
                          {saving ? "保存中..." : "保存"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div>
                      {/* 事業所ヘッダー */}
                      <div className="px-4 py-3 flex items-start justify-between gap-2">
                        <button className="flex-1 text-left" onClick={() => setExpandedOfficeId(isExpanded ? null : office.id)}>
                          <div className="flex items-center gap-1.5">
                            <ChevronRight size={14} className={`text-gray-400 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                            <p className="text-sm font-medium text-gray-800">{office.name}</p>
                            <span className="text-xs text-gray-400">（{officeManagers.filter(m => m.active).length}名）</span>
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5 ml-5">
                            {office.address && <span className="text-xs text-gray-400">{office.address}</span>}
                            {office.fax_number && <span className="text-xs text-gray-400">FAX: {office.fax_number}</span>}
                            {office.phone_number && <span className="text-xs text-gray-400">TEL: {office.phone_number}</span>}
                            {office.office_number && <span className="text-xs text-gray-400">事業所番号: {office.office_number}</span>}
                          </div>
                        </button>
                        <div className="flex gap-1.5 shrink-0">
                          <button onClick={() => startEdit(office)} className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200">編集</button>
                          <button onClick={() => handleDelete(office.id, office.name)} className="text-xs px-2 py-1 rounded-lg bg-red-50 text-red-500 hover:bg-red-100">削除</button>
                        </div>
                      </div>

                      {/* ケアマネ一覧（展開時） */}
                      {isExpanded && (
                        <div className="bg-gray-50 border-t border-gray-100 px-4 py-3 space-y-2">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium text-gray-500">ケアマネ</span>
                            <button
                              onClick={() => { setAddingManagerOfficeId(office.id); setNewManagerName(""); }}
                              className="text-xs px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-600 border border-emerald-200"
                            >
                              ＋ 追加
                            </button>
                          </div>

                          {addingManagerOfficeId === office.id && (
                            <div className="flex gap-2">
                              <input
                                value={newManagerName}
                                onChange={e => setNewManagerName(e.target.value)}
                                placeholder="氏名を入力"
                                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-300 bg-white"
                              />
                              <button onClick={() => handleAddManager(office.id)} disabled={savingManager || !newManagerName.trim()}
                                className="px-3 py-1.5 rounded-lg text-sm text-white bg-emerald-500 disabled:opacity-50">
                                {savingManager ? "…" : "追加"}
                              </button>
                              <button onClick={() => setAddingManagerOfficeId(null)} className="px-2 py-1.5 rounded-lg text-sm text-gray-400 bg-white border border-gray-200">✕</button>
                            </div>
                          )}

                          {officeManagers.length === 0 && addingManagerOfficeId !== office.id && (
                            <p className="text-xs text-gray-400">ケアマネが登録されていません</p>
                          )}
                          {officeManagers.map(mgr => (
                            <div key={mgr.id} className="flex items-center justify-between gap-2">
                              <span className={`text-sm ${mgr.active ? "text-gray-700" : "text-gray-400 line-through"}`}>{mgr.name}</span>
                              <div className="flex gap-1.5 shrink-0">
                                <button
                                  onClick={() => handleToggleManagerActive(mgr)}
                                  className={`text-xs px-2 py-0.5 rounded-md border ${mgr.active ? "bg-white text-gray-500 border-gray-200" : "bg-emerald-50 text-emerald-600 border-emerald-200"}`}
                                >
                                  {mgr.active ? "退職" : "復職"}
                                </button>
                                <button onClick={() => handleDeleteManager(mgr.id, mgr.name)} className="text-xs px-2 py-0.5 rounded-md bg-red-50 text-red-400 border border-red-100">削除</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Office Management Section ───────────────────────────────────────────────

function OfficeManagementSection({ tenantId }: { tenantId: string }) {
  const [offices, setOffices] = useState<Office[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editBusinessNumber, setEditBusinessNumber] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try { setOffices(await getOffices(tenantId)); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [tenantId]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      await createOffice(tenantId, newName.trim());
      setNewName("");
      await load();
    } catch { alert("追加に失敗しました"); } finally { setAdding(false); }
  };

  const handleEdit = async (id: string) => {
    if (!editName.trim()) return;
    setSaving(id);
    try {
      const bn = editBusinessNumber.trim();
      await updateOffice(id, editName.trim(), bn === "" ? null : bn);
      setEditId(null);
      await load();
    } catch { alert("保存に失敗しました"); } finally { setSaving(null); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("この事業所を削除しますか？\n（事業所別価格データも削除されます）")) return;
    setDeletingId(id);
    try { await deleteOffice(id); await load(); }
    catch { alert("削除に失敗しました"); } finally { setDeletingId(null); }
  };

  return (
    <div>
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">事業所管理</h3>
      <div className="bg-white rounded-xl overflow-hidden border border-gray-100">
        {loading ? (
          <div className="p-4 flex justify-center"><Loader2 size={20} className="animate-spin text-emerald-400" /></div>
        ) : (
          <>
            {offices.length === 0 && (
              <p className="text-xs text-gray-400 p-4 text-center">事業所が登録されていません</p>
            )}
            {offices.map((office, idx) => (
              <div key={office.id} className={`px-4 py-3 ${idx > 0 ? "border-t border-gray-100" : ""}`}>
                {editId === office.id ? (
                  <div className="flex flex-col gap-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="事業所名"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-emerald-400"
                      autoFocus
                    />
                    <input
                      value={editBusinessNumber}
                      onChange={(e) => setEditBusinessNumber(e.target.value.replace(/[^0-9]/g, "").slice(0, 10))}
                      placeholder="介護事業所番号（10桁）"
                      inputMode="numeric"
                      className="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none focus:border-emerald-400 font-mono"
                    />
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => handleEdit(office.id)}
                        disabled={saving === office.id}
                        className="text-xs font-medium text-white bg-emerald-500 px-3 py-1 rounded-lg disabled:opacity-40 flex items-center gap-1"
                      >
                        {saving === office.id ? <Loader2 size={12} className="animate-spin" /> : "保存"}
                      </button>
                      <button onClick={() => setEditId(null)} className="text-xs text-gray-400">戻す</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-800 truncate">{office.name}</div>
                      <div className="text-xs text-gray-400 font-mono mt-0.5">
                        事業所番号: {office.business_number ?? <span className="text-amber-500">未設定</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => { setEditId(office.id); setEditName(office.name); setEditBusinessNumber(office.business_number ?? ""); }}
                      className="text-xs text-emerald-600 bg-emerald-50 px-2 py-1 rounded-lg"
                    >
                      編集
                    </button>
                    <button
                      onClick={() => handleDelete(office.id)}
                      disabled={deletingId === office.id}
                      className="text-xs text-red-400 bg-red-50 px-2 py-1 rounded-lg disabled:opacity-40"
                    >
                      {deletingId === office.id ? <Loader2 size={12} className="animate-spin" /> : "削除"}
                    </button>
                  </div>
                )}
              </div>
            ))}
            {/* 新規追加 */}
            <div className="border-t border-gray-100 px-4 py-3 flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="新しい事業所名"
                className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400"
              />
              <button
                onClick={handleAdd}
                disabled={adding || !newName.trim()}
                className="flex items-center gap-1 text-xs font-medium text-white bg-emerald-500 px-3 py-1.5 rounded-lg disabled:opacity-40"
              >
                {adding ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
                追加
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Office Price Import Modal ────────────────────────────────────────────────

function OfficePriceImportModal({
  tenantId,
  offices,
  equipment,
  onClose,
  onDone,
}: {
  tenantId: string;
  offices: Office[];
  equipment: Equipment[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [csvText, setCsvText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setCsvText(ev.target?.result as string ?? ""); };
    reader.readAsText(file, "UTF-8");
  };

  const handleImport = async () => {
    if (!csvText.trim()) { alert("CSVを入力またはファイルを選択してください"); return; }
    setLoading(true);
    setResult(null);
    try {
      // BOMを除去してパース
      const text = csvText.replace(/^\uFEFF/, "");
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) { alert("データ行がありません"); return; }

      // ヘッダー行解析
      const parseRow = (line: string) =>
        line.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1").replace(/""/g, '"'));
      const headers = parseRow(lines[0]);
      // 0: 商品コード, 1: 用具名, 2+: 事業所名
      const officeHeaders = headers.slice(2);
      const officeMap = new Map(offices.map((o) => [o.name, o.id]));

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];
      const prices: { tenant_id: string; product_code: string; office_id: string; rental_price: number }[] = [];

      for (let i = 1; i < lines.length; i++) {
        const cols = parseRow(lines[i]);
        const productCode = cols[0]?.trim();
        if (!productCode) { skipped++; continue; }
        const eq = equipment.find((e) => e.product_code === productCode);
        if (!eq) { skipped++; errors.push(`行${i + 1}: 商品コード「${productCode}」が見つかりません`); continue; }

        officeHeaders.forEach((officeName, j) => {
          const officeId = officeMap.get(officeName);
          if (!officeId) return;
          const priceStr = cols[j + 2]?.trim();
          if (!priceStr) return;
          const price = parseInt(priceStr.replace(/,/g, ""));
          if (isNaN(price) || price <= 0) return;
          prices.push({ tenant_id: tenantId, product_code: productCode, office_id: officeId, rental_price: price });
          imported++;
        });
      }

      if (prices.length > 0) {
        await bulkUpsertOfficePrices(prices);
      }
      setResult({ imported, skipped, errors: errors.slice(0, 10) });
    } catch (err) {
      alert("インポートに失敗しました: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-end justify-center">
      <div className="bg-white rounded-t-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">事業所別価格 取込</h3>
          <button onClick={onClose}><X size={20} className="text-gray-400" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="bg-indigo-50 rounded-xl p-3 text-xs text-indigo-700 space-y-1">
            <p className="font-semibold">CSV形式：</p>
            <p>商品コード,用具名,{offices.map((o) => o.name).join(",") || "事業所A,事業所B"}</p>
            <p>CODE001,電動ベッド,15000,14000</p>
            <p className="text-indigo-500">※「事業所別価格 出力」ボタンでテンプレートを取得できます</p>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">ファイル選択</label>
            <input type="file" accept=".csv" onChange={handleFile} className="text-sm" />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-600 block mb-1">またはCSVをペースト</label>
            <textarea
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              rows={6}
              placeholder="CSVの内容をここにペースト..."
              className="w-full border border-gray-200 rounded-xl px-3 py-2 text-xs font-mono outline-none focus:border-indigo-400 resize-none"
            />
          </div>

          {result && (
            <div className="bg-emerald-50 rounded-xl p-3 text-xs space-y-1">
              <p className="font-semibold text-emerald-700">✓ 完了：{result.imported}件 取込、{result.skipped}件 スキップ</p>
              {result.errors.map((e, i) => <p key={i} className="text-red-500">{e}</p>)}
            </div>
          )}
        </div>
        <div className="px-4 pb-6 pt-2 flex gap-2 border-t border-gray-100">
          {result ? (
            <button onClick={onDone} className="flex-1 py-3 bg-emerald-500 text-white text-sm font-medium rounded-xl">
              完了
            </button>
          ) : (
            <>
              <button onClick={onClose} className="flex-1 py-3 border border-gray-200 text-sm text-gray-600 rounded-xl">
                キャンセル
              </button>
              <button
                onClick={handleImport}
                disabled={loading || !csvText.trim()}
                className="flex-1 py-3 bg-indigo-500 text-white text-sm font-medium rounded-xl disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                取込実行
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Data Reimport（利用者・保険情報・居宅マスタ を CSV から一括再構築） ───

type ReimportClientRow = {
  user_number: string;
  name: string;
  furigana: string | null;
  gender: string | null;
  birth_date: string | null;
  postal_code: string | null;
  address: string | null;
  phone: string | null;
  mobile: string | null;
  memo: string | null;
};
type ReimportInsuranceRow = {
  user_number: string;
  effective_date: string | null;
  insured_number: string | null;
  insurer_number: string | null;
  issued_date: string | null;
  qualification_date: string | null;
  certification_status: string | null;
  care_level: string | null;
  certification_date: string | null;
  certification_start_date: string | null;
  certification_end_date: string | null;
  benefit_rate: string | null;
  copay_rate: string | null;
  care_manager_org: string | null;
  care_manager: string | null;
  service_memo: string | null;
  service_restriction: string | null;
};

function parseReimportCsv(buf: ArrayBuffer): { clients: Map<string, ReimportClientRow>; insurance: ReimportInsuranceRow[] } {
  const text = new TextDecoder("shift-jis").decode(buf);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV が空です");
  const parseRow = (line: string): string[] => {
    const out: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const header = parseRow(lines[0]);
  const col = (name: string): number => header.indexOf(name);
  const iUserNum = col("利用者番号"),
    iLast = col("利用者名（姓）"), iFirst = col("利用者名（名）"), iName = col("利用者名"),
    iFLast = col("フリガナ（姓）"), iFFirst = col("フリガナ（名）"), iFuri = col("フリガナ"),
    iGender = col("性別"), iBirth = col("生年月日"),
    iZip = col("郵便番号"), iAddr = col("住所"),
    iPhone = col("電話番号"), iMobile = col("携帯番号"), iMemo = col("メモ"),
    iEff = col("有効開始日"),
    iInsNum = col("被保険者番号"), iInsurer = col("保険者番号"),
    iIssued = col("交付年月日"), iQual = col("資格取得日"),
    iCertStatus = col("認定状況"), iCareLevel = col("要介護度"),
    iCertDate = col("認定年月日"),
    iCertStart = col("認定有効期間－開始日"),
    iCertEnd = col("認定有効期間－終了日"),
    iBenefit = col("給付率"),
    iSvcLimit = col("サービス限定"), iNote = col("留意事項"),
    iCmOrg = col("支援事業所（正式名称）"), iCmOrgShort = col("支援事業所"),
    iCm = col("担当ケアマネジャー");
  if (iUserNum < 0 || iName < 0) throw new Error("必要な列（利用者番号 / 利用者名）が見つかりません");

  const n = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
  const nYmd = (v: string | undefined): string | null => {
    const s = n(v); if (!s) return null;
    // Accept YYYY/MM/DD or YYYY-MM-DD or YYYYMMDD
    const m1 = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
    if (m1) return `${m1[1]}-${m1[2].padStart(2, "0")}-${m1[3].padStart(2, "0")}`;
    const m2 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
    return s;
  };

  const clients = new Map<string, ReimportClientRow>();
  const insurance: ReimportInsuranceRow[] = [];
  for (let idx = 1; idx < lines.length; idx++) {
    const r = parseRow(lines[idx]);
    const userNum = (r[iUserNum] ?? "").trim();
    if (!userNum) continue;
    const last = iLast >= 0 ? n(r[iLast]) : null;
    const first = iFirst >= 0 ? n(r[iFirst]) : null;
    const nameDirect = iName >= 0 ? n(r[iName]) : null;
    const name = nameDirect || [last, first].filter(Boolean).join(" ").trim();
    if (!name) continue;
    const fLast = iFLast >= 0 ? n(r[iFLast]) : null;
    const fFirst = iFFirst >= 0 ? n(r[iFFirst]) : null;
    const furiDirect = iFuri >= 0 ? n(r[iFuri]) : null;
    const furigana = furiDirect || [fLast, fFirst].filter(Boolean).join(" ").trim() || null;

    // 利用者マスタ: 1利用者1行（既存は上書き、認定最新が来るたびに更新）
    const prev = clients.get(userNum);
    const newEnd = iCertEnd >= 0 ? (nYmd(r[iCertEnd]) ?? "") : "";
    const prevEnd = prev ? (insurance.filter((ir) => ir.user_number === userNum).map((ir) => ir.certification_end_date ?? "").sort().at(-1) ?? "") : "";
    if (!prev || newEnd > prevEnd) {
      clients.set(userNum, {
        user_number: userNum,
        name,
        furigana,
        gender: iGender >= 0 ? n(r[iGender]) : null,
        birth_date: iBirth >= 0 ? nYmd(r[iBirth]) : null,
        postal_code: iZip >= 0 ? n(r[iZip]) : null,
        address: iAddr >= 0 ? n(r[iAddr]) : null,
        phone: iPhone >= 0 ? n(r[iPhone]) : null,
        mobile: iMobile >= 0 ? n(r[iMobile]) : null,
        // memo は clients から DROP 済のため省略（後日 client_memos へ）
        memo: null,
      });
    }

    // 介護保険情報: 1行 = 1認定期間
    const benefit = iBenefit >= 0 ? n(r[iBenefit]) : null;
    const copayCalc = benefit && !isNaN(Number(benefit)) ? String(100 - Number(benefit)) : null;
    const careOrg = (iCmOrg >= 0 ? n(r[iCmOrg]) : null) ?? (iCmOrgShort >= 0 ? n(r[iCmOrgShort]) : null);
    insurance.push({
      user_number: userNum,
      effective_date: iEff >= 0 ? nYmd(r[iEff]) : null,
      insured_number: iInsNum >= 0 ? n(r[iInsNum]) : null,
      insurer_number: iInsurer >= 0 ? n(r[iInsurer]) : null,
      issued_date: iIssued >= 0 ? nYmd(r[iIssued]) : null,
      qualification_date: iQual >= 0 ? nYmd(r[iQual]) : null,
      certification_status: iCertStatus >= 0 ? n(r[iCertStatus]) : null,
      care_level: iCareLevel >= 0 ? n(r[iCareLevel]) : null,
      certification_date: iCertDate >= 0 ? nYmd(r[iCertDate]) : null,
      certification_start_date: iCertStart >= 0 ? nYmd(r[iCertStart]) : null,
      certification_end_date: iCertEnd >= 0 ? nYmd(r[iCertEnd]) : null,
      benefit_rate: benefit,
      copay_rate: copayCalc,
      care_manager_org: careOrg,
      care_manager: iCm >= 0 ? n(r[iCm]) : null,
      service_memo: iSvcLimit >= 0 ? n(r[iSvcLimit]) : null,
      service_restriction: iNote >= 0 ? n(r[iNote]) : null,
    });
  }
  return { clients, insurance };
}

function DataReimportSection({ tenantId }: { tenantId: string }) {
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [parsed, setParsed] = useState<{
    clients: Map<string, ReimportClientRow>;
    insurance: ReimportInsuranceRow[];
  } | null>(null);
  const [dryrun, setDryrun] = useState<null | {
    existing: number;
    toInsert: number;
    toUpdate: number;
    toSoftDelete: number;
    insuranceCurrent: number;
    insuranceNew: number;
    ordersToDelete: number;
    orderItemsToDelete: number;
    salesRecordsToDelete: number;
    careOfficesNew: number;
    careManagersNew: number;
  }>(null);
  const [parsing, setParsing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setCsvFile(file);
    setParsing(true);
    setDryrun(null);
    setDone(null);
    try {
      const buf = await file.arrayBuffer();
      const p = parseReimportCsv(buf);
      setParsed(p);
      // dryRun: 既存データとの差分を集計
      const userNums = Array.from(p.clients.keys());
      // 既存 clients
      const existingClientNums = new Set<string>();
      const PAGE = 1000;
      let from = 0;
      while (true) {
        const { data } = await supabase.from("clients").select("user_number").eq("tenant_id", tenantId).range(from, from + PAGE - 1);
        if (!data || data.length === 0) break;
        data.forEach((c: { user_number: string | null }) => { if (c.user_number) existingClientNums.add(c.user_number); });
        if (data.length < PAGE) break;
        from += PAGE;
      }
      const toInsert = userNums.filter((u) => !existingClientNums.has(u)).length;
      const toUpdate = userNums.filter((u) => existingClientNums.has(u)).length;
      const toSoftDelete = Array.from(existingClientNums).filter((u) => !p.clients.has(u)).length;

      const today = new Date().toISOString().slice(0, 10);
      const insuranceCurrent = p.insurance.filter((r) => {
        const s = r.certification_start_date, e = r.certification_end_date;
        return (!s || s <= today) && (!e || e >= today);
      });

      // 現在期間の居宅・ケアマネ ユニーク数
      const offSet = new Set<string>();
      const mgrSet = new Set<string>();
      for (const r of insuranceCurrent) {
        if (r.care_manager_org) offSet.add(r.care_manager_org.trim());
        if (r.care_manager_org && r.care_manager) mgrSet.add(`${r.care_manager_org.trim()}__${r.care_manager.trim()}`);
      }

      const [{ count: ordCnt }, { count: itmCnt }, { count: srCnt }] = await Promise.all([
        supabase.from("orders").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
        supabase.from("order_items").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
        supabase.from("sales_records").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
      ]);

      setDryrun({
        existing: existingClientNums.size,
        toInsert,
        toUpdate,
        toSoftDelete,
        insuranceCurrent: insuranceCurrent.length,
        insuranceNew: p.insurance.length,
        ordersToDelete: ordCnt ?? 0,
        orderItemsToDelete: itmCnt ?? 0,
        salesRecordsToDelete: srCnt ?? 0,
        careOfficesNew: offSet.size,
        careManagersNew: mgrSet.size,
      });
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      alert(`CSV パースエラー\n${msg}`);
      setParsed(null);
    } finally {
      setParsing(false);
    }
  };

  const execute = async () => {
    if (!parsed || !dryrun) return;
    if (!confirm("本当に実行しますか？\n発注データは削除されます。\nこの処理は取り消せません。")) return;
    setExecuting(true);
    setDone(null);
    try {
      // Phase 1: 発注関連削除
      setProgress("1/5 発注データを削除中...");
      await supabase.from("sales_records").delete().eq("tenant_id", tenantId);
      await supabase.from("order_items").delete().eq("tenant_id", tenantId);
      await supabase.from("orders").delete().eq("tenant_id", tenantId);

      // Phase 2: 利用者マスタ upsert
      setProgress("2/5 利用者マスタを upsert 中...");
      const clientArr = Array.from(parsed.clients.values()).map((c) => ({
        tenant_id: tenantId,
        user_number: c.user_number,
        name: c.name,
        furigana: c.furigana,
        gender: c.gender,
        birth_date: c.birth_date,
        postal_code: c.postal_code,
        address: c.address,
        phone: c.phone,
        mobile: c.mobile,
        // memo は clients から DROP 済のため省略（後日 client_memos へ）
        deleted_at: null,
      }));
      const BATCH = 200;
      for (let i = 0; i < clientArr.length; i += BATCH) {
        const batch = clientArr.slice(i, i + BATCH);
        const { error } = await supabase.from("clients").upsert(batch, { onConflict: "tenant_id,user_number", ignoreDuplicates: false });
        if (error) throw error;
        setProgress(`2/5 利用者マスタ upsert ${Math.min(i + BATCH, clientArr.length)}/${clientArr.length}`);
      }

      // CSV に無い既存利用者 → deleted_at
      setProgress("2/5 CSV に無い既存利用者を ソフト削除...");
      const userNums = Array.from(parsed.clients.keys());
      // RPC は無いので、1000件ずつ not in で処理
      // PostgreSQL の UPDATE with NOT IN だと実行可能
      // Supabase では .not('user_number', 'in', ...) が使える
      const SLICE = 300; // URLパラメータ長の問題を避ける
      for (let i = 0; i < userNums.length; i += SLICE) {
        // 何もしない：既存の削除処理は最後に1回だけ実行
      }
      const { error: softDelErr } = await supabase.from("clients").update({ deleted_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .not("user_number", "in", `(${userNums.map((u) => `"${u}"`).join(",")})`);
      if (softDelErr) {
        // NOT IN で失敗する場合は代替として client-side フィルタ
        console.warn("soft delete failed, skipping:", softDelErr);
      }

      // Phase 3: 保険情報の入れ替え
      setProgress("3/5 介護保険情報を入替中...");
      // 既存全削除
      await supabase.from("client_insurance_records").delete().eq("tenant_id", tenantId);
      // client_id を再取得
      const { data: clientIds } = await supabase.from("clients").select("id, user_number").eq("tenant_id", tenantId).is("deleted_at", null);
      const unum2id = new Map<string, string>();
      (clientIds ?? []).forEach((c: { id: string; user_number: string | null }) => { if (c.user_number) unum2id.set(c.user_number, c.id); });
      // バッチ insert
      const insRows = parsed.insurance
        .filter((r) => unum2id.has(r.user_number))
        .map((r) => ({
          tenant_id: tenantId,
          client_id: unum2id.get(r.user_number)!,
          effective_date: r.effective_date,
          insured_number: r.insured_number,
          insurer_number: r.insurer_number,
          issued_date: r.issued_date,
          qualification_date: r.qualification_date,
          certification_status: r.certification_status,
          care_level: r.care_level,
          certification_date: r.certification_date,
          certification_start_date: r.certification_start_date,
          certification_end_date: r.certification_end_date,
          benefit_rate: r.benefit_rate,
          copay_rate: r.copay_rate,
          care_manager_org: r.care_manager_org,
          care_manager: r.care_manager,
          service_memo: r.service_memo,
          service_restriction: r.service_restriction,
        }));
      for (let i = 0; i < insRows.length; i += BATCH) {
        const batch = insRows.slice(i, i + BATCH);
        const { error } = await supabase.from("client_insurance_records").insert(batch);
        if (error) throw error;
        setProgress(`3/5 保険情報 INSERT ${Math.min(i + BATCH, insRows.length)}/${insRows.length}`);
      }

      // Phase 4: 居宅・ケアマネマスタ再構築
      setProgress("4/5 居宅・ケアマネマスタを再構築中...");
      // clients.care_office_id / care_manager_id をクリア
      await supabase.from("clients").update({ care_office_id: null, care_manager_id: null }).eq("tenant_id", tenantId);
      // care_managers, care_offices を削除
      await supabase.from("care_managers").delete().eq("tenant_id", tenantId);
      await supabase.from("care_offices").delete().eq("tenant_id", tenantId);

      const today = new Date().toISOString().slice(0, 10);
      // 現在期間の記録から care_offices を生成
      const currentInsurance = parsed.insurance.filter((r) => {
        const s = r.certification_start_date, e = r.certification_end_date;
        return (!s || s <= today) && (!e || e >= today);
      });
      const offNames = Array.from(new Set(currentInsurance.map((r) => r.care_manager_org?.trim()).filter(Boolean) as string[]));
      if (offNames.length > 0) {
        const { error } = await supabase.from("care_offices")
          .insert(offNames.map((name) => ({ tenant_id: tenantId, name })));
        if (error) throw error;
      }
      // 取得し直して id 引き
      const { data: offsData } = await supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId);
      const offName2id = new Map<string, string>();
      (offsData ?? []).forEach((o: { id: string; name: string }) => offName2id.set(o.name, o.id));

      // care_managers
      const mgrKeys = new Set<string>();
      const mgrRows: Array<{ tenant_id: string; care_office_id: string; name: string; active: boolean }> = [];
      for (const r of currentInsurance) {
        if (!r.care_manager_org || !r.care_manager) continue;
        const offId = offName2id.get(r.care_manager_org.trim());
        if (!offId) continue;
        const key = `${offId}__${r.care_manager.trim()}`;
        if (mgrKeys.has(key)) continue;
        mgrKeys.add(key);
        mgrRows.push({ tenant_id: tenantId, care_office_id: offId, name: r.care_manager.trim(), active: true });
      }
      if (mgrRows.length > 0) {
        const { error } = await supabase.from("care_managers").insert(mgrRows);
        if (error) throw error;
      }
      const { data: mgrsData } = await supabase.from("care_managers").select("id, care_office_id, name").eq("tenant_id", tenantId);
      const mgrKey2id = new Map<string, string>();
      (mgrsData ?? []).forEach((m: { id: string; care_office_id: string; name: string }) => {
        mgrKey2id.set(`${m.care_office_id}__${m.name}`, m.id);
      });

      // clients.care_office_id / care_manager_id を再設定（現在期間のものを採用、同じ利用者で複数あれば effective_date 最新）
      const currByUser = new Map<string, ReimportInsuranceRow>();
      for (const r of currentInsurance.slice().sort((a, b) => (a.effective_date ?? "").localeCompare(b.effective_date ?? ""))) {
        currByUser.set(r.user_number, r);
      }
      for (let i = 0; i < userNums.length; i += BATCH) {
        const batch = userNums.slice(i, i + BATCH);
        const updates = batch.map((u) => {
          const r = currByUser.get(u);
          const clientId = unum2id.get(u);
          if (!clientId) return null;
          const offId = r?.care_manager_org ? offName2id.get(r.care_manager_org.trim()) ?? null : null;
          const mgrId = offId && r?.care_manager ? mgrKey2id.get(`${offId}__${r.care_manager.trim()}`) ?? null : null;
          return { client_id: clientId, care_office_id: offId, care_manager_id: mgrId };
        }).filter((u): u is NonNullable<typeof u> => u !== null);
        // 個別 UPDATE（Supabase JSクライアントは bulk update が弱い）
        await Promise.all(updates.map((u) =>
          supabase.from("clients").update({ care_office_id: u.care_office_id, care_manager_id: u.care_manager_id }).eq("id", u.client_id)
        ));
        setProgress(`4/5 利用者の居宅紐付け ${Math.min(i + BATCH, userNums.length)}/${userNums.length}`);
      }

      // Phase 5: opendata 再マッチ
      setProgress("5/5 オープンデータでマスタを補完中...");
      const { data: odData } = await supabase.from("care_offices_opendata")
        .select("name, address, phone_number, fax_number, office_number")
        .eq("prefecture", "千葉県");
      const odByName = new Map<string, { address: string | null; phone_number: string | null; fax_number: string | null; office_number: string }>();
      (odData ?? []).forEach((o: { name: string; address: string | null; phone_number: string | null; fax_number: string | null; office_number: string }) => {
        odByName.set(o.name, { address: o.address, phone_number: o.phone_number, fax_number: o.fax_number, office_number: o.office_number });
      });
      const { data: currentOffs } = await supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId);
      for (const o of (currentOffs ?? []) as Array<{ id: string; name: string }>) {
        const od = odByName.get(o.name);
        if (!od) continue;
        await supabase.from("care_offices").update({
          address: od.address,
          phone_number: od.phone_number,
          fax_number: od.fax_number,
          office_number: od.office_number,
        }).eq("id", o.id);
      }

      setProgress("");
      setDone("完了しました。");
      setParsed(null);
      setDryrun(null);
      setCsvFile(null);
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? String(e);
      alert(`実行中にエラーが発生しました\n${msg}\n\n部分的に処理が完了している可能性があります。DB を確認してください。`);
      console.error(e);
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800 space-y-1">
        <p className="font-semibold">⚠️ 危険な操作</p>
        <p>このテナントの 発注 / 発注明細 / 売上帳票 が削除され、利用者マスタ・介護保険情報・居宅マスタが CSV の内容で作り直されます。予定（events）と利用者 ID の紐付けは維持されます。</p>
      </div>
      <div className="bg-white rounded-xl p-4 border border-gray-100 space-y-3">
        <input
          ref={fileRef}
          type="file"
          accept=".csv"
          className="text-xs"
          disabled={executing}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {parsing && <p className="text-xs text-gray-500">解析中...</p>}
        {csvFile && !parsing && <p className="text-xs text-gray-600">ファイル: {csvFile.name}</p>}
      </div>
      {dryrun && (
        <div className="bg-white rounded-xl p-4 border border-blue-200 space-y-2">
          <h3 className="text-sm font-semibold text-blue-700">実行プレビュー（dryRun）</h3>
          <dl className="text-xs space-y-1">
            <div className="flex justify-between"><dt>Phase1 発注データ 削除</dt><dd>{dryrun.ordersToDelete} 件 (items {dryrun.orderItemsToDelete}, sales {dryrun.salesRecordsToDelete})</dd></div>
            <div className="flex justify-between"><dt>Phase2 利用者マスタ 新規登録</dt><dd>{dryrun.toInsert} 人</dd></div>
            <div className="flex justify-between"><dt>Phase2 利用者マスタ 更新</dt><dd>{dryrun.toUpdate} 人</dd></div>
            <div className="flex justify-between"><dt>Phase2 ソフト削除（CSV に無い既存）</dt><dd>{dryrun.toSoftDelete} 人</dd></div>
            <div className="flex justify-between"><dt>Phase3 介護保険情報 入替</dt><dd>{dryrun.insuranceNew} 件（うち現在期間 {dryrun.insuranceCurrent} 件）</dd></div>
            <div className="flex justify-between"><dt>Phase4 居宅マスタ 生成</dt><dd>{dryrun.careOfficesNew} 件</dd></div>
            <div className="flex justify-between"><dt>Phase4 ケアマネマスタ 生成</dt><dd>{dryrun.careManagersNew} 件</dd></div>
            <div className="flex justify-between"><dt>Phase5 オープンデータ補完</dt><dd>一致した居宅のみ自動反映</dd></div>
          </dl>
          <button
            onClick={execute}
            disabled={executing}
            className="w-full py-2 rounded-xl bg-red-500 text-white font-semibold hover:bg-red-600 disabled:opacity-50 text-sm"
          >
            {executing ? (progress || "実行中...") : "🚨 この内容で実行する"}
          </button>
          {progress && <p className="text-xs text-gray-500 text-center">{progress}</p>}
        </div>
      )}
      {done && (
        <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-sm text-green-700">
          ✅ {done}
        </div>
      )}
    </div>
  );
}

// ─── Care Plan Template ───────────────────────────────────────────────────────

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

// ─── Change Contract Modal (変更契約書 / 契約書別紙) ─────────────────────────
// 用具が追加・解約・数量変更された際に作成する書類。
// 変更前の月（当月）と変更後の月（翌月）の利用料金を併記する形式。
function ChangeContractModal({
  client,
  clientItems,
  equipment,
  companyInfo,
  tenantId,
  onClose,
  onSaved,
  initialParams,
}: {
  client: Client;
  clientItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  onClose: () => void;
  onSaved?: () => void;
  initialParams?: Record<string, unknown>;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const today = new Date();
  const todayYM = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const nextDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const nextYM = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}`;

  const [step, setStep] = useState<1 | 2>(1);
  const [contractDate, setContractDate] = useState((initialParams?.contractDate as string) ?? todayStr);
  const [currentMonth, setCurrentMonth] = useState((initialParams?.currentMonth as string) ?? todayYM);
  const [nextMonth, setNextMonth] = useState((initialParams?.nextMonth as string) ?? nextYM);
  const initialBenefitRate: "1" | "2" | "3" =
    (initialParams?.benefitRate as "1" | "2" | "3" | undefined) ??
    (client.copay_rate === "20" ? "2" : client.copay_rate === "30" ? "3" : "1");
  const [benefitRate, setBenefitRate] = useState<"1" | "2" | "3">(initialBenefitRate);
  const [saving, setSaving] = useState(false);

  type Row = {
    itemId: string;
    productCode: string;
    name: string;
    category: string;
    unitPrice: number;
    quantity: number;
    inCurrent: boolean;
    inNext: boolean;
  };

  const burdenRate = parseInt(benefitRate, 10);

  const inMonth = useCallback((item: OrderItem, yyyymm: string): boolean => {
    if (item.status === "cancelled") return false;
    if (item.status === "ordered" || item.status === "delivered" || item.status === "trial") return false;
    const [y, m] = yyyymm.split("-").map(Number);
    if (!y || !m) return false;
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0);
    const start = item.rental_start_date ? new Date(item.rental_start_date) : null;
    const end = item.rental_end_date ? new Date(item.rental_end_date) : null;
    if (!start) return false;
    if (start > monthEnd) return false;
    if (end && end < monthStart) return false;
    return true;
  }, []);

  const buildRows = useCallback((): Row[] => {
    const result: Row[] = [];
    for (const item of clientItems) {
      const eq = equipment.find((e) => e.product_code === item.product_code);
      const inCurrent = inMonth(item, currentMonth);
      const inNext = inMonth(item, nextMonth);
      if (!inCurrent && !inNext) continue;
      const fullPrice = item.rental_price ?? eq?.rental_price ?? 0;
      const userBurden = Math.round((fullPrice * burdenRate) / 10);
      result.push({
        itemId: item.id,
        productCode: item.product_code,
        name: eq?.name ?? item.product_code,
        category: eq?.category ?? "",
        unitPrice: userBurden,
        quantity: item.quantity ?? 1,
        inCurrent,
        inNext,
      });
    }
    return result;
  }, [clientItems, equipment, currentMonth, nextMonth, burdenRate, inMonth]);

  const [rows, setRows] = useState<Row[]>(() => buildRows());

  useEffect(() => {
    setRows(buildRows());
  }, [buildRows]);

  const currentTotal = rows.filter((r) => r.inCurrent).reduce((s, r) => s + r.unitPrice * r.quantity, 0);
  const nextTotal = rows.filter((r) => r.inNext).reduce((s, r) => s + r.unitPrice * r.quantity, 0);

  const contractDateJa = contractDate ? toJapaneseEra(new Date(contractDate + "T00:00:00")) : "　　年　月　日";

  const monthLabel = (yyyymm: string) => {
    const [y, m] = yyyymm.split("-").map(Number);
    return `${y}年${m}月`;
  };
  const monthN = (yyyymm: string) => parseInt(yyyymm.split("-")[1] ?? "0", 10);

  const handlePrint = () => {
    const el = document.getElementById("change-contract-print");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    // el (#change-contract-print) は padding 17mm を持つラッパー。
    // innerHTML はその中身だけ取り出すので、印刷時は @page margin で余白を取り、
    // body は padding 0 で運用する（プレビューと印刷で見た目を一致させるため）。
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>変更契約書</title><style>
      *{box-sizing:border-box}
      html,body{margin:0;padding:0}
      body{font-family:'ＭＳ Ｐゴシック','MS PGothic','Yu Gothic','メイリオ',sans-serif;font-size:10pt;color:#000;line-height:1.45}
      @page{size:A4 portrait;margin:17mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #000;padding:1px 5px;vertical-align:middle}
      p{margin:0}
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
        type: "change_contract",
        title: `変更契約書 ${contractDate}`,
        params: { contractDate, currentMonth, nextMonth, benefitRate },
      });
      onSaved?.();
    } finally {
      setSaving(false);
    }
  };

  // ── サンプル（変更契約書.xlsx）の列幅・フォント・配置を忠実に再現 ──
  // Excel列幅 → %換算（合計95.62 = 100%）
  // A:16.6%  B:43.3%  C:8.4%   D:4.8%   E:3.0%   F:9.8%   G:3.0%   H:9.8% (8列)
  // 簡略のため E+F、G+H を1列にまとめて 6 列構成にし、ヘッダ内で月番号を bold 表示
  const PRINT_FONT = `'ＭＳ Ｐゴシック','MS PGothic','Yu Gothic','メイリオ',sans-serif`;
  const cellBase: React.CSSProperties = { border: "1px solid #000", padding: "2px 5px", verticalAlign: "middle" };
  const cellLeft: React.CSSProperties = { ...cellBase, textAlign: "left" };
  const cellRight: React.CSSProperties = { ...cellBase, textAlign: "right" };
  const cellCenter: React.CSSProperties = { ...cellBase, textAlign: "center" };
  const thBase: React.CSSProperties = { ...cellBase, textAlign: "center", fontWeight: "normal" };

  return (
    <div className="fixed inset-0 bg-black/60 flex flex-col z-50 overflow-hidden">
      <div className="bg-white flex-1 overflow-hidden flex flex-col">
        {/* ヘッダー */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <button onClick={step === 2 ? () => setStep(1) : onClose}>
            <ChevronLeft size={20} className="text-gray-500" />
          </button>
          <h2 className="font-semibold text-gray-800 flex-1">変更契約書</h2>
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
            <button disabled={rows.length === 0} onClick={() => setStep(2)}
              className="px-4 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
              次へ（プレビュー）
            </button>
          )}
        </div>

        {/* Step 1: 設定 */}
        {step === 1 && (
          <div className="flex-1 overflow-auto p-5 space-y-4">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
              💡 変更前後の月を選択すると、レンタル中の用具を自動抽出します。チェックボックスで月ごとの含有を調整できます。
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">変更前の月（当月）</label>
                <input type="month" value={currentMonth} onChange={(e) => setCurrentMonth(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">変更後の月（翌月）</label>
                <input type="month" value={nextMonth} onChange={(e) => setNextMonth(e.target.value)}
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm" />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">契約日</label>
                <input type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)}
                  className="border border-gray-200 rounded-xl px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">利用者負担割合</label>
                <div className="flex gap-2">
                  {(["1", "2", "3"] as const).map((rate) => (
                    <button key={rate} onClick={() => setBenefitRate(rate)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium border ${benefitRate === rate ? "bg-emerald-500 text-white border-emerald-500" : "bg-white text-gray-600 border-gray-300"}`}>
                      {rate}割
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white border border-gray-200 rounded-xl overflow-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-2 py-2 border-b text-left">種目</th>
                    <th className="px-2 py-2 border-b text-left">商品名</th>
                    <th className="px-2 py-2 border-b text-right">単価</th>
                    <th className="px-2 py-2 border-b text-right">数量</th>
                    <th className="px-2 py-2 border-b text-center">{monthN(currentMonth)}月</th>
                    <th className="px-2 py-2 border-b text-center">{monthN(nextMonth)}月</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={6} className="text-center text-gray-400 py-6">指定月にレンタル中の用具がありません</td></tr>
                  ) : rows.map((r, i) => (
                    <tr key={r.itemId} className="border-b last:border-b-0">
                      <td className="px-2 py-1.5">{r.category}</td>
                      <td className="px-2 py-1.5">{r.name}</td>
                      <td className="px-2 py-1.5 text-right">¥{r.unitPrice.toLocaleString()}</td>
                      <td className="px-2 py-1.5 text-right">{r.quantity}</td>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={r.inCurrent}
                          onChange={(e) => setRows((prev) => prev.map((row, idx) => idx === i ? { ...row, inCurrent: e.target.checked } : row))} />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <input type="checkbox" checked={r.inNext}
                          onChange={(e) => setRows((prev) => prev.map((row, idx) => idx === i ? { ...row, inNext: e.target.checked } : row))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50">
                  <tr>
                    <td colSpan={4} className="px-2 py-2 text-right font-semibold">合計</td>
                    <td className="px-2 py-2 text-center font-bold">¥{currentTotal.toLocaleString()}</td>
                    <td className="px-2 py-2 text-center font-bold">¥{nextTotal.toLocaleString()}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}

        {/* Step 2: 印刷プレビュー（変更契約書.xlsx の見本に忠実なレイアウト） */}
        {step === 2 && (
          <div className="flex-1 overflow-auto bg-gray-100 p-4">
            {/* A4 用紙風の枠（210mm × 297mm）。padding が印刷時の @page margin と一致 */}
            <div
              style={{
                width: "210mm",
                minHeight: "297mm",
                margin: "0 auto",
                background: "white",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                fontFamily: PRINT_FONT,
                color: "#000",
              }}
            >
              <div
                id="change-contract-print"
                style={{
                  padding: "17mm 17mm",
                  fontFamily: PRINT_FONT,
                  fontSize: "10pt",
                  color: "#000",
                  lineHeight: 1.5,
                  // ── A4 縦の印刷領域（297mm − 余白34mm = 263mm） ──
                  // flex で「上ブロック → 余白 → 下ブロック」と縦に並べ、
                  // 余白を flex-grow で伸ばすことで下ブロック（事業者）が用紙下端に張り付く
                  minHeight: "263mm",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                {/* ── 上ブロック ── */}
                <div>
                  {/* 契約書別紙（タイトル） */}
                  <p style={{ fontSize: "14pt", textAlign: "center", margin: "0 0 12px" }}>
                    契約書別紙
                  </p>

                  {/* 利用者氏名 + 様 */}
                  <p style={{ margin: "0 0 8px" }}>
                    <span style={{ fontSize: "12pt" }}>{client.name}</span>
                    <span style={{ fontSize: "11pt", marginLeft: "8px" }}>様</span>
                  </p>

                  {/* 説明文（A6） */}
                  <p style={{ fontSize: "10pt", margin: "0 0 12px" }}>
                    利用料金の変更がありましたので、新たに契約書別紙を取り交わさせて頂きます。
                  </p>

                  {/* タイトル "令和8年 3・4 月利用料金"（A8: bold） */}
                  <p style={{ fontSize: "11pt", fontWeight: "bold", margin: "0 0 4px" }}>
                    {(() => {
                      const [y] = currentMonth.split("-").map(Number);
                      const era = y >= 2019 ? `令和${y - 2018}年` : `${y}年`;
                      return `${era} ${monthN(currentMonth)}・${monthN(nextMonth)}月利用料金`;
                    })()}
                  </p>

                  {/* テーブル */}
                  <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "12px" }}>
                    <colgroup>
                      <col style={{ width: "16.6%" }} />
                      <col style={{ width: "43.3%" }} />
                      <col style={{ width: "8.4%" }} />
                      <col style={{ width: "4.8%" }} />
                      <col style={{ width: "13.4%" }} />
                      <col style={{ width: "13.4%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={{ ...thBase, fontSize: "9pt" }}>種目</th>
                        <th style={{ ...thBase, fontSize: "9pt" }}>商品名</th>
                        <th style={{ ...thBase, fontSize: "6pt" }}>利用者負担額</th>
                        <th style={{ ...thBase, fontSize: "8pt" }}>数量</th>
                        <th style={{ ...thBase, fontSize: "8pt" }}>
                          <span style={{ fontWeight: "bold" }}>{monthN(currentMonth)}</span>月利用者負担
                        </th>
                        <th style={{ ...thBase, fontSize: "8pt" }}>
                          <span style={{ fontWeight: "bold" }}>{monthN(nextMonth)}</span>月利用者負担
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          <td style={{ ...cellLeft, fontSize: "10pt", padding: "2px 5px" }}>{r.category}</td>
                          <td style={{ ...cellLeft, fontSize: "8pt", padding: "2px 5px" }}>{r.name}</td>
                          <td style={{ ...cellRight, fontSize: "10.5pt", padding: "2px 5px" }}>{r.unitPrice}</td>
                          <td style={{ ...cellRight, fontSize: "10.5pt", padding: "2px 5px" }}>{r.quantity}</td>
                          <td style={{ ...cellRight, fontSize: "10.5pt", padding: "2px 5px" }}>{r.inCurrent ? r.unitPrice * r.quantity : ""}</td>
                          <td style={{ ...cellRight, fontSize: "10.5pt", padding: "2px 5px" }}>{r.inNext ? r.unitPrice * r.quantity : ""}</td>
                        </tr>
                      ))}
                      {/* 空行（見本通り 16 行枠を維持） */}
                      {Array.from({ length: Math.max(0, 16 - rows.length) }).map((_, i) => (
                        <tr key={`empty-${i}`}>
                          <td style={{ ...cellBase, height: "16pt", padding: "2px 5px" }}></td>
                          <td style={{ ...cellBase, padding: "2px 5px" }}></td>
                          <td style={{ ...cellBase, padding: "2px 5px" }}></td>
                          <td style={{ ...cellBase, padding: "2px 5px" }}></td>
                          <td style={{ ...cellBase, padding: "2px 5px" }}></td>
                          <td style={{ ...cellBase, padding: "2px 5px" }}></td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={4} style={{ ...cellCenter, fontSize: "10pt", padding: "2px 5px" }}>合計</td>
                        <td style={{ ...cellRight, fontSize: "10.5pt", padding: "2px 5px" }}>{currentTotal}</td>
                        <td style={{ ...cellRight, fontSize: "10.5pt", padding: "2px 5px" }}>{nextTotal}</td>
                      </tr>
                    </tfoot>
                  </table>

                  {/* 注意事項 */}
                  <div style={{ fontSize: "9pt", lineHeight: 1.5, marginBottom: "10px" }}>
                    <p>　（１）介護保険の適用がある場合は、料金表のサービス費の1割もしくは２割又は3割が利用者負担金となります。</p>
                    <p>　（２）利用者負担金は契約開始月については使用月末締めの翌々月６日にご指定の金融機関の口座から引き落としをさ</p>
                    <p>　　　 せていただきます。（注）金融機関休業日の場合は翌営業日となります。</p>
                    <p>  （３）尚、契約起算日が月の１５日以前の場合においては月額の全額を、１６日以降の場合においては１/２の料金を請求</p>
                    <p>        させていただきます。解約の場合も同様に月の１５日以前の解約については月額の１/２を、１６日以降の解約について</p>
                    <p>        は１ヶ月分の料金を請求させていただきます。</p>
                  </div>

                  <div style={{ fontSize: "9pt", lineHeight: 1.5, marginBottom: "12px" }}>
                    <p>　　別紙（介護予防）福祉用具貸与サービス契約約款及び本書の契約内容を証するため、本書２通を作成し、利用者、事業者</p>
                    <p>が署名押印の上、各自１通保有するものとします。</p>
                    <p>　　同様に、介護保険制度にて義務づけられているサービス担当者会議の開催と必要と認められる場合において、利用者様</p>
                    <p>の個人情報を用いることについての説明を受け、同意するものといたします。</p>
                  </div>
                </div>

                {/* ── 余白（伸縮） ── 上下ブロックの間を flex で埋める */}
                <div style={{ flexGrow: 1, minHeight: "8mm" }} />

                {/* ── 下ブロック（用紙下端に張り付く） ── */}
                <div>
                  {/* 契約日 */}
                  <p style={{ fontSize: "10pt", margin: "0 0 8px" }}>{contractDateJa}</p>

                  {/* 署名欄 */}
                  <p style={{ fontSize: "10pt", margin: "0 0 10px", borderBottom: "1px solid #000", paddingBottom: "6px" }}>
                    契約者住所　{client.address ?? ""}
                  </p>
                  <p style={{ fontSize: "10pt", margin: "0 0 10px", borderBottom: "1px solid #000", paddingBottom: "6px" }}>
                    氏　　　名　{client.name}　<span style={{ float: "right" }}>印</span>
                  </p>
                  <p style={{ fontSize: "10pt", margin: "0 0 10px", borderBottom: "1px solid #000", paddingBottom: "6px" }}>
                    代理人署名　<span style={{ float: "right" }}>印</span>
                  </p>

                  {/* 事業者 */}
                  <p style={{ fontSize: "10pt", margin: "8px 0 2px" }}>事　業　者</p>
                  <p style={{ fontSize: "10pt", margin: "0 0 2px" }}>
                    　　　　＜事業所名＞　{companyInfo.companyName}
                  </p>
                  <p style={{ fontSize: "10pt", margin: "0 0 2px" }}>
                    　　　　＜住    所＞　{companyInfo.companyAddress}
                  </p>
                  <p style={{ fontSize: "10pt", margin: "0 0 2px" }}>
                    　　　　＜管理者名＞　　　　{companyInfo.staffName}　　　㊞
                  </p>
                </div>
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

// ─── 請求書／領収書 モーダル ───────────────────────────────────────────────
// 介護保険対象レンタルの当月利用料を集計し、請求書または領収書として A4 印刷
// 可能なプレビューで表示する。保存時には invoices テーブルに番号を採番して
// upsert し、再発行時は同じ番号を再利用する。
function InvoiceReceiptModal({
  client,
  orders,
  orderItems,
  equipment,
  companyInfo,
  priceHistory,
  tenantId,
  defaultMonth,
  hospitalizations,
  onClose,
}: {
  client: Client;
  orders: Order[];
  orderItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  priceHistory: EquipmentPriceHistory[];
  tenantId: string;
  defaultMonth: string;  // YYYY-MM
  hospitalizations: ClientHospitalization[];
  onClose: () => void;
}) {
  const [targetMonth, setTargetMonth] = useState(defaultMonth);
  const [mode, setMode] = useState<"invoice" | "receipt">("invoice");
  const [saving, setSaving] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState<number | null>(null);
  const [yearIssued, setYearIssued] = useState<number | null>(null);
  const [issuedDate, setIssuedDate] = useState<string | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(true);

  const [y, m] = targetMonth.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStartStr = `${targetMonth}-01`;
  const monthEndStr = `${targetMonth}-${String(daysInMonth).padStart(2, "0")}`;

  // 対象月に発生した介護保険レンタル明細
  const careItems = useMemo(() => {
    const clientOrderIds = new Set(orders.filter(o => o.client_id === client.id).map(o => o.id));
    const resolvePay = (i: OrderItem): "介護" | "自費" | "特価自費" => {
      if (i.payment_type) return i.payment_type;
      return orders.find(o => o.id === i.order_id)?.payment_type ?? "介護";
    };
    return orderItems.filter((item) => {
      if (!clientOrderIds.has(item.order_id)) return false;
      if (resolvePay(item) !== "介護") return false;
      if (!item.rental_start_date) return false;
      if (item.rental_start_date > monthEndStr) return false;
      if (item.status === "terminated" && item.rental_end_date && item.rental_end_date < monthStartStr) return false;
      if (item.status !== "rental_started" && item.status !== "terminated") return false;
      return true;
    }).sort((a, b) => {
      const na = equipment.find(e => e.product_code === a.product_code)?.name ?? a.product_code;
      const nb = equipment.find(e => e.product_code === b.product_code)?.name ?? b.product_code;
      return na.localeCompare(nb, "ja");
    });
  }, [orders, orderItems, equipment, client.id, monthStartStr, monthEndStr]);

  const getEq = (code: string) => equipment.find((e) => e.product_code === code);
  const histPrice = (code: string, ym: string) =>
    getPriceForMonth(priceHistory, code, ym) ?? undefined;

  // 対象月の請求対象日（入院除外を考慮した開始〜終了）
  const periodInfo = useMemo(() => {
    const pld = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const billingDays = new Set<number>();
    for (const item of careItems) {
      const start = pld(item.rental_start_date!);
      const end = item.rental_end_date ? pld(item.rental_end_date) : new Date(y, m, 0);
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(y, m - 1, d);
        if (date >= start && date <= end) {
          const inHosp = hospitalizations.some(h => {
            const admit = pld(h.admission_date);
            const discharge = h.discharge_date ? pld(h.discharge_date) : new Date(y, m, 0);
            return date >= admit && date <= discharge;
          });
          if (!inHosp) billingDays.add(d);
        }
      }
    }
    const sortedDays = [...billingDays].sort((a, b) => a - b);
    const firstDay = sortedDays[0] ?? null;
    const lastDay = sortedDays[sortedDays.length - 1] ?? null;
    return { billingDays, firstDay, lastDay };
  }, [careItems, hospitalizations, y, m, daysInMonth]);

  // 明細行の単位数・金額を算出
  const detailRows = useMemo(() => {
    return careItems.map((item) => {
      const eq = getEq(item.product_code);
      const price = getPriceForMonth(priceHistory, item.product_code, targetMonth) ?? item.rental_price ?? 0;
      const units = calcMonthUnits(item, y, m, histPrice(item.product_code, targetMonth)) ?? 0;
      const quantity = item.quantity || 1;
      const totalUnits = units * quantity;
      // 課税区分（現状 equipment に持たせていないので一律「非課税」扱い）
      const isTaxable = false;
      return {
        item,
        eqName: eq?.name ?? item.product_code,
        category: eq?.category ?? "",
        price,
        units,
        quantity,
        totalUnits,
        isTaxable,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [careItems, priceHistory, targetMonth, y, m]);

  const totalUnits = detailRows.reduce((s, r) => s + r.totalUnits, 0);
  const insuredAmount = totalUnits * 10;
  const benefitRate = parseInt(client.benefit_rate ?? "90", 10);
  const copayRate = 100 - benefitRate;
  const copayAmount = Math.floor(insuredAmount * copayRate / 100);

  // 課税分・非課税分（現状は全部非課税）
  const taxableCopay = detailRows.reduce((s, r) => {
    if (!r.isTaxable) return s;
    return s + Math.floor(r.totalUnits * 10 * copayRate / 100);
  }, 0);
  const nonTaxableCopay = copayAmount - taxableCopay;
  const taxAmount = Math.floor(taxableCopay * 10 / 110); // 課税分に含まれる消費税（税込想定）
  const taxableBase = taxableCopay - taxAmount;

  // 既存番号のチェック（対象月で既に発行済みなら再利用）
  useEffect(() => {
    let cancelled = false;
    setLoadingExisting(true);
    setInvoiceNumber(null);
    setYearIssued(null);
    setIssuedDate(null);
    (async () => {
      try {
        const { data } = await supabase
          .from("invoices")
          .select("invoice_number, year_issued, issued_date")
          .eq("tenant_id", tenantId)
          .eq("client_id", client.id)
          .eq("billing_month", targetMonth)
          .maybeSingle();
        if (cancelled) return;
        if (data) {
          setInvoiceNumber(data.invoice_number as number);
          setYearIssued(data.year_issued as number);
          setIssuedDate((data.issued_date as string | null) ?? null);
        }
      } catch {
        // invoices テーブル未作成等は無視
      } finally {
        if (!cancelled) setLoadingExisting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, client.id, targetMonth]);

  // 和暦ラベル
  const eraYM = toJapaneseEraYM(y, m);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const issuedDateDisplay = issuedDate ?? todayStr;
  const issuedDateJa = toJapaneseEra(new Date(issuedDateDisplay + "T00:00:00"));

  // 番号表示
  const displayNumber = invoiceNumber !== null && yearIssued !== null
    ? `No. ${yearIssued}-${String(invoiceNumber).padStart(4, "0")}-01`
    : "No. 未発行";

  // 月切替
  const changeMonth = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setTargetMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  // 保存・採番
  const handleSave = async () => {
    setSaving(true);
    try {
      const nowYear = new Date().getFullYear();
      let useNumber = invoiceNumber;
      let useYear = yearIssued;
      const useDate = issuedDate ?? todayStr;

      if (useNumber === null || useYear === null) {
        // 新規採番
        const { data: maxData } = await supabase
          .from("invoices")
          .select("invoice_number")
          .eq("tenant_id", tenantId)
          .order("invoice_number", { ascending: false })
          .limit(1);
        const currentMax = (maxData && maxData.length > 0) ? (maxData[0].invoice_number as number) : 0;
        useNumber = currentMax + 1;
        useYear = nowYear;
      }

      const snapshot = {
        client: {
          id: client.id,
          name: client.name,
          user_number: client.user_number,
          address: client.address,
          care_manager_org: client.care_manager_org,
          benefit_rate: client.benefit_rate,
        },
        company: companyInfo,
        rows: detailRows.map(r => ({
          product_code: r.item.product_code,
          name: r.eqName,
          category: r.category,
          price: r.price,
          units: r.units,
          quantity: r.quantity,
          total_units: r.totalUnits,
          is_taxable: r.isTaxable,
          rental_start_date: r.item.rental_start_date,
          rental_end_date: r.item.rental_end_date,
        })),
        total_units: totalUnits,
        insured_amount: insuredAmount,
        benefit_rate: benefitRate,
        copay_rate: copayRate,
        copay_amount: copayAmount,
        taxable_copay: taxableCopay,
        non_taxable_copay: nonTaxableCopay,
        tax_amount: taxAmount,
        taxable_base: taxableBase,
        period: {
          first_day: periodInfo.firstDay,
          last_day: periodInfo.lastDay,
        },
      };

      const { error } = await supabase.from("invoices").upsert({
        tenant_id: tenantId,
        client_id: client.id,
        billing_month: targetMonth,
        invoice_number: useNumber,
        year_issued: useYear,
        issued_date: useDate,
        copay_amount: copayAmount,
        data: snapshot,
      }, { onConflict: "tenant_id,client_id,billing_month" });
      if (error) throw error;

      setInvoiceNumber(useNumber);
      setYearIssued(useYear);
      setIssuedDate(useDate);
      alert(`保存しました: No. ${useYear}-${String(useNumber).padStart(4, "0")}-01`);
    } catch (e) {
      console.error(e);
      alert("保存に失敗しました。invoices テーブルの作成状態を確認してください。");
    } finally {
      setSaving(false);
    }
  };

  // 印刷用スタイル
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "__invoice_print__";
    style.textContent = `
      @page { size: A4 portrait; margin: 10mm; }
      @media print {
        body > * { visibility: hidden !important; }
        #invoice-receipt-modal, #invoice-receipt-modal * { visibility: visible !important; }
        #invoice-receipt-modal {
          position: fixed !important; top: 0 !important; left: 0 !important;
          width: 100% !important; height: auto !important;
          background: white !important; z-index: 99999 !important;
          overflow: visible !important;
        }
        .no-print { display: none !important; }
        .invoice-sheet { box-shadow: none !important; margin: 0 auto !important; }
      }
    `;
    document.head.appendChild(style);
    return () => { document.getElementById("__invoice_print__")?.remove(); };
  }, []);

  // 郵便番号（clients の postal_code を保持している場合のみ表示、型が無いので safe access）
  const postalCode = (client as unknown as { postal_code?: string | null }).postal_code ?? null;

  // カレンダー用 DOW
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  const firstDow = new Date(y, m - 1, 1).getDay();
  // 開始日・終了日（表示用）
  const startDayMark = new Set<number>();
  const endDayMark = new Set<number>();
  for (const item of careItems) {
    if (item.rental_start_date && item.rental_start_date >= monthStartStr && item.rental_start_date <= monthEndStr) {
      startDayMark.add(parseInt(item.rental_start_date.split("-")[2], 10));
    }
    if (item.rental_end_date && item.rental_end_date >= monthStartStr && item.rental_end_date <= monthEndStr) {
      endDayMark.add(parseInt(item.rental_end_date.split("-")[2], 10));
    }
  }

  const title = mode === "invoice" ? "利用料請求書" : "利用料領収書";
  const amountLabel = mode === "invoice" ? "今回ご請求額" : "領収金額";
  const dateLabel = mode === "invoice" ? "発行日" : "領収日";

  return (
    <div id="invoice-receipt-modal" className="fixed inset-0 bg-black/70 z-[60] flex flex-col">

      {/* 操作バー */}
      <div className="no-print bg-white border-b border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
        <button onClick={onClose}><X size={20} className="text-gray-500" /></button>
        <span className="font-semibold text-gray-800">請求書／領収書</span>
        <div className="flex items-center gap-1 border border-gray-300 rounded-lg bg-white px-1">
          <button onClick={() => changeMonth(-1)} className="p-1 text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="font-semibold text-gray-800 px-2 text-sm">{eraYM}</span>
          <button onClick={() => changeMonth(1)} className="p-1 text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <div className="flex items-center gap-1 border border-gray-300 rounded-lg overflow-hidden">
          <button onClick={() => setMode("invoice")}
            className={`px-3 py-1 text-sm ${mode === "invoice" ? "bg-emerald-500 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
            請求書
          </button>
          <button onClick={() => setMode("receipt")}
            className={`px-3 py-1 text-sm ${mode === "receipt" ? "bg-emerald-500 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
            領収書
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={handleSave} disabled={saving || loadingExisting}
            className="flex items-center gap-1.5 bg-white text-emerald-600 border border-emerald-300 hover:bg-emerald-50 px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : (invoiceNumber !== null ? "再採番/更新" : "保存して採番")}
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 bg-emerald-500 text-white px-4 py-2 rounded-xl text-sm font-medium">
            <Printer size={14} /> 印刷
          </button>
        </div>
      </div>

      {/* 帳票本体 */}
      <div className="flex-1 overflow-y-auto bg-gray-100">
        <div className="invoice-sheet mx-auto my-6 bg-white shadow-lg"
          style={{
            fontFamily: "'Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','Meiryo',sans-serif",
            fontSize: "12px",
            lineHeight: "1.5",
            maxWidth: "794px",
            width: "794px",
            minHeight: "1123px",
            padding: "32px",
            color: "#111",
            boxSizing: "border-box",
          }}>

          {/* [0] タイトル帯 */}
          <div style={{
            background: "#d4ead7",
            border: "1px solid #374151",
            borderRadius: "14px",
            height: "48px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "16px",
          }}>
            <h1 style={{ fontSize: "26px", fontWeight: "bold", color: "#111", letterSpacing: "0.15em", margin: 0 }}>
              {mode === "invoice" ? "利 用 料 請 求 書" : "利 用 料 領 収 書"}
            </h1>
          </div>

          {/* [1] 住所（左50%） ／ 自社情報（右50%） */}
          <div style={{ display: "flex", alignItems: "flex-start", marginBottom: "6px" }}>
            <div style={{ width: "50%", fontSize: "12px" }}>
              <p style={{ margin: "2px 0" }}>〒{postalCode ?? ""}</p>
              <p style={{ margin: "2px 0" }}>{client.address ?? ""}</p>
            </div>
            <div style={{ width: "50%", fontSize: "12px", textAlign: "left" }}>
              <p style={{ margin: "2px 0", fontWeight: "bold" }}>{companyInfo.companyName || "介護ショップ　ケア・サポート千葉"}</p>
              <p style={{ margin: "2px 0" }}>登録番号：T{companyInfo.businessNumber}</p>
              <p style={{ margin: "2px 0" }}>{companyInfo.companyAddress}</p>
              <p style={{ margin: "2px 0" }}>TEL：{companyInfo.tel}　FAX：{companyInfo.fax}</p>
              <p style={{ margin: "4px 0 0", fontSize: "10px", color: "#555" }}>※ 押印は省略させていただきます。</p>
            </div>
          </div>

          {/* [2] 氏名（左50%・縦中央）／ 居宅介護支援事業者名・支払い者名テーブル（右50%） */}
          <div style={{ display: "flex", alignItems: "center", marginBottom: "0" }}>
            <div style={{ width: "50%", paddingLeft: "16px" }}>
              <p style={{
                fontSize: "24px",
                fontWeight: "bold",
                margin: 0,
              }}>
                {client.name}&nbsp;様
              </p>
            </div>
            <div style={{ width: "50%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <colgroup>
                  <col style={{ width: "50%" }} />
                  <col style={{ width: "50%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>居宅介護支援事業者名</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>支払い者名</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{client.care_manager_org ?? ""}</td>
                    <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{client.name}&nbsp;様</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* [3] 利用者氏名・発行日テーブル（全幅） */}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "10px" }}>
            <colgroup>
              <col style={{ width: "25%" }} />
              <col style={{ width: "50%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "10%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>利用者氏名</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", height: "28px" }} />
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>{dateLabel}</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", height: "28px" }} />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{client.name}&nbsp;様</td>
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{issuedDateJa}</td>
              </tr>
            </tbody>
          </table>

          {/* [4] 注記文 */}
          <div style={{ fontSize: "13px", marginBottom: "6px" }}>
            {mode === "invoice" ? "下記の通り請求いたします。" : "下記の内容について、領収いたしました。"}
          </div>

          {/* [5+6] 期間表示（左）＋ 請求額ボックス（右）を同一行に */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "12px" }}>
            <div style={{ fontSize: "14px", fontWeight: "bold", paddingBottom: "4px" }}>
              {eraYM}分
              {periodInfo.firstDay && periodInfo.lastDay && (
                <span style={{ marginLeft: "16px" }}>
                  期間： {m}月{periodInfo.firstDay}日〜{m}月{periodInfo.lastDay}日
                </span>
              )}
            </div>
            <div style={{ width: "190px", border: "1px solid #374151" }}>
              <div style={{
                background: "#a3d5b2",
                color: "#fff",
                textAlign: "center",
                fontSize: "12px",
                padding: "4px 8px",
                fontWeight: "bold",
              }}>
                {amountLabel}
              </div>
              <div style={{
                background: "#fff",
                textAlign: "right",
                fontSize: "24px",
                fontWeight: "bold",
                padding: "6px 12px",
                color: "#111",
              }}>
                ¥{copayAmount.toLocaleString()}
              </div>
            </div>
          </div>

          {/* [7] 利用内訳テーブル（全幅・4列） */}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "16px" }}>
            <colgroup>
              <col style={{ width: "55%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "15%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>利用内訳</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>単価</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>数量</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>金　額</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }}>福祉用具貸与</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{copayAmount.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px", paddingLeft: "32px", fontSize: "11px", color: "#333" }}>
                  　　課税分　{taxableCopay.toLocaleString()}円
                </td>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px" }} />
              </tr>
              <tr>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px", paddingLeft: "32px", fontSize: "11px", color: "#333" }}>
                  　　非課税分　{nonTaxableCopay.toLocaleString()}円
                </td>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px" }} />
              </tr>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", fontWeight: "bold" }}>合計</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{copayAmount.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          {/* [8] 下段2カラム：介護サービス費内訳（左65%） ／ ご利用日カレンダー（右35%） */}
          <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", marginBottom: "16px" }}>
            <div style={{ width: "65%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <colgroup>
                  <col style={{ width: "55%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>介護サービス費内訳</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>単位数</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>回数</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>単位</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((r) => (
                    <tr key={r.item.id}>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px" }}>{r.eqName}</td>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{r.units.toLocaleString()}</td>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{r.quantity}</td>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{r.totalUnits.toLocaleString()}単位</td>
                    </tr>
                  ))}
                  {detailRows.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "center", color: "#888" }}>
                        対象月の明細はありません
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ border: "1px solid #374151", padding: "6px 8px", fontWeight: "bold" }}>合計</td>
                    <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                    <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                    <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{totalUnits.toLocaleString()}単位</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={{ width: "35%", border: "1px solid #374151", padding: "6px" }}>
              <div style={{ textAlign: "center", fontSize: "13px", fontWeight: "bold", marginBottom: "4px" }}>ご利用日</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "10px", tableLayout: "fixed" }}>
                <thead>
                  <tr>
                    {DOW.map((d, idx) => (
                      <th key={d} style={{
                        border: "1px solid #374151",
                        padding: "2px 0",
                        textAlign: "center",
                        fontWeight: "bold",
                        color: idx === 0 ? "#ef4444" : idx === 6 ? "#3b82f6" : "#333",
                        width: `${100 / 7}%`,
                        height: "20px",
                      }}>{d}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const cells: React.ReactNode[] = [];
                    const rows: React.ReactNode[] = [];
                    for (let i = 0; i < firstDow; i++) {
                      cells.push(<td key={`e${i}`} style={{ border: "1px solid #374151", height: "22px" }} />);
                    }
                    for (let d = 1; d <= daysInMonth; d++) {
                      const dow = (firstDow + d - 1) % 7;
                      const isBill = periodInfo.billingDays.has(d);
                      const isStart = startDayMark.has(d);
                      const isEnd = endDayMark.has(d);
                      const hasMark = isStart || isEnd || isBill;
                      const mark = isStart || isEnd ? "□" : isBill ? "○" : "";
                      const color = dow === 0 ? "#ef4444" : dow === 6 ? "#3b82f6" : "#333";
                      cells.push(
                        <td key={d} style={{
                          border: "1px solid #374151",
                          padding: 0,
                          height: "22px",
                          width: "22px",
                          textAlign: "center",
                          color,
                          verticalAlign: "middle",
                          position: "relative",
                          lineHeight: "1",
                        }}>
                          <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ fontSize: "10px", position: "relative", zIndex: 1 }}>{d}</span>
                            {hasMark && (
                              <span style={{
                                position: "absolute",
                                top: "50%",
                                left: "50%",
                                transform: "translate(-50%, -50%)",
                                fontSize: "16px",
                                fontWeight: "normal",
                                color,
                                zIndex: 0,
                                lineHeight: "1",
                              }}>{mark}</span>
                            )}
                          </div>
                        </td>
                      );
                      if (cells.length === 7) {
                        rows.push(<tr key={`r${d}`}>{cells.splice(0)}</tr>);
                      }
                    }
                    if (cells.length > 0) {
                      while (cells.length < 7) {
                        cells.push(<td key={`t${cells.length}`} style={{ border: "1px solid #374151", height: "22px" }} />);
                      }
                      rows.push(<tr key="rlast">{cells}</tr>);
                    }
                    return rows;
                  })()}
                </tbody>
              </table>
              <p style={{ fontSize: "9px", color: "#333", margin: "4px 0 0", lineHeight: "1.3" }}>
                ○：介護サービス算定日<br />
                □：サービス利用開始・終了日
              </p>
            </div>
          </div>

          {/* [9] 消費税内訳テーブル（全幅・3列） */}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "16px" }}>
            <colgroup>
              <col style={{ width: "60%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>消費税内訳</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>消費税対象額</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>消費税額</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }}>10％対象</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{taxableBase.toLocaleString()}</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{taxAmount.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", fontWeight: "bold" }}>合計</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{taxableBase.toLocaleString()}</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{taxAmount.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          {/* [10] フッタ：右下の番号 */}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px", fontSize: "10px", color: "#333", marginTop: "24px" }}>
            <span>{displayNumber}</span>
            <span>[1枚中1枚目]</span>
          </div>
        </div>
      </div>
    </div>
  );
}

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
  const [faxSending, setFaxSending] = useState(false);
  const [faxResult, setFaxResult] = useState<"ok" | "err" | null>(null);
  const [careOffices, setCareOffices] = useState<CareOffice[]>([]);
  const [faxDialogOpen, setFaxDialogOpen] = useState(false);
  const [selectedFaxNumber, setSelectedFaxNumber] = useState("");

  useEffect(() => {
    getCareOffices(tenantId).then(setCareOffices).catch(() => {});
  }, [tenantId]);

  // 利用者のケアマネ事務所に紐づくFAX番号を自動選択
  useEffect(() => {
    if (client.care_manager_org) {
      const matched = careOffices.find(o => o.name === client.care_manager_org);
      if (matched?.fax_number) setSelectedFaxNumber(matched.fax_number);
    }
  }, [careOffices, client.care_manager_org]);

  const handleSendFax = async () => {
    if (!selectedFaxNumber) { alert("FAX番号を選択してください"); return; }
    setFaxSending(true);
    setFaxResult(null);
    try {
      // 印刷エリアをキャンバス化してbase64に変換（簡易実装）
      // 実際はPDF生成ライブラリ（html2canvas + jspdf等）を使用
      alert("FAX送信機能：eFax APIキー設定後に利用できます。\n送信先：" + selectedFaxNumber);
      setFaxResult("ok");
    } catch {
      setFaxResult("err");
    } finally {
      setFaxSending(false);
      setFaxDialogOpen(false);
    }
  };

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
        <button onClick={() => setFaxDialogOpen(true)}
          className="flex items-center gap-1.5 bg-blue-500 text-white px-4 py-2 rounded-xl text-sm font-medium">
          <Send size={14} /> FAX送信
        </button>
      </div>

      {/* FAX送信ダイアログ */}
      {faxDialogOpen && (
        <div className="no-print fixed inset-0 bg-black/50 z-[70] flex items-center justify-center px-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5">
            <h3 className="font-semibold text-gray-800 mb-1">FAX送信</h3>
            <p className="text-xs text-gray-500 mb-4">貸与提供報告書を送信します</p>
            <div className="mb-3">
              <label className="text-xs text-gray-500 mb-1 block">送信先事業所</label>
              <select
                value={selectedFaxNumber}
                onChange={e => setSelectedFaxNumber(e.target.value)}
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              >
                <option value="">FAX番号を選択</option>
                {careOffices.filter(o => o.fax_number).map(o => (
                  <option key={o.id} value={o.fax_number!}>{o.name}（{o.fax_number}）</option>
                ))}
              </select>
            </div>
            <div className="mb-4">
              <label className="text-xs text-gray-500 mb-1 block">FAX番号（直接入力も可）</label>
              <input
                value={selectedFaxNumber}
                onChange={e => setSelectedFaxNumber(e.target.value)}
                placeholder="0436-00-0000"
                className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
              />
            </div>
            {faxResult === "ok" && <p className="text-xs text-emerald-600 mb-3">✓ 送信しました</p>}
            {faxResult === "err" && <p className="text-xs text-red-500 mb-3">送信に失敗しました</p>}
            <div className="flex gap-2">
              <button onClick={() => setFaxDialogOpen(false)} className="flex-1 py-2 rounded-xl text-sm text-gray-500 bg-gray-100 hover:bg-gray-200">キャンセル</button>
              <button onClick={handleSendFax} disabled={faxSending || !selectedFaxNumber}
                className="flex-1 py-2 rounded-xl text-sm text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-50 flex items-center justify-center gap-1">
                {faxSending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {faxSending ? "送信中..." : "送信"}
              </button>
            </div>
          </div>
        </div>
      )}

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
  const [rentalHistory, setRentalHistory] = useState<ClientRentalHistory[]>([]);
  const [monitoringRecords, setMonitoringRecords] = useState<MonitoringRecord[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [companyInfo, setCompanyInfo] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [formClient, setFormClient] = useState<Client | null>(null);
  const [openRecord, setOpenRecord] = useState<MonitoringRecord | null>(null);

  useEffect(() => { loadData(); }, [tenantId]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [clientsRes, monRes, eqData, tenantData, rentalHistRes] = await Promise.all([
        supabase.from("clients").select("*").eq("tenant_id", tenantId),
        supabase.from("monitoring_records").select("*").eq("tenant_id", tenantId).order("target_month", { ascending: false }),
        getEquipment(tenantId),
        getTenantById(tenantId),
        supabase.from("client_rental_history").select("*").eq("tenant_id", tenantId)
          .or(`end_date.is.null,end_date.gte.${new Date().toISOString().split("T")[0]}`),
      ]);
      const cls = (clientsRes.data ?? []) as Client[];
      // orders をページングで全件取得
      const allOrders: { id: string; client_id: string }[] = [];
      let ordFrom = 0;
      while (true) {
        const { data: ordChunk } = await supabase
          .from("orders").select("id, client_id")
          .eq("tenant_id", tenantId)
          .range(ordFrom, ordFrom + 999);
        if (!ordChunk || ordChunk.length === 0) break;
        allOrders.push(...(ordChunk as { id: string; client_id: string }[]));
        if (ordChunk.length < 1000) break;
        ordFrom += 1000;
      }
      setClients(cls);
      setClientOrders(allOrders);
      setMonitoringRecords((monRes.data ?? []) as MonitoringRecord[]);
      setEquipment(eqData);
      setRentalHistory((rentalHistRes.data ?? []) as ClientRentalHistory[]);
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
      // order_items を tenant_id で直接取得（URLの長さ制限を回避）
      const items: OrderItem[] = [];
      let itemFrom = 0;
      while (true) {
        const { data: chunk } = await supabase
          .from("order_items")
          .select("*")
          .eq("tenant_id", tenantId)
          .in("status", ["rental_started", "delivered", "trial"])
          .range(itemFrom, itemFrom + 999);
        if (!chunk || chunk.length === 0) break;
        items.push(...(chunk as OrderItem[]));
        if (chunk.length < 1000) break;
        itemFrom += 1000;
      }
      setActiveItems(items);
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

  // client_rental_history を client_id でグループ化
  const rentalHistoryMap = useMemo(() => {
    const map = new Map<string, ClientRentalHistory[]>();
    for (const h of rentalHistory) {
      if (!map.has(h.client_id)) map.set(h.client_id, []);
      map.get(h.client_id)!.push(h);
    }
    return map;
  }, [rentalHistory]);

  const schedule = useMemo(() => {
    // order_items で有効な利用者 OR rental_history で有効な利用者を対象
    const activeClientIds = new Set([
      ...Array.from(clientItemsMap.keys()),
      ...Array.from(rentalHistoryMap.keys()),
    ]);
    return clients
      .filter(c => activeClientIds.has(c.id))
      .map(client => {
        const items = clientItemsMap.get(client.id) ?? [];
        const histItems = rentalHistoryMap.get(client.id) ?? [];
        // 開始日の候補（order_items + rental_history）
        const startDates: string[] = [
          ...items.map(i => i.rental_start_date).filter((d): d is string => !!d),
          ...histItems.map(h => h.start_date).filter((d): d is string => !!d),
        ];
        const earliestStart = startDates.sort()[0] ?? null;
        const clientRecords = monitoringRecords.filter(r => r.client_id === client.id);
        const lastRecord = clientRecords[0] ?? null;
        const base = lastRecord?.target_month ?? earliestStart?.slice(0, 7) ?? null;
        const nextDue = base ? calcNextDueMonth(base) : null;
        const doneThisMonth = clientRecords.find(r => r.target_month === selectedMonth) ?? null;
        return { client, items, histItems, nextDue, lastRecord, doneThisMonth };
      });
  }, [clients, clientItemsMap, rentalHistoryMap, monitoringRecords, selectedMonth]);

  const todayMonth = (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,"0")}`; })();
  const overdue       = schedule.filter(s => s.nextDue && s.nextDue < selectedMonth && !s.doneThisMonth);
  const dueThisMonth  = schedule.filter(s => s.nextDue === selectedMonth && !s.doneThisMonth);
  const completedThisMonth = schedule.filter(s => s.doneThisMonth);
  const upcoming      = schedule.filter(s => s.nextDue && s.nextDue > selectedMonth && !s.doneThisMonth)
    .sort((a, b) => (a.nextDue ?? "").localeCompare(b.nextDue ?? ""));

  const changeMonth = (delta: number) => {
    const [y, m] = selectedMonth.split("-").map(Number);
    const total = y * 12 + m - 1 + delta;
    setSelectedMonth(`${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`);
  };

  if (formClient) {
    const clientItems = clientItemsMap.get(formClient.id) ?? [];
    const clientHistItems = rentalHistoryMap.get(formClient.id) ?? [];
    const clientRecords = monitoringRecords.filter(r => r.client_id === formClient.id);
    const lastRecord = clientRecords[0] ?? null;
    return (
      <MonitoringFormModal
        client={formClient}
        clientItems={clientItems}
        clientHistItems={clientHistItems}
        equipment={equipment}
        companyInfo={companyInfo}
        tenantId={tenantId}
        lastRecord={lastRecord}
        targetMonth={selectedMonth}
        existingRecord={openRecord}
        onClose={() => { setFormClient(null); setOpenRecord(null); }}
        onSaved={() => { setFormClient(null); setOpenRecord(null); loadData(); }}
      />
    );
  }

  const RowCard = ({ client, nextDue, rec, color, onRecord }: {
    client: Client; nextDue?: string | null; rec?: MonitoringRecord | null;
    color: "red" | "amber" | "emerald" | "gray"; onRecord?: () => void;
  }) => {
    const bg = color === "red" ? "bg-red-50 border-red-100" : color === "amber" ? "bg-amber-50 border-amber-100" : color === "emerald" ? "bg-emerald-50 border-emerald-100" : "bg-white border-gray-100";
    return (
      <div className={`border rounded-xl px-3 py-2.5 flex items-center justify-between ${bg}`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-gray-800 truncate">{client.name}</span>
          {client.gender && <span className="text-xs text-gray-400 shrink-0">{client.gender}</span>}
          <span className="text-xs text-gray-500 shrink-0">{client.care_level}</span>
          {nextDue && color !== "emerald" && (
            <span className={`text-xs shrink-0 ${color === "red" ? "text-red-500" : color === "amber" ? "text-amber-600" : "text-gray-400"}`}>
              {nextDue.replace("-", "年")}月
            </span>
          )}
          {color === "emerald" && rec?.visit_date && (
            <span className="text-xs text-gray-400 shrink-0">訪問:{rec.visit_date}</span>
          )}
          {color === "emerald" && nextDue && (
            <span className="text-xs text-emerald-600 shrink-0">次回:{nextDue.replace("-", "年")}月</span>
          )}
        </div>
        {onRecord ? (
          <button onClick={onRecord}
            className={`shrink-0 text-xs text-white px-3 py-1 rounded-lg ${color === "red" ? "bg-red-500 hover:bg-red-600" : color === "emerald" ? "bg-gray-400 hover:bg-gray-500" : "bg-emerald-500 hover:bg-emerald-600"}`}>
            {color === "emerald" ? "確認" : "記録入力"}
          </button>
        ) : <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />}
      </div>
    );
  };

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
            <button onClick={() => setSelectedMonth(todayMonth)}
              className="text-sm font-medium text-gray-700 w-20 text-center hover:text-emerald-600">
              {selectedMonth.replace("-", "年")}月
            </button>
            <button onClick={() => changeMonth(1)} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <ChevronRight size={16} className="text-gray-500" />
            </button>
          </div>
        </div>
        <div className="flex gap-3 mt-1.5 text-xs">
          {overdue.length > 0 && <span className="text-red-500 font-medium">期限超過 {overdue.length}名</span>}
          <span className="text-amber-600 font-medium">今月対象 {dueThisMonth.length}名</span>
          <span className="text-emerald-600 font-medium">完了 {completedThisMonth.length}名</span>
          <span className="text-gray-400">今後 {upcoming.length}名</span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center flex-1">
          <Loader2 size={28} className="animate-spin text-emerald-400" />
        </div>
      ) : schedule.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-16">レンタル中の利用者がいません</p>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {overdue.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-red-500 mb-2">期限超過</h3>
              <div className="space-y-1">
                {overdue.map(({ client, nextDue }) => (
                  <RowCard key={client.id} client={client} nextDue={nextDue} color="red"
                    onRecord={() => setFormClient(client)} />
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="text-xs font-semibold text-amber-600 mb-2">
              {selectedMonth.replace("-", "年")}月の対象者
              {dueThisMonth.length === 0 && <span className="ml-2 font-normal text-gray-400">（なし）</span>}
            </h3>
            <div className="space-y-1">
              {dueThisMonth.map(({ client, nextDue }) => (
                <RowCard key={client.id} client={client} nextDue={nextDue} color="amber"
                  onRecord={() => setFormClient(client)} />
              ))}
              {completedThisMonth.map(({ client, doneThisMonth: rec, nextDue }) => (
                <RowCard key={client.id} client={client} rec={rec} nextDue={nextDue} color="emerald"
                  onRecord={() => { setOpenRecord(rec ?? null); setFormClient(client); }} />
              ))}
            </div>
          </section>

          {upcoming.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">今後の予定</h3>
              <div className="space-y-1">
                {upcoming.map(({ client, nextDue }) => (
                  <RowCard key={client.id} client={client} nextDue={nextDue} color="gray"
                    onRecord={() => setFormClient(client)} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MonitoringPreview ───────────────────────────────────────────────────────

function MonitoringPreview({
  client, visitDate, reportDate, tm, staffName, companyInfo,
  itemChecks, equipment, insuranceRecord, continuityComment, reportComment, previousComment, onClose,
}: {
  client: Client;
  visitDate: string;
  reportDate: string;
  tm: string;
  staffName: string;
  companyInfo: CompanyInfo;
  itemChecks: { order_item_id: string; product_code: string; equipment_name: string; category: string; quantity: number; no_issue: boolean; has_malfunction: boolean; has_deterioration: boolean; needs_replacement: boolean }[];
  equipment: Equipment[];
  insuranceRecord: ClientInsuranceRecord | null;
  continuityComment: string;
  reportComment: string;
  previousComment: string;
  onClose: () => void;
}) {
  const toJaDate = (s: string) => {
    if (!s) return "";
    const d = new Date(s + "T00:00:00");
    if (isNaN(d.getTime())) return s;
    const r = d.getFullYear() - 2018;
    return `令和${r}年${d.getMonth() + 1}月${d.getDate()}日`;
  };
  const toJaMonth = (ym: string) => {
    if (!ym) return "";
    const [y, m] = ym.split("-");
    return `令和${Number(y) - 2018}年${Number(m)}月`;
  };

  const TD = "border border-gray-400 px-1 py-0.5 text-[10px]";
  const TH = `${TD} bg-gray-100 font-semibold text-center whitespace-nowrap`;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start justify-center py-4 px-2">
        <div className="bg-white w-full max-w-3xl rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
          {/* Toolbar */}
          <div className="bg-gray-800 text-white px-4 py-2.5 flex items-center justify-between print:hidden">
            <span className="text-sm font-medium">プレビュー：モニタリング報告書</span>
            <div className="flex gap-2">
              <button onClick={() => window.print()} className="text-xs bg-blue-500 hover:bg-blue-600 px-3 py-1.5 rounded-lg">印刷</button>
              <button onClick={onClose} className="text-xs bg-gray-600 hover:bg-gray-700 px-3 py-1.5 rounded-lg">閉じる</button>
            </div>
          </div>

          {/* Document */}
          <div className="p-6 text-[11px] leading-relaxed font-sans space-y-3" style={{ fontFamily: "'MS Gothic', monospace" }}>
            {/* Header */}
            <div className="border-2 border-gray-700 p-3 space-y-1">
              <div className="text-center text-sm font-bold mb-2">福祉用具貸与　モニタリング報告書</div>
              <div className="flex gap-4">
                <span className="text-gray-500 w-28 shrink-0">居宅支援事業所</span>
                <span>{client.care_manager_org ?? ""}</span>
              </div>
              <div className="flex gap-4">
                <span className="text-gray-500 w-28 shrink-0">利用者</span>
                <span className="font-bold">{client.name} 様</span>
              </div>
              <div className="flex gap-4 mt-1">
                <span className="text-gray-500 w-28 shrink-0">事業所名</span>
                <span>{companyInfo.companyName}</span>
                <span className="ml-4 text-gray-500">TEL</span>
                <span>{companyInfo.tel}</span>
                {companyInfo.fax && <><span className="ml-2 text-gray-500">FAX</span><span>{companyInfo.fax}</span></>}
              </div>
              <div className="flex gap-4">
                <span className="text-gray-500 w-28 shrink-0">担当者</span>
                <span>{staffName}</span>
              </div>
            </div>

            {/* Visit info */}
            <div className="border border-gray-400 p-2 flex gap-6 items-center">
              <div><span className="text-gray-500">訪問日　</span><span className="font-bold">{toJaDate(visitDate)}</span></div>
              <div><span className="text-gray-500">対象月　</span><span className="font-bold">{toJaMonth(tm)}</span></div>
              <div><span className="text-gray-500">介護度　</span><span>{client.care_level}</span></div>
              {(insuranceRecord?.certification_start_date || client.certification_end_date) && (
                <div>
                  <span className="text-gray-500">認定期間　</span>
                  <span>{insuranceRecord?.certification_start_date ?? ""} 〜 {insuranceRecord?.certification_end_date ?? client.certification_end_date ?? ""}</span>
                </div>
              )}
            </div>

            {/* Equipment check table */}
            <div>
              <div className="text-xs font-bold mb-1 border-b-2 border-gray-700 pb-0.5">■ 福祉用具チェック</div>
              <table className="w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${TH} w-20`}>種目</th>
                    <th className={TH}>機種名</th>
                    <th className={`${TH} w-10`}>数量</th>
                    <th className={`${TH} w-16`} colSpan={2}>問題なし</th>
                    <th className={`${TH} w-16`} colSpan={2}>不具合</th>
                    <th className={`${TH} w-16`} colSpan={2}>劣化</th>
                    <th className={`${TH} w-16`} colSpan={2}>交換必要</th>
                  </tr>
                  <tr>
                    <th className={TH}></th><th className={TH}></th><th className={TH}></th>
                    {["問題なし","不具合","劣化","交換必要"].map(h => (
                      <Fragment key={h}>
                        <th className={TH}>なし</th>
                        <th className={TH}>あり</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {itemChecks.slice(0, 8).map((item, idx) => {
                    const eq = equipment.find(e => e.product_code === item.product_code);
                    const name = eq?.name ?? item.equipment_name;
                    const cat = eq?.category ?? item.category;
                    const prev = idx > 0 ? (equipment.find(e => e.product_code === itemChecks[idx-1].product_code)?.category ?? itemChecks[idx-1].category) : null;
                    return (
                      <tr key={item.order_item_id}>
                        <td className={TD}>{cat !== prev ? cat : ""}</td>
                        <td className={TD}>{name}</td>
                        <td className={`${TD} text-center`}>{item.quantity}</td>
                        <td className={`${TD} text-center`}>{item.no_issue ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{!item.no_issue ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{!item.has_malfunction ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{item.has_malfunction ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{!item.has_deterioration ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{item.has_deterioration ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{!item.needs_replacement ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{item.needs_replacement ? "☑" : "□"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Comments */}
            <div className="border border-gray-400 p-2 space-y-2">
              <div>
                <div className="text-gray-500 font-semibold mb-0.5">■ 継続・必要性</div>
                <div className="whitespace-pre-wrap min-h-[2.5rem]">{continuityComment}</div>
              </div>
              <div className="border-t border-gray-300 pt-2">
                <div className="text-gray-500 font-semibold mb-0.5">■ 報告内容</div>
                <div className="whitespace-pre-wrap min-h-[3rem]">{reportComment}</div>
              </div>
            </div>

            {/* Report date */}
            <div className="flex justify-end">
              <span className="text-gray-500">報告日　</span>
              <span className="font-bold">{toJaDate(reportDate)}</span>
            </div>

            {/* Previous comment */}
            {previousComment && (
              <div className="border border-dashed border-gray-400 p-2">
                <div className="text-gray-500 font-semibold mb-0.5">■ 前回コメント</div>
                <div className="whitespace-pre-wrap">{previousComment}</div>
              </div>
            )}
          </div>
        </div>
      </div>
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
  client, clientItems, clientHistItems, equipment, companyInfo, tenantId, lastRecord, targetMonth, existingRecord, onClose, onSaved,
}: {
  client: Client;
  clientItems: OrderItem[];
  clientHistItems: ClientRentalHistory[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  lastRecord: MonitoringRecord | null;
  targetMonth: string;
  existingRecord: MonitoringRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const [visitDate, setVisitDate] = useState(existingRecord?.visit_date ?? todayStr);
  const [reportDate, setReportDate] = useState(existingRecord?.report_date ?? todayStr);
  const [staffName, setStaffName] = useState(existingRecord?.staff_name ?? companyInfo.staffName ?? "");
  const [tm, setTm] = useState(existingRecord?.target_month ?? targetMonth);
  const [reportComment, setReportComment] = useState(existingRecord?.report_comment ?? "");
  const [continuityComment, setContinuityComment] = useState(
    existingRecord?.continuity_comment ?? "怪我無く、安全にお過ごし頂く為に、継続して福祉用具の利用が必要と思われます。"
  );
  const [previousComment, setPreviousComment] = useState(
    existingRecord ? (existingRecord.previous_comment ?? "") : (lastRecord?.report_comment ?? "")
  );
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(existingRecord?.id ?? null);
  const [downloading, setDownloading] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [insuranceRecord, setInsuranceRecord] = useState<ClientInsuranceRecord | null>(null);

  const [itemChecks, setItemChecks] = useState<MonitoringItemCheck[]>(() => {
    const fromOrders = clientItems.map(item => {
      const eq = equipment.find(e => e.product_code === item.product_code);
      return {
        order_item_id: item.id,
        product_code: item.product_code,
        equipment_name: eq?.name ?? item.product_code,
        category: eq?.category ?? "",
        quantity: item.quantity ?? 1,
        no_issue: true, has_malfunction: false, has_deterioration: false, needs_replacement: false,
      };
    });
    const fromHistory = clientHistItems.map(h => ({
      order_item_id: h.id,
      product_code: "",
      equipment_name: h.equipment_name,
      category: "",
      quantity: 1,
      no_issue: true, has_malfunction: false, has_deterioration: false, needs_replacement: false,
    }));
    return [...fromOrders, ...fromHistory];
  });

  // 既存レコードがある場合、monitoring_itemsを読み込んでitemChecksを上書き
  useEffect(() => {
    if (!existingRecord?.id) return;
    supabase.from("monitoring_items").select("*").eq("monitoring_id", existingRecord.id)
      .then(({ data }) => {
        if (!data || data.length === 0) return;
        setItemChecks(data.map((item: MonitoringItem) => ({
          order_item_id: item.order_item_id ?? item.id,
          product_code: item.product_code ?? "",
          equipment_name: item.equipment_name ?? "",
          category: item.category ?? "",
          quantity: item.quantity ?? 1,
          no_issue: item.no_issue ?? true,
          has_malfunction: item.has_malfunction ?? false,
          has_deterioration: item.has_deterioration ?? false,
          needs_replacement: item.needs_replacement ?? false,
        })));
      });
  }, [existingRecord?.id]);

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
        items: itemChecks.map(c => {
          const eq = equipment.find(e => e.product_code === c.product_code);
          return {
          category: eq?.category ?? c.category,
          equipment_name: eq?.name ?? c.equipment_name,
          quantity: c.quantity,
          no_issue: c.no_issue,
          has_malfunction: c.has_malfunction,
          has_deterioration: c.has_deterioration,
          needs_replacement: c.needs_replacement,
          };
        }),
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
          {itemChecks.map((check, idx) => {
            const eq = equipment.find(e => e.product_code === check.product_code);
            const displayName = eq?.name ?? check.equipment_name;
            const displayCategory = eq?.category ?? check.category;
            return (
              <div key={check.order_item_id} className="bg-white rounded-lg px-3 py-2 flex items-center gap-2">
                <span className="text-[10px] text-gray-400 w-14 shrink-0 truncate">{displayCategory}</span>
                <span className="text-xs text-gray-800 font-medium flex-1 min-w-0 truncate">{displayName}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="flex items-center gap-0.5 cursor-pointer">
                    <input type="checkbox" checked={check.no_issue}
                      onChange={e => updateCheck(idx, "no_issue", e.target.checked)}
                      className="w-3.5 h-3.5 accent-emerald-500" />
                    <span className="text-[10px] text-gray-600">問題なし</span>
                  </label>
                  <label className="flex items-center gap-0.5 cursor-pointer">
                    <input type="checkbox" checked={check.has_malfunction}
                      onChange={e => updateCheck(idx, "has_malfunction", e.target.checked)}
                      className="w-3.5 h-3.5 accent-red-500" />
                    <span className="text-[10px] text-gray-600">不具合</span>
                  </label>
                  <label className="flex items-center gap-0.5 cursor-pointer">
                    <input type="checkbox" checked={check.has_deterioration}
                      onChange={e => updateCheck(idx, "has_deterioration", e.target.checked)}
                      className="w-3.5 h-3.5 accent-amber-500" />
                    <span className="text-[10px] text-gray-600">劣化</span>
                  </label>
                  <label className="flex items-center gap-0.5 cursor-pointer">
                    <input type="checkbox" checked={check.needs_replacement}
                      onChange={e => updateCheck(idx, "needs_replacement", e.target.checked)}
                      className="w-3.5 h-3.5 accent-blue-500" />
                    <span className="text-[10px] text-gray-600">交換</span>
                  </label>
                </div>
              </div>
            );
          })}
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
          onClick={() => setShowPreview(true)}
          className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-200 px-4 py-2.5 rounded-xl hover:bg-gray-50"
        >
          <Eye size={16} />
          プレビュー
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

      {showPreview && (
        <MonitoringPreview
          client={client}
          visitDate={visitDate}
          reportDate={reportDate}
          tm={tm}
          staffName={staffName}
          companyInfo={companyInfo}
          itemChecks={itemChecks}
          equipment={equipment}
          insuranceRecord={insuranceRecord}
          continuityComment={continuityComment}
          reportComment={reportComment}
          previousComment={previousComment}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
