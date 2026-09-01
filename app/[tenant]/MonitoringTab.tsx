"use client";

import { useState, useEffect, useMemo, Fragment } from "react";
import { ChevronLeft, ChevronRight, CheckCircle2, Loader2, Send, Eye, Download } from "lucide-react";
import { supabase, Client, Equipment, ClientRentalHistory, MonitoringRecord, MonitoringItem, ClientInsuranceRecord, OrderItem } from "@/lib/supabase";
import { getEquipment } from "@/lib/equipment";
import { getTenantById } from "@/lib/tenants";
import { todayYmd } from "@/lib/date-jst";
import { type CompanyInfo, COMPANY_INFO_DEFAULTS } from "./company-info";
import SendRentalReportModal from "./SendRentalReportModal";

function calcNextDueMonth(base: string): string {
  const [y, m] = base.split("-").map(Number);
  const total = y * 12 + m - 1 + 6;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export default function MonitoringTab({ tenantId, currentOfficeId, officeViewAll }: { tenantId: string; currentOfficeId: string | null; officeViewAll: boolean }) {
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

  // eslint-disable-next-line react-hooks/immutability, react-hooks/exhaustive-deps -- TDZ: function declared below; useEffect callback runs post-render so safe at runtime
  useEffect(() => { loadData(); }, [tenantId, currentOfficeId, officeViewAll]);

  const loadData = async () => {
    setLoading(true);
    try {
      // Phase 8: officeViewAll=false なら currentOfficeId で絞り込み
      const officeFilter = officeViewAll ? null : currentOfficeId;
      // clients は 1000 件超えるケースあり (kt-group の office=1bfc0d57 で 1777 件)。
      // 必ずページングで全件取得する。
      const fetchAllClients = async (): Promise<Client[]> => {
        const PAGE = 1000;
        const all: Client[] = [];
        let from = 0;
        while (true) {
          let q = supabase.from("clients").select("*").eq("tenant_id", tenantId).order("id").range(from, from + PAGE - 1);
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
      const [cls, monRes, eqData, tenantData, rentalHistRes] = await Promise.all([
        fetchAllClients(),
        supabase.from("monitoring_records").select("*").eq("tenant_id", tenantId).order("target_month", { ascending: false }),
        getEquipment(tenantId),
        getTenantById(tenantId),
        supabase.from("client_rental_history").select("*").eq("tenant_id", tenantId)
          .or(`end_date.is.null,end_date.gte.${todayYmd()}`),
      ]);
      // orders をページングで全件取得
      const allOrders: { id: string; client_id: string }[] = [];
      let ordFrom = 0;
      while (true) {
        let ordQ = supabase
          .from("orders").select("id, client_id")
          .eq("tenant_id", tenantId)
          .order("id").range(ordFrom, ordFrom + 999);
        if (officeFilter) ordQ = ordQ.eq("office_id", officeFilter);
        const { data: ordChunk } = await ordQ;
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
      // order_items は office_id 列を持たないので、上で office filter 済の allOrders 経由で絞る
      const items: OrderItem[] = [];
      let itemFrom = 0;
      while (true) {
        const { data: chunk } = await supabase
          .from("order_items")
          .select("*")
          .eq("tenant_id", tenantId)
          .in("status", ["rental_started", "delivered", "trial"])
          .order("id").range(itemFrom, itemFrom + 999);
        if (!chunk || chunk.length === 0) break;
        items.push(...(chunk as OrderItem[]));
        if (chunk.length < 1000) break;
        itemFrom += 1000;
      }
      const orderIds = new Set(allOrders.map((o) => o.id));
      const filteredItems = officeFilter ? items.filter((i) => orderIds.has(i.order_id)) : items;
      setActiveItems(filteredItems);
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
        currentOfficeId={currentOfficeId}
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
  itemChecks, equipment, insuranceRecord, continuityComment, reportComment, previousComment,
  goalAchievement, goalComment, onClose,
  tenantId, currentOfficeId, monitoringRecordId,
}: {
  client: Client;
  visitDate: string;
  reportDate: string;
  tm: string;
  staffName: string;
  companyInfo: CompanyInfo;
  itemChecks: { order_item_id: string; product_code: string; equipment_name: string; category: string; quantity: number; no_issue: boolean; has_malfunction: boolean; has_deterioration: boolean; needs_replacement: boolean; has_usage_issue: boolean }[];
  equipment: Equipment[];
  insuranceRecord: ClientInsuranceRecord | null;
  continuityComment: string;
  reportComment: string;
  previousComment: string;
  goalAchievement: string;
  goalComment: string;
  onClose: () => void;
  tenantId: string;
  currentOfficeId: string | null;
  monitoringRecordId: string | null;
}) {
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendToast, setSendToast] = useState<{ kind: "success" | "error"; msg: string } | null>(null);
  useEffect(() => {
    if (!sendToast) return;
    const t = setTimeout(() => setSendToast(null), 3500);
    return () => clearTimeout(t);
  }, [sendToast]);
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

  // 用具行数に応じて A4 縦 1 枚に収まるよう tier を決定（印刷時のみ反映）
  const rowCount = itemChecks.length;
  const tier =
    rowCount <= 3 ? "few" :
    rowCount <= 6 ? "medium" :
    rowCount <= 10 ? "many" : "overflow";

  // 印刷用スタイル: モーダルだけを A4 縦 1 枚に展開し、tier 別に余白/行高を調整
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "__monitoring_print__";
    style.textContent = `
      @page { size: A4 portrait; margin: 10mm 12mm; }
      @media print {
        body > * { visibility: hidden !important; }
        #monitoring-preview-modal, #monitoring-preview-modal * { visibility: visible !important; }
        #monitoring-preview-modal {
          position: fixed !important; top: 0 !important; left: 0 !important;
          width: 100% !important; height: auto !important;
          background: white !important; z-index: 99999 !important;
          overflow: visible !important; padding: 0 !important;
        }
        #monitoring-preview-modal .monitoring-shell {
          box-shadow: none !important; border-radius: 0 !important;
          width: 100% !important; max-width: none !important;
          padding: 0 !important; margin: 0 !important;
        }
        #monitoring-preview-modal .monitoring-doc { padding: 0 !important; }

        /* tier: few (1-3 行) — ゆったり */
        .monitoring-doc.tier-few { gap: 14px; }
        .monitoring-doc.tier-few > * { margin-top: 0 !important; margin-bottom: 14px !important; }
        .monitoring-doc.tier-few .monitoring-equipment-table td,
        .monitoring-doc.tier-few .monitoring-equipment-table th { height: 30px; padding: 4px 4px !important; }
        .monitoring-doc.tier-few .monitoring-report-area { min-height: 200px !important; }
        .monitoring-doc.tier-few .monitoring-continuity-area { min-height: 60px !important; }

        /* tier: medium (4-6 行) — 中 */
        .monitoring-doc.tier-medium { gap: 10px; }
        .monitoring-doc.tier-medium > * { margin-top: 0 !important; margin-bottom: 10px !important; }
        .monitoring-doc.tier-medium .monitoring-equipment-table td,
        .monitoring-doc.tier-medium .monitoring-equipment-table th { height: 24px; padding: 3px 4px !important; }
        .monitoring-doc.tier-medium .monitoring-report-area { min-height: 130px !important; }
        .monitoring-doc.tier-medium .monitoring-continuity-area { min-height: 42px !important; }

        /* tier: many (7-10 行) — コンパクト */
        .monitoring-doc.tier-many { gap: 7px; font-size: 10px; }
        .monitoring-doc.tier-many > * { margin-top: 0 !important; margin-bottom: 7px !important; }
        .monitoring-doc.tier-many .monitoring-equipment-table td,
        .monitoring-doc.tier-many .monitoring-equipment-table th { height: 20px; padding: 2px 3px !important; font-size: 9px; }
        .monitoring-doc.tier-many .monitoring-report-area { min-height: 80px !important; }
        .monitoring-doc.tier-many .monitoring-continuity-area { min-height: 30px !important; }

        /* tier: overflow (11+ 行) — 最低限まで縮小 */
        .monitoring-doc.tier-overflow { gap: 5px; font-size: 9px; }
        .monitoring-doc.tier-overflow > * { margin-top: 0 !important; margin-bottom: 5px !important; }
        .monitoring-doc.tier-overflow .monitoring-equipment-table td,
        .monitoring-doc.tier-overflow .monitoring-equipment-table th { height: 16px; padding: 1px 2px !important; font-size: 8px; line-height: 1.1; }
        .monitoring-doc.tier-overflow .monitoring-report-area { min-height: 48px !important; }
        .monitoring-doc.tier-overflow .monitoring-continuity-area { min-height: 20px !important; }
        .monitoring-doc.tier-overflow .monitoring-header { padding: 6px !important; }
        .monitoring-doc.tier-overflow .monitoring-header > div { line-height: 1.25; }
      }
    `;
    document.head.appendChild(style);
    return () => { document.getElementById("__monitoring_print__")?.remove(); };
  }, []);

  return (
    <div id="monitoring-preview-modal" className="fixed inset-0 z-50 bg-black/60 overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start justify-center py-4 px-2">
        <div className="monitoring-shell bg-white w-full max-w-3xl rounded-xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
          {/* Toolbar */}
          <div className="bg-gray-800 text-white px-4 py-2.5 flex items-center justify-between print:hidden">
            <span className="text-sm font-medium">プレビュー：モニタリング報告書（{rowCount}行 / {tier}）</span>
            <div className="flex gap-2">
              <button
                onClick={() => setShowSendModal(true)}
                disabled={!currentOfficeId}
                title={!currentOfficeId ? "送信元事業所が選択されていません" : "居宅介護支援事業所に貸与報告書を送付"}
                className="text-xs bg-emerald-500 hover:bg-emerald-600 disabled:bg-gray-500 disabled:cursor-not-allowed px-3 py-1.5 rounded-lg flex items-center gap-1"
              >
                <Send size={12} /> 居宅事業所に送付
              </button>
              <button onClick={() => window.print()} className="text-xs bg-blue-500 hover:bg-blue-600 px-3 py-1.5 rounded-lg">印刷</button>
              <button onClick={onClose} className="text-xs bg-gray-600 hover:bg-gray-700 px-3 py-1.5 rounded-lg">閉じる</button>
            </div>
          </div>

          {/* Document */}
          <div className={`monitoring-doc tier-${tier} p-6 text-[11px] leading-relaxed font-sans space-y-3`} style={{ fontFamily: "'MS Gothic', monospace" }}>
            {/* Header */}
            <div className="monitoring-header border-2 border-gray-700 p-3 space-y-1">
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
              <table className="monitoring-equipment-table w-full border-collapse">
                <thead>
                  <tr>
                    <th className={`${TH} w-20`}>種目</th>
                    <th className={TH}>機種名</th>
                    <th className={`${TH} w-10`}>数量</th>
                    <th className={`${TH} w-16`} colSpan={2}>問題なし</th>
                    <th className={`${TH} w-16`} colSpan={2}>不具合</th>
                    <th className={`${TH} w-16`} colSpan={2}>劣化</th>
                    <th className={`${TH} w-16`} colSpan={2}>交換必要</th>
                    <th className={`${TH} w-16`} colSpan={2}>使用状況の問題</th>
                  </tr>
                  <tr>
                    <th className={TH}></th><th className={TH}></th><th className={TH}></th>
                    {["問題なし","不具合","劣化","交換必要","使用状況の問題"].map(h => (
                      <Fragment key={h}>
                        <th className={TH}>なし</th>
                        <th className={TH}>あり</th>
                      </Fragment>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {itemChecks.map((item, idx) => {
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
                        <td className={`${TD} text-center`}>{!item.has_usage_issue ? "☑" : "□"}</td>
                        <td className={`${TD} text-center`}>{item.has_usage_issue ? "☑" : "□"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Comments */}
            <div className="border border-gray-400 p-2 space-y-2">
              <div>
                <div className="text-gray-500 font-semibold mb-0.5">■ 利用目標の達成状況</div>
                <div className="monitoring-goal-area">
                  <span className="text-gray-500">達成状況: </span>
                  <span className="font-bold">{goalAchievement || "―"}</span>
                </div>
                <div className="whitespace-pre-wrap">{goalComment || "―"}</div>
              </div>
              <div className="border-t border-gray-300 pt-2">
                <div className="text-gray-500 font-semibold mb-0.5">■ 継続・必要性</div>
                <div className="monitoring-continuity-area whitespace-pre-wrap min-h-[2.5rem]">{continuityComment}</div>
              </div>
              <div className="border-t border-gray-300 pt-2">
                <div className="text-gray-500 font-semibold mb-0.5">■ 報告内容</div>
                <div className="monitoring-report-area whitespace-pre-wrap min-h-[3rem]">{reportComment}</div>
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

      {/* 送付トースト */}
      {sendToast && (
        <div className="fixed top-6 right-6 z-[60] print:hidden" onClick={e => e.stopPropagation()}>
          <div className={`px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium ${sendToast.kind === "success" ? "bg-emerald-500 text-white" : "bg-red-500 text-white"}`}>
            {sendToast.msg}
          </div>
        </div>
      )}

      {/* 送付確認モーダル */}
      {showSendModal && currentOfficeId && (
        <SendRentalReportModal
          tenantId={tenantId}
          client={client}
          sourceOfficeId={currentOfficeId}
          monitoringRecordId={monitoringRecordId}
          visitDate={visitDate}
          reportDate={reportDate}
          getHtmlSnapshot={() => {
            const docEl = document.querySelector("#monitoring-preview-modal .monitoring-doc");
            return docEl ? docEl.outerHTML : "";
          }}
          onClose={() => setShowSendModal(false)}
          onSuccess={() => { setShowSendModal(false); setSendToast({ kind: "success", msg: "送付しました" }); }}
          onError={(msg) => { setShowSendModal(false); setSendToast({ kind: "error", msg: `送付失敗: ${msg}` }); }}
        />
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
  has_usage_issue: boolean;
};

function MonitoringFormModal({
  client, clientItems, clientHistItems, equipment, companyInfo, tenantId, currentOfficeId, lastRecord, targetMonth, existingRecord, onClose, onSaved,
}: {
  client: Client;
  clientItems: OrderItem[];
  clientHistItems: ClientRentalHistory[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  tenantId: string;
  currentOfficeId: string | null;
  lastRecord: MonitoringRecord | null;
  targetMonth: string;
  existingRecord: MonitoringRecord | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const todayStr = todayYmd();
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
  const [goalAchievement, setGoalAchievement] = useState(existingRecord?.goal_achievement ?? "");
  const [goalComment, setGoalComment] = useState(existingRecord?.goal_comment ?? "");
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
        no_issue: true, has_malfunction: false, has_deterioration: false, needs_replacement: false, has_usage_issue: false,
      };
    });
    const fromHistory = clientHistItems.map(h => ({
      order_item_id: h.id,
      product_code: "",
      equipment_name: h.equipment_name,
      category: "",
      quantity: 1,
      no_issue: true, has_malfunction: false, has_deterioration: false, needs_replacement: false, has_usage_issue: false,
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
          has_usage_issue: item.has_usage_issue ?? false,
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
        goal_achievement: goalAchievement || null,
        goal_comment: goalComment || null,
        status: "completed",
      }).select().single();
      if (error || !rec) { console.error(error); return; }
      for (const check of itemChecks) {
        const { error: itemError } = await supabase.from("monitoring_items").insert({
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
          has_usage_issue: check.has_usage_issue,
        });
        if (itemError) console.error("monitoring_items insert failed:", itemError.message);
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
          has_usage_issue: c.has_usage_issue,
          };
        }),
        continuity_comment: continuityComment,
        report_comment: reportComment,
        previous_comment: previousComment,
        goal_achievement: goalAchievement || null,
        goal_comment: goalComment || null,
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

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto w-full space-y-4">
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
                  <label className="flex items-center gap-0.5 cursor-pointer" title="使用状況上の問題（チェック＝あり／未チェック＝問題なし）">
                    <input type="checkbox" checked={check.has_usage_issue}
                      onChange={e => updateCheck(idx, "has_usage_issue", e.target.checked)}
                      className="w-3.5 h-3.5 accent-purple-500" />
                    <span className="text-[10px] text-gray-600">使用状況上の問題</span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {/* 利用目標の達成状況 */}
        <div className="bg-gray-50 rounded-xl p-3 space-y-3">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">利用目標の達成状況</p>
          <div>
            <label className="text-xs text-gray-500 block mb-1">達成状況</label>
            <select value={goalAchievement} onChange={e => setGoalAchievement(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 bg-white">
              <option value="">未選択</option>
              <option value="達成">達成</option>
              <option value="一部達成">一部達成</option>
              <option value="未達成">未達成</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500 block mb-1">達成状況コメント</label>
            <textarea value={goalComment} onChange={e => setGoalComment(e.target.value)}
              rows={2}
              className="w-full border border-gray-200 rounded-lg px-2 py-1.5 text-sm outline-none focus:border-emerald-400 resize-none"
              placeholder="例: 屋内移動の自立を維持できている" />
          </div>
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
          goalAchievement={goalAchievement}
          goalComment={goalComment}
          tenantId={tenantId}
          currentOfficeId={currentOfficeId}
          monitoringRecordId={savedId}
          onClose={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
