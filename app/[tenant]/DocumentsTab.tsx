"use client";
import { useState, useEffect, useCallback } from "react";
import { ChevronLeft, Loader2, Printer, FileText } from "lucide-react";
import { supabase, Order, OrderItem, Equipment, EquipmentPriceHistory, Client, Supplier, Member, ClientDocument, DocTask } from "@/lib/supabase";
import { getClientDocuments, saveClientDocument, deleteClientDocument } from "@/lib/documents";
import { todayYmd, toJapaneseEra } from "@/lib/date-jst";
import { type CompanyInfo, COMPANY_INFO_DEFAULTS } from "./company-info";
import { HW_KANA } from "./search-utils";
import { completeDocTask } from "@/lib/docTasks";
import { getOrderItems, getMembers } from "@/lib/orders";
import { getEquipment, getSuppliers, getPriceHistory } from "@/lib/equipment";
import { getTenantById } from "@/lib/tenants";
import { getCarePlanElementsByClient, completeCarePlanElements, describeCarePlanElement, filterElementsForDocType } from "@/lib/carePlanElements";
import { CarePlanElement } from "@/lib/supabase";
import { type SharedDocumentRow } from "@/lib/notifications";
import CarePlanModal from "./CarePlanModal";
import ProposalModal from "./ProposalModal";
import ContractDocumentsModal from "./ContractDocumentsModal";
import RentalReportModal from "./RentalReportModal";
import OrderEmailPreviewModal from "./OrderEmailPreviewModal";

// ─── Documents Tab ───────────────────────────────────────────────────────────

// v2: pending doc_task バナー用 — expected_doc_type を日本語ラベルに変換
const EXPECTED_DOC_TYPE_LABELS: Record<string, string> = {
  rental_report: "貸与報告書",
  care_plan: "個別援助計画書",
  proposal: "選定提案書",
  rental_contract: "重要事項説明書 / 契約書",
  important_matters: "重要事項説明書",
  change_contract: "変更契約書",
};

