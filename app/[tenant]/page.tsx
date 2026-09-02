"use client";

import { useState, useEffect, use, useCallback, Fragment, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import {
  Package,
  ClipboardList,
  Users,
  Settings,
  ChevronDown,
  ChevronRight,
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
  Clock,
  CalendarClock,
  Hammer,
} from "lucide-react";
import { Order, OrderItem, Equipment, Client, Supplier, Member, EquipmentPriceHistory } from "@/lib/supabase";
import { todayYmd } from "@/lib/date-jst";
import { type CompanyInfo, COMPANY_INFO_DEFAULTS } from "./company-info";
import { normalizeSearch } from "./search-utils";
import { KANA_ROWS } from "./kana-rows";
import NewOrderModal from "./NewOrderModal";
import { STATUS_LABEL, STATUS_COLOR, NEXT_STATUSES } from "./order-item-helpers";
import RentalReportModal from "./RentalReportModal";
import OrderEmailPreviewModal from "./OrderEmailPreviewModal";
import { getOrders, updateOrderItemStatus, getAllOrderItemsByTenant, getMembers, mergeOrders, unmergeOrder } from "@/lib/orders";
import { getEquipment, getSuppliers, getPriceHistory } from "@/lib/equipment";
import { getClients } from "@/lib/clients";
import { getTenants, getTenantById } from "@/lib/tenants";
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
const ClientsTab = dynamic(() => import("./ClientsTab"), { ssr: false, loading: TabLoadingFallback });
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

