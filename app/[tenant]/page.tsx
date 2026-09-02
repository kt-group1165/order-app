"use client";

import { useState, useEffect, use, useCallback, Fragment, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Package,
  ClipboardList,
  Users,
  Settings,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  Search,
  X,
  Plus,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Bell,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  Truck,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  PlayCircle,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  Ban,
  RotateCcw,
  Mail,
  Send,
  FileText,
  ClipboardCheck,
  CreditCard,
  FileWarning,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  AlertTriangle,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  RefreshCw,
  Trash2,
  Clock,
  CalendarClock,
  Hammer,
} from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Client, Supplier, Member, EquipmentPriceHistory, ClientDocument, ClientInsuranceRecord, ClientRentalHistory, ClientHospitalization } from "@/lib/supabase";
import { getClientDocuments, deleteClientDocument } from "@/lib/documents";
import { mapWithConcurrency } from "@/lib/concurrency";
import { monthEndYmd, todayYmd } from "@/lib/date-jst";
import { type CompanyInfo, COMPANY_INFO_DEFAULTS } from "./company-info";
import { type CareOfficeChoice } from "./SendRentalReportModal";
import { HW_KANA, normalizeSearch, matchEquipment, matchClient } from "./search-utils";
import { STATUS_LABEL, STATUS_COLOR, NEXT_STATUSES } from "./order-item-helpers";
import CarePlanModal from "./CarePlanModal";
import ProposalModal from "./ProposalModal";
import ContractDocumentsModal from "./ContractDocumentsModal";
import RentalReportModal from "./RentalReportModal";
import OrderEmailPreviewModal from "./OrderEmailPreviewModal";
import { getOrders, getOrderItems, updateOrderItemStatus, getAllOrderItemsByTenant, createOrder, createOrderItem, getMembers, mergeOrders, unmergeOrder } from "@/lib/orders";
import { getEquipment, getSuppliers, getPriceHistory, getPriceForMonth, getEquipmentSetItems, getPurchasePrices, getPurchasePriceForMonth } from "@/lib/equipment";
import { getClients, promoteProvisionalClient, softDeleteClient, restoreClient } from "@/lib/clients";
import { getTenants, getTenantById, type Tenant } from "@/lib/tenants";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
import { getOffices, getOfficePrices, createOffice, updateOffice, deleteOffice, upsertOfficePrice, deleteOfficePrice, bulkUpsertOfficePrices, getClientOfficeAssignments, assignClientToOffice, removeClientFromOffice, getClientAssignmentsForClient, ensureActiveAssignment, closeActiveAssignment, addAssignment, updateAssignment, deleteAssignment, type Office, type EquipmentOfficePrice, type ClientOfficeAssignment } from "@/lib/offices";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
import { getCareOffices, upsertCareOffice, deleteCareOffice, sendFax, getCareManagers, addCareManager, updateCareManager, deleteCareManager, type CareOffice, type CareManager } from "@/lib/careOffices";
// 2026-09-02: 全タブを next/dynamic 化 (PERF_CLEANUP_MISSION.md 案A)。
//   以前は静的importのため既に別ファイルのタブも同一chunkにバンドルされていた
//   (ファイル分割はできていたがコード分割=バンドルサイズ削減の効果は無かった)。
//   dynamic() + ssr:false でタブを開くまでロードしないようにする。
const TabLoadingFallback = () => (
  <div className="flex items-center justify-center py-20 text-gray-400">
    <Loader2 size={24} className="animate-spin" />
  </div>
);
const OvertimeTab = dynamic(() => import("./OvertimeTab"), { ssr: false, loading: TabLoadingFallback });
const AttendanceTab = dynamic(() => import("./AttendanceTab"), { ssr: false, loading: TabLoadingFallback });
const RenovationTab = dynamic(() => import("./RenovationTab"), { ssr: false, loading: TabLoadingFallback });
const NotificationsTab = dynamic(() => import("./NotificationsTab"), { ssr: false, loading: TabLoadingFallback });
const StaffTab = dynamic(() => import("./StaffTab"), { ssr: false, loading: TabLoadingFallback });
const MeetingNotesTab = dynamic(() => import("./MeetingNotesTab"), { ssr: false, loading: TabLoadingFallback });
const DemoUnitsTab = dynamic(() => import("./DemoUnitsTab"), { ssr: false, loading: TabLoadingFallback });
const DocTasksTab = dynamic(() => import("./DocTasksTab"), { ssr: false, loading: TabLoadingFallback });
const MonitoringTab = dynamic(() => import("./MonitoringTab"), { ssr: false, loading: TabLoadingFallback });
const EquipmentTab = dynamic(() => import("./EquipmentTab"), { ssr: false, loading: TabLoadingFallback });
const DocumentsTab = dynamic(() => import("./DocumentsTab"), { ssr: false, loading: TabLoadingFallback });
const SettingsTab = dynamic(() => import("./SettingsTab"), { ssr: false, loading: TabLoadingFallback });
const BillingTab = dynamic(() => import("./BillingTab"), { ssr: false, loading: TabLoadingFallback });
import { getMaxUserNumber } from "@kt/shared/user-number";
import { getUnreadCount } from "@/lib/notifications";

// ─── Status helpers ─────────────────────────────────────────────────────────
// (STATUS_LABEL/STATUS_COLOR/NEXT_STATUSES/calcMonthUnits/toShortDate/RPT_* は
//  ./order-item-helpers.ts へ移設。CarePlanModal 等の分割ファイルからも使うため)

// ─── Types ──────────────────────────────────────────────────────────────────

type Tab = "home" | "orders" | "equipment" | "clients" | "monitoring" | "meeting-notes" | "demo-units" | "billing" | "documents" | "doc-tasks" | "staff" | "overtime" | "attendance" | "renovation" | "notifications" | "settings";

