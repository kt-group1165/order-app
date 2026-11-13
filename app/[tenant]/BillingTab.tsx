"use client";

import { useState, useEffect, useRef, useMemo, useCallback, useTransition, memo } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, ChevronLeft, X, Loader2, Printer, Download } from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Supplier, EquipmentPriceHistory, ClientHospitalization } from "@/lib/supabase";
import { monthEndYmd, toJapaneseEra, toJapaneseEraYM } from "@/lib/date-jst";
import { type CompanyInfo, COMPANY_INFO_DEFAULTS } from "./company-info";
import { getOfficeCompanyInfo } from "@/lib/officeCompanyInfo";
import { HW_KANA } from "./search-utils";
import { itemMonthUnits, hasBrokenRentalDates, isKeidoRestricted, RESTRICTION_GROUP_OF_CATEGORY } from "./order-item-helpers";
import { getExceptionGrants, hasActiveGrant, isTableMissingError, getAllExceptionGrants, getExceptionInsurerRules, type FukuyoguExceptionGrant } from "@/lib/fukuyoguExceptions";
import { judgeClientExceptions, findInsurerRule, describeJudgement, type ExceptionInsurerRule, type ExceptionJudgement, type ExceptionAlertLevel } from "@/lib/fukuyoguExceptionRules";
import { rentalMonthUnits, hospitalizationRanges, rentalDayMask, halfMonthFlags, type DateRange } from "@/lib/half-month-units";
import { firstBy, groupBy } from "@/lib/index-by";
import { useRentalCalcContext, excludedOf, modeOf } from "@/lib/rentalCalcContext";
import { loadProrations, prorationModeOf, type ProrationLoad } from "@/lib/orderItemProration";
import { loadOrderItemPauses, type PausesLoad } from "@/lib/fukuyoguPauses";

/** 休止が読めていない間の空 Map (毎回 new すると useMemo の依存が変わり続ける) */
const EMPTY_PAUSES: Map<string, DateRange[]> = new Map();
import { getAllOrders, getAllOrderItemsByTenant } from "@/lib/orders";
import { getEquipment, getSuppliers, getPriceHistory, getPriceForMonth } from "@/lib/equipment";
import { getClientsCols } from "@/lib/clients";
import { getTenantById } from "@/lib/tenants";
import { getOffices, type Office } from "@/lib/offices";
import {
  getLateFlags, setLateFlag, removeLateFlag,
  getUnitOverrides,
  getRebillFlags, setRebillFlag, removeRebillFlag,
  type BillingLateFlag, type BillingRebillFlag,
} from "@/lib/billing";
import { getCareOffices, type CareOffice } from "@/lib/careOffices";
import Encoding from "encoding-japanese";
import { buildFukuyoguDensou, careLevelCodeForDensou, fukuyoguServiceCode, fukuyoguRentalDaysInMonth, fukuyoguPlanKubunCode, FUKUYOGU_PLAN_KUBUN_LABEL, isYoboCareLevel, type FukuyoguSeikyuRow, type FukuyoguDetailLine } from "@/lib/kokuho-densou/build";
import { computeFukuyoguAmounts, capFukuyoguUnits, normalizeCmUnits, kohiCoverageInMonth, isKohiMonthMode, KOHI_MONTH_MODES, KOHI_MONTH_MODE_LABEL, KOHI_MONTH_MODE_DEFAULT, type FukuyoguKohi, type FukuyoguLineInput, type KohiMonthMode } from "@/lib/kokuho-densou/fukuyogu-amounts";
import { getCmUnits, saveCmUnits } from "@/lib/fukuyoguCmUnits";
import { loadKohiForMonth, getKohiMonthModes, saveKohiMonthMode } from "@/lib/fukuyoguKohiMonth";
import { pickCertForMonth, certFieldsForDensou } from "@/lib/kokuho-densou/cert-for-month";
import { fukuyoguServiceStartDate } from "@/lib/kokuho-densou/fukuyogu-period";
import { resolveBenefitForMonth } from "@/lib/insurance/cert-month";
import { BILLING_CLIENT_COLS, type BillingClient } from "@/lib/billing-client-cols";
import { BILLING_CERT_SELECT, type BillingCertRow } from "@/lib/insurance/billing-cert-cols";
import { loadBenefitCertificates, type BenefitCertsLoad } from "@/lib/insurance/benefit-certs";
import { loadPerOfficeOfficeIds, isPerOffice, rowsForOffice } from "@/lib/insurance/office-scope";
import { findRentalOverruns, indexCeilings, type CeilingRentalLine } from "@/lib/ceilingCheck";
import { getCeilingPrices } from "@/lib/ceilingPrices";
import { selectAllPagedParallel } from "@/lib/pagedParallel";
import { buildFukuyoguJissekiCsv, type FukuyoguJissekiUser } from "@/lib/careplan-v4/build-jisseki";

const UserBillingTab = dynamic(() => import("./UserBillingTab"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center py-20 text-gray-400">
      <Loader2 size={24} className="animate-spin" />
    </div>
  ),
});

// ─── Billing Tab ─────────────────────────────────────────────────────────────

type BillingSubTab = "monthly" | "insurance" | "user" | "sales";

const BILLING_SUB_TABS: { id: BillingSubTab; label: string }[] = [
  { id: "monthly",   label: "月次情報" },
  { id: "insurance", label: "介護請求" },
  { id: "user",      label: "利用請求" },
  { id: "sales",     label: "売上帳票" },
];

