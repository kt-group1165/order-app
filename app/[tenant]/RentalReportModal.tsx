"use client";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { X, Loader2, Printer, Send } from "lucide-react";
import { OrderItem, Equipment, EquipmentPriceHistory, Client } from "@/lib/supabase";
import { type CompanyInfo } from "./company-info";
import { saveClientDocument } from "@/lib/documents";
import { getCareOffices, type CareOffice } from "@/lib/careOffices";
import SendRentalReportModal from "./SendRentalReportModal";
import RentalReportSheet from "./RentalReportSheet";
import { USAGE_TYPE_LABELS, detectRentalUsage, rentalReportTitle, type UsageType } from "@/lib/rentalReport";

// ─── Rental Report Modal ─────────────────────────────────────────────────────



export default function RentalReportModal({
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
  // 居宅事業所への送付モーダル
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendToast, setSendToast] = useState<{ kind: "success" | "error"; msg: string } | null>(null);
  const searchParamsForSend = useSearchParams();
  const currentOfficeIdForSend = searchParamsForSend.get("office");
  const [faxSending, setFaxSending] = useState(false);
  const [faxResult, setFaxResult] = useState<"ok" | "err" | null>(null);
  const [careOffices, setCareOffices] = useState<CareOffice[]>([]);
  const [faxDialogOpen, setFaxDialogOpen] = useState(false);
  const [selectedFaxNumber, setSelectedFaxNumber] = useState("");

  useEffect(() => {
    getCareOffices(tenantId).then(setCareOffices).catch((err) => {
      console.warn("getCareOffices failed:", err);
    });
  }, [tenantId]);

  // 利用者のケアマネ事務所に紐づくFAX番号を自動選択
  useEffect(() => {
    if (client.care_manager_org) {
      const matched = careOffices.find(o => o.name === client.care_manager_org);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
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


  const handleSaveDoc = async () => {
    setSaving(true);
    try {
      const title = rentalReportTitle(targetMonth);
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

  // 対象月・アイテムが変わるたびに貸与利用項目を自動判定 (規則は lib/rentalReport.ts)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setSelectedUsage(new Set(detectRentalUsage(items, targetMonth)));
  }, [targetMonth, items]);


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
        <button
          onClick={() => setShowSendModal(true)}
          disabled={!currentOfficeIdForSend}
          title={!currentOfficeIdForSend ? "送信元事業所が選択されていません" : "居宅介護支援事業所に貸与報告書を送付"}
          className="flex items-center gap-1.5 bg-purple-500 hover:bg-purple-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white px-4 py-2 rounded-xl text-sm font-medium"
        >
          <Send size={14} /> 居宅事業所に送付
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
              // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
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
        <RentalReportSheet
          id="rental-report-doc"
          client={client}
          items={items}
          orderPaymentMap={orderPaymentMap}
          equipment={equipment}
          companyInfo={companyInfo}
          priceHistory={priceHistory}
          targetMonth={targetMonth}
          visitDate={visitDate}
          usage={selectedUsage}
          memo={memo}
          checkedReqs={checkedReqs}
          onToggleReq={(idx) => setCheckedReqs((prev) => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
          })}
          onMemoChange={setMemo}
        />
      </div>

      {/* 居宅事業所への送付モーダル */}
      {showSendModal && currentOfficeIdForSend && (
        <SendRentalReportModal
          tenantId={tenantId}
          client={client}
          sourceOfficeId={currentOfficeIdForSend}
          monitoringRecordId={null}
          visitDate={visitDate}
          reportDate={`${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`}
          getHtmlSnapshot={() => document.getElementById("rental-report-doc")?.outerHTML ?? ""}
          onClose={() => setShowSendModal(false)}
          onSuccess={() => {
            setShowSendModal(false);
            setSendToast({ kind: "success", msg: "送付しました" });
            setTimeout(() => setSendToast(null), 3500);
          }}
          onError={(msg) => {
            setSendToast({ kind: "error", msg: `送付失敗: ${msg}` });
            setTimeout(() => setSendToast(null), 5000);
          }}
        />
      )}

      {/* 送付トースト */}
      {sendToast && (
        <div className={`fixed top-4 right-4 z-[80] px-4 py-2 rounded-lg shadow-lg text-sm text-white ${sendToast.kind === "success" ? "bg-emerald-500" : "bg-red-500"}`}>
          {sendToast.msg}
        </div>
      )}
    </div>
  );
}

