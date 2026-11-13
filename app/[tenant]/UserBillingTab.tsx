"use client";

import { type BillingCertRow } from "@/lib/insurance/billing-cert-cols";
import { useEffect, useMemo, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight, Printer, FileText, Receipt } from "lucide-react";
import { monthEndYmd } from "@/lib/date-jst";
import type {
  Client,
  Equipment,
  EquipmentPriceHistory,
  Order,
  OrderItem,
} from "@/lib/supabase";
import { rentalMonthUnits } from "@/lib/half-month-units";
import { useRentalCalcContext, excludedOf, modeOf } from "@/lib/rentalCalcContext";
import { getPriceForMonth } from "@/lib/equipment";

const EMPTY_PRICE_HISTORY: EquipmentPriceHistory[] = [];
import {
  getUserInvoices,
  upsertUserInvoice,
  updateUserInvoiceStatus,
  getNextUserInvoiceNo,
  type BillingUserInvoice,
  type BillingUserInvoiceStatus,
} from "@/lib/userBilling";
import { getCareOffices, type CareOffice } from "@/lib/careOffices";
import { getOfficeCompanyInfo, toCompanyInfo, emptyCompanyInfoRow } from "@/lib/officeCompanyInfo";
import type { CompanyInfo } from "./company-info";

// ── かな行フィルター (MonthlyInfoTab と同じ pattern) ─────────────────────
const USER_BILLING_KANA_ROWS = ["あ", "か", "さ", "た", "な", "は", "ま", "や", "ら", "わ", "他"];
const USER_BILLING_KANA_MAP: Record<string, string[]> = {
  あ: ["ア", "イ", "ウ", "エ", "オ"],
  か: ["カ", "キ", "ク", "ケ", "コ", "ガ", "ギ", "グ", "ゲ", "ゴ"],
  さ: ["サ", "シ", "ス", "セ", "ソ", "ザ", "ジ", "ズ", "ゼ", "ゾ"],
  た: ["タ", "チ", "ツ", "テ", "ト", "ダ", "ヂ", "ヅ", "デ", "ド"],
  な: ["ナ", "ニ", "ヌ", "ネ", "ノ"],
  は: ["ハ", "ヒ", "フ", "ヘ", "ホ", "バ", "ビ", "ブ", "ベ", "ボ", "パ", "ピ", "プ", "ペ", "ポ"],
  ま: ["マ", "ミ", "ム", "メ", "モ"],
  や: ["ヤ", "ユ", "ヨ"],
  ら: ["ラ", "リ", "ル", "レ", "ロ"],
  わ: ["ワ", "ヲ", "ン"],
};
const USER_BILLING_ALL_KANA = Object.values(USER_BILLING_KANA_MAP).flat();
const toKana = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

const PAYMENT_METHOD_OPTIONS = ["", "払込票", "振込", "集金", "口座振替", "現金"];
const UNIT_PRICE_YEN = 10; // 介護単位 1 単位 = 10 円固定
const TAX_RATE = 0.1; // 自費レンタル 消費税 10%

type LineItem = {
  key: string;
  kind: "福祉用具貸与" | "自費レンタル";
  name: string;
  unit_price: number; // 税抜単価 (介護自己負担分の場合は計算済 1 個あたりの自己負担額)
  quantity: number;
  amount: number; // 税抜
  tax_amount: number;
  is_taxable: boolean;
  /** 介護: 1 個あたりの当月算定単位数 (半月ルール後)。自費は null */
  units: number | null;
  /** 帳票の「ご利用日」カレンダー・期間用 (YYYY-MM-DD) */
  rental_start_date: string;
  rental_end_date: string | null;
  /** 発注の事業所 (帳票の発行元を事業所ごとに引くため) */
  office_id: string | null;
};

type Row = {
  client: Client;
  ins: BillingCertRow | null;
  careOffice: CareOffice | null;
  lineItems: LineItem[];
  computedTotal: number; // 税込合計
  computedTax: number;
  invoice: BillingUserInvoice | null;
};

function jpReiwa(y: number): string {
  // 令和元年 = 2019。R{Y-2018}/{M} 形式は MonthlyInfoTab と同じ流儀。
  return `R${y - 2018}`;
}

