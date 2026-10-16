"use client";

// 市原市の受領委任払い 事前協議願 (第６号様式 (第10条)・A4 縦)。
// 市原市の受領委任払い用の支給申請書は事後専用で、着工前は受領委任払い登録事業者がこれを出す
// (市原市介護保険住宅改修費の支給に係る受領委任払いに関する要綱 第10条)。
// 出どころ: 市原市 介護保険各種様式ダウンロード jizen_kyougi_negai.pdf / 記載例 (2026-10-15 取得)
// 届出者 = 自社 (発行元タブの住所・会社名・代表者)。

import type { CSSProperties } from "react";
import { Sheet, type DocSheetProps } from "./RenovationDocSheets";
import { RENOVATION_KINDS, toWareki, warekiLabel, yenNum } from "@/lib/renovationDocs";

const B = "1px solid #000";
const cell: CSSProperties = { border: B, padding: "1.2mm 2mm", verticalAlign: "middle" };
const th: CSSProperties = { ...cell, textAlign: "center", width: "30mm", fontWeight: "normal", letterSpacing: "0.3em" };
const digit: CSSProperties = { border: B, width: "6mm", height: "7mm", textAlign: "center", padding: 0 };

function Digits({ value, count, shade = 0 }: { value: string; count: number; shade?: number }) {
  const chars = Array.from(value.padEnd(count, " ")).slice(0, count);
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <tbody>
        <tr>
          {shade > 0 && <td style={{ ...digit, width: `${6 * shade}mm`, background: "#ccc" }} />}
          {chars.map((c, i) => <td key={i} style={digit}>{c.trim()}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

/** 様式の 6 区分の表記 (市原市の様式どおり。見積書の区分名とは少し違う) */
const KIND_LABELS: Record<number, string> = {
  1: "手すりの取り付け",
  2: "段差の解消",
  3: "滑りの防止および移動の円滑化等のための床又は通路面の材料の変更",
  4: "引き戸等への扉の取替え",
  5: "洋式便器等への便器の取替え",
  6: "その他１から５の住宅改修に付帯して必要となる住宅改修",
};

export function IchiharaJizenKyogiSheet({ docs, project, client, totals }: DocSheetProps) {
  const iss = docs.issuer;
  const birth = toWareki(client?.birth_date);
  const vendor = [iss.company_name, iss.office_name].filter(Boolean).join("　");
  // 区分ごとの改修場所 (見積の改修箇所をまとめる)
  const placesByKind = new Map<number, string[]>();
  for (const g of docs.estimate.groups) {
    const place = [g.place, g.part].filter(Boolean).join(" ");
    const list = placesByKind.get(g.kind) ?? [];
    if (place && !list.includes(place)) list.push(place);
    placesByKind.set(g.kind, list);
  }
  const circle = (on: boolean): CSSProperties | undefined => (on ? { border: B, padding: "0 0.8mm" } : undefined);
  return (
    <Sheet>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "9pt", marginTop: "4mm" }}>
        <span>第６号様式（第10条）</span>
      </div>
      <div style={{ textAlign: "right" }}>{docs.application.apply_date ? warekiLabel(docs.application.apply_date) : "　　年　　月　　日"}</div>
      <div style={{ marginTop: "3mm" }}>（あて先）市原市長</div>
      <div style={{ marginLeft: "100mm", marginTop: "2mm", lineHeight: 1.7 }}>
        <div>住　所　{iss.address}</div>
        <div>氏　名　{iss.company_name}{iss.office_name ? `　${iss.office_name}` : ""}</div>
        {iss.representative && <div style={{ paddingLeft: "13mm" }}>代表者　{iss.representative}</div>}
      </div>
      <div style={{ textAlign: "center", fontSize: "12pt", letterSpacing: "0.5em", margin: "6mm 0 2mm" }}>事前協議願</div>
      <div style={{ textIndent: "1em", lineHeight: 1.6 }}>
        下記のとおり受領委任払いに係る住宅改修費について、協議をしたいので、市原市介護保険住宅改修費の支給に係る受領委任払いに関する要綱第１０条の規定により提出します。
      </div>
      <div style={{ textAlign: "center", margin: "1mm 0" }}>記</div>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <tr>
            <td style={th}>フリガナ</td>
            <td style={{ ...cell, textAlign: "center" }}>{client?.furigana ?? ""}</td>
            <td style={{ ...th, width: "28mm" }}>保険者番号</td>
            <td style={{ ...cell, padding: 0, width: "62mm" }}><Digits value={client?.insurer_number ?? ""} count={6} shade={4} /></td>
          </tr>
          <tr>
            <td style={th} rowSpan={2}>被保険者氏名</td>
            <td style={{ ...cell, textAlign: "center", fontSize: "12pt", letterSpacing: "0.3em" }} rowSpan={2}>{client?.name ?? project.client_name}</td>
            <td style={{ ...th, width: "28mm" }}>被保険者番号</td>
            <td style={{ ...cell, padding: 0 }}><Digits value={client?.insured_number ?? ""} count={10} /></td>
          </tr>
          <tr>
            <td style={{ ...th, width: "28mm" }}>生年月日</td>
            <td style={cell}>
              <span style={circle(birth?.era === "明治")}>明治</span>・<span style={circle(birth?.era === "大正")}>大正</span>・<span style={circle(birth?.era === "昭和")}>昭和</span>
              　{birth ? `${birth.year}年${birth.month}月${birth.day}日` : "　年　月　日"}
            </td>
          </tr>
        </tbody>
      </table>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {RENOVATION_KINDS.map((k) => {
            const places = placesByKind.get(k.no);
            const on = places !== undefined;
            return (
              <tr key={k.no}>
                {k.no === 1 && (
                  <td style={{ ...cell, borderTop: "none", width: "6mm", textAlign: "center", lineHeight: 1.3 }} rowSpan={RENOVATION_KINDS.length}>
                    住<br />宅<br />改<br />修<br />の<br />種<br />類
                  </td>
                )}
                <td style={{ ...cell, borderTop: k.no === 1 ? "none" : "1px dashed #000", borderBottom: "1px dashed #000", fontSize: "9pt", lineHeight: 1.6 }}>
                  <div><span style={circle(on)}>{k.no}</span>　{KIND_LABELS[k.no]}</div>
                  <div style={{ display: "flex", paddingLeft: "4mm" }}>
                    <span style={{ flex: 1 }}>（改修場所：{on ? places!.join("・") : ""}</span>
                    <span>）（改修事業者名：{on ? vendor : "　　　　　　　　　　　　　　"}）</span>
                  </div>
                </td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...cell, borderTop: "none" }} colSpan={2}>
              改修予定合計費用<span style={{ marginLeft: "25mm" }}>{yenNum(totals.grandTotal)}円</span>
            </td>
          </tr>
          <tr>
            <td style={{ ...cell, textAlign: "center", lineHeight: 1.3 }}>以<br />前<br />の<br />履<br />歴</td>
            <td style={{ ...cell, verticalAlign: "top", height: "48mm" }}>
              <div>住宅改修の種類・時期・費用等</div>
              <div style={{ whiteSpace: "pre-wrap", marginTop: "2mm" }}>{docs.application.previous_history}</div>
            </td>
          </tr>
          <tr>
            <td style={{ ...cell, textAlign: "center", lineHeight: 1.3 }}>添<br />付<br />書<br />類</td>
            <td style={{ ...cell, height: "20mm", fontSize: "9pt" }}>
              ○住宅改修が必要な理由書　○工事費内訳書　○改修前写真（撮影日のわかるもの）　○平面図等
            </td>
          </tr>
        </tbody>
      </table>
    </Sheet>
  );
}
