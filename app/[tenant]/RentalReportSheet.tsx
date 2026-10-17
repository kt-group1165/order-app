"use client";
import { OrderItem, Equipment, EquipmentPriceHistory, Client } from "@/lib/supabase";
import { toJapaneseEra, toJapaneseEraYM } from "@/lib/date-jst";
import { type CompanyInfo } from "./company-info";
import { calcMonthUnits, toShortDate, RPT_TD, RPT_TH, RPT_TABLE } from "./order-item-helpers";
import { getPriceForMonth } from "@/lib/equipment";
import { USAGE_TYPE_LABELS, isReportItem, type UsageType } from "@/lib/rentalReport";

// （介護予防）福祉用具貸与提供報告書 の 1 枚。1 人ずつの画面 (RentalReportModal) と
// 毎月の一括作成 (BulkRentalReportModal) で同じものを出す。

export const REQUEST_LABELS = [
  "保険証をお送りください。",
  "介護保険負担割合証をお送り下さい。",
  "上記内容のサービス計画書（1）〜（3）をお送り下さい。",
  "当月分のサービス提供票をお送りください。",
  "この度の変更後のサービス提供票をお送り下さい。",
];

export default function RentalReportSheet({
  id,
  client,
  items,
  orderPaymentMap = {},
  equipment,
  companyInfo,
  priceHistory,
  targetMonth,
  visitDate,
  reportDate,
  usage,
  memo,
  checkedReqs,
  onToggleReq,
  onMemoChange,
  className = "max-w-4xl mx-auto my-6 bg-white shadow-lg px-10 py-8",
}: {
  id?: string;
  client: Client;
  items: OrderItem[];
  orderPaymentMap?: Record<string, "介護" | "自費">;
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  priceHistory: EquipmentPriceHistory[];
  targetMonth: string;
  /** 訪問日 (空なら空欄で出す) */
  visitDate: string;
  /** 報告日 (省略時は訪問日。1 人ずつの画面の従来の出し方) */
  reportDate?: string;
  usage: ReadonlySet<UsageType>;
  memo: string;
  checkedReqs: ReadonlySet<number>;
  /** 渡したときだけ画面上で依頼事項の □ を切り替えられる */
  onToggleReq?: (idx: number) => void;
  /** 渡したときだけ備考を入力できる */
  onMemoChange?: (v: string) => void;
  className?: string;
}) {
  const m1Year = parseInt(targetMonth.split("-")[0]);
  const m1Month = parseInt(targetMonth.split("-")[1]);
  const m2next = new Date(m1Year, m1Month, 1);
  const m2Year = m2next.getFullYear();
  const m2Month = m2next.getMonth() + 1;
  const m2YM = `${m2Year}-${String(m2Month).padStart(2, "0")}`;

  const eqByCode = new Map(equipment.map((e) => [e.product_code, e]));
  const getEq = (code: string) => eqByCode.get(code);
  const histPrice = (code: string, ym: string) => getPriceForMonth(priceHistory, code, ym) ?? undefined;

  const reportItems = items.filter(isReportItem).sort((a, b) => {
    const ca = getEq(a.product_code)?.category ?? "zzz";
    const cb = getEq(b.product_code)?.category ?? "zzz";
    if (ca !== cb) return ca.localeCompare(cb, "ja");
    return (getEq(a.product_code)?.name ?? "").localeCompare(getEq(b.product_code)?.name ?? "", "ja");
  });
  const resolvePayType = (i: OrderItem) => i.payment_type ?? orderPaymentMap[i.order_id] ?? "介護";
  const careItems = reportItems.filter((i) => resolvePayType(i) !== "自費");
  const selfPayItems = reportItems.filter((i) => resolvePayType(i) === "自費");

  const m1Total = careItems.reduce((s, i) => s + (calcMonthUnits(i, m1Year, m1Month, histPrice(i.product_code, targetMonth)) ?? 0), 0);
  const m2Total = careItems.reduce((s, i) => s + (calcMonthUnits(i, m2Year, m2Month, histPrice(i.product_code, m2YM)) ?? 0), 0);

  // 貸与利用項目・訪問日は通常の和暦、表セル内は短縮形式
  const fmtDateFull = (d: string | null | undefined) => (d ? toJapaneseEra(new Date(d + "T00:00:00")) : "");
  const fmtDate = (d: string | null) => (d ? toShortDate(d) : "");

  const EMPTY_CARE = Math.max(0, 8 - careItems.length);
  const EMPTY_SELF = Math.max(0, 4 - selfPayItems.length);

  return (
    <div id={id} className={className}
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
            <span style={{ border: "1px solid #c53030", color: "#c53030", padding: "1px 8px", fontWeight: "bold", minWidth: "90px", minHeight: "1.5em", display: "inline-block" }}>
              {fmtDateFull(reportDate ?? visitDate)}
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
                  usage.has(t) ? (
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
                  {item.rental_end_date && <div>{fmtDate(item.rental_end_date)}&nbsp;解約</div>}
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
                  {item.rental_end_date && <div>{fmtDate(item.rental_end_date)} 解約</div>}
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
                {/* 1 人ずつの画面では従来どおり印刷に □ を出さない (画面で選ぶための印) */}
                <span
                  className={onToggleReq ? "no-print" : undefined}
                  onClick={onToggleReq ? () => onToggleReq(idx) : undefined}
                  style={{ cursor: onToggleReq ? "pointer" : "default", userSelect: "none", fontSize: "14pt", lineHeight: "1" }}
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
          {onMemoChange && (
            <textarea
              value={memo}
              onChange={(e) => onMemoChange(e.target.value)}
              className="no-print w-full border border-gray-300 rounded p-2"
              style={{ height: "90px", fontSize: "9pt", resize: "none" }}
              placeholder="備考欄"
            />
          )}
          {(memo || !onMemoChange) && (
            <p style={{ fontSize: "9pt", borderBottom: "1px solid #aaa", minHeight: "90px", whiteSpace: "pre-wrap" }}>
              {memo}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
