"use client";

// 介護保険 居宅介護（介護予防）住宅改修費 支給申請書 (A4 縦)。市ごとに様式が違うので CITY_FORMS で差分を持つ。
//
// 出どころ (2026-10-15 に各市公式サイトから取得。項目の書き起こしは scratchpad の SPEC.md):
//   市原市   償還払い用 (20-reiwa.pdf) / 受領委任払い用 (26-reiwa.pdf) — 介護保険各種様式ダウンロード
//   木更津市 償還払い / 受領委任払い用 第8号様式 — 申請書ダウンロード (介護保険課)
//   袖ケ浦市 住宅改修支給申請書 (償還払用 / 受領委任払用) — 住宅改修費の支給申請について
//   君津市   償還払い用 第10号様式 / 受領委任払い用 第8号様式 — 介護保険に関する各種申請書等一覧
//   千葉市   様式第23号 (R6.4 改正。事前申請専用) — 介護保険 様式ダウンロード (サービス)
//   茂原市   別記第34号様式（第27条） — 福祉用具購入費及び住宅改修費の支給申請に関するお知らせ (2026-10-16 取得)
//
// 千葉市以外の 4 市は 1 枚を事前・事後で使い回す。事前に出すときは、市が「事後に記入」と指定している欄を空けて出す。
// ⚠ 木更津市は手引き (H30) が「改修費用・申請日は事後に記入」、記入例は事前でも改修費用を記入済みと食い違う。
//   ここでは新しい記入例に合わせて事前でも改修費用を印字する (blankOnPre に入れていない)。
// ⚠ 市原市の受領委任払い用は事後専用 (事前は事業者が「事前協議願」を出す)。事前で受領委任を選ぶと注意を出す。
// 口座欄・個人番号は空欄の枠だけ出す (手書き)。システムは口座・個人番号を持たない。

import type { CSSProperties, ReactNode } from "react";
import { Sheet, type DocSheetProps } from "./RenovationDocSheets";
import { RENOVATION_KINDS, toWareki, warekiLabel, yenNum, cityOf } from "@/lib/renovationDocs";

type BlankField = "started" | "completed" | "cost" | "apply_date" | "title_month";

type CityForm = {
  /** 様式番号 (左上)。償還払い / 受領委任払い */
  formNo: { shoukan: string; juryo: string };
  title: string;
  /** 様式に印字済みの保険者番号 (空なら利用者の番号を入れる) */
  fixedInsurer?: string;
  /** 宛先の既定 (千葉市は区長なので住所から作る) */
  addressee: string;
  /** 申請文の書き出し */
  lead: string;
  /** 千葉市の様式第23号は事前専用 (着工予定日のみ・完成日なし) */
  preOnly?: boolean;
  gender: { shoukan: boolean; juryo: boolean };
  myNumber: boolean;
  /** 袖ケ浦市だけの欄 */
  careLevel?: boolean;
  siteAddress?: boolean;
  kindChecks?: boolean;
  contractorContact?: boolean;
  changeReason?: boolean;
  /** 市が書く欄 */
  cityBox?: string;
  /** 申請者の押印・捨印 (市原市) */
  seal?: boolean;
  /** 口座振込依頼欄 */
  bank: boolean;
  /** 事前申請のとき空ける欄 */
  blankOnPre: BlankField[];
  notes: { shoukan: string[]; juryo: string[] };
  juryo: {
    /** 受領委任払いの様式があるか */
    available: boolean;
    /** 委任文 (申請文の後ろに続ける) */
    delegation: string;
    /** 受任者欄の見出し */
    delegateLabel: string;
    /** 費用の内訳 ①保険給付改修費 ②自己負担 ①−② (木更津市) */
    costBreakdown?: boolean;
    /** 居宅介護支援事業者 (ケアマネ) の確認欄 */
    cmConfirm?: string;
    /** 事後専用 (市原市) */
    postOnly?: boolean;
  };
  /** 提出代行者欄 (千葉市) / 代理申請事業所欄 (袖ケ浦市) */
  proxy?: "chiba" | "sodegaura";
  footer?: string;
  /** 宛先を「（宛先）○○市長」と様なしで書く (茂原市) */
  addresseeAtesaki?: boolean;
  /** 茂原市だけの欄: 負担割合・要介護度 / 本人の状況 / 着工予定日と見積もり額 */
  copayAndCare?: boolean;
  personStatus?: string[];
  plannedAndEstimate?: boolean;
  /** 受領委任払いを選んだときの画面の注意 (申請書とは別に届を出す市など) */
  juryoNote?: string;
};