function formatIssuedDateReiwa(iso: string | null): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = parseInt(m[1], 10);
  return `${jpReiwa(y)}/${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
}

function parseLocalDate(s: string): Date {
  const [py, pm, pd] = s.split("-").map(Number);
  return new Date(py, pm - 1, pd);
}

// ── 帳票印刷 (請求書 / 領収書 / 一覧) ────────────────────────────────────
// window.open した別窓に自己完結の A4 HTML を書き込んで印刷する
// (会議録の printMeetingNoteSheet と同じ流儀。ページ本体の DOM は汚さない)。
function escapeHtml(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function reiwaDate(iso: string): string {
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!mm) return iso;
  const yy = parseInt(mm[1], 10);
  return `令和${yy - 2018}年${parseInt(mm[2], 10)}月${parseInt(mm[3], 10)}日`;
}

function reiwaMonth(ym: string): string {
  const mm = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!mm) return ym;
  const yy = parseInt(mm[1], 10);
  return `令和${yy - 2018}年${parseInt(mm[2], 10)}月分`;
}

// 発行番号の表示形式: {年}-{番号4桁}  (例: 2026-0001)
function formatInvoiceNo(year: number, no: number): string {
  return `${year}-${String(no).padStart(4, "0")}`;
}

type IssuerInfo = {
  /** 法人名 (companies.name 等)。無ければ空 */
  legalName: string;
  companyName: string;
  /** 適格請求書の登録番号 (T + 13 桁) */
  invoiceNumber: string;
  companyAddress: string;
  tel: string;
  fax: string;
};

// 帳票の発行元: 事業所ごとの設定 > 事業所・法人マスタ > グループ共通 (lib/officeCompanyInfo.ts)。
// BillingTab の InvoiceReceiptModal と同じ経路。
function issuerFromCompanyInfo(ci: CompanyInfo): IssuerInfo {
  const inv = (ci.invoiceNumber ?? "").trim();
  return {
    legalName: (ci.legalName ?? "").trim(),
    companyName: ci.companyName ?? "",
    invoiceNumber: inv ? (/^T/i.test(inv) ? inv.toUpperCase() : `T${inv}`) : "",
    companyAddress: ci.companyAddress ?? "",
    tel: ci.tel ?? "",
    fax: ci.fax ?? "",
  };
}

// 「令和 8年 4月 8日」(見本の書式)
function reiwaDateSpaced(iso: string): string {
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!mm) return iso;
  const yy = parseInt(mm[1], 10);
  return `令和 ${yy - 2018}年 ${parseInt(mm[2], 10)}月 ${parseInt(mm[3], 10)}日`;
}

// 1 枚分の A4 帳票 (請求書 or 領収書) の HTML を組み立てる。
// 書式は ほのぼの出力の利用料請求書 (apps/order-app/請求書.pdf) に合わせる。
// group.length === 1 → 通常の 1 利用者。>1 → 名寄せ (同一世帯合算: 利用者別小計 + 世帯合計)。
function buildDocPage(
  group: Row[],
  mode: "invoice" | "receipt",
  issuer: IssuerInfo,
  billingMonth: string,
  issueDate: string,
  invoiceNo: string | null
): string {
  const rep = group[0];
  const isMerged = group.length > 1;
  const title = mode === "invoice" ? "利用料請求書" : "利用料領収書";
  const amountLabel = mode === "invoice" ? "今回ご請求額" : "領収金額";
  const dateLabel = mode === "invoice" ? "発行日" : "領収日";
  const lead = mode === "invoice" ? "下記の通り請求いたします。" : "下記の内容について、領収いたしました。";

  const [yy, mo] = billingMonth.split("-").map(Number);
  const daysInMonth = new Date(yy, mo, 0).getDate();
  const monthStartStr = `${billingMonth}-01`;
  const monthEndStr = `${billingMonth}-${String(daysInMonth).padStart(2, "0")}`;

  const allItems = group.flatMap((r) => r.lineItems);
  const careItems = allItems.filter((li) => li.units != null);
  const billed = group.reduce((s, r) => s + (r.invoice?.total_amount ?? r.computedTotal), 0);
  // 課税分は税込 (見本: 課税分 438円 / 消費税対象額 438 / 消費税額 39)
  const taxableIncl = allItems.filter((li) => li.is_taxable).reduce((s, li) => s + li.amount + li.tax_amount, 0);
  const nonTaxable = allItems.filter((li) => !li.is_taxable).reduce((s, li) => s + li.amount, 0);
  const tax = group.reduce((s, r) => s + r.computedTax, 0);
  const officeName = rep.careOffice?.name ?? rep.client.care_manager_org ?? "";
  const yen = (n: number) => n.toLocaleString();

  // ── 期間・ご利用日 ──
  const dayOf = (iso: string) => parseInt(iso.slice(8, 10), 10);
  const usedDays = new Set<number>(); // 期間 (全明細)
  const careDays = new Set<number>(); // ○ 介護サービス算定日
  const edgeDays = new Set<number>(); // □ サービス利用開始・終了日
  for (const li of allItems) {
    const from = li.rental_start_date < monthStartStr ? 1 : dayOf(li.rental_start_date);
    const to = !li.rental_end_date || li.rental_end_date > monthEndStr ? daysInMonth : dayOf(li.rental_end_date);
    for (let d = from; d <= to; d++) {
      usedDays.add(d);
      if (li.units != null) careDays.add(d);
    }
    if (li.rental_start_date >= monthStartStr && li.rental_start_date <= monthEndStr) edgeDays.add(dayOf(li.rental_start_date));
    if (li.rental_end_date && li.rental_end_date >= monthStartStr && li.rental_end_date <= monthEndStr) edgeDays.add(dayOf(li.rental_end_date));
  }
  const sortedDays = [...usedDays].sort((a, b) => a - b);
  const period =
    sortedDays.length > 0
      ? `期間：${mo}月${sortedDays[0]}日～${mo}月${sortedDays[sortedDays.length - 1]}日`
      : "";

  const firstDow = new Date(yy, mo - 1, 1).getDay();
  const calCells: string[] = [];
  for (let i = 0; i < firstDow; i++) calCells.push(`<td></td>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dow = (firstDow + d - 1) % 7;
    const cls = dow === 0 ? "sun" : dow === 6 ? "sat" : "";
    const mark = edgeDays.has(d) ? "sq" : careDays.has(d) ? "ci" : "";
    calCells.push(`<td class="${cls}"><span class="${mark}">${d}</span></td>`);
  }
  while (calCells.length % 7 !== 0) calCells.push(`<td></td>`);
  const calRows: string[] = [];
  for (let i = 0; i < calCells.length; i += 7) calRows.push(`<tr>${calCells.slice(i, i + 7).join("")}</tr>`);

  // ── 利用内訳 ──
  const sumPerson = (r: Row) => r.lineItems.reduce((s, li) => s + li.amount + li.tax_amount, 0);
  const usageRows = isMerged
    ? group
        .map(
          (r) =>
            `<tr><td>福祉用具貸与（${escapeHtml(r.client.name)} 様）</td><td></td><td></td><td class="r">${yen(sumPerson(r))}</td></tr>`
        )
        .join("")
    : `<tr><td>福祉用具貸与</td><td></td><td></td><td class="r">${yen(sumPerson(rep))}</td></tr>`;

  // ── 介護サービス費内訳 (介護の明細のみ。単位数 = 1 個あたり / 回数 = 数量) ──
  const careRow = (li: LineItem) => {
    const u = li.units ?? 0;
    return `<tr><td>${escapeHtml(li.name)}</td><td class="r">${yen(u)}</td><td class="c">${li.quantity}</td><td class="r">${yen(u * li.quantity)}単位</td></tr>`;
  };
  const careRowsHtml = isMerged
    ? group
        .filter((r) => r.lineItems.some((li) => li.units != null))
        .map((r) => {
          const items = r.lineItems.filter((li) => li.units != null);
          const sub = items.reduce((s, li) => s + (li.units ?? 0) * li.quantity, 0);
          return `<tr class="person"><td colspan="3">${escapeHtml(r.client.name)} 様</td><td class="r">${yen(sub)}単位</td></tr>${items.map(careRow).join("")}`;
        })
        .join("")
    : careItems.map(careRow).join("");
  const totalUnits = careItems.reduce((s, li) => s + (li.units ?? 0) * li.quantity, 0);

  const toName = `${escapeHtml(rep.client.name)} 様${isMerged ? ` 他 ${group.length - 1} 名` : ""}`;
  const userNames = group.map((r) => `${escapeHtml(r.client.name)} 様`).join("<br>");
  const postalCode = (rep.client as unknown as { postal_code?: string | null }).postal_code ?? "";

  return `
  <div class="sheet doc">
    <div class="titlebar">${title}</div>

    <div class="row top">
      <div class="col-l addr">
        <div>〒${escapeHtml(postalCode)}</div>
        <div>${escapeHtml(rep.client.address ?? "")}</div>
      </div>
      <div class="col-r issuer">
        ${issuer.legalName ? `<div>${escapeHtml(issuer.legalName)}</div>` : ""}
        <div>${escapeHtml(issuer.companyName)}</div>
        ${issuer.invoiceNumber ? `<div>登録番号：${escapeHtml(issuer.invoiceNumber)}</div>` : ""}
        ${issuer.companyAddress ? `<div>${escapeHtml(issuer.companyAddress)}</div>` : ""}
        <div>${issuer.tel ? `TEL：${escapeHtml(issuer.tel)}` : ""}${issuer.fax ? `　FAX：${escapeHtml(issuer.fax)}` : ""}</div>
        <div>※　押印は省略させていただきます。</div>
      </div>
    </div>

    <div class="row mid">
      <div class="col-l to">
        <div class="to-name">${toName}</div>
        ${isMerged ? `<div class="to-sub">（同一世帯合算）</div>` : ""}
      </div>
      <div class="col-r">
        <table class="box">
          <tr><th>居宅介護支援事業者名</th></tr>
          <tr><td>${escapeHtml(officeName)}</td></tr>
        </table>
        <table class="box mt">
          <colgroup><col style="width:52%"><col></colgroup>
          <tr><th colspan="2">支払い者名</th></tr>
          <tr><td>${escapeHtml(rep.client.name)} 様</td><td></td></tr>
        </table>
      </div>
    </div>

    <table class="box userline">
      <colgroup><col style="width:22%"><col style="width:12%"><col style="width:16%"><col style="width:16%"><col style="width:20%"><col></colgroup>
      <tr><th>利用者氏名</th><th></th><th></th><th></th><th>${dateLabel}</th><th></th></tr>
      <tr><td>${userNames}</td><td></td><td></td><td></td><td>${reiwaDateSpaced(issueDate)}</td><td></td></tr>
    </table>
    <div class="lead">${lead}</div>

    <div class="row amountrow">
      <div class="period">${reiwaMonth(billingMonth).replace(/^令和(\d+)年(\d+)月分$/, "令和 $1年 $2月分")}　${period}</div>
      <div class="amountbox">
        <div class="amountlabel">${amountLabel}</div>
        <div class="amountval">¥${yen(billed)}</div>
      </div>
    </div>

    <table class="grid">
      <colgroup><col><col style="width:9%"><col style="width:9%"><col style="width:11%"></colgroup>
      <tr><th>利用内訳</th><th>単価</th><th>数量</th><th>金　額</th></tr>
      ${allItems.length > 0 ? usageRows : `<tr><td colspan="4" class="empty">明細がありません</td></tr>`}
      <tr class="subline"><td class="indent">課税分　　${yen(taxableIncl)}円</td><td></td><td></td><td></td></tr>
      <tr class="subline last"><td class="indent">非課税分　${yen(nonTaxable)}円</td><td></td><td></td><td></td></tr>
      <tr class="total"><td colspan="3">合計</td><td class="r">${yen(billed)}</td></tr>
    </table>

    <table class="grid mt">
      <colgroup><col><col style="width:8%"><col style="width:6%"><col style="width:16%"></colgroup>
      <tr><th>介護サービス費内訳</th><th>単位数</th><th>回数</th><th>単位</th></tr>
      ${careRowsHtml || `<tr><td colspan="4" class="empty">介護保険の明細はありません</td></tr>`}
      <tr class="total"><td colspan="3">合計</td><td class="r">${yen(totalUnits)}単位</td></tr>
    </table>

    <div class="row calrow">
      <div class="legend">
        <div>○：介護サービス算定日</div>
        <div>□：サービス利用開始・終了日</div>
      </div>
      <div class="cal">
        <div class="cal-title">ご利用日</div>
        <table>
          <tr><th class="sun">日</th><th>月</th><th>火</th><th>水</th><th>木</th><th>金</th><th class="sat">土</th></tr>
          ${calRows.join("")}
        </table>
      </div>
    </div>

    <table class="grid mt">
      <colgroup><col><col style="width:16%"><col style="width:16%"></colgroup>
      <tr><th>消費税内訳</th><th>消費税対象額</th><th>消費税額</th></tr>
      <tr><td>10％対象</td><td class="r">${yen(taxableIncl)}</td><td class="r">${yen(tax)}</td></tr>
      <tr class="total"><td>合計</td><td class="r">${yen(taxableIncl)}</td><td class="r">${yen(tax)}</td></tr>
    </table>

    <div class="pageno">${invoiceNo ? `No.${escapeHtml(invoiceNo)}` : ""}　　[1枚中1枚目]</div>
  </div>`;
}

