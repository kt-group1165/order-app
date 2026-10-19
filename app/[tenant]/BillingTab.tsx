"use client";

import { useState, useEffect, useRef, useMemo, useTransition, memo } from "react";
import dynamic from "next/dynamic";
import { ChevronRight, ChevronLeft, X, Loader2, Printer, Download } from "lucide-react";
import { supabase, Order, OrderItem, Equipment, Client, Supplier, EquipmentPriceHistory, ClientInsuranceRecord, ClientHospitalization } from "@/lib/supabase";
import { monthEndYmd, toJapaneseEra, toJapaneseEraYM } from "@/lib/date-jst";
import { type CompanyInfo, COMPANY_INFO_DEFAULTS } from "./company-info";
import { getOfficeCompanyInfo } from "@/lib/officeCompanyInfo";
import { HW_KANA } from "./search-utils";
import { calcMonthUnits, hasBrokenRentalDates, isKeidoRestricted, RESTRICTION_GROUP_OF_CATEGORY } from "./order-item-helpers";
import { getExceptionGrants, hasActiveGrant, isTableMissingError } from "@/lib/fukuyoguExceptions";
import { halfMonthUnits } from "@/lib/half-month-units";
import { getAllOrders, getAllOrderItemsByTenant } from "@/lib/orders";
import { getEquipment, getSuppliers, getPriceHistory, getPriceForMonth } from "@/lib/equipment";
import { getClients } from "@/lib/clients";
import { getTenantById } from "@/lib/tenants";
import { getOffices, type Office } from "@/lib/offices";
import {
  getLateFlags, setLateFlag, removeLateFlag,
  getUnitOverrides, setUnitOverride, removeUnitOverride,
  getRebillFlags, setRebillFlag, removeRebillFlag,
  type BillingLateFlag, type BillingRebillFlag,
} from "@/lib/billing";
import { getCareOffices, type CareOffice } from "@/lib/careOffices";
import Encoding from "encoding-japanese";
import { buildFukuyoguDensou, fukuyoguServiceCode, type FukuyoguSeikyuRow, type FukuyoguDetailLine } from "@/lib/kokuho-densou/build";
import { computeFukuyoguAmounts } from "@/lib/kokuho-densou/fukuyogu-amounts";
import { findRentalOverruns, indexCeilings, type CeilingRentalLine } from "@/lib/ceilingCheck";
import { getCeilingPrices } from "@/lib/ceilingPrices";
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
}: {
  tenantId: string;
  currentOfficeId: string | null;
  clients: Client[];
  insuranceRecords: ClientInsuranceRecord[];
  orderItems: OrderItem[];
  orders: Order[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
  careOffices: CareOffice[];
  dataLoading: boolean;
  priceHistory: EquipmentPriceHistory[];
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
  const getActiveInsuranceRecord = (clientId: string): ClientInsuranceRecord | null => {
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

  // 当月の単位数集計 (簡易版: 入院半月判定を含む)
  const computeMonthlyUnits = (clientId: string): number => {
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    const daysInMonth = new Date(y, m, 0).getDate();
    const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const clientOrderIds = new Set(orders.filter((o) => o.client_id === clientId).map((o) => o.id));
    const clientHosp = hospitalizations.filter((h) => h.client_id === clientId);

    let total = 0;
    for (const item of orderItems) {
      if (!clientOrderIds.has(item.order_id)) continue;
      const pt = item.payment_type ?? orders.find((o) => o.id === item.order_id)?.payment_type ?? "介護";
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
        const eq = equipment.find((e) => e.product_code === item.product_code);
        // ⚠ 価格改定があれば当月時点の価格を使う (equipment.rental_price は現在価格なので
        //   過去月を見ているときは食い違いうる)。InvoiceReceiptModal と同じ経路。
        const price = getPriceForMonth(priceHistory, item.product_code, billingMonth) ?? eq?.rental_price ?? 0;
        const base = price ? Math.round(price / 10) : 0;
        const rentalStart = parseLocalDate(item.rental_start_date);
        const rentalEnd = item.rental_end_date ? parseLocalDate(item.rental_end_date) : monthEnd;
        let firstHalf = false, secondHalf = false;
        for (let d = 1; d <= daysInMonth; d++) {
          const date = new Date(y, m - 1, d);
          if (date < rentalStart || date > rentalEnd) continue;
          const inHosp = clientHosp.some((h) => {
            const admit = parseLocalDate(h.admission_date);
            const discharge = h.discharge_date ? parseLocalDate(h.discharge_date) : monthEnd;
            return date >= admit && date <= discharge;
          });
          if (!inHosp) {
            if (d <= 15) firstHalf = true; else secondHalf = true;
          }
        }
        units = halfMonthUnits(base, firstHalf, secondHalf);
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
      const order = orders.find((o) => o.id === item.order_id);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- ins/careOffice/units 集計は state 依存だが意図的に billingMonth + unitOverrides 切替時にだけ recompute
  }, [clients, orderItems, orders, billingMonth, unitOverrides, currentOfficeId, careOffices, insuranceRecords, hospitalizations, equipment]);

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
          <table className="min-w-full text-xs border-collapse">
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
                  <td className="px-2 py-1 border border-gray-200">{ins?.insurer_name ?? client.care_manager_org ?? "-"}</td>
                  <td className="px-2 py-1 border border-gray-200 font-mono">{ins?.insured_number ?? client.insured_number ?? "-"}</td>
                  <td className="px-2 py-1 border border-gray-200">{client.name}</td>
                  <td className="px-2 py-1 border border-gray-200 font-mono">{client.user_number ?? "-"}</td>
                  <td className="px-2 py-1 border border-gray-200">居宅介護支援事業者作成</td>
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

export default function BillingTab({ tenantId, currentOfficeId }: { tenantId: string; currentOfficeId: string | null }) {
  // サブタブ: 月次情報 / 介護請求 / 利用請求 / 売上帳票
  const [subTab, setSubTab] = useState<BillingSubTab>("monthly");
  const [clients, setClients] = useState<Client[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tenantInfo, setTenantInfo] = useState<import("@/lib/tenants").Tenant | null>(null);
  const [offices, setOffices] = useState<Office[]>([]);
  const [insuranceRecords, setInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [hospitalizations, setHospitalizations] = useState<ClientHospitalization[]>([]);
  const [priceHistoryAll, setPriceHistoryAll] = useState<EquipmentPriceHistory[]>([]);
  const [careOffices, setCareOffices] = useState<CareOffice[]>([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [invoiceClient, setInvoiceClient] = useState<Client | null>(null);

  // 会社情報（請求書／領収書モーダル用）
  // 請求書・領収書の会社欄: 事業所ごとの設定 > 事業所・法人マスタ > グループ共通 (lib/officeCompanyInfo.ts)
  const [companyInfoForDoc, setCompanyInfoForDoc] = useState<CompanyInfo>(COMPANY_INFO_DEFAULTS);
  useEffect(() => {
    let cancelled = false;
    getOfficeCompanyInfo(tenantId, currentOfficeId)
      .then((r) => { if (!cancelled) setCompanyInfoForDoc(r.info); })
      .catch((e) => console.error("会社情報の取得に失敗:", e instanceof Error ? e.message : e));
    return () => { cancelled = true; };
  }, [tenantId, currentOfficeId]);

  useEffect(() => {
    // BillingTab は currentOfficeId 単独 (officeViewAll 概念無し)
    // PostgREST default limit 1000 を超えるテーブル (insurance_records 8370 件等) は必ずページング
    const fetchAllPaged = async <T,>(table: string): Promise<T[]> => {
      const PAGE = 1000;
      const all: T[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase.from(table).select("*").eq("tenant_id", tenantId).range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        all.push(...(data as T[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return all;
    };
    Promise.all([
      getClients(tenantId, { officeId: currentOfficeId ?? undefined }),
      getEquipment(tenantId),
      getAllOrderItemsByTenant(tenantId),
      getAllOrders(tenantId, currentOfficeId),
      getTenantById(tenantId),
      getOffices(tenantId),
      fetchAllPaged<ClientInsuranceRecord>("client_insurance_records"),
      fetchAllPaged<ClientHospitalization>("client_hospitalizations"),
      getCareOffices(tenantId),
    ]).then(([c, eq, items, ords, tenant, offs, insRaw, hospRaw, coffs]) => {
      setClients(c);
      setEquipment(eq);
      setOrderItems(items);
      setOrders(ords);
      setTenantInfo(tenant);
      setOffices(offs);
      setInsuranceRecords(insRaw as ClientInsuranceRecord[]);
      setHospitalizations(hospRaw as ClientHospitalization[]);
      setCareOffices(coffs as CareOffice[]);
      // 価格履歴は全 product_code 分を取得（請求書／領収書モーダルで使用）
      const codes = [...new Set(items.map((i: OrderItem) => i.product_code))];
      if (codes.length > 0) {
        getPriceHistory(tenantId, codes).then(setPriceHistoryAll).catch((err) => {
          console.warn("getPriceHistory failed:", err);
        });
      }
    }).catch(console.error).finally(() => setDataLoading(false));
  }, [tenantId, currentOfficeId]);
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

  // 月遅れ自動判定：保険証のcertification_statusが「申請中」の利用者
  const autoLateClients = useMemo(() => {
    const [y, m] = billingMonth.split("-").map(Number);
    const monthStart = `${billingMonth}-01`;
    const monthEnd = monthEndYmd(y, m);
    const lateSet = new Set<string>();
    for (const client of clients) {
      const recs = insuranceRecords
        .filter(r => r.client_id === client.id)
        .sort((a, b) => (b.effective_date ?? "").localeCompare(a.effective_date ?? ""));
      const rec = recs.find(r => {
        const start = r.certification_start_date ?? r.effective_date;
        const end = r.certification_end_date;
        if (start && start > monthEnd) return false;
        if (end && end < monthStart) return false;
        return true;
      });
      if (rec?.certification_status === "申請中") lateSet.add(client.id);
    }
    return lateSet;
  }, [insuranceRecords, clients, billingMonth]);

  // 当月アクティブレンタルを取得
  const activeRentals = useMemo(() => {
    const [y, m] = billingMonth.split("-").map(Number);
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    return orderItems.filter((item) => {
      const pt = item.payment_type ?? orders.find((o) => o.id === item.order_id)?.payment_type ?? "介護";
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, [billingMonth, orderItems]);

  // 利用者ごとにグループ化（事業所フィルタ付き）
  const clientGroups = useMemo(() => {
    const map = new Map<string, { client: Client; items: OrderItem[] }>();
    for (const item of activeRentals) {
      const order = orders.find((o) => o.id === item.order_id);
      // 事業所が選択されている場合、その事業所の注文のみ
      if (currentOfficeId && order?.office_id && order.office_id !== currentOfficeId) continue;
      if (!order?.client_id) continue;
      const client = clients.find((c) => c.id === order.client_id);
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional dep stability
  }, [activeRentals, orders, clients]);

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

  const getUnits = (item: OrderItem, clientId: string) => {
    if (unitOverrides.has(item.id)) return unitOverrides.get(item.id)!;
    const eq = equipment.find((e) => e.product_code === item.product_code);
    // ⚠ 価格改定があれば当月時点の価格を使う (2026-09-04 是正: 以前は equipment.rental_price
    //   = 現在価格を直参照しており、価格改定後に過去月ぶんを組むと現在価格で計算されていた)。
    const price = getPriceForMonth(priceHistoryAll, item.product_code, billingMonth) ?? eq?.rental_price ?? 0;
    const base = price ? Math.round(price / 10) : 0;
    // 入院による半月判定
    const [y, m] = billingMonth.split("-").map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const monthEnd = new Date(y, m, 0, 23, 59, 59);
    const clientHosp = hospitalizations.filter(h => h.client_id === clientId);
    // 貸与期間のうち入院でない日をカウント（タイムゾーン問題を避けるため文字列分割でパース）
    const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const rentalStart = item.rental_start_date ? parseLocalDate(item.rental_start_date) : null;
    const rentalEnd = item.rental_end_date ? parseLocalDate(item.rental_end_date) : monthEnd;
    if (!rentalStart) return base;
    let firstHalf = false, secondHalf = false;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m - 1, d);
      if (date < rentalStart || date > rentalEnd) continue;
      const inHosp = clientHosp.some(h => {
        const admit = parseLocalDate(h.admission_date);
        const discharge = h.discharge_date ? parseLocalDate(h.discharge_date) : monthEnd;
        return date >= admit && date <= discharge;
      });
      if (!inHosp) {
        if (d <= 15) firstHalf = true; else secondHalf = true;
      }
    }
    return halfMonthUnits(base, firstHalf, secondHalf);
  };

  // 指定年月(ym="YYYY-MM")での単位数計算 (返戻・過誤の過去月伝送用)。
  // getUnits の billingMonth 依存を外した版。過去月は単位上書きを読まない(未ロードのため)。
  const computeUnitsForMonth = (item: OrderItem, clientId: string, ym: string): number => {
    const eq = equipment.find((e) => e.product_code === item.product_code);
    // ⚠ 過去月 (返戻・過誤の再伝送) を組むので、当時の価格改定を必ず反映する。
    const price = getPriceForMonth(priceHistoryAll, item.product_code, ym) ?? eq?.rental_price ?? 0;
    const base = price ? Math.round(price / 10) : 0;
    const [yy, mm] = ym.split("-").map(Number);
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const monthEnd = new Date(yy, mm, 0, 23, 59, 59);
    const clientHosp = hospitalizations.filter((h) => h.client_id === clientId);
    const parseLocalDate = (s: string) => { const [py, pm, pd] = s.split("-").map(Number); return new Date(py, pm - 1, pd); };
    const rentalStart = item.rental_start_date ? parseLocalDate(item.rental_start_date) : null;
    const rentalEnd = item.rental_end_date ? parseLocalDate(item.rental_end_date) : monthEnd;
    if (!rentalStart) return base;
    let firstHalf = false, secondHalf = false;
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(yy, mm - 1, d);
      if (date < rentalStart || date > rentalEnd) continue;
      const inHosp = clientHosp.some((h) => {
        const admit = parseLocalDate(h.admission_date);
        const discharge = h.discharge_date ? parseLocalDate(h.discharge_date) : monthEnd;
        return date >= admit && date <= discharge;
      });
      if (!inHosp) { if (d <= 15) firstHalf = true; else secondHalf = true; }
    }
    return halfMonthUnits(base, firstHalf, secondHalf);
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- intentional placeholder / future use
  const handleUnitOverride = async (clientId: string, item: OrderItem, value: string) => {
    const n = parseInt(value, 10);
    const eq = equipment.find((e) => e.product_code === item.product_code);
    const autoUnits = eq?.rental_price ? Math.round(eq.rental_price / 10) : 0;
    if (!value || isNaN(n) || n === autoUnits) {
      await removeUnitOverride(tenantId, clientId, billingMonth, item.id);
      setUnitOverridesState((prev) => { const m = new Map(prev); m.delete(item.id); return m; });
    } else {
      await setUnitOverride(tenantId, clientId, billingMonth, item.id, n);
      setUnitOverridesState((prev) => new Map(prev).set(item.id, n));
    }
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
  const generateTransferData = async () => {
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

    // 公費 (生保 等) 情報を当月分だけ取得。生保(法別12)は本人負担を公費が全額負担する前提 (v1)。
    const monthStart = `${billingMonth}-01`;
    const monthEnd = monthEndYmd(y, m);
    const kohiByClient = new Map<string, { hobetsu: string; futansha: string | null; jukyusha: string | null }>();
    {
      const clientIds = billingGroups.map((g) => g.client.id);
      const { data: kohiData, error: kohiErr } = await supabase
        .from("client_public_expenses")
        .select("client_id, hohei_code, futan_sha_number, jukyu_sha_number, valid_start, valid_end")
        .eq("tenant_id", tenantId)
        .in("client_id", clientIds);
      if (kohiErr) {
        console.error("公費取得失敗:", kohiErr.message);
        alert(`公費情報の取得に失敗しました: ${kohiErr.message}`);
        return;
      }
      for (const k of kohiData ?? []) {
        if (!k.hohei_code) continue;
        if (k.valid_start && k.valid_start > monthEnd) continue;
        if (k.valid_end && k.valid_end < monthStart) continue;
        if (!kohiByClient.has(k.client_id)) {
          kohiByClient.set(k.client_id, { hobetsu: k.hohei_code, futansha: k.futan_sha_number, jukyusha: k.jukyu_sha_number });
        }
      }
    }

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
    try {
      ceilingIndex = indexCeilings(await getCeilingPrices(tenantId));
    } catch (e) {
      preWarnings.push(`上限価格マスタを読めなかったため上限超過の確認をしていません: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 明細行 → 利用者ごとの請求行を組む
    const rows: FukuyoguSeikyuRow[] = [];
    for (const { client, items } of billingGroups) {
      const details: FukuyoguDetailLine[] = [];
      const ceilingLines: (CeilingRentalLine & { name: string })[] = [];
      let totalUnits = 0;
      for (const item of items) {
        const eq = equipment.find((e) => e.product_code === item.product_code);
        const unitPer = getUnits(item, client.id);
        const count = item.quantity;
        const units = unitPer * count;
        if (units <= 0) continue;
        // ⚠ 終了日 < 開始日 のとき calcMonthUnits は **満額を返して請求に載せる**。
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
        details.push({ serviceCode: code, unitPer, count, units });
        totalUnits += units;
        ceilingLines.push({
          id: item.id,
          name: eq?.name ?? item.product_code,
          taisCode: eq?.tais_code,
          // 上限と比べるのは 月額 (半月按分前)。getUnits と同じく当月時点の改定価格 → マスタ価格
          price: getPriceForMonth(priceHistoryAll, item.product_code, billingMonth) ?? eq?.rental_price ?? null,
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
        benefitRateRaw: client.benefit_rate,
        insuredNumber: client.insured_number,
        totalUnits,
        kohi,
      });
      for (const w of amt.warnings) preWarnings.push(`${client.name}: ${w}`);
      const { copayRate, totalCost, insuranceAmount, userAmount, kohiAmount } = amt;
      const careOffice = client.care_office_id
        ? careOffices.find((co) => co.id === client.care_office_id) ?? null
        : null;
      rows.push({
        userName: client.name,
        insurerNumber: client.insurer_number,
        // 2026-08-31 監査: `?? client.user_number` で**社内の利用者番号**にフォールバック
        //   していた。無関係な番号で請求/実績が立ち、しかも build.ts の
        //   `if (!insured) warnings.push(...)` が user_number で埋まって発火しない
        //   = 完全な silent failure。実測で insured_number が空の client は 1,047 名。
        //   空のまま渡して警告を出させる (返戻にはなるが、誤った番号で通るより良い)。
        insuredNumber: client.insured_number ?? null,
        birthDate: client.birth_date,
        gender: client.gender,
        careLevel: client.care_level,
        certStart: client.certification_start_date,
        certEnd: client.certification_end_date,
        careOfficeNumber: careOffice?.office_number ?? null,
        copayRate,
        details,
        totalUnits,
        totalCost,
        insuranceAmount,
        userAmount,
        kohiHobetsu: amt.kohiHobetsu,
        kohiFutansha: kohi?.futansha ?? null,
        kohiJukyusha: kohi?.jukyusha ?? null,
        kohiAmount,
        kohiTandoku: amt.kohiTandoku,
      });
    }

    if (rows.length === 0) {
      alert("対象月に国保連請求対象の福祉用具貸与がありません。");
      return;
    }

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
        ? careOffices.find((co) => co.id === client.care_office_id) ?? null
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
        const eq = equipment.find((e) => e.product_code === item.product_code);
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
    const result = new Map<string, Array<{ client: Client; items: OrderItem[]; flag: BillingRebillFlag }>>();
    for (const flag of rebillFlags.values()) {
      if (flag.month === billingMonth) continue;
      const client = clients.find((c) => c.id === flag.client_id);
      if (!client) continue;
      const [y, m] = flag.month.split("-").map(Number);
      const monthStart = new Date(y, m - 1, 1);
      const monthEnd = new Date(y, m, 0, 23, 59, 59);
      const items = orderItems.filter((item) => {
        const order = orders.find((o) => o.id === item.order_id);
        if (order?.client_id !== client.id) return false;
        const pt = item.payment_type ?? orders.find((o) => o.id === item.order_id)?.payment_type ?? "介護";
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
  }, [rebillFlags, billingMonth, orderItems, orders, clients]);

  // 返戻・過誤の過去月別 伝送ファイル生成 (サービス提供年月ごとに 1 ファイル)。
  // 返戻=補正して再請求 / 過誤=取下げ後の再請求。いずれも当該月の通常請求として出力する
  // (過誤の取下げ(取消)処理自体は国保連側の別手続き)。
  const generateRebillTransferData = async () => {
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
      const { data: kohiData, error: kohiErr } = await supabase
        .from("client_public_expenses")
        .select("client_id, hohei_code, futan_sha_number, jukyu_sha_number, valid_start, valid_end")
        .eq("tenant_id", tenantId)
        .in("client_id", clientIds);
      if (kohiErr) {
        console.error("公費取得失敗:", kohiErr.message);
        alert(`公費情報の取得に失敗しました: ${kohiErr.message}`);
        return;
      }
      const kohiByClient = new Map<string, { hobetsu: string; futansha: string | null; jukyusha: string | null }>();
      for (const k of kohiData ?? []) {
        if (!k.hohei_code) continue;
        if (k.valid_start && k.valid_start > monthEnd) continue;
        if (k.valid_end && k.valid_end < monthStart) continue;
        if (!kohiByClient.has(k.client_id)) {
          kohiByClient.set(k.client_id, { hobetsu: k.hohei_code, futansha: k.futan_sha_number, jukyusha: k.jukyu_sha_number });
        }
      }
      const rows: FukuyoguSeikyuRow[] = [];
      for (const { client, items } of entries) {
        const details: FukuyoguDetailLine[] = [];
        let totalUnits = 0;
        for (const item of items) {
          const eq = equipment.find((e) => e.product_code === item.product_code);
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
          details.push({ serviceCode: code, unitPer, count, units });
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
          benefitRateRaw: client.benefit_rate,
          insuredNumber: client.insured_number,
          totalUnits,
          kohi,
        });
        for (const w of amt.warnings) allWarnings.push(`[${ym}] ${client.name}: ${w}`);
        const { copayRate, totalCost, insuranceAmount } = amt;
        const careOffice = client.care_office_id
          ? careOffices.find((co) => co.id === client.care_office_id) ?? null
          : null;
        rows.push({
          userName: client.name,
          insurerNumber: client.insurer_number,
          // 2026-08-31 監査: `?? client.user_number` で**社内の利用者番号**にフォールバック
          //   していた。無関係な番号で請求/実績が立ち、しかも build.ts の
          //   `if (!insured) warnings.push(...)` が user_number で埋まって発火しない
          //   = 完全な silent failure。実測で insured_number が空の client は 1,047 名。
          //   空のまま渡して警告を出させる (返戻にはなるが、誤った番号で通るより良い)。
          insuredNumber: client.insured_number ?? null,
          birthDate: client.birth_date,
          gender: client.gender,
          careLevel: client.care_level,
          certStart: client.certification_start_date,
          certEnd: client.certification_end_date,
          careOfficeNumber: careOffice?.office_number ?? null,
          copayRate,
          details,
          totalUnits,
          totalCost,
          insuranceAmount,
          userAmount: amt.userAmount,
          kohiHobetsu: amt.kohiHobetsu,
          kohiFutansha: kohi?.futansha ?? null,
          kohiJukyusha: kohi?.jukyusha ?? null,
          kohiAmount: amt.kohiAmount,
          kohiTandoku: amt.kohiTandoku,
        });
      }
      if (rows.length === 0) continue;
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
  const guardedSetSubTab = (id: BillingSubTab) => { if (confirmLeave()) setSubTab(id); };

  const [detailClient, setDetailClient] = useState<{ client: Client; items: OrderItem[] } | null>(null);
  const [rentalGridClient, setRentalGridClient] = useState<{ client: Client; items: OrderItem[] } | null>(null);
  const [kanaFilter, setKanaFilter] = useState<string | null>(null);
  const [kokuhoOnly, setKokuhoOnly] = useState(true); // true=国保連提出対象(月遅れ除く)のみ / false=全件
  const [showRentalGridView, setShowRentalGridView] = useState(false);
  const [gridSelectedClient, setGridSelectedClient] = useState<{ client: Client; items: OrderItem[] } | null>(null);
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

  // 国保対象フィルタ: ON なら月遅れ(自動+手動)の当月行を除外。再請求(過去月)行は国保連提出対象なので常に残す。
  const displayRows = kokuhoOnly
    ? allRows.filter((r) => r.type === "rebill" || !(autoLateClients.has(r.client.id) || lateFlags.has(r.client.id)))
    : allRows;

  if (subTab === "sales") {
    return (
      <div className="flex flex-col h-full bg-white text-sm">
        <BillingSubTabNav active={subTab} onChange={setSubTab} />
        <SalesReportTab
          tenantId={tenantId}
          clients={clients}
          orderItems={orderItems}
          orders={orders}
          equipment={equipment}
          currentOfficeId={currentOfficeId}
        />
      </div>
    );
  }

  if (subTab === "monthly") {
    return (
      <div className="flex flex-col h-full bg-white text-sm">
        <BillingSubTabNav active={subTab} onChange={setSubTab} />
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
        />
      </div>
    );
  }

  if (subTab === "user") {
    return (
      <div className="flex flex-col h-full bg-white text-sm">
        <BillingSubTabNav active={subTab} onChange={setSubTab} />
        <UserBillingTab
          tenantId={tenantId}
          currentOfficeId={currentOfficeId}
          clients={clients}
          orderItems={orderItems}
          orders={orders}
          equipment={equipment}
          insuranceRecords={insuranceRecords}
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
        <button className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">明細書</button>
        <button className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">請求書</button>
        <button
          onClick={() => setKokuhoOnly(v => !v)}
          title="国保連提出対象(月遅れを除く)のみ表示 ⇔ 全件表示 を切替"
          className={`border rounded px-2.5 py-1 font-semibold transition-colors ${kokuhoOnly ? "border-blue-500 bg-blue-100 text-blue-800" : "border-gray-400 bg-white text-gray-700 hover:bg-gray-50"}`}
        >{kokuhoOnly ? "国保対象のみ" : "全件表示"}</button>
        <button className="border border-gray-400 rounded bg-white px-2.5 py-1 text-gray-700 hover:bg-gray-50">管理帳票</button>
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
        <div className="ml-auto flex items-center gap-2">
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
            <button onClick={generateRebillTransferData}
              title="返戻・過誤の対象をサービス提供年月ごとに 1 ファイルずつ出力"
              className="border border-orange-500 rounded bg-orange-50 px-3 py-1 text-orange-700 font-semibold hover:bg-orange-100 flex items-center gap-1.5">
              <Download size={13} />返戻過誤 伝送({rebillByMonth.length}月分)
            </button>
          )}
          <button onClick={generateCareplanJissekiCsv}
            title="ケアプランデータ連携 V4.1 の第6表実績 (UPJSK) を担当居宅事業所ごとに出力"
            className="border border-teal-500 rounded bg-teal-50 px-3 py-1 text-teal-700 font-semibold hover:bg-teal-100 flex items-center gap-1.5">
            <Download size={13} />ケアプラン連携
          </button>
          <button onClick={generateTransferData}
            className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5">
            <Download size={13} />CSV出力
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
            <div className="grid grid-cols-[32px_64px_72px_60px_60px_180px_104px_1fr_64px_72px_44px] border-b border-gray-300 bg-gray-100 text-xs font-semibold text-gray-600 sticky top-0 z-10">
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
              <div className="px-2 py-2 border-l border-gray-200">サービス事業所</div>
              <div className="px-2 py-2 border-l border-gray-200">被保険者番号</div>
              <div className="px-2 py-2 border-l border-gray-200">利用者名</div>
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
                      className="grid grid-cols-[32px_64px_72px_60px_60px_180px_104px_1fr_64px_72px_44px] border-b border-gray-100 bg-amber-50 text-xs">
                      <div className="px-1 py-2" />
                      <div className="px-2 py-2 border-l border-gray-100" />
                      <div className="px-2 py-2 border-l border-gray-100 text-amber-700 font-medium">再請求</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">R{ry-2018}/{rm}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500">R{y-2018}/{m}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-500 truncate">—</div>
                      <div className="px-2 py-2 border-l border-gray-100 font-mono text-gray-500">{row.client.user_number ?? "—"}</div>
                      <div className="px-2 py-2 border-l border-gray-100 text-gray-700 font-medium truncate">{row.client.name}</div>
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
                const isAutoLate = autoLateClients.has(client.id);
                const lateFlag = lateFlags.get(client.id);
                const isLate = isAutoLate || !!lateFlag;
                const flag = rebillFlags.get(`${client.id}-${billingMonth}`);
                const isSelected = selectedClientIds.has(client.id);
                const isDetail = detailClient?.client.id === client.id;
                // 申請中バッジ
                const monthStart = `${billingMonth}-01`;
                const monthEnd = monthEndYmd(y, m);
                const insRecs = insuranceRecords
                  .filter(r => r.client_id === client.id)
                  .sort((a, b) => (b.effective_date ?? "").localeCompare(a.effective_date ?? ""));
                const insRec = insRecs.find(r => {
                  const start = r.certification_start_date ?? r.effective_date;
                  const end = r.certification_end_date;
                  if (start && start > monthEnd) return false;
                  if (end && end < monthStart) return false;
                  return true;
                });
                const isApplying = insRec?.certification_status === "申請中";
                // サービス事業所名 (居宅介護支援事業所)
                const careOfficeId = client.care_office_id ?? insRec?.care_office_id ?? null;
                const careOfficeName = careOfficeId
                  ? careOffices.find(co => co.id === careOfficeId)?.name ?? ""
                  : client.care_manager_org ?? "";
                // 提出月 = lateFlag.month があればそれ、無ければ billingMonth
                const submitMonth = lateFlag?.month ?? billingMonth;
                const [sy, sm] = submitMonth.split("-").map(Number);
                return (
                  <div
                    key={client.id}
                    onClick={() => setDetailClient(isDetail ? null : { client, items })}
                    className={`grid grid-cols-[32px_64px_72px_60px_60px_180px_104px_1fr_64px_72px_44px] border-b border-gray-100 text-xs cursor-pointer transition-colors ${
                      isDetail ? "bg-blue-100" : isLate ? "bg-yellow-50" : isSelected ? "bg-indigo-50" : idx % 2 === 0 ? "bg-white hover:bg-gray-50" : "bg-gray-50/50 hover:bg-gray-100"
                    }`}
                  >
                    <div className="px-1 py-2 flex items-center justify-center" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setSelectedClientIds(prev => {
                          const s = new Set(prev); if (s.has(client.id)) s.delete(client.id); else s.add(client.id); return s;
                        })}
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
                      <button
                        onClick={e => { e.stopPropagation(); setRentalGridClient({ client, items }); }}
                        className="shrink-0 text-[10px] border border-gray-300 rounded px-1.5 py-0.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                      >提供表</button>
                      <button
                        onClick={e => { e.stopPropagation(); setInvoiceClient(client); }}
                        className="shrink-0 text-[10px] border border-emerald-400 rounded px-1.5 py-0.5 text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-colors"
                      >請求書</button>
                    </div>
                    <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={e => e.stopPropagation()}>
                      <select
                        value={isLate ? "月遅" : ""}
                        disabled={isAutoLate}
                        onChange={() => toggleLateFlag(client.id)}
                        title={isAutoLate ? "保険証が申請中のため自動で月遅れ扱い(解除不可)" : "月遅れ"}
                        className={`w-full text-[11px] border rounded px-0.5 py-0.5 bg-white disabled:bg-yellow-50 disabled:text-yellow-700 disabled:border-yellow-300 ${isLate ? "border-yellow-400 text-yellow-700 font-semibold" : "border-gray-300 text-gray-500"}`}
                      >
                        <option value=""></option>
                        <option value="月遅">月遅</option>
                      </select>
                    </div>
                    <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={e => e.stopPropagation()}>
                      <select
                        value={flag?.flag_type === "返戻" ? "返戻" : ""}
                        onChange={e => setRebillLocal(client.id, billingMonth, e.target.value === "返戻" ? "返戻" : null)}
                        className={`w-full text-[11px] border rounded px-1 py-0.5 bg-white ${flag?.flag_type === "返戻" ? "border-red-400 text-red-600 font-semibold" : "border-gray-300 text-gray-500"}`}
                      >
                        <option value=""></option>
                        <option value="返戻">返戻</option>
                      </select>
                    </div>
                    <div className="px-1 py-2 border-l border-gray-100 text-center" onClick={e => { e.stopPropagation(); toggleRebillFlag(client.id, billingMonth, "過誤"); }}>
                      <span
                        className={`inline-flex w-5 h-5 rounded-full border-2 items-center justify-center text-[10px] font-bold cursor-pointer transition-colors ${
                          flag?.flag_type === "過誤" ? "border-red-500 bg-red-500 text-white" : "border-gray-300 text-transparent hover:border-red-300"
                        }`}
                        title="過誤"
                      >○</span>
                    </div>
                  </div>
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
              const totalUnits = clientGroups.reduce((s, { client, items }) =>
                s + items.reduce((ss, item) => ss + getUnits(item, client.id) * item.quantity, 0), 0);
              const kokuhoCount = billingGroupsForTotal.length;
              const kokuhoUnits = billingGroupsForTotal.reduce((s, { client, items }) =>
                s + items.reduce((ss, item) => ss + getUnits(item, client.id) * item.quantity, 0), 0);
              // 単位単価は地域加算で違うが、概算 10 円/単位 (国保連伝送と同じ)
              const UNIT_PRICE = 10;
              const insuranceUnitAmount = kokuhoUnits * UNIT_PRICE;
              // 給付率の平均 (各 client の benefit_rate を加重平均)
              let insuranceClaim = 0;
              let copayClaim = 0;
              for (const { client, items } of billingGroupsForTotal) {
                const subUnits = items.reduce((ss, item) => ss + getUnits(item, client.id) * item.quantity, 0);
                const benefitRate = parseInt(client.benefit_rate ?? "90", 10);
                const subAmount = subUnits * UNIT_PRICE;
                const subCopay = Math.round(subAmount * (100 - benefitRate) / 100);
                insuranceClaim += subAmount - subCopay;
                copayClaim += subCopay;
              }
              return (
                <div className="border-t border-gray-300 bg-gray-50 px-3 py-2 shrink-0 text-[11px] text-gray-700">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1 mb-1.5">
                    <span>合計件数 <strong className="font-mono">{totalCount.toLocaleString()}</strong></span>
                    <span>合計単位数 <strong className="font-mono">{totalUnits.toLocaleString()}</strong></span>
                    <span>国保件数 <strong className="font-mono">{kokuhoCount.toLocaleString()}</strong></span>
                    <span>国保対象単位数 <strong className="font-mono">{kokuhoUnits.toLocaleString()}</strong></span>
                  </div>
                  <div className="border border-gray-300 rounded bg-white px-2 py-1.5 grid grid-cols-3 gap-x-4 gap-y-1">
                    <span>特定介護請求額 <strong className="font-mono">—</strong></span>
                    <span>軽減額 <strong className="font-mono">—</strong></span>
                    <span>保険単位額 <strong className="font-mono">{insuranceUnitAmount.toLocaleString()}</strong></span>
                    <span>公費単位数 <strong className="font-mono">—</strong></span>
                    <span>保険請求額 <strong className="font-mono">{insuranceClaim.toLocaleString()}</strong></span>
                    <span>公費請求額 <strong className="font-mono">—</strong></span>
                    <span>利用者負担額 <strong className="font-mono text-red-600">{copayClaim.toLocaleString()}</strong></span>
                    <span>公費分本人負担 <strong className="font-mono">—</strong></span>
                  </div>
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
                        const eq = equipment.find(e => e.product_code === item.product_code);
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
                    const totalU = detailClient.items.reduce((s, item) => s + getUnits(item, detailClient.client.id) * item.quantity, 0);
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
          onClose={() => setInvoiceClient(null)}
        />
      )}
    </div>
  );
}

// ─── Sales Report Tab（売上帳票：介護保険レンタル） ─────────────────────
function SalesReportTab({ tenantId, clients, orderItems, orders, equipment, currentOfficeId }: {
  tenantId: string;
  clients: Client[];
  orderItems: OrderItem[];
  orders: Order[];
  equipment: Equipment[];
  currentOfficeId: string | null;
}) {
  // 月選択（デフォルト：今月）
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [y, m] = month.split("-").map(Number);
  const prevMonth = () => { const d = new Date(y, m - 2, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const nextMonth = () => { const d = new Date(y, m, 1); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };
  const toThisMonth = () => { const d = new Date(); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); };

  // データ: 売上帳票の手入力項目 + 書類チェック + 居宅/ケアマネマスタ
  const [salesRecords, setSalesRecords] = useState<import("@/lib/sales").SalesRecord[]>([]);
  const [documents, setDocuments] = useState<Array<{ client_id: string; type: string }>>([]);
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  const [purchasePrices, setPurchasePrices] = useState<Array<{ product_code: string; supplier_id: string; purchase_price: number }>>([]);
  const [suppliersAll, setSuppliersAll] = useState<Supplier[]>([]); // 卸名解決用 (非表示含む全件)
  const [careOfficesMap, setCareOfficesMap] = useState<Map<string, string>>(new Map()); // id -> name
  const [careManagersMap, setCareManagersMap] = useState<Map<string, string>>(new Map()); // id -> name
  const [loading, setLoading] = useState(true);

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
            const { data, error } = await supabase.from(table).select(columns).eq("tenant_id", tenantId).range(from, from + PAGE - 1);
            if (error) throw error;
            if (!data || data.length === 0) break;
            all.push(...(data as unknown as T[]));
            if (data.length < PAGE) break;
            from += PAGE;
          }
          return all;
        };
        const [sr, docs, priceHist, ppRes, offs, mgrs, sups] = await Promise.all([
          getSalesRecords(tenantId),
          fetchAllRows<{ client_id: string; type: string }>("client_documents", "client_id, type"),
          getPriceHistory(tenantId, [...new Set(orderItems.map((i) => i.product_code))]),
          supabase.from("equipment_prices").select("product_code, supplier_id, purchase_price").eq("tenant_id", tenantId),
          fetchAllRows<{ id: string; name: string }>("care_offices", "id, name"),
          fetchAllRows<{ id: string; name: string }>("care_managers", "id, name"),
          getSuppliers().catch((e) => { console.error("getSuppliers に失敗 (空で続行):", e); return [] as Supplier[]; }),
        ]);
        setSalesRecords(sr);
        setDocuments(docs);
        setPriceHistory(priceHist);
        setPurchasePrices((ppRes.data ?? []) as Array<{ product_code: string; supplier_id: string; purchase_price: number }>);
        setSuppliersAll(sups);
        const om = new Map<string, string>();
        offs.forEach((o) => om.set(o.id, o.name));
        setCareOfficesMap(om);
        const mm = new Map<string, string>();
        mgrs.forEach((m) => mm.set(m.id, m.name));
        setCareManagersMap(mm);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 月非依存。品目コード集合(productCodesKey)変化時のみ再取得
  }, [tenantId, productCodesKey]);

  // 居宅名 / ケアマネ名：care_office_id 優先、なければテキスト
  const getCareOfficeName = (c: Client): string =>
    (c.care_office_id ? careOfficesMap.get(c.care_office_id) : null) ?? c.care_manager_org ?? "";
  const getCareManagerName = (c: Client): string =>
    (c.care_manager_id ? careManagersMap.get(c.care_manager_id) : null) ?? c.care_manager ?? "";

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
      isHalfMonth: boolean;
      client: Client;
      item: OrderItem;
      order: Order;
      equipmentName: string;
      rentalPrice: number;  // 月額
      purchasePrice: number;
    };
    const result: RowType[] = [];

    // 月額取得（その月有効な rental_price、なければ equipment.rental_price）
    const getMonthlyPrice = (productCode: string): number => {
      // price_history from getPriceHistory: { product_code, rental_price, valid_from }
      const hist = priceHistory
        .filter((p) => p.product_code === productCode && p.valid_from <= monthEnd)
        .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
      if (hist.length > 0) return hist[0].rental_price;
      const eq = equipment.find((e) => e.product_code === productCode);
      return eq?.rental_price ?? 0;
    };

    // 仕入単価取得
    const getPurchasePrice = (productCode: string, supplierId: string | null): number => {
      if (!supplierId) return 0;
      const p = purchasePrices.find((p) => p.product_code === productCode && p.supplier_id === supplierId);
      return p?.purchase_price ?? 0;
    };

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
        const day = parseInt(item.rental_start_date.split("-")[2]);
        const isHalf = day >= 16;
        result.push({
          key: `${item.id}-start`,
          orderItemId: item.id,
          eventType: "start",
          salesDate: item.rental_start_date,
          rType,
          isHalfMonth: isHalf,
          client,
          item,
          order,
          equipmentName,
          rentalPrice: getMonthlyPrice(item.product_code),
          purchasePrice: item.purchase_price ?? getPurchasePrice(item.product_code, item.supplier_id),
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
        const day = parseInt(item.rental_end_date.split("-")[2]);
        const isHalf = day <= 15;
        result.push({
          key: `${item.id}-end`,
          orderItemId: item.id,
          eventType: "end",
          salesDate: item.rental_end_date,
          rType,
          isHalfMonth: isHalf,
          client,
          item,
          order,
          equipmentName,
          rentalPrice: getMonthlyPrice(item.product_code),
          purchasePrice: item.purchase_price ?? getPurchasePrice(item.product_code, item.supplier_id),
        });
      }
    }

    // 売上日昇順
    return result.sort((a, b) => a.salesDate.localeCompare(b.salesDate));
  }, [orderItems, orders, clients, equipment, priceHistory, purchasePrices, month, y, m, currentOfficeId]);

  // 月次損益（発生ベース・介護保険レンタル）
  //   売上 = その月に稼働中のレンタル月額の合計（半月按分: 開始16日以降/終了15日以前は半月）
  //   経費 = その月にレンタル開始した item の仕入原価合計（order_items.purchase_price スナップ優先、無ければカタログ）
  //   利益 = 売上 − 経費。現金（買掛支払）とは別軸の客観的な月次損益。
  const pnl = useMemo(() => {
    const monthStart = `${month}-01`;
    const monthEnd = monthEndYmd(y, m);
    // その月有効な月額レンタル（rental 履歴優先）
    const monthlyRentalOf = (productCode: string): number => {
      const hist = priceHistory
        .filter((p) => p.product_code === productCode && p.valid_from <= monthEnd)
        .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
      if (hist.length > 0) return hist[0].rental_price;
      return equipment.find((e) => e.product_code === productCode)?.rental_price ?? 0;
    };
    // カタログ仕入（スナップショットが無い旧データ用フォールバック）
    const catalogPurchaseOf = (productCode: string, supplierId: string | null): number => {
      if (!supplierId) return 0;
      return purchasePrices.find((p) => p.product_code === productCode && p.supplier_id === supplierId)?.purchase_price ?? 0;
    };
    let revenue = 0;
    let expense = 0;
    let activeCount = 0;
    let startedCount = 0;
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
        const full = monthlyRentalOf(item.product_code);
        const startDay = item.rental_start_date >= monthStart && item.rental_start_date <= monthEnd
          ? parseInt(item.rental_start_date.split("-")[2]) : null;
        const endDay = item.status === "terminated" && item.rental_end_date != null
          && item.rental_end_date >= monthStart && item.rental_end_date <= monthEnd
          ? parseInt(item.rental_end_date.split("-")[2]) : null;
        const half = (startDay != null && startDay >= 16) || (endDay != null && endDay <= 15);
        const rev = Math.round(full * (half ? 0.5 : 1));
        revenue += rev;
        activeCount++;
        const pa = prodAcc(item.product_code);
        pa.revenue += rev; pa.activeCount++;
      }
      // ── 経費: その月にレンタル開始した分の仕入原価（スナップ優先）──
      if (item.rental_start_date >= monthStart && item.rental_start_date <= monthEnd) {
        const exp = item.purchase_price ?? catalogPurchaseOf(item.product_code, item.supplier_id);
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
    return { revenue, expense, profit: revenue - expense, activeCount, startedCount, byProduct, bySupplier };
  }, [orderItems, orders, equipment, priceHistory, purchasePrices, month, y, m, currentOfficeId]);
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

  // CSV 出力
  const exportCSV = () => {
    const headers = [
      "NO", "売上日", "入力者", "R項目", "契約書", "R契約日", "R解約日", "解約理由",
      "提案書", "個別援助計画", "紹介機関", "居宅", "ケアマネージャー様氏名",
      "受注担当者名", "納品・回収", "利用者名", "商品名",
      "R売上(1ヶ月分)", "R売上(半月分)", "R引上金額(1ヶ月分)", "R引上金額(半月分)", "仕入金額",
    ];
    const rowsCsv = rows.map((r, idx) => {
      const sr = getSalesRec(r.orderItemId, r.eventType);
      const revenueFull = r.eventType === "start" && !r.isHalfMonth ? r.rentalPrice : "";
      const revenueHalf = r.eventType === "start" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : "";
      const liftFull = r.eventType === "end" && !r.isHalfMonth ? r.rentalPrice : "";
      const liftHalf = r.eventType === "end" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : "";
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
        revenueFull,
        revenueHalf,
        liftFull,
        liftHalf,
        r.purchasePrice || "",
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
        <div className="ml-auto flex items-center gap-2">
          <span className="text-gray-500 text-xs">{rows.length} 件</span>
          <button onClick={exportCSV}
            className="border border-indigo-500 rounded bg-indigo-500 px-3 py-1 text-white font-semibold hover:bg-indigo-600 flex items-center gap-1.5">
            <Download size={13} />CSV出力
          </button>
        </div>
      </div>

      {/* 月次損益（発生ベース） */}
      {!loading && (
        <div className="border-b border-gray-300 bg-slate-50 shrink-0">
          <div className="px-3 py-2 flex items-center gap-4 flex-wrap text-xs">
            <span className="font-semibold text-gray-700">月次損益（発生ベース）</span>
            <span className="text-gray-600">売上 <span className="font-semibold text-gray-900">¥{pnl.revenue.toLocaleString()}</span> <span className="text-gray-400">(稼働{pnl.activeCount}件)</span></span>
            <span className="text-gray-600">経費 <span className="font-semibold text-gray-900">¥{pnl.expense.toLocaleString()}</span> <span className="text-gray-400">(当月開始{pnl.startedCount}件)</span></span>
            <span className="text-gray-600">利益 <span className={`font-bold ${pnl.profit >= 0 ? "text-emerald-700" : "text-red-600"}`}>¥{pnl.profit.toLocaleString()}</span></span>
            <button
              onClick={() => setShowPnlDetail((v) => !v)}
              className="text-[11px] px-2 py-0.5 rounded border border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
            >
              内訳 {showPnlDetail ? "▲" : "▼"}
            </button>
            <span className="text-[10px] text-gray-400 ml-auto">売上=当月稼働レンタルの月額合計 / 経費=当月開始レンタルの仕入原価（現金支払とは別軸）</span>
          </div>
          {showPnlDetail && (
            <div className="px-3 pb-3 grid grid-cols-1 lg:grid-cols-2 gap-3 text-xs">
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
                        const name = sid === "__none__" ? "（卸未設定）" : (suppliersAll.find((s) => s.id === sid)?.name ?? sid);
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
                ].map((h) => (
                  <th key={h} className="border border-gray-300 px-2 py-1 font-medium text-gray-600 whitespace-pre-line text-center">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const sr = getSalesRec(r.orderItemId, r.eventType);
                const revenueFull = r.eventType === "start" && !r.isHalfMonth ? r.rentalPrice : null;
                const revenueHalf = r.eventType === "start" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : null;
                const liftFull = r.eventType === "end" && !r.isHalfMonth ? r.rentalPrice : null;
                const liftHalf = r.eventType === "end" && r.isHalfMonth ? Math.round(r.rentalPrice / 2) : null;
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

// ─── RentalGridModal ──────────────────────────────────────────────────────────

function RentalGridModal({
  client, items, equipment, hospitalizations, month, onClose,
}: {
  client: Client;
  items: OrderItem[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
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

  // 半月請求判定
  const getHalfBilling = (item: OrderItem): "full" | "first" | "second" | "none" => {
    const itemDays = getItemDays(item);
    if (itemDays.size === 0) return "none";
    // 入院で除外される日
    const billingDays = [...itemDays].filter(d => !hospDays.has(d));
    if (billingDays.length === 0) return "none";
    const hasFirst = billingDays.some(d => d <= 15);
    const hasSecond = billingDays.some(d => d > 15);
    if (hasFirst && hasSecond) return "full";
    if (hasFirst) return "first";
    return "second";
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
                const billing = getHalfBilling(item);
                const rentalDayCount = [...itemDays].filter(d => !hospDays.has(d)).length;
                const baseUnits = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
                const units = (billing === "first" || billing === "second") ? Math.round(baseUnits / 2) : billing === "none" ? 0 : baseUnits;
                const billingLabel = billing === "full" ? "1か月" : billing === "first" ? "前半月" : billing === "second" ? "後半月" : "—";
                return (
                  <tr key={item.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                    <td className="border border-gray-200 px-2 py-1.5 font-medium text-gray-800 leading-tight">
                      {e?.name ?? item.product_code}
                    </td>
                    {days.map(d => {
                      const isRental = itemDays.has(d);
                      const isHosp = hospDays.has(d);
                      const isStart = item.rental_start_date && (() => { const s = pld(item.rental_start_date!); return s.getDate() === d && s.getMonth() === m - 1 && s.getFullYear() === y; })();
                      const isEnd = item.rental_end_date && (() => { const e = pld(item.rental_end_date!); return e.getDate() === d && e.getMonth() === m - 1 && e.getFullYear() === y; })();
                      return (
                        <td key={d} className={`text-center p-0 h-7 ${
                          !isRental ? "border border-gray-200 bg-white" :
                          isHosp ? "border border-orange-300 bg-orange-100" :
                          "border border-blue-300 bg-blue-100"
                        }`}>
                          {isRental && (
                            <span className={`text-[9px] font-bold ${
                              isHosp ? "text-orange-500" :
                              isStart ? "text-blue-700" :
                              isEnd ? "text-purple-600" :
                              "text-blue-500"
                            }`}>
                              {isStart ? "S" : isEnd ? "E" : isHosp ? "入" : "●"}
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
                    {items.reduce((s, item) => {
                      const e = eq(item);
                      const billing = getHalfBilling(item);
                      if (billing === "none") return s;
                      const u = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
                      return s + (billing === "first" || billing === "second" ? Math.round(u / 2) : u);
                    }, 0)}単位
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
  client, items, equipment, hospitalizations, month,
}: {
  client: Client;
  items: OrderItem[];
  equipment: Equipment[];
  hospitalizations: ClientHospitalization[];
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

  const getHalfBilling = (item: OrderItem): "full" | "first" | "second" | "none" => {
    const itemDays = getItemDays(item);
    if (itemDays.size === 0) return "none";
    const billingDays = [...itemDays].filter(d => !hospDays.has(d));
    if (billingDays.length === 0) return "none";
    const hasFirst = billingDays.some(d => d <= 15);
    const hasSecond = billingDays.some(d => d > 15);
    if (hasFirst && hasSecond) return "full";
    if (hasFirst) return "first";
    return "second";
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
              const billing = getHalfBilling(item);
              const rentalDayCount = [...itemDays].filter(d => !hospDays.has(d)).length;
              const baseUnits = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
              const units = (billing === "first" || billing === "second") ? Math.round(baseUnits / 2) : billing === "none" ? 0 : baseUnits;
              const billingLabel = billing === "full" ? "1か月" : billing === "first" ? "前半月" : billing === "second" ? "後半月" : "—";
              return (
                <tr key={item.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"}>
                  <td className="border border-gray-200 px-2 py-1.5 font-medium text-gray-800 leading-tight">
                    {e?.name ?? item.product_code}
                  </td>
                  {days.map(d => {
                    const isRental = itemDays.has(d);
                    const isHosp = hospDays.has(d);
                    const isStart = item.rental_start_date && (() => { const s = pld(item.rental_start_date!); return s.getDate() === d && s.getMonth() === m - 1 && s.getFullYear() === y; })();
                    const isEnd = item.rental_end_date && (() => { const e = pld(item.rental_end_date!); return e.getDate() === d && e.getMonth() === m - 1 && e.getFullYear() === y; })();
                    return (
                      <td key={d} className={`text-center p-0 h-7 ${
                        !isRental ? "border border-gray-200 bg-white" :
                        isHosp ? "border border-orange-300 bg-orange-100" :
                        "border border-blue-300 bg-blue-100"
                      }`}>
                        {isRental && (
                          <span className={`text-[9px] font-bold ${
                            isHosp ? "text-orange-500" :
                            isStart ? "text-blue-700" :
                            isEnd ? "text-purple-600" :
                            "text-blue-500"
                          }`}>
                            {isStart ? "S" : isEnd ? "E" : isHosp ? "入" : "●"}
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
                {items.reduce((s, item) => {
                  const e = eq(item);
                  const billing = getHalfBilling(item);
                  if (billing === "none") return s;
                  const u = Math.round((e?.rental_price ?? 0) / 10) * item.quantity;
                  return s + (billing === "first" || billing === "second" ? Math.round(u / 2) : u);
                }, 0)}単位
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
  onClose,
}: {
  client: Client;
  orders: Order[];
  orderItems: OrderItem[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  priceHistory: EquipmentPriceHistory[];
  tenantId: string;
  defaultMonth: string;  // YYYY-MM
  hospitalizations: ClientHospitalization[];
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
  const histPrice = (code: string, ym: string) =>
    getPriceForMonth(priceHistory, code, ym) ?? undefined;

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
      const price = getPriceForMonth(priceHistory, item.product_code, targetMonth) ?? item.rental_price ?? 0;
      const units = calcMonthUnits(item, y, m, histPrice(item.product_code, targetMonth)) ?? 0;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [careItems, priceHistory, targetMonth, y, m]);

  const totalUnits = detailRows.reduce((s, r) => s + r.totalUnits, 0);
  const insuredAmount = totalUnits * 10;
  const benefitRate = parseInt(client.benefit_rate ?? "90", 10);
  const copayRate = 100 - benefitRate;
  const copayAmount = Math.floor(insuredAmount * copayRate / 100);

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
                <td style={{ border: "1px solid #374151", padding: "6px 8px", textAlign: "right" }}>{copayAmount.toLocaleString()}</td>
              </tr>
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