const NOTE_COMMON_OWNER = "・改修を行った住宅の所有者が当該被保険者でない場合は、所有者の承諾書も併せて添付してください。";

export const CITY_FORMS: Record<string, CityForm> = {
  // 茂原市 別記第34号様式（第27条）— 事前・事後兼用。※印 (着工日・完成日・改修費用) は工事完了後に書く。
  //   受領委任払いは申請書では区別せず、別紙「福祉用具購入費・住宅改修費受領委任届（第２号様式）」と委任状を付ける (未対応)。
  //   出どころ: https://www.city.mobara.chiba.jp/cmsfiles/contents/0000005/5898/jyuutakukaisyuu.pdf (2026-10-16 取得)
  茂原市: {
    formNo: { shoukan: "別記第34号様式（第27条）", juryo: "別記第34号様式（第27条）" },
    title: "介護保険居宅介護(介護予防)住宅改修費支給申請書",
    addressee: "茂原市長",
    addresseeAtesaki: true,
    lead: "上記のとおり関係書類を添えて居宅介護(介護予防)住宅改修費の支給を申請します。",
    gender: { shoukan: true, juryo: true },
    myNumber: true,
    copayAndCare: true,
    personStatus: ["入院中", "入所中", "転入前", "転居前", "認定前"],
    plannedAndEstimate: true,
    juryoNote: "茂原市は受領委任払いでも申請書は同じです。別に「福祉用具購入費・住宅改修費受領委任届（第２号様式）」と委任状を付けてください（この画面では未対応）。",
    bank: true,
    blankOnPre: ["started", "completed", "cost"],
    notes: {
      shoukan: [
        "・工事着工前に、この申請書に介護支援専門員等が作成した住宅改修が必要な理由書(付表1及び2)、工事費見積もり書、住宅改修後の完成予定の状態がわかるもの(日付入りの写真及び図面)を添付して申請し、保険給付の対象となるかどうかの確認を受けてください。確認の結果は、書面で通知します。",
        "・工事完了後に、住宅改修に要した費用に係る領収証、工事費内訳書、住宅改修の完成後の状態を確認できる書類（日付入りの写真）を提出してください。",
        "・改修を行う住宅の所有者が当該被保険者でない場合は、所有者の承諾書も併せて添付してください。",
        "・※印の箇所は工事完了後に記載してください。",
      ],
      juryo: [],
    },
    juryo: { available: false, delegation: "", delegateLabel: "" },
  },
  市原市: {
    formNo: { shoukan: "", juryo: "" },
    title: "介護保険居宅介護（介護予防）住宅改修費支給申請書",
    addressee: "市原市長",
    lead: "上記のとおり関係書類を添えて居宅介護（介護予防）住宅改修費の支給を申請します。",
    gender: { shoukan: false, juryo: false },
    myNumber: true,
    seal: true,
    bank: true,
    blankOnPre: ["title_month", "started", "completed", "cost"],
    footer: "※着工日、完成日、改修費用は工事後の申請の際に記載して下さい。",
    notes: {
      shoukan: [
        "【工事前】この申請書に、介護支援専門員等が作成した住宅改修が必要と認められる理由を記載した書類（理由書）、工事費の内訳がわかる書類（見積書）、改修予定の状態が確認できる書類（写真及び平面図）を添付して下さい。",
        "【工事後】領収書（原本）、完成後の状態が確認できる書類を提出して下さい。改修を行った住宅等の所有者が当該被保険者でない場合は、住宅等の所有者の承諾書を併せて提出して下さい。",
      ],
      juryo: [
        "・この申請書に、領収証及び介護支援専門員等が作成した住宅改修が必要と認められる理由を記載した書類、完成後の状態が確認できる書類等を添付して下さい。",
        "・改修を行った住宅等の所有者が当該被保険者でない場合は、住宅等の所有者の承諾書も併せて添付して下さい。",
      ],
    },
    juryo: {
      available: true,
      delegation: "また、居宅介護（支援）住宅改修費支給申請及び給付金の受領に関する権限を下欄の受取人に委任します。",
      delegateLabel: "受取人（受領委任払い登録事業者）",
      cmConfirm: "確認者（居宅介護支援事業者（介護支援専門員））",
      postOnly: true,
    },
  },
  木更津市: {
    formNo: { shoukan: "", juryo: "第8号様式（第１０条第１項）" },
    title: "介護保険居宅介護（介護予防）住宅改修費支給申請書",
    fixedInsurer: "122069",
    addressee: "木更津市長",
    lead: "上記のとおり関係書類を添えて、居宅介護（介護予防）住宅改修費の支給を申請します。",
    gender: { shoukan: true, juryo: true },
    myNumber: true,
    cityBox: "事前申請確認欄",
    bank: true,
    blankOnPre: ["started", "completed", "apply_date"],
    notes: {
      shoukan: [
        "・住宅改修を行うときには、あらかじめ申請書を提出してください。",
        "・この申請書に、見積もり及び着工予定年月日を記載した書類、及び介護支援専門員等が作成した住宅改修が必要と認められる理由を記載した書類、住宅改修の予定の状態が確認できる書類等を添付してください。",
        "・住宅改修が完成した後に、その要した費用並びにその着工及び完成の年月日を記載した書類、領収証、完成後の状態を確認できる書類等を添付してください。",
        NOTE_COMMON_OWNER,
      ],
      juryo: [
        "１ 住宅改修を行うときは、あらかじめ申請書を提出してください。",
        "２ 保険対象費用額に給付対象外経費が含まれているときは、保険支給額が減額されます。また、過去に支給を受けている場合、保険支給額が減額されることもありますのでご注意ください。",
        "３ この申請書に、見積もり及び介護支援専門員等が作成した住宅改修が必要と認められる理由を記載した書類、住宅改修の予定の状態が確認できる書類等を添付してください。",
        "４ 住宅改修が完成した後に、その要した費用並びにその着工及び完成の年月日を記載した書類、領収証、完成後の状態を確認できる書類等を添付してください。",
        "５ 改修を行った住宅の所有者が当該被保険者でない場合は、所有者の承諾書も併せて添付してください。",
      ],
    },
    juryo: {
      available: true,
      delegation: "また、本申請に基づく住宅改修費の支給申請及び受領に関する権限を下記受任者に委任します。",
      delegateLabel: "受領受任者",
      costBreakdown: true,
    },
  },
  袖ケ浦市: {
    formNo: { shoukan: "", juryo: "" },
    title: "介護保険居宅介護（介護予防）住宅改修支給申請書",
    addressee: "袖ケ浦市長",
    lead: "前のとおり、関係書類を添えて居宅介護（介護予防）住宅改修費の支給を申請します。",
    gender: { shoukan: false, juryo: false },
    myNumber: true,
    careLevel: true,
    siteAddress: true,
    kindChecks: true,
    contractorContact: true,
    changeReason: true,
    cityBox: "事前承認番号",
    bank: true,
    proxy: "sodegaura",
    blankOnPre: ["started", "completed", "cost", "apply_date"],
    notes: {
      shoukan: [
        "・この申請書に添えて、介護支援専門員等が作成した住宅改修が必要な理由書、工事費見積書、住宅改修の予定の状態が確認できるもの(写真又は簡単な図面)を提出してください。",
        "・工事終了後、住宅改修に要した領収書、工事費内訳書、住宅改修の完成後の状態を確認できる書類を提出してください。",
        NOTE_COMMON_OWNER,
      ],
      juryo: [
        "・この申請書に添えて、介護支援専門員等が作成した住宅改修が必要な理由書、工事費見積書、住宅改修の予定の状態が確認できるもの(写真又は簡単な図面)を提出してください。",
        "・工事終了後、住宅改修に要した領収書、工事費内訳書、住宅改修の完成後の状態を確認できる書類を提出してください。",
        NOTE_COMMON_OWNER,
      ],
    },
    juryo: {
      available: true,
      delegation: "上の事業所に居宅介護（予防）住宅改修費の請求及び受領を委任します。",
      delegateLabel: "申請者（受領委任事業所）",
    },
  },
  君津市: {
    formNo: { shoukan: "第10号様式(第18条)", juryo: "第８号様式(第１０条第１項)" },
    title: "介護保険居宅介護(介護予防)住宅改修費支給申請書",
    fixedInsurer: "122259",
    addressee: "君津市長",
    lead: "上記のとおり関係書類を添えて居宅介護(介護予防)住宅改修費の支給を申請します。",
    gender: { shoukan: false, juryo: true },
    myNumber: true,
    bank: true,
    blankOnPre: ["started", "completed", "cost"],
    notes: {
      shoukan: [
        "・この申請書に、介護支援専門員等が作成した住宅改修が必要と認められる理由書、見積書及び完成後の状態が確認できる書類等を添付してください。",
        NOTE_COMMON_OWNER,
      ],
      juryo: [
        "１　この申請書には、領収証の写し及び工事費内訳書、居宅介護支援事業者等が作成した住宅改修が必要と認められる理由を記載した書類、完成後の状態が確認できる書類（着工前及び完了後の写真）等を添付してください。",
        "２　住宅改修を行った住宅の所有者が当該被保険者でないときは、所有者の承諾書も併せて添付してください。",
      ],
    },
    juryo: {
      available: true,
      delegation: "また、居宅介護(介護予防)住宅改修費の支給の申請及び受領に関する権限については、次の登録事業者に委任します。",
      delegateLabel: "登録事業者",
      cmConfirm: "上記の申請については、介護保険法第45条第1項又は第57条第1項に規定する住宅改修に該当すること及び支給の申請手続が適正であることを確認します。（居宅介護支援事業者）",
    },
  },
  千葉市: {
    formNo: { shoukan: "様式第23号", juryo: "様式第23号" },
    title: "介護保険居宅介護（介護予防）住宅改修費支給申請書",
    addressee: "",
    lead: "上記のとおり関係書類を添えて居宅介護（介護予防）住宅改修費の支給を申請します。",
    preOnly: true,
    gender: { shoukan: false, juryo: false },
    myNumber: false,
    bank: false,
    proxy: "chiba",
    blankOnPre: [],
    notes: {
      shoukan: [
        "・この申請書の裏面に、見積書及び介護支援専門員等が作成した住宅改修が必要と認められる理由を記載した書類、住宅改修の予定の状態が確認できる書類等を添付してください。",
        "・住宅改修が完了した後に、領収証及び完了後の状態が確認できる書類等を提出してください。",
        "・住宅改修を行った住宅の所有者が当該被保険者でない場合は、所有者の承諾書も併せて添付してください。",
        "・次の場合には保険給付の対象外となります。",
        "（１）本事前申請の結果(「介護保険住宅改修費支給申請に関する確認のお知らせ」)に記載の確認年月日より前に着工している場合",
        "（２）要介護（要支援）認定申請中の方で、認定結果が非該当又は出ない場合",
        "（３）医療機関又は介護施設等に入院（入所）中に改修し、退院（退所）されずに改修後の住宅で生活されていない場合",
      ],
      juryo: [],
    },
    juryo: { available: false, delegation: "", delegateLabel: "" },
  },
};