// 一覧 (管理帳票) の HTML を組み立てる
function buildListPage(rows: Row[], billingMonth: string, issuer: IssuerInfo): string {
  const body = rows
    .map((r, i) => {
      const status = r.invoice?.status ?? "未確定";
      const billed = r.invoice?.total_amount ?? r.computedTotal;
      const office = r.careOffice?.name ?? r.client.care_manager_org ?? "-";
      return `<tr>
        <td class="r mono">${i + 1}</td>
        <td class="c">${escapeHtml(status)}</td>
        <td>${escapeHtml(r.client.name)}</td>
        <td class="sub">${escapeHtml(office)}</td>
        <td class="c">${escapeHtml(r.invoice?.payment_method ?? "")}</td>
        <td class="r mono">¥${billed.toLocaleString()}</td>
        <td class="c">${r.invoice?.issued_date ? reiwaDate(r.invoice.issued_date) : ""}</td>
      </tr>`;
    })
    .join("");
  const total = rows.reduce((s, r) => s + (r.invoice?.total_amount ?? r.computedTotal), 0);
  return `
  <div class="sheet list">
    <div class="list-head">
      <h1>利用請求一覧（${reiwaMonth(billingMonth)}）</h1>
      <div class="list-co">${escapeHtml(issuer.companyName)}</div>
    </div>
    <table class="listtbl">
      <thead>
        <tr><th>No</th><th>状態</th><th>利用者名</th><th>事業所名</th><th>支払方法</th><th>請求額</th><th>請求書発行日</th></tr>
      </thead>
      <tbody>
        ${body || `<tr><td colspan="7" class="empty">対象がありません</td></tr>`}
        <tr class="total"><td colspan="5" class="r">合計（${rows.length}件）</td><td class="r mono">¥${total.toLocaleString()}</td><td></td></tr>
      </tbody>
    </table>
  </div>`;
}

// ポップアップブロックを避けるため、窓はクリック直後 (await より前) に開いておく
function openBlankPrintWindow(): Window | null {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) alert("印刷ウィンドウを開けませんでした。ポップアップブロックを解除してください。");
  return w;
}

