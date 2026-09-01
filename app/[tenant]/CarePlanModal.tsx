"use client";
import { useState, useEffect, useMemo } from "react";
import { ChevronLeft, Printer } from "lucide-react";
import { OrderItem, Equipment, Client } from "@/lib/supabase";
import { todayYmd, toJapaneseEra } from "@/lib/date-jst";
import { type CompanyInfo } from "./company-info";
import { STATUS_LABEL, STATUS_COLOR } from "./order-item-helpers";
import { saveClientDocument } from "@/lib/documents";
import { CarePlanTemplate, CarePlanElement } from "@/lib/supabase";
import { getCarePlanTemplates } from "@/lib/carePlanTemplates";
import { getCarePlanElementsByClient, getCertRenewalVirtuals, completeCarePlanElements, describeCarePlanElement, buildOtherFreeText, isVirtualElement, parseVirtualInsuranceId } from "@/lib/carePlanElements";
import { completeDocTask, insertCertRenewalTask } from "@/lib/docTasks";

// DB の日付文字列 ("1946/4/25" 等) を <input type="date"> 用 "YYYY-MM-DD" に正規化
const toDateInput = (s: string | null | undefined): string => {
  if (!s) return "";
  const m = s.trim().match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})/);
  if (!m) return "";
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
};

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
  monitoringMonths, goalsText, precautionsText,
  planTypeFlags, otherText, TD, TH,
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
  planTypeFlags: { 新規納品: boolean; 追加納品: boolean; 回収: boolean; プラン更新: boolean; プラン変更: boolean; その他: boolean };
  otherText: string;
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
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
      {/* 発生要因チェック (auto fill from selected care_plan_elements) */}
      <table style={{ borderCollapse: "collapse", width: "100%", marginBottom: "3px" }}>
        <tbody>
          <tr>
            {(["新規納品", "追加納品", "回収", "プラン更新", "プラン変更"] as const).map((label) => (
              <td key={label} style={{ ...TD, textAlign: "center", whiteSpace: "nowrap", fontSize: "8pt", padding: "2px 4px" }}>
                <span style={{ display: "inline-block", width: "10px", textAlign: "center", marginRight: "2px" }}>
                  {planTypeFlags[label] ? "☑" : "☐"}
                </span>
                {label}
              </td>
            ))}
            <td style={{ ...TD, fontSize: "8pt", padding: "2px 4px" }}>
              <span style={{ display: "inline-block", width: "10px", textAlign: "center", marginRight: "2px" }}>
                {planTypeFlags.その他 ? "☑" : "☐"}
              </span>
              その他（{otherText || "　　"}）
            </td>
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
                        <div style={{ display: "flex", padding: "2px 6px", borderBottom: "1px dotted #888" }}>
                          <span style={{ flex: 1 }}>種目</span>
                          <span style={{ width: "56px", textAlign: "center", borderLeft: "1px dotted #888", paddingLeft: "6px" }}>単位数</span>
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
                            <div style={{ display: "flex", padding: "2px 6px", borderBottom: "1px dotted #888", fontSize: "7.5pt", color: "#333" }}>
                              <span style={{ flex: 1, overflow: "hidden", fontSize: eq?.category === "認知症徘徊感知機器" ? "6pt" : undefined }}>{eq?.category ?? ""}</span>
                              <span style={{ width: "56px", textAlign: "right", borderLeft: "1px dotted #888", paddingLeft: "6px", whiteSpace: "nowrap" }}>{unitsDisplay}</span>
                            </div>
                            <div style={{ padding: "3px 6px", fontSize: "7pt", whiteSpace: "nowrap", overflow: "hidden" }}>{nameDisplay}</div>
                          </td>
                          <td style={TD}>{eq?.selection_reason ?? ""}</td>
                        </tr>
                      );
                    })}
                    {Array.from({ length: Math.max(0, 10 - pageItems.length) }).map((_, i) => (
                      <tr key={`empty-${i}`}>
                        <td style={TD}></td>
                        <td style={{ ...TD, padding: "0", verticalAlign: "top" }}>
                          <div style={{ display: "flex", padding: "2px 6px", borderBottom: "1px dotted #888", fontSize: "7.5pt", color: "#333" }}>
                            <span style={{ flex: 1, overflow: "hidden" }}>&nbsp;</span>
                            <span style={{ width: "56px", borderLeft: "1px dotted #888", paddingLeft: "6px", whiteSpace: "nowrap" }}>&nbsp;</span>
                          </div>
                          <div style={{ padding: "3px 6px", fontSize: "7pt", whiteSpace: "nowrap", overflow: "hidden" }}>&nbsp;</div>
                        </td>
                        <td style={TD}></td>
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

export default function CarePlanModal({
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

  // 発生要因 (care_plan_elements) - 計画書冒頭チェック 6 種の駆動元
  const [elements, setElements] = useState<CarePlanElement[]>([]);
  const [selectedElementIds, setSelectedElementIds] = useState<Set<string>>(
    () => new Set((initialParams?.selectedElementIds as string[]) ?? []),
  );

  const [creationDate, setCreationDate] = useState((initialParams?.creationDate as string) ?? todayStr);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const [gender, setGender] = useState((initialParams?.gender as string) ?? client.gender ?? "");
  const [birthDate, setBirthDate] = useState((initialParams?.birthDate as string) ?? toDateInput(client.birth_date));
  const [certStartDate, setCertStartDate] = useState((initialParams?.certStartDate as string) ?? toDateInput(client.certification_start_date));
  const [consultantName, setConsultantName] = useState((initialParams?.consultantName as string) ?? "");
  const [consultantRelation, setConsultantRelation] = useState((initialParams?.consultantRelation as string) ?? "");
  const [consultationDate, setConsultationDate] = useState((initialParams?.consultationDate as string) ?? todayStr);
  const [monitoringMonths, setMonitoringMonths] = useState((initialParams?.monitoringMonths as string) ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => { getCarePlanTemplates(tenantId).then(setTemplates); }, [tenantId]);
  useEffect(() => {
    const load = async () => {
      const [els, virts] = await Promise.all([
        getCarePlanElementsByClient(client.id),
        client.office_id
          ? getCertRenewalVirtuals(client.id, tenantId, client.office_id)
          : Promise.resolve([] as CarePlanElement[]),
      ]);
      const merged = [...virts, ...els].sort((a, b) => {
        if (a.occurred_at !== b.occurred_at) return b.occurred_at.localeCompare(a.occurred_at);
        return a.created_at.localeCompare(b.created_at);
      });
      setElements(merged);
    };
    load();
  }, [client.id, client.office_id, tenantId]);

  // 選択中の要素から計画書冒頭 6 種チェックの ON 状態を導出 (auto fill)
  const planTypeFlags = useMemo(() => {
    const flags = { 新規納品: false, 追加納品: false, 回収: false, プラン更新: false, プラン変更: false, その他: false };
    for (const e of elements) {
      if (!selectedElementIds.has(e.id)) continue;
      if (e.element_type === "new_delivery") flags.新規納品 = true;
      else if (e.element_type === "additional_delivery") flags.追加納品 = true;
      else if (e.element_type === "pickup") flags.回収 = true;
      else if (e.element_type === "plan_renewal") flags.プラン更新 = true;
      else if (e.element_type === "plan_change") flags.プラン変更 = true;
      else if (e.element_type === "care_office_change") flags.その他 = true;
    }
    return flags;
  }, [elements, selectedElementIds]);

  const otherText = useMemo(() => {
    const selectedEls = elements.filter((e) => selectedElementIds.has(e.id));
    return buildOtherFreeText(selectedEls);
  }, [elements, selectedElementIds]);

  // 要素 check 時に用具系なら selectedIds / changeTypes を自動同期
  const toggleElement = (el: CarePlanElement, checked: boolean) => {
    setSelectedElementIds((prev) => {
      const n = new Set(prev);
      if (checked) n.add(el.id); else n.delete(el.id);
      return n;
    });
    // 用具系要素 (ref_table='order_items') は対応 item を auto 選択
    if (el.ref_table === "order_items") {
      const label = el.element_type === "new_delivery" ? "新規納品"
        : el.element_type === "additional_delivery" ? "追加納品"
        : el.element_type === "pickup" ? "回収" : null;
      if (label) {
        if (checked) {
          setSelectedIds((prev) => new Set(prev).add(el.ref_id));
          setChangeTypes((p) => ({ ...p, [el.ref_id]: label }));
        } else {
          setSelectedIds((prev) => { const n = new Set(prev); n.delete(el.ref_id); return n; });
        }
      }
    }
  };

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
      const saved = await saveClientDocument({
        tenant_id: tenantId, client_id: client.id, type: "care_plan",
        title: `個別援助計画書 ${creationDate}`,
        params: { creationDate, selectedIds: [...selectedIds], changeTypes, gender, birthDate, certStartDate, consultantName, consultantRelation, consultationDate, monitoringMonths, selectedElementIds: [...selectedElementIds], planTypeFlags, otherText },
      });
      // 仮想 cert_renewal は doc_tasks に実体化 → 完了マーク (バナー連携)
      const allIds = [...selectedElementIds];
      const virtualIds = allIds.filter(isVirtualElement);
      const realIds = allIds.filter((id) => !isVirtualElement(id));
      for (const vid of virtualIds) {
        const insId = parseVirtualInsuranceId(vid);
        const ve = elements.find((e) => e.id === vid);
        if (!insId || !ve || !client.office_id) continue;
        const task = await insertCertRenewalTask({
          tenantId,
          officeId: client.office_id,
          clientId: client.id,
          insuranceRecordId: insId,
          certEndDate: ve.occurred_at,
          expectedDocType: "care_plan",
        });
        if (task) await completeDocTask(task.id, saved.id);
      }
      // 実要素 → care_plan_elements を completed にして紐付け (灰色化、再使用不可)
      if (realIds.length > 0) {
        await completeCarePlanElements(realIds, saved.id);
      }
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
          <div className="flex-1 overflow-y-auto p-4 space-y-4 [&>*]:max-w-4xl [&>*]:mx-auto">
            <div>
              <h3 className="text-xs font-semibold text-gray-500 mb-2">発生要因（該当する項目をチェック）</h3>
              {elements.length === 0 ? (
                <p className="text-sm text-gray-400">発生要因はまだ記録されていません</p>
              ) : (
                <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-100">
                  {elements.map((el, idx) => {
                    const completed = el.status === "completed";
                    const checked = selectedElementIds.has(el.id);
                    return (
                      <label key={el.id} className={`flex items-center gap-2 px-3 py-2 ${completed ? "opacity-40" : "cursor-pointer hover:bg-gray-50"}`}>
                        <input type="checkbox" checked={checked} disabled={completed}
                          onChange={(e) => toggleElement(el, e.target.checked)}
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
                          // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
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
              <div className="grid grid-cols-2 gap-3">
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
              planTypeFlags={planTypeFlags}
              otherText={otherText}
              TD={TD}
              TH={TH}
            />
          </div>
        )}
      </div>
    </div>
  );
}

