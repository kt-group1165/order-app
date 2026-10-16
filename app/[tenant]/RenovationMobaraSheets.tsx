"use client";

// 茂原市の受領委任払いに付ける書類 (A4 縦)。申請書 (別記第34号様式) は受領委任でも同じで、これを別に付ける。
//   ① 福祉用具購入費・住宅改修費受領委任届 (第２号様式 (第２条))
//   ② 委任状 (支給決定額の受領に関する権限の委任)
// 出どころ: 茂原市 https://www.city.mobara.chiba.jp/cmsfiles/contents/0000005/5898/jyuutakukaisyuu.pdf
//   (申請書一式の 3 頁目・6 頁目。2026-10-16 取得)
// 受任者 = 自社 (発行元タブの会社名・代表者・住所・口座)、委任者 = 被保険者。署名・押印は手書き。

import type { CSSProperties } from "react";
import { Sheet, type DocSheetProps } from "./RenovationDocSheets";
import { RENOVATION_KINDS, toWareki, warekiLabel, yenNum } from "@/lib/renovationDocs";

const B = "1px solid #000";
const cell: CSSProperties = { border: B, padding: "1.2mm 2mm", verticalAlign: "middle" };
const th: CSSProperties = { ...cell, textAlign: "center", width: "26mm", fontWeight: "normal" };
const digit: CSSProperties = { border: B, width: "5.2mm", height: "6.5mm", textAlign: "center", padding: 0 };

