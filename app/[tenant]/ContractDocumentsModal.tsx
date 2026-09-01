"use client";
import { useState, useEffect } from "react";
import { ChevronLeft, Printer } from "lucide-react";
import { OrderItem, Equipment, Client } from "@/lib/supabase";
import { todayYmd, toJapaneseEra } from "@/lib/date-jst";
import { type CompanyInfo } from "./company-info";
import { saveClientDocument } from "@/lib/documents";
import { CarePlanElement } from "@/lib/supabase";
import { CONTRACT_SECTION_DEFAULTS, RENTAL_CONTRACT_DOC_TYPE, parseContractArticles } from "@/lib/contractTemplateSections";
import { getCarePlanElementsByClient, completeCarePlanElements, describeCarePlanElement, filterElementsForDocType } from "@/lib/carePlanElements";
import { getDocTemplate, type DocTemplateSections } from "@/lib/docTemplates";

// ─── Contract Documents Modal (重要事項説明書 + 契約書) ────────────────────────

export default function ContractDocumentsModal({
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
  const todayStr = todayYmd();
  const [step, setStep] = useState<1 | 2>(1);
  const [explanationDate, setExplanationDate] = useState(todayStr);
  const [contractDate, setContractDate] = useState(todayStr);
  const [benefitRate, setBenefitRate] = useState<"1" | "2" | "3">("1");
  const [saving, setSaving] = useState(false);

  // 発生要因 (rental_contract = new_delivery のみが対象)
  const [elements, setElements] = useState<CarePlanElement[]>([]);
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    getCarePlanElementsByClient(client.id).then((all) => {
      setElements(filterElementsForDocType(all, "rental_contract"));
    });
  }, [client.id]);

  // 文面テンプレート (DB 差し替え分)。fetch 失敗時 (migration 未適用等) は既定文で描画
  const [tplSections, setTplSections] = useState<DocTemplateSections>({});
  useEffect(() => {
    getDocTemplate(tenantId, RENTAL_CONTRACT_DOC_TYPE).then(setTplSections).catch(() => {});
  }, [tenantId]);

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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const burdenLabel = benefitRate === "1" ? "１割" : benefitRate === "2" ? "２割" : "３割";

  // セクション文面 (DB 差し替え or 既定文) + 差込プレースホルダ置換
  const sec = (key: string) =>
    (tplSections[key] ?? CONTRACT_SECTION_DEFAULTS[key] ?? "")
      .split("{契約締結日}").join(contractDateJa)
      .split("{認定有効期限}").join(certEndJa);

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
      // 重要事項説明書 + 契約書 を 1 件に統合保存 (html はプレビュー全体のスナップショット)
      const html = document.getElementById("combined-docs-print")?.innerHTML ?? "";
      const contractDoc = await saveClientDocument({
        tenant_id: tenantId, client_id: client.id,
        type: "contract",
        title: `重要事項説明書兼契約書 ${contractDate}`,
        params: { explanationDate, contractDate, benefitRate, selectedIds: [...selectedIds], selectedElementIds: [...selectedElementIds], html },
      });
      // 選択した発生要因を契約書に紐付けて completed (灰色化、再使用不可)
      if (selectedElementIds.size > 0) {
        await completeCarePlanElements([...selectedElementIds], contractDoc.id);
      }
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
            <button disabled={selectedIds.size === 0 && selectedElementIds.size === 0} onClick={() => setStep(2)}
              className="px-4 py-1.5 bg-emerald-500 text-white text-sm font-medium rounded-xl disabled:opacity-40">
              プレビュー →
            </button>
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
                        // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
                        e.target.checked ? n.add(item.id) : n.delete(item.id);
                        setSelectedIds(n);
                      }} className="accent-blue-500 shrink-0" />
                      <span className="text-sm text-gray-800">{eq?.name ?? item.product_code}</span>
                      {item.rental_start_date && <span className="text-xs text-gray-400">開始 {item.rental_start_date}</span>}
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
                <p style={{ margin: "0 0 4px", fontSize: "7.5pt", whiteSpace: "pre-wrap" }}>{sec("jusetsu_service_area_note")}</p>

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
                <p style={{ margin: "0 0 4px", fontSize: "7.5pt", whiteSpace: "pre-wrap" }}>{sec("jusetsu_holiday_note")}</p>

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
                <p style={{ margin: "0 0 4px", fontSize: "7.5pt", whiteSpace: "pre-wrap" }}>{sec("jusetsu_taiyo_note")}</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>５．サービスの利用方法</h2>
                <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（１）サービスの利用開始</p>
                <p style={{ margin: "0 0 2px", paddingLeft: "2em", whiteSpace: "pre-wrap" }}>{sec("jusetsu_usage_start")}</p>
                <p style={{ margin: "0 0 2px", fontWeight: "bold" }}>　（２）サービスの終了</p>
                <p style={{ margin: "0 0 4px", paddingLeft: "2em", whiteSpace: "pre-wrap" }}>{sec("jusetsu_usage_end")}</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>６．当社の（介護予防）福祉用具貸与の運営の方針</h2>
                <p style={{ margin: "0 0 4px", paddingLeft: "1em", whiteSpace: "pre-wrap" }}>{sec("jusetsu_policy")}</p>

                <h2 style={{ fontSize: "9pt", fontWeight: "bold", margin: "0 0 3px", borderBottom: "1px solid #333", paddingBottom: "1px" }}>７．サービス内容に関する相談･苦情</h2>
                <p style={{ margin: "0 0 2px", paddingLeft: "1em", whiteSpace: "pre-wrap" }}>{sec("jusetsu_complaint_intro")}</p>
                <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "2px", fontSize: "8pt" }}><tbody>
                  <tr>
                    <th style={{ ...TH, width: "80px" }}>事業所名</th><td style={TD}>{companyInfo.companyName}</td>
                    <th style={{ ...TH, width: "80px" }}>電話番号</th><td style={TD}>{companyInfo.tel}</td>
                  </tr>
                  <tr><th style={TH}>受付時間</th><td style={TD} colSpan={3}>{companyInfo.businessHours}（{companyInfo.businessDays}）</td></tr>
                </tbody></table>
                <p style={{ margin: "0 0 2px", whiteSpace: "pre-wrap" }}>{sec("jusetsu_complaint_public")}</p>
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
                  <p style={{ margin: "0 0 2px", whiteSpace: "pre-wrap" }}>{sec("jusetsu_explain_statement")}</p>
                  <p style={{ margin: "0 0 2px" }}>説明日　{explanationDateJa}　　説明者　　　　　　　　　　　　㊞</p>
                  <p style={{ margin: "0 0 1px" }}>事業者　＜住所＞{companyInfo.companyAddress}　＜事業所名＞{companyInfo.companyName}　＜管理者名＞{companyInfo.staffName}　㊞</p>
                </div>
                <div style={{ marginBottom: "4px", fontSize: "7.5pt" }}>
                  <p style={{ margin: "0 0 3px", whiteSpace: "pre-wrap" }}>{sec("jusetsu_confirm_items")}</p>
                </div>
                <div style={{ border: "1px solid #555", padding: "5px 8px", fontSize: "7.5pt" }}>
                  <p style={{ margin: "0 0 2px", whiteSpace: "pre-wrap" }}>{sec("jusetsu_client_statement")}</p>
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

                {parseContractArticles(sec("contract_articles_1_6")).map(({ title, body }, idx) => (
                  <div key={idx} style={{ marginBottom: "5px" }}>
                    <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>{title}</p>
                    <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{body}</p>
                  </div>
                ))}

                {/* 第７条 料金 */}
                <div style={{ marginBottom: "5px" }}>
                  <p style={{ fontWeight: "bold", margin: "0 0 4px" }}>第７条（料金）</p>
                  <p style={{ margin: "0 0 4px", paddingLeft: "1em", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{sec("contract_article_7_terms")}</p>
                  <p style={{ fontWeight: "bold", margin: "0 0 2px", paddingLeft: "1em" }}>（介護予防）福祉用具貸与料金一覧表</p>
                  <p style={{ margin: "0 0 4px", paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt", whiteSpace: "pre-wrap" }}>{sec("contract_fee_note_pre")}</p>
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
                  <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", fontSize: "7.5pt", whiteSpace: "pre-wrap" }}>{sec("contract_fee_note_post")}</p>
                </div>

                {parseContractArticles(sec("contract_articles_8_20")).map(({ title, body }, idx) => (
                  <div key={idx} style={{ marginBottom: "5px" }}>
                    <p style={{ fontWeight: "bold", margin: "0 0 2px" }}>{title}</p>
                    <p style={{ margin: 0, paddingLeft: "1em", lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{body}</p>
                  </div>
                ))}

                <p style={{ margin: "10px 0 8px", lineHeight: "1.6", fontSize: "8pt", whiteSpace: "pre-wrap" }}>
                  {sec("contract_closing")}
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
                  <p style={{ margin: 0, lineHeight: "1.6", whiteSpace: "pre-wrap" }}>{sec("contract_privacy")}</p>
                </div>

              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

