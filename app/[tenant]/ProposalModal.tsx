"use client";
import { useState, useEffect, Fragment } from "react";
import { ChevronLeft, Printer } from "lucide-react";
import { OrderItem, Equipment, Client } from "@/lib/supabase";
import { todayYmd, toJapaneseEra } from "@/lib/date-jst";
import { type CompanyInfo } from "./company-info";
import { STATUS_LABEL, STATUS_COLOR } from "./order-item-helpers";
import { saveClientDocument } from "@/lib/documents";
import { CarePlanElement } from "@/lib/supabase";
import { getCarePlanElementsByClient, completeCarePlanElements, describeCarePlanElement, filterElementsForDocType } from "@/lib/carePlanElements";

// ─── Proposal Modal ──────────────────────────────────────────────────────────

export default function ProposalModal({
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
  const todayStr = todayYmd();
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

  // 発生要因 (proposal = new_delivery / additional_delivery / plan_change)
  const [elements, setElements] = useState<CarePlanElement[]>([]);
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(
    () => new Set((initialParams?.selectedElementIds as string[]) ?? []),
  );
  useEffect(() => {
    getCarePlanElementsByClient(client.id).then((all) => {
      setElements(filterElementsForDocType(all, "proposal"));
    });
  }, [client.id]);

  const selectedItems = selectableItems.filter((i) => selectedIds.has(i.id));
  const getEq = (code: string) => equipment.find((e) => e.product_code === code);

  const handlePrint = () => {
    const el = document.getElementById("proposal-print-content");
    if (!el) return;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>選定提案書</title><style>
      body{font-family:'Meiryo','MS PGothic',sans-serif;font-size:9pt;margin:0;padding:0;color:#000}
      @page{size:A4 portrait;margin:10mm}
      table{border-collapse:collapse;width:100%}
      td,th{border:1px solid #555;padding:2px 4px;vertical-align:middle}
      #proposal-print-content{width:190mm;padding:0;margin:0 auto;box-shadow:none}
    </style></head><body>${el.innerHTML}</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await saveClientDocument({
        tenant_id: tenantId, client_id: client.id, type: "proposal",
        title: `選定提案書 ${creationDate}`,
        params: { creationDate, selectedIds: [...selectedIds], selectedElementIds: [...selectedElementIds] },
      });
      if (selectedElementIds.size > 0) {
        await completeCarePlanElements([...selectedElementIds], saved.id);
      }
      onSaved?.();
    } finally { setSaving(false); }
  };

  const TD: React.CSSProperties = { border: "1px solid #555", padding: "2px 5px", verticalAlign: "middle" as const, fontSize: "8.5pt" };
  const TH: React.CSSProperties = { border: "1px solid #555", background: "#eee", padding: "2px 5px", textAlign: "center" as const, whiteSpace: "nowrap" as const, verticalAlign: "middle" as const, fontSize: "8.5pt", fontWeight: "bold" as const };

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
              disabled={selectedIds.size === 0 && selectedElementIds.size === 0}
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
          <div className="flex-1 overflow-y-auto p-4 space-y-4 [&>*]:max-w-4xl [&>*]:mx-auto">
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
                            // 用具系要素 → 対応 item を selectedIds にも auto 反映
                            if (el.ref_table === "order_items") {
                              if (e.target.checked) {
                                setSelectedIds((prev) => new Set(prev).add(el.ref_id));
                              } else {
                                setSelectedIds((prev) => { const n = new Set(prev); n.delete(el.ref_id); return n; });
                              }
                            }
                          }}
                          className="accent-blue-500 shrink-0" />
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
                          // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
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
            <div id="proposal-print-content" className="bg-white mx-auto shadow"
              style={{
                fontFamily: "'Meiryo','MS PGothic',sans-serif",
                fontSize: "9pt",
                color: "#000",
                width: "190mm",
                minHeight: "277mm",
                padding: "0",
                display: "flex",
                flexDirection: "column" as const,
              }}>
              <p style={{ fontSize: "15pt", fontWeight: "bold", textAlign: "center", letterSpacing: "0.3em", margin: "0 0 6px" }}>選定提案書</p>
              <table style={{ borderCollapse: "collapse" as const, width: "100%", marginBottom: "4px", fontSize: "9pt" }}>
                <tbody>
                  <tr>
                    <td style={{ border: "none", width: "50%", padding: "1px 0" }}>作成日：{creationDate ? toJapaneseEra(new Date(creationDate + "T00:00:00")) : "　　年　月　日"}</td>
                    <td style={{ border: "none", textAlign: "right" as const, padding: "1px 0" }}>担当者：{companyInfo.staffName}</td>
                  </tr>
                  <tr>
                    <td style={{ border: "none", padding: "1px 0" }}>事業所名：{companyInfo.companyName}</td>
                    <td style={{ border: "none", textAlign: "right" as const, padding: "1px 0" }}>事業所番号：{companyInfo.businessNumber}</td>
                  </tr>
                </tbody>
              </table>
              <table style={{ borderCollapse: "collapse" as const, width: "100%", marginBottom: "6px", tableLayout: "fixed" as const }}>
                <colgroup>
                  <col style={{ width: "22%" }} />
                  <col style={{ width: "30%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "30%" }} />
                </colgroup>
                <tbody>
                  <tr>
                    <th style={TH}>利用者氏名</th>
                    <td style={TD}>{client.name}　様</td>
                    <th style={TH}>フリガナ</th>
                    <td style={TD}>{client.furigana ?? ""}</td>
                  </tr>
                  <tr>
                    <th style={TH}>介護度</th>
                    <td style={TD}>{client.care_level ?? ""}</td>
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
              <p style={{ fontWeight: "bold", margin: "4px 0 3px", fontSize: "9.5pt" }}>【貸与を提案する福祉用具】</p>
              <table style={{ borderCollapse: "collapse" as const, width: "100%", marginBottom: "6px", tableLayout: "fixed" as const }}>
                <colgroup>
                  <col style={{ width: "26px" }} />
                  <col style={{ width: "78px" }} />
                  <col style={{ width: "33%" }} />
                  <col />
                  <col style={{ width: "44px" }} />
                </colgroup>
                <thead>
                  <tr>
                    {["No", "種目名・貸与価格", "商品名", "提案する理由", "採　否"].map((h) => (
                      <th key={h} style={TH}>{h}</th>
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
                          <td style={{ ...TD, verticalAlign: "top" as const, fontSize: "8pt" }} rowSpan={rowspan}>
                            <p style={{ margin: 0 }}>{eq?.category ?? ""}</p>
                            {price && <p style={{ margin: "1px 0 0", fontSize: "7.5pt", color: "#555" }}>¥{price.toLocaleString()}/月</p>}
                          </td>
                          <td style={{ ...TD, fontWeight: "bold", wordBreak: "break-all" as const }}>◎ {eq?.name ?? item.product_code}</td>
                          <td style={{ ...TD, fontSize: "8pt", wordBreak: "break-all" as const }}>{eq?.proposal_reason ?? eq?.selection_reason ?? ""}</td>
                          <td style={{ ...TD, textAlign: "center" as const, fontSize: "8pt" }}>採　否</td>
                        </tr>
                        {compCodes.map((compCode) => {
                          const compEq = equipment.find((e) => e.product_code === compCode);
                          if (!compEq) return null;
                          return (
                            <tr key={compCode}>
                              <td style={{ ...TD, wordBreak: "break-all" as const }}>{compEq.name}</td>
                              <td style={{ ...TD, fontSize: "8pt", wordBreak: "break-all" as const }}>{compEq.selection_reason ?? ""}</td>
                              <td style={{ ...TD, textAlign: "center" as const, fontSize: "8pt" }}>採　否</td>
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
                    // 8 行まで空行で埋め、紙面のバランスを取る
                    return Array.from({ length: Math.max(0, 8 - totalRows) }).map((_, i) => (
                      <tr key={`empty-${i}`} style={{ height: "26px" }}>
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
              <p style={{ margin: "8px 0 0", fontSize: "9pt" }}>以上、福祉用具選定提案書に基づき、商品のご提案を致しました。</p>
              <div style={{ marginTop: "auto" }}>
                <div style={{ fontSize: "8.5pt", marginTop: "12px", borderTop: "1px solid #999", paddingTop: "5px", lineHeight: 1.5 }}>
                  <div>法人名称：{companyInfo.companyName}</div>
                  <div>住　　所：{companyInfo.companyAddress}　TEL：{companyInfo.tel}　FAX：{companyInfo.fax}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