// ホーム(メニュー一覧)画面
function HomeMenu({ tenantName, onNavigate }: { tenantName: string; onNavigate: (t: Tab) => void }) {
  const items: { id: Tab; icon: React.ElementType; label: string; desc: string }[] = [
    { id: "orders", icon: ClipboardList, label: "発注管理", desc: "福祉用具の発注・納品・レンタル" },
    { id: "clients", icon: Users, label: "利用者別", desc: "利用者ごとの情報・履歴" },
    { id: "documents", icon: FileText, label: "書類", desc: "利用者の書類管理" },
    { id: "doc-tasks", icon: FileWarning, label: "書類タスク", desc: "期限・不足書類の管理" },
    { id: "monitoring", icon: ClipboardCheck, label: "モニタリング", desc: "モニタリング記録" },
    { id: "staff", icon: Users, label: "職員", desc: "スタッフ管理" },
    { id: "overtime", icon: Clock, label: "残業管理", desc: "残業許可申請・承認・残業時間管理表" },
    { id: "attendance", icon: CalendarClock, label: "出勤簿", desc: "日次の出退勤入力・月次残業時間の集計" },
    { id: "meeting-notes", icon: ClipboardCheck, label: "担当者会議録", desc: "サービス担当者会議の要点(第4表)" },
    { id: "demo-units", icon: Package, label: "デモ機管理", desc: "特定福祉用具のデモ貸出状況" },
    { id: "renovation", icon: Hammer, label: "住宅改修", desc: "訪問〜役所提出までの進行状況・粗利集計" },
    { id: "billing", icon: CreditCard, label: "請求", desc: "月次請求・売上帳票・損益" },
    { id: "equipment", icon: Package, label: "用具マスタ", desc: "用具・価格・卸の管理" },
    { id: "settings", icon: Settings, label: "設定", desc: "会社情報・卸会社・各種マスタ" },
  ];
  return (
    <div className="h-full overflow-y-auto bg-gray-50 p-4 sm:p-6">
      <div className="max-w-4xl mx-auto">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-gray-800">{tenantName}</h2>
          <p className="text-xs text-gray-400">メニューを選択してください</p>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {items.map(({ id, icon: Icon, label, desc }) => (
            <button
              key={id}
              onClick={() => onNavigate(id)}
              className="bg-white rounded-2xl border border-gray-200 shadow-sm p-4 text-left hover:border-emerald-300 hover:shadow transition-all flex flex-col gap-2"
            >
              <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
                <Icon size={20} className="text-emerald-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-800">{label}</p>
                <p className="text-[11px] text-gray-400 mt-0.5 leading-snug">{desc}</p>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

type OrderWithItems = Order & { items: OrderItem[] };

type PendingChange = {
  item: OrderItem;
  newStatus: OrderItem["status"];
  date?: string;        // rental_start_date or rental_end_date
  deliveredAt?: string; // 発注済→レンタル開始ダイレクト時の納品日
};

// ─── Main Page ──────────────────────────────────────────────────────────────

const CURRENT_OFFICE_KEY = (tenantId: string) => `current_office_${tenantId}`;
const OFFICE_VIEW_MODE_KEY = (tenantId: string) => `office_view_mode_${tenantId}`;

export default function TenantPage({
  params,
}: {
  params: Promise<{ tenant: string }>;
}) {
  const { tenant: tenantId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  // 旧 slug `/care-chiba` 互換: kt-group + ケア・サポート千葉 office に redirect
  // (Phase A2 で tenant=care-chiba は削除済、data は kt-group + office=1bfc0d57 に統合済)
  useEffect(() => {
    if (tenantId === "care-chiba") {
      router.replace(`/kt-group?office=1bfc0d57-9ee0-4ae2-baa5-80edb776290a`);
    }
  }, [tenantId, router]);

  const urlOfficeId = searchParams.get("office");
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [tenantName, setTenantName] = useState(tenantId);
  const [ordersDirty, setOrdersDirty] = useState(false);
  // 出勤簿タブの未保存件数 (0 = 変更なし)。タブ離脱時の警告に使う
  const [attendanceDirty, setAttendanceDirty] = useState(0);
  const [pendingTabChange, setPendingTabChange] = useState<Tab | null>(null);
  const [clientTabTarget, setClientTabTarget] = useState<string | null>(null);
  // 書類タスク → Documents タブ遷移時に、対象 client を pre-select するための受け渡し
  // v2: doc_task.id と expected_doc_type も渡し、modal auto-open + 完了時 task close
  const [docsTabTarget, setDocsTabTarget] = useState<{
    clientId: string;
    docTaskId?: string | null;
    expectedDocType?: string | null;
  } | null>(null);
  // 事業所切替: URL ?office= が primary、無ければ localStorage、それも無ければ null
  const [currentOfficeId, setCurrentOfficeId] = useState<string | null>(urlOfficeId);
  const [officeViewAll, setOfficeViewAll] = useState(false); // false=自事業所のみ, true=全事業所

  // URL ?office= 変更時 (戻る/進む等) は state を追従
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL synchronization
    setCurrentOfficeId(urlOfficeId);
  }, [urlOfficeId]);

  // ヘッダー表示用: ログイン中 (URL ?office=) の事業所名
  const [currentOfficeName, setCurrentOfficeName] = useState<string | null>(null);
  useEffect(() => {
    if (!currentOfficeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount init / office 切替追従)
      setCurrentOfficeName(null);
      return;
    }
    let active = true;
    getOffices(tenantId)
      .then((ofs) => { if (active) setCurrentOfficeName(ofs.find((o) => o.id === currentOfficeId)?.name ?? null); })
      .catch(() => {});
    return () => { active = false; };
  }, [tenantId, currentOfficeId]);

  useEffect(() => {
    getTenants().then((list) => {
      const found = list.find((t) => t.id === tenantId);
      if (found) setTenantName(found.name);
    });
    // URL 未指定時のみ localStorage を fallback として読む
    if (!urlOfficeId && typeof window !== "undefined") {
      const savedOffice = localStorage.getItem(CURRENT_OFFICE_KEY(tenantId));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
      if (savedOffice) setCurrentOfficeId(savedOffice);
    }
    if (typeof window !== "undefined") {
      const savedMode = localStorage.getItem(OFFICE_VIEW_MODE_KEY(tenantId));
      if (savedMode === "all") setOfficeViewAll(true);
    }
  }, [tenantId, urlOfficeId]);

  const handleOfficeChange = (officeId: string | null) => {
    setCurrentOfficeId(officeId);
    if (typeof window !== "undefined") {
      if (officeId) localStorage.setItem(CURRENT_OFFICE_KEY(tenantId), officeId);
      else localStorage.removeItem(CURRENT_OFFICE_KEY(tenantId));
    }
    // URL も更新
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (officeId) params.set("office", officeId);
    else params.delete("office");
    router.replace(`/${tenantId}?${params.toString()}`);
  };

  const handleOfficeViewModeChange = (viewAll: boolean) => {
    setOfficeViewAll(viewAll);
    if (typeof window !== "undefined") {
      localStorage.setItem(OFFICE_VIEW_MODE_KEY(tenantId), viewAll ? "all" : "mine");
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-emerald-600 text-white px-4 py-3 flex items-center gap-2 shrink-0">
        <button
          onClick={() => {
            const leavingDirty =
              (activeTab === "orders" && ordersDirty) ||
              (activeTab === "attendance" && attendanceDirty > 0);
            if (activeTab !== "home" && leavingDirty) setPendingTabChange("home");
            else setActiveTab("home");
          }}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          title="ホームメニューへ"
        >
          <Package size={20} className="shrink-0" />
          <div className="min-w-0">
            <h1 className="text-base font-semibold truncate leading-tight">{tenantName}</h1>
            {currentOfficeName && (
              <p className="text-[10px] text-emerald-200 truncate leading-tight">{currentOfficeName}</p>
            )}
          </div>
        </button>
        <HeaderNotificationBadge currentOfficeId={currentOfficeId} onClick={() => setActiveTab("notifications")} />
        <span className="text-xs text-emerald-200">用具・発注管理</span>
        <span className="text-[10px] text-emerald-300 font-mono ml-1">v0.7.10</span>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "home" && <HomeMenu tenantName={tenantName} onNavigate={setActiveTab} />}
        {activeTab === "orders" && <OrdersTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} onDirtyChange={setOrdersDirty} onSwitchToClient={(clientId) => { setClientTabTarget(clientId); setActiveTab("clients"); }} />}
        {activeTab === "equipment" && <EquipmentTab tenantId={tenantId} />}
        {activeTab === "clients" && <ClientsTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} onOfficeViewAllChange={handleOfficeViewModeChange} initialClientId={clientTabTarget} onClearInitialClient={() => setClientTabTarget(null)} />}
        {activeTab === "monitoring" && <MonitoringTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} />}
        {activeTab === "doc-tasks" && <DocTasksTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} onOpenDocuments={(clientId, docTaskId, expectedDocType) => { setDocsTabTarget(clientId ? { clientId, docTaskId, expectedDocType } : null); setActiveTab("documents"); }} />}
        {activeTab === "billing" && <BillingTab tenantId={tenantId} currentOfficeId={currentOfficeId} />}
        {activeTab === "documents" && <DocumentsTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} initialSelectedClientId={docsTabTarget?.clientId ?? null} initialDocTaskId={docsTabTarget?.docTaskId ?? null} initialExpectedDocType={docsTabTarget?.expectedDocType ?? null} onClearInitialClient={() => setDocsTabTarget(null)} />}
        {activeTab === "staff" && <StaffTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} />}
        {activeTab === "overtime" && <OvertimeTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} />}
        {activeTab === "attendance" && <AttendanceTab tenantId={tenantId} currentOfficeId={currentOfficeId} onDirtyChange={setAttendanceDirty} />}
        {activeTab === "renovation" && <RenovationTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} />}
        {activeTab === "notifications" && <NotificationsTab currentOfficeId={currentOfficeId} />}
        {activeTab === "meeting-notes" && <MeetingNotesTab tenantId={tenantId} currentOfficeId={currentOfficeId} currentOfficeName={currentOfficeName} officeViewAll={officeViewAll} />}
        {activeTab === "demo-units" && <DemoUnitsTab tenantId={tenantId} currentOfficeId={currentOfficeId} />}
        {activeTab === "settings" && <SettingsTab tenantId={tenantId} currentOfficeId={currentOfficeId} officeViewAll={officeViewAll} onOfficeChange={handleOfficeChange} onViewModeChange={handleOfficeViewModeChange} />}
      </div>

      {/* Bottom Nav */}
      <nav className="bg-white border-t border-gray-200 flex shrink-0">
        {(
          [
            { id: "orders", icon: ClipboardList, label: "発注管理" },
            { id: "documents", icon: FileText, label: "書類" },
            { id: "doc-tasks", icon: FileWarning, label: "書類タスク" },
            { id: "clients", icon: Users, label: "利用者別" },
            { id: "staff", icon: Users, label: "職員" },
            { id: "monitoring", icon: ClipboardCheck, label: "モニタリング" },
            { id: "billing", icon: CreditCard, label: "請求" },
            { id: "equipment", icon: Package, label: "用具マスタ" },
            { id: "settings", icon: Settings, label: "設定" },
          ] as { id: Tab; icon: React.ElementType; label: string }[]
        ).map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => {
              const leavingDirty =
                (activeTab === "orders" && ordersDirty) ||
                (activeTab === "attendance" && attendanceDirty > 0);
              if (id !== activeTab && leavingDirty) {
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
                <p className="text-xs text-gray-500 mt-1">
                  {activeTab === "attendance"
                    ? `出勤簿の入力 ${attendanceDirty} 件が保存されていません。破棄して移動しますか？`
                    : "ステータス変更が保存されていません。このまま移動しますか？"}
                </p>
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
                onClick={() => {
                  setActiveTab(pendingTabChange);
                  setPendingTabChange(null);
                  setOrdersDirty(false);
                  setAttendanceDirty(0);
                }}
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
  const [nameRow, setNameRow] = useState<string>("all");
  const [orderSearch, setOrderSearch] = useState("");
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
  // 発注統合: 複数選択 ID
  const [selectedMergeIds, setSelectedMergeIds] = useState<Set<string>>(new Set());
  // 発注統合: 確認モーダル ({orders} = 統合対象、targetId = 統合先)
  const [mergeModal, setMergeModal] = useState<{ orders: OrderWithItems[]; targetId: string } | null>(null);
  // 発注統合: 候補 banner を表示するかどうか (利用者ごと展開状態)
  const [candidateBannerHiddenFor, setCandidateBannerHiddenFor] = useState<Set<string>>(new Set());
  // 発注統合: 実行中
  const [mergeExecuting, setMergeExecuting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Phase 8: officeViewAll=false なら currentOfficeId でサーバ側絞り込み
      const officeFilter = officeViewAll ? null : currentOfficeId;
      // 全 order_items を一括取得して order_id でグループ化（N+1 を排除）
      const [ordersData, allItems, clientsData, equipData, suppliersData, membersData] = await Promise.all([
        getOrders(tenantId, officeFilter),
        getAllOrderItemsByTenant(tenantId),
        getClients(tenantId, { officeId: officeFilter }),
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
  }, [tenantId, currentOfficeId, officeViewAll]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
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

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const clientName = (id: string | null) =>
    id ? (clientByIdOrders.get(id)?.name ?? id) : "（利用者未設定）";

  const equipName = (code: string) =>
    equipmentByCodeOrders.get(code)?.name ?? code;
  const equipCategory = (code: string) =>
    equipmentByCodeOrders.get(code)?.category ?? null;
  const ORDER_CAT_COLOR: Record<string, string> = {
    車いす: "bg-blue-100 text-blue-700",
    歩行器: "bg-purple-100 text-purple-700",
    ベッド: "bg-amber-100 text-amber-700",
    特殊寝台: "bg-amber-100 text-amber-700",
    手すり: "bg-pink-100 text-pink-700",
    スロープ: "bg-orange-100 text-orange-700",
  };
  const catColorOrders = (cat: string | null) =>
    cat ? (ORDER_CAT_COLOR[cat] ?? "bg-gray-100 text-gray-600") : "bg-gray-100 text-gray-600";

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
    // 検索フィルタ (利用者名・ふりがな・用具名・商品コード)
    let visibleGroups = groups;
    const q = normalizeSearch(orderSearch.trim());
    if (q) {
      visibleGroups = visibleGroups.filter((g) => {
        if (normalizeSearch(`${g.name}${g.furigana ?? ""}`).includes(q)) return true;
        return g.orders.some((o) =>
          o.items.some((i) => {
            const eqNm = equipmentByCodeOrders.get(i.product_code)?.name ?? i.product_code;
            return normalizeSearch(eqNm).includes(q) || normalizeSearch(i.product_code).includes(q);
          })
        );
      });
    }

    if (nameRow === "all") return visibleGroups;
    const row = KANA_ROWS.find((r) => r.label === nameRow);
    if (!row) return visibleGroups;
    return visibleGroups.filter((g) => row.chars.includes((g.furigana ?? "").trim().charAt(0)));
  }, [orders, filter, clientByIdOrders, nameRow, orderSearch, equipmentByCodeOrders]);

  const today = todayYmd();

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

  // ── 発注統合: 同日同利用者の order グループ検出 (clientGroups から計算) ──
  // returns Map<clientId, group[]> where each group has 2+ orders on same date
  const mergeCandidates = useMemo(() => {
    const result = new Map<string, OrderWithItems[][]>();
    for (const grp of clientGroups) {
      if (!grp.clientId) continue;
      // 同 client 内で ordered_at の date 部分でグルーピング
      const byDate = new Map<string, OrderWithItems[]>();
      for (const o of grp.orders) {
        // 統合済 (merged_from が空でない) はスキップ: 既に統合済なので候補から除外
        if ((o.merged_from_order_ids?.length ?? 0) > 0) continue;
        const date = (o.ordered_at ?? "").slice(0, 10);
        if (!date) continue;
        const arr = byDate.get(date) ?? [];
        arr.push(o);
        byDate.set(date, arr);
      }
      const groups: OrderWithItems[][] = [];
      for (const arr of byDate.values()) {
        if (arr.length >= 2) groups.push(arr);
      }
      if (groups.length > 0) result.set(grp.clientId, groups);
    }
    return result;
  }, [clientGroups]);

  // ── 要対応サマリー (filter 前の全 orders から集計) ──
  const actionSummary = useMemo(() => {
    let deliveryWait = 0; // 発注済のまま = 納品待ち
    let startWait = 0;    // 納品済/デモ中 = レンタル開始待ち
    for (const o of orders) {
      for (const i of o.items) {
        if (i.status === "ordered") deliveryWait++;
        else if (i.status === "delivered" || i.status === "trial") startWait++;
      }
    }
    let mergeCount = 0;
    for (const groups of mergeCandidates.values()) mergeCount += groups.length;
    return { deliveryWait, startWait, mergeCount };
  }, [orders, mergeCandidates]);

  const toggleSelectMerge = (orderId: string) => {
    setSelectedMergeIds((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId);
      else next.add(orderId);
      return next;
    });
  };

  // 選択された ID から統合 modal を開く (target = 最古、source = それ以外)
  const openMergeModalFromSelection = (clientId: string | null) => {
    const selected = orders.filter((o) => selectedMergeIds.has(o.id) && o.client_id === clientId);
    if (selected.length < 2) {
      alert("統合には 2 件以上の発注を選択してください");
      return;
    }
    // 最古を target にデフォルト
    const sorted = [...selected].sort(
      (a, b) => new Date(a.ordered_at).getTime() - new Date(b.ordered_at).getTime()
    );
    setMergeModal({ orders: sorted, targetId: sorted[0].id });
  };

  const openMergeModalForCandidates = (clientGroupOrders: OrderWithItems[]) => {
    const sorted = [...clientGroupOrders].sort(
      (a, b) => new Date(a.ordered_at).getTime() - new Date(b.ordered_at).getTime()
    );
    setMergeModal({ orders: sorted, targetId: sorted[0].id });
  };

  const handleExecuteMerge = async () => {
    if (!mergeModal) return;
    const target = mergeModal.targetId;
    const sources = mergeModal.orders.filter((o) => o.id !== target).map((o) => o.id);
    if (sources.length === 0) {
      alert("統合元が選択されていません");
      return;
    }
    setMergeExecuting(true);
    try {
      const res = await mergeOrders({ targetOrderId: target, sourceOrderIds: sources });
      if (res.warnings.length > 0) {
        alert(`統合完了 (${res.sources_merged} 件をマージ、${res.items_moved} 点を移動)\n\n警告:\n${res.warnings.join("\n")}`);
      }
      setMergeModal(null);
      setSelectedMergeIds(new Set());
      await load();
    } catch (e) {
      alert(`統合失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMergeExecuting(false);
    }
  };

  const handleUnmerge = async (orderId: string) => {
    if (!confirm("この統合を解除し、元の発注単位に戻しますか？")) return;
    setMergeExecuting(true);
    try {
      const res = await unmergeOrder(orderId);
      alert(`統合解除完了 (${res.restored_orders} 件を復元、${res.items_reassigned} 点を割戻し)${res.warning ? "\n警告: " + res.warning : ""}`);
      await load();
    } catch (e) {
      alert(`統合解除失敗: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setMergeExecuting(false);
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

      {/* 検索ボックス */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 shrink-0">
        <div className="flex items-center gap-2 border border-gray-200 rounded-xl px-3 py-1.5 bg-white max-w-md">
          <Search size={14} className="text-gray-400 shrink-0" />
          <input
            value={orderSearch}
            onChange={(e) => setOrderSearch(e.target.value)}
            placeholder="利用者名・用具名・コードで検索"
            className="flex-1 text-sm outline-none bg-transparent"
          />
          {orderSearch && (
            <button onClick={() => setOrderSearch("")} aria-label="検索をクリア">
              <X size={14} className="text-gray-400" />
            </button>
          )}
        </div>
      </div>

      {/* 要対応サマリー */}
      {(actionSummary.deliveryWait > 0 || actionSummary.startWait > 0 || actionSummary.mergeCount > 0) && (
        <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-2 overflow-x-auto shrink-0">
          <span className="shrink-0 text-[11px] text-gray-400 mr-1">要対応</span>
          {actionSummary.deliveryWait > 0 && (
            <button
              onClick={() => setFilter(filter === "ordered" ? "all" : "ordered")}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                filter === "ordered"
                  ? "bg-amber-500 text-white border-amber-500"
                  : "bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100"
              }`}
            >
              納品待ち {actionSummary.deliveryWait}件
            </button>
          )}
          {actionSummary.startWait > 0 && (
            <button
              onClick={() => setFilter(filter === "delivered" ? "all" : "delivered")}
              className={`shrink-0 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                filter === "delivered"
                  ? "bg-blue-500 text-white border-blue-500"
                  : "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100"
              }`}
            >
              開始待ち {actionSummary.startWait}件
            </button>
          )}
          {actionSummary.mergeCount > 0 && (
            <span className="shrink-0 px-3 py-1 rounded-full text-xs font-medium border bg-gray-50 text-gray-500 border-gray-200">
              統合候補 {actionSummary.mergeCount}件
            </span>
          )}
        </div>
      )}

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

      {/* 名前(五十音・行)フィルタ */}
      <div className="bg-white border-b border-gray-100 px-3 py-2 flex items-center gap-1.5 overflow-x-auto shrink-0">
        <span className="shrink-0 text-[11px] text-gray-400 mr-1">名前</span>
        <button
          onClick={() => setNameRow("all")}
          className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
            nameRow === "all" ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"
          }`}
        >
          すべて
        </button>
        {KANA_ROWS.map((r) => (
          <button
            key={r.label}
            onClick={() => setNameRow(r.label)}
            className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              nameRow === r.label ? "bg-emerald-500 text-white" : "bg-gray-100 text-gray-500"
            }`}
          >
            {r.label}行
          </button>
        ))}
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
              const candidateGroups = group.clientId ? (mergeCandidates.get(group.clientId) ?? []) : [];
              const showCandidateBanner = candidateGroups.length > 0 && !candidateBannerHiddenFor.has(group.clientId ?? "__none__");
              const selectedInGroup = group.orders.filter((o) => selectedMergeIds.has(o.id));
              return (
              <div key={group.clientId ?? "__none__"}>
                {/* 利用者ヘッダー */}
                <div className="bg-emerald-50 border-b border-emerald-100 px-4 py-2 flex items-center gap-2">
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
                  {selectedInGroup.length >= 2 && (
                    <button
                      onClick={() => openMergeModalFromSelection(group.clientId)}
                      className="text-xs px-2.5 py-0.5 rounded-full border border-blue-300 bg-blue-500 text-white font-medium hover:bg-blue-600"
                    >
                      選択中 {selectedInGroup.length} 件を統合
                    </button>
                  )}
                  <span className="ml-auto text-xs text-emerald-400">{group.orders.length}発注</span>
                </div>
                {/* 統合候補 banner */}
                {showCandidateBanner && (
                  <div className="bg-blue-50 border-b border-blue-100 px-4 py-2 flex flex-col gap-1.5">
                    {candidateGroups.map((cg, i) => {
                      const date = (cg[0].ordered_at ?? "").slice(0, 10);
                      return (
                        <div key={`${group.clientId}-cand-${i}`} className="flex items-center gap-2 text-xs">
                          <span className="text-blue-700">
                            {new Date(date).toLocaleDateString("ja-JP")} に {cg.length} 件の発注 → 統合候補
                          </span>
                          <button
                            onClick={() => openMergeModalForCandidates(cg)}
                            className="px-2 py-0.5 rounded-full border border-blue-300 bg-white text-blue-700 hover:bg-blue-100 font-medium"
                          >
                            確認
                          </button>
                        </div>
                      );
                    })}
                    <button
                      onClick={() => setCandidateBannerHiddenFor((prev) => new Set(prev).add(group.clientId ?? "__none__"))}
                      className="self-start text-[11px] text-blue-500 hover:underline"
                    >
                      この通知を閉じる
                    </button>
                  </div>
                )}
                {/* その利用者の発注一覧 (名前より一段インデント) */}
                <ul className="flex flex-col gap-4 pl-12 pr-3 pb-3 pt-0">
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
                          {/* 統合用 checkbox (利用者あり、未統合の order のみ) */}
                          {group.clientId && (order.merged_from_order_ids?.length ?? 0) === 0 && (
                            <input
                              type="checkbox"
                              checked={selectedMergeIds.has(order.id)}
                              onChange={() => toggleSelectMerge(order.id)}
                              onClick={(e) => e.stopPropagation()}
                              title="統合用に選択"
                              className="accent-blue-500 w-3.5 h-3.5 shrink-0"
                            />
                          )}
                          {/* 折りたたみボタン（固定幅） */}
                          <button
                            onClick={toggleExpand}
                            className="w-44 shrink-0 text-left flex items-center gap-2 min-w-0"
                          >
                            <span className="text-xs text-gray-500 whitespace-nowrap">
                              {new Date(order.ordered_at).toLocaleDateString("ja-JP")}発注
                            </span>
                            <span className="text-xs text-gray-400 whitespace-nowrap">{activeItems.length}点</span>
                            {/* 放置発注の経過日数警告 (発注済 item が残っている order のみ) */}
                            {order.items.some((i) => i.status === "ordered") && (() => {
                              const elapsedDays = Math.floor((Date.now() - new Date(order.ordered_at).getTime()) / 86400000);
                              return (
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap shrink-0 ${
                                    elapsedDays >= 14
                                      ? "text-red-600 bg-red-50"
                                      : elapsedDays >= 7
                                        ? "text-amber-600 bg-amber-50"
                                        : "text-gray-400"
                                  }`}
                                >
                                  発注から{elapsedDays}日
                                </span>
                              );
                            })()}
                            {/* 卸未設定バッジ */}
                            {activeItems.length > 0 && !order.supplier_id && activeItems.every((i) => !i.supplier_id) && (
                              <span
                                title="卸を選ぶと仕入原価が記録され月次損益に反映されます"
                                className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 whitespace-nowrap shrink-0"
                              >
                                卸未設定
                              </span>
                            )}
                            {(order.merged_from_order_ids?.length ?? 0) > 0 && (
                              <span
                                title={`${order.merged_from_order_ids.length} 件の発注が統合されています`}
                                className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded shrink-0"
                              >
                                統合済 +{order.merged_from_order_ids.length}
                              </span>
                            )}
                            {isOpen ? (
                              <ChevronDown size={16} className="text-gray-400 shrink-0" />
                            ) : (
                              <ChevronRight size={16} className="text-gray-400 shrink-0" />
                            )}
                          </button>
                          {/* 統合解除 button */}
                          {(order.merged_from_order_ids?.length ?? 0) > 0 && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleUnmerge(order.id); }}
                              disabled={mergeExecuting}
                              title="統合を解除して元の発注単位に戻す"
                              className="text-xs px-2 py-0.5 rounded-full border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-50 shrink-0"
                            >
                              統合解除
                            </button>
                          )}
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
                                      {/* 種目バッジ + 用具名 */}
                                      <td className="py-2 text-sm font-medium text-gray-800 max-w-0">
                                        <div className="flex items-center gap-2 min-w-0">
                                          {equipCategory(item.product_code) && (
                                            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium whitespace-nowrap shrink-0 ${catColorOrders(equipCategory(item.product_code))}`}>
                                              {equipCategory(item.product_code)}
                                            </span>
                                          )}
                                          <span className="truncate">{equipName(item.product_code)}</span>
                                        </div>
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
          currentOfficeId={currentOfficeId}
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

      {/* 発注統合モーダル */}
      {mergeModal && (() => {
        const targetOrder = mergeModal.orders.find((o) => o.id === mergeModal.targetId);
        const sourceOrders = mergeModal.orders.filter((o) => o.id !== mergeModal.targetId);
        const totalItems = mergeModal.orders.reduce((s, o) => s + o.items.length, 0);
        const cli = targetOrder ? clientByIdOrders.get(targetOrder.client_id ?? "") : null;
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col">
              <div className="px-5 pt-4 pb-2 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-base font-bold text-gray-800">発注を統合</h2>
                <button onClick={() => setMergeModal(null)} className="text-gray-400 hover:text-gray-600">
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
                <p className="text-sm text-gray-600">
                  {cli ? `${cli.name} の` : ""}{mergeModal.orders.length} 件の発注を 1 件にまとめます (合計 {totalItems} 点)。
                </p>
                <div className="text-xs text-gray-500 leading-relaxed">
                  ・統合先以外の発注は <span className="font-semibold">削除</span> され、明細だけが統合先に移動します<br />
                  ・各明細の発注時刻は元のまま保持されます<br />
                  ・統合解除すれば元の発注単位に戻せます
                </div>
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-gray-500">統合先 (この発注に他の明細を吸収):</p>
                  {mergeModal.orders.map((o) => (
                    <label key={o.id} className="flex items-start gap-2 p-2.5 border border-gray-200 rounded-xl hover:bg-gray-50 cursor-pointer">
                      <input
                        type="radio"
                        name="merge-target"
                        checked={mergeModal.targetId === o.id}
                        onChange={() => setMergeModal({ ...mergeModal, targetId: o.id })}
                        className="mt-0.5 accent-blue-500"
                      />
                      <div className="flex-1 text-xs">
                        <div className="font-medium text-gray-800">
                          {new Date(o.ordered_at).toLocaleString("ja-JP")}
                          <span className="ml-2 text-gray-400">({o.items.length}点)</span>
                        </div>
                        {o.notes && <div className="text-gray-500 mt-0.5 truncate">{o.notes}</div>}
                      </div>
                    </label>
                  ))}
                </div>
                {sourceOrders.some((o) => (o.email_sent_count ?? 0) > 0) && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                    送信済みのメールがある発注が含まれます。統合後もメール書類は再生成可能ですが、統合先発注として表示されます。
                  </div>
                )}
              </div>
              <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
                <button
                  onClick={() => setMergeModal(null)}
                  disabled={mergeExecuting}
                  className="px-4 py-1.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleExecuteMerge}
                  disabled={mergeExecuting}
                  className="px-4 py-1.5 text-sm bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1.5"
                >
                  {mergeExecuting && <Loader2 size={14} className="animate-spin" />}
                  統合する
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

function ClientsTab({ tenantId, currentOfficeId, officeViewAll, onOfficeViewAllChange, initialClientId, onClearInitialClient }: { tenantId: string; currentOfficeId: string | null; officeViewAll: boolean; onOfficeViewAllChange?: (value: boolean) => void; initialClientId?: string | null; onClearInitialClient?: () => void }) {
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
    // 実行時に使う元データ。memo は CSV インポート経路では扱わない（client_memos へ移行済）
    data: Omit<Client, "id" | "created_at" | "memo">;
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
  const [hospDateInput, setHospDateInput] = useState(() => todayYmd());
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
        // Phase 8: office filter (officeViewAll=false 時)
        const officeFilter = officeViewAll ? null : currentOfficeId;
        const [c, items, eq, ords, sup, mem, hospRes, tenant, assignments] = await Promise.all([
          getClients(tenantId, { onlyDeleted: trashFilter, officeId: officeFilter }),
          getAllOrderItemsByTenant(tenantId),
          getEquipment(tenantId),
          getOrders(tenantId, officeFilter),
          getSuppliers(),
          getMembers(tenantId),
          // ⚠ 入院データは **単位数計算 (半月ルール・入院控除) に流れる**ので
          //   1000 行で切れると請求額が狂う。同ファイル内の請求タブ側は
          //   fetchAllPaged を使っており、ここだけ素の select だった (2026-08-31 是正)。
          (async () => {
            const PAGE = 1000;
            const all: ClientHospitalization[] = [];
            for (let from = 0; ; from += PAGE) {
              const { data, error } = await supabase
                .from("client_hospitalizations")
                .select("*")
                .eq("tenant_id", tenantId)
                .order("admission_date", { ascending: false })
                .order("id")
                .range(from, from + PAGE - 1);
              if (error) throw error;
              all.push(...((data ?? []) as ClientHospitalization[]));
              if (!data || data.length < PAGE) break;
            }
            return all;
          })(),
          getTenantById(tenantId),
          getClientOfficeAssignments(tenantId),
        ]);
        setClients(c);
        setOrderItems(items);
        setEquipment(eq);
        setOrders(ords);
        setSuppliers(sup);
        setMembers(mem);
        setHospitalizations(hospRes);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, [tenantId, trashFilter, currentOfficeId, officeViewAll]);

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
    const lastDay = monthEndYmd(year, month);
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
        currentOfficeId={currentOfficeId}
        initialViewMode={selectedClientInitialViewMode}
        hospitalizations={hospitalizations}
        onBack={() => { setSelectedClient(null); setSelectedClientInitialViewMode(undefined); }}
      />
    );
  }

  // Count active rentals per client
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
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
    a.download = `利用者一覧_${todayYmd()}.csv`;
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
      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
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
      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
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
      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
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
            .order("id").range(from, from + PAGE - 1);
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
      // memo は clients から DROP 済（client_memos へ移行）。CSV インポート経路では扱わない
      type ClientData = Omit<Client, "id" | "created_at" | "memo">;
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
          office_id: currentOfficeId ?? null,
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

      const findProvisionalCandidates = (newData: Omit<Client, "id" | "created_at" | "memo">): ProvisionalCandidate[] => {
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

      const newClients = await getClients(tenantId, { officeId: officeViewAll ? null : currentOfficeId });
      setClients(newClients);

      // 保険情報の書き込み
      // 行 (利用者) ごとに独立しているので上限付き並列 (concurrency=6) で処理する。
      // 直列時と同じく「1件失敗しても他は続行・エラーは個別に無視 (insuranceAdded に
      // カウントしないだけ)」という挙動を維持する。行の中の insert/update 順序
      // (existingByDate の自己参照) は 1 行内では直列のまま変えていない。
      // ⚠ 直列版は「予期しない例外が出たらそこで残り全行を打ち切る」try/catch だったが、
      //   並列実行では他の行の処理が既に進行中のため同じ意味を持たせられない。
      //   1 行単位で try/catch し、失敗した行だけスキップする (他の行への影響ゼロ・
      //   バックグラウンドに投げっぱなしの処理を残さない、という点でむしろ安全な設計)。
      let insuranceAdded = 0;
      try {
        const clientIdByUserNumber = new Map<string, string>();
        for (const c of newClients) {
          if (c.user_number) clientIdByUserNumber.set(c.user_number, c.id);
        }
        const rowsWithInsurance = preview.rows.filter(
          (r) => r.insurance.length > 0 && clientIdByUserNumber.has(r.user_number),
        );
        await mapWithConcurrency(
          rowsWithInsurance,
          async (r) => {
            try {
            const clientId = clientIdByUserNumber.get(r.user_number)!;
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
            } catch {
              // 1 行の失敗は他行に影響させない (直列版の「致命的ではない」と同じ扱い)
            }
          },
          6,
        );
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
    setHospDateInput(todayYmd());
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
    "歩行補助つえ": "17 1010",
    "徘徊感知機器": "17 1011",
    "認知症老人徘徊感知機器": "17 1011",
    "移動用リフト": "17 1012",
    "自動排泄処理装置": "17 1013",
    "自動排せつ処理装置": "17 1013",
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
        {/* 自事業所/全利用者 toggle (currentOfficeId が選択されてる場合のみ) */}
        {currentOfficeId && onOfficeViewAllChange && (
          <div className="flex rounded-xl border border-gray-200 overflow-hidden text-xs font-medium shrink-0">
            <button
              onClick={() => onOfficeViewAllChange(false)}
              className={`px-2.5 py-1.5 transition-colors ${!officeViewAll ? "bg-emerald-500 text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
            >
              自事業所
            </button>
            <button
              onClick={() => onOfficeViewAllChange(true)}
              className={`px-2.5 py-1.5 transition-colors ${officeViewAll ? "bg-emerald-500 text-white" : "bg-white text-gray-500 hover:bg-gray-50"}`}
            >
              全利用者
            </button>
          </div>
        )}
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
          currentOfficeId={currentOfficeId}
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
        const monthEnd = monthEndYmd(jYear, jMonth);
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
                            // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  allOrderItems,
  equipment,
  tenantId,
  currentOfficeId,
  initialViewMode,
  hospitalizations,
  onBack,
}: {
  client: Client;
  allOrderItems: OrderItem[];
  equipment: Equipment[];
  tenantId: string;
  currentOfficeId: string | null;
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
  const [careOfficesList, setCareOfficesList] = useState<Array<{ id: string; name: string; self_office_id?: string | null }>>([]);
  const [careManagersList, setCareManagersList] = useState<Array<{ id: string; care_office_id: string; name: string }>>([]);
  useEffect(() => {
    (async () => {
      // self_office_id (自社紐づけ) 込みで取得。列未適用 DB では旧 select に fallback
      type OffRow = { id: string; name: string; self_office_id?: string | null };
      let offData: OffRow[] = [];
      const withSelf = await supabase.from("care_offices").select("id, name, self_office_id").eq("tenant_id", tenantId).order("name");
      if (!withSelf.error) {
        offData = (withSelf.data ?? []) as OffRow[];
      } else if (["42703", "PGRST204", "PGRST205"].includes(withSelf.error.code ?? "")) {
        const plain = await supabase.from("care_offices").select("id, name").eq("tenant_id", tenantId).order("name");
        if (plain.error) console.error("care_offices fetch failed:", plain.error.message);
        else offData = (plain.data ?? []) as OffRow[];
      } else {
        console.error("care_offices fetch failed:", withSelf.error.message);
      }
      const mgrRes = await supabase.from("care_managers").select("id, care_office_id, name").eq("tenant_id", tenantId).eq("active", true).order("name");
      setCareOfficesList(offData);
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
  // 不完全 (保険者番号 + 被保険者番号 + 認定年月日 がいずれも未設定) の行は default 非表示
  const [showIncompleteInsurance, setShowIncompleteInsurance] = useState(false);

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
  // 利用期間 (client_office_assignments) — Stage A
  const [clientAssignments, setClientAssignments] = useState<ClientOfficeAssignment[]>([]);
  const [assignmentOffices, setAssignmentOffices] = useState<Office[]>([]);
  const [assignmentEditingId, setAssignmentEditingId] = useState<string | null>(null);
  const [assignmentEditForm, setAssignmentEditForm] = useState<{ start_date: string; end_date: string }>({ start_date: "", end_date: "" });
  const [assignmentAdding, setAssignmentAdding] = useState<{ office_id: string; start_date: string; end_date: string } | null>(null);
  const [showAssignmentHistory, setShowAssignmentHistory] = useState(false);
  const [startDatePicker, setStartDatePicker] = useState<{ officeId: string; officeName: string; date: string } | null>(null);
  const [endDatePicker, setEndDatePicker] = useState<{ officeId: string; officeName: string; date: string } | null>(null);

  // 月次実績送信 (居宅事業所宛)
  const [showRecordModal, setShowRecordModal] = useState(false);
  const [recordYearMonth, setRecordYearMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const [recordToast, setRecordToast] = useState<{ kind: "success" | "error"; msg: string } | null>(null);

  const reloadAssignments = useCallback(async () => {
    try {
      const rows = await getClientAssignmentsForClient(client.id);
      setClientAssignments(rows);
    } catch (e) { console.error("利用期間の取得に失敗", e); }
  }, [client.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [rows, offs] = await Promise.all([
          getClientAssignmentsForClient(client.id),
          getOffices(tenantId),
        ]);
        if (!cancelled) {
          setClientAssignments(rows);
          setAssignmentOffices(offs);
        }
      } catch (e) { console.error("利用期間/事業所の初期取得に失敗", e); }
    })();
    return () => { cancelled = true; };
  }, [client.id, tenantId]);

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

  // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
  useEffect(() => { loadItems(); }, [loadItems]);

  const today = todayYmd();

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
        // Stage A: rental_started 時に利用期間を自動 INSERT (open 行が無ければ)
        // 開始日は item.rental_start_date を使用 (manual 入力の date)
        if (newStatus === "rental_started") {
          const officeId = (orderData as Order | null)?.office_id ?? currentOfficeId;
          if (officeId) {
            try {
              const startDate = date ?? item.rental_start_date ?? todayYmd();
              await ensureActiveAssignment(client.id, officeId, tenantId, startDate);
              await reloadAssignments();
            } catch (e) { console.error("利用期間の自動作成に失敗", e); }
          }
        }
        // Stage A: terminated/cancelled 時に「全 item が非 active」になったか check、
        // なれば利用期間を auto-close (end_date = item の終了日 or 今日)
        if (newStatus === "terminated" || newStatus === "cancelled") {
          const officeId = (orderData as Order | null)?.office_id ?? currentOfficeId;
          if (officeId) {
            try {
              // client × office 配下で rental_started item が他に残ってないか確認
              const { data: remaining } = await supabase
                .from("order_items")
                .select("id, order_id, orders!inner(client_id, office_id)")
                .eq("status", "rental_started")
                .eq("orders.client_id", client.id)
                .eq("orders.office_id", officeId)
                .neq("id", item.id);
              if ((remaining ?? []).length === 0) {
                const endDate = date ?? item.rental_end_date ?? todayYmd();
                await closeActiveAssignment(client.id, officeId, endDate);
                await reloadAssignments();
              }
            } catch (e) { console.error("利用期間の自動クローズに失敗", e); }
          }
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
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
        const { error } = await supabase.from("client_insurance_records").update(insuranceForm).eq("id", editingInsuranceId);
        if (error) {
          console.warn("client_insurance_records update failed:", error.message);
          alert(`保険情報の更新に失敗しました: ${error.message}`);
          return;
        }
      } else {
        const { error } = await supabase.from("client_insurance_records").insert({ ...insuranceForm, tenant_id: tenantId, client_id: client.id });
        if (error) {
          console.warn("client_insurance_records insert failed:", error.message);
          alert(`保険情報の登録に失敗しました: ${error.message}`);
          return;
        }
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
    const { error } = await supabase.from("client_insurance_records").delete().eq("id", id);
    if (error) { alert(`保険情報の削除に失敗しました: ${error.message}`); return; }
    await loadItems();
  };

  const handleSaveRentalHistory = async () => {
    if (!rentalHistoryForm || !rentalHistoryForm.equipment_name.trim()) return;
    setRentalHistorySaving(true);
    try {
      if (editingRentalHistoryId) {
        const { error } = await supabase.from("client_rental_history").update(rentalHistoryForm).eq("id", editingRentalHistoryId);
        if (error) {
          console.warn("client_rental_history update failed:", error.message);
          alert(`レンタル履歴の更新に失敗しました: ${error.message}`);
          return;
        }
      } else {
        const { error } = await supabase.from("client_rental_history").insert({ ...rentalHistoryForm, tenant_id: tenantId, client_id: client.id, source: "manual" });
        if (error) {
          console.warn("client_rental_history insert failed:", error.message);
          alert(`レンタル履歴の登録に失敗しました: ${error.message}`);
          return;
        }
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
    const { error } = await supabase.from("client_rental_history").delete().eq("id", id);
    if (error) { alert(`レンタル履歴の削除に失敗しました: ${error.message}`); return; }
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
                    const { error } = await supabase.from("clients").update(payload).eq("id", client.id);
                    setBasicSaving(false);
                    if (error) { alert(`基本情報の保存に失敗しました: ${error.message}`); return; }
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
                  {careOfficesList.some((o) => o.self_office_id) && (
                    <optgroup label="自社グループ">
                      {careOfficesList.filter((o) => o.self_office_id).map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="他社">
                    {careOfficesList.filter((o) => !o.self_office_id).map((o) => (
                      <option key={o.id} value={o.id}>{o.name}</option>
                    ))}
                  </optgroup>
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

          {/* 利用期間 (client_office_assignments) — kaigo-app 風 */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-gray-500">事業所別 利用状況</h3>
              <button
                onClick={() => setShowAssignmentHistory((v) => !v)}
                className="text-[11px] text-gray-500 hover:text-gray-700 underline">
                {showAssignmentHistory ? "履歴を閉じる" : "履歴を開く"}
              </button>
            </div>

            {/* 月次実績送信 (居宅事業所宛) */}
            <div className="bg-white rounded-xl shadow-sm px-3 py-2.5 mb-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-gray-500 shrink-0">月次実績</span>
              <input
                type="month"
                value={recordYearMonth}
                onChange={(e) => setRecordYearMonth(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-xs"
              />
              <button
                onClick={() => setShowRecordModal(true)}
                disabled={!currentOfficeId}
                title={!currentOfficeId ? "送信元事業所が選択されていません" : "居宅事業所に当月の福祉用具実績を送信"}
                className="ml-auto text-[11px] px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-lg flex items-center gap-1.5">
                <Send size={12} />
                居宅事業所に実績送信
              </button>
            </div>

            {/* 全 office (福祉用具) 一覧 + toggle */}
            <div className="bg-white rounded-xl shadow-sm divide-y divide-gray-100 mb-3">
              {assignmentOffices.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">事業所が登録されていません</p>
              ) : assignmentOffices.map((o) => {
                const activeAssignment = clientAssignments.find((a) => a.office_id === o.id && a.end_date === null);
                const isActive = !!activeAssignment;
                return (
                  <div key={o.id} className="flex items-center justify-between px-3 py-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-medium text-sm truncate ${o.id === currentOfficeId ? "text-gray-800" : "text-gray-500"}`}>{o.name}</span>
                      {o.id === currentOfficeId && <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded shrink-0">自事業所</span>}
                      {isActive && <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded shrink-0">利用中</span>}
                      {isActive && activeAssignment.start_date && (
                        <span className="text-[10px] text-gray-400 shrink-0">{activeAssignment.start_date}〜</span>
                      )}
                    </div>
                    {o.id === currentOfficeId ? (
                      <button
                        onClick={() => {
                          const today = todayYmd();
                          if (isActive) {
                            setEndDatePicker({ officeId: o.id, officeName: o.name, date: today });
                          } else {
                            setStartDatePicker({ officeId: o.id, officeName: o.name, date: today });
                          }
                        }}
                        className={`text-[11px] px-2.5 py-1 rounded-lg shrink-0 ${isActive ? "bg-red-500 hover:bg-red-600 text-white" : "bg-emerald-500 hover:bg-emerald-600 text-white"}`}>
                        {isActive ? "利用終了" : "利用開始"}
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-400 shrink-0">他事業所のため操作不可</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* 履歴 (折り畳み) */}
            {showAssignmentHistory && (
            <div className="space-y-2">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-xs font-semibold text-gray-500">履歴 (期間 詳細編集)</h4>
              <div className="flex gap-1.5">
                <button
                  onClick={() => {
                    const today = todayYmd();
                    const defaultOffice = currentOfficeId ?? assignmentOffices[0]?.id ?? "";
                    setAssignmentAdding({ office_id: defaultOffice, start_date: today, end_date: "" });
                  }}
                  className="text-[11px] px-2 py-1 bg-blue-500 text-white rounded-lg hover:bg-blue-600">
                  期間追加
                </button>
              </div>
            </div>
            {assignmentAdding && (
              <div className="bg-blue-50 rounded-xl p-3 mb-2 space-y-2">
                <div className="flex flex-wrap gap-2 items-center text-xs">
                  <label className="flex items-center gap-1">
                    <span className="text-gray-600">事業所</span>
                    <select
                      value={assignmentAdding.office_id}
                      onChange={(e) => setAssignmentAdding({ ...assignmentAdding, office_id: e.target.value })}
                      className="border border-gray-300 rounded px-2 py-1 text-xs">
                      {assignmentOffices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-gray-600">開始</span>
                    <input
                      type="date"
                      value={assignmentAdding.start_date}
                      onChange={(e) => setAssignmentAdding({ ...assignmentAdding, start_date: e.target.value })}
                      className="border border-gray-300 rounded px-2 py-1 text-xs" />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-gray-600">終了</span>
                    <input
                      type="date"
                      value={assignmentAdding.end_date}
                      onChange={(e) => setAssignmentAdding({ ...assignmentAdding, end_date: e.target.value })}
                      className="border border-gray-300 rounded px-2 py-1 text-xs" />
                  </label>
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setAssignmentAdding(null)}
                    className="text-[11px] px-2 py-1 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">キャンセル</button>
                  <button
                    onClick={async () => {
                      if (!assignmentAdding.office_id || !assignmentAdding.start_date) {
                        alert("事業所と開始日を入力してください"); return;
                      }
                      try {
                        await addAssignment(
                          tenantId, client.id, assignmentAdding.office_id,
                          assignmentAdding.start_date,
                          assignmentAdding.end_date || null,
                        );
                        setAssignmentAdding(null);
                        await reloadAssignments();
                      } catch (e) { alert("追加に失敗: " + (e instanceof Error ? e.message : String(e))); }
                    }}
                    className="text-[11px] px-2 py-1 bg-blue-500 text-white rounded-lg hover:bg-blue-600">保存</button>
                </div>
              </div>
            )}
            {clientAssignments.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">利用期間の記録はありません</p>
            ) : (
              <table className="w-full table-fixed bg-white rounded-xl overflow-hidden shadow-sm text-left text-xs">
                <tbody className="divide-y divide-gray-100">
                  {clientAssignments.map((a) => {
                    const officeName = assignmentOffices.find((o) => o.id === a.office_id)?.name ?? "(未設定の事業所)";
                    const isActive = a.end_date === null;
                    const isEditing = assignmentEditingId === a.id;
                    return (
                      <tr key={a.id} className="px-2">
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-800">{officeName}</span>
                            {isActive && <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">利用中</span>}
                          </div>
                          {isEditing ? (
                            <div className="flex flex-wrap gap-2 items-center mt-1.5">
                              <input
                                type="date"
                                value={assignmentEditForm.start_date}
                                onChange={(e) => setAssignmentEditForm({ ...assignmentEditForm, start_date: e.target.value })}
                                className="border border-gray-300 rounded px-2 py-1 text-xs" />
                              <span className="text-gray-400">〜</span>
                              <input
                                type="date"
                                value={assignmentEditForm.end_date}
                                onChange={(e) => setAssignmentEditForm({ ...assignmentEditForm, end_date: e.target.value })}
                                className="border border-gray-300 rounded px-2 py-1 text-xs" />
                              <button
                                onClick={async () => {
                                  try {
                                    await updateAssignment(a.id, {
                                      start_date: assignmentEditForm.start_date || null,
                                      end_date: assignmentEditForm.end_date || null,
                                    });
                                    setAssignmentEditingId(null);
                                    await reloadAssignments();
                                  } catch (e) { alert("更新に失敗: " + (e instanceof Error ? e.message : String(e))); }
                                }}
                                className="text-[11px] px-2 py-0.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600">保存</button>
                              <button
                                onClick={() => setAssignmentEditingId(null)}
                                className="text-[11px] px-2 py-0.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300">×</button>
                            </div>
                          ) : (
                            <div className="text-gray-600 mt-0.5">
                              {a.start_date ?? "(開始未設定)"} 〜 {a.end_date ?? "(継続中)"}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top w-32 text-right">
                          {!isEditing && (
                            <div className="flex flex-col items-end gap-1">
                              <button
                                onClick={() => {
                                  setAssignmentEditingId(a.id);
                                  setAssignmentEditForm({ start_date: a.start_date ?? "", end_date: a.end_date ?? "" });
                                }}
                                className="text-[11px] text-blue-600 hover:underline">編集</button>
                              {isActive && (
                                <button
                                  onClick={async () => {
                                    if (!confirm(`${officeName} の利用を終了しますか？(終了日 = 今日)`)) return;
                                    try {
                                      await closeActiveAssignment(client.id, a.office_id);
                                      await reloadAssignments();
                                    } catch (e) { alert("利用終了に失敗: " + (e instanceof Error ? e.message : String(e))); }
                                  }}
                                  className="text-[11px] text-red-600 hover:underline">利用終了</button>
                              )}
                              <button
                                onClick={async () => {
                                  if (!confirm("この利用期間を削除しますか？(履歴から消えます)")) return;
                                  try {
                                    await deleteAssignment(a.id);
                                    await reloadAssignments();
                                  } catch (e) { alert("削除に失敗: " + (e instanceof Error ? e.message : String(e))); }
                                }}
                                className="text-[11px] text-gray-400 hover:underline">削除</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            </div>
            )}
          </section>

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
                      else if (doc.type === "contract" || doc.type === "rental_contract" || doc.type === "important_matters") setShowDocuments(true);
                      else if (doc.type === "supplier_email") {
                        const orderId = doc.params?.orderId as string | undefined;
                        if (!orderId) {
                          alert("この発注メール書類には発注ID(orderId)が記録されていないため、再生成できません。\n古い書類の可能性があります。");
                          return;
                        }
                        // まず orderId で直接検索 (未統合 or 統合先)
                        const [orderRes, suppliers, members] = await Promise.all([
                          supabase.from("orders").select("*").eq("id", orderId).maybeSingle(),
                          getSuppliers(),
                          getMembers(tenantId),
                        ]);
                        if (orderRes.error) {
                          console.error("発注取得エラー:", orderRes.error);
                          alert(`発注の取得に失敗しました: ${orderRes.error.message}`);
                          return;
                        }
                        let foundOrder: Order | null = (orderRes.data as Order) ?? null;
                        // 見つからなければ merged_from_order_ids で統合先 order を検索
                        if (!foundOrder) {
                          const { data: mergedRows } = await supabase
                            .from("orders")
                            .select("*")
                            .contains("merged_from_order_ids", [{ id: orderId }]);
                          if (mergedRows && mergedRows.length > 0) {
                            foundOrder = mergedRows[0] as Order;
                          }
                        }
                        if (!foundOrder) {
                          alert("元の発注が見つかりません（削除された可能性があります）。");
                          return;
                        }
                        const items = await getOrderItems(foundOrder.id);
                        setEmailPreview({ order: foundOrder, items, suppliers, members, sentAt: doc.created_at });
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
            {(() => {
              const incompleteCount = insuranceRecords.filter(
                (r) => !r.insurer_number && !r.insured_number && !r.certification_date,
              ).length;
              const visibleRecords = showIncompleteInsurance
                ? insuranceRecords
                : insuranceRecords.filter(
                    (r) => r.insurer_number || r.insured_number || r.certification_date,
                  );
              return (
            <div className="shrink-0 mx-4 mt-3 mb-3 border border-gray-200 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-200">
                <span className="text-xs font-semibold text-gray-700">
                  介護認定 履歴一覧
                  {incompleteCount > 0 && (
                    <span className="ml-2 text-[10px] text-gray-500">
                      ({showIncompleteInsurance ? "全件" : `${visibleRecords.length} 件 + 未入力 ${incompleteCount} 件`})
                    </span>
                  )}
                </span>
                {incompleteCount > 0 && (
                  <label className="flex items-center gap-1 text-[11px] text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showIncompleteInsurance}
                      onChange={(e) => setShowIncompleteInsurance(e.target.checked)}
                      className="accent-blue-500"
                    />
                    未入力行も表示
                  </label>
                )}
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
                  {visibleRecords.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-gray-400">保険情報がありません</td></tr>
                  ) : visibleRecords.map((rec, idx) => {
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
              );
            })()}

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
                    <label className="text-[11px] text-gray-500">居宅介護支援事業所</label>
                    {insuranceForm
                      ? <select
                          value={F?.care_office_id ?? ""}
                          onChange={e => setInsuranceForm(f => f ? { ...f, care_office_id: e.target.value || null } : f)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-blue-400 bg-white">
                          <option value="">未選択</option>
                          {careOfficesList.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                      : <div className="text-sm text-gray-800 border border-transparent px-2.5 py-1.5">{selRec?.care_office_id ? (careOfficesList.find(o => o.id === selRec.care_office_id)?.name ?? selRec?.care_manager_org ?? "—") : (selRec?.care_manager_org || "—")}</div>}
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
            const { error } = await supabase.from("client_public_expenses").update(pf).eq("id", editingPeId);
            setPeSaving(false);
            if (error) { alert(`公費情報の保存に失敗しました: ${error.message}`); return; }
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
            const { error } = await supabase.from("client_public_expenses").delete().eq("id", id);
            if (error) { alert(`公費情報の削除に失敗しました: ${error.message}`); return; }
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

      {/* 月次実績送信モーダル */}
      {showRecordModal && currentOfficeId && (
        <SendMonthlyRecordModal
          tenantId={tenantId}
          client={client}
          sourceOfficeId={currentOfficeId}
          yearMonth={recordYearMonth}
          clientItems={clientItems}
          equipment={equipment}
          priceHistory={priceHistory}
          onClose={() => setShowRecordModal(false)}
          onSuccess={() => {
            setShowRecordModal(false);
            setRecordToast({ kind: "success", msg: "月次実績を送信しました" });
            setTimeout(() => setRecordToast(null), 3500);
          }}
          onError={(msg) => {
            setRecordToast({ kind: "error", msg: `送信失敗: ${msg}` });
            setTimeout(() => setRecordToast(null), 5000);
          }}
        />
      )}

      {/* 月次実績送信トースト */}
      {recordToast && (
        <div className={`fixed top-4 right-4 z-[80] px-4 py-2 rounded-lg shadow-lg text-sm text-white ${recordToast.kind === "success" ? "bg-emerald-500" : "bg-red-500"}`}>
          {recordToast.msg}
        </div>
      )}

      {/* 利用開始日 picker modal */}
      {startDatePicker && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" onClick={() => setStartDatePicker(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">利用開始</h3>
            <p className="text-xs text-gray-500 mb-3">{startDatePicker.officeName} の利用を開始します。</p>
            <label className="text-xs text-gray-600 block mb-1">開始日</label>
            <input
              type="date"
              value={startDatePicker.date}
              onChange={(e) => setStartDatePicker({ ...startDatePicker, date: e.target.value })}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setStartDatePicker(null)} className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50">キャンセル</button>
              <button
                onClick={async () => {
                  try {
                    const inserted = await ensureActiveAssignment(client.id, startDatePicker.officeId, tenantId, startDatePicker.date);
                    if (inserted === null) alert("既に現在利用中の期間があります。");
                    setStartDatePicker(null);
                    await reloadAssignments();
                  } catch (e) { alert("利用開始に失敗: " + (e instanceof Error ? e.message : String(e))); }
                }}
                className="text-sm px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white">開始</button>
            </div>
          </div>
        </div>
      )}

      {/* 利用終了日 picker modal */}
      {endDatePicker && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" onClick={() => setEndDatePicker(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-800 mb-1">利用終了</h3>
            <p className="text-xs text-gray-500 mb-3">{endDatePicker.officeName} の利用を終了します。</p>
            <label className="text-xs text-gray-600 block mb-1">終了日</label>
            <input
              type="date"
              value={endDatePicker.date}
              onChange={(e) => setEndDatePicker({ ...endDatePicker, date: e.target.value })}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-4"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setEndDatePicker(null)} className="text-sm px-3 py-1.5 rounded border border-gray-300 hover:bg-gray-50">キャンセル</button>
              <button
                onClick={async () => {
                  try {
                    await closeActiveAssignment(client.id, endDatePicker.officeId, endDatePicker.date);
                    setEndDatePicker(null);
                    await reloadAssignments();
                  } catch (e) { alert("利用終了に失敗: " + (e instanceof Error ? e.message : String(e))); }
                }}
                className="text-sm px-3 py-1.5 rounded bg-red-500 hover:bg-red-600 text-white">終了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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

// ─── SendMonthlyRecordModal ──────────────────────────────────────────────────
// 福祉用具の月次実績を居宅介護支援事業所に送付する確認モーダル

type MonthlyRecordRow = {
  date_range_start: string;
  date_range_end: string;
  equipment_name: string;
  tais_code: string | null;
  monthly_rental_fee: number;
  category: string | null;
};

function buildRecordsForMonth(
  yearMonth: string,
  clientItems: OrderItem[],
  equipment: Equipment[],
  priceHistory: EquipmentPriceHistory[],
): MonthlyRecordRow[] {
  const [y, m] = yearMonth.split("-").map(Number);
  const monthStart = `${yearMonth}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
  return clientItems
    .filter((i) => {
      if (i.status === "cancelled") return false;
      const start = i.rental_start_date;
      const end = i.rental_end_date;
      if (!start) return false;
      if (start > monthEnd) return false;
      if (end && end < monthStart) return false;
      return true;
    })
    .map((i) => {
      const eq = equipment.find((e) => e.product_code === i.product_code);
      const price = getPriceForMonth(priceHistory, i.product_code, yearMonth) ?? i.rental_price ?? 0;
      const rangeStart = i.rental_start_date && i.rental_start_date > monthStart ? i.rental_start_date : monthStart;
      const rangeEnd = i.rental_end_date && i.rental_end_date < monthEnd ? i.rental_end_date : monthEnd;
      return {
        date_range_start: rangeStart,
        date_range_end: rangeEnd,
        equipment_name: eq?.name ?? i.product_code,
        tais_code: eq?.tais_code ?? null,
        monthly_rental_fee: price,
        category: eq?.category ?? null,
      };
    });
}

function buildRecordHtml(yearMonth: string, clientName: string, records: MonthlyRecordRow[]): string {
  const totalRows = records
    .map(
      (r) =>
        `<tr><td>${r.date_range_start}</td><td>${r.date_range_end}</td><td>${r.equipment_name}</td><td>${r.tais_code ?? "-"}</td><td>${r.category ?? "-"}</td><td style="text-align:right">¥${r.monthly_rental_fee.toLocaleString()}</td></tr>`,
    )
    .join("");
  const sum = records.reduce((s, r) => s + r.monthly_rental_fee, 0);
  return `<div style="font-family:sans-serif;font-size:12px;padding:16px;">
<h2 style="font-size:16px;margin:0 0 8px;">${yearMonth} 福祉用具実績 - ${clientName} 様</h2>
<table style="width:100%;border-collapse:collapse;font-size:11px" border="1" cellpadding="6">
<thead><tr style="background:#f3f4f6"><th>開始</th><th>終了</th><th>用具名</th><th>TAIS</th><th>区分</th><th>月額</th></tr></thead>
<tbody>${totalRows || '<tr><td colspan="6" style="text-align:center;color:#888">対象なし</td></tr>'}</tbody>
<tfoot><tr><td colspan="5" style="text-align:right;font-weight:bold">合計</td><td style="text-align:right;font-weight:bold">¥${sum.toLocaleString()}</td></tr></tfoot>
</table>
</div>`;
}

function SendMonthlyRecordModal({
  tenantId, client, sourceOfficeId, yearMonth, clientItems, equipment, priceHistory,
  onClose, onSuccess, onError,
}: {
  tenantId: string;
  client: Client;
  sourceOfficeId: string;
  yearMonth: string;
  clientItems: OrderItem[];
  equipment: Equipment[];
  priceHistory: EquipmentPriceHistory[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [choices, setChoices] = useState<CareOfficeChoice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceOfficeName, setSourceOfficeName] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const records = useMemo(
    () => buildRecordsForMonth(yearMonth, clientItems, equipment, priceHistory),
    [yearMonth, clientItems, equipment, priceHistory],
  );
  const total = useMemo(() => records.reduce((s, r) => s + r.monthly_rental_fee, 0), [records]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: asgn, error: asgnErr } = await supabase
          .from("client_office_assignments")
          .select("office_id")
          .eq("tenant_id", tenantId)
          .eq("client_id", client.id);
        if (asgnErr) throw asgnErr;
        const assignedIds = new Set((asgn ?? []).map((a) => a.office_id as string));

        const { data: careOffices, error: careErr } = await supabase
          .from("offices")
          .select("id, name, service_type")
          .eq("tenant_id", tenantId)
          .eq("service_type", "居宅介護支援")
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true });
        if (careErr) throw careErr;

        const { data: srcOffice } = await supabase
          .from("offices")
          .select("name")
          .eq("id", sourceOfficeId)
          .maybeSingle();
        if (cancelled) return;
        if (srcOffice?.name) setSourceOfficeName(srcOffice.name as string);

        const all: CareOfficeChoice[] = (careOffices ?? []).map((o) => ({
          id: o.id as string,
          name: o.name as string,
          is_assigned: assignedIds.has(o.id as string),
        }));
        const assigned = all.filter((c) => c.is_assigned);
        setChoices(all);
        if (assigned.length > 0) {
          setShowAll(false);
          setSelectedId(assigned[0].id);
        } else {
          setShowAll(true);
          setSelectedId(all[0]?.id ?? null);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, client.id, sourceOfficeId]);

  const visibleChoices = showAll ? choices : choices.filter((c) => c.is_assigned);
  const assignedCount = choices.filter((c) => c.is_assigned).length;

  const handleSend = async () => {
    if (!selectedId) return;
    setSending(true);
    setErrorMsg(null);
    try {
      const { data: userData, error: userErr } = await supabase.auth.getUser();
      if (userErr || !userData?.user) throw new Error("ユーザー情報が取得できません");
      const userId = userData.user.id;

      const html = buildRecordHtml(yearMonth, client.name, records);
      const title = `${yearMonth} 福祉用具実績 - ${client.name} 様`;
      const payload = {
        service_type: "福祉用具",
        year_month: yearMonth,
        client_id: client.id,
        client_name: client.name,
        records,
      };

      const { data: sd, error: sdErr } = await supabase
        .from("shared_documents")
        .insert({
          tenant_id: tenantId,
          client_id: client.id,
          source_office_id: sourceOfficeId,
          target_office_id: selectedId,
          document_type: "service_record_monthly",
          title,
          html_content: html,
          payload,
          sent_by: userId,
        })
        .select("id")
        .single();
      if (sdErr || !sd) throw sdErr ?? new Error("shared_documents 作成失敗");

      const { error: ntErr } = await supabase
        .from("notifications")
        .insert({
          tenant_id: tenantId,
          office_id: selectedId,
          user_id: null,
          type: "document_received",
          ref_table: "shared_documents",
          ref_id: sd.id,
          title: `福祉用具実績を受信: ${client.name} 様 (${yearMonth})`,
          body: `${sourceOfficeName || "送信元事業所"} から`,
        });
      if (ntErr) throw ntErr;

      onSuccess();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      onError(msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[55] bg-black/60 flex items-center justify-center p-4 print:hidden" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="font-semibold text-gray-800">居宅介護支援事業所に月次実績を送信</h3>
          <p className="text-xs text-gray-500 mt-1">
            {client.name} 様 / {yearMonth} / 全 {records.length} 件 / 合計 ¥{total.toLocaleString()}
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          {records.length === 0 ? (
            <p className="text-sm text-amber-600">この月にレンタル中だった用具がありません。</p>
          ) : (
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="text-left px-2 py-1.5">期間</th>
                    <th className="text-left px-2 py-1.5">用具名</th>
                    <th className="text-right px-2 py-1.5">月額</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {records.map((r, idx) => (
                    <tr key={idx}>
                      <td className="px-2 py-1.5 text-gray-700 whitespace-nowrap">{r.date_range_start.slice(5)}〜{r.date_range_end.slice(5)}</td>
                      <td className="px-2 py-1.5 text-gray-800 truncate">{r.equipment_name}</td>
                      <td className="px-2 py-1.5 text-right text-gray-700 whitespace-nowrap">¥{r.monthly_rental_fee.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-6"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
          ) : choices.length === 0 ? (
            <p className="text-sm text-red-500">tenant 内に居宅介護支援事業所が登録されていません</p>
          ) : (
            <div>
              <label className="text-xs text-gray-500 block mb-1.5">送付先</label>
              {assignedCount === 0 && (
                <p className="text-xs text-amber-600 mb-2">
                  この利用者に紐付く居宅介護支援事業所がありません。全候補から手動選択してください。
                </p>
              )}
              {assignedCount > 0 && (
                <label className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)}
                    className="w-3.5 h-3.5 accent-emerald-500" />
                  <span>全 居宅介護支援事業所 から選ぶ</span>
                </label>
              )}
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {visibleChoices.map((c) => (
                  <label key={c.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer ${selectedId === c.id ? "border-emerald-400 bg-emerald-50" : "border-gray-200 hover:bg-gray-50"}`}>
                    <input type="radio" name="target_office_record" value={c.id}
                      checked={selectedId === c.id}
                      onChange={() => setSelectedId(c.id)}
                      className="accent-emerald-500" />
                    <span className="text-sm text-gray-800 flex-1 truncate">{c.name}</span>
                    {c.is_assigned && <span className="text-[10px] text-emerald-600 shrink-0 px-1.5 py-0.5 bg-emerald-100 rounded">担当</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="text-xs text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {errorMsg}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 flex gap-2 justify-end">
          <button onClick={onClose} disabled={sending}
            className="text-sm text-gray-600 px-4 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-50">
            キャンセル
          </button>
          <button onClick={handleSend}
            disabled={loading || sending || !selectedId || records.length === 0}
            className="text-sm text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-300 disabled:cursor-not-allowed px-4 py-2 rounded-lg flex items-center gap-1.5">
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            送信確定
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── HeaderNotificationBadge ────────────────────────────────────────
// 未読 notifications 数を表示する Bell badge。click で notifications タブへ。
function HeaderNotificationBadge({ currentOfficeId, onClick }: { currentOfficeId: string | null; onClick: () => void }) {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchCount = async () => {
      if (!currentOfficeId) { if (!cancelled) setUnread(0); return; }
      const n = await getUnreadCount(currentOfficeId);
      if (!cancelled) setUnread(n);
    };
    void fetchCount();
    const t = setInterval(fetchCount, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [currentOfficeId]);

  return (
    <button
      onClick={onClick}
      className="relative flex items-center justify-center w-8 h-8 rounded-full hover:bg-emerald-700 transition-colors"
      title="通知"
    >
      <Bell size={18} />
      {unread > 0 && (
        <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