function BillingSubTabNav({ active, onChange }: { active: BillingSubTab; onChange: (id: BillingSubTab) => void }) {
  return (
    <div className="border-b border-gray-200 bg-white px-3 py-2 shrink-0 flex items-center gap-2">
      {BILLING_SUB_TABS.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`px-3 py-1 rounded-lg text-xs font-medium ${
            active === t.id
              ? "bg-indigo-500 text-white"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const MONTHLY_INFO_KANA_ROWS = ["あ","か","さ","た","な","は","ま","や","ら","わ","他"];
const MONTHLY_INFO_KANA_MAP: Record<string, string[]> = {
  "あ":["ア","イ","ウ","エ","オ"],"か":["カ","キ","ク","ケ","コ","ガ","ギ","グ","ゲ","ゴ"],
  "さ":["サ","シ","ス","セ","ソ","ザ","ジ","ズ","ゼ","ゾ"],"た":["タ","チ","ツ","テ","ト","ダ","ヂ","ヅ","デ","ド"],
  "な":["ナ","ニ","ヌ","ネ","ノ"],"は":["ハ","ヒ","フ","ヘ","ホ","バ","ビ","ブ","ベ","ボ","パ","ピ","プ","ペ","ポ"],
  "ま":["マ","ミ","ム","メ","モ"],"や":["ヤ","ユ","ヨ"],
  "ら":["ラ","リ","ル","レ","ロ"],"わ":["ワ","ヲ","ン"],
};
const MONTHLY_INFO_ALL_KANA = Object.values(MONTHLY_INFO_KANA_MAP).flat();
const monthlyInfoToKana = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

function MonthlyInfoTab({
  tenantId,
  currentOfficeId,
  clients,
  insuranceRecords,
  orderItems,
  orders,
  equipment,
  hospitalizations,
  careOffices,
  dataLoading,
  priceHistory,
  pausesByItem,
  prorations,
}: {
  tenantId: string;
  currentOfficeId: string | null;
  clients: BillingClient[];
  insuranceRecords: BillingCertRow[];
  orderItems: OrderItem[];
  orders: Order[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
  careOffices: CareOffice[];
  dataLoading: boolean;
  priceHistory: EquipmentPriceHistory[];
  /** 貸与の休止期間 (order_item_pauses)。休止日は半月按分の判定から除く */
  pausesByItem: Map<string, DateRange[]>;
  /** 明細×月の算定方法 (既定 自動=半月按分 / 日割り)。null = 読込中 → 自動 */
  prorations: ProrationLoad | null;
}) {
  const [billingMonth, setBillingMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [unitOverrides, setUnitOverrides] = useState<Map<string, number>>(new Map());
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);

  useEffect(() => {
    getUnitOverrides(tenantId, billingMonth)
      .then((units) => {
        const m = new Map<string, number>();
        units.forEach((u) => m.set(u.order_item_id, u.units_override));
        setUnitOverrides(m);
      })
      .catch(console.error);
  }, [tenantId, billingMonth]);

  const [y, m] = billingMonth.split("-").map(Number);
  const prevMonth = () => { const d = new Date(y, m - 2, 1); setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const d = new Date(y, m, 1);     setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  // 当月に対象月が掛かる insurance_record を引く (effective_date <= 月末 && (cert_end >= 月初 || null))
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

  // ★ 2026-11-13 高速化: 引き当ての索引 (旧: 利用者ごとに orderItems 8,000 件を全部なめ、明細ごとに orders.find / equipment.find)。
  //   firstBy = arr.find と同じ (最初の 1 件) / groupBy = arr.filter と同じ (元の並び順)。lib/index-by.ts
  const mOrdersById = useMemo(() => firstBy(orders, (o) => o.id), [orders]);
  const mEquipmentByCode = useMemo(() => firstBy(equipment, (e) => e.product_code), [equipment]);
  const mHospByClient = useMemo(() => groupBy(hospitalizations, (h) => h.client_id), [hospitalizations]);
  const mItemsByClient = useMemo(() => {
    const m = new Map<string, OrderItem[]>();
    for (const it of orderItems) {
      const cid = mOrdersById.get(it.order_id)?.client_id;
      if (!cid) continue;
      const a = m.get(cid);
      if (a) a.push(it); else m.set(cid, [it]);
    }
    return m;
  }, [orderItems, mOrdersById]);

  // 当月の単位数集計 (簡易版: 入院半月判定を含む)
  const computeMonthlyUnits = (clientId: string): number => {
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const hospRanges = hospitalizationRanges((mHospByClient.get(clientId) ?? []));

    let total = 0;
    for (const item of mItemsByClient.get(clientId) ?? []) {
      const pt = item.payment_type ?? mOrdersById.get(item.order_id)?.payment_type ?? "介護";
      if (pt !== "介護") continue;
      if (!item.rental_start_date) continue;
      const start = parseLocalDate(item.rental_start_date);
      if (start > monthEnd) continue;
      if (item.status === "terminated" && item.rental_end_date) {
        const end = parseLocalDate(item.rental_end_date);
        if (end < monthStart) continue;
      }
      if (item.status !== "rental_started" && item.status !== "terminated") continue;

      // override 優先、無ければ rental_price/10
      let units: number;
      if (unitOverrides.has(item.id)) {
        units = unitOverrides.get(item.id)!;
      } else {
        const eq = mEquipmentByCode.get(item.product_code);
        // ⚠ 価格改定があれば当月時点の価格を使う (equipment.rental_price は現在価格なので
        //   過去月を見ているときは食い違いうる)。InvoiceReceiptModal と同じ経路。
        // 価格は その明細の注文の事業所の行 → 共通の行 → 用具マスタ (lib/equipment.ts getPriceForMonth)
        const price = getPriceForMonth(priceHistory, item.product_code, billingMonth, mOrdersById.get(item.order_id)?.office_id ?? currentOfficeId) ?? eq?.rental_price ?? 0;
        const base = price ? Math.round(price / 10) : 0;
        // 半月按分 (既定) / 日割り: 入院・休止の日を除いた貸与日で判定 (lib/half-month-units.ts rentalMonthUnits)
        units = rentalMonthUnits(base, item.rental_start_date, item.rental_end_date, billingMonth,
          [...hospRanges, ...(pausesByItem.get(item.id) ?? [])], prorationModeOf(prorations, item.id, billingMonth));
      }
      total += units * item.quantity;
    }
    return total;
  };

  // 当月にアクティブな利用者 (介護保険のレンタル item が 1 件以上ある利用者) のみ
  const monthlyRows = useMemo(() => {
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const clientIdsWithActive = new Set<string>();
    for (const item of orderItems) {
      const order = mOrdersById.get(item.order_id);
      if (!order?.client_id) continue;
      if (currentOfficeId && order.office_id && order.office_id !== currentOfficeId) continue;
      const pt = item.payment_type ?? order.payment_type ?? "介護";
      if (pt !== "介護") continue;
      if (!item.rental_start_date) continue;
      const start = parseLocalDate(item.rental_start_date);
      if (start > monthEnd) continue;
      if (item.status === "terminated" && item.rental_end_date) {
        const end = parseLocalDate(item.rental_end_date);
        if (end < monthStart) continue;
      }
      if (item.status !== "rental_started" && item.status !== "terminated") continue;
      clientIdsWithActive.add(order.client_id);
    }
    return clients
      .filter((c) => clientIdsWithActive.has(c.id))
      .map((client) => {
        const ins = getActiveInsuranceRecord(client.id);
        const careOfficeId = client.care_office_id ?? ins?.care_office_id ?? null;
        const careOffice = careOfficeId ? careOffices.find((co) => co.id === careOfficeId) ?? null : null;
        const units = computeMonthlyUnits(client.id);
        return { client, ins, careOffice, units };
      });
  // computeMonthlyUnits / getActiveInsuranceRecord は毎回作り直す関数なので deps には入れず、中で読む state を並べる
  //   (2026-11-13: priceHistory・prorations が漏れていて、価格改定の履歴・日割り設定が後から届いても単位が古いままだった)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, orderItems, orders, billingMonth, unitOverrides, currentOfficeId, careOffices, insuranceRecords, hospitalizations, equipment, pausesByItem, priceHistory, prorations, mOrdersById, mItemsByClient, mHospByClient, mEquipmentByCode]);

  // かな行フィルター
  const filteredRows = useMemo(() => {
    if (!kanaFilter) return monthlyRows;
    return monthlyRows.filter(({ client }) => {
      const first = monthlyInfoToKana((client.furigana ?? client.name).charAt(0));
      return kanaFilter === "他" ? !MONTHLY_INFO_ALL_KANA.includes(first) : (MONTHLY_INFO_KANA_MAP[kanaFilter] ?? []).includes(first);
    });
  }, [monthlyRows, kanaFilter]);

  const sortedRows = useMemo(
    () => filteredRows.slice().sort((a, b) => {
      // 施設は末尾に、個人利用者を先頭に
      const fa = a.client.is_facility ? 1 : 0;
      const fb = b.client.is_facility ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return (a.client.furigana ?? a.client.name).localeCompare(b.client.furigana ?? b.client.name, "ja");
    }),
    [filteredRows]
  );

  if (dataLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={22} className="animate-spin text-indigo-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* 左: かな行フィルター */}
      <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
        <button
          onClick={() => setKanaFilter(null)}
          className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
        >全</button>
        {MONTHLY_INFO_KANA_ROWS.map((k) => (
          <button
            key={k}
            onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
            className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
          >{k}</button>
        ))}
      </div>

      {/* 中央: ツールバー + テーブル */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2">
          <button onClick={prevMonth} className="px-2 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-xs">◀</button>
          <span className="text-sm font-semibold text-gray-700">{y}年 {m}月</span>
          <button onClick={nextMonth} className="px-2 py-1 rounded bg-white border border-gray-300 hover:bg-gray-50 text-xs">▶</button>
          <span className="text-xs text-gray-500 ml-2">{sortedRows.length} 件</span>
        </div>
        <div className="flex-1 overflow-auto">
          {/* 横長対策: 全幅に引き伸ばさず最大幅で止める (列が間延びしないように) */}
          <table className="w-full max-w-[1400px] text-xs border-collapse tabular-nums">
            <thead className="bg-gray-100 text-gray-700 sticky top-0 z-10">
              <tr>
                <th className="px-2 py-1.5 border border-gray-300 text-left">保険変更</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">保険者</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">被保険者番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">利用者名</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">利用者番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">作成区分</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">支援事業所番号</th>
                <th className="px-2 py-1.5 border border-gray-300 text-left">居宅介護支援事業所名</th>
                <th className="px-2 py-1.5 border border-gray-300 text-right">区分支給限度基準内単位数</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(({ client, ins, careOffice, units }) => (
                <tr key={client.id} className="hover:bg-blue-50">
                  <td className="px-2 py-1 border border-gray-200 text-center text-gray-400">-</td>
                  {/* 2026-11-13: 保険者名が無いとき 居宅の名前 (care_manager_org) を出していた (18 名) → 保険者番号を出す */}
                  <td className="px-2 py-1 border border-gray-200">{ins?.insurer_name ?? (ins?.insurer_number ?? client.insurer_number ? <span className="font-mono text-gray-500" title="保険者名が未登録のため番号を表示">{ins?.insurer_number ?? client.insurer_number}</span> : "-")}</td>
                  <td className="px-2 py-1 border border-gray-200 font-mono">{ins?.insured_number ?? client.insured_number ?? "-"}</td>
                  <td className="px-2 py-1 border border-gray-200">{client.name}</td>
                  <td className="px-2 py-1 border border-gray-200 font-mono">{client.user_number ?? "-"}</td>
                  {/* 2026-11-13: 固定だった → 伝送の 項19 と同じ関数で出す (居宅番号なし=自己作成 / 要支援 × 区分3 の居宅=介護予防支援) */}
                  <td className="px-2 py-1 border border-gray-200">{FUKUYOGU_PLAN_KUBUN_LABEL[fukuyoguPlanKubunCode(careOffice?.office_number, isYoboCareLevel(ins?.care_level ?? client.care_level), (careOffice as { plan_kubun?: string | null } | null)?.plan_kubun)]}</td>
                  <td className="px-2 py-1 border border-gray-200 font-mono">{careOffice?.office_number ?? "-"}</td>
                  <td className="px-2 py-1 border border-gray-200 truncate max-w-[200px]" title={careOffice?.name ?? ""}>{careOffice?.name ?? client.care_manager_org ?? "-"}</td>
                  <td className="px-2 py-1 border border-gray-200 text-right font-mono">{units.toLocaleString()}</td>
                </tr>
              ))}
              {sortedRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-gray-400 text-sm">対象月にレンタル利用のある利用者がいません</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function BillingTab({ tenantId, currentOfficeId, onOpenExceptionGrant }: { tenantId: string; currentOfficeId: string | null; onOpenExceptionGrant?: (clientId: string, restrictionGroup: string) => void }) {
  // サブタブ: 月次情報 / 介護請求 / 利用請求 / 売上帳票
  const [subTab, setSubTab] = useState<BillingSubTab>("monthly");
  // ★ 2026-11-13 高速化: 介護請求サブタブでだけ使う読込 (会社情報・負担割合証・例外給付・CM 指示・公費の扱い・画面用の公費) は
  //   そのサブタブを一度開いてから読む (初期表示の 月次情報 では使わない)。一度開いたら以後は従来どおり月・事業所の切替で読み直す。
  //   伝送 (CSV 出力・返戻過誤) は これらが読み終わるまで押せない (densouInputsReady)
  const [insuranceTabOpened, setInsuranceTabOpened] = useState(false);
  const changeSubTab = (id: BillingSubTab) => { if (id === "insurance") setInsuranceTabOpened(true); setSubTab(id); };
  const [clients, setClients] = useState<BillingClient[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tenantInfo, setTenantInfo] = useState<import("@/lib/tenants").Tenant | null>(null);
  const [offices, setOffices] = useState<Office[]>([]);
  const [insuranceRecordsAll, setInsuranceRecords] = useState<BillingCertRow[]>([]);
  // ★ 2026-11-11 事業所別保険 (DESIGN_INSURANCE_PER_OFFICE.md §3.2): 認定・公費・負担割合証は
  //   per_office の事業所なら自事業所の行だけ、shared なら per_office の事業所の行を外して使う。
  //   per_office の事業所が 0 なら素通し (= 今の動き)。読み込んだ直後に絞るので下流 (伝送・月遅れ判定・給付率) は全部この規則に従う
  const [perOfficeIds, setPerOfficeIds] = useState<string[]>([]);
  const [perOfficeLoaded, setPerOfficeLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadPerOfficeOfficeIds().then((ids) => { if (!cancelled) { setPerOfficeIds(ids); setPerOfficeLoaded(true); } });
    return () => { cancelled = true; };
  }, [tenantId]);
  const perOfficeMode = isPerOffice(currentOfficeId, perOfficeIds);
  const insuranceRecords = useMemo(
    () => rowsForOffice(insuranceRecordsAll, currentOfficeId, perOfficeIds),
    [insuranceRecordsAll, currentOfficeId, perOfficeIds],
  );
  /**
   * 伝送に載せる 要介護度・認定期間・保険者/被保番・担当居宅。
   *   shared … 今までどおり (認定行を優先し、空の項目は clients の列で補う / 番号・担当居宅は clients の列)
   *   per_office … ★ 自事業所の認定行だけ。clients の列 (他事業所と共有) は使わない。行が無ければ要介護度が空になり、
   *                build.ts の「要介護度をコードにできない」で伝送から外れる (= 認定なし・月遅れ扱い)
   */
  const densouCertOf = (client: BillingClient, rec: BillingCertRow | null) => perOfficeMode
    ? { ...certFieldsForDensou({ care_level: null, certification_start_date: null, certification_end_date: null }, rec),
        insurerNumber: rec?.insurer_number ?? null, insuredNumber: rec?.insured_number ?? null, careOfficeId: rec?.care_office_id ?? null }
    : { ...certFieldsForDensou(client, rec),
        insurerNumber: client.insurer_number, insuredNumber: client.insured_number ?? null, careOfficeId: client.care_office_id };
  const [hospitalizations, setHospitalizations] = useState<ClientHospitalization[]>([]);
  const [priceHistoryAll, setPriceHistoryAll] = useState<EquipmentPriceHistory[]>([]);
  const [careOffices, setCareOffices] = useState<CareOffice[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  // ★ 2026-11-13 高速化: 引き当ての索引。描画・useMemo のたびに orders.find / clients.find / equipment.find /
  //   insuranceRecords.filter / careOffices.find を 数千回回していた (実データで 1 回の描画 約 330ms → 約 10ms・node 計測)。
  //   firstBy = arr.find と同じ (最初の 1 件) / groupBy = arr.filter と同じ (元の並び順)。lib/index-by.ts
  const ordersById = useMemo(() => firstBy(orders, (o) => o.id), [orders]);
  const clientsById = useMemo(() => firstBy(clients, (c) => c.id), [clients]);
  const equipmentByCode = useMemo(() => firstBy(equipment, (e) => e.product_code), [equipment]);
  const insByClient = useMemo(() => groupBy(insuranceRecords, (r) => r.client_id), [insuranceRecords]);
  const hospByClient = useMemo(() => groupBy(hospitalizations, (h) => h.client_id), [hospitalizations]);
  const careOfficeById = useMemo(() => firstBy(careOffices, (co) => co.id), [careOffices]);
  const [invoiceClient, setInvoiceClient] = useState<BillingClient | null>(null);

  // 会社情報（請求書／領収書モーダル用）
  // 請求書・領収書の会社欄: 事業所ごとの設定 > 事業所・法人マスタ > グループ共通 (lib/officeCompanyInfo.ts)
  const [companyInfoForDoc, setCompanyInfoForDoc] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);
  useEffect(() => {
    if (!insuranceTabOpened) return;
    let cancelled = false;
    getOfficeCompanyInfo(tenantId, currentOfficeId)
      .then((r) => { if (!cancelled) setCompanyInfoForDoc(r.info); })
      .catch((e) => console.error("会社情報の取得に失敗:", e instanceof Error ? e.message : e));
    return () => { cancelled = true; };
  }, [tenantId, currentOfficeId, insuranceTabOpened]);

  useEffect(() => {
    // BillingTab は currentOfficeId 単独 (officeViewAll 概念無し)
    // PostgREST default limit 1000 を超えるテーブル (insurance_records 8370 件等) は必ずページング
    // 認定 (約 25,000 行) を 1000 行ずつ直列に読むと約 5 秒かかっていた → 件数を聞いてページを並列に (lib/pagedParallel.ts)
    const fetchAllPaged = <T,>(table: string, select = "*"): Promise<T[]> =>
      selectAllPagedParallel<T>(
        () => supabase.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
        (from, to) => supabase.from(table).select(select).eq("tenant_id", tenantId).order("id").range(from, to),
      );
    // ★ 2026-11-13: per_office の事業所を開いているときは 認定を office_id = 自事業所 の行だけ読む
    //   (下の rowsForOffice の per_office 分岐で残る行と同じ。ケアサポ 22,543 → 約 5,800 行)。
    //   shared・事業所未選択は従来どおり全件 (rowsForOffice が per_office の事業所の行を外す)。
    //   per_office の判定 (offices 1 行) を先に聞いてから読むので 二重読みにならない
    const insP = loadPerOfficeOfficeIds().then((ids) => {
      const ownOffice = isPerOffice(currentOfficeId, ids) ? currentOfficeId : null;
      if (!ownOffice) return fetchAllPaged<BillingCertRow>("client_insurance_records", BILLING_CERT_SELECT);
      return selectAllPagedParallel<BillingCertRow>(
        () => supabase.from("client_insurance_records").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("office_id", ownOffice),
        (from, to) => supabase.from("client_insurance_records").select(BILLING_CERT_SELECT).eq("tenant_id", tenantId).eq("office_id", ownOffice).order("id").range(from, to),
      );
    });
    // 価格改定の履歴は テナント全件 (約 700 行) を最初から同時に読み、order_items が揃ってから品目で絞る
    //   (2026-11-13 高速化: 旧 = order_items を待ってから 150 品目ずつ 6 回直列。結果は getPriceHistory(tenantId, codes) と同じ
    //    = 同じ品目・valid_from 昇順 (同日は id))。失敗しても画面の読込は止めない (従来どおり warn だけ)
    const priceHistAllP: Promise<EquipmentPriceHistory[] | null> = selectAllPagedParallel<EquipmentPriceHistory>(
      () => supabase.from("equipment_price_history").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
      (from, to) => supabase.from("equipment_price_history").select("*").eq("tenant_id", tenantId).order("id").range(from, to),
    ).catch((err) => { console.warn("getPriceHistory failed:", err); return null; });
    Promise.all([
      // 利用者は請求で使う列だけ (lib/billing-client-cols.ts。旧 select("*") 47 列)
      getClientsCols(tenantId, { officeId: currentOfficeId ?? undefined }, BILLING_CLIENT_COLS),
      getEquipment(tenantId),
      getAllOrderItemsByTenant(tenantId),
      getAllOrders(tenantId, currentOfficeId),
      getTenantById(tenantId),
      getOffices(tenantId),
      // 認定は請求で使う列だけ (lib/insurance/billing-cert-cols.ts。旧 select("*") 約 36MB)・per_office なら自事業所の行だけ
      insP,
      fetchAllPaged<ClientHospitalization>("client_hospitalizations"),
      getCareOffices(tenantId),
    ]).then(([c, eq, items, ords, tenant, offs, insRaw, hospRaw, coffs]) => {
      setClients(c);
      setEquipment(eq);
      setOrderItems(items);
      setOrders(ords);
      setTenantInfo(tenant);
      setOffices(offs);
      setInsuranceRecords(insRaw as BillingCertRow[]);
      setHospitalizations(hospRaw as ClientHospitalization[]);
      setCareOffices(coffs as CareOffice[]);
      // 価格履歴は全 product_code 分を取得（請求書／領収書モーダルで使用）
      const codes = new Set(items.map((i: OrderItem) => i.product_code));
      if (codes.size > 0) {
        void priceHistAllP.then((all) => {
          if (!all) return;
          setPriceHistoryAll(all.filter((h) => codes.has(h.product_code))
            .sort((a, b) => a.valid_from.localeCompare(b.valid_from) || String(a.id).localeCompare(String(b.id))));
        });
      }
    }).catch(console.error).finally(() => setDataLoading(false));
  }, [tenantId, currentOfficeId]);
  // ★ 負担割合証 (期間ごと。2026-11-09 FY-H): 給付率は「提供月に掛かる負担割合証」→ 無ければ認定行の値 (+ 警告)。
  //   規則は lib/insurance/cert-month.ts (kaigo-app と同じ中身の純関数)。
  //   表が未適用・読めないときは従来どおり clients.benefit_rate で計算し、理由を 1 行だけ警告に出す。
  const [benefitCerts, setBenefitCerts] = useState<BenefitCertsLoad | null>(null);
  /** 負担割合証を読み終えた事業所 (per_office は事業所ごとに行が違う。事業所を切り替えた直後に前の事業所の行で伝送しないため) */
  const [benefitCertsOfficeKey, setBenefitCertsOfficeKey] = useState<string | null>(null);
  // ★ 貸与の休止期間 (2026-11-09 FY-PZ): 休止日は 明細 項10 日数 と 半月按分の判定 から除く。
  //   表 (order_item_pauses) が未適用・読めないときは 休止なし で計算し、伝送の警告に理由を 1 行出す (console.error は lib 側)。
  const [pauses, setPauses] = useState<PausesLoad | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadOrderItemPauses(tenantId).then((r) => { if (!cancelled) setPauses(r); });
    return () => { cancelled = true; };
  }, [tenantId]);
  const pausesOf = (itemId: string): DateRange[] => pauses?.byItem.get(itemId) ?? [];
  // ★ 明細×月の算定方法 (2026-11-12): 既定は半月按分の自動。order_item_proration に行がある月だけ日割り。
  //   読めないときは 全件 自動 で計算し、伝送の警告に理由を出す (表未適用なら notice)。
  const [prorations, setProrations] = useState<ProrationLoad | null>(null);
  const [prorationError, setProrationError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadProrations(tenantId)
      .then((r) => { if (!cancelled) setProrations(r); })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(msg);
        if (!cancelled) setProrationError(msg);
      });
    return () => { cancelled = true; };
  }, [tenantId]);
  /**
   * 日割りの明細がある利用者の注意 (単位の計算は変えない。伝送の警告に 1 行/利用者)。
   *   ① 当月に入院がある: 単位 (rentalMonthUnits daily) は入院日を除いた日数、伝送の日数 (項10) は入院を含む
   *   ② 月途中の公費がある: 日割り後の単位に さらに公費の日割り/半月がかかる (二重の按分)
   *   どちらも ほのぼのの実出力で確かめた例が無い (2026-11-12)。
   */
  const dailyProrationWarnings = (
    client: { id: string; name: string; insured_number: string | null },
    items: readonly OrderItem[],
    ym: string,
    kohi: FukuyoguKohi | null,
    lines: readonly FukuyoguLineInput[],
  ): string[] => {
    if (!items.some((it) => prorationModeOf(prorations, it.id, ym) === "daily")) return [];
    const out: string[] = [];
    const ms = `${ym}-01`, me = monthEndYmd(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)));
    const hospInMonth = hospitalizations.some((h) => h.client_id === client.id && h.admission_date <= me && (h.discharge_date == null || h.discharge_date >= ms));
    if (hospInMonth) {
      out.push(`${client.name}: 日割りと入院が重なる: 単位は入院日を除いた日数で計算、伝送の日数 (項10) は入院を含む。ほのぼのの実例が無いので確認を`);
    }
    if (kohi && !/^[Hh]/.test((client.insured_number ?? "").trim()) && lines.length && kohiCoverageInMonth(kohi.periods, [...lines], ym).partial) {
      out.push(`${client.name}: 日割り×月途中の公費は二重に按分される (日割り後の単位に さらに公費の按分がかかる)。実例が無いので確認を`);
    }
    return out;
  };
  const prorationNotice: string | null = prorationError
    ? `${prorationError} — 全件 半月按分の自動で計算しました`
    : !prorations
      ? "日割りの設定をまだ読み込んでいません — 全件 半月按分の自動で計算しました (少し待ってから作り直してください)"
      : prorations.notice;
  /** 休止が使えないときの警告 (伝送の警告に出す)。null = 読めている */
  const pausesNotice: string | null = !pauses
    ? "貸与の休止期間をまだ読み込んでいません — 休止を除かずに日数・半月按分を計算しました (少し待ってから作り直してください)"
    : pauses.available ? null : pauses.message;
  useEffect(() => {
    if (!insuranceTabOpened) return;
    let cancelled = false;
    // ★ 2026-11-13: per_office の事業所なら 自事業所の行だけ読む (benefitRawForMonth の rowsForOffice で残る行と同じ。
    //   ケアサポ 約 12,000 → 約 2,000 行)。per_office の判定 (offices 1 行) を先に聞く (認定の読込と同じ)
    //   per_office の判定は 画面を開いたときに読み終えた perOfficeIds を使う (2026-11-13: 旧 = ここで offices をもう一度聞いてから 2 段目)
    if (!perOfficeLoaded) return;
    loadBenefitCertificates(tenantId, { officeId: isPerOffice(currentOfficeId, perOfficeIds) ? currentOfficeId : null })
      .then((r) => { if (!cancelled) { setBenefitCerts(r); setBenefitCertsOfficeKey(currentOfficeId ?? ""); } });
    return () => { cancelled = true; };
  }, [tenantId, insuranceTabOpened, currentOfficeId, perOfficeLoaded, perOfficeIds]);
  /** その月の給付率 (computeFukuyoguAmounts の benefitRateRaw に渡す文字列)。警告は onWarn、負担割合証なしは noCert に名前を足す */
  const benefitRawForMonth = (client: BillingClient, monthStart: string, monthEnd: string, onWarn: (w: string) => void, noCert: string[]): string | null => {
    if (!benefitCerts?.available) return client.benefit_rate;
    const r = resolveBenefitForMonth(
      (insByClient.get(client.id) ?? []),
      rowsForOffice(benefitCerts.byClient.get(client.id) ?? [], currentOfficeId, perOfficeIds),
      monthStart, monthEnd,
    );
    if (r.source === "certificate") for (const w of r.warnings) onWarn(w);
    else {
      noCert.push(client.name);
      for (const w of r.warnings) if (!w.startsWith("その月の負担割合証")) onWarn(w); // 「負担割合証なし」は 1 行にまとめる
    }
    return r.benefitRate != null ? String(r.benefitRate) : client.benefit_rate;
  };
  /** 「負担割合証なし」をまとめた 1 行 (表が未適用ならその理由) */
  const benefitNoCertSummary = (noCert: string[]): string | null => {
    if (!benefitCerts?.available) return benefitCerts?.notice ?? null;
    if (noCert.length === 0) return null;
    return `その月の負担割合証が無く、認定行の給付率で計算した利用者 ${noCert.length} 名: ${noCert.slice(0, 20).join("、")}${noCert.length > 20 ? " …" : ""} — 負担割合証を確認してください`;
  };
  const [billingMonth, setBillingMonth] = useState(() => {
    // デフォルトは今月
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  const [unitOverrides, setUnitOverridesState] = useState<Map<string, number>>(new Map()); // key: order_item_id
  const [rebillFlags, setRebillFlagsState] = useState<Map<string, BillingRebillFlag>>(new Map()); // key: "clientId-month"
  const [lateFlags, setLateFlagsState] = useState<Map<string, BillingLateFlag>>(new Map()); // key: clientId (= flag.month は提出月)
  const [selectedClientIds, setSelectedClientIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  // 月遅/返戻/過誤 フラグは即保存せずローカルに貯め、「保存」ボタンで一括反映する。
  // savedRef = 最後に DB と同期した状態 (保存時に diff を計算するための基準)。
  const [isDirty, setIsDirty] = useState(false);
  const [savingFlags, setSavingFlags] = useState(false);
  const savedRebillRef = useRef<Map<string, BillingRebillFlag>>(new Map());
  const savedLateRef = useRef<Map<string, BillingLateFlag>>(new Map());
  // ★ CM 指示単位数 (2026-11-09): 利用者ごと・月ごと。入力があればその単位数までを保険請求し 超過は保険外 (全額自己負担)。
  //   保存は入力欄を離れたとき即時 (月遅/返戻フラグの「保存」ボタンとは別)。表が未適用なら全員 実績で請求し、理由を画面に出す。
  const [cmUnits, setCmUnits] = useState<Map<string, number>>(new Map()); // key: client_id
  const [cmEntered, setCmEntered] = useState<Set<string>>(new Set()); // その月に値がある client_id (事業所で値が割れた人も含む)
  const [cmUnitsNotice, setCmUnitsNotice] = useState<string | null>(null);
  const [cmUnitsAvailable, setCmUnitsAvailable] = useState(true);
  const [cmSavingId, setCmSavingId] = useState<string | null>(null);
  /** CM 指示を読み終えた 月|事業所 (読込中・前の月の値のまま伝送しないため) */
  const [cmLoadedKey, setCmLoadedKey] = useState<string | null>(null);
  // ★ 月途中の公費 (生保) の扱い (2026-11-09): 公費が月の途中で始まる/終わる利用者の行に
  //   「全部利用者負担 / 日割り / 半月」の選択を出す (ケアマネの方針で 利用者ごと・月ごと)。未選択は既定 + 警告。
  //   保存は選んだとき即時 (upsert)。表が未適用なら選択欄を無効にし、理由を画面に出す。
  const [kohiModes, setKohiModes] = useState<Map<string, KohiMonthMode>>(new Map()); // key: client_id
  const [kohiModesAvailable, setKohiModesAvailable] = useState(true);
  const [kohiModesNotice, setKohiModesNotice] = useState<string | null>(null);
  const [kohiModeSavingId, setKohiModeSavingId] = useState<string | null>(null);
  /** 公費の扱いを読み終えた 月|事業所 */
  const [kohiModesLoadedKey, setKohiModesLoadedKey] = useState<string | null>(null);
  const [screenKohi, setScreenKohi] = useState<{ month: string; byClient: Map<string, FukuyoguKohi> } | null>(null);
  const [screenKohiNotice, setScreenKohiNotice] = useState<string | null>(null);
  // ★ 軽度者 例外給付の印 (2026-11-09): 利用者行に 記録なし/切れ = 赤・30日以内に期限/期間要なのに終了日空 = 橙。
  //   押すと利用者タブの例外給付タブを その品目区分の新規入力で開く。基準日は請求月の 1 日 (伝送の警告と同じ)。
  //   表が読めなければ印は出さず、理由を画面下の集計欄に出す (伝送の警告は従来どおり別経路)。
  const [exGrants, setExGrants] = useState<FukuyoguExceptionGrant[] | null>(null);
  const [exRules, setExRules] = useState<ExceptionInsurerRule[]>([]);
  const [exNotice, setExNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!insuranceTabOpened) return;
    let cancelled = false;
    (async () => {
      const notices: string[] = [];
      // 例外給付記録と市町村ルールは互いに依存しないので同時に読む (2026-11-13。エラーの扱いは従来どおり)
      const rulesP = getExceptionInsurerRules(tenantId);
      try {
        const g = await getAllExceptionGrants(tenantId);
        if (!cancelled) setExGrants(g);
      } catch (e) {
        console.error("例外給付記録の取得失敗:", e);
        notices.push(isTableMissingError(e as { code?: string })
          ? "例外給付の表が未作成のため、利用者行の例外給付の印は出していません"
          : `例外給付記録を読めなかったため、利用者行の例外給付の印は出していません (${(e as { message?: string })?.message ?? String(e)})`);
        if (!cancelled) setExGrants(null);
      }
      const r = await rulesP;
      if (r.message) notices.push(r.message);
      if (!cancelled) { setExRules(r.rules); setExNotice(notices.length > 0 ? notices.join(" / ") : null); }
    })();
    return () => { cancelled = true; };
  }, [tenantId, insuranceTabOpened]);

  // 月遅れ自動判定：
  //   ① 当月の認定の certification_status が「申請中」の利用者
  //   ② ★ 2026-11-09 (FY-C2): 伝送の要介護度をコードにできない利用者 (当月に有効な認定が無い 等)。
  //      build.ts も伝送から外す (確実に返戻するため)。行に「要介護度なし」の印を出す。
  //   認定の選び方は伝送と同じ lib/kokuho-densou/cert-for-month.ts (被保番が一致する認定を優先)。
  const { autoLateClients, noCareLevelClients } = useMemo(() => {
    const [y, m] = billingMonth.split("-").map(Number);
    const monthStart = `${billingMonth}-01`;
    const monthEnd = monthEndYmd(y, m);
    const lateSet = new Set<string>();
    const noLevel = new Set<string>();
    const recsByClient = new Map<string, BillingCertRow[]>();
    for (const r of insuranceRecords) {
      const xs = recsByClient.get(r.client_id);
      if (xs) xs.push(r); else recsByClient.set(r.client_id, [r]);
    }
    for (const client of clients) {
      const rec = pickCertForMonth(recsByClient.get(client.id) ?? [], monthStart, monthEnd,
        { insurerNumber: client.insurer_number, insuredNumber: client.insured_number });
      if (rec?.certification_status === "申請中") lateSet.add(client.id);
      if (!careLevelCodeForDensou(densouCertOf(client, rec).careLevel)) { noLevel.add(client.id); lateSet.add(client.id); }
    }
    return { autoLateClients: lateSet, noCareLevelClients: noLevel };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- densouCertOf は perOfficeMode だけに依存
  }, [insuranceRecords, clients, billingMonth, perOfficeMode]);

  // 当月アクティブレンタルを取得
  const activeRentals = useMemo(() => {
    const [y, m] = billingMonth.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    return orderItems.filter((item) => {
      const pt = item.payment_type ?? ordersById.get(item.order_id)?.payment_type ?? "介護";
      if (pt !== "介護") return false; // 介護保険のみ請求
      if (!item.rental_start_date) return false;
      const pld2 = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
      const start = pld2(item.rental_start_date);
      if (start > monthEnd) return false;
      if (item.status === "terminated" && item.rental_end_date) {
        const end = pld2(item.rental_end_date);
        if (end < monthStart) return false;
      }
      if (item.status !== "rental_started" && item.status !== "terminated") return false;
      return true;
    });
  }, [billingMonth, orderItems, ordersById]);

  // 利用者ごとにグループ化（事業所フィルタ付き）
  const clientGroups = useMemo(() => {
    const map = new Map<string, { client: BillingClient; items: OrderItem[] }>();
    for (const item of activeRentals) {
      const order = ordersById.get(item.order_id);
      // 事業所が選択されている場合、その事業所の注文のみ
      if (currentOfficeId && order?.office_id && order.office_id !== currentOfficeId) continue;
      if (!order?.client_id) continue;
      const client = clientsById.get(order.client_id);
      if (!client) continue;
      if (!map.has(client.id)) map.set(client.id, { client, items: [] });
      map.get(client.id)!.items.push(item);
    }
    return Array.from(map.values()).sort((a, b) => {
      // 施設は末尾に、個人利用者を先頭に
      const fa = a.client.is_facility ? 1 : 0;
      const fb = b.client.is_facility ? 1 : 0;
      if (fa !== fb) return fa - fb;
      return (a.client.furigana ?? a.client.name).localeCompare(b.client.furigana ?? b.client.name, "ja");
    });
  }, [activeRentals, ordersById, clientsById, currentOfficeId]);

  // 例外給付の判定 (利用者ごと)。ok の利用者は入れない
  const exceptionByClient = useMemo(() => {
    const m = new Map<string, { level: ExceptionAlertLevel; items: ExceptionJudgement[] }>();
    if (!exGrants) return m;
    const onDate = `${billingMonth}-01`;
    const eqByCode = new Map(equipment.map((e) => [e.product_code, e]));
    for (const { client, items } of clientGroups) {
      const groups: string[] = [];
      for (const item of items) {
        const cat = eqByCode.get(item.product_code)?.category;
        if (!isKeidoRestricted(client.care_level, cat)) continue;
        const g = RESTRICTION_GROUP_OF_CATEGORY[cat ?? ""];
        if (g) groups.push(g);
      }
      if (groups.length === 0) continue;
      const j = judgeClientExceptions(exGrants, client.id, groups, onDate, findInsurerRule(exRules, client.insurer_number));
      if (j.level !== "ok") m.set(client.id, { level: j.level, items: j.items.filter((i) => i.level !== "ok") });
    }
    return m;
  }, [exGrants, exRules, clientGroups, equipment, billingMonth]);
  const openExceptionGrant = (clientId: string, group: string) => {
    if (!onOpenExceptionGrant) return;
    if (isDirty && !confirm("月遅・返戻・過誤のフラグに未保存の変更があります。保存せずに利用者タブへ移りますか？")) return;
    onOpenExceptionGrant(clientId, group);
  };

  // DBからフラグを読み込む
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setLoading(true);
    Promise.all([
      getUnitOverrides(tenantId, billingMonth),
      getRebillFlags(tenantId),
      getLateFlags(tenantId, billingMonth),
    ]).then(([units, rebill, late]) => {
      const um = new Map<string, number>();
      units.forEach((u) => um.set(u.order_item_id, u.units_override));
      setUnitOverridesState(um);
      const rm = new Map<string, BillingRebillFlag>();
      rebill.forEach((r) => rm.set(`${r.client_id}-${r.month}`, r));
      setRebillFlagsState(rm);
      const lm = new Map<string, BillingLateFlag>();
      late.forEach((l) => lm.set(l.client_id, l));
      setLateFlagsState(lm);
      savedRebillRef.current = new Map(rm);
      savedLateRef.current = new Map(lm);
      setIsDirty(false);
    }).catch(console.error).finally(() => setLoading(false));
  }, [tenantId, billingMonth]);

  // CM 指示単位数を読む (事業所を選んでいればその事業所の値)
  useEffect(() => {
    if (!insuranceTabOpened) return;
    let cancelled = false;
    getCmUnits(tenantId, billingMonth, currentOfficeId).then((r) => {
      if (cancelled) return;
      setCmUnits(r.byClient);
      setCmEntered(r.entered);
      setCmUnitsAvailable(r.available);
      setCmUnitsNotice(r.message);
      setCmLoadedKey(`${billingMonth}|${currentOfficeId ?? ""}`);
    });
    return () => { cancelled = true; };
  }, [tenantId, billingMonth, currentOfficeId, insuranceTabOpened]);

  // CM 指示単位数の入力を保存 (空欄 = 削除 = 実績で請求に戻す)。失敗は必ず画面に出す
  const handleCmUnitsCommit = async (clientId: string, raw: string) => {
    const units = raw.trim() === "" ? null : normalizeCmUnits(raw);
    if (raw.trim() !== "" && units == null) {
      alert(`CM 指示単位数「${raw}」を読めません — 0 以上の整数で入れてください`);
      return;
    }
    if ((cmUnits.get(clientId) ?? null) === units) return;
    if (!currentOfficeId) {
      alert("CM 指示単位数は事業所ごとに保存します。事業所を選んでから入力してください。");
      return;
    }
    setCmSavingId(clientId);
    try {
      await saveCmUnits({ tenantId, officeId: currentOfficeId, clientId, month: billingMonth, units });
      setCmUnits((prev) => {
        const m = new Map(prev);
        if (units == null) m.delete(clientId); else m.set(clientId, units);
        return m;
      });
      setCmEntered((prev) => {
        const s = new Set(prev);
        if (units == null) s.delete(clientId); else s.add(clientId);
        return s;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("CM 指示単位数の保存失敗:", msg);
      alert(`保存失敗: ${msg}`);
    } finally {
      setCmSavingId(null);
    }
  };

  // 月途中の公費の扱いを読む (事業所を選んでいればその事業所の値)
  useEffect(() => {
    if (!insuranceTabOpened) return;
    let cancelled = false;
    getKohiMonthModes(tenantId, billingMonth, currentOfficeId).then((r) => {
      if (cancelled) return;
      setKohiModes(r.byClient);
      setKohiModesAvailable(r.available);
      setKohiModesNotice(r.message);
      setKohiModesLoadedKey(`${billingMonth}|${currentOfficeId ?? ""}`);
    });
    return () => { cancelled = true; };
  }, [tenantId, billingMonth, currentOfficeId, insuranceTabOpened]);

  // 画面表示用に 当月の公費を読む (月途中の判定だけに使う。伝送は出力時に読み直す)
  const screenClientIdsKey = useMemo(() => clientGroups.map((g) => g.client.id).sort().join(","), [clientGroups]);
  useEffect(() => {
    if (!insuranceTabOpened) return;
    let cancelled = false;
    const ids = screenClientIdsKey ? screenClientIdsKey.split(",") : [];
    if (ids.length === 0) return;
    const [yy, mm] = billingMonth.split("-").map(Number);
    // 事業所の範囲は伝送 (出力時) と同じ (2026-11-13: 画面用だけ範囲を渡しておらず、他事業所の公費行も数えていた)
    loadKohiForMonth(tenantId, ids, `${billingMonth}-01`, monthEndYmd(yy, mm), { officeId: currentOfficeId, perOfficeIds })
      .then((r) => {
        if (cancelled) return;
        setScreenKohi({ month: billingMonth, byClient: r.byClient });
        setScreenKohiNotice(r.notices.length ? r.notices.join(" / ") : null);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
        console.error("公費の取得失敗 (画面表示用):", msg);
        if (!cancelled) {
          setScreenKohi(null);
          setScreenKohiNotice(`公費を読めなかったため、月途中の公費の判定を画面に出していません (${msg})。伝送の出力時にもう一度読みます`);
        }
      });
    return () => { cancelled = true; };
  }, [tenantId, billingMonth, screenClientIdsKey, currentOfficeId, perOfficeIds, insuranceTabOpened]);

  // 公費が当月の貸与期間の一部だけの利用者 (= 「公費の扱い」を選ぶ必要がある人)
  const kohiPartialByClient = useMemo(() => {
    const out = new Map<string, { kohi: FukuyoguKohi; firstDay: string | null; lastDay: string | null }>();
    if (!screenKohi || screenKohi.month !== billingMonth) return out;
    for (const { client, items } of clientGroups) {
      const kohi = screenKohi.byClient.get(client.id);
      if (!kohi || /^[Hh]/.test((client.insured_number ?? "").trim())) continue;
      const lines: FukuyoguLineInput[] = items.map((it) => ({ unitPer: 1, count: 1, units: 1, rentalStart: it.rental_start_date, rentalEnd: it.rental_end_date }));
      const cov = kohiCoverageInMonth(kohi.periods, lines, billingMonth);
      if (cov.partial) out.set(client.id, { kohi, firstDay: cov.firstDay, lastDay: cov.lastDay });
    }
    return out;
  }, [screenKohi, clientGroups, billingMonth]);

  // 公費の扱いを保存 (空 = 削除 = 未選択に戻す)。失敗は必ず画面に出す
  const handleKohiModeChange = async (clientId: string, raw: string) => {
    const mode = raw === "" ? null : isKohiMonthMode(raw) ? raw : undefined;
    if (mode === undefined) { alert(`公費の扱い「${raw}」を読めません`); return; }
    if (!currentOfficeId) {
      alert("公費の扱いは事業所ごとに保存します。事業所を選んでから選択してください。");
      return;
    }
    setKohiModeSavingId(clientId);
    try {
      await saveKohiMonthMode({ tenantId, officeId: currentOfficeId, clientId, month: billingMonth, mode });
      setKohiModes((prev) => {
        const next = new Map(prev);
        if (mode == null) next.delete(clientId); else next.set(clientId, mode);
        return next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("公費の扱いの保存失敗:", msg);
      alert(`保存失敗: ${msg}`);
    } finally {
      setKohiModeSavingId(null);
    }
  };

  // 未保存で画面(ブラウザ)を離れようとしたら警告
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // 月遅れフラグのトグル (手動 mark) — ローカルのみ更新、DB反映は「保存」ボタン
  const toggleLateFlag = (clientId: string) => {
    setLateFlagsState((prev) => {
      const m = new Map(prev);
      if (m.has(clientId)) m.delete(clientId);
      else m.set(clientId, { id: "", tenant_id: tenantId, client_id: clientId, month: billingMonth, created_at: "" });
      return m;
    });
    setIsDirty(true);
  };

  // チェックした利用者を過誤/返戻で確定 — ローカルのみ更新、DB反映は「保存」ボタン
  const handleConfirm = (type: "返戻" | "過誤") => {
    setRebillFlagsState((prev) => {
      const m = new Map(prev);
      for (const clientId of selectedClientIds) {
        m.set(`${clientId}-${billingMonth}`, {
          id: "", tenant_id: tenantId, client_id: clientId, month: billingMonth, flag_type: type, created_at: ""
        });
      }
      return m;
    });
    setSelectedClientIds(new Set());
    setIsDirty(true);
  };

  /**
   * 利用・提供表 (RentalGridModal / RentalGridPanel) の 1 明細ぶん。単位は請求・伝送と同じ getUnits
   * (単位上書き・当月の改定価格・入院・休止・日割り設定を反映)、区分は同じ材料で halfMonthFlags (2026-11-13 寄せ)
   */
  const rentalGridCalcOf = (clientId: string) => (item: OrderItem): RentalGridCalc => {
    const excluded = [...hospitalizationRanges((hospByClient.get(clientId) ?? [])), ...pausesOf(item.id)];
    const mode = prorationModeOf(prorations, item.id, billingMonth);
    const mask = item.rental_start_date ? rentalDayMask(item.rental_start_date, item.rental_end_date, billingMonth, excluded) : [];
    const billedDays = mask.filter(Boolean).length;
    const { firstHalf, secondHalf } = item.rental_start_date
      ? halfMonthFlags(item.rental_start_date, item.rental_end_date, billingMonth, excluded)
      : { firstHalf: false, secondHalf: false };
    const kind: RentalGridCalc["kind"] = billedDays === 0 ? "none"
      : mode === "daily" ? "daily" : firstHalf && secondHalf ? "full" : "half";
    const label = kind === "none" ? "—" : kind === "daily" ? `日割(${billedDays}日)`
      : kind === "full" ? "1か月" : firstHalf ? "前半月" : "後半月";
    return { units: kind === "none" ? 0 : getUnits(item, clientId) * item.quantity, billedDays, kind, label };
  };

  /** 価格を引く事業所 = その明細の注文の事業所 (無ければ 今見ている事業所)。lib/equipment.ts getPriceForMonth に渡す */
  const officeOfItem = (item: OrderItem): string | null => ordersById.get(item.order_id)?.office_id ?? currentOfficeId ?? null;

  const getUnits = (item: OrderItem, clientId: string) => {
    if (unitOverrides.has(item.id)) return unitOverrides.get(item.id)!;
    const eq = equipmentByCode.get(item.product_code);
    // ⚠ 価格改定があれば当月時点の価格を使う (2026-09-04 是正: 以前は equipment.rental_price
    //   = 現在価格を直参照しており、価格改定後に過去月ぶんを組むと現在価格で計算されていた)。
    const price = getPriceForMonth(priceHistoryAll, item.product_code, billingMonth, officeOfItem(item)) ?? eq?.rental_price ?? 0;
    const base = price ? Math.round(price / 10) : 0;
    if (!item.rental_start_date) return base;
    // 半月按分 (既定) / 日割り: 入院・休止の日を除いた貸与日で判定 (lib/half-month-units.ts rentalMonthUnits)
    return rentalMonthUnits(base, item.rental_start_date, item.rental_end_date, billingMonth,
      [...hospitalizationRanges((hospByClient.get(clientId) ?? [])), ...pausesOf(item.id)],
      prorationModeOf(prorations, item.id, billingMonth));
  };

  // 指定年月(ym="YYYY-MM")での単位数計算 (返戻・過誤の過去月伝送用)。
  // getUnits の billingMonth 依存を外した版。過去月は単位上書きを読まない(未ロードのため)。
  const computeUnitsForMonth = (item: OrderItem, clientId: string, ym: string): number => {
    const eq = equipmentByCode.get(item.product_code);
    // ⚠ 過去月 (返戻・過誤の再伝送) を組むので、当時の価格改定を必ず反映する。
    const price = getPriceForMonth(priceHistoryAll, item.product_code, ym, officeOfItem(item)) ?? eq?.rental_price ?? 0;
    const base = price ? Math.round(price / 10) : 0;
    if (!item.rental_start_date) return base;
    return rentalMonthUnits(base, item.rental_start_date, item.rental_end_date, ym,
      [...hospitalizationRanges((hospByClient.get(clientId) ?? [])), ...pausesOf(item.id)],
      prorationModeOf(prorations, item.id, ym));
  };

  const toggleRebillFlag = (clientId: string, month: string, type: "返戻" | "過誤") => {
    const key = `${clientId}-${month}`;
    setRebillFlagsState((prev) => {
      const m = new Map(prev);
      const existing = m.get(key);
      if (existing && existing.flag_type === type) m.delete(key);
      else m.set(key, { id: "", tenant_id: tenantId, client_id: clientId, month, flag_type: type, created_at: "" });
      return m;
    });
    setIsDirty(true);
  };

  // 返戻 select 用: ローカルのみ更新
  const setRebillLocal = (clientId: string, month: string, type: "返戻" | null) => {
    const key = `${clientId}-${month}`;
    setRebillFlagsState((prev) => {
      const m = new Map(prev);
      if (type === null) { if (m.get(key)?.flag_type === "返戻") m.delete(key); }
      else m.set(key, { id: "", tenant_id: tenantId, client_id: clientId, month, flag_type: type, created_at: "" });
      return m;
    });
    setIsDirty(true);
  };

  // 貯めた 月遅/返戻/過誤 フラグを DB に一括反映 (snapshot との diff)
  const handleSaveFlags = async () => {
    setSavingFlags(true);
    try {
      const savedLate = savedLateRef.current;
      const savedRebill = savedRebillRef.current;
      const ops: Promise<void>[] = [];
      // 月遅れ: 追加 / 削除
      for (const [clientId, f] of lateFlags) {
        if (!savedLate.has(clientId)) ops.push(setLateFlag(tenantId, clientId, f.month || billingMonth));
      }
      for (const [clientId, f] of savedLate) {
        if (!lateFlags.has(clientId)) ops.push(removeLateFlag(tenantId, clientId, f.month || billingMonth));
      }
      // 返戻/過誤: 追加・変更 / 削除
      for (const [key, f] of rebillFlags) {
        const prev = savedRebill.get(key);
        if (!prev || prev.flag_type !== f.flag_type) ops.push(setRebillFlag(tenantId, f.client_id, f.month, f.flag_type));
      }
      for (const [key, f] of savedRebill) {
        if (!rebillFlags.has(key)) ops.push(removeRebillFlag(tenantId, f.client_id, f.month));
      }
      await Promise.all(ops);
      savedLateRef.current = new Map(lateFlags);
      savedRebillRef.current = new Map(rebillFlags);
      setIsDirty(false);
    } catch (e) {
      console.error("フラグ保存失敗:", e);
      alert("保存に失敗しました: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSavingFlags(false);
    }
  };

  // 伝送データ生成 (国保連 正式インタフェース: 7111 請求書 + 7131 様式第二 / Shift_JIS)
  /**
   * 伝送に使う入力が読み終わっているか (2026-11-13)。読込中に押すと 負担割合証なし = clients の給付率 /
   * CM 指示なし = 全員実績で請求 / 公費の扱い 未選択 = 既定 で黙って組んでしまうので、揃うまで押せなくする。
   * (休止・日割り設定は 読めない/未適用 なら注意文つきで組む従来どおり。読込中 (null) のときだけ待つ)
   */
  const densouKey = `${billingMonth}|${currentOfficeId ?? ""}`;
  const densouInputsReady = !dataLoading && benefitCerts !== null && benefitCertsOfficeKey === (currentOfficeId ?? "") && cmLoadedKey === densouKey && kohiModesLoadedKey === densouKey
    && pauses !== null && (prorations !== null || prorationError !== null);
  const densouNotReadyAlert = () => alert("伝送に使うデータ (負担割合証・CM 指示・公費の扱い・休止・日割り設定) をまだ読み込んでいます。少し待ってからもう一度押してください");

  const generateTransferData = async () => {
    if (!densouInputsReady) { densouNotReadyAlert(); return; }
    const [y, m] = billingMonth.split("-").map(Number);
    // 選択中の事業所の事業所番号を優先、なければテナントの番号にフォールバック
    const currentOffice = offices.find(o => o.id === currentOfficeId);
    const rawOfficeNumber = currentOffice?.business_number || tenantInfo?.business_number || "";
    const officeNumber = rawOfficeNumber.replace(/-/g, "");
    if (currentOfficeId && !currentOffice?.business_number) {
      alert(`事業所「${currentOffice?.name ?? ""}」に事業所番号が設定されていません。設定タブで登録してください。`);
      return;
    }
    const lateClientIdsCsv = new Set<string>([
      ...autoLateClients,
      ...Array.from(lateFlags.keys()),
    ]);
    const billingGroups = clientGroups.filter((g) => !lateClientIdsCsv.has(g.client.id));
    // 要介護度をコードにできず外した人 (月遅れ扱い) は確認ダイアログにも出す
    const noCareLevelNames = clientGroups.filter((g) => noCareLevelClients.has(g.client.id)).map((g) => g.client.name);

    // 公費 (生保 等) 情報を当月分だけ取得 (期間と本人支払額つき。lib/fukuyoguKohiMonth.ts)。
    //   月途中の公費は「公費の扱い」(kohiModes) で、本人支払額は介護券の額までを本人負担に (fukuyogu-amounts.ts)。
    const monthStart = `${billingMonth}-01`;
    const monthEnd = monthEndYmd(y, m);
    let kohiLoad: Awaited<ReturnType<typeof loadKohiForMonth>>;
    try {
      // 1,000 人分を 1 回の .in() に渡すと URL が長すぎて 400 になる → 150 人ずつ (lib/inChunks.ts)
      kohiLoad = await loadKohiForMonth(tenantId, billingGroups.map((g) => g.client.id), monthStart, monthEnd, { officeId: currentOfficeId, perOfficeIds });
    } catch (e) {
      const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
      console.error("公費取得失敗:", msg);
      alert(`公費情報の取得に失敗しました: ${msg}`);
      return;
    }
    const kohiByClient = kohiLoad.byClient;

    // 軽度者(要支援1・2/要介護1) 原則対象外品目の例外給付記録を取得 (B-6d・2026-09-05)
    // ⚠ migrations/fukuyogu_exception_grants.sql が未適用の間はテーブルが無いので、
    //   その場合はこの警告そのものをスキップする (伝送生成自体は止めない)。
    let exceptionGrants: Awaited<ReturnType<typeof getExceptionGrants>> = [];
    let exceptionCheckAvailable = true;
    try {
      exceptionGrants = await getExceptionGrants(tenantId, billingGroups.map((g) => g.client.id));
    } catch (e) {
      if (isTableMissingError(e as { code?: string })) {
        exceptionCheckAvailable = false;
      } else {
        console.error("例外給付記録の取得失敗:", e);
      }
    }

    // ★ 2026-10-15 (B-2i): 上限価格を超える貸与は 月額全体が保険給付の対象外 (超過分だけではない)。
    //   以前は請求画面も伝送も上限を一切見ておらず、発注入力の 2 画面でしか警告が出なかった
    //   (実例: KMD-R12 13,000 円。2026-07 施行の公表で上限 12,850 円が初めて付き、以後毎月超過)。
    //   判定は lib/ceilingCheck.ts (check:ceiling-rental と同じ関数)。読めなくても伝送は止めない。
    let ceilingIndex: ReturnType<typeof indexCeilings> | null = null;
    const preWarnings: string[] = [];
    const benefitNoCert: string[] = []; // 負担割合証なしで認定行の給付率を使った利用者 (FY-H)
    try {
      ceilingIndex = indexCeilings(await getCeilingPrices(tenantId));
    } catch (e) {
      preWarnings.push(`上限価格マスタを読めなかったため上限超過の確認をしていません: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 明細行 → 利用者ごとの請求行を組む
    const rows: FukuyoguSeikyuRow[] = [];
    for (const n of kohiLoad.notices) preWarnings.push(n);
    if (noCareLevelNames.length > 0) {
      preWarnings.push(`要介護度をコードにできない (当月に有効な認定が無い 等) ため伝送から除外し月遅れ扱いにしました ${noCareLevelNames.length} 名: ${noCareLevelNames.join("・")} — 認定を登録してください`);
    }
    if (kohiModesNotice) preWarnings.push(kohiModesNotice);
    if (pausesNotice) preWarnings.push(pausesNotice);
    if (prorationNotice) preWarnings.push(prorationNotice);
    for (const { client, items } of billingGroups) {
      const details: FukuyoguDetailLine[] = [];
      // 明細と同じ並びの貸与期間 (月途中の公費の判定・明細の公費対象に使う)
      const lineDates: { rentalStart: string | null; rentalEnd: string | null; pauses: DateRange[] }[] = [];
      const ceilingLines: (CeilingRentalLine & { name: string })[] = [];
      let totalUnits = 0;
      for (const item of items) {
        const eq = equipmentByCode.get(item.product_code);
        const unitPer = getUnits(item, client.id);
        const count = item.quantity;
        const units = unitPer * count;
        if (units <= 0) continue;
        // ⚠ 終了日 < 開始日 (壊れたデータ) は 貸与日 0 日として計算される (旧 calcMonthUnits は満額を返していた)。
        //   値は変えず (null にすると請求から消えて、それはそれで黙る) 警告だけ出す。
        //   実測 (2026-09-03): 4,669 行中 該当 0 行。
        if (hasBrokenRentalDates(item)) {
          preWarnings.push(`${client.name}: ${eq?.name ?? item.product_code} の貸与期間が逆転しています (${item.rental_start_date} 〜 ${item.rental_end_date}) — 満額で請求に載ります`);
        }
        // 軽度者 原則対象外品目 × 例外給付記録なし の警告 (B-6d)。
        // ⚠ 断定はしない。「例外給付を取っていない」ではなく「記録が無い」だけを示す。
        if (exceptionCheckAvailable && isKeidoRestricted(client.care_level, eq?.category)) {
          const group = RESTRICTION_GROUP_OF_CATEGORY[eq?.category ?? ""];
          const onDate = `${billingMonth}-01`;
          if (!hasActiveGrant(exceptionGrants, client.id, group, onDate)) {
            preWarnings.push(
              `${client.name}(${client.care_level}): ${eq?.name ?? item.product_code} は軽度者の原則対象外品目ですが、例外給付の記録がありません — ` +
              `記録が無いだけの可能性があります。実際に例外給付を受けているか確認し、利用者タブから記録してください`,
            );
          }
        }
        const code = fukuyoguServiceCode(eq?.category);
        if (!code) {
          preWarnings.push(`${client.name}: 種目「${eq?.category ?? "未設定"}」(${eq?.name ?? item.product_code}) の福祉用具貸与サービスコードが不明です`);
          continue;
        }
        details.push({
          serviceCode: code, unitPer, count, units,
          days: fukuyoguRentalDaysInMonth(item.rental_start_date, item.rental_end_date, billingMonth, pausesOf(item.id)),
          taisCode: eq?.tais_code ?? null,
        });
        lineDates.push({ rentalStart: item.rental_start_date ?? null, rentalEnd: item.rental_end_date ?? null, pauses: pausesOf(item.id) });
        totalUnits += units;
        ceilingLines.push({
          id: item.id,
          name: eq?.name ?? item.product_code,
          taisCode: eq?.tais_code,
          // 上限と比べるのは 月額 (半月按分前)。getUnits と同じく当月時点の改定価格 → マスタ価格
          price: getPriceForMonth(priceHistoryAll, item.product_code, billingMonth, officeOfItem(item)) ?? eq?.rental_price ?? null,
          quantity: item.quantity,
        });
      }
      if (details.length === 0) continue;
      if (ceilingIndex) {
        for (const o of findRentalOverruns(ceilingLines, `${billingMonth}-01`, ceilingIndex)) {
          const l = ceilingLines.find((x) => x.id === o.id);
          preWarnings.push(
            `${client.name}: ${l?.name ?? ""} の月額 ${o.price.toLocaleString()}円 が上限価格 ${o.ceiling.toLocaleString()}円 (${o.effectiveFrom} 施行) を ${o.excess.toLocaleString()}円 超えています — 上限超過の貸与は月額全体が保険給付の対象外です (返戻になります)。価格を見直してください`,
          );
        }
      }
      // 給付率 (benefit_rate は 90/80/70 の給付率で保存済み)、福祉用具は単価 10 円固定
      // 2026-08-31 監査: 未設定を**無警告で 90 (1割負担)** にしていた。
      //   clients.benefit_rate は実測 (2026-09-03) で NULL が **5,008 名 (55%)**。
      //   (2026-08-31 時点の「583 名」は古い数字だった。5-4: 実測日を添える)
      //   ⚠ ただし請求に出るのはその月にレンタルがある人だけで、2026-06 は
      //     1,056 名中 **NULL 0 名**。警告が 5,008 件出るわけではない。
      //   ⚠ 給付率は 認定 (client_insurance_records) から導出するのが本筋。
      //     点検 = scripts/benefit-rate-check.mts / 是正 =
      //     kaigo-app/migrations/fix_clients_benefit_rate_from_cert.mjs
      //   2割負担者を 1割で出すと
      //   費用総額7,200円 → 保険請求 6,480円 (正は 5,760円) = 720円/月 の過大請求 → 返戻。
      //   `|| 90` のせいで "0" も 90 になっていた。
      //   既定 (90) は変えず、必ず気づけるように警告を出す。
      // ★ 2026-10-15: 公費単独 (被保険者番号 H) は保険 0・公費 10 割。計算は純関数に一本化
      //   (lib/kokuho-densou/fukuyogu-amounts.ts。返戻・過誤の再請求と同じ式を使う)。
      const kohi = kohiByClient.get(client.id) ?? null;
      const amt = computeFukuyoguAmounts({
        // ★ 給付率は 提供月に掛かる負担割合証 (無ければ認定行) で (FY-H。表が未適用なら clients.benefit_rate のまま)
        benefitRateRaw: benefitRawForMonth(client, monthStart, monthEnd, (w) => preWarnings.push(`${client.name}: ${w}`), benefitNoCert),
        insuredNumber: client.insured_number,
        totalUnits,
        kohi,
        // ★ CM 指示単位数で頭打ち (入力が無ければ実績で請求)
        cmUnits: cmUnits.get(client.id) ?? null,
        // ★ 月途中の公費: 用具ごとの貸与期間と「公費の扱い」(未選択は既定 + 警告)
        month: billingMonth,
        lines: details.map((d, i) => ({ unitPer: d.unitPer, count: d.count, units: d.units, ...lineDates[i] })),
        kohiMode: kohiModes.get(client.id) ?? null,
      });
      for (const w of kohiLoad.clientWarnings.get(client.id) ?? []) preWarnings.push(`${client.name}: ${w}`);
      for (const w of amt.warnings) preWarnings.push(`${client.name}: ${w}`);
      for (const w of dailyProrationWarnings(client, items, billingMonth, kohi,
        details.map((d, i) => ({ unitPer: d.unitPer, count: d.count, units: d.units, ...lineDates[i] })))) preWarnings.push(w);
      if (amt.kohiPieces) amt.kohiPieces.forEach((ps, i) => { details[i].kohiPieces = ps; });
      const { copayRate, totalCost, insuranceAmount, userAmount, kohiAmount } = amt;
      const dc = densouCertOf(client, pickCertForMonth((insByClient.get(client.id) ?? []), monthStart, monthEnd,
        { insurerNumber: client.insurer_number, insuredNumber: client.insured_number }));
      const careOffice = dc.careOfficeId
        ? careOfficeById.get(dc.careOfficeId) ?? null
        : null;
      rows.push({
        userName: client.name,
        insurerNumber: dc.insurerNumber,
        // 2026-08-31 監査: `?? client.user_number` で**社内の利用者番号**にフォールバック
        //   していた。無関係な番号で請求/実績が立ち、しかも build.ts の
        //   `if (!insured) warnings.push(...)` が user_number で埋まって発火しない
        //   = 完全な silent failure。実測で insured_number が空の client は 1,047 名。
        //   空のまま渡して警告を出させる (返戻にはなるが、誤った番号で通るより良い)。
        insuredNumber: dc.insuredNumber,
        birthDate: client.birth_date,
        gender: client.gender,
        // ★ 要介護度・認定期間は 当月に有効な認定レコードを優先 (per_office は自事業所の認定行だけ。上の densouCertOf)
        careLevel: dc.careLevel, certStart: dc.certStart, certEnd: dc.certEnd,
        careOfficeNumber: careOffice?.office_number ?? null,
        carePlanKubun: (careOffice as { plan_kubun?: string | null } | undefined)?.plan_kubun ?? null,
        copayRate,
        details,
        // ★ 保険請求の単位数 = 頭打ち後 / 限度額管理対象 = 実績 / 計画単位数 = CM 指示 (build.ts の注記)
        totalUnits: amt.billedUnits,
        limitTargetUnits: amt.actualUnits,
        planUnits: amt.planUnits,
        // ★ その月に CM 指示単位数が 1 件でも入っていれば、未入力の人は月遅れ扱い (build.ts の注記)
        cmMissing: cmEntered.size > 0 && !cmEntered.has(client.id),
        totalCost,
        insuranceAmount,
        userAmount,
        kohiHobetsu: amt.kohiHobetsu,
        kohiFutansha: kohi?.futansha ?? null,
        kohiJukyusha: kohi?.jukyusha ?? null,
        kohiAmount,
        kohiTandoku: amt.kohiTandoku,
        kohiUnits: amt.kohiUnits,
        kohiTargetCost: amt.kohiTargetCost,
        kohiHonninFutan: amt.kohiHonninFutan,
        // 開始年月日 (7131/7132-01 項21): その利用者の介護保険の貸与の最初の開始日が当月内なら (2026-11-13〜)。
        //   貸与の開始日を提供票から組み直したので ほのぼのと一致する (9 月で 38 一致・食い違い 0)。
        //   中止年月日 (項22) は ほのぼのと食い違う行がまだあるので渡さない (lib/kokuho-densou/fukuyogu-period.ts)
        serviceStartDate: fukuyoguServiceStartDate(
          orderItems.filter((it) => {
            const o = ordersById.get(it.order_id);
            return o?.client_id === client.id && (it.status === "rental_started" || it.status === "terminated")
              && (it.payment_type ?? o?.payment_type ?? "介護") === "介護";
          }).map((it) => ({ rentalStart: it.rental_start_date, rentalEnd: it.rental_end_date })),
          billingMonth),
      });
    }

    if (rows.length === 0) {
      alert("対象月に国保連請求対象の福祉用具貸与がありません。");
      return;
    }
    if (cmUnitsNotice) preWarnings.unshift(cmUnitsNotice);
    { const s = benefitNoCertSummary(benefitNoCert); if (s) preWarnings.unshift(s); }

    const result = buildFukuyoguDensou(rows, { officeNumber, year: y, month: m });
    const allWarnings = [...preWarnings, ...result.warnings];
    if (allWarnings.length > 0) {
      const list = allWarnings.slice(0, 12).join("\n・");
      const ok = window.confirm(
        `以下の項目が不足しています (伝送ソフトの取込チェックでエラーになる可能性があります):\n\n・${list}${allWarnings.length > 12 ? `\n…他 ${allWarnings.length - 12} 件` : ""}\n\nこのままファイルを出力しますか？`,
      );
      if (!ok) return;
    }

    // Shift_JIS で出力 (仕様: 伝送ファイルの文字コードはシフト JIS)
    const sjis = Encoding.convert(Encoding.stringToCode(result.content), {
      to: "SJIS",
      from: "UNICODE",
    });
    const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ケアプランデータ連携 V4.1: 第6表実績 (UPJSK) を送信先の居宅介護支援事業所ごとに 1 ファイル出力
  const generateCareplanJissekiCsv = () => {
    const [y, m] = billingMonth.split("-").map(Number);
    const currentOffice = offices.find(o => o.id === currentOfficeId);
    const rawOfficeNumber = currentOffice?.business_number || tenantInfo?.business_number || "";
    const senderOfficeNumber = rawOfficeNumber.replace(/-/g, "");
    if (!senderOfficeNumber) {
      alert("送信元の事業所番号が設定されていません。設定タブで登録してください。");
      return;
    }
    const senderOfficeName = currentOffice?.name || tenantInfo?.name || "";
    const monthStartIso = `${billingMonth}-01`;

    // 実績票の送信単位 = サービス種類コード + 事業所番号ごと → 担当居宅事業所ごとにグルーピング
    const byCareOffice = new Map<string, { officeName: string; officeNumber: string; users: FukuyoguJissekiUser[] }>();
    const preWarnings: string[] = [];
    for (const { client, items } of clientGroups) {
      const careOffice = client.care_office_id
        ? careOfficeById.get(client.care_office_id) ?? null
        : null;
      if (!careOffice) {
        preWarnings.push(`${client.name}: 居宅介護支援事業所がマスタ未紐付けのためスキップしました`);
        continue;
      }
      const receiverNumber = (careOffice.office_number ?? "").replace(/-/g, "");
      if (!receiverNumber) {
        preWarnings.push(`${client.name}: 居宅「${careOffice.name}」の事業所番号が未登録のためスキップしました`);
        continue;
      }
      const jissekiItems: FukuyoguJissekiUser["items"] = [];
      for (const item of items) {
        const eq = equipmentByCode.get(item.product_code);
        const code = fukuyoguServiceCode(eq?.category);
        if (!code) {
          preWarnings.push(`${client.name}: 種目「${eq?.category ?? "未設定"}」(${eq?.name ?? item.product_code}) の福祉用具貸与サービスコードが不明です`);
          continue;
        }
        const units = getUnits(item, client.id);
        if (units <= 0) continue; // 全月入院等は実績なし
        // サービス利用日 = 月内の貸与開始日 (前月以前からの継続は月初日)
        const serviceDate =
          item.rental_start_date && item.rental_start_date > monthStartIso
            ? item.rental_start_date
            : monthStartIso;
        jissekiItems.push({
          serviceCode: code,
          units,
          quantity: item.quantity,
          taisCode: eq?.tais_code ?? null,
          todokedeCode: null, // equipment_master に届出コード列は無し (TAIS のみ)
          equipmentName: eq?.name ?? item.product_code,
          serviceDate,
        });
      }
      if (jissekiItems.length === 0) continue;
      if (!byCareOffice.has(receiverNumber)) {
        byCareOffice.set(receiverNumber, { officeName: careOffice.name, officeNumber: receiverNumber, users: [] });
      }
      byCareOffice.get(receiverNumber)!.users.push({
        name: client.name,
        insurerNumber: client.insurer_number,
        // 2026-08-31 監査: `?? client.user_number` で**社内の利用者番号**にフォールバック
        //   していた。無関係な番号で請求/実績が立ち、しかも build.ts の
        //   `if (!insured) warnings.push(...)` が user_number で埋まって発火しない
        //   = 完全な silent failure。実測で insured_number が空の client は 1,047 名。
        //   空のまま渡して警告を出させる (返戻にはなるが、誤った番号で通るより良い)。
        insuredNumber: client.insured_number ?? null,
        planStaffName: client.care_manager || careOffice.name,
        items: jissekiItems,
      });
    }

    if (byCareOffice.size === 0) {
      alert(
        "対象月にケアプラン連携で送信できる福祉用具貸与の実績がありません。" +
          (preWarnings.length > 0 ? `\n\n・${preWarnings.slice(0, 12).join("\n・")}` : ""),
      );
      return;
    }

    // ビルド (警告収集) → 確認 → 事業所ごとに 1 ファイルずつダウンロード
    const results: { content: string; fileName: string; officeName: string; recordCount: number }[] = [];
    const allWarnings = [...preWarnings];
    for (const g of byCareOffice.values()) {
      const result = buildFukuyoguJissekiCsv(g.users, {
        year: y,
        month: m,
        senderOfficeNumber,
        senderOfficeName,
        receiverOfficeNumber: g.officeNumber,
      });
      allWarnings.push(...result.warnings);
      if (result.content) {
        results.push({ content: result.content, fileName: result.fileName, officeName: g.officeName, recordCount: result.recordCount });
      }
    }
    if (results.length === 0) {
      alert("出力対象の実績レコードがありませんでした。\n\n・" + allWarnings.slice(0, 12).join("\n・"));
      return;
    }
    if (allWarnings.length > 0) {
      const list = allWarnings.slice(0, 12).join("\n・");
      const ok = window.confirm(
        `以下の項目が不足しています (連携システムの取込チェックでエラーになる可能性があります):\n\n・${list}${allWarnings.length > 12 ? `\n…他 ${allWarnings.length - 12} 件` : ""}\n\nこのままファイルを出力しますか？`,
      );
      if (!ok) return;
    }
    for (const r of results) {
      const sjis = Encoding.convert(Encoding.stringToCode(r.content), { to: "SJIS", from: "UNICODE" });
      const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.fileName;
      a.click();
      URL.revokeObjectURL(url);
    }
    alert(
      `ケアプラン連携の実績ファイル (UPJSK) を ${results.length} 件出力しました。\n` +
        results.map((r) => `・${r.officeName} (${r.recordCount} 明細)`).join("\n") +
        "\n\nケアプランデータ連携システム (専用ソフト) にアップロードしてください。",
    );
  };

  // 過去月の再請求グループ（返戻・過誤フラグがある月ごとに集計）
  const rebillByMonth = useMemo(() => {
    const result = new Map<string, Array<{ client: BillingClient; items: OrderItem[]; flag: BillingRebillFlag }>>();
    for (const flag of rebillFlags.values()) {
      if (flag.month === billingMonth) continue;
      const client = clientsById.get(flag.client_id);
      if (!client) continue;
      const [y, m] = flag.month.split("-").map(Number);
      const monthStart = new Date(y, m - 1, 1);
      const monthEnd = new Date(y, m, 0, 23, 59, 59);
      const items = orderItems.filter((item) => {
        const order = ordersById.get(item.order_id);
        if (order?.client_id !== client.id) return false;
        const pt = item.payment_type ?? ordersById.get(item.order_id)?.payment_type ?? "介護";
        if (pt !== "介護") return false;
        if (!item.rental_start_date) return false;
        const start = new Date(item.rental_start_date);
        if (start > monthEnd) return false;
        if (item.status === "terminated" && item.rental_end_date) {
          const end = new Date(item.rental_end_date);
          if (end < monthStart) return false;
        }
        if (item.status !== "rental_started" && item.status !== "terminated") return false;
        return true;
      });
      if (!result.has(flag.month)) result.set(flag.month, []);
      result.get(flag.month)!.push({ client, items, flag });
    }
    return Array.from(result.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [rebillFlags, billingMonth, orderItems, ordersById, clientsById]);

  // 返戻・過誤の過去月別 伝送ファイル生成 (サービス提供年月ごとに 1 ファイル)。
  // 返戻=補正して再請求 / 過誤=取下げ後の再請求。いずれも当該月の通常請求として出力する
  // (過誤の取下げ(取消)処理自体は国保連側の別手続き)。
  const generateRebillTransferData = async () => {
    // 返戻過誤も 負担割合証 (benefitRawForMonth) を使う。CM 指示・公費の扱いは月ごとに読み直すが 足並みを揃えて同じ条件で待つ
    if (!densouInputsReady) { densouNotReadyAlert(); return; }
    const currentOffice = offices.find((o) => o.id === currentOfficeId);
    const rawOfficeNumber = currentOffice?.business_number || tenantInfo?.business_number || "";
    const officeNumber = rawOfficeNumber.replace(/-/g, "");
    if (currentOfficeId && !currentOffice?.business_number) {
      alert(`事業所「${currentOffice?.name ?? ""}」に事業所番号が設定されていません。設定タブで登録してください。`);
      return;
    }
    if (rebillByMonth.length === 0) {
      alert("返戻・過誤の対象がありません。");
      return;
    }
    const allWarnings: string[] = [];
    let fileCount = 0;
    // 軽度者 原則対象外品目 × 例外給付記録なし の警告 (B-6d)。generateTransferData と同じロジック。
    let exceptionGrants: Awaited<ReturnType<typeof getExceptionGrants>> = [];
    let exceptionCheckAvailable = true;
    try {
      const allClientIds = [...new Set(rebillByMonth.flatMap(([, entries]) => entries.map((e) => e.client.id)))];
      exceptionGrants = await getExceptionGrants(tenantId, allClientIds);
    } catch (e) {
      if (isTableMissingError(e as { code?: string })) exceptionCheckAvailable = false;
      else console.error("例外給付記録の取得失敗:", e);
    }
    for (const [ym, entries] of rebillByMonth) {
      const [yy, mm] = ym.split("-").map(Number);
      // 公費 (当該月有効分)
      const monthStart = `${ym}-01`;
      const monthEnd = monthEndYmd(yy, mm);
      const clientIds = entries.map((e) => e.client.id);
      // 期間・本人支払額つき (lib/fukuyoguKohiMonth.ts。150 人ずつ読む)
      let kohiLoad: Awaited<ReturnType<typeof loadKohiForMonth>>;
      try {
        kohiLoad = await loadKohiForMonth(tenantId, clientIds, monthStart, monthEnd, { officeId: currentOfficeId, perOfficeIds });
      } catch (e) {
        const msg = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
        console.error("公費取得失敗:", msg);
        alert(`公費情報の取得に失敗しました: ${msg}`);
        return;
      }
      const kohiByClient = kohiLoad.byClient;
      for (const n of kohiLoad.notices) allWarnings.push(`[${ym}] ${n}`);
      // ★ 月途中の公費の扱い (その月の値)。読めなければ全員 既定の扱いで請求し、その旨を警告に出す
      const modeLoad = await getKohiMonthModes(tenantId, ym, currentOfficeId);
      if (modeLoad.message) allWarnings.push(`[${ym}] ${modeLoad.message}`);
      // ★ CM 指示単位数 (その月の値)。読めなければ全員 実績で請求し、その旨を警告に出す
      const cmLoad = await getCmUnits(tenantId, ym, currentOfficeId);
      if (cmLoad.message) allWarnings.push(`[${ym}] ${cmLoad.message}`);
      if (pausesNotice) allWarnings.push(`[${ym}] ${pausesNotice}`);
      if (prorationNotice) allWarnings.push(`[${ym}] ${prorationNotice}`);
      const benefitNoCert: string[] = []; // 負担割合証なしで認定行の給付率を使った利用者 (FY-H)
      const rows: FukuyoguSeikyuRow[] = [];
      for (const { client, items } of entries) {
        const details: FukuyoguDetailLine[] = [];
        const lineDates: { rentalStart: string | null; rentalEnd: string | null; pauses: DateRange[] }[] = [];
        let totalUnits = 0;
        for (const item of items) {
          const eq = equipmentByCode.get(item.product_code);
          const unitPer = computeUnitsForMonth(item, client.id, ym);
          const count = item.quantity;
          const units = unitPer * count;
          if (units <= 0) continue;
          if (exceptionCheckAvailable && isKeidoRestricted(client.care_level, eq?.category)) {
            const group = RESTRICTION_GROUP_OF_CATEGORY[eq?.category ?? ""];
            if (!hasActiveGrant(exceptionGrants, client.id, group, `${ym}-01`)) {
              allWarnings.push(
                `[${ym}] ${client.name}(${client.care_level}): ${eq?.name ?? item.product_code} は軽度者の原則対象外品目ですが、例外給付の記録がありません`,
              );
            }
          }
          const code = fukuyoguServiceCode(eq?.category);
          if (!code) {
            allWarnings.push(`[${ym}] ${client.name}: 種目「${eq?.category ?? "未設定"}」のサービスコードが不明です`);
            continue;
          }
          details.push({
            serviceCode: code, unitPer, count, units,
            days: fukuyoguRentalDaysInMonth(item.rental_start_date, item.rental_end_date, ym, pausesOf(item.id)),
            taisCode: eq?.tais_code ?? null,
          });
          lineDates.push({ rentalStart: item.rental_start_date ?? null, rentalEnd: item.rental_end_date ?? null, pauses: pausesOf(item.id) });
          totalUnits += units;
        }
        if (details.length === 0) continue;
        // 2026-08-31 監査: 未設定を**無警告で 90 (1割負担)** にしていた。
        //   clients.benefit_rate は実測 (2026-09-03) で NULL が **5,008 名 (55%)**。
      //   (2026-08-31 時点の「583 名」は古い数字だった。5-4: 実測日を添える)
      //   ⚠ ただし請求に出るのはその月にレンタルがある人だけで、2026-06 は
      //     1,056 名中 **NULL 0 名**。警告が 5,008 件出るわけではない。
      //   ⚠ 給付率は 認定 (client_insurance_records) から導出するのが本筋。
      //     点検 = scripts/benefit-rate-check.mts / 是正 =
      //     kaigo-app/migrations/fix_clients_benefit_rate_from_cert.mjs
      //   2割負担者を 1割で出すと
        //   費用総額7,200円 → 保険請求 6,480円 (正は 5,760円) = 720円/月 の過大請求 → 返戻。
        //   `|| 90` のせいで "0" も 90 になっていた。
        //   既定 (90) は変えず、必ず気づけるように警告を出す。
        // ★ 2026-10-15: 公費単独 (H) を含め、通常請求と同じ純関数で計算する
        const kohi = kohiByClient.get(client.id) ?? null;
        const amt = computeFukuyoguAmounts({
          // ★ 給付率は 提供月 (ym) に掛かる負担割合証 (無ければ認定行) で (FY-H)
          benefitRateRaw: benefitRawForMonth(client, monthStart, monthEnd, (w) => allWarnings.push(`[${ym}] ${client.name}: ${w}`), benefitNoCert),
          insuredNumber: client.insured_number,
          totalUnits,
          kohi,
          cmUnits: cmLoad.byClient.get(client.id) ?? null,
          month: ym,
          lines: details.map((d, i) => ({ unitPer: d.unitPer, count: d.count, units: d.units, ...lineDates[i] })),
          kohiMode: modeLoad.byClient.get(client.id) ?? null,
        });
        for (const w of kohiLoad.clientWarnings.get(client.id) ?? []) allWarnings.push(`[${ym}] ${client.name}: ${w}`);
        for (const w of amt.warnings) allWarnings.push(`[${ym}] ${client.name}: ${w}`);
        for (const w of dailyProrationWarnings(client, items, ym, kohi,
          details.map((d, i) => ({ unitPer: d.unitPer, count: d.count, units: d.units, ...lineDates[i] })))) allWarnings.push(`[${ym}] ${w}`);
        if (amt.kohiPieces) amt.kohiPieces.forEach((ps, i) => { details[i].kohiPieces = ps; });
        const { copayRate, totalCost, insuranceAmount } = amt;
        const dc = densouCertOf(client, pickCertForMonth((insByClient.get(client.id) ?? []), monthStart, monthEnd,
          { insurerNumber: client.insurer_number, insuredNumber: client.insured_number }));
        const careOffice = dc.careOfficeId
          ? careOfficeById.get(dc.careOfficeId) ?? null
          : null;
        rows.push({
          userName: client.name,
          insurerNumber: dc.insurerNumber,
          // 2026-08-31 監査: `?? client.user_number` で**社内の利用者番号**にフォールバック
          //   していた。無関係な番号で請求/実績が立ち、しかも build.ts の
          //   `if (!insured) warnings.push(...)` が user_number で埋まって発火しない
          //   = 完全な silent failure。実測で insured_number が空の client は 1,047 名。
          //   空のまま渡して警告を出させる (返戻にはなるが、誤った番号で通るより良い)。
          insuredNumber: dc.insuredNumber,
          birthDate: client.birth_date,
          gender: client.gender,
          // ★ 要介護度・認定期間は 当月に有効な認定レコードを優先 (per_office は自事業所の認定行だけ。上の densouCertOf)
          careLevel: dc.careLevel, certStart: dc.certStart, certEnd: dc.certEnd,
          careOfficeNumber: careOffice?.office_number ?? null,
        carePlanKubun: (careOffice as { plan_kubun?: string | null } | undefined)?.plan_kubun ?? null,
          copayRate,
          details,
          totalUnits: amt.billedUnits,
          limitTargetUnits: amt.actualUnits,
          planUnits: amt.planUnits,
          cmMissing: cmLoad.entered.size > 0 && !cmLoad.entered.has(client.id),
          totalCost,
          insuranceAmount,
          userAmount: amt.userAmount,
          kohiHobetsu: amt.kohiHobetsu,
          kohiFutansha: kohi?.futansha ?? null,
          kohiJukyusha: kohi?.jukyusha ?? null,
          kohiAmount: amt.kohiAmount,
          kohiTandoku: amt.kohiTandoku,
          kohiUnits: amt.kohiUnits,
          kohiTargetCost: amt.kohiTargetCost,
          kohiHonninFutan: amt.kohiHonninFutan,
        });
      }
      if (rows.length === 0) continue;
      { const s = benefitNoCertSummary(benefitNoCert); if (s) allWarnings.push(`[${ym}] ${s}`); }
      const result = buildFukuyoguDensou(rows, { officeNumber, year: yy, month: mm });
      allWarnings.push(...result.warnings.map((w) => `[${ym}] ${w}`));
      const sjis = Encoding.convert(Encoding.stringToCode(result.content), { to: "SJIS", from: "UNICODE" });
      const blob = new Blob([new Uint8Array(sjis)], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);
      fileCount++;
    }
    if (fileCount === 0) {
      alert("返戻・過誤の出力対象がありませんでした。");
      return;
    }
    alert(
      `返戻・過誤の伝送ファイルを ${fileCount} 件(月別)出力しました。` +
      (allWarnings.length > 0 ? `\n\n⚠ 不足項目 (取込前に確認):\n・${allWarnings.slice(0, 10).join("\n・")}${allWarnings.length > 10 ? `\n…他 ${allWarnings.length - 10} 件` : ""}` : ""),
    );
  };

  const [y, m] = billingMonth.split("-").map(Number);
  const prevMonth = () => { const d = new Date(y, m - 2, 1); setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const d = new Date(y, m, 1); setBillingMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  // 未保存の変更があるまま画面遷移する前に確認する
  const confirmLeave = () => !isDirty || window.confirm("保存されていない変更があります。破棄して移動しますか？");
  const guardedPrevMonth = () => { if (confirmLeave()) prevMonth(); };
  const guardedNextMonth = () => { if (confirmLeave()) nextMonth(); };
  const guardedSetSubTab = (id: BillingSubTab) => { if (confirmLeave()) changeSubTab(id); };

  const [detailClient, setDetailClient] = useState<{ client: BillingClient; items: OrderItem[] } | null>(null);
  const [rentalGridClient, setRentalGridClient] = useState<{ client: BillingClient; items: OrderItem[] } | null>(null);
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);
  const [kokuhoOnly, setKokuhoOnly] = useState(true); // true=国保連提出対象(月遅れ除く)のみ / false=全件
  const [showRentalGridView, setShowRentalGridView] = useState(false);
  const [gridSelectedClient, setGridSelectedClient] = useState<{ client: BillingClient; items: OrderItem[] } | null>(null);
  const [gridKanaFilter, setGridKanaFilter] = useState<string | null>(null);
  const [isGridPending, startGridTransition] = useTransition();
  const KANA_ROWS = ["あ","か","さ","た","な","は","ま","や","ら","わ","他"];
  const KANA_MAP: Record<string, string[]> = {
    "あ":["ア","イ","ウ","エ","オ"],"か":["カ","キ","ク","ケ","コ","ガ","ギ","グ","ゲ","ゴ"],
    "さ":["サ","シ","ス","セ","ソ","ザ","ジ","ズ","ゼ","ゾ"],"た":["タ","チ","ツ","テ","ト","ダ","ヂ","ヅ","デ","ド"],
    "な":["ナ","ニ","ヌ","ネ","ノ"],"は":["ハ","ヒ","フ","ヘ","ホ","バ","ビ","ブ","ベ","ボ","パ","ピ","プ","ペ","ポ"],
    "ま":["マ","ミ","ム","メ","モ"],"や":["ヤ","ユ","ヨ"],
    "ら":["ラ","リ","ル","レ","ロ"],"わ":["ワ","ヲ","ン"],
  };
  // ひらがな→カタカナ正規化
  const toKana = (s: string) => s
    .normalize("NFC")
    .replace(/[\uff66-\uff9f]/g, (c) => HW_KANA[c] ?? c)                                        // \u534a\u89d2\u30ab\u30ca\u2192\u5168\u89d2\u30ab\u30ca
    .replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));  // \u3072\u3089\u304c\u306a\u2192\u30ab\u30bf\u30ab\u30ca
  const allKana = Object.values(KANA_MAP).flat();

  const filteredGroups = kanaFilter
    ? clientGroups.filter(({ client }) => {
        const first = toKana((client.furigana ?? client.name).charAt(0));
        if (kanaFilter === "他") return !allKana.includes(first);
        return (KANA_MAP[kanaFilter] ?? []).includes(first);
      })
    : clientGroups;

  const gridFilteredGroups = gridKanaFilter
    ? clientGroups.filter(({ client }) => {
        const first = toKana((client.furigana ?? client.name).charAt(0));
        if (gridKanaFilter === "他") return !allKana.includes(first);
        return (KANA_MAP[gridKanaFilter] ?? []).includes(first);
      })
    : clientGroups;

  // 全行（当月 + 再請求）
  const allRows = [
    ...filteredGroups.map(g => ({ type: "current" as const, ...g })),
    ...rebillByMonth.flatMap(([month, entries]) =>
      entries.map(({ client, items, flag }) => ({ type: "rebill" as const, client, items, flag, month }))
    ),
  ];

  // 国保対象フィルタ: ON なら 自動の月遅れ (認定 申請中 等) の当月行を除外。再請求(過去月)行は国保連提出対象なので常に残す。
  // ★ 2026-11-13 user 依頼: 手で「月遅」にした行は ON でも一覧に残す (黄色の行・月遅の印)。
  //   旧: 月遅にした瞬間に一覧から消え、その月の画面で月遅れにしたことが見えなくなっていた。
  //   金額には入らない (伝送 = 1059 行付近・フッター合計 = billingGroupsForTotal は lateFlags で別に除外している)
  const displayRows = kokuhoOnly
    ? allRows.filter((r) => r.type === "rebill" || lateFlags.has(r.client.id) || !autoLateClients.has(r.client.id))
    : allRows;

  // ★ 2026-11-13 高速化: 介護請求の一覧 (約 1,150 行) は 行を React.memo の部品 (BillingClientRow) にし、
  //   データが届くたびに全行を描き直さない。行ごとの値はここで 1 回だけ作る (旧: 描画のたびに行ごとに 認定の選択・単位の合計)。
  //   操作は 1 つの安定したオブジェクト (rowActions) で渡す。中身は描画のあとに最新の関数へ差し替える (rowActionsImpl)
  const unitsByClient = useMemo(() => {
    const out = new Map<string, number>();
    for (const { client, items } of clientGroups) out.set(client.id, items.reduce((ss, item) => ss + getUnits(item, client.id) * item.quantity, 0));
    return out;
    // getUnits は毎回作り直す関数なので、中で読む state を並べる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientGroups, unitOverrides, equipmentByCode, priceHistoryAll, billingMonth, hospByClient, pauses, prorations]);
  const rowCertInfo = useMemo(() => {
    const out = new Map<string, { isApplying: boolean; careOfficeName: string }>();
    const monthStart = `${billingMonth}-01`;
    const monthEnd = monthEndYmd(y, m);
    for (const { client } of clientGroups) {
      // 認定の選び方は 月遅れ自動判定・伝送と同じ (被保番が一致する認定を優先)
      const insRec = pickCertForMonth((insByClient.get(client.id) ?? []), monthStart, monthEnd,
        { insurerNumber: client.insurer_number, insuredNumber: client.insured_number });
      const careOfficeId = client.care_office_id ?? insRec?.care_office_id ?? null;
      out.set(client.id, {
        isApplying: insRec?.certification_status === "申請中",
        careOfficeName: careOfficeId ? careOfficeById.get(careOfficeId)?.name ?? "" : client.care_manager_org ?? "",
      });
    }
    return out;
  }, [clientGroups, insByClient, careOfficeById, billingMonth, y, m]);
  const rowActionsImpl = useRef<BillingRowActions | null>(null);
  useEffect(() => {
    rowActionsImpl.current = {
      toggleDetail: (client, items) => setDetailClient((cur) => (cur?.client.id === client.id ? null : { client, items })),
      toggleSelect: (clientId) => setSelectedClientIds((prev) => { const s = new Set(prev); if (s.has(clientId)) s.delete(clientId); else s.add(clientId); return s; }),
      openExceptionGrant,
      kohiModeChange: (clientId, value) => { void handleKohiModeChange(clientId, value); },
      openRentalGrid: (client, items) => setRentalGridClient({ client, items }),
      openInvoice: (client) => setInvoiceClient(client),
      cmCommit: (clientId, value) => { void handleCmUnitsCommit(clientId, value); },
      toggleLate: toggleLateFlag,
      setRebill: (clientId, value) => setRebillLocal(clientId, billingMonth, value),
      toggleKago: (clientId) => toggleRebillFlag(clientId, billingMonth, "過誤"),
    };
  });
  const rowActions = useMemo<BillingRowActions>(() => ({
    toggleDetail: (c, i) => rowActionsImpl.current?.toggleDetail(c, i),
    toggleSelect: (id) => rowActionsImpl.current?.toggleSelect(id),
    openExceptionGrant: (id, g) => rowActionsImpl.current?.openExceptionGrant(id, g),
    kohiModeChange: (id, v) => rowActionsImpl.current?.kohiModeChange(id, v),
    openRentalGrid: (c, i) => rowActionsImpl.current?.openRentalGrid(c, i),
    openInvoice: (c) => rowActionsImpl.current?.openInvoice(c),
    cmCommit: (id, v) => rowActionsImpl.current?.cmCommit(id, v),
    toggleLate: (id) => rowActionsImpl.current?.toggleLate(id),
    setRebill: (id, v) => rowActionsImpl.current?.setRebill(id, v),
    toggleKago: (id) => rowActionsImpl.current?.toggleKago(id),
  }), []);

  if (subTab === "sales") {
    return (
      <div className="flex flex-col h-full bg-white text-sm">
        <BillingSubTabNav active={subTab} onChange={changeSubTab} />
        <SalesReportTab
          tenantId={tenantId}
          clients={clients}
          orderItems={orderItems}
          orders={orders}
          equipment={equipment}
          currentOfficeId={currentOfficeId}
          careOffices={careOffices}
        />
      </div>
    );
  }

  if (subTab === "monthly") {
    return (
      <div className="flex flex-col h-full bg-white text-sm">
        <BillingSubTabNav active={subTab} onChange={changeSubTab} />
        <MonthlyInfoTab
          tenantId={tenantId}
          currentOfficeId={currentOfficeId}
          clients={clients}
          insuranceRecords={insuranceRecords}
          orderItems={orderItems}
          orders={orders}
          equipment={equipment}
          hospitalizations={hospitalizations}
          careOffices={careOffices}
          dataLoading={dataLoading}
          priceHistory={priceHistoryAll}
          pausesByItem={pauses?.byItem ?? EMPTY_PAUSES}
          prorations={prorations}
        />
      </div>
    );
  }

  if (subTab === "user") {
    return (
      <div className="flex flex-col h-full bg-white text-sm">
        <BillingSubTabNav active={subTab} onChange={changeSubTab} />
        <UserBillingTab
          tenantId={tenantId}
          currentOfficeId={currentOfficeId}
          clients={clients}
          orderItems={orderItems}
          orders={orders}
          equipment={equipment}
          insuranceRecords={insuranceRecords}
          priceHistory={priceHistoryAll}
          dataLoading={dataLoading}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-white text-sm">
      <BillingSubTabNav active={subTab} onChange={guardedSetSubTab} />
      {/* ── ツールバー ── */}
      <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 border border-gray-300 rounded bg-white px-2 py-1">
          <button onClick={guardedPrevMonth} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="font-semibold text-gray-800 px-1.5">R{y - 2018}/{m}</span>
          <button onClick={guardedNextMonth} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <span className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 font-medium">請求分</span>
        <button
          onClick={() => { setShowRentalGridView(v => !v); setGridSelectedClient(null); }}
          className={`border rounded px-2.5 py-1 font-medium transition-colors ${showRentalGridView ? "border-emerald-600 bg-emerald-600 text-white" : "border-emerald-500 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"}`}
        >提供表</button>
        <div className="w-px h-5 bg-gray-300 mx-1" />
        {/* 2026-11-13: 押しても何も起きなかった「明細書」「請求書」「管理帳票」のボタンを外した (処理が無い見た目だけのボタン)。
            利用者ごとの請求書は 各行の「請求書」、伝送は「CSV出力」から */}
        <button
          onClick={() => setKokuhoOnly(v => !v)}
          title="国保連提出対象のみ表示 (自動の月遅れ = 申請中 等を除く。手で月遅にした行は 月遅の印付きで残す・金額には入らない) ⇔ 全件表示 を切替"
          className={`border rounded px-2.5 py-1 font-semibold transition-colors ${kokuhoOnly ? "border-blue-500 bg-blue-100 text-blue-800" : "border-gray-400 bg-white text-gray-700 hover:bg-gray-50"}`}
        >{kokuhoOnly ? "国保対象のみ" : "全件表示"}</button>
        {selectedClientIds.size > 0 && (
          <>
            <div className="w-px h-5 bg-gray-300 mx-1" />
            <span className="text-gray-600">{selectedClientIds.size}名選択</span>
            <button onClick={() => handleConfirm("返戻")}
              className="border border-orange-400 rounded bg-orange-50 px-2.5 py-1 text-orange-700 font-semibold hover:bg-orange-100">返戻で確定</button>
            <button onClick={() => handleConfirm("過誤")}
              className="border border-red-400 rounded bg-red-50 px-2.5 py-1 text-red-700 font-semibold hover:bg-red-100">過誤で確定</button>
          </>
        )}
        {/* 横長対策: 右端寄せ (ml-auto) をやめ、月切替の隣にまとめて並べる */}
        <div className="w-px h-5 bg-gray-300 mx-1" />
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={handleSaveFlags}
            disabled={savingFlags || !isDirty}
            title="月遅/返戻/過誤 の変更を保存"
            className={`border rounded px-3 py-1 font-semibold transition-colors ${
              isDirty ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700" : "border-gray-300 bg-white text-gray-400"
            }`}
          >{savingFlags ? "保存中…" : isDirty ? "保存 *" : "保存済"}</button>
          <span className="text-amber-600 text-xs">※ 被保険者証情報は別途ほのぼので補完</span>
          {rebillByMonth.length > 0 && (
            <button onClick={generateRebillTransferData} disabled={!densouInputsReady}
              title={densouInputsReady ? "返戻・過誤の対象をサービス提供年月ごとに 1 ファイルずつ出力" : "伝送に使うデータを読み込み中です"}
              className="border border-orange-500 rounded bg-orange-50 px-3 py-1 text-orange-700 font-semibold hover:bg-orange-100 flex items-center gap-1.5">
              <Download size={13} />返戻過誤 伝送({rebillByMonth.length}か月分)
            </button>
          )}
          <button onClick={generateCareplanJissekiCsv}
            title="ケアプランデータ連携 V4.1 の第6表実績 (UPJSK) を担当居宅事業所ごとに出力"
            className="border border-teal-500 rounded bg-teal-50 px-3 py-1 text-teal-700 font-semibold hover:bg-teal-100 flex items-center gap-1.5">
            <Download size={13} />ケアプラン連携
          </button>
          <button onClick={generateTransferData} disabled={!densouInputsReady}
            title={densouInputsReady ? undefined : "伝送に使うデータを読み込み中です"}
            className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait">
            {densouInputsReady ? <Download size={13} /> : <Loader2 size={13} className="animate-spin" />}CSV出力
          </button>
        </div>
      </div>

      {(loading || dataLoading) ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-400" /></div>
      ) : showRentalGridView ? (
        <div className="flex flex-1 min-h-0">
          {/* ── 提供表ビュー：左＝利用者リスト、右＝グリッド ── */}
          <div className="flex shrink-0 border-r border-gray-300">
            {/* カナサイドバー */}
            <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
              <button
                onClick={() => setGridKanaFilter(null)}
                className={`w-8 py-1 rounded text-sm font-bold transition-colors ${gridKanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
              >全</button>
              {KANA_ROWS.map(k => (
                <button key={k}
                  onClick={() => setGridKanaFilter(gridKanaFilter === k ? null : k)}
                  className={`w-8 py-1 rounded text-sm font-medium transition-colors ${gridKanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
                >{k}</button>
              ))}
            </div>
            {/* 利用者名リスト */}
            <div className="w-40 overflow-y-auto">
              {gridFilteredGroups.map(({ client, items }) => (
                <button
                  key={client.id}
                  onClick={() => startGridTransition(() => setGridSelectedClient({ client, items }))}
                  className={`w-full text-left px-3 py-2.5 text-sm border-b border-gray-100 transition-colors ${
                    gridSelectedClient?.client.id === client.id
                      ? "bg-blue-100 text-blue-800 font-semibold"
                      : "hover:bg-gray-50 text-gray-700"
                  }`}
                >{client.name}</button>
              ))}
            </div>
          </div>
          {/* 右：グリッド */}
          <div className={`flex-1 overflow-auto transition-opacity duration-100 ${isGridPending ? "opacity-40 pointer-events-none" : "opacity-100"}`}>
            {gridSelectedClient ? (
              <RentalGridPanel
                client={gridSelectedClient.client}
                items={gridSelectedClient.items}
                equipment={equipment}
                hospitalizations={hospitalizations.filter(h => h.client_id === gridSelectedClient.client.id)}
                pausesOf={pausesOf}
                calcOf={rentalGridCalcOf(gridSelectedClient.client.id)}
                month={billingMonth}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">利用者を選択してください</div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* ── 行カナ絞り込みサイドバー ── */}
          <div className="w-10 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col items-center py-1 gap-0.5 overflow-y-auto">
            <button
              onClick={() => setKanaFilter(null)}
              className={`w-8 py-1 rounded text-sm font-bold transition-colors ${kanaFilter === null ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
            >全</button>
            {KANA_ROWS.map(k => (
              <button key={k}
                onClick={() => setKanaFilter(kanaFilter === k ? null : k)}
                className={`w-8 py-1 rounded text-sm font-medium transition-colors ${kanaFilter === k ? "bg-blue-500 text-white" : "hover:bg-gray-200 text-gray-600"}`}
              >{k}</button>
            ))}
          </div>

          {/* ── メインテーブル ── */}
          <div className="flex flex-col flex-1 min-w-0 border-r border-gray-200">
            {/* 行 (ヘッダーは sticky にしてスクロール内へ配置。本文とスクロールバー幅を共有し列を一致させる) */}
            <div className="flex-1 overflow-y-auto">
            {/* ヘッダー行: 対象 / 申請中 / 状態 / 提出月 / 請求月 / サービス事業所 / 被保険者番号 / 利用者名 / 月遅 / 返戻 / 過誤 */}
            <div className="grid min-w-max grid-cols-[32px_64px_72px_60px_60px_180px_104px_minmax(160px,360px)_84px_64px_72px_44px] border-b border-gray-300 bg-gray-100 text-xs font-semibold text-gray-600 sticky top-0 z-10">
              <div className="px-1 py-2 flex items-center justify-center">
                <button
                  onClick={() => setSelectedClientIds(
                    selectedClientIds.size === clientGroups.length && clientGroups.length > 0
                      ? new Set() : new Set(clientGroups.map(g => g.client.id))
                  )}
                  className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                    selectedClientIds.size === clientGroups.length && clientGroups.length > 0
                      ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
                  }`}
                >
                  {selectedClientIds.size === clientGroups.length && clientGroups.length > 0 && (
                    <span className="text-white text-[8px] font-bold leading-none">✓</span>
                  )}
                </button>
              </div>
              <div className="px-2 py-2 border-l border-gray-200 text-center">申請中</div>
              <div className="px-2 py-2 border-l border-gray-200">状態</div>
              <div className="px-2 py-2 border-l border-gray-200">提出月</div>
              <div className="px-2 py-2 border-l border-gray-200">請求月</div>
              {/* 2026-11-13: 見出しを中身に合わせた (旧「サービス事業所」「被保険者番号」。中身は 居宅介護支援事業所名 と 利用者番号) */}
              <div className="px-2 py-2 border-l border-gray-200">居宅介護支援事業所</div>
              <div className="px-2 py-2 border-l border-gray-200">利用者番号</div>
              <div className="px-2 py-2 border-l border-gray-200">利用者名</div>
              <div className="px-1 py-2 border-l border-gray-200 text-center" title="ケアマネが給付管理で割り付けた単位数。入れるとその単位数までを保険請求し、超えた分は保険外 (全額自己負担)。空欄 = 月次情報 (給付管理) 未着として伝送から外す (その月に 1 名も入力が無いときは実績で請求)">CM指示単位</div>
              <div className="px-2 py-2 border-l border-gray-200 text-center">月遅</div>
              <div className="px-2 py-2 border-l border-gray-200 text-center">返戻</div>
              <div className="px-2 py-2 border-l border-gray-200 text-center">過誤</div>
            </div>

              {displayRows.length === 0 ? (
                <p className="text-gray-400 text-center py-10">{billingMonth}のアクティブレンタル（介護）がありません</p>
              ) : displayRows.map((row, idx) => {
                if (row.type === "rebill") {
                  const [ry, rm] = row.month.split("-").map(Number);
                  return (
                    <div key={`rebill-${row.client.id}-${row.month}`}
                      className="grid min-w-max grid-cols-[32px_64px_72px_60px_60px_180px_104px_minmax(160px,360px)_84px_64px_72px_44px] border-b border-gray-100 bg-amber-50 text-xs">
                      <div className="px-1 py-2" />
                      <div className="px-2 py-2 border-l border-gray-100" />
                      <div className="px-2 py-2 border-l border-gray-100 text-amber-700 font-medium">再請求</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">R{ry-2018}/{rm}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">R{y-2018}/{m}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500 truncate">—</div>
                      <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-500">{row.client.user_number ?? "—"}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-700 font-medium truncate">{row.client.name}</div>
                      <div className="px-2 py-2 border-l border-gray-100" />
                      <div className="px-2 py-2 border-l border-gray-100 text-center" />
                      <div className="px-2 py-2 border-l border-gray-100 text-center">
                        {row.flag.flag_type === "返戻" && (
                          <button onClick={() => toggleRebillFlag(row.client.id, row.month, "返戻")}
                            className="text-red-500 underline text-[11px]">返戻</button>
                        )}
                      </div>
                      <div className="px-2 py-2 border-l border-gray-100 text-center">
                        {row.flag.flag_type === "過誤" && (
                          <button onClick={() => toggleRebillFlag(row.client.id, row.month, "過誤")}
                            className="text-red-500 underline text-[11px]">過誤</button>
                        )}
                      </div>
                    </div>
                  );
                }
                const { client, items } = row;
                const ci = rowCertInfo.get(client.id);
                const kp = kohiPartialByClient.get(client.id);
                return (
                  <BillingClientRow
                    key={client.id}
                    client={client}
                    items={items}
                    even={idx % 2 === 0}
                    y={y}
                    m={m}
                    billingMonth={billingMonth}
                    isAutoLate={autoLateClients.has(client.id)}
                    lateFlagMonth={lateFlags.get(client.id)?.month ?? null}
                    hasLateFlag={lateFlags.has(client.id)}
                    rebillFlagType={rebillFlags.get(`${client.id}-${billingMonth}`)?.flag_type ?? null}
                    isSelected={selectedClientIds.has(client.id)}
                    isDetail={detailClient?.client.id === client.id}
                    isApplying={ci?.isApplying ?? false}
                    isNoCareLevel={noCareLevelClients.has(client.id)}
                    careOfficeName={ci?.careOfficeName ?? ""}
                    exception={exceptionByClient.get(client.id) ?? null}
                    kohiPartial={kp ?? null}
                    kohiMode={kp ? kohiModes.get(client.id) ?? null : null}
                    kohiModeDisabled={!kohiModesAvailable || kohiModeSavingId === client.id}
                    kohiModesNotice={kohiModesAvailable ? null : (kohiModesNotice ?? "")}
                    cmUnits={cmUnits.get(client.id) ?? null}
                    actualUnits={unitsByClient.get(client.id) ?? 0}
                    cmDisabled={!cmUnitsAvailable || cmSavingId === client.id}
                    cmUnitsAvailable={cmUnitsAvailable}
                    cmUnitsNotice={cmUnitsAvailable ? null : cmUnitsNotice}
                    actions={rowActions}
                  />
                );
              })}
            </div>

            {/* ── フッター合計 (サンプル画像の box レイアウト) ── */}
            {(() => {
              // 集計対象: 月遅れ除外
              const lateClientIds = new Set<string>([
                ...autoLateClients,
                ...Array.from(lateFlags.keys()),
              ]);
              const billingGroupsForTotal = clientGroups.filter(g => !lateClientIds.has(g.client.id));
              const totalCount = clientGroups.length;
              const totalUnits = clientGroups.reduce((s, { client }) => s + (unitsByClient.get(client.id) ?? 0), 0);
              const kokuhoCount = billingGroupsForTotal.length;
              const kokuhoUnits = billingGroupsForTotal.reduce((s, { client }) => s + (unitsByClient.get(client.id) ?? 0), 0);
              // 単位単価は地域加算で違うが、概算 10 円/単位 (国保連伝送と同じ)
              const UNIT_PRICE = 10;
              const insuranceUnitAmount = kokuhoUnits * UNIT_PRICE;
              // 給付率の平均 (各 client の benefit_rate を加重平均)
              let insuranceClaim = 0;
              let copayClaim = 0;
              let outsideTotal = 0;
              let cappedCount = 0;
              for (const { client } of billingGroupsForTotal) {
                const actualUnits = unitsByClient.get(client.id) ?? 0;
                // ★ CM 指示単位数で頭打ち (超過分は保険外)
                const cap = capFukuyoguUnits(actualUnits, cmUnits.get(client.id) ?? null);
                const subUnits = cap.billedUnits;
                outsideTotal += cap.overUnits * UNIT_PRICE;
                if (cap.capped) cappedCount++;
                const benefitRate = parseInt(client.benefit_rate ?? "90", 10);
                const subAmount = subUnits * UNIT_PRICE;
                const subCopay = Math.round(subAmount * (100 - benefitRate) / 100);
                insuranceClaim += subAmount - subCopay;
                copayClaim += subCopay;
              }
              return (
                <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-1.5 tabular-nums">
                    <span>合計件数 <strong className="font-mono">{totalCount.toLocaleString()}</strong></span>
                    <span>合計単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
                    <span>国保件数 <strong className="font-mono">{kokuhoCount.toLocaleString()}</strong></span>
                    <span>国保対象単位数 <strong className="font-mono">{kokuhoUnits.toLocaleString()}</strong></span>
                  </div>
                  {/* 横長対策: 3列の金額欄を全幅に広げず最大幅で止める */}
                  <div className="border border-gray-300 rounded bg-white px-2 py-1.5 grid grid-cols-3 gap-x-4 gap-y-1 max-w-3xl tabular-nums">
                    <span>特定介護請求額 <strong className="font-mono">—</strong></span>
                    <span>軽減額 <strong className="font-mono">—</strong></span>
                    <span>保険単位額 <strong className="font-mono">{insuranceUnitAmount.toLocaleString()}</strong></span>
                    <span>公費単位数 <strong className="font-mono">—</strong></span>
                    <span>保険請求額 <strong className="font-mono">{insuranceClaim.toLocaleString()}</strong></span>
                    <span>公費請求額 <strong className="font-mono">—</strong></span>
                    <span>利用者負担額 <strong className="font-mono text-red-600">{copayClaim.toLocaleString()}</strong></span>
                    <span>公費分本人負担 <strong className="font-mono">—</strong></span>
                  </div>
                  {(kohiPartialByClient.size > 0 || kohiModesNotice || screenKohiNotice) && (() => {
                    const unselected = [...kohiPartialByClient.keys()].filter((cid) => !kohiModes.has(cid)).length;
                    return (
                      <div className="mt-1.5 text-[11px] text-red-700">
                        {kohiPartialByClient.size > 0 && (
                          <span>⚠ 公費が月の途中で始まる/終わる利用者 {kohiPartialByClient.size} 名 (公費の扱い 未選択 {unselected} 名 = 「{KOHI_MONTH_MODE_LABEL[KOHI_MONTH_MODE_DEFAULT]}」で請求) — 利用者名の横で ケアマネの方針 (全部利用者負担 / 日割り / 半月) を選んでください</span>
                        )}
                        {kohiModesNotice && <span className="block">⚠ {kohiModesNotice}</span>}
                        {screenKohiNotice && <span className="block">⚠ {screenKohiNotice}</span>}
                      </div>
                    );
                  })()}
                  {(exceptionByClient.size > 0 || exNotice) && (
                    <div className="mt-1.5 text-[11px] text-red-700">
                      {exceptionByClient.size > 0 && <span>⚠ 軽度者 例外給付 要確認 {exceptionByClient.size} 名 (記録なし/期限切れ {[...exceptionByClient.values()].filter((v) => v.level === "danger").length} 名) — 利用者名の横の印を押すと入力を開きます。記録が無いだけの可能性があります</span>}
                      {exNotice && <span className="block">⚠ {exNotice}</span>}
                    </div>
                  )}
                  {(cappedCount > 0 || cmUnitsNotice) && (
                    <div className="mt-1.5 text-[11px] text-orange-700">
                      {cappedCount > 0 && <span>⚠ CM 指示単位数で頭打ち {cappedCount} 名 — 保険外 (全額自己負担) {outsideTotal.toLocaleString()} 円 (上の保険請求額・利用者負担額には含めていません)</span>}
                      {cmUnitsNotice && <span className="block text-red-600">⚠ {cmUnitsNotice}</span>}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>

          {/* ── 右：明細情報 ── */}
          <div className="w-80 shrink-0 flex flex-col bg-white">
            <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 text-xs font-bold text-gray-700 flex items-center gap-2">
              <span>明細情報</span>
              {detailClient && <span className="font-normal text-gray-500 truncate">{detailClient.client.name}</span>}
            </div>
            {detailClient ? (
              <>
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-[11px] border-collapse">
                    <thead className="bg-gray-100 border-b border-gray-300 sticky top-0">
                      <tr>
                        <th className="text-left px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200">サービス内容</th>
                        <th className="text-right px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-12">単位数</th>
                        <th className="text-right px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-10">単価</th>
                        <th className="text-right px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-10">回数</th>
                        <th className="text-right px-1.5 py-1.5 font-semibold text-gray-600 border-r border-gray-200 w-14">単位数小計</th>
                        <th className="text-left px-1.5 py-1.5 font-semibold text-gray-600 w-20">摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailClient.items.map((item, i) => {
                        const eq = equipmentByCode.get(item.product_code);
                        const unitPrice = getUnits(item, detailClient.client.id);
                        const units = unitPrice * item.quantity;
                        const taisCode = eq?.tais_code ?? "";
                        return (
                          <tr key={item.id} className={`border-b border-gray-100 ${i % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                            <td className="px-1.5 py-1 text-gray-700 leading-tight border-r border-gray-100">{eq?.name ?? item.product_code}</td>
                            <td className="px-1.5 py-1 text-right font-mono text-gray-700 border-r border-gray-100">{unitPrice}</td>
                            <td className="px-1.5 py-1 text-right font-mono text-gray-700 border-r border-gray-100">10</td>
                            <td className="px-1.5 py-1 text-right font-mono text-gray-700 border-r border-gray-100">{item.quantity}</td>
                            <td className="px-1.5 py-1 text-right font-mono font-semibold text-gray-800 border-r border-gray-100">{units.toLocaleString()}</td>
                            <td className="px-1.5 py-1 text-gray-500 text-[10px] font-mono truncate" title={taisCode}>{taisCode || "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-gray-300 bg-gray-50 shrink-0">
                  {(() => {
                    const actualU = detailClient.items.reduce((s, item) => s + getUnits(item, detailClient.client.id) * item.quantity, 0);
                    // ★ CM 指示単位数で頭打ち (超過分は保険外 = 全額自己負担)
                    const cap = capFukuyoguUnits(actualU, cmUnits.get(detailClient.client.id) ?? null);
                    const totalU = cap.billedUnits;
                    const UNIT_PRICE = 10;
                    const insuredAmount = totalU * UNIT_PRICE;
                    const benefitRate = parseInt(detailClient.client.benefit_rate ?? "90", 10);
                    const copayRate = 100 - benefitRate;
                    const copayAmount = Math.round(insuredAmount * copayRate / 100);
                    const benefitAmount = insuredAmount - copayAmount;
                    return (
                      <table className="w-full text-[11px] border-collapse">
                        <tbody>
                          <tr className="border-t border-gray-200">
                            <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">保険単位数</td>
                            <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">{totalU.toLocaleString()}</td>
                            <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費単位数</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">—</td>
                          </tr>
                          <tr className="border-t border-gray-200">
                            <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">保険請求額</td>
                            <td className="px-2 py-1 text-right font-mono font-semibold text-gray-800">{benefitAmount.toLocaleString()}</td>
                            <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費請求額</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">—</td>
                          </tr>
                          <tr className="border-t border-gray-200">
                            <td className="px-2 py-1 text-gray-600 border-r border-gray-200 bg-gray-100 font-medium">利用者負担額</td>
                            <td className="px-2 py-1 text-right font-mono font-semibold text-red-600">{copayAmount.toLocaleString()}</td>
                            <td className="px-2 py-1 text-gray-600 border-l border-gray-200 bg-gray-100 font-medium">公費本人負担</td>
                            <td className="px-2 py-1 text-right font-mono text-gray-400">—</td>
                          </tr>
                          {cap.capped && (
                            <tr className="border-t border-orange-200 bg-orange-50">
                              <td colSpan={4} className="px-2 py-1 text-orange-700">
                                ⚠ CM 指示単位数で頭打ち: 実績 {actualU.toLocaleString()} 単位 → 保険請求 {totalU.toLocaleString()} 単位。
                                超過 {cap.overUnits.toLocaleString()} 単位 = <strong>{(cap.overUnits * UNIT_PRICE).toLocaleString()} 円は保険外 (全額自己負担)</strong>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    );
                  })()}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
                行を選択してください
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 利用・提供表モーダル ── */}
      {rentalGridClient && (
        <RentalGridModal
          client={rentalGridClient.client}
          items={rentalGridClient.items}
          equipment={equipment}
          hospitalizations={hospitalizations.filter(h => h.client_id === rentalGridClient.client.id)}
          pausesOf={pausesOf}
          calcOf={rentalGridCalcOf(rentalGridClient.client.id)}
          month={billingMonth}
          onClose={() => setRentalGridClient(null)}
        />
      )}

      {/* ── 請求書／領収書モーダル ── */}
      {invoiceClient && (
        <InvoiceReceiptModal
          client={invoiceClient}
          orders={orders}
          orderItems={orderItems}
          equipment={equipment}
          companyInfo={companyInfoForDoc}
          priceHistory={priceHistoryAll}
          tenantId={tenantId}
          defaultMonth={billingMonth}
          hospitalizations={hospitalizations.filter(h => h.client_id === invoiceClient.id)}
          prorations={prorations}
          pausesByItem={pauses?.byItem ?? EMPTY_PAUSES}
          onClose={() => setInvoiceClient(null)}
        />
      )}
    </div>
  );
}

// ─── Sales Report Tab（売上帳票：介護保険レンタル） ─────────────────────
function SalesReportTab({ tenantId, clients, orderItems, orders, equipment, currentOfficeId, careOffices }: {
  tenantId: string;
  clients: BillingClient[];
  orderItems: OrderItem[];
  orders: Order[];
  equipment: Equipment[];
  currentOfficeId: string | null;
  /** 親 (請求画面) が読み終えた居宅の一覧。ここで care_offices を読み直さない (2026-11-13) */
  careOffices: CareOffice[];
}) {
  // 月選択（デフォルト：今月）
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [y, m] = month.split("-").map(Number);
  // ★ 2026-11-12: 按分は 請求・伝送と同じ rentalMonthUnits (日割り設定・休止・入院を反映。lib/rentalCalcContext.ts)
  const calc = useRentalCalcContext(tenantId);
  const prevMonth = () => { const d = new Date(y, m - 2, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const d = new Date(y, m, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const toThisMonth = () => { const d = new Date(); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  // データ: 売上帳票の手入力項目 + 書類チェック + 居宅/ケアマネマスタ
  const [salesRecords, setSalesRecords] = useState<import("@/lib/sales").SalesRecord[]>([]);
  const [documents, setDocuments] = useState<Array<{ client_id: string; type: string }>>([]);
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  // 卸別仕入単価 (is_active かつ サンプル以外のみ。valid_from 履歴を持つ)
  const [purchasePrices, setPurchasePrices] = useState<Array<{ product_code: string; supplier_id: string; purchase_price: number; valid_from: string }>>([]);
  const [samplePriceRowCount, setSamplePriceRowCount] = useState(0); // 経費に使わなかったサンプル単価の行数
  const [suppliersAll, setSuppliersAll] = useState<Supplier[]>([]); // 卸名解決用 (非表示含む全件)
  // id -> name。親が読んだ居宅の一覧から作る (親の読み込みが後から終わっても追従する)
  const careOfficesMap = useMemo(() => new Map(careOffices.map((o) => [o.id, o.name] as [string, string])), [careOffices]);
  const [careManagersMap, setCareManagersMap] = useState<Map<string, string>>(new Map()); // id -> name
  const [loading, setLoading] = useState(true);
  /** 2 段目 (書類・仕入・ケアマネ名・卸) を読み終えるまで true。月次損益の経費はこれを待つ */
  const [subLoading, setSubLoading] = useState(true);

  // 取得対象は月非依存 (全件ロード→クライアント側で月フィルタ)。
  // 月ナビや orderItems の参照変化で毎回全再取得していたのを、
  // 品目コード集合が変わった時だけ再取得するよう安定キー化 (初期ロード最適化)。
  const productCodesKey = useMemo(
    () => [...new Set(orderItems.map((i) => i.product_code))].sort().join(","),
    [orderItems],
  );

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { getSalesRecords } = await import("@/lib/sales");
        // PostgREST default 1000 行制限対策。client_documents/care_offices/care_managers
        // など増える可能性のあるテーブルはページング取得
        const fetchAllRows = async <T,>(table: string, columns = "*"): Promise<T[]> => {
          const PAGE = 1000;
          const all: T[] = [];
          let from = 0;
          while (true) {
            const { data, error } = await supabase.from(table).select(columns).eq("tenant_id", tenantId).order("id").range(from, from + PAGE - 1);
            if (error) throw error;
            if (!data || data.length === 0) break;
            all.push(...(data as unknown as T[]));
            if (data.length < PAGE) break;
            from += PAGE;
          }
          return all;
        };
        // ★ 2026-11-13 高速化: 表の金額に効くもの (手入力の記録・価格履歴) を先に読んで表を出し、
        //   ✓ の列 (書類)・仕入・居宅/ケアマネ名・卸 は あとから埋める (読む表と回数は同じ。居宅は親が読んだものを使うので 1 本減)
        const [sr, priceHist] = await Promise.all([
          getSalesRecords(tenantId),
          getPriceHistory(tenantId, [...new Set(orderItems.map((i) => i.product_code))]),
        ]);
        setSalesRecords(sr);
        setPriceHistory(priceHist);
        setLoading(false);
        const [docs, ppRes, mgrs, sups] = await Promise.all([
          fetchAllRows<{ client_id: string; type: string }>("client_documents", "client_id, type"),
          // ★ 2,556 行あるので必ずページング (以前は非ページングで先頭 1,000 行しか見ていなかった)
          fetchAllRows<{ product_code: string; supplier_id: string; purchase_price: number | null; valid_from: string | null; is_active: boolean | null; supplier_product_code: string | null }>(
            "equipment_prices", "product_code, supplier_id, purchase_price, valid_from, is_active, supplier_product_code"),
          fetchAllRows<{ id: string; name: string }>("care_managers", "id, name"),
          getSuppliers().catch((e) => { console.error("getSuppliers に失敗 (空で続行):", e); return [] as Supplier[]; }),
        ]);
        setDocuments(docs);
        // ★ サンプル単価 (supplier_product_code が 'SAMPLE-' 始まり。seed_fake_supplier_prices.mjs) は
        //   架空の値なので経費に使わない。DB の行の削除は user 判断 (ここでは件数だけ出す)
        const isSample = (p: { supplier_product_code: string | null }) => (p.supplier_product_code ?? "").startsWith("SAMPLE-");
        setSamplePriceRowCount(ppRes.filter(isSample).length);
        setPurchasePrices(
          ppRes
            .filter((p) => p.is_active !== false && !isSample(p) && p.purchase_price != null && p.purchase_price > 0)
            .map((p) => ({ product_code: p.product_code, supplier_id: p.supplier_id, purchase_price: p.purchase_price as number, valid_from: p.valid_from ?? "0000-01-01" })),
        );
        setSuppliersAll(sups);
        const mm = new Map<string, string>();
        mgrs.forEach((m) => mm.set(m.id, m.name));
        setCareManagersMap(mm);
      } finally {
        setLoading(false);
        setSubLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 月非依存。品目コード集合(productCodesKey)変化時のみ再取得
  }, [tenantId, productCodesKey]);

  // 居宅名 / ケアマネ名：care_office_id 優先、なければテキスト
  const getCareOfficeName = (c: BillingClient): string =>
    (c.care_office_id ? careOfficesMap.get(c.care_office_id) : null) ?? c.care_manager_org ?? "";
  const getCareManagerName = (c: BillingClient): string =>
    (c.care_manager_id ? careManagersMap.get(c.care_manager_id) : null) ?? c.care_manager ?? "";

  /**
   * 明細の仕入原価。分からなければ null (= 0 円ではなく「不明」)。
   *   1. order_items.purchase_price (発注時スナップ)。★ 0 は「未入力」扱いでカタログへ
   *   2. カタログ equipment_prices (product_code, supplier_id) で asOf 時点に有効な最新 (valid_from <= asOf)
   */
  const resolvePurchasePrice = useCallback((item: OrderItem, asOf: string): number | null => {
    if (item.purchase_price != null && item.purchase_price > 0) return item.purchase_price;
    if (!item.supplier_id) return null;
    let best: { purchase_price: number; valid_from: string } | null = null;
    for (const p of purchasePrices) {
      if (p.product_code !== item.product_code || p.supplier_id !== item.supplier_id || p.valid_from > asOf) continue;
      if (!best || p.valid_from > best.valid_from) best = p;
    }
    return best?.purchase_price ?? null;
  }, [purchasePrices]);

  /**
   * 1 明細の当月の金額 (円・1 個あたり) と算定の種類。請求・伝送と同じ rentalMonthUnits (日割り設定・休止・入院を反映)。
   *   終了日は 解約済 (terminated) のときだけ見る (売上帳票の従来の扱い)
   */
  const salesMonthAmount = useCallback((item: OrderItem, clientId: string, ym: string, price: number): { amount: number; prorate: "full" | "half" | "daily" } => {
    const fullUnits = price ? Math.round(price / 10) : 0;
    const mode = modeOf(calc, item.id, ym);
    const units = rentalMonthUnits(fullUnits, item.rental_start_date, item.status === "terminated" ? item.rental_end_date : null, ym,
      excludedOf(calc, clientId, item.id), mode);
    return { amount: units * 10, prorate: mode === "daily" ? "daily" : units === fullUnits ? "full" : "half" };
  }, [calc]);

  /**
   * 行 (開始 = 獲得 / 終了 = 引上) の金額 (円・1 個あたり)。★ その月の請求額ではない (2026-11-12 判断)。
   *   営業の売上報告の書式で「開始で獲得した月額」「解約で引き上げた月額」を記録する列なので、
   *   同じ月に開始・終了がある台でも 開始行は開始日だけ、終了行は終了日だけで 1ヶ月分/半月分 を決める (旧どおり)。休止・入院は見ない。
   *   日割りにした月だけ: 開始行 = 開始日〜月末 / 終了行 = 月初〜終了日 の日割り (rentalMonthUnits の daily)
   */
  const salesRowAmount = useCallback((item: OrderItem, ev: "start" | "end", ym: string, price: number): { amount: number; prorate: "full" | "half" | "daily" } => {
    if (modeOf(calc, item.id, ym) === "daily") {
      const units = ev === "start"
        ? rentalMonthUnits(price ? Math.round(price / 10) : 0, item.rental_start_date, null, ym, [], "daily")
        : rentalMonthUnits(price ? Math.round(price / 10) : 0, null, item.rental_end_date, ym, [], "daily");
      return { amount: units * 10, prorate: "daily" };
    }
    const day = parseInt(((ev === "start" ? item.rental_start_date : item.rental_end_date) ?? "").slice(8, 10), 10);
    const half = ev === "start" ? day >= 16 : day <= 15;
    return half ? { amount: Math.round(price / 2), prorate: "half" } : { amount: price, prorate: "full" };
  }, [calc]);

  // 当月の売上帳票行を生成（自動集計）
  const rows = useMemo(() => {
    const monthStart = `${month}-01`;
    const monthEnd = monthEndYmd(y, m);

    type RowType = {
      key: string;
      orderItemId: string;
      eventType: "start" | "end";
      salesDate: string;
      rType: "新規" | "追加" | "一部解約" | "全部解約";
      /** 行の算定: full = 1ヶ月分 / half = 半月分 / daily = 日割り (salesRowAmount) */
      prorate: "full" | "half" | "daily";
      /** 行の金額 (円・1 個あたり) = 獲得 / 引上 の月額 (その月の請求額ではない) */
      amount: number;
      client: BillingClient;
      item: OrderItem;
      order: Order;
      equipmentName: string;
      rentalPrice: number;  // 月額
      purchasePrice: number;
    };
    const result: RowType[] = [];

    // 月額: 請求 (getUnits) と同じ 価格履歴 (getPriceForMonth = 月初時点) → 用具マスタ
    const getMonthlyPrice = (productCode: string, officeId: string | null): number =>
      getPriceForMonth(priceHistory, productCode, month, officeId) ?? equipment.find((e) => e.product_code === productCode)?.rental_price ?? 0;

    for (const item of orderItems) {
      const order = orders.find((o) => o.id === item.order_id);
      if (!order) continue;
      // 事業所フィルタ
      if (currentOfficeId && order.office_id && order.office_id !== currentOfficeId) continue;
      // 介護保険適用のみ
      const pt = item.payment_type ?? order.payment_type;
      if (pt !== "介護") continue;

      const client = clients.find((c) => c.id === order.client_id);
      if (!client) continue;
      const eq = equipment.find((e) => e.product_code === item.product_code);
      const equipmentName = eq?.name ?? item.product_code;

      // ── レンタル開始イベント ──
      if (item.rental_start_date && item.rental_start_date >= monthStart && item.rental_start_date <= monthEnd) {
        // 新規 vs 追加の判定: この開始日時点で同一利用者の他の介護レンタルが active なら「追加」
        const hasPrior = orderItems.some((o2) => {
          if (o2.id === item.id) return false;
          const o2order = orders.find((oo) => oo.id === o2.order_id);
          if (!o2order || o2order.client_id !== client.id) return false;
          const o2pt = o2.payment_type ?? o2order.payment_type;
          if (o2pt !== "介護") return false;
          if (!o2.rental_start_date) return false;
          if (o2.rental_start_date >= item.rental_start_date!) return false;  // 本アイテムより前に開始
          if (o2.status === "cancelled") return false;
          if (o2.status === "terminated" && o2.rental_end_date && o2.rental_end_date < item.rental_start_date!) return false;
          return true;
        });
        const rType = hasPrior ? "追加" : "新規";
        result.push({
          key: `${item.id}-start`,
          orderItemId: item.id,
          eventType: "start",
          salesDate: item.rental_start_date,
          rType,
          ...salesRowAmount(item, "start", month, getMonthlyPrice(item.product_code, order.office_id ?? currentOfficeId ?? null)),
          client,
          item,
          order,
          equipmentName,
          rentalPrice: getMonthlyPrice(item.product_code, order.office_id ?? currentOfficeId ?? null),
          purchasePrice: resolvePurchasePrice(item, monthEnd) ?? 0,
        });
      }

      // ── レンタル終了イベント ──
      if (item.status === "terminated" && item.rental_end_date && item.rental_end_date >= monthStart && item.rental_end_date <= monthEnd) {
        // 一部解約 vs 全部解約: この終了日時点で他に active なアイテムが残るなら「一部解約」
        const hasOtherActive = orderItems.some((o2) => {
          if (o2.id === item.id) return false;
          const o2order = orders.find((oo) => oo.id === o2.order_id);
          if (!o2order || o2order.client_id !== client.id) return false;
          const o2pt = o2.payment_type ?? o2order.payment_type;
          if (o2pt !== "介護") return false;
          if (!o2.rental_start_date) return false;
          if (o2.status === "cancelled") return false;
          if (o2.rental_start_date > item.rental_end_date!) return false;
          if (o2.status === "terminated" && o2.rental_end_date && o2.rental_end_date <= item.rental_end_date!) return false;
          return true;
        });
        const rType: "一部解約" | "全部解約" = hasOtherActive ? "一部解約" : "全部解約";
        result.push({
          key: `${item.id}-end`,
          orderItemId: item.id,
          eventType: "end",
          salesDate: item.rental_end_date,
          rType,
          ...salesRowAmount(item, "end", month, getMonthlyPrice(item.product_code, order.office_id ?? currentOfficeId ?? null)),
          client,
          item,
          order,
          equipmentName,
          rentalPrice: getMonthlyPrice(item.product_code, order.office_id ?? currentOfficeId ?? null),
          purchasePrice: resolvePurchasePrice(item, monthEnd) ?? 0,
        });
      }
    }

    // 売上日昇順
    return result.sort((a, b) => a.salesDate.localeCompare(b.salesDate));
  }, [orderItems, orders, clients, equipment, priceHistory, resolvePurchasePrice, month, y, m, currentOfficeId, salesRowAmount]);

  // 月次損益（発生ベース・介護保険レンタル）
  //   売上 = その月に稼働中のレンタルの当月金額の合計 (請求と同じ rentalMonthUnits。半月按分・日割り・休止・入院を反映)
  //   経費 = その月にレンタル開始した item の仕入原価合計（order_items.purchase_price スナップ優先、無ければカタログ）
  //   利益 = 売上 − 経費。現金（買掛支払）とは別軸の客観的な月次損益。
  const pnl = useMemo(() => {
    const monthStart = `${month}-01`;
    const monthEnd = monthEndYmd(y, m);
    // 月額: 請求と同じ 価格履歴 (月初時点) → 用具マスタ
    const monthlyRentalOf = (productCode: string, officeId: string | null): number =>
      getPriceForMonth(priceHistory, productCode, month, officeId) ?? equipment.find((e) => e.product_code === productCode)?.rental_price ?? 0;
    let revenue = 0;
    let expense = 0;
    let activeCount = 0;
    let startedCount = 0;
    // 仕入原価が分からない当月開始の件数 (卸未設定 / 単価未登録)。¥0 と「不明」を区別するため
    let unknownCostCount = 0;
    // 内訳: 商品別 (売上+経費) / 卸別 (経費のみ = 当月開始の仕入)
    const byProduct = new Map<string, { revenue: number; expense: number; activeCount: number; startedCount: number }>();
    const bySupplier = new Map<string, { expense: number; startedCount: number }>();
    const prodAcc = (code: string) => {
      let acc = byProduct.get(code);
      if (!acc) { acc = { revenue: 0, expense: 0, activeCount: 0, startedCount: 0 }; byProduct.set(code, acc); }
      return acc;
    };
    for (const item of orderItems) {
      const order = orders.find((o) => o.id === item.order_id);
      if (!order) continue;
      if (currentOfficeId && order.office_id && order.office_id !== currentOfficeId) continue;
      const pt = item.payment_type ?? order.payment_type;
      if (pt !== "介護") continue;
      if (!item.rental_start_date) continue;
      if (item.status === "cancelled") continue;
      // ── 売上: 当月稼働中か（開始<=月末 かつ 月初より前に終了していない）──
      const startedByMonthEnd = item.rental_start_date <= monthEnd;
      const endedBeforeMonth = item.status === "terminated" && item.rental_end_date != null && item.rental_end_date < monthStart;
      if (startedByMonthEnd && !endedBeforeMonth) {
        const rev = salesMonthAmount(item, order.client_id ?? "", month, monthlyRentalOf(item.product_code, order.office_id ?? currentOfficeId ?? null)).amount;
        revenue += rev;
        activeCount++;
        const pa = prodAcc(item.product_code);
        pa.revenue += rev; pa.activeCount++;
      }
      // ── 経費: その月にレンタル開始した分の仕入原価（スナップ優先）──
      if (item.rental_start_date >= monthStart && item.rental_start_date <= monthEnd) {
        const resolved = resolvePurchasePrice(item, monthEnd);
        if (resolved == null) unknownCostCount++;
        const exp = resolved ?? 0;
        expense += exp;
        startedCount++;
        const pa = prodAcc(item.product_code);
        pa.expense += exp; pa.startedCount++;
        const sKey = item.supplier_id ?? "__none__";
        const sa = bySupplier.get(sKey) ?? { expense: 0, startedCount: 0 };
        sa.expense += exp; sa.startedCount++;
        bySupplier.set(sKey, sa);
      }
    }
    return { revenue, expense, profit: revenue - expense, activeCount, startedCount, unknownCostCount, byProduct, bySupplier };
  }, [orderItems, orders, equipment, priceHistory, resolvePurchasePrice, month, y, m, currentOfficeId, salesMonthAmount]);
  const [showPnlDetail, setShowPnlDetail] = useState(false);

  // 書類チェック関数
  const hasDoc = (clientId: string, docType: string) =>
    documents.some((d) => d.client_id === clientId && d.type === docType);
  const hasContract = (clientId: string) => hasDoc(clientId, "contract");

  // 売上帳票レコード（手入力分）を取得
  const getSalesRec = (orderItemId: string, eventType: "start" | "end") =>
    salesRecords.find((s) => s.order_item_id === orderItemId && s.event_type === eventType);

  // セル編集
  const saveSalesField = async (orderItemId: string, eventType: "start" | "end", field: "cancellation_reason" | "sales_rep" | "delivery_person" | "input_by" | "notes", value: string) => {
    try {
      const { upsertSalesRecord, getSalesRecords } = await import("@/lib/sales");
      await upsertSalesRecord(tenantId, orderItemId, eventType, { [field]: value || null });
      const sr = await getSalesRecords(tenantId);
      setSalesRecords(sr);
    } catch (e) {
      console.error(e);
      alert("保存に失敗しました");
    }
  };

  /** 売上・引上の金額を列に振り分ける。日割りは 半月分の列ではなく 日割の列 (CSV は末尾に追加。既存列の位置は変えない) */
  const amountCols = (r: (typeof rows)[number]) => {
    const pick = (ev: "start" | "end", kind: "full" | "half" | "daily") => (r.eventType === ev && r.prorate === kind ? r.amount : null);
    return {
      revenueFull: pick("start", "full"), revenueHalf: pick("start", "half"), revenueDaily: pick("start", "daily"),
      liftFull: pick("end", "full"), liftHalf: pick("end", "half"), liftDaily: pick("end", "daily"),
    };
  };

  // CSV 出力
  const exportCSV = () => {
    const headers = [
      "NO", "売上日", "入力者", "R項目", "契約書", "R契約日", "R解約日", "解約理由",
      "提案書", "個別援助計画", "紹介機関", "居宅", "ケアマネージャー様氏名",
      "受注担当者名", "納品・回収", "利用者名", "商品名",
      "R売上(1ヶ月分)", "R売上(半月分)", "R引上金額(1ヶ月分)", "R引上金額(半月分)", "仕入金額",
      // 2026-11-12 追加 (末尾。既存列の位置は変えない): 明細×月で「日割り」にした月の金額
      "R売上(日割)", "R引上金額(日割)",
    ];
    const rowsCsv = rows.map((r, idx) => {
      const sr = getSalesRec(r.orderItemId, r.eventType);
      const c = amountCols(r);
      const v = (x: number | null) => (x == null ? "" : x);
      return [
        idx + 1,
        r.salesDate,
        sr?.input_by ?? "",
        r.rType,
        hasContract(r.client.id) ? "✓" : "",
        r.item.rental_start_date ?? "",
        r.item.rental_end_date ?? "",
        sr?.cancellation_reason ?? "",
        hasDoc(r.client.id, "proposal") ? "✓" : "",
        hasDoc(r.client.id, "care_plan") ? "✓" : "",
        r.client.referrer_org ?? "",
        getCareOfficeName(r.client),
        getCareManagerName(r.client),
        sr?.sales_rep ?? "",
        sr?.delivery_person ?? "",
        r.client.name,
        r.equipmentName,
        v(c.revenueFull),
        v(c.revenueHalf),
        v(c.liftFull),
        v(c.liftHalf),
        r.purchasePrice || "",
        v(c.revenueDaily),
        v(c.liftDaily),
      ];
    });
    const csvText = [headers, ...rowsCsv]
      .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["\uFEFF" + csvText], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `売上帳票_介護保険レンタル_${month}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {/* ツールバー（月ナビ + CSV） */}
      <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0.5 border border-gray-300 rounded bg-white px-2 py-1">
          <button onClick={prevMonth} className="text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="font-semibold text-gray-800 px-2">{y}年 {m}月</span>
          <button onClick={nextMonth} className="text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <button onClick={toThisMonth} className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">本日の月へ</button>
        <span className="border border-blue-500 rounded bg-blue-100 px-2.5 py-1 text-blue-800 font-semibold">介護保険レンタル</span>
        {/* 横長対策: 件数・CSV出力も右端に飛ばさず並べる */}
        <div className="flex items-center gap-2">
          <span className="text-gray-500 text-xs">{rows.length} 件</span>
          {calc && calc.notices.length > 0 && (
            <span className="text-[11px] text-amber-700" title={calc.notices.join("\n")}>⚠ {calc.notices[0]}{calc.notices.length > 1 ? ` (他 ${calc.notices.length - 1} 件)` : ""}</span>
          )}
          <button onClick={exportCSV}
            className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5">
            <Download size={13} />CSV出力
          </button>
        </div>
      </div>

      {/* 月次損益（発生ベース）。経費 (仕入) は 2 段目の読み込み後 */}
      {!loading && subLoading && (
        <div className="border-b border-gray-300 bg-slate-50 shrink-0 px-3 py-2 text-xs text-gray-400 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />月次損益・仕入・書類の ✓ を読み込み中 (表は先に出しています)
        </div>
      )}
      {!loading && !subLoading && (
        <div className="border-b border-gray-300 bg-slate-50 shrink-0">
          <div className="px-3 py-2 flex items-center gap-4 flex-wrap text-xs">
            <span className="font-semibold text-gray-700">月次損益（発生ベース）</span>
            <span className="text-gray-600">売上 <span className="font-semibold text-gray-900">¥{pnl.revenue.toLocaleString()}</span> <span className="text-gray-400">(稼働{pnl.activeCount}件)</span></span>
            <span className="text-gray-600">
              経費{" "}
              {pnl.unknownCostCount > 0 ? (
                <span
                  className="font-semibold text-amber-700"
                  title={`当月開始 ${pnl.startedCount} 件のうち ${pnl.unknownCostCount} 件は仕入原価が分からない (卸未設定 / 卸別仕入単価が未登録) ため経費に入っていません。¥0 ではなく不明です。`}
                >
                  ¥{pnl.expense.toLocaleString()} + 未設定{pnl.unknownCostCount}件
                </span>
              ) : (
                <span className="font-semibold text-gray-900">¥{pnl.expense.toLocaleString()}</span>
              )}{" "}
              <span className="text-gray-400">(当月開始{pnl.startedCount}件 / うち仕入未設定{pnl.unknownCostCount}件)</span>
            </span>
            <span className="text-gray-600">
              利益{" "}
              <span className={`font-bold ${pnl.unknownCostCount > 0 ? "text-amber-700" : pnl.profit >= 0 ? "text-emerald-700" : "text-red-600"}`}>
                ¥{pnl.profit.toLocaleString()}{pnl.unknownCostCount > 0 && <span className="font-normal text-[10px]">（経費不明分を含まない）</span>}
              </span>
            </span>
            <button
              onClick={() => setShowPnlDetail((v) => !v)}
              className="text-[11px] px-2 py-0.5 rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
            >
              内訳 {showPnlDetail ? "▲" : "▼"}
            </button>
            <span className="text-[10px] text-gray-400">売上=当月稼働レンタルの月額合計 / 経費=当月開始レンタルの仕入原価（現金支払とは別軸）</span>
            {samplePriceRowCount > 0 && (
              <span className="text-[10px] text-gray-400">※サンプル仕入単価 {samplePriceRowCount.toLocaleString()} 行は経費に使っていません</span>
            )}
          </div>
          {showPnlDetail && (
            <div className="px-3 pb-3 grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs max-w-6xl tabular-nums">
              {/* 商品別 (売上上位20) */}
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
                <p className="px-3 py-1.5 font-semibold text-gray-600 border-b border-slate-100">商品別（売上上位20）</p>
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 text-gray-400">
                    <tr>
                      <th className="text-left px-3 py-1 font-medium">商品</th>
                      <th className="text-right px-2 py-1 font-medium">稼働</th>
                      <th className="text-right px-2 py-1 font-medium">売上</th>
                      <th className="text-right px-2 py-1 font-medium">経費</th>
                      <th className="text-right px-3 py-1 font-medium">損益</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(pnl.byProduct.entries())
                      .sort((a, b) => b[1].revenue - a[1].revenue)
                      .slice(0, 20)
                      .map(([code, v]) => {
                        const eq = equipment.find((e) => e.product_code === code);
                        const profit = v.revenue - v.expense;
                        return (
                          <tr key={code} className="border-t border-dashed border-slate-100">
                            <td className="px-3 py-1 max-w-0"><span className="block truncate" title={eq?.name ?? code}>{eq?.name ?? code}</span></td>
                            <td className="text-right px-2 py-1 text-gray-500">{v.activeCount}</td>
                            <td className="text-right px-2 py-1">¥{v.revenue.toLocaleString()}</td>
                            <td className="text-right px-2 py-1 text-gray-500">¥{v.expense.toLocaleString()}</td>
                            <td className={`text-right px-3 py-1 font-medium ${profit >= 0 ? "text-emerald-700" : "text-red-600"}`}>¥{profit.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              {/* 卸別 (当月開始の仕入) */}
              <div className="bg-white rounded-lg border border-slate-200 overflow-hidden self-start">
                <p className="px-3 py-1.5 font-semibold text-gray-600 border-b border-slate-100">卸別 仕入（当月開始分）</p>
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 text-gray-400">
                    <tr>
                      <th className="text-left px-3 py-1 font-medium">卸会社</th>
                      <th className="text-right px-2 py-1 font-medium">件数</th>
                      <th className="text-right px-3 py-1 font-medium">仕入額</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from(pnl.bySupplier.entries())
                      .sort((a, b) => b[1].expense - a[1].expense)
                      .map(([sid, v]) => {
                        const name = sid === "__none__" ? "（卸未設定・仕入原価不明）" : (suppliersAll.find((s) => s.id === sid)?.name ?? sid);
                        return (
                          <tr key={sid} className="border-t border-dashed border-slate-100">
                            <td className="px-3 py-1">{name}</td>
                            <td className="text-right px-2 py-1 text-gray-500">{v.startedCount}</td>
                            <td className="text-right px-3 py-1">¥{v.expense.toLocaleString()}</td>
                          </tr>
                        );
                      })}
                    {pnl.bySupplier.size === 0 && (
                      <tr><td colSpan={3} className="px-3 py-2 text-gray-400 text-center">当月開始のレンタルがありません</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* テーブル */}
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-400" /></div>
      ) : rows.length === 0 ? (
        <p className="text-center text-sm text-gray-400 py-16">この月に該当する売上データがありません</p>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="text-xs border-collapse min-w-max">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                {[
                  "NO", "売上日", "入力者", "R項目", "契約", "R契約日", "R解約日", "解約理由",
                  "提案", "援助計画", "紹介機関", "居宅", "ケアマネ様氏名",
                  "受注担当", "納品・回収", "利用者名", "商品名",
                  "R売上\n(1ヶ月)", "R売上\n(半月)", "R引上\n(1ヶ月)", "R引上\n(半月)", "仕入",
                  "R売上\n(日割)", "R引上\n(日割)",
                ].map((h) => (
                  <th key={h} className="border border-gray-300 px-2 py-1 font-medium text-gray-600 whitespace-pre-line text-center">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const sr = getSalesRec(r.orderItemId, r.eventType);
                const { revenueFull, revenueHalf, revenueDaily, liftFull, liftHalf, liftDaily } = amountCols(r);
                const yen = (v: number | null) => v !== null ? `¥${v.toLocaleString()}` : "";
                const rTypeColor =
                  r.rType === "新規" ? "bg-blue-50 text-blue-700" :
                  r.rType === "追加" ? "bg-emerald-50 text-emerald-700" :
                  r.rType === "一部解約" ? "bg-amber-50 text-amber-700" :
                  "bg-red-50 text-red-700";
                return (
                  <tr key={r.key} className="hover:bg-gray-50">
                    <td className="border border-gray-200 px-2 py-1 text-center text-gray-500">{idx + 1}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.salesDate}</td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.input_by ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "input_by", e.target.value)}
                        className="w-24 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className={`border border-gray-200 px-2 py-1 text-center font-medium ${rTypeColor}`}>{r.rType}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center">{hasContract(r.client.id) ? "✓" : ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.item.rental_start_date ?? ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.item.rental_end_date ?? ""}</td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.cancellation_reason ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "cancellation_reason", e.target.value)}
                        className="w-32 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className="border border-gray-200 px-2 py-1 text-center">{hasDoc(r.client.id, "proposal") ? "✓" : ""}</td>
                    <td className="border border-gray-200 px-2 py-1 text-center">{hasDoc(r.client.id, "care_plan") ? "✓" : ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.client.referrer_org ?? ""}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{getCareOfficeName(r.client)}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{getCareManagerName(r.client)}</td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.sales_rep ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "sales_rep", e.target.value)}
                        className="w-24 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className="border border-gray-200 px-0 py-0">
                      <input type="text" defaultValue={sr?.delivery_person ?? ""}
                        onBlur={(e) => saveSalesField(r.orderItemId, r.eventType, "delivery_person", e.target.value)}
                        className="w-24 px-2 py-1 outline-none focus:bg-yellow-50" />
                    </td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap font-medium text-gray-800">{r.client.name}</td>
                    <td className="border border-gray-200 px-2 py-1 whitespace-nowrap">{r.equipmentName}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(revenueFull)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(revenueHalf)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(liftFull)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{yen(liftHalf)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap">{r.purchasePrice ? `¥${r.purchasePrice.toLocaleString()}` : ""}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap text-amber-700">{yen(revenueDaily)}</td>
                    <td className="border border-gray-200 px-2 py-1 text-right whitespace-nowrap text-amber-700">{yen(liftDaily)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** 利用・提供表の 1 明細 (親の rentalGridCalcOf が 請求と同じ計算で作る) */
type RentalGridCalc = {
  /** 当月の単位 × 数量 (請求・伝送と同じ) */
  units: number;
  /** 算定に数える貸与日数 (入院・休止を除く) */
  billedDays: number;
  kind: "full" | "half" | "daily" | "none";
  label: string;
};

// ─── BillingClientRow (介護請求の一覧の 1 行。React.memo) ─────────────────────────────
// 2026-11-13: 元は一覧の map の中に直接書いていた JSX。中身は変えず、親で作った値を props で受ける形にした。
type BillingRowActions = {
  toggleDetail: (client: BillingClient, items: OrderItem[]) => void;
  toggleSelect: (clientId: string) => void;
  openExceptionGrant: (clientId: string, group: string) => void;
  kohiModeChange: (clientId: string, value: string) => void;
  openRentalGrid: (client: BillingClient, items: OrderItem[]) => void;
  openInvoice: (client: BillingClient) => void;
  cmCommit: (clientId: string, value: string) => void;
  toggleLate: (clientId: string) => void;
  setRebill: (clientId: string, value: "返戻" | null) => void;
  toggleKago: (clientId: string) => void;
};

const BillingClientRow = memo(function BillingClientRow({
  client, items, even, y, m, billingMonth,
  isAutoLate, lateFlagMonth, hasLateFlag, rebillFlagType, isSelected, isDetail, isApplying, isNoCareLevel, careOfficeName,
  exception, kohiPartial, kohiMode, kohiModeDisabled, kohiModesNotice,
  cmUnits: cm, actualUnits: actual, cmDisabled, cmUnitsAvailable, cmUnitsNotice, actions,
}: {
  client: BillingClient; items: OrderItem[]; even: boolean; y: number; m: number; billingMonth: string;
  isAutoLate: boolean; lateFlagMonth: string | null; hasLateFlag: boolean; rebillFlagType: string | null;
  isSelected: boolean; isDetail: boolean; isApplying: boolean; isNoCareLevel: boolean; careOfficeName: string;
  exception: { level: ExceptionAlertLevel; items: ExceptionJudgement[] } | null;
  kohiPartial: { kohi: FukuyoguKohi; firstDay: string | null; lastDay: string | null } | null;
  kohiMode: KohiMonthMode | null; kohiModeDisabled: boolean; kohiModesNotice: string | null;
  cmUnits: number | null; actualUnits: number; cmDisabled: boolean; cmUnitsAvailable: boolean; cmUnitsNotice: string | null;
  actions: BillingRowActions;
}) {
  const isLate = isAutoLate || hasLateFlag;
  // 提出月 = lateFlag.month があればそれ、無ければ billingMonth
  const submitMonth = lateFlagMonth ?? billingMonth;
  const [sy, sm] = submitMonth.split("-").map(Number);
  const over = cm != null && cm < actual ? actual - cm : 0;
  return (
    <div
      onClick={() => actions.toggleDetail(client, items)}
      className={`grid min-w-max grid-cols-[32px_64px_72px_60px_60px_180px_104px_minmax(160px,360px)_84px_64px_72px_44px] border-b border-gray-100 text-xs cursor-pointer transition-colors ${
        isDetail ? "bg-blue-100" : isLate ? "bg-yellow-50" : isSelected ? "bg-indigo-50" : even ? "bg-white hover:bg-gray-50" : "bg-gray-50/50 hover:bg-gray-100"
      }`}
    >
      <div className="px-1 py-2 flex items-center justify-center" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => actions.toggleSelect(client.id)}
          className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
            isSelected ? "border-indigo-500 bg-indigo-500" : "border-gray-400 bg-white"
          }`}
        >
          {isSelected && <span className="text-white text-[8px] font-bold leading-none">✓</span>}
        </button>
      </div>
      <div className="px-1 py-2 border-l border-gray-100 text-center">
        {isApplying && (
          <span className="inline-block bg-yellow-200 text-yellow-900 font-semibold text-[10px] px-1.5 py-0.5 rounded">申請中</span>
        )}
        {isNoCareLevel && !isApplying && (
          <span
            className="inline-block bg-red-100 text-red-800 border border-red-300 font-semibold text-[10px] px-1 py-0.5 rounded leading-tight"
            title="当月に有効な認定が無い等で要介護度をコードにできないため、伝送から外して月遅れ扱いにしています (そのまま出すと確実に返戻)。利用者タブで認定を登録してください"
          >要介護度なし</span>
        )}
      </div>
      <div className="px-2 py-2 border-l border-gray-100">
        {!isLate && <span className="text-red-600 font-semibold">国保対象</span>}
      </div>
      <div className="px-2 py-2 border-l border-gray-100 text-gray-700">R{sy-2018}/{sm}</div>
      <div className="px-2 py-2 border-l border-gray-100 text-gray-700">R{y-2018}/{m}</div>
      <div className="px-2 py-2 border-l border-gray-100 text-gray-700 truncate" title={careOfficeName}>{careOfficeName || "—"}</div>
      <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-700">{client.user_number ?? "—"}</div>
      <div className="px-2 py-2 border-l border-gray-100 font-medium text-gray-800 flex items-center gap-1.5 min-w-0">
        <span className="flex-1 truncate">{client.name}</span>
        {(() => {
          const ex = exception;
          if (!ex) return null;
          // 押したら 赤 (記録なし/切れ) の区分を優先して開く
          const target = ex.items.find((i) => i.level === "danger") ?? ex.items[0];
          return (
            <button
              onClick={e => { e.stopPropagation(); actions.openExceptionGrant(client.id, target.group); }}
              title={`${ex.items.map(describeJudgement).join("\n")}\n\n押すと利用者タブの例外給付 (${target.group}) の入力を開きます`}
              className={`shrink-0 text-[10px] border rounded px-1.5 py-0.5 font-semibold transition-colors ${ex.level === "danger" ? "border-red-400 text-red-700 bg-red-50 hover:bg-red-100" : "border-orange-400 text-orange-700 bg-orange-50 hover:bg-orange-100"}`}
            >例外給付{ex.level === "danger" ? (ex.items.some((i) => i.kind === "missing") ? "なし" : "切れ") : "期限"}</button>
          );
        })()}
        {(() => {
          // ★ 月途中の公費 (生保): ケアマネの方針で 全部利用者負担 / 日割り / 半月 を選ぶ。未選択 = 既定 (赤)
          const kp = kohiPartial;
          if (!kp) return null;
          const mode = kohiMode;
          const range = `${kp.firstDay ?? "?"}〜${kp.lastDay ?? "?"}`;
          return (
            <select
              value={mode ?? ""}
              disabled={kohiModeDisabled}
              onClick={e => e.stopPropagation()}
              onChange={e => actions.kohiModeChange(client.id, e.target.value)}
              title={kohiModesNotice != null
                ? kohiModesNotice
                : `公費 (法別${kp.kohi.hobetsu}) の期間が月の一部です (${range})。ケアマネの方針で選んでください。\n未選択のときは「${KOHI_MONTH_MODE_LABEL[KOHI_MONTH_MODE_DEFAULT]}」で請求します`}
              className={`shrink-0 text-[10px] border rounded px-1 py-0.5 font-semibold bg-white disabled:bg-gray-100 ${mode ? "border-sky-400 text-sky-700" : "border-red-400 text-red-700 bg-red-50"}`}
            >
              <option value="">公費 月途中: 未選択</option>
              {KOHI_MONTH_MODES.map((md) => <option key={md} value={md}>公費 {KOHI_MONTH_MODE_LABEL[md]}</option>)}
            </select>
          );
        })()}
        <button
          onClick={e => { e.stopPropagation(); actions.openRentalGrid(client, items); }}
          className="shrink-0 text-[10px] border border-gray-300 rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
        >提供表</button>
        <button
          onClick={e => { e.stopPropagation(); actions.openInvoice(client); }}
          className="shrink-0 text-[10px] border border-emerald-400 rounded px-1.5 py-0.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors"
        >請求書</button>
      </div>
      <div className="px-1 py-1 border-l border-gray-100 text-center" onClick={e => e.stopPropagation()}>
        <input
          key={`${client.id}-${billingMonth}-${cm ?? ""}`}
          type="text"
          inputMode="numeric"
          defaultValue={cm != null ? String(cm) : ""}
          disabled={cmDisabled}
          placeholder={cmUnitsAvailable ? "" : "未適用"}
          onBlur={e => actions.cmCommit(client.id, e.currentTarget.value)}
          onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
          title={!cmUnitsAvailable ? (cmUnitsNotice ?? "") : over > 0 ? `CM 指示単位数で頭打ち: 実績 ${actual} 単位 → 保険請求 ${cm} 単位 / 超過 ${over} 単位 (${(over * 10).toLocaleString()}円) は保険外 (全額自己負担)` : "空欄 = 月次情報 (給付管理) 未着 → 伝送から外す (月遅れ扱い)。その月に 1 名も入力が無いときは実績で請求"}
          className={`w-full text-[11px] text-right font-mono border rounded px-1 py-0.5 bg-white disabled:bg-gray-100 ${over > 0 ? "border-orange-400 text-orange-700 font-semibold" : "border-gray-300 text-gray-700"}`}
        />
        {over > 0 && <div className="text-[9px] text-orange-700 leading-tight mt-0.5">頭打ち −{over.toLocaleString()}</div>}
      </div>
      <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={e => e.stopPropagation()}>
        <select
          value={isLate ? "月遅" : ""}
          disabled={isAutoLate}
          onChange={() => actions.toggleLate(client.id)}
          title={isAutoLate ? "保険証が申請中のため自動で月遅れ扱い(解除不可)" : "月遅れ"}
          className={`w-full text-[11px] border rounded px-0.5 py-0.5 bg-white disabled:bg-yellow-50 disabled:text-yellow-700 disabled:border-yellow-300 ${isLate ? "border-yellow-400 text-yellow-700 font-semibold" : "border-gray-300 text-gray-500"}`}
        >
          <option value=""></option>
          <option value="月遅">月遅</option>
        </select>
      </div>
      <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={e => e.stopPropagation()}>
        <select
          value={rebillFlagType === "返戻" ? "返戻" : ""}
          onChange={e => actions.setRebill(client.id, e.target.value === "返戻" ? "返戻" : null)}
          className={`w-full text-[11px] border rounded px-1 py-0.5 bg-white ${rebillFlagType === "返戻" ? "border-red-400 text-red-600 font-semibold" : "border-gray-300 text-gray-500"}`}
        >
          <option value=""></option>
          <option value="返戻">返戻</option>
        </select>
      </div>
      <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={e => { e.stopPropagation(); actions.toggleKago(client.id); }}>
        <span
          className={`inline-flex w-5 h-5 rounded-full border-2 items-center justify-center text-[10px] font-bold cursor-pointer transition-colors ${
            rebillFlagType === "過誤" ? "border-red-500 bg-red-500 text-white" : "border-gray-300 text-transparent hover:border-red-300"
          }`}
          title="過誤"
        >○</span>
      </div>
    </div>
  );
});

// ─── RentalGridModal ──────────────────────────────────────────────────────────

function RentalGridModal({
  client, items, equipment, hospitalizations, pausesOf, calcOf, month, onClose,
}: {
  client: BillingClient;
  items: OrderItem[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
  pausesOf: (itemId: string) => DateRange[];
  calcOf: (item: OrderItem) => RentalGridCalc;
  month: string;
  onClose: () => void;
}) {
  const [y, m] = month.split("-").map(Number);
  const reiwa = y - 2018;
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const DOW = ["日","月","火","水","木","金","土"];
  const getDoW = (day: number) => DOW[new Date(y, m - 1, day).getDay()];
  const isWeekend = (day: number) => { const d = new Date(y, m - 1, day).getDay(); return d === 0 || d === 6; };

  const pld = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };

  // 入院期間を日単位のSetで保持
  const hospDays = new Set<number>();
  for (const h of hospitalizations) {
    const admitDate = pld(h.admission_date);
    const dischargeDate = h.discharge_date ? pld(h.discharge_date) : new Date(y, m, 0);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= admitDate && date <= dischargeDate) hospDays.add(d);
    }
  }

  // 各アイテムの貸与日を計算
  const getItemDays = (item: OrderItem) => {
    if (!item.rental_start_date) return new Set<number>();
    const start = pld(item.rental_start_date);
    const end = item.rental_end_date ? pld(item.rental_end_date) : new Date(y, m, 0);
    const active = new Set<number>();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= start && date <= end) active.add(d);
    }
    return active;
  };

  // 単位・請求区分は 請求・伝送と同じ計算 (親の calcOf = getUnits + halfMonthFlags。自前で半月を判定しない)
  // 休止の日 (表示用。算定は calcOf 側で除いている)
  const pausedDay = (item: OrderItem, d: number) => {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    return pausesOf(item.id).some((r) => (!r.from || day >= r.from) && (!r.to || day <= r.to));
  };

  const eq = (item: OrderItem) => equipment.find(e => e.product_code === item.product_code);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-[95vw] max-h-[90vh]">
        {/* ヘッダー */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-200 bg-gray-50 rounded-t-lg shrink-0">
          <span className="font-bold text-gray-800">利用・提供表</span>
          <span className="text-gray-600 text-sm">{client.name}</span>
          <span className="text-gray-500 text-sm">R{reiwa}/{m}月</span>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => window.print()}
              className="text-xs border border-gray-300 rounded px-3 py-1 hover:bg-gray-100 flex items-center gap-1"
            >
              <Printer size={12} />印刷
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-700"><X size={18} /></button>
          </div>
        </div>

        {/* グリッド本体 */}
        <div className="flex-1 overflow-auto p-3">
          <table className="border-collapse text-[11px] w-full">
            <thead>
              {/* 曜日行 */}
              <tr>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-600 min-w-[140px]">サービス内容</th>
                {days.map(d => (
                  <th key={d} className={`border border-gray-300 px-0.5 py-1 text-center font-medium w-6 ${
                    isWeekend(d) ? "bg-red-50 text-red-500" : "bg-gray-100 text-gray-600"
                  }`}>
                    <div>{d}</div>
                    <div className={`text-[9px] ${isWeekend(d) ? "text-red-400" : "text-gray-400"}`}>{getDoW(d)}</div>
                  </th>
                ))}
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-10">合計</th>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-14">単位数</th>
                <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-16">請求区分</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const e = eq(item);
                const itemDays = getItemDays(item);
                const { units, billedDays: rentalDayCount, kind: billing, label: billingLabel } = calcOf(item);
                return (
                  <tr key={item.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                    <td className="border border-gray-200 px-2 py-1.5 font-medium text-gray-800 leading-tight">
                      {e?.name ?? item.product_code}
                    </td>
                    {days.map(d => {
                      const isRental = itemDays.has(d);
                      const isHosp = hospDays.has(d);
                      const isPause = !isHosp && pausedDay(item, d);
                      const isStart = item.rental_start_date && (() => { const s = pld(item.rental_start_date!); return s.getDate() === d && s.getMonth() === m - 1 && s.getFullYear() === y; })();
                      const isEnd = item.rental_end_date && (() => { const e = pld(item.rental_end_date!); return e.getDate() === d && e.getMonth() === m - 1 && e.getFullYear() === y; })();
                      return (
                        <td key={d} className={`text-center p-0 h-7 ${
                          !isRental ? "border border-gray-200 bg-white" :
                          isHosp ? "border border-orange-300 bg-orange-100" :
                          isPause ? "border border-gray-300 bg-gray-100" :
                          "border border-blue-300 bg-blue-100"
                        }`}>
                          {isRental && (
                            <span className={`text-[9px] font-bold ${
                              isHosp ? "text-orange-500" :
                              isPause ? "text-gray-500" :
                              isStart ? "text-blue-700" :
                              isEnd ? "text-purple-600" :
                              "text-blue-500"
                            }`}>
                              {isStart ? "S" : isEnd ? "E" : isHosp ? "入" : isPause ? "休" : "●"}
                            </span>
                          )}
                        </td>
                      );
                    })}
                    <td className="border border-gray-200 px-1 py-1 text-right font-mono text-gray-700">{rentalDayCount}日</td>
                    <td className="border border-gray-200 px-1 py-1 text-right font-mono font-semibold text-gray-800">{units}</td>
                    <td className={`border border-gray-200 px-1 py-1 text-center text-[10px] font-semibold ${
                      billing === "full" ? "text-gray-700" :
                      billing !== "none" ? "text-amber-600" : "text-gray-400"
                    }`}>{billingLabel}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 凡例 */}
          <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-500">
            <span className="flex items-center gap-1"><span className="w-4 h-4 bg-blue-100 border border-gray-300 inline-block rounded-sm" />貸与中</span>
            <span className="flex items-center gap-1"><span className="w-4 h-4 bg-orange-100 border border-gray-300 inline-block rounded-sm" />入院中（請求除外）</span>
            <span className="flex items-center gap-1"><span className="font-bold text-blue-700 text-xs">S</span> 開始日</span>
            <span className="flex items-center gap-1"><span className="font-bold text-purple-600 text-xs">E</span> 終了日</span>
          </div>

          {/* 合計 */}
          <div className="mt-4 inline-block border border-gray-300 rounded overflow-hidden text-[11px]">
            <div className="bg-gray-100 border-b border-gray-300 px-3 py-1 font-semibold text-gray-700 text-center">介護請求合計</div>
            <table className="border-collapse">
              <thead>
                <tr>
                  <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600"></th>
                  <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">単位数合計</th>
                  <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">請求区分</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-700">合計</td>
                  <td className="border border-gray-200 px-3 py-1 text-right font-mono font-semibold text-gray-800">
                    {items.reduce((s, item) => s + calcOf(item).units, 0)}単位
                  </td>
                  <td className="border border-gray-200 px-3 py-1 text-center text-gray-600">介護保険</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RentalGridPanel (inline, no modal wrapper) ───────────────────────────────

const RentalGridPanel = memo(function RentalGridPanel({
  client, items, equipment, hospitalizations, pausesOf, calcOf, month,
}: {
  client: BillingClient;
  items: OrderItem[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
  pausesOf: (itemId: string) => DateRange[];
  calcOf: (item: OrderItem) => RentalGridCalc;
  month: string;
}) {
  const [y, m] = month.split("-").map(Number);
  const reiwa = y - 2018;
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  const DOW = ["日","月","火","水","木","金","土"];
  const getDoW = (day: number) => DOW[new Date(y, m - 1, day).getDay()];
  const isWeekend = (day: number) => { const d = new Date(y, m - 1, day).getDay(); return d === 0 || d === 6; };

  const pld = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };

  const hospDays = new Set<number>();
  for (const h of hospitalizations) {
    const admitDate = pld(h.admission_date);
    const dischargeDate = h.discharge_date ? pld(h.discharge_date) : new Date(y, m, 0);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= admitDate && date <= dischargeDate) hospDays.add(d);
    }
  }

  const getItemDays = (item: OrderItem) => {
    if (!item.rental_start_date) return new Set<number>();
    const start = pld(item.rental_start_date);
    const end = item.rental_end_date ? pld(item.rental_end_date) : new Date(y, m, 0);
    const active = new Set<number>();
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date >= start && date <= end) active.add(d);
    }
    return active;
  };

  // 単位・請求区分は 請求・伝送と同じ計算 (親の calcOf = getUnits + halfMonthFlags。自前で半月を判定しない)
  // 休止の日 (表示用。算定は calcOf 側で除いている)
  const pausedDay = (item: OrderItem, d: number) => {
    const day = `${month}-${String(d).padStart(2, "0")}`;
    return pausesOf(item.id).some((r) => (!r.from || day >= r.from) && (!r.to || day <= r.to));
  };

  const eq = (item: OrderItem) => equipment.find(e => e.product_code === item.product_code);

  return (
    <div className="p-3">
      {/* ヘッダー */}
      <div className="flex items-center gap-3 mb-3">
        <span className="font-bold text-gray-800 text-sm">利用・提供表</span>
        <span className="text-gray-700 font-semibold">{client.name}</span>
        <span className="text-gray-500 text-sm">R{reiwa}/{m}月</span>
        <button
          onClick={() => window.print()}
          className="ml-auto text-xs border border-gray-300 rounded px-3 py-1 hover:bg-gray-100 flex items-center gap-1"
        ><Printer size={12} />印刷</button>
      </div>

      {/* グリッド */}
      <div className="overflow-x-auto">
        <table className="border-collapse text-[11px]">
          <thead>
            <tr>
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-left font-semibold text-gray-600 min-w-[140px]">サービス内容</th>
              {days.map(d => (
                <th key={d} className={`border border-gray-300 px-0.5 py-1 text-center font-medium w-6 ${
                  isWeekend(d) ? "bg-red-50 text-red-500" : "bg-gray-100 text-gray-600"
                }`}>
                  <div>{d}</div>
                  <div className={`text-[9px] ${isWeekend(d) ? "text-red-400" : "text-gray-400"}`}>{getDoW(d)}</div>
                </th>
              ))}
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-10">合計</th>
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-14">単位数</th>
              <th className="border border-gray-300 bg-gray-100 px-2 py-1 text-center font-semibold text-gray-600 w-16">請求区分</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const e = eq(item);
              const itemDays = getItemDays(item);
              const { units, billedDays: rentalDayCount, kind: billing, label: billingLabel } = calcOf(item);
              return (
                <tr key={item.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                  <td className="border border-gray-200 px-2 py-1.5 font-medium text-gray-800 leading-tight">
                    {e?.name ?? item.product_code}
                  </td>
                  {days.map(d => {
                    const isRental = itemDays.has(d);
                    const isHosp = hospDays.has(d);
                    const isPause = !isHosp && pausedDay(item, d);
                    const isStart = item.rental_start_date && (() => { const s = pld(item.rental_start_date!); return s.getDate() === d && s.getMonth() === m - 1 && s.getFullYear() === y; })();
                    const isEnd = item.rental_end_date && (() => { const e = pld(item.rental_end_date!); return e.getDate() === d && e.getMonth() === m - 1 && e.getFullYear() === y; })();
                    return (
                      <td key={d} className={`text-center p-0 h-7 ${
                        !isRental ? "border border-gray-200 bg-white" :
                        isHosp ? "border border-orange-300 bg-orange-100" :
                        isPause ? "border border-gray-300 bg-gray-100" :
                        "border border-blue-300 bg-blue-100"
                      }`}>
                        {isRental && (
                          <span className={`text-[9px] font-bold ${
                            isHosp ? "text-orange-500" :
                            isPause ? "text-gray-500" :
                            isStart ? "text-blue-700" :
                            isEnd ? "text-purple-600" :
                            "text-blue-500"
                          }`}>
                            {isStart ? "S" : isEnd ? "E" : isHosp ? "入" : isPause ? "休" : "●"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="border border-gray-200 px-1 py-1 text-right font-mono text-gray-700">{rentalDayCount}日</td>
                  <td className="border border-gray-200 px-1 py-1 text-right font-mono font-semibold text-gray-800">{units}</td>
                  <td className={`border border-gray-200 px-1 py-1 text-center text-[10px] font-semibold ${
                    billing === "full" ? "text-gray-700" :
                    billing !== "none" ? "text-amber-600" : "text-gray-400"
                  }`}>{billingLabel}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 凡例 */}
      <div className="flex items-center gap-4 mt-3 text-[11px] text-gray-500">
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-blue-100 border border-blue-300 inline-block rounded-sm" />貸与中</span>
        <span className="flex items-center gap-1"><span className="w-4 h-4 bg-orange-100 border border-orange-300 inline-block rounded-sm" />入院中（請求除外）</span>
        <span className="flex items-center gap-1"><span className="font-bold text-blue-700 text-xs">S</span> 開始日</span>
        <span className="flex items-center gap-1"><span className="font-bold text-purple-600 text-xs">E</span> 終了日</span>
      </div>

      {/* 合計 */}
      <div className="mt-4 inline-block border border-gray-300 rounded overflow-hidden text-[11px]">
        <div className="bg-gray-100 border-b border-gray-300 px-3 py-1 font-semibold text-gray-700 text-center">介護請求合計</div>
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600"></th>
              <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">単位数合計</th>
              <th className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-600">請求区分</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="border border-gray-200 px-3 py-1 bg-gray-50 font-medium text-gray-700">合計</td>
              <td className="border border-gray-200 px-3 py-1 text-right font-mono font-semibold text-gray-800">
                {items.reduce((s, item) => s + calcOf(item).units, 0)}単位
              </td>
              <td className="border border-gray-200 px-3 py-1 text-center text-gray-600">介護保険</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
});

// ─── 請求書／領収書 モーダル ───────────────────────────────────────────────
// 介護保険対象レンタルの当月利用料を集計し、請求書または領収書として A4 印刷
// 可能なプレビューで表示する。保存時には invoices テーブルに番号を採番して
// upsert し、再発行時は同じ番号を再利用する。
function InvoiceReceiptModal({
  client,
  orders,
  orderItems,
  equipment,
  companyInfo,
  priceHistory,
  tenantId,
  defaultMonth,
  hospitalizations,
  prorations,
  pausesByItem,
  onClose,
}: {
  client: BillingClient;
  orders: Order[];
  orderItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  priceHistory: EquipmentPriceHistory[];
  tenantId: string;
  defaultMonth: string;  // YYYY-MM
  hospitalizations: ClientHospitalization[];
  /** 明細×月の算定方法 (日割り設定)。単位は請求・伝送と同じ rentalMonthUnits */
  prorations: ProrationLoad | null;
  /** 貸与の休止 (order_item_pauses)。休止日は貸与日に数えない */
  pausesByItem: Map<string, DateRange[]>;
  onClose: () => void;
}) {
  const [targetMonth, setTargetMonth] = useState(defaultMonth);
  const [mode, setMode] = useState<"invoice" | "receipt">("invoice");
  const [saving, setSaving] = useState(false);
  const [invoiceNumber, setInvoiceNumber] = useState<number | null>(null);
  const [yearIssued, setYearIssued] = useState<number | null>(null);
  const [issuedDate, setIssuedDate] = useState<string | null>(null);
  const [loadingExisting, setLoadingExisting] = useState(true);
  // ★ 読込エラーを画面に出すため。以前は error を捨てていて「未発行」と区別が付かなかった
  const [loadError, setLoadError] = useState<string | null>(null);

  const [y, m] = targetMonth.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const monthStartStr = `${targetMonth}-01`;
  const monthEndStr = `${targetMonth}-${String(daysInMonth).padStart(2, "0")}`;

  // 対象月に発生した介護保険レンタル明細
  const careItems = useMemo(() => {
    const clientOrderIds = new Set(orders.filter(o => o.client_id === client.id).map(o => o.id));
    const resolvePay = (i: OrderItem): "介護" | "自費" | "特価自費" => {
      if (i.payment_type) return i.payment_type;
      return orders.find(o => o.id === i.order_id)?.payment_type ?? "介護";
    };
    return orderItems.filter((item) => {
      if (!clientOrderIds.has(item.order_id)) return false;
      if (resolvePay(item) !== "介護") return false;
      if (!item.rental_start_date) return false;
      if (item.rental_start_date > monthEndStr) return false;
      if (item.status === "terminated" && item.rental_end_date && item.rental_end_date < monthStartStr) return false;
      if (item.status !== "rental_started" && item.status !== "terminated") return false;
      return true;
    }).sort((a, b) => {
      const na = equipment.find(e => e.product_code === a.product_code)?.name ?? a.product_code;
      const nb = equipment.find(e => e.product_code === b.product_code)?.name ?? b.product_code;
      return na.localeCompare(nb, "ja");
    });
  }, [orders, orderItems, equipment, client.id, monthStartStr, monthEndStr]);

  const getEq = (code: string) => equipment.find((e) => e.product_code === code);
  // 価格を引く事業所 = その明細の注文の事業所 (lib/equipment.ts getPriceForMonth)
  const officeOfItem = (item: OrderItem): string | null => orders.find((o) => o.id === item.order_id)?.office_id ?? null;
  const histPrice = (code: string, ym: string, officeId: string | null) =>
    getPriceForMonth(priceHistory, code, ym, officeId) ?? undefined;

  // 対象月の請求対象日（入院除外を考慮した開始〜終了）
  const periodInfo = useMemo(() => {
    const pld = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const billingDays = new Set<number>();
    for (const item of careItems) {
      const start = pld(item.rental_start_date!);
      const end = item.rental_end_date ? pld(item.rental_end_date) : new Date(y, m, 0);
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(y, m - 1, d);
        if (date >= start && date <= end) {
          const inHosp = hospitalizations.some(h => {
            const admit = pld(h.admission_date);
            const discharge = h.discharge_date ? pld(h.discharge_date) : new Date(y, m, 0);
            return date >= admit && date <= discharge;
          });
          if (!inHosp) billingDays.add(d);
        }
      }
    }
    const sortedDays = [...billingDays].sort((a, b) => a - b);
    const firstDay = sortedDays[0] ?? null;
    const lastDay = sortedDays[sortedDays.length - 1] ?? null;
    return { billingDays, firstDay, lastDay };
  }, [careItems, hospitalizations, y, m, daysInMonth]);

  // 明細行の単位数・金額を算出
  const detailRows = useMemo(() => {
    return careItems.map((item) => {
      const eq = getEq(item.product_code);
      const price = getPriceForMonth(priceHistory, item.product_code, targetMonth, officeOfItem(item)) ?? item.rental_price ?? 0;
      // 単位は 請求・伝送と同じ rentalMonthUnits (日割り設定・入院・休止を反映)
      const units = itemMonthUnits(item, targetMonth, histPrice(item.product_code, targetMonth, officeOfItem(item)) ?? item.rental_price,
        [...hospitalizationRanges(hospitalizations), ...(pausesByItem.get(item.id) ?? [])], prorationModeOf(prorations, item.id, targetMonth)) ?? 0;
      const quantity = item.quantity || 1;
      const totalUnits = units * quantity;
      // 課税区分（現状 equipment に持たせていないので一律「非課税」扱い）
      const isTaxable = false;
      return {
        item,
        eqName: eq?.name ?? item.product_code,
        category: eq?.category ?? "",
        price,
        units,
        quantity,
        totalUnits,
        isTaxable,
      };
    });
    // getEq / histPrice は毎回作り直す関数なので、中で読む equipment / priceHistory を並べる (2026-11-13: equipment が漏れていた)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [careItems, priceHistory, equipment, targetMonth, y, m, hospitalizations, pausesByItem, prorations]);

  const totalUnits = detailRows.reduce((s, r) => s + r.totalUnits, 0);
  // ★ CM 指示単位数 (2026-11-09): 対象月に入力があれば その単位数までが保険、超過分は保険外 (全額自己負担)。
  //   請求画面と同じ表 (fukuyogu_cm_units)。読めなければ実績で計算し、画面に理由を出す。
  //   事業所は「その利用者の介護の発注の事業所」(1 つに決まるときだけ。複数なら全事業所の値を見る)
  const [cmLoaded, setCmLoaded] = useState<{ month: string; units: number | null; notice: string | null } | null>(null);
  const invoiceOfficeId = useMemo(() => {
    const ids = new Set(careItems.map((it) => orders.find((o) => o.id === it.order_id)?.office_id).filter((v): v is string => !!v));
    return ids.size === 1 ? [...ids][0] : null;
  }, [careItems, orders]);
  useEffect(() => {
    let cancelled = false;
    getCmUnits(tenantId, targetMonth, invoiceOfficeId).then((r) => {
      if (!cancelled) setCmLoaded({ month: targetMonth, units: r.byClient.get(client.id) ?? null, notice: r.message });
    });
    return () => { cancelled = true; };
  }, [tenantId, targetMonth, invoiceOfficeId, client.id]);
  const cmForMonth = cmLoaded?.month === targetMonth ? cmLoaded.units : null;
  const cmCap = capFukuyoguUnits(totalUnits, cmForMonth);
  const insuredAmount = cmCap.billedUnits * 10;
  const benefitRate = parseInt(client.benefit_rate ?? "90", 10);
  const copayRate = 100 - benefitRate;
  const insuranceCopay = Math.floor(insuredAmount * copayRate / 100);
  // 保険外 (CM 指示単位数を超えた分) は 10 割を本人に請求する
  const outsideAmount = cmCap.overUnits * 10;
  const copayAmount = insuranceCopay + outsideAmount;

  // 課税分・非課税分（現状は全部非課税）
  const taxableCopay = detailRows.reduce((s, r) => {
    if (!r.isTaxable) return s;
    return s + Math.floor(r.totalUnits * 10 * copayRate / 100);
  }, 0);
  const nonTaxableCopay = copayAmount - taxableCopay;
  const taxAmount = Math.floor(taxableCopay * 10 / 110); // 課税分に含まれる消費税（税込想定）
  const taxableBase = taxableCopay - taxAmount;

  // 既存番号のチェック（対象月で既に発行済みなら再利用）
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- HANDOVER §2 (mount-time async fetch / mount init)
    setLoadingExisting(true);
    setInvoiceNumber(null);
    setYearIssued(null);
    setIssuedDate(null);
    setLoadError(null);
    (async () => {
      try {
        // ⚠ ★ error を捨てていた。PostgREST は列名が違っても **throw しない**ので、
        //   `const { data }` だけだと catch にも入らず、★ 黙って「未発行」に見える。
        //   実際 `issued_date` (正: `issue_date`) の誤りで 保存も読込も失敗していたのに、
        //   この画面には ★ 何も出なかった (2026-09-03 実測。invoices が 0 行だった原因)。
        const { data, error } = await supabase
          .from("invoices")
          .select("invoice_number, year_issued, issue_date")
          .eq("tenant_id", tenantId)
          .eq("client_id", client.id)
          .eq("billing_month", targetMonth)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          // 42P01 = テーブル未作成。それ以外 (42703 = 列が無い 等) は ★ 握りつぶさない
          if (error.code === "42P01") {
            console.warn("invoices テーブルが未作成です (請求書番号の再利用はできません)");
          } else {
            console.error("請求書番号の読込に失敗:", error.code, error.message);
            setLoadError(`請求書番号を読めませんでした: ${error.message}`);
          }
          return;
        }
        if (data) {
          setInvoiceNumber(data.invoice_number as number);
          setYearIssued(data.year_issued as number);
          setIssuedDate((data.issue_date as string | null) ?? null);
        }
      } catch (e) {
        // 通信断など (PostgREST のエラーはここに来ない)
        console.error("請求書番号の読込で例外:", e);
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingExisting(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, client.id, targetMonth]);

  // 和暦ラベル
  const eraYM = toJapaneseEraYM(y, m);
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const issuedDateDisplay = issuedDate ?? todayStr;
  const issuedDateJa = toJapaneseEra(new Date(issuedDateDisplay + "T00:00:00"));

  // 番号表示
  const displayNumber = invoiceNumber !== null && yearIssued !== null
    ? `No. ${yearIssued}-${String(invoiceNumber).padStart(4, "0")}-01`
    : "No. 未発行";

  // 月切替
  const changeMonth = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    setTargetMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  // 保存・採番
  const handleSave = async () => {
    setSaving(true);
    try {
      const nowYear = new Date().getFullYear();
      let useNumber = invoiceNumber;
      let useYear = yearIssued;
      const useDate = issuedDate ?? todayStr;

      if (useNumber === null || useYear === null) {
        // 新規採番
        const { data: maxData } = await supabase
          .from("invoices")
          .select("invoice_number")
          .eq("tenant_id", tenantId)
          .order("invoice_number", { ascending: false })
          .limit(1);
        const currentMax = (maxData && maxData.length > 0) ? (maxData[0].invoice_number as number) : 0;
        useNumber = currentMax + 1;
        useYear = nowYear;
      }

      const snapshot = {
        client: {
          id: client.id,
          name: client.name,
          user_number: client.user_number,
          address: client.address,
          care_manager_org: client.care_manager_org,
          benefit_rate: client.benefit_rate,
        },
        company: companyInfo,
        rows: detailRows.map(r => ({
          product_code: r.item.product_code,
          name: r.eqName,
          category: r.category,
          price: r.price,
          units: r.units,
          quantity: r.quantity,
          total_units: r.totalUnits,
          is_taxable: r.isTaxable,
          rental_start_date: r.item.rental_start_date,
          rental_end_date: r.item.rental_end_date,
        })),
        total_units: totalUnits,
        insured_amount: insuredAmount,
        cm_units: cmForMonth,
        outside_units: cmCap.overUnits,
        outside_amount: outsideAmount,
        benefit_rate: benefitRate,
        copay_rate: copayRate,
        copay_amount: copayAmount,
        taxable_copay: taxableCopay,
        non_taxable_copay: nonTaxableCopay,
        tax_amount: taxAmount,
        taxable_base: taxableBase,
        period: {
          first_day: periodInfo.firstDay,
          last_day: periodInfo.lastDay,
        },
      };

      const { error } = await supabase.from("invoices").upsert({
        tenant_id: tenantId,
        client_id: client.id,
        billing_month: targetMonth,
        invoice_number: useNumber,
        year_issued: useYear,
        // ⚠ 列名は `issue_date` (d は入らない) / 金額の列は `total_amount`。
        //   `issued_date` / `copay_amount` と書いていて **upsert が必ず 42703 で落ちていた**。
        //   ★ この請求書は 利用者負担額 をそのまま請求する = copayAmount が総額。
        //   ⚠ DB には taxable_amount / nontaxable_amount / tax_amount もあるが、
        //     今は書いていない (内訳は data のスナップショットに入っている)。
        issue_date: useDate,
        total_amount: copayAmount,
        data: snapshot,
      }, { onConflict: "tenant_id,client_id,billing_month" });
      if (error) throw error;

      setInvoiceNumber(useNumber);
      setYearIssued(useYear);
      setIssuedDate(useDate);
      alert(`保存しました: No. ${useYear}-${String(useNumber).padStart(4, "0")}-01`);
    } catch (e) {
      console.error(e);
      // ⚠ 原因ごとに文面を変える。**同じ文面だと原因に辿り着けない。**
      //   実際 2026-09-03 に、列名の誤り (42703) をこの文面が
      //   「テーブルが無いのか」と読ませて、原因の特定を遅らせた。
      const code = (e as { code?: string } | null)?.code;
      if (code === "23505") {
        // 同時に 2 人が保存すると両方が同じ max を読んで同じ番号を取る。
        // DB の UNIQUE (tenant_id, invoice_number) が 2 人目を弾く。
        alert("他の人が同じ請求書番号を取りました。もう一度「保存」を押してください。");
      } else if (code === "42703" || code === "PGRST204") {
        alert("保存に失敗しました。invoices の列がコードと合っていません (管理者に連絡してください)。");
      } else {
        alert(`保存に失敗しました: ${(e as Error)?.message ?? "原因不明"}`);
      }
    } finally {
      setSaving(false);
    }
  };

  // 印刷用スタイル
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "__invoice_print__";
    style.textContent = `
      @page { size: A4 portrait; margin: 10mm; }
      @media print {
        body > * { visibility: hidden !important; }
        #invoice-receipt-modal, #invoice-receipt-modal * { visibility: visible !important; }
        #invoice-receipt-modal {
          position: fixed !important; top: 0 !important; left: 0 !important;
          width: 100% !important; height: auto !important;
          background: white !important; z-index: 99999 !important;
          overflow: visible !important;
        }
        .no-print { display: none !important; }
        .invoice-sheet { box-shadow: none !important; margin: 0 auto !important; }
      }
    `;
    document.head.appendChild(style);
    return () => { document.getElementById("__invoice_print__")?.remove(); };
  }, []);

  // 郵便番号（clients の postal_code を保持している場合のみ表示、型が無いので safe access）
  const postalCode = (client as unknown as { postal_code?: string | null }).postal_code ?? null;

  // カレンダー用 DOW
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  const firstDow = new Date(y, m - 1, 1).getDay();
  // 開始日・終了日（表示用）
  const startDayMark = new Set<number>();
  const endDayMark = new Set<number>();
  for (const item of careItems) {
    if (item.rental_start_date && item.rental_start_date >= monthStartStr && item.rental_start_date <= monthEndStr) {
      startDayMark.add(parseInt(item.rental_start_date.split("-")[2], 10));
    }
    if (item.rental_end_date && item.rental_end_date >= monthStartStr && item.rental_end_date <= monthEndStr) {
      endDayMark.add(parseInt(item.rental_end_date.split("-")[2], 10));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const title = mode === "invoice" ? "利用料請求書" : "利用料領収書";
  const amountLabel = mode === "invoice" ? "今回ご請求額" : "領収金額";
  const dateLabel = mode === "invoice" ? "発行日" : "領収日";

  return (
    <div id="invoice-receipt-modal" className="fixed inset-0 bg-black/70 z-[60] flex flex-col">

      {/* 操作バー */}
      <div className="no-print bg-white border-b border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
        <button onClick={onClose}><X size={20} className="text-gray-500" /></button>
        <span className="font-semibold text-gray-800">請求書／領収書</span>
        <div className="flex items-center gap-1 border border-gray-300 rounded-lg bg-white px-1">
          <button onClick={() => changeMonth(-1)} className="p-1 text-gray-500 hover:text-gray-800"><ChevronLeft size={14} /></button>
          <span className="font-semibold text-gray-800 px-2 text-sm">{eraYM}</span>
          <button onClick={() => changeMonth(1)} className="p-1 text-gray-500 hover:text-gray-800"><ChevronRight size={14} /></button>
        </div>
        <div className="flex items-center gap-1 border border-gray-300 rounded-lg overflow-hidden">
          <button onClick={() => setMode("invoice")}
            className={`px-3 py-1 text-sm ${mode === "invoice" ? "bg-emerald-500 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
            請求書
          </button>
          <button onClick={() => setMode("receipt")}
            className={`px-3 py-1 text-sm ${mode === "receipt" ? "bg-emerald-500 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>
            領収書
          </button>
        </div>
        {loadError && (
          // ★ 読込に失敗したことを画面に出す。出さないと「未発行」と見分けが付かない
          <span
            title={loadError}
            className="ml-3 truncate rounded border border-amber-400 bg-amber-50 px-2 py-0.5 text-[11px] font-bold text-amber-800"
          >
            ⚠ 既存の請求書番号を読めませんでした
          </span>
        )}
        {cmLoaded?.notice && (
          <span title={cmLoaded.notice} className="ml-3 truncate rounded border border-red-300 bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-700">
            ⚠ CM 指示単位数を反映できていません
          </span>
        )}
        {cmCap.capped && (
          <span className="ml-3 truncate rounded border border-orange-400 bg-orange-50 px-2 py-0.5 text-[11px] font-bold text-orange-800">
            CM 指示単位数で頭打ち (保険外 {outsideAmount.toLocaleString()} 円を含む)
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={handleSave} disabled={saving || loadingExisting}
            className="flex items-center gap-1.5 bg-white text-emerald-600 border border-emerald-300 hover:bg-emerald-50 px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50">
            {saving ? <Loader2 size={14} className="animate-spin" /> : (invoiceNumber !== null ? "再採番/更新" : "保存して採番")}
          </button>
          <button onClick={() => window.print()}
            className="flex items-center gap-1.5 bg-emerald-500 text-white px-4 py-2 rounded-xl text-sm font-medium">
            <Printer size={14} /> 印刷
          </button>
        </div>
      </div>

      {/* 帳票本体 */}
      <div className="flex-1 overflow-y-auto bg-gray-100">
        <div className="invoice-sheet mx-auto my-6 bg-white shadow-lg"
          style={{
            fontFamily: "'Hiragino Kaku Gothic ProN','Noto Sans JP','Yu Gothic','Meiryo',sans-serif",
            fontSize: "12px",
            lineHeight: "1.5",
            maxWidth: "794px",
            width: "794px",
            minHeight: "1123px",
            padding: "32px",
            color: "#111",
            boxSizing: "border-box",
          }}>

          {/* [0] タイトル帯 */}
          <div style={{
            background: "#d4ead7",
            border: "1px solid #374151",
            borderRadius: "14px",
            height: "48px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: "16px",
          }}>
            <h1 style={{ fontSize: "26px", fontWeight: "bold", color: "#111", letterSpacing: "0.15em", margin: 0 }}>
              {mode === "invoice" ? "利 用 料 請 求 書" : "利 用 料 領 収 書"}
            </h1>
          </div>

          {/* [1] 住所（左50%） ／ 自社情報（右50%） */}
          <div style={{ display: "flex", alignItems: "flex-start", marginBottom: "6px" }}>
            <div style={{ width: "50%", fontSize: "12px" }}>
              <p style={{ margin: "2px 0" }}>〒{postalCode ?? ""}</p>
              <p style={{ margin: "2px 0" }}>{client.address ?? ""}</p>
            </div>
            <div style={{ width: "50%", fontSize: "12px", textAlign: "left" }}>
              {/* 以前は指定事業所番号に T を付けて「登録番号」と印字していた (適格請求書の登録番号とは別物) */}
              {companyInfo.legalName && <p style={{ margin: "2px 0" }}>{companyInfo.legalName}</p>}
              <p style={{ margin: "2px 0", fontWeight: "bold" }}>{companyInfo.companyName}</p>
              {companyInfo.invoiceNumber && (
                <p style={{ margin: "2px 0" }}>登録番号：{/^T/i.test(companyInfo.invoiceNumber) ? companyInfo.invoiceNumber.toUpperCase() : `T${companyInfo.invoiceNumber}`}</p>
              )}
              <p style={{ margin: "2px 0" }}>{companyInfo.companyAddress}</p>
              <p style={{ margin: "2px 0" }}>TEL：{companyInfo.tel}　FAX：{companyInfo.fax}</p>
              <p style={{ margin: "4px 0 0", fontSize: "10px", color: "#555" }}>※ 押印は省略させていただきます。</p>
            </div>
          </div>

          {/* [2] 氏名（左50%・縦中央）／ 居宅介護支援事業者名・支払い者名テーブル（右50%） */}
          <div style={{ display: "flex", alignItems: "center", marginBottom: "0" }}>
            <div style={{ width: "50%", paddingLeft: "16px" }}>
              <p style={{
                fontSize: "24px",
                fontWeight: "bold",
                margin: 0,
              }}>
                {client.name}&nbsp;様
              </p>
            </div>
            <div style={{ width: "50%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <colgroup>
                  <col style={{ width: "50%" }} />
                  <col style={{ width: "50%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>居宅介護支援事業者名</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>支払い者名</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{client.care_manager_org ?? ""}</td>
                    <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{client.name}&nbsp;様</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* [3] 利用者氏名・発行日テーブル（全幅） */}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "10px" }}>
            <colgroup>
              <col style={{ width: "25%" }} />
              <col style={{ width: "50%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "10%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>利用者氏名</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", height: "28px" }} />
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", fontWeight: "bold", textAlign: "center", height: "28px" }}>{dateLabel}</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 12px", height: "28px" }} />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{client.name}&nbsp;様</td>
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 12px", height: "28px" }}>{issuedDateJa}</td>
              </tr>
            </tbody>
          </table>

          {/* [4] 注記文 */}
          <div style={{ fontSize: "13px", marginBottom: "6px" }}>
            {mode === "invoice" ? "下記の通り請求いたします。" : "下記の内容について、領収いたしました。"}
          </div>

          {/* [5+6] 期間表示（左）＋ 請求額ボックス（右）を同一行に */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "12px" }}>
            <div style={{ fontSize: "14px", fontWeight: "bold", paddingBottom: "4px" }}>
              {eraYM}分
              {periodInfo.firstDay && periodInfo.lastDay && (
                <span style={{ marginLeft: "16px" }}>
                  期間： {m}月{periodInfo.firstDay}日〜{m}月{periodInfo.lastDay}日
                </span>
              )}
            </div>
            <div style={{ width: "190px", border: "1px solid #374151" }}>
              <div style={{
                background: "#a3d5b2",
                color: "#fff",
                textAlign: "center",
                fontSize: "12px",
                padding: "4px 8px",
                fontWeight: "bold",
              }}>
                {amountLabel}
              </div>
              <div style={{
                background: "#fff",
                textAlign: "right",
                fontSize: "24px",
                fontWeight: "bold",
                padding: "6px 12px",
                color: "#111",
              }}>
                ¥{copayAmount.toLocaleString()}
              </div>
            </div>
          </div>

          {/* [7] 利用内訳テーブル（全幅・4列） */}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "16px" }}>
            <colgroup>
              <col style={{ width: "55%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "15%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>利用内訳</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>単価</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>数量</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>金　額</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }}>福祉用具貸与</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{insuranceCopay.toLocaleString()}</td>
              </tr>
              {outsideAmount > 0 && (
                <tr>
                  <td style={{ border: "1px solid #374151", padding: "6px 8px" }}>福祉用具貸与 保険外 (ケアプランの単位数を超えた分・全額自己負担)</td>
                  <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>10</td>
                  <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{cmCap.overUnits.toLocaleString()}単位</td>
                  <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{outsideAmount.toLocaleString()}</td>
                </tr>
              )}
              <tr>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px", paddingLeft: "32px", fontSize: "11px", color: "#333" }}>
                  　　課税分　{taxableCopay.toLocaleString()}円
                </td>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px dashed #9ca3af", padding: "4px 8px" }} />
              </tr>
              <tr>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px", paddingLeft: "32px", fontSize: "11px", color: "#333" }}>
                  　　非課税分　{nonTaxableCopay.toLocaleString()}円
                </td>
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px" }} />
                <td style={{ borderLeft: "1px solid #374151", borderRight: "1px solid #374151", borderTop: "1px dashed #9ca3af", borderBottom: "1px solid #374151", padding: "4px 8px" }} />
              </tr>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", fontWeight: "bold" }}>合計</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{copayAmount.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          {/* [8] 下段2カラム：介護サービス費内訳（左65%） ／ ご利用日カレンダー（右35%） */}
          <div style={{ display: "flex", gap: "12px", alignItems: "flex-start", marginBottom: "16px" }}>
            <div style={{ width: "65%" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <colgroup>
                  <col style={{ width: "55%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>介護サービス費内訳</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>単位数</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>回数</th>
                    <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>単位</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map((r) => (
                    <tr key={r.item.id}>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px" }}>{r.eqName}</td>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{r.units.toLocaleString()}</td>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{r.quantity}</td>
                      <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{r.totalUnits.toLocaleString()}単位</td>
                    </tr>
                  ))}
                  {detailRows.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "center", color: "#888" }}>
                        対象月の明細はありません
                      </td>
                    </tr>
                  )}
                  <tr>
                    <td style={{ border: "1px solid #374151", padding: "6px 8px", fontWeight: "bold" }}>合計</td>
                    <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                    <td style={{ border: "1px solid #374151", padding: "6px 8px" }} />
                    <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{totalUnits.toLocaleString()}単位</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div style={{ width: "35%", border: "1px solid #374151", padding: "6px" }}>
              <div style={{ textAlign: "center", fontSize: "13px", fontWeight: "bold", marginBottom: "4px" }}>ご利用日</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "10px", tableLayout: "fixed" }}>
                <thead>
                  <tr>
                    {DOW.map((d, idx) => (
                      <th key={d} style={{
                        border: "1px solid #374151",
                        padding: "2px 0",
                        textAlign: "center",
                        fontWeight: "bold",
                        color: idx === 0 ? "#ef4444" : idx === 6 ? "#3b82f6" : "#333",
                        width: `${100 / 7}%`,
                        height: "20px",
                      }}>{d}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const cells: React.ReactNode[] = [];
                    const rows: React.ReactNode[] = [];
                    for (let i = 0; i < firstDow; i++) {
                      cells.push(<td key={`e${i}`} style={{ border: "1px solid #374151", height: "22px" }} />);
                    }
                    for (let d = 1; d <= daysInMonth; d++) {
                      const dow = (firstDow + d - 1) % 7;
                      const isBill = periodInfo.billingDays.has(d);
                      const isStart = startDayMark.has(d);
                      const isEnd = endDayMark.has(d);
                      const hasMark = isStart || isEnd || isBill;
                      const mark = isStart || isEnd ? "□" : isBill ? "○" : "";
                      const color = dow === 0 ? "#ef4444" : dow === 6 ? "#3b82f6" : "#333";
                      cells.push(
                        <td key={d} style={{
                          border: "1px solid #374151",
                          padding: 0,
                          height: "22px",
                          width: "22px",
                          textAlign: "center",
                          color,
                          verticalAlign: "middle",
                          position: "relative",
                          lineHeight: "1",
                        }}>
                          <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
                            <span style={{ fontSize: "10px", position: "relative", zIndex: 1 }}>{d}</span>
                            {hasMark && (
                              <span style={{
                                position: "absolute",
                                top: "50%",
                                left: "50%",
                                transform: "translate(-50%, -50%)",
                                fontSize: "16px",
                                fontWeight: "normal",
                                color,
                                zIndex: 0,
                                lineHeight: "1",
                              }}>{mark}</span>
                            )}
                          </div>
                        </td>
                      );
                      if (cells.length === 7) {
                        rows.push(<tr key={`r${d}`}>{cells.splice(0)}</tr>);
                      }
                    }
                    if (cells.length > 0) {
                      while (cells.length < 7) {
                        cells.push(<td key={`t${cells.length}`} style={{ border: "1px solid #374151", height: "22px" }} />);
                      }
                      rows.push(<tr key="rlast">{cells}</tr>);
                    }
                    return rows;
                  })()}
                </tbody>
              </table>
              <p style={{ fontSize: "9px", color: "#333", margin: "4px 0 0", lineHeight: "1.3" }}>
                ○：介護サービス算定日<br />
                □：サービス利用開始・終了日
              </p>
            </div>
          </div>

          {/* [9] 消費税内訳テーブル（全幅・3列） */}
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", marginBottom: "16px" }}>
            <colgroup>
              <col style={{ width: "60%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "20%" }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>消費税内訳</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>消費税対象額</th>
                <th style={{ border: "1px solid #374151", background: "#d4ead7", padding: "6px 8px", textAlign: "center", fontWeight: "bold" }}>消費税額</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px" }}>10％対象</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{taxableBase.toLocaleString()}</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{taxAmount.toLocaleString()}</td>
              </tr>
              <tr>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", fontWeight: "bold" }}>合計</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{taxableBase.toLocaleString()}</td>
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right", fontWeight: "bold" }}>{taxAmount.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>

          {/* [10] フッタ：右下の番号 */}
          <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "12px", fontSize: "10px", color: "#333", marginTop: "24px" }}>
            <span>{displayNumber}</span>
            <span>[1枚中1枚目]</span>
          </div>
        </div>
      </div>
    </div>
  );
}