/** 住所 → 様式。登録の無い市町村は null (画面で「様式未登録」と出す) */
export function cityFormFor(address: string | null | undefined): { city: string | null; form: CityForm | null } {
  const c = cityOf(address)?.city ?? null;
  return { city: c, form: c ? CITY_FORMS[c] ?? null : null };
}

// ─── 表示 ────────────────────────────────────────────────────────────────────

const B = "1px solid #000";
const cell: CSSProperties = { border: B, padding: "1.1mm 1.8mm", verticalAlign: "middle" };
const th: CSSProperties = { ...cell, background: "#f2f2f2", textAlign: "center", width: "27mm", fontWeight: "normal" };
const digit: CSSProperties = { border: B, width: "5.2mm", height: "6mm", textAlign: "center", padding: 0, fontSize: "10pt" };

function Digits({ value, count }: { value: string; count: number }) {
  const chars = Array.from(value.padEnd(count, " ")).slice(0, count);
  return (
    <table style={{ borderCollapse: "collapse", display: "inline-table" }}>
      <tbody><tr>{chars.map((c, i) => <td key={i} style={digit}>{c.trim()}</td>)}</tr></tbody>
    </table>
  );
}

const blankDate = "　　　年　　月　　日";

export function ApplicationSheet({ docs, project, client, totals, addressee, receiptAmount }: DocSheetProps) {
  const address = client?.address ?? project.client_address ?? "";
  const { form } = cityFormFor(address);
  if (!form) {
    return (
      <div className="rdoc-sheet rdoc-portrait" style={{ width: "190mm", padding: "20mm", background: "#fff", color: "#b91c1c" }}>
        この利用者の住所（{address || "未登録"}）の市町村は、支給申請書の様式がまだ登録されていません。
        登録済み: {Object.keys(CITY_FORMS).join("・")}
      </div>
    );
  }
  const app = docs.application;
  const juryo = app.payment === "juryo" && form.juryo.available;
  const pre = app.phase === "pre" && !form.preOnly;
  const blank = (f: BlankField) => pre && form.blankOnPre.includes(f);
  const birth = toWareki(client?.birth_date);
  const phone = client?.phone || (client as unknown as { mobile?: string | null } | null)?.mobile || "";
  const postal = (client as unknown as { postal_code?: string | null } | null)?.postal_code ?? "";
  const o = docs.owner;
  const kinds = Array.from(new Set(docs.estimate.groups.map((g) => g.kind))).sort();
  const places = docs.estimate.groups.map((g) => [g.place, g.part].filter(Boolean).join(" ")).filter(Boolean);
  const insurer = form.fixedInsurer ?? (client?.insurer_number ?? "");
  const iss = docs.issuer;
  const showGender = juryo ? form.gender.juryo : form.gender.shoukan;
  const gender = client?.gender?.startsWith("男") ? "男" : client?.gender?.startsWith("女") ? "女" : null;
  const startLabel = form.preOnly ? "着工予定日" : "着工日";
  // 茂原市は「工事完了後に記載」の欄に (※) が付く
  const mark = form.plannedAndEstimate ? "(※)" : "";
  const startValue = form.preOnly
    ? (docs.estimate.start_date ? warekiLabel(docs.estimate.start_date) : blankDate)
    : blank("started") ? blankDate : (app.started_date ? warekiLabel(app.started_date) : blankDate);
  const cost = blank("cost") ? "" : yenNum(totals.grandTotal);
  const benefit = totals.grandTotal - receiptAmount;
  const dateLine = blank("apply_date") || !app.apply_date ? blankDate : warekiLabel(app.apply_date);
  const notes = juryo ? form.notes.juryo : form.notes.shoukan;
  const kindText: ReactNode = form.kindChecks ? (
    <div style={{ fontSize: "8pt" }}>
      {RENOVATION_KINDS.map((k) => (
        <div key={k.no}>{kinds.includes(k.no) ? "☑" : "☐"}{k.no}．{k.no === 6 ? "付帯工事" : k.label}</div>
      ))}
      {places.length > 0 && <div style={{ marginTop: "1mm" }}>箇所：{places.join("、")}</div>}
    </div>
  ) : (
    <>
      {kinds.map((k) => <div key={k}>（{k}）{RENOVATION_KINDS.find((x) => x.no === k)?.label}</div>)}
      {places.length > 0 && <div style={{ marginTop: "1mm" }}>箇所：{places.join("、")}</div>}
    </>
  );

  return (
    <Sheet>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "8.5pt", minHeight: "5mm" }}>
        <span>{juryo ? form.formNo.juryo : form.formNo.shoukan}</span>
        {form.cityBox && (
          <span style={{ display: "inline-flex", border: B }}>
            <span style={{ padding: "1mm 2mm", borderRight: B }}>{form.cityBox}</span>
            <span style={{ width: "18mm" }} />
          </span>
        )}
      </div>
      <div style={{ textAlign: "center", fontSize: "12.5pt", margin: "2mm 0 1mm" }}>
        {form.title}{juryo ? "（受領委任払い用）" : ""}
      </div>
      {form.blankOnPre.includes("title_month") && (
        <div style={{ textAlign: "center", marginBottom: "2mm" }}>
          {blank("title_month") || !app.completed_date ? "　　年　　月" : (() => { const w = toWareki(app.completed_date); return w ? `${w.era}${w.year}年${w.month}月` : ""; })()}
        </div>
      )}
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          <tr>
            <td style={th}>フリガナ</td>
            <td style={{ ...cell, fontSize: "8.5pt" }}>{client?.furigana ?? ""}</td>
            <td style={th}>保険者番号</td>
            <td style={cell}><Digits value={insurer} count={6} /></td>
          </tr>
          <tr>
            <td style={th}>被保険者氏名</td>
            <td style={{ ...cell, fontSize: "12pt", height: "9mm" }}>{client?.name ?? project.client_name}</td>
            <td style={th}>被保険者番号</td>
            <td style={cell}><Digits value={client?.insured_number ?? ""} count={10} /></td>
          </tr>
          {form.myNumber && (
            <tr>
              <td style={th} colSpan={2} />
              <td style={th}>個人番号</td>
              <td style={cell}><Digits value="" count={12} /></td>
            </tr>
          )}
          <tr>
            <td style={th}>生年月日</td>
            <td style={cell}>
              {birth ? `${birth.era}${birth.year}年${birth.month}月${birth.day}日生` : "明・大・昭　　年　　月　　日生"}
            </td>
            {showGender ? (
              <>
                <td style={th}>性別</td>
                <td style={cell}>{gender ? `${gender}` : "男・女"}</td>
              </>
            ) : form.careLevel ? (
              <>
                <td style={th}>要介護度等</td>
                <td style={cell}>{client?.care_level ?? ""}</td>
              </>
            ) : <td style={cell} colSpan={2} />}
          </tr>
          {form.copayAndCare && (
            <tr>
              <td style={th}>負担割合</td>
              <td style={cell}>{/^[123]割$/.test(project.copay_rate ?? "") ? project.copay_rate!.slice(0, 1) : "　"}　割</td>
              <td style={th}>要介護度</td>
              <td style={cell}>{client?.care_level ?? ""}</td>
            </tr>
          )}
          {form.careLevel && (
            <tr>
              <td style={th}>認定有効期間</td>
              <td style={cell} colSpan={3}>
                {warekiLabel(client?.certification_start_date) || blankDate}　～　{warekiLabel(client?.certification_end_date) || blankDate}
              </td>
            </tr>
          )}
          <tr>
            <td style={th}>住　　所</td>
            <td style={{ ...cell, height: "13mm" }} colSpan={3}>
              〒{postal}<br />{address}<span style={{ float: "right" }}>電話番号　{phone}</span>
            </td>
          </tr>
          <tr>
            <td style={th}>住宅の所有者</td>
            <td style={cell} colSpan={form.personStatus ? 1 : 3}>
              {o.is_self ? (client?.name ?? project.client_name) : o.name}
              <span style={{ float: "right" }}>本人との関係（{o.is_self ? "本人" : o.relation}）</span>
            </td>
            {form.personStatus && (
              <>
                <td style={th}>本人の状況</td>
                {/* 該当するものに○ (手書き)。入院・入所等の状況はシステムで持っていないので印字しない */}
                <td style={{ ...cell, fontSize: "8.5pt" }}>{form.personStatus.join(" ・ ")}</td>
              </>
            )}
          </tr>
          {form.siteAddress && (
            <tr>
              <td style={th}>住宅改修先住所</td>
              <td style={cell} colSpan={3}>
                {/* 工事場所が利用者の住所と違うときは利用者の郵便番号を流用しない */}
                〒{!docs.estimate.site || docs.estimate.site === address ? postal : ""}　{docs.estimate.site || address}
              </td>
            </tr>
          )}
          <tr>
            <td style={th}>改修の内容・<br />箇所及び規模</td>
            <td style={{ ...cell, verticalAlign: "top", height: "24mm" }}>{kindText}</td>
            <td style={{ ...cell, padding: 0, verticalAlign: "top" }} colSpan={2}>
              <table style={{ borderCollapse: "collapse", width: "100%", height: "100%" }}>
                <tbody>
                  <tr>
                    <td style={{ ...th, borderTop: "none", borderLeft: "none", width: "18mm" }}>業者名</td>
                    <td style={{ ...cell, borderTop: "none", borderRight: "none" }}>{iss.company_name}　{iss.office_name}</td>
                  </tr>
                  {form.contractorContact && (
                    <tr>
                      <td style={{ ...th, borderLeft: "none", width: "18mm" }}>業者連絡先</td>
                      <td style={{ ...cell, borderRight: "none" }}>{iss.tel}</td>
                    </tr>
                  )}
                  {form.plannedAndEstimate && (
                    <>
                      <tr>
                        <td style={{ ...th, borderLeft: "none", width: "18mm" }}>着工予定日</td>
                        <td style={{ ...cell, borderRight: "none" }}>
                          {docs.estimate.start_date ? warekiLabel(docs.estimate.start_date) : blankDate}
                        </td>
                      </tr>
                      <tr>
                        <td style={{ ...th, borderLeft: "none", width: "18mm" }}>見積もり額</td>
                        <td style={{ ...cell, borderRight: "none", textAlign: "right" }}>{yenNum(totals.grandTotal)}　円</td>
                      </tr>
                    </>
                  )}
                  <tr>
                    <td style={{ ...th, borderLeft: "none", width: "18mm", ...(form.preOnly ? { borderBottom: "none" } : {}) }}>{startLabel}{mark}</td>
                    <td style={{ ...cell, borderRight: "none", ...(form.preOnly ? { borderBottom: "none" } : {}) }}>{startValue}</td>
                  </tr>
                  {!form.preOnly && (
                    <tr>
                      <td style={{ ...th, borderBottom: "none", borderLeft: "none", width: "18mm" }}>完成日{mark}</td>
                      <td style={{ ...cell, borderBottom: "none", borderRight: "none" }}>
                        {blank("completed") || !app.completed_date ? blankDate : warekiLabel(app.completed_date)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </td>
          </tr>
          {juryo && form.juryo.costBreakdown ? (
            <tr>
              <td style={th}>改修費用</td>
              <td style={cell} colSpan={3}>
                <span>保険給付改修費①　{cost} 円</span>
                <span style={{ marginLeft: "6mm" }}>自己負担額②　{blank("cost") ? "" : yenNum(receiptAmount)} 円</span>
                <span style={{ marginLeft: "6mm" }}>保険支給額①－②　{blank("cost") ? "" : yenNum(benefit)} 円</span>
              </td>
            </tr>
          ) : (
            <tr>
              <td style={th}>改修費用{mark}</td>
              <td style={{ ...cell, fontSize: "11pt" }} colSpan={3}>{cost}　円</td>
            </tr>
          )}
          {form.changeReason && (
            <tr>
              <td style={{ ...th, fontSize: "7.5pt" }}>改修予定費用から改修費用で変更があった場合の理由</td>
              <td style={{ ...cell, whiteSpace: "pre-wrap" }} colSpan={3}>{pre ? "" : app.change_reason}</td>
            </tr>
          )}
          {form.cityBox === "事前承認番号" && (
            <tr>
              <td style={th}>事前承認番号</td>
              <td style={{ ...cell, background: "repeating-linear-gradient(135deg, #fff 0 3mm, #ccc 3mm 3.3mm)" }} colSpan={3} />
            </tr>
          )}
        </tbody>
      </table>

      {juryo && form.juryo.cmConfirm && form.juryo.cmConfirm.startsWith("確認者") && (
        <CmBox label={form.juryo.cmConfirm} docs={docs} />
      )}

      <div style={{ border: B, borderTop: "none", padding: "2mm 3mm", lineHeight: 1.8 }}>
        <div style={{ fontSize: "11pt" }}>
          {form.addressee
            ? form.addresseeAtesaki ? `（宛先）${form.addressee}` : `${form.addressee}　様`
            : <>（あて先）<span style={{ marginLeft: "6mm" }}>{addressee}</span></>}
        </div>
        <div style={{ paddingLeft: "4mm" }}>
          {form.lead}{juryo ? form.juryo.delegation : ""}
        </div>
        <div style={{ paddingLeft: "10mm" }}>{dateLine}</div>
        <div style={{ display: "flex", gap: "4mm", paddingLeft: "10mm" }}>
          <span style={{ whiteSpace: "nowrap" }}>{juryo ? "申請者（兼受領委任者）" : "申請者"}</span>
          <div style={{ flex: 1 }}>
            <div>住所　{address}</div>
            <div>
              氏名　{client?.name ?? project.client_name}
              {form.seal && <span style={{ marginLeft: "10mm" }}>印</span>}
              <span style={{ float: "right" }}>電話番号　{phone}</span>
            </div>
          </div>
          {form.seal && <span style={{ border: "1px dashed #000", borderRadius: "50%", width: "10mm", height: "10mm", fontSize: "6.5pt", display: "flex", alignItems: "center", justifyContent: "center" }}>捨印</span>}
        </div>
        <div style={{ fontSize: "7.5pt", paddingLeft: "10mm" }}>（注）本人が手書きしない場合は、記名押印してください。</div>
      </div>

      {juryo && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            <tr>
              <td style={{ ...th, borderTop: "none" }}>{form.juryo.delegateLabel}</td>
              <td style={{ ...cell, borderTop: "none", lineHeight: 1.7 }}>
                <div>所在地　〒{iss.postal_code}　{iss.address}</div>
                <div>名称　{iss.company_name}　{iss.office_name}</div>
                <div>代表者氏名　　　　　　　　　　　　<span style={{ float: "right" }}>電話番号　{iss.tel}</span></div>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {juryo && form.juryo.cmConfirm && !form.juryo.cmConfirm.startsWith("確認者") && (
        <CmBox label={form.juryo.cmConfirm} docs={docs} />
      )}

      {form.proxy === "chiba" && app.proxy && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            <tr>
              <td style={{ ...th, borderTop: "none" }}>提出代行者<br />所在地・名称・<br />電話番号</td>
              <td style={{ ...cell, borderTop: "none" }}>
                <div>〒{iss.postal_code}　{iss.address}</div>
                <div>{iss.company_name}　{iss.office_name}</div>
                <div>電話番号　{iss.tel}</div>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      {form.proxy === "sodegaura" && !juryo && app.proxy && (
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            <tr>
              <td style={{ ...th, borderTop: "none" }}>代理申請を行う<br />事業所情報</td>
              <td style={{ ...cell, borderTop: "none" }}>
                <div>事業所名称　{iss.company_name}　{iss.office_name}</div>
                <div>事業所種別　福祉用具貸与・販売（住宅改修）</div>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {form.footer && <div style={{ textAlign: "right", fontSize: "7.5pt", marginTop: "1mm" }}>{form.footer}</div>}
      <div style={{ fontSize: "7.3pt", marginTop: "2mm", lineHeight: 1.45 }}>
        <div>注意</div>
        {notes.map((n, i) => <div key={i} style={{ paddingLeft: n.startsWith("（") ? "4mm" : 0 }}>{n}</div>)}
      </div>

      {form.bank && <BankBox />}
    </Sheet>
  );
}

function CmBox({ label, docs }: { label: string; docs: DocSheetProps["docs"] }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <tbody>
        <tr>
          <td style={{ ...th, borderTop: "none", fontSize: "7.5pt", width: "40mm" }}>{label}</td>
          <td style={{ ...cell, borderTop: "none", lineHeight: 1.7 }}>
            <div>名称　{docs.reason.creator_office}</div>
            <div>介護支援専門員氏名　{docs.reason.creator_name}　　　印</div>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/** 口座振込依頼欄 (空欄の枠のみ。口座はシステムに持たない) */
function BankBox() {
  return (
    <div style={{ marginTop: "2mm" }}>
      <div style={{ fontSize: "8.5pt" }}>居宅介護（介護予防）住宅改修費を下記の口座に振り込んでください。</div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "8pt" }}>
        <tbody>
          <tr>
            <td style={{ ...th, width: "18mm" }} rowSpan={3}>口座振込<br />依頼欄</td>
            <td style={{ ...cell, height: "9mm" }}>　　　　　　銀行・信用金庫・信用組合・農協</td>
            <td style={cell}>　　　　本店・支店・出張所</td>
            <td style={cell}>種目　1 普通　2 当座　3 その他</td>
            <td style={cell}>口座番号 <Digits value="" count={7} /></td>
          </tr>
          <tr>
            <td style={cell} colSpan={2}>金融機関コード <Digits value="" count={4} />　店舗コード <Digits value="" count={3} /></td>
            <td style={cell} colSpan={2}>フリガナ</td>
          </tr>
          <tr>
            <td style={{ ...cell, height: "9mm" }} colSpan={4}>口座名義人</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
