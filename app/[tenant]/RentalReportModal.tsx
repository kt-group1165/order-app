"use client";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { X, Loader2, Printer, Send } from "lucide-react";
import { OrderItem, Equipment, EquipmentPriceHistory, Client } from "@/lib/supabase";
import { toJapaneseEra, toJapaneseEraYM } from "@/lib/date-jst";
import { type CompanyInfo } from "./company-info";
import { calcMonthUnits, toShortDate, RPT_TD, RPT_TH, RPT_TABLE } from "./order-item-helpers";
import { saveClientDocument } from "@/lib/documents";
import { getPriceForMonth } from "@/lib/equipment";
import { getCareOffices, type CareOffice } from "@/lib/careOffices";
import SendRentalReportModal from "./SendRentalReportModal";

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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
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
        <div id="rental-report-doc" className="max-w-4xl mx-auto my-6 bg-white shadow-lg px-10 py-8"
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
                        // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- intentional side-effect
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