export default function DocumentsTab({ tenantId, currentOfficeId, officeViewAll, initialSelectedClientId, initialDocTaskId, initialExpectedDocType, onClearInitialClient }: { tenantId: string; currentOfficeId: string | null; officeViewAll: boolean; initialSelectedClientId?: string | null; initialDocTaskId?: string | null; initialExpectedDocType?: string | null; onClearInitialClient?: () => void }) {
  // v2: 「書類タスク」から遷移したときの紐付け doc_task.id (saveClientDocument 後に completed 化)
  const [pendingDocTaskId, setPendingDocTaskId] = useState<string | null>(null);
  // v2: pending task の詳細 (バナー表示用 — trigger_label / due_date など)
  const [pendingDocTask, setPendingDocTask] = useState<DocTask | null>(null);
  // v2: pending task の expected_doc_type (state) — バナーラベル表示用
  const [pendingExpectedDocType, setPendingExpectedDocType] = useState<string | null>(null);
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

  // 受信ケアプラン (居宅介護支援 → 自事業所)
  const [receivedCarePlans, setReceivedCarePlans] = useState<SharedDocumentRow[]>([]);
  const [receivedCarePlansLoading, setReceivedCarePlansLoading] = useState(false);
  const [previewSharedDoc, setPreviewSharedDoc] = useState<SharedDocumentRow | null>(null);
  const [sourceOfficeNameMap, setSourceOfficeNameMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    // Phase 8: officeViewAll=false なら currentOfficeId で絞り込み
    const officeFilter = officeViewAll ? null : currentOfficeId;
    // PostgREST default limit 1000 を超えるケース対応 (ページング)
    const fetchAllClients = async (): Promise<Client[]> => {
      const PAGE = 1000;
      const all: Client[] = [];
      let from = 0;
      while (true) {
        let q = supabase.from("clients").select("*").eq("tenant_id", tenantId).order("furigana").range(from, from + PAGE - 1);
        if (officeFilter) q = q.eq("office_id", officeFilter);
        const { data, error } = await q;
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as Client[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    };
    Promise.all([
      fetchAllClients(),
      getEquipment(tenantId),
      getTenantById(tenantId),
    ]).then(([cls, equip, tenant]) => {
      setClients(cls);
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
  }, [tenantId, currentOfficeId, officeViewAll]);

  const loadReceivedCarePlans = useCallback(async (clientId: string) => {
    if (!currentOfficeId) {
      setReceivedCarePlans([]);
      return;
    }
    setReceivedCarePlansLoading(true);
    try {
      const { data, error } = await supabase
        .from("shared_documents")
        .select("id, tenant_id, client_id, source_office_id, target_office_id, document_type, title, html_content, payload, source_document_id, sent_at, sent_by, read_at, read_by, created_at")
        .eq("client_id", clientId)
        .eq("target_office_id", currentOfficeId)
        .in("document_type", ["care-plan-1", "care-plan-2", "care-plan-3"])
        .order("sent_at", { ascending: false });
      if (error) {
        setReceivedCarePlans([]);
        return;
      }
      const rows = (data ?? []) as SharedDocumentRow[];
      setReceivedCarePlans(rows);
      // 送信元事業所名 fetch
      const sourceIds = Array.from(new Set(rows.map((r) => r.source_office_id)));
      if (sourceIds.length > 0) {
        const { data: offs } = await supabase
          .from("offices")
          .select("id, name")
          .in("id", sourceIds);
        const map = new Map<string, string>();
        for (const o of ((offs ?? []) as Array<{ id: string; name: string }>)) {
          map.set(o.id, o.name);
        }
        setSourceOfficeNameMap(map);
      }
    } finally {
      setReceivedCarePlansLoading(false);
    }
  }, [currentOfficeId]);

  const loadClientData = async (client: Client) => {
    setClientLoading(true);
    setClientItems([]); setDocuments([]); setPriceHistory([]); setOrderPaymentMap({}); setReceivedCarePlans([]);
    const [{ data: ordersData }, docs] = await Promise.all([
      supabase.from("orders").select("id, payment_type").eq("tenant_id", tenantId).eq("client_id", client.id),
      getClientDocuments(tenantId, client.id),
      loadReceivedCarePlans(client.id),
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

  // v2: 書類タスクから遷移して書類作成した直後に呼ぶ。
  //     最新の expected type document を pendingDocTaskId に紐付けて completed 化。
  const closePendingDocTaskWith = async (expectedType: string) => {
    if (!pendingDocTaskId || !selectedClient) return;
    try {
      const docs = await getClientDocuments(tenantId, selectedClient.id);
      // expected type に対応する最新 client_document を取得
      // rental_contract task は実 type が contract (統合後) / rental_contract / important_matters (旧) のいずれか
      const equivTypes =
        expectedType === "rental_contract"
          ? ["contract", "rental_contract", "important_matters"]
          : [expectedType];
      const latest = docs.find((d) => equivTypes.includes(d.type));
      if (latest) {
        await completeDocTask(pendingDocTaskId, latest.id);
      }
    } catch (e) {
      console.error("closePendingDocTask error:", e);
    } finally {
      setPendingDocTaskId(null);
      setPendingDocTask(null);
      setPendingExpectedDocType(null);
    }
  };

  // v2: pending doc_task の詳細を fetch (バナー表示用)
  // pendingDocTaskId が null になる場面では呼び出し元 (closePendingDocTaskWith / 解除ボタン)
  // が pendingDocTask も同時に null 化するため、ここでは fetch のみ責務とする。
  useEffect(() => {
    if (!pendingDocTaskId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("doc_tasks")
        .select("*")
        .eq("id", pendingDocTaskId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.error("fetch pendingDocTask error:", error);
        setPendingDocTask(null);
        return;
      }
      setPendingDocTask((data as DocTask | null) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingDocTaskId]);

  // 書類タスクからの遷移時、対象 client を pre-select + (v2) modal auto-open + doc_task 紐付け
  useEffect(() => {
    if (!initialSelectedClientId || clients.length === 0) return;
    const c = clients.find((cc) => cc.id === initialSelectedClientId);
    if (c) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 親 state 駆動の cross-tab 遷移 pre-select (mount-time init 相当)
      setSelectedClient(c);
      void loadClientData(c);
      // v2: 該当 modal を自動 open
      if (initialExpectedDocType) {
        setPendingDocTaskId(initialDocTaskId ?? null);
        setPendingExpectedDocType(initialExpectedDocType);
        switch (initialExpectedDocType) {
          case "care_plan":
            setCarePlanInitialParams(null);
            setShowCarePlan(true);
            break;
          case "proposal":
            setProposalInitialParams(null);
            setShowProposal(true);
            break;
          case "rental_contract":
            setShowContracts(true);
            break;
          case "change_contract":
            setChangeContractInitialParams(null);
            setShowChangeContract(true);
            break;
          // supplier_email は OrdersTab 側のメール送信で発生。Documents からは作成不可。
        }
      }
    }
    onClearInitialClient?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 意図的: loadClientData/onClearInitialClient は依存外
  }, [initialSelectedClientId, clients]);

  const KANA_ROWS = ["あ","か","さ","た","な","は","ま","や","ら","わ","他"];
  const KANA_MAP: Record<string, string[]> = {
    "あ":["ア","イ","ウ","エ","オ"],"か":["カ","キ","ク","ケ","コ","ガ","ギ","グ","ゲ","ゴ"],
    "さ":["サ","シ","ス","セ","ソ","ザ","ジ","ズ","ゼ","ゾ"],"た":["タ","チ","ツ","テ","ト","ダ","ヂ","ヅ","デ","ド"],
    "な":["ナ","ニ","ヌ","ネ","ノ"],"は":["ハ","ヒ","フ","ヘ","ホ","バ","ビ","ブ","ベ","ボ","パ","ピ","プ","ペ","ポ"],
    "ま":["マ","ミ","ム","メ","モ"],"や":["ヤ","ユ","ヨ"],
    "ら":["ラ","リ","ル","レ","ロ"],"わ":["ワ","ヲ","ン"],
  };
  const toKana = (s: string) => s
    .normalize("NFC")
    .replace(/[\uff66-\uff9f]/g, (c) => HW_KANA[c] ?? c)                                        // \u534a\u89d2\u30ab\u30ca\u2192\u5168\u89d2\u30ab\u30ca
    .replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));  // \u3072\u3089\u304c\u306a\u2192\u30ab\u30bf\u30ab\u30ca
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
                {/* v2: 書類タスク連携中バナー (pending doc_task がある時のみ) */}
                {pendingDocTaskId && pendingExpectedDocType && (
                  <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-blue-800">
                    <div className="flex items-start gap-2">
                      <span className="shrink-0 text-base leading-5">📌</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold">
                          書類タスク連携中 — 「{EXPECTED_DOC_TYPE_LABELS[pendingExpectedDocType] ?? pendingExpectedDocType}」を作成してください
                        </p>
                        {pendingDocTask && (
                          <p className="text-xs text-blue-700 mt-1 leading-relaxed">
                            {pendingDocTask.trigger_label && (
                              <span>触発元: {pendingDocTask.trigger_label}</span>
                            )}
                            {pendingDocTask.due_date && (
                              <span className="ml-2">期限: {pendingDocTask.due_date}</span>
                            )}
                            {!pendingDocTask.due_date && pendingDocTask.trigger_date && (
                              <span className="ml-2">発生日: {pendingDocTask.trigger_date}</span>
                            )}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingDocTaskId(null);
                          setPendingDocTask(null);
                          setPendingExpectedDocType(null);
                        }}
                        className="shrink-0 text-xs px-2 py-1 rounded border border-blue-300 bg-white text-blue-700 hover:bg-blue-100 transition-colors"
                      >
                        タスクを解除
                      </button>
                    </div>
                  </div>
                )}
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
                          doc.type === "contract" ||
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
                                  } else if (doc.type === "contract" || doc.type === "rental_contract" || doc.type === "important_matters") {
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
                                    // 統合済の場合: merged_from_order_ids に元 orderId を含む統合先 order を探す
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
                                      showSavedFromParams("元の発注が見つかりません（削除された可能性があります）。");
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

                {/* 受信ケアプラン (居宅介護支援 → 自事業所) — 帳票種別ごとにグループ化 */}
                {(() => {
                  // (source_office_id, sent_at ±5 分) でグループ化
                  const GROUP_WINDOW_MS = 5 * 60 * 1000;
                  type Group = {
                    key: string;
                    sourceOfficeId: string;
                    sourceOfficeName: string;
                    sentAt: string;
                    items: SharedDocumentRow[];
                  };
                  const sorted = [...receivedCarePlans].sort((a, b) =>
                    a.sent_at < b.sent_at ? -1 : 1,
                  );
                  const groups: Group[] = [];
                  for (const r of sorted) {
                    const t = new Date(r.sent_at).getTime();
                    const g = groups.find(
                      (gg) =>
                        gg.sourceOfficeId === r.source_office_id &&
                        Math.abs(new Date(gg.sentAt).getTime() - t) <= GROUP_WINDOW_MS,
                    );
                    if (g) {
                      g.items.push(r);
                    } else {
                      groups.push({
                        key: `${r.source_office_id}_${r.sent_at}`,
                        sourceOfficeId: r.source_office_id,
                        sourceOfficeName: sourceOfficeNameMap.get(r.source_office_id) ?? "—",
                        sentAt: r.sent_at,
                        items: [r],
                      });
                    }
                  }
                  for (const g of groups) {
                    g.items.sort((a, b) => (a.document_type < b.document_type ? -1 : 1));
                  }
                  groups.sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));

                  const CARE_PLAN_LABEL: Record<string, string> = {
                    "care-plan-1": "第1表",
                    "care-plan-2": "第2表",
                    "care-plan-3": "第3表",
                  };

                  return (
                    <div className="mt-6">
                      <div className="flex items-center gap-2 mb-2">
                        <p className="text-xs text-gray-500 font-semibold uppercase tracking-wide">
                          受信ケアプラン ({groups.length} 件)
                        </p>
                        {receivedCarePlansLoading && <Loader2 size={12} className="animate-spin text-gray-400" />}
                      </div>
                      {groups.length === 0 ? (
                        <p className="text-sm text-gray-400 text-center py-6 border border-dashed border-gray-200 rounded-lg">
                          この利用者宛ての受信ケアプランはありません
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {groups.map((g) => (
                            <div
                              key={g.key}
                              className="bg-white rounded-xl px-3 py-2.5 border border-blue-100 shadow-sm"
                            >
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <FileText size={16} className="text-blue-500 shrink-0" />
                                <span className="text-sm font-medium text-gray-800 truncate">
                                  {g.sourceOfficeName}
                                </span>
                                {g.items.map((it) => (
                                  <button
                                    key={it.id}
                                    type="button"
                                    onClick={() => setPreviewSharedDoc(it)}
                                    className="inline-flex items-center gap-0.5 rounded bg-blue-100 text-blue-700 px-1.5 py-0.5 text-[10px] font-medium hover:bg-blue-200"
                                    title={`${CARE_PLAN_LABEL[it.document_type] ?? it.document_type} を表示`}
                                  >
                                    {CARE_PLAN_LABEL[it.document_type] ?? it.document_type}
                                  </button>
                                ))}
                              </div>
                              <p className="text-xs text-gray-400 ml-6">
                                送信: {new Date(g.sentAt).toLocaleString("ja-JP", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                {g.items.length > 1 && <span className="ml-1">・{g.items.length} 帳票一括</span>}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 受信ケアプラン プレビューモーダル */}
      {previewSharedDoc && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex flex-col" onClick={() => setPreviewSharedDoc(null)}>
          <div className="bg-white border-b border-gray-200 px-4 py-2 flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setPreviewSharedDoc(null)} className="text-gray-500 hover:text-gray-700">✕</button>
            <span className="font-semibold text-sm text-gray-800 flex-1 truncate">{previewSharedDoc.title}</span>
            <span className="text-[11px] text-gray-500">
              {previewSharedDoc.sent_at?.slice(0, 16).replace("T", " ")}
            </span>
            <button
              onClick={() => {
                const w = window.open("", "_blank");
                if (w) { w.document.write(previewSharedDoc.html_content); w.document.close(); }
              }}
              className="text-xs border border-gray-300 bg-white text-gray-700 px-3 py-1 rounded hover:bg-gray-50"
            >
              別タブで開く
            </button>
            <button
              onClick={() => {
                const iframe = document.getElementById("received-careplan-iframe") as HTMLIFrameElement | null;
                if (iframe?.contentWindow) iframe.contentWindow.print();
              }}
              className="text-xs bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded"
            >
              印刷
            </button>
          </div>
          <iframe
            id="received-careplan-iframe"
            srcDoc={previewSharedDoc.html_content}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            className="flex-1 border-0 bg-white"
            title={previewSharedDoc.title}
            onClick={(e) => e.stopPropagation()}
          />
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
          onSaved={async () => { await refreshDocs(); await closePendingDocTaskWith("care_plan"); setShowCarePlan(false); }}
        />
      )}
      {showProposal && selectedClient && (
        <ProposalModal
          client={selectedClient} clientItems={clientItems} equipment={equipment}
          companyInfo={companyInfo} tenantId={tenantId}
          initialParams={proposalInitialParams ?? undefined}
          onClose={() => setShowProposal(false)}
          onSaved={async () => { await refreshDocs(); await closePendingDocTaskWith("proposal"); setShowProposal(false); }}
        />
      )}
      {showContracts && selectedClient && (
        <ContractDocumentsModal
          client={selectedClient} clientItems={clientItems} equipment={equipment}
          companyInfo={companyInfo} tenantId={tenantId}
          onClose={() => setShowContracts(false)}
          onSaved={async () => { await refreshDocs(); await closePendingDocTaskWith("rental_contract"); setShowContracts(false); }}
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
            await closePendingDocTaskWith("change_contract");
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
  const todayStr = todayYmd();
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

  // 発生要因 (change_contract = additional_delivery / pickup / plan_change)
  const [elements, setElements] = useState<CarePlanElement[]>([]);
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(
    () => new Set((initialParams?.selectedElementIds as string[]) ?? []),
  );
  useEffect(() => {
    getCarePlanElementsByClient(client.id).then((all) => {
      setElements(filterElementsForDocType(all, "change_contract"));
    });
  }, [client.id]);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setRows(buildRows());
  }, [buildRows]);

  const currentTotal = rows.filter((r) => r.inCurrent).reduce((s, r) => s + r.unitPrice * r.quantity, 0);
  const nextTotal = rows.filter((r) => r.inNext).reduce((s, r) => s + r.unitPrice * r.quantity, 0);

  const contractDateJa = contractDate ? toJapaneseEra(new Date(contractDate + "T00:00:00")) : "　　年　月　日";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
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
      const saved = await saveClientDocument({
        tenant_id: tenantId,
        client_id: client.id,
        type: "change_contract",
        title: `変更契約書 ${contractDate}`,
        params: { contractDate, currentMonth, nextMonth, benefitRate, selectedElementIds: [...selectedElementIds] },
      });
      if (selectedElementIds.size > 0) {
        await completeCarePlanElements([...selectedElementIds], saved.id);
      }
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
            <button disabled={rows.length === 0 && selectedElementIds.size === 0} onClick={() => setStep(2)}
              className="px-4 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
              次へ（プレビュー）
            </button>
          )}
        </div>

        {/* Step 1: 設定 */}
        {step === 1 && (
          <div className="flex-1 overflow-auto p-5 space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">発生要因（該当する項目をチェック）</h3>
              {elements.length === 0 ? (
                <p className="text-sm text-gray-400">対象となる発生要因はまだ記録されていません</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                  {elements.map((el, idx) => {
                    const completed = el.status === "completed";
                    const checked = selectedElementIds.has(el.id);
                    return (
                      <label key={el.id} className={`flex items-center gap-2 px-3 py-2 ${completed ? "opacity-40" : "cursor-pointer hover:bg-gray-50"}`}>
                        <input type="checkbox" checked={checked} disabled={completed}
                          onChange={(e) => {
                            setSelectedElementIds((prev) => {
                              const n = new Set(prev);
                              if (e.target.checked) n.add(el.id); else n.delete(el.id);
                              return n;
                            });
                          }}
                          className="accent-emerald-500 shrink-0" />
                        <span className="text-xs text-gray-400 w-6 shrink-0">{idx + 1}.</span>
                        <span className="text-xs text-gray-500 shrink-0">{el.occurred_at}</span>
                        <span className="flex-1 text-sm text-gray-800 min-w-0 truncate">{describeCarePlanElement(el)}</span>
                        {completed && <span className="text-[10px] text-gray-400 shrink-0">（済）</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
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