function Digits({ value, count, shade = 0 }: { value: string; count: number; shade?: number }) {
  const chars = Array.from(value.padEnd(count, " ")).slice(0, count);
  return (
    <table style={{ borderCollapse: "collapse", display: "inline-table" }}>
      <tbody>
        <tr>
          {shade > 0 && <td style={{ ...digit, width: `${5.2 * shade}mm`, background: "#ccc" }} />}
          {chars.map((c, i) => <td key={i} style={digit}>{c.trim()}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

const blankDate = "　　　年　　　月　　　日";

/** 受領委任届 (第２号様式) */
export function MobaraJuryoTodokeSheet({ docs, project, client, totals, receiptAmount }: DocSheetProps) {
  const iss = docs.issuer;
  const birth = toWareki(client?.birth_date);
  const gender = client?.gender?.startsWith("男") ? "男" : client?.gender?.startsWith("女") ? "女" : null;
  const address = client?.address ?? project.client_address ?? "";
  const phone = client?.phone || (client as unknown as { mobile?: string | null } | null)?.mobile || "";
  const kinds = Array.from(new Set(docs.estimate.groups.map((g) => g.kind))).sort();
  const places = docs.estimate.groups.map((g) => [g.place, g.part].filter(Boolean).join(" ")).filter(Boolean);
  const circle = (on: boolean): CSSProperties | undefined => (on ? { border: B, borderRadius: "50%", padding: "0 1mm" } : undefined);
  return (
    <Sheet>
      <div style={{ fontSize: "9pt", marginTop: "6mm" }}>第２号様式（第２条）</div>
      <div style={{ textAlign: "center", fontSize: "13pt", fontWeight: "bold", margin: "5mm 0 4mm" }}>福祉用具購入費・住宅改修費受領委任届</div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <tr>
            <td style={{ ...th, fontSize: "8pt" }}>ﾌ ﾘ ｶﾞ ﾅ</td>
            <td style={{ ...cell, fontSize: "8.5pt" }}>{client?.furigana ?? ""}</td>
            <td style={th}>保険者番号</td>
            <td style={cell}><Digits value={client?.insurer_number ?? ""} count={6} shade={2} /></td>
          </tr>
          <tr>
            <td style={th}>被保険者氏名</td>
            <td style={{ ...cell, fontSize: "12pt", height: "9mm" }}>{client?.name ?? project.client_name}</td>
            <td style={th}>被保険者番号</td>
            <td style={cell}><Digits value={client?.insured_number ?? ""} count={10} /></td>
          </tr>
          <tr>
            <td style={th}>生年月日</td>
            <td style={cell}>
              <span style={circle(birth?.era === "明治")}>明治</span>・<span style={circle(birth?.era === "大正")}>大正</span>・<span style={circle(birth?.era === "昭和")}>昭和</span>
              　{birth ? `${birth.year}年　${birth.month}月　${birth.day}日` : "　　年　　月　　日"}
            </td>
            <td style={th}>性　別</td>
            <td style={{ ...cell, textAlign: "center" }}>
              <span style={circle(gender === "男")}>男</span>　・　<span style={circle(gender === "女")}>女</span>
            </td>
          </tr>
          <tr>
            <td style={th}>住　　所</td>
            <td style={{ ...cell, height: "13mm" }} colSpan={3}>
              {address}<span style={{ float: "right", marginTop: "5mm" }}>電話番号　{phone}</span>
            </td>
          </tr>
          <tr>
            <td style={th} rowSpan={2}>給付の種類<br />（具体的に）</td>
            <td style={{ ...cell, textAlign: "center", fontWeight: "bold" }}>特定福祉用具の購入品目</td>
            <td style={{ ...cell, textAlign: "center", fontWeight: "bold" }} colSpan={2}>住宅改修の内容</td>
          </tr>
          <tr>
            <td style={{ ...cell, height: "20mm" }} />
            <td style={{ ...cell, verticalAlign: "top", fontSize: "8.5pt" }} colSpan={2}>
              {kinds.map((k) => <div key={k}>（{k}）{RENOVATION_KINDS.find((x) => x.no === k)?.label}</div>)}
              {places.length > 0 && <div>箇所：{places.join("、")}</div>}
            </td>
          </tr>
          <tr>
            <td style={{ ...th, borderTop: "2.5px solid #000" }}>費用額合計</td>
            <td style={{ ...cell, borderTop: "2.5px solid #000" }} colSpan={3}>
              <span style={{ marginLeft: "30mm" }}>{yenNum(totals.grandTotal)}　円</span>
              <span style={{ marginLeft: "10mm" }}>（うち被保険者負担分　{yenNum(receiptAmount)}　円）</span>
            </td>
          </tr>
        </tbody>
      </table>

      <div style={{ margin: "8mm 0 0 8mm", fontSize: "11pt", letterSpacing: "0.4em" }}>茂原市長　様</div>
      <div style={{ margin: "5mm 0", lineHeight: 1.7, textIndent: "1em" }}>
        上記の介護保険給付につきましては、茂原市介護保険福祉用具購入費及び住宅改修費の支給に係る受領委任払いに関する要綱第２条第２項の規定により、当該保険給付の申請及び保険給付費の受領を下記の者に委任します。
      </div>
      <div style={{ marginLeft: "25mm" }}>{docs.application.apply_date ? warekiLabel(docs.application.apply_date) : blankDate}</div>
      <div style={{ marginLeft: "25mm", marginTop: "4mm", lineHeight: 2.6 }}>
        <div>委 任 者　　住　所　{address}</div>
        <div style={{ paddingLeft: "17mm" }}>氏　名　{client?.name ?? project.client_name}</div>
      </div>

      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "5mm" }}>
        <tbody>
          <tr>
            <td style={{ ...th, fontSize: "8.5pt" }}>受任者の氏名<br />又は事業者名<br /><span style={{ fontSize: "7pt" }}>及び代表者氏名</span></td>
            <td style={{ ...cell, height: "17mm" }} colSpan={4}>
              <div>{iss.company_name}　{iss.office_name}</div>
              <div>{iss.representative ? `代表者　${iss.representative}` : ""}</div>
            </td>
          </tr>
          <tr>
            <td style={th}>受任者住所</td>
            <td style={{ ...cell, height: "13mm" }} colSpan={4}>
              {iss.postal_code ? `〒${iss.postal_code}　` : ""}{iss.address}
              <span style={{ float: "right", marginTop: "5mm" }}>電話番号　{iss.tel}</span>
            </td>
          </tr>
          <tr>
            <td style={{ ...th, fontSize: "8.5pt" }} rowSpan={2}>口座振替依頼書</td>
            <td style={{ ...cell, fontSize: "8.5pt", width: "36mm" }}>{iss.bank_name || <span style={{ color: "#666" }}>銀行・信用金庫<br />信用組合・農協</span>}</td>
            <td style={{ ...cell, fontSize: "8.5pt", width: "30mm" }}>{iss.bank_branch || <span style={{ color: "#666" }}>本店（所）・支店（所）<br />出張所</span>}</td>
            <td style={{ ...cell, fontSize: "8pt", width: "24mm" }}>
              {["普通預金", "当座預金", "その他"].map((t, i) => (
                <div key={t}><span style={circle(iss.bank_type !== "" && t.startsWith(iss.bank_type))}>{i + 1}</span>　{t}</div>
              ))}
            </td>
            <td style={cell}>
              <div style={{ fontSize: "8pt", textAlign: "center" }}>口座番号</div>
              <Digits value={iss.bank_number.replace(/\D/g, "")} count={7} />
            </td>
          </tr>
          <tr>
            <td style={{ ...cell, fontSize: "8.5pt" }}>
              <div style={{ fontSize: "7pt" }}>ﾌ ﾘ ｶﾞ ﾅ</div>
              <div>口座名義人</div>
            </td>
            <td style={cell} colSpan={3}>
              <div style={{ fontSize: "8pt", borderBottom: "1px dotted #000" }}>{iss.bank_holder_kana}</div>
              <div>{iss.bank_holder}</div>
            </td>
          </tr>
        </tbody>
      </table>
      <div style={{ fontSize: "7.5pt", fontWeight: "bold", marginTop: "2mm" }}>
        ※保険料が未納となっている方で、支払方法の変更により償還払い給付となっている場合は、受領委任による給付はできません
      </div>
    </Sheet>
  );
}

/** 委任状 (支給決定額の受領) */
export function MobaraIninjoSheet({ docs, project, client }: DocSheetProps) {
  const iss = docs.issuer;
  const address = client?.address ?? project.client_address ?? "";
  const applyDate = toWareki(docs.application.apply_date);
  const line: CSSProperties = { display: "inline-block", minWidth: "100mm", borderBottom: B, paddingLeft: "2mm" };
  return (
    <Sheet>
      <div style={{ textAlign: "center", fontSize: "16pt", fontWeight: "bold", letterSpacing: "1.2em", margin: "14mm 0 14mm" }}>委任状</div>
      <div style={{ marginLeft: "8mm", lineHeight: 3 }}>
        <div>受　任　者</div>
        <div style={{ marginLeft: "8mm" }}>住　所　<span style={line}>{iss.postal_code ? `〒${iss.postal_code}　` : ""}{iss.address}</span></div>
        <div style={{ marginLeft: "8mm" }}>
          氏　名　<span style={line}>{iss.company_name}　{iss.office_name}{iss.representative ? `　代表者 ${iss.representative}` : ""}</span>
        </div>
      </div>
      <div style={{ margin: "28mm 4mm 0", lineHeight: 1.8, textIndent: "1em" }}>
        {applyDate ? `${applyDate.era}${applyDate.year}年${applyDate.month}月${applyDate.day}日` : "令和　　年　　月　　日"}
        介護保険居宅介護（介護予防）住宅改修費支給申請に係る支給決定額の受領に関する一切の権限を上記の者に委任します。
      </div>
      <div style={{ textAlign: "right", margin: "24mm 4mm 0" }}>
        {docs.application.apply_date ? warekiLabel(docs.application.apply_date) : "令和　　年　　月　　日"}
      </div>
      <div style={{ marginLeft: "60mm", marginTop: "22mm", lineHeight: 3 }}>
        <div>委　任　者</div>
        <div style={{ marginLeft: "4mm" }}>住　所　<span style={{ ...line, minWidth: "90mm" }}>{address}</span></div>
        <div style={{ marginLeft: "4mm" }}>氏　名　<span style={{ ...line, minWidth: "90mm" }}>{client?.name ?? project.client_name}</span></div>
      </div>
    </Sheet>
  );
}