function openPrintWindow(w: Window | null, inner: string, docTitle: string, layout: "invoice" | "list") {
  if (!w || w.closed) {
    alert("印刷ウィンドウが閉じられたため、印刷を中止しました。");
    return;
  }
  const pageCss =
    layout === "list"
      ? "@page { size: A4 portrait; margin: 12mm; }"
      : "@page { size: A4 portrait; margin: 12mm; }";
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(docTitle)}</title>
<style>
  ${pageCss}
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','Meiryo',sans-serif; color: #111; font-size: 12px; line-height: 1.5; }
  .mono { font-variant-numeric: tabular-nums; }
  .sheet { width: 186mm; margin: 0 auto; padding: 0 0 8mm; page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }

  /* 請求書 / 領収書 (ほのぼのの利用料請求書と同じ書式) */
  .doc { font-size: 12px; line-height: 1.35; position: relative; min-height: 270mm; }
  .doc .titlebar { width: 60%; margin: 0 auto 12px; background: #d4ead7; border-radius: 6px; height: 30px; display: flex; align-items: center; justify-content: center; font-size: 19px; font-weight: 700; letter-spacing: .08em; }
  .doc .row { display: flex; justify-content: space-between; }
  .doc .col-l { width: 47%; }
  .doc .col-r { width: 47%; }
  .doc .addr { font-size: 13px; padding-left: 2mm; }
  .doc .issuer { font-size: 12.5px; line-height: 1.25; }
  .doc .mid { align-items: center; margin-top: 4px; }
  .doc .to { padding-left: 6mm; }
  .doc .to-name { font-size: 17px; font-weight: 700; }
  .doc .to-sub { font-size: 11px; color: #444; margin-top: 2px; }
  .doc table { border-collapse: collapse; width: 100%; }
  .doc table.box th, .doc table.box td { border: 1px solid #111; padding: 1px 4px; height: 20px; font-size: 12.5px; }
  .doc table.box th { background: #d4ead7; font-weight: 700; text-align: center; }
  .doc .mt { margin-top: 4px; }
  .doc table.userline { margin-top: 4px; }
  .doc .lead { margin: 3px 0 0; font-size: 12.5px; }
  .doc .amountrow { align-items: flex-end; margin: 14px 0 3px; }
  .doc .period { font-size: 13px; font-weight: 700; }
  .doc .amountbox { width: 42mm; border: 2px solid #111; }
  .doc .amountlabel { background: #0d7a6f; color: #fff; text-align: center; font-size: 14px; font-weight: 700; padding: 2px 0; }
  .doc .amountval { text-align: right; font-size: 19px; font-weight: 700; padding: 0 6px; }
  .doc table.grid th, .doc table.grid td { border: 1px solid #111; padding: 1px 4px; height: 20px; }
  .doc table.grid th { background: #d4ead7; font-weight: 700; text-align: center; }
  .doc table.grid .r { text-align: right; font-variant-numeric: tabular-nums; }
  .doc table.grid .c { text-align: center; }
  .doc table.grid .indent { padding-left: 10mm; }
  .doc table.grid tr.subline td { border-top: 1px solid #bbb; }
  .doc table.grid tr.total td { border-top: 2px solid #111; font-weight: 700; }
  .doc table.grid tr.person td { background: #f3f8f4; font-weight: 600; }
  .doc table.grid .empty { text-align: center; color: #888; }
  .doc .calrow { align-items: flex-end; justify-content: flex-end; gap: 30mm; margin: 10px 0 6px; }
  .doc .legend { font-size: 10px; font-weight: 700; line-height: 1.3; }
  .doc .cal { width: 41mm; border: 2px solid #111; padding: 0 2px 4px; }
  .doc .cal-title { text-align: center; font-size: 13px; border-bottom: 1px solid #111; margin: 0 -2px 2px; }
  .doc .cal table th, .doc .cal table td { border: none; text-align: center; font-size: 10px; height: 17px; padding: 0; }
  .doc .cal table th { font-size: 12px; font-weight: 400; }
  .doc .cal .sun { color: #e11d48; }
  .doc .cal .sat { color: #2563eb; }
  .doc .cal span.ci { display: inline-block; min-width: 14px; height: 14px; line-height: 12px; border: 1px solid currentColor; border-radius: 50%; }
  .doc .cal span.sq { display: inline-block; min-width: 14px; height: 14px; line-height: 12px; border: 1px solid currentColor; }
  .doc .pageno { position: absolute; right: 0; bottom: 0; font-size: 12px; }

  /* 一覧 */
  .list-head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 8px; }
  .list-head h1 { font-size: 16px; margin: 0; }
  .list-co { font-size: 12px; }
  table.listtbl { width: 100%; border-collapse: collapse; font-size: 11px; }
  table.listtbl th, table.listtbl td { border: 1px solid #9ca3af; padding: 4px 6px; }
  table.listtbl th { background: #f3f4f6; }
  table.listtbl .r { text-align: right; }
  table.listtbl .c { text-align: center; }
  table.listtbl .sub { font-size: 10px; color: #555; }
  table.listtbl tr.total td { background: #eef2f7; font-weight: 700; }
  table.listtbl .empty { text-align: center; color: #999; padding: 16px; }
</style></head>
<body>${inner}
<script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

export default function UserBillingTab({
  tenantId,
  currentOfficeId,
  clients,
  orderItems,
  orders,
  equipment,
  insuranceRecords,
  priceHistory = EMPTY_PRICE_HISTORY,
  dataLoading,
}: {
  tenantId: string;
  currentOfficeId: string | null;
  clients: Client[];
  orderItems: OrderItem[];
  orders: Order[];
  equipment: Equipment[];
  insuranceRecords: BillingCertRow[];
  /** 用具の価格履歴 (請求と同じ月の価格で基本単位を出す)。無ければ用具マスタの現在価格 */
  priceHistory?: EquipmentPriceHistory[];
  dataLoading: boolean;
}) {
  const [billingMonth, setBillingMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [targetSet, setTargetSet] = useState<Set<string>>(new Set());
  const [mergedSet, setMergedSet] = useState<Set<string>>(new Set());
  const [invoiceMap, setInvoiceMap] = useState<Map<string, BillingUserInvoice>>(new Map());
  const [careOffices, setCareOffices] = useState<CareOffice[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(false);
  const [saving, setSaving] = useState(false);

  const [y, m] = billingMonth.split("-").map(Number);
  const prevMonth = () => {
    const d = new Date(y, m - 2, 1);
    setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };
  const nextMonth = () => {
    const d = new Date(y, m, 1);
    setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  // 居宅マスタ (列「事業所名」表示用)
  useEffect(() => {
    getCareOffices(tenantId).then(setCareOffices).catch(console.error);
  }, [tenantId]);

  // 介護の単位計算の材料 (BillingTab・貸与報告書と同じ): 日割り設定 / 休止 / 入院 (lib/rentalCalcContext.ts)。
  //   どれも読めないときは その分を除かずに計算し、画面に理由を 1 行出す (黙って違う額にしない)
  const calc = useRentalCalcContext(tenantId);
  const calcNotices = calc?.notices ?? [];


  // 当月に対象月が掛かる insurance_record
  const getActiveInsuranceRecord = (clientId: string): BillingCertRow | null => {
    const monthStart = `${billingMonth}-01`;
    const monthEnd = monthEndYmd(y, m);
    const recs = insuranceRecords
      .filter((r) => r.client_id === clientId)
      .sort((a, b) => (b.effective_date ?? "").localeCompare(a.effective_date ?? ""));
    return (
      recs.find((r) => {
        const start = r.certification_start_date ?? r.effective_date;
        const end = r.certification_end_date;
        if (start && start > monthEnd) return false;
        if (end && end < monthStart) return false;
        return true;
      }) ?? null
    );
  };

  // ── 当月の対象 client × 明細を算出 ────────────────────────────────────
  const rows: Row[] = useMemo(() => {
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);

    // client_id → LineItem[]
    const byClient = new Map<string, LineItem[]>();

    for (const item of orderItems) {
      const order = orders.find((o) => o.id === item.order_id);
      if (!order?.client_id) continue;
      if (currentOfficeId && order.office_id && order.office_id !== currentOfficeId) continue;
      const pt = item.payment_type ?? order.payment_type ?? "介護";
      if (!item.rental_start_date) continue;
      const start = parseLocalDate(item.rental_start_date);
      if (start > monthEnd) continue;
      if (item.status === "terminated" && item.rental_end_date) {
        const end = parseLocalDate(item.rental_end_date);
        if (end < monthStart) continue;
      }
      if (item.status !== "rental_started" && item.status !== "terminated") continue;

      const eq = equipment.find((e) => e.product_code === item.product_code);
      const eqName = eq?.name ?? item.product_code;

      if (pt === "介護") {
        // 介護自己負担分: 単位数 * 10 円 * (1 - 給付率%/100)。
        // 基本単位 = 当月の価格 / 10。価格は 請求 (BillingTab の getUnits) と同じ 価格履歴 (getPriceForMonth) → 用具マスタ の順。
        // 当月の算定単位は 請求・伝送と同じ rentalMonthUnits
        // (既定 = 半月按分の自動 / 明細×月で「日割り」を選んだ月 = 日割り)。入院・休止の日は貸与日に数えない。
        const price = getPriceForMonth(priceHistory, item.product_code, billingMonth) ?? eq?.rental_price ?? 0;
        const baseUnits = price ? Math.round(price / 10) : 0;
        const units = rentalMonthUnits(baseUnits, item.rental_start_date, item.rental_end_date, billingMonth,
          excludedOf(calc, order.client_id, item.id), modeOf(calc, item.id, billingMonth));

        const insRec = getActiveInsuranceRecord(order.client_id);
        const benefitRateStr =
          insRec?.benefit_rate ??
          clients.find((c) => c.id === order.client_id)?.benefit_rate ??
          "90";
        const benefitRate = parseInt(benefitRateStr, 10);
        const copayRate = isNaN(benefitRate) ? 10 : Math.max(0, 100 - benefitRate);
        const gross = units * UNIT_PRICE_YEN * item.quantity; // 円 (税抜)
        const copay = Math.round((gross * copayRate) / 100);
        if (copay > 0) {
          const list = byClient.get(order.client_id) ?? [];
          list.push({
            key: item.id,
            kind: "福祉用具貸与",
            name: eqName,
            unit_price: units * UNIT_PRICE_YEN, // 1 個あたりの介護費用 (税抜)
            quantity: item.quantity,
            amount: copay,
            tax_amount: 0,
            is_taxable: false,
            units,
            rental_start_date: item.rental_start_date,
            rental_end_date: item.rental_end_date ?? null,
            office_id: order.office_id ?? null,
          });
          byClient.set(order.client_id, list);
        }
      } else if (pt === "自費" || pt === "特価自費") {
        // 自費レンタル: rental_price * quantity (税込)
        const unitPrice = item.rental_price ?? eq?.rental_price ?? 0;
        if (unitPrice <= 0) continue;
        const grossInclTax = unitPrice * item.quantity;
        const amount = Math.round(grossInclTax / (1 + TAX_RATE));
        const tax = grossInclTax - amount;
        const list = byClient.get(order.client_id) ?? [];
        list.push({
          key: item.id,
          kind: "自費レンタル",
          name: eqName,
          unit_price: unitPrice,
          quantity: item.quantity,
          amount,
          tax_amount: tax,
          is_taxable: true,
          units: null,
          rental_start_date: item.rental_start_date,
          rental_end_date: item.rental_end_date ?? null,
          office_id: order.office_id ?? null,
        });
        byClient.set(order.client_id, list);
      }
    }

    const result: Row[] = [];
    for (const client of clients) {
      const items = byClient.get(client.id);
      if (!items || items.length === 0) continue;
      const ins = getActiveInsuranceRecord(client.id);
      const careOfficeId = client.care_office_id ?? ins?.care_office_id ?? null;
      const careOffice = careOfficeId ? careOffices.find((co) => co.id === careOfficeId) ?? null : null;
      const computedTax = items.reduce((s, it) => s + it.tax_amount, 0);
      const computedTotal = items.reduce((s, it) => s + it.amount + it.tax_amount, 0);
      result.push({
        client,
        ins,
        careOffice,
        lineItems: items,
        computedTotal,
        computedTax,
        invoice: invoiceMap.get(client.id) ?? null,
      });
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability (MonthlyInfoTab と同じ pattern)
  }, [
    clients,
    orderItems,
    orders,
    equipment,
    billingMonth,
    currentOfficeId,
    insuranceRecords,
    careOffices,
    invoiceMap,
    calc,
    priceHistory,
  ]);

  // かな行フィルター
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- 単純 derive、React Compiler 任せでも同等
  const filteredRows = useMemo(() => {
    if (!kanaFilter) return rows;
    return rows.filter(({ client }) => {
      const first = toKana((client.furigana ?? client.name).charAt(0));
      return kanaFilter === "他"
        ? !USER_BILLING_ALL_KANA.includes(first)
        : (USER_BILLING_KANA_MAP[kanaFilter] ?? []).includes(first);
    });
  }, [rows, kanaFilter]);

  const sortedRows = useMemo(
    () =>
      filteredRows.slice().sort((a, b) => {
        // 施設は末尾に、個人利用者を先頭に
        const fa = a.client.is_facility ? 1 : 0;
        const fb = b.client.is_facility ? 1 : 0;
        if (fa !== fb) return fa - fb;
        return (a.client.furigana ?? a.client.name).localeCompare(b.client.furigana ?? b.client.name, "ja");
      }),
    [filteredRows]
  );

  // 既存 invoice を月切替時に取得
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setLoadingInvoices(true);
    getUserInvoices(tenantId, billingMonth)
      .then((invs) => {
        const map = new Map<string, BillingUserInvoice>();
        invs.forEach((inv) => map.set(inv.client_id, inv));
        setInvoiceMap(map);
      })
      .catch(console.error)
      .finally(() => setLoadingInvoices(false));
  }, [tenantId, billingMonth]);

  // 選択行が表示中の sortedRows に無ければ自動的に null になる (derived)。
  // 明示的な setState 不要。
  const selectedRow = useMemo(
    () => sortedRows.find((r) => r.client.id === selectedClientId) ?? null,
    [sortedRows, selectedClientId]
  );

  // 件数/合計
  const totals = useMemo(() => {
    const count = sortedRows.length;
    const confirmedCount = sortedRows.filter(
      (r) => r.invoice && (r.invoice.status === "確定" || r.invoice.status === "入金完")
    ).length;
    const totalSum = sortedRows.reduce(
      (s, r) => s + (r.invoice?.total_amount ?? r.computedTotal),
      0
    );
    const confirmedSum = sortedRows
      .filter((r) => r.invoice && (r.invoice.status === "確定" || r.invoice.status === "入金完"))
      .reduce((s, r) => s + (r.invoice?.total_amount ?? r.computedTotal), 0);
    return { count, confirmedCount, totalSum, confirmedSum };
  }, [sortedRows]);

  // 選択行のフッタ詳細
  const selectedSummary = useMemo(() => {
    if (!selectedRow) {
      return {
        amount: totals.totalSum,
        overpaid: 0,
        discount: 0,
        medical: 0,
        tax: sortedRows.reduce((s, r) => s + r.computedTax, 0),
        billed: totals.totalSum,
      };
    }
    const inv = selectedRow.invoice;
    const amount = inv?.total_amount ?? selectedRow.computedTotal;
    return {
      amount,
      overpaid: inv?.overpaid_offset_amount ?? 0,
      discount: inv?.discount_amount ?? 0,
      medical: inv?.medical_deduction_amount ?? 0,
      tax: inv?.tax_amount ?? selectedRow.computedTax,
      billed: amount - (inv?.overpaid_offset_amount ?? 0) - (inv?.discount_amount ?? 0),
    };
  }, [selectedRow, totals, sortedRows]);

  // ── DB 書き込み helpers ───────────────────────────────────────────────
  const persistInvoice = async (
    row: Row,
    patch: {
      payment_method?: string | null;
      issued_date?: string | null;
      status?: BillingUserInvoiceStatus;
      invoice_no?: number | null;
      invoice_year?: number | null;
    }
  ): Promise<BillingUserInvoice | null> => {
    setSaving(true);
    try {
      const next = await upsertUserInvoice({
        tenant_id: tenantId,
        client_id: row.client.id,
        month: billingMonth,
        status: patch.status ?? row.invoice?.status ?? "未確定",
        payment_method: patch.payment_method ?? row.invoice?.payment_method ?? null,
        issued_date: patch.issued_date ?? row.invoice?.issued_date ?? null,
        total_amount: row.invoice?.total_amount ?? row.computedTotal,
        tax_amount: row.invoice?.tax_amount ?? row.computedTax,
        discount_amount: row.invoice?.discount_amount ?? 0,
        medical_deduction_amount: row.invoice?.medical_deduction_amount ?? 0,
        overpaid_offset_amount: row.invoice?.overpaid_offset_amount ?? 0,
        notes: row.invoice?.notes ?? null,
        invoice_no: patch.invoice_no ?? row.invoice?.invoice_no ?? null,
        invoice_year: patch.invoice_year ?? row.invoice?.invoice_year ?? null,
      });
      setInvoiceMap((prev) => new Map(prev).set(next.client_id, next));
      return next;
    } catch (err) {
      console.error(err);
      alert("保存に失敗しました");
      return null;
    } finally {
      setSaving(false);
    }
  };

  // 未採番なら発行番号を確保して返す (採番済ならそのまま)。返り値は表示用文字列。
  const ensureInvoiceNo = async (row: Row): Promise<string | null> => {
    const inv = row.invoice ?? invoiceMap.get(row.client.id) ?? null;
    if (inv?.invoice_no != null && inv?.invoice_year != null) {
      return formatInvoiceNo(inv.invoice_year, inv.invoice_no);
    }
    const year = new Date().getFullYear();
    const no = await getNextUserInvoiceNo(tenantId, year);
    const next = await persistInvoice(row, { invoice_no: no, invoice_year: year });
    if (!next || next.invoice_no == null || next.invoice_year == null) return null;
    return formatInvoiceNo(next.invoice_year, next.invoice_no);
  };

  const changeStatus = async (row: Row, status: BillingUserInvoiceStatus) => {
    // 確定時は未採番なら発行番号を採番してから確定する
    if (status === "確定" && (row.invoice?.invoice_no == null)) {
      const year = new Date().getFullYear();
      const no = await getNextUserInvoiceNo(tenantId, year);
      await persistInvoice(row, { status, invoice_no: no, invoice_year: year });
      return;
    }
    // 確定 / 入金完 化時は計算済値で必ず upsert
    if (!row.invoice) {
      await persistInvoice(row, { status });
      return;
    }
    setSaving(true);
    try {
      await updateUserInvoiceStatus(row.invoice.id, status);
      setInvoiceMap((prev) =>
        new Map(prev).set(row.client.id, { ...row.invoice!, status })
      );
    } catch (err) {
      console.error(err);
      alert("状態変更に失敗しました");
    } finally {
      setSaving(false);
    }
  };

  // ── 帳票印刷 ───────────────────────────────────────────────────────────
  // 対象 (チェック済) の行。無ければ表示中の全行を対象にする。
  const printTargetRows = (): Row[] => {
    const checked = sortedRows.filter((r) => targetSet.has(r.client.id));
    return checked.length > 0 ? checked : sortedRows;
  };

  // 名寄せ: mergedSet かつ同一住所の利用者を 1 グループ (世帯合算) に。
  // それ以外は 1 名 1 グループ。
  const groupForPrint = (targets: Row[]): Row[][] => {
    const singles: Row[][] = [];
    const householdMap = new Map<string, Row[]>();
    for (const r of targets) {
      const addr = (r.client.address ?? "").trim();
      if (mergedSet.has(r.client.id) && addr) {
        const g = householdMap.get(addr) ?? [];
        g.push(r);
        householdMap.set(addr, g);
      } else {
        singles.push([r]);
      }
    }
    const merged: Row[][] = [];
    for (const g of householdMap.values()) merged.push(g); // 1 名でもグループ扱い (単独表示)
    return [...singles, ...merged];
  };

  // 帳票の発行元を事業所ごとに引く (事業所ごとの設定 > マスタ > グループ共通)。
  // 読めなければ空欄で印字し、理由を alert で出す (黙って「○○福祉用具」等を印字しない)。
  const loadIssuers = async (officeIds: (string | null)[]): Promise<Map<string, IssuerInfo>> => {
    const out = new Map<string, IssuerInfo>();
    const errors: string[] = [];
    for (const oid of new Set(officeIds)) {
      const key = oid ?? "";
      try {
        const r = await getOfficeCompanyInfo(tenantId, oid);
        out.set(key, issuerFromCompanyInfo(r.info));
      } catch (err) {
        console.error("発行元 (会社情報) の取得に失敗:", err);
        errors.push(err instanceof Error ? err.message : String(err));
        out.set(key, issuerFromCompanyInfo(toCompanyInfo(emptyCompanyInfoRow())));
      }
    }
    if (errors.length > 0) alert(`発行元 (会社情報) を読めませんでした。発行元欄は空欄で印字します。
${errors[0]}`);
    return out;
  };

  // 名寄せグループの発行元事業所: 画面で事業所を選んでいればそれ、無ければ明細の発注事業所が 1 つに決まるときだけ
  const officeForGroup = (g: Row[]): string | null => {
    if (currentOfficeId) return currentOfficeId;
    const ids = new Set(g.flatMap((r) => r.lineItems.map((li) => li.office_id)).filter((v): v is string => !!v));
    return ids.size === 1 ? [...ids][0] : null;
  };

  const printDocs = async (mode: "invoice" | "receipt") => {
    const targets = printTargetRows();
    if (targets.length === 0) {
      alert("対象月に請求対象の利用者がいません。");
      return;
    }
    const w = openBlankPrintWindow();
    if (!w) return;
    const issue = todayIso();
    const groups = groupForPrint(targets);
    const issuers = await loadIssuers(groups.map(officeForGroup));

    // 発行番号: 請求書は未採番なら採番、領収書は既存番号があれば流用のみ
    const noMap = new Map<string, string>();
    for (const g of groups) {
      const rep = g[0];
      if (mode === "invoice") {
        const no = await ensureInvoiceNo(rep);
        if (no) noMap.set(rep.client.id, no);
      } else {
        const inv = rep.invoice ?? invoiceMap.get(rep.client.id) ?? null;
        if (inv?.invoice_no != null && inv?.invoice_year != null) {
          noMap.set(rep.client.id, formatInvoiceNo(inv.invoice_year, inv.invoice_no));
        }
      }
    }

    const inner = groups
      .map((g) => buildDocPage(g, mode, issuers.get(officeForGroup(g) ?? "")!, billingMonth, issue, noMap.get(g[0].client.id) ?? null))
      .join("");
    openPrintWindow(w, inner, mode === "invoice" ? "利用料請求書" : "利用料領収書", "invoice");
  };

  const printList = async () => {
    if (sortedRows.length === 0) {
      alert("対象月に請求対象の利用者がいません。");
      return;
    }
    const w = openBlankPrintWindow();
    if (!w) return;
    const info = (await loadIssuers([currentOfficeId])).get(currentOfficeId ?? "")!;
    openPrintWindow(w, buildListPage(sortedRows, billingMonth, info), "利用請求一覧", "list");
  };

  if (dataLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  const checkedCount = sortedRows.filter((r) => targetSet.has(r.client.id)).length;
  const printScopeLabel = checkedCount > 0 ? `対象 ${checkedCount} 名` : `全 ${sortedRows.length} 名`;

  const statusBadge = (status: BillingUserInvoiceStatus | "未確定") => {
    if (status === "入金完")
      return <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 text-[10px] font-semibold">入金完</span>;
    if (status === "確定")
      return <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-semibold">確定</span>;
    return <span className="inline-block whitespace-nowrap px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px] font-semibold">未確定</span>;
  };

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: かな行フィルター */}
      <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
        <button
          onClick={() => setKanaFilter(null)}
          className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
        >
          全
        </button>
        {USER_BILLING_KANA_ROWS.map((k) => (
          <button
            key={k}
            onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
            className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
          >
            {k}
          </button>
        ))}
      </div>

      {/* 中央 + 右ペイン */}
      <div className="flex flex-1 min-w-0">
        {/* 中央: ツールバー + テーブル + フッタ */}
        <div className="flex-[1_1_1120px] max-w-[1120px] flex flex-col min-w-0 border-r border-gray-200">
          {/* 単位計算の材料が読めないときの注記 (日割り設定表の未適用 等)。黙って違う額にしない */}
          {calcNotices.length > 0 && (
            <div className="border-b border-amber-200 bg-amber-50 px-3 py-1 text-[11px] text-amber-800 shrink-0">
              {calcNotices.join(" / ")}
            </div>
          )}
          {/* ツールバー */}
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-0.5 border border-gray-300 rounded bg-white px-2 py-1">
              <button onClick={prevMonth} className="text-gray-500 hover:text-gray-800">
                <ChevronLeft size={14} />
              </button>
              <span className="font-semibold text-gray-800 px-1.5">
                {jpReiwa(y)}/{m}
              </span>
              <button onClick={nextMonth} className="text-gray-500 hover:text-gray-800">
                <ChevronRight size={14} />
              </button>
            </div>
            <span className="text-xs text-gray-500 ml-2">{sortedRows.length} 件</span>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            {/* 帳票出力 */}
            <button
              onClick={printList}
              className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50 flex items-center gap-1.5 text-xs"
              title="この一覧を印刷"
            >
              <Printer size={13} />
              印刷
            </button>
            <button
              onClick={() => printDocs("invoice")}
              className="border border-emerald-500 rounded bg-emerald-50 px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 flex items-center gap-1.5 text-xs font-medium"
              title={`請求書を発行（${printScopeLabel}）`}
            >
              <FileText size={13} />
              請求書
            </button>
            <button
              onClick={() => printDocs("receipt")}
              className="border border-emerald-500 rounded bg-emerald-50 px-2.5 py-1 text-emerald-700 hover:bg-emerald-100 flex items-center gap-1.5 text-xs font-medium"
              title={`領収書を発行（${printScopeLabel}）`}
            >
              <Receipt size={13} />
              領収書
            </button>
            <span className="text-[11px] text-gray-400">{printScopeLabel}</span>
            {(loadingInvoices || saving) && (
              <Loader2 size={14} className="animate-spin text-indigo-400 ml-2" />
            )}
          </div>

          {/* テーブル */}
          <div className="flex-1 overflow-auto">
            {/* 横長対策: 全幅に引き伸ばさず最大幅で止める (利用者名と請求額が離れすぎないように) */}
            <table className="w-full max-w-[1100px] text-xs border-collapse tabular-nums">
              <thead className="bg-gray-100 text-gray-700 sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-1.5 border border-gray-300 text-center w-10">対象</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-center w-10">名寄</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-center w-16">状態</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-left">利用者名</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-left">事業所名</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-left w-16">番号</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-left w-24">支払方法</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-right w-24">請求額</th>
                  <th className="px-2 py-1.5 border border-gray-300 text-left w-28">請求書発行日</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, idx) => {
                  const { client, careOffice, invoice } = row;
                  const status: BillingUserInvoiceStatus = invoice?.status ?? "未確定";
                  const billedAmount = invoice?.total_amount ?? row.computedTotal;
                  const seq = idx + 1; // 連番 (画面表示用)
                  const isSelected = selectedClientId === client.id;
                  return (
                    <tr
                      key={client.id}
                      className={`cursor-pointer ${isSelected ? "bg-indigo-50" : "hover:bg-blue-50"}`}
                      onClick={() => setSelectedClientId(client.id)}
                    >
                      <td className="px-2 py-1 border border-gray-200 text-center">
                        <input
                          type="checkbox"
                          checked={targetSet.has(client.id)}
                          onChange={(e) => {
                            e.stopPropagation();
                            setTargetSet((prev) => {
                              const next = new Set(prev);
                              if (next.has(client.id)) next.delete(client.id);
                              else next.add(client.id);
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-1 border border-gray-200 text-center">
                        <input
                          type="checkbox"
                          checked={mergedSet.has(client.id)}
                          onChange={(e) => {
                            e.stopPropagation();
                            setMergedSet((prev) => {
                              const next = new Set(prev);
                              if (next.has(client.id)) next.delete(client.id);
                              else next.add(client.id);
                              return next;
                            });
                          }}
                          onClick={(e) => e.stopPropagation()}
                          title="名寄せ (チェックした同一住所の利用者を請求書/領収書 1 枚に世帯合算)"
                        />
                      </td>
                      <td className="px-2 py-1 border border-gray-200 text-center">
                        {statusBadge(status)}
                      </td>
                      <td className="px-2 py-1 border border-gray-200">{client.name}</td>
                      <td
                        className="px-2 py-1 border border-gray-200 truncate max-w-[200px]"
                        title={careOffice?.name ?? ""}
                      >
                        {careOffice?.name ?? client.care_manager_org ?? "-"}
                      </td>
                      <td className="px-2 py-1 border border-gray-200 font-mono">
                        {invoice?.invoice_no != null && invoice?.invoice_year != null
                          ? formatInvoiceNo(invoice.invoice_year, invoice.invoice_no)
                          : `${client.user_number ?? "-"}-${seq}`}
                      </td>
                      <td
                        className="px-2 py-1 border border-gray-200"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <select
                          value={invoice?.payment_method ?? ""}
                          onChange={(e) => persistInvoice(row, { payment_method: e.target.value || null })}
                          className="w-full bg-transparent border-0 text-xs focus:bg-white focus:border focus:border-indigo-300 focus:outline-none rounded px-1 py-0.5"
                        >
                          {PAYMENT_METHOD_OPTIONS.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt || "—"}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-1 border border-gray-200 text-right font-mono">
                        ¥{billedAmount.toLocaleString()}
                      </td>
                      <td
                        className="px-2 py-1 border border-gray-200"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="date"
                          value={invoice?.issued_date ?? ""}
                          onChange={(e) => persistInvoice(row, { issued_date: e.target.value || null })}
                          className="w-full bg-transparent border-0 text-xs focus:bg-white focus:border focus:border-indigo-300 focus:outline-none rounded px-1 py-0.5"
                        />
                        {invoice?.issued_date && (
                          <span className="text-[10px] text-gray-400 ml-1">
                            {formatIssuedDateReiwa(invoice.issued_date)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {sortedRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-8 text-center text-gray-400 text-sm">
                      対象月に請求対象の利用者がいません
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* フッタ: 総合計 + 選択行詳細 */}
          <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-xs">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-700 tabular-nums">
              <span>
                件数合計 <span className="font-mono font-semibold">{totals.count.toLocaleString()}</span>
              </span>
              <span>
                請求額合計{" "}
                <span className="font-mono font-semibold">¥{totals.totalSum.toLocaleString()}</span>
              </span>
              <span className="text-gray-500">
                確 件数合計{" "}
                <span className="font-mono font-semibold">{totals.confirmedCount.toLocaleString()}</span>
              </span>
              <span className="text-gray-500">
                確定請求額合計{" "}
                <span className="font-mono font-semibold">¥{totals.confirmedSum.toLocaleString()}</span>
              </span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-gray-600 tabular-nums">
              <span>
                合計金額 <span className="font-mono">¥{selectedSummary.amount.toLocaleString()}</span>
              </span>
              <span>
                過入金充当額{" "}
                <span className="font-mono">¥{selectedSummary.overpaid.toLocaleString()}</span>
              </span>
              <span>
                軽減額 <span className="font-mono">¥{selectedSummary.discount.toLocaleString()}</span>
              </span>
              <span>
                医療費控除対象額{" "}
                <span className="font-mono">¥{selectedSummary.medical.toLocaleString()}</span>
              </span>
              <span>
                消費税額 <span className="font-mono">¥{selectedSummary.tax.toLocaleString()}</span>
              </span>
              <span className="font-semibold text-gray-800">
                請求金額 <span className="font-mono">¥{selectedSummary.billed.toLocaleString()}</span>
              </span>
            </div>
          </div>
        </div>

        {/* 右ペイン: 利用明細欄 */}
        <div className="flex-[1_1_20rem] min-w-80 flex flex-col bg-white">
          <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700">利用明細欄</span>
            {selectedRow && (
              <span className="text-xs text-gray-500 truncate max-w-[160px]">
                {selectedRow.client.name}
              </span>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            {!selectedRow && (
              <div className="p-4 text-center text-gray-400 text-xs">
                左の行をクリックすると明細が表示されます
              </div>
            )}
            {selectedRow && (
              <>
                <table className="w-full text-xs border-collapse">
                  <thead className="bg-gray-50 text-gray-600">
                    <tr>
                      <th className="px-2 py-1 border-b border-gray-200 text-left">利用料項目</th>
                      <th className="px-2 py-1 border-b border-gray-200 text-right w-16">単価</th>
                      <th className="px-2 py-1 border-b border-gray-200 text-right w-10">数量</th>
                      <th className="px-2 py-1 border-b border-gray-200 text-right w-20">金額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRow.lineItems.map((li) => (
                      <tr key={li.key} className="border-b border-gray-100">
                        <td className="px-2 py-1">
                          <div className="text-gray-700">{li.kind}</div>
                          <div className="text-[11px] text-gray-500 truncate" title={li.name}>
                            {li.name}
                          </div>
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          ¥{li.unit_price.toLocaleString()}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">{li.quantity}</td>
                        <td className="px-2 py-1 text-right font-mono">
                          ¥{li.amount.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="px-3 py-2 border-t border-gray-200 text-xs space-y-0.5">
                  {selectedRow.lineItems.some((li) => li.is_taxable) && (
                    <div className="flex justify-between text-gray-600">
                      <span>課税分</span>
                      <span className="font-mono">
                        ¥
                        {selectedRow.lineItems
                          .filter((li) => li.is_taxable)
                          .reduce((s, li) => s + li.amount, 0)
                          .toLocaleString()}
                      </span>
                    </div>
                  )}
                  {selectedRow.computedTax > 0 && (
                    <div className="flex justify-between text-gray-600">
                      <span>消費税 (10%)</span>
                      <span className="font-mono">¥{selectedRow.computedTax.toLocaleString()}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-gray-800 font-semibold pt-1 border-t border-gray-100 mt-1">
                    <span>合計</span>
                    <span className="font-mono">¥{selectedRow.computedTotal.toLocaleString()}</span>
                  </div>
                </div>

                {/* 状態 transition */}
                <div className="px-3 py-2 border-t border-gray-200 flex flex-wrap gap-1.5">
                  {(selectedRow.invoice?.status ?? "未確定") === "未確定" && (
                    <button
                      onClick={() => changeStatus(selectedRow, "確定")}
                      disabled={saving}
                      className="border border-blue-500 rounded bg-blue-500 text-white text-xs px-2.5 py-1 font-semibold hover:bg-blue-600 disabled:opacity-50"
                    >
                      請求確定
                    </button>
                  )}
                  {selectedRow.invoice?.status === "確定" && (
                    <>
                      <button
                        onClick={() => changeStatus(selectedRow, "入金完")}
                        disabled={saving}
                        className="border border-emerald-500 rounded bg-emerald-500 text-white text-xs px-2.5 py-1 font-semibold hover:bg-emerald-600 disabled:opacity-50"
                      >
                        入金完
                      </button>
                      <button
                        onClick={() => changeStatus(selectedRow, "未確定")}
                        disabled={saving}
                        className="border border-gray-400 rounded bg-white text-gray-700 text-xs px-2.5 py-1 font-medium hover:bg-gray-50 disabled:opacity-50"
                      >
                        確定取消
                      </button>
                    </>
                  )}
                  {selectedRow.invoice?.status === "入金完" && (
                    <button
                      onClick={() => changeStatus(selectedRow, "確定")}
                      disabled={saving}
                      className="border border-gray-400 rounded bg-white text-gray-700 text-xs px-2.5 py-1 font-medium hover:bg-gray-50 disabled:opacity-50"
                    >
                      入金取消
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
