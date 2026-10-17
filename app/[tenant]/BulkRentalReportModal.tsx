"use client";
import { useEffect, useMemo, useState } from "react";
import { X, Loader2, Printer, Save } from "lucide-react";
import { supabase, OrderItem, Equipment, EquipmentPriceHistory, Client, ClientDocument } from "@/lib/supabase";
import { getAllOrderItemsByTenant } from "@/lib/orders";
import { todayYmd } from "@/lib/date-jst";
import { type CompanyInfo } from "./company-info";
import RentalReportSheet from "./RentalReportSheet";
import { detectRentalUsage, hasMovementInMonth, hasRentalInMonth, rentalReportTitle, type UsageType } from "@/lib/rentalReport";

// 貸与報告書を毎月まとめて作る。対象 = その月に貸与のある人 (全員) か、開始・解約のあった人だけ。
// 訪問日はその月のモニタリング記録の訪問日 (無ければ空欄)。ケアマネ事業所ごとに並べる。
// 「履歴に保存」は 1 人ずつの画面と同じ形 (type=rental_report / params) で保存するので、後から 1 人ずつ開き直せる。

const PRINT_STYLE_ID = "__bulk_rpt_print__";
const NO_CARE_OFFICE = "（ケアマネ事業所なし）";

type Row = {
  client: Client;
  items: OrderItem[];
  usage: UsageType[];
  movement: boolean;
  visitDate: string;
  saved: boolean;
};

async function fetchPaged<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function prevMonth(): string {
  const [y, m] = todayYmd().split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function BulkRentalReportModal({
  tenantId,
  clients,
  equipment,
  companyInfo,
  onClose,
  onSaved,
}: {
  tenantId: string;
  /** 書類画面の利用者 (事業所の絞り込み済み) */
  clients: Client[];
  equipment: Equipment[];
  companyInfo: CompanyInfo;
  onClose: () => void;
  onSaved?: (docs: ClientDocument[]) => void;
}) {
  // 報告書は月初に前月分を出すことが多いので、既定は前月
  const [targetMonth, setTargetMonth] = useState(prevMonth);
  const [scope, setScope] = useState<"all" | "movement">("all");
  const [items, setItems] = useState<OrderItem[] | null>(null);
  const [payMap, setPayMap] = useState<Record<string, { client_id: string; pay: "介護" | "自費" }>>({});
  const [priceHistory, setPriceHistory] = useState<EquipmentPriceHistory[]>([]);
  const [visitByClient, setVisitByClient] = useState<Map<string, string>>(new Map());
  const [savedClients, setSavedClients] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [monthLoading, setMonthLoading] = useState(false);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [visitOverride, setVisitOverride] = useState<Map<string, string>>(new Map());
  const [focusId, setFocusId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [printing, setPrinting] = useState(false);
  const reportDate = todayYmd();

  // 貸与明細・発注 (月に依らない) と単価の改定履歴
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [all, orders] = await Promise.all([
          getAllOrderItemsByTenant(tenantId),
          fetchPaged<{ id: string; client_id: string; payment_type: string | null }>((from, to) =>
            supabase.from("orders").select("id, client_id, payment_type").eq("tenant_id", tenantId).order("id").range(from, to)),
        ]);
        const pm: Record<string, { client_id: string; pay: "介護" | "自費" }> = {};
        for (const o of orders) pm[o.id] = { client_id: o.client_id, pay: o.payment_type === "自費" ? "自費" : "介護" };
        // 単価の改定履歴: .in() は件数が多いと遅くなるので 150 件ずつ
        const codes = [...new Set(all.map((i) => i.product_code))];
        const hist: EquipmentPriceHistory[] = [];
        for (let i = 0; i < codes.length; i += 150) {
          const { data, error } = await supabase.from("equipment_price_history").select("*")
            .eq("tenant_id", tenantId).in("product_code", codes.slice(i, i + 150)).order("valid_from", { ascending: true });
          if (error) throw new Error(error.message);
          hist.push(...((data ?? []) as EquipmentPriceHistory[]));
        }
        if (!cancelled) { setItems(all); setPayMap(pm); setPriceHistory(hist); }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("貸与報告書の一括作成: 読み込みに失敗:", msg);
        if (!cancelled) setLoadError(msg);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  // 月ごと: モニタリングの訪問日と、その月の報告書が保存済みか
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 月を変えたときの読み込み中表示
    setMonthLoading(true);
    (async () => {
      try {
        const [mons, docs] = await Promise.all([
          fetchPaged<{ client_id: string; visit_date: string | null }>((from, to) =>
            supabase.from("monitoring_records").select("client_id, visit_date")
              .eq("tenant_id", tenantId).eq("target_month", targetMonth).order("id").range(from, to)),
          fetchPaged<{ client_id: string }>((from, to) =>
            supabase.from("client_documents").select("client_id")
              .eq("tenant_id", tenantId).eq("type", "rental_report").eq("params->>targetMonth", targetMonth).order("id").range(from, to)),
        ]);
        const v = new Map<string, string>();
        // 同じ月に複数あるときは遅い訪問日
        for (const m of mons) if (m.visit_date && (v.get(m.client_id) ?? "") < m.visit_date) v.set(m.client_id, m.visit_date);
        if (!cancelled) {
          setVisitByClient(v);
          setSavedClients(new Set(docs.map((d) => d.client_id)));
          setVisitOverride(new Map());
          setUnchecked(new Set());
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("貸与報告書の一括作成: 月の読み込みに失敗:", msg);
        if (!cancelled) setLoadError(msg);
      } finally {
        if (!cancelled) setMonthLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, targetMonth]);

  const orderPayMap = useMemo(() => {
    const out: Record<string, "介護" | "自費"> = {};
    for (const [id, v] of Object.entries(payMap)) out[id] = v.pay;
    return out;
  }, [payMap]);

  const allRows = useMemo<Row[]>(() => {
    if (!items) return [];
    const byClient = new Map<string, OrderItem[]>();
    for (const it of items) {
      const cid = payMap[it.order_id]?.client_id;
      if (!cid) continue;
      const list = byClient.get(cid) ?? [];
      list.push(it);
      byClient.set(cid, list);
    }
    const rows: Row[] = [];
    for (const c of clients) {
      const its = byClient.get(c.id);
      if (!its || !hasRentalInMonth(its, targetMonth)) continue;
      rows.push({
        client: c,
        items: its,
        usage: detectRentalUsage(its, targetMonth),
        movement: hasMovementInMonth(its, targetMonth),
        visitDate: visitByClient.get(c.id) ?? "",
        saved: savedClients.has(c.id),
      });
    }
    rows.sort((a, b) => {
      const oa = a.client.care_manager_org || "￿";
      const ob = b.client.care_manager_org || "￿";
      if (oa !== ob) return oa.localeCompare(ob, "ja");
      const ma = a.client.care_manager ?? "", mb = b.client.care_manager ?? "";
      if (ma !== mb) return ma.localeCompare(mb, "ja");
      return (a.client.furigana ?? a.client.name).localeCompare(b.client.furigana ?? b.client.name, "ja");
    });
    return rows;
  }, [items, payMap, clients, targetMonth, visitByClient, savedClients]);

  const rows = useMemo(() => (scope === "movement" ? allRows.filter((r) => r.movement) : allRows), [allRows, scope]);
  const visitOf = (r: Row) => visitOverride.get(r.client.id) ?? r.visitDate;
  const checkedRows = rows.filter((r) => !unchecked.has(r.client.id));
  const unsavedChecked = checkedRows.filter((r) => !r.saved);
  const focus = rows.find((r) => r.client.id === focusId) ?? rows[0] ?? null;

  const groups = useMemo(() => {
    const out: { org: string; rows: Row[] }[] = [];
    for (const r of rows) {
      const org = r.client.care_manager_org || NO_CARE_OFFICE;
      const last = out[out.length - 1];
      if (last && last.org === org) last.rows.push(r);
      else out.push({ org, rows: [r] });
    }
    return out;
  }, [rows]);

  const toggle = (ids: string[], on: boolean) => setUnchecked((prev) => {
    const next = new Set(prev);
    for (const id of ids) { if (on) next.delete(id); else next.add(id); }
    return next;
  });

  // 印刷: 選んだ人を全員描いてから印刷し、終わったら消す
  useEffect(() => {
    const style = document.createElement("style");
    style.id = PRINT_STYLE_ID;
    style.textContent = `
      @page { size: A4 portrait; margin: 8mm; }
      @media print {
        body > * { visibility: hidden !important; }
        #bulk-rental-report-print, #bulk-rental-report-print * { visibility: visible !important; }
        #bulk-rental-report-print { position: absolute !important; top: 0 !important; left: 0 !important; width: 100% !important; display: block !important; }
        #bulk-rental-report-modal { position: static !important; overflow: visible !important; }
        .bulk-rpt-sheet { box-shadow: none !important; margin: 0 !important; break-after: page; }
        .bulk-rpt-sheet:last-child { break-after: auto; }
        .no-print { display: none !important; }
      }
    `;
    document.head.appendChild(style);
    return () => { document.getElementById(PRINT_STYLE_ID)?.remove(); };
  }, []);
  useEffect(() => {
    if (!printing) return;
    const t = setTimeout(() => { window.print(); setPrinting(false); }, 300);
    return () => clearTimeout(t);
  }, [printing]);

  const handleSave = async () => {
    if (unsavedChecked.length === 0) return;
    if (!confirm(`${unsavedChecked.length} 名の貸与報告書 (${rentalReportTitle(targetMonth).replace("貸与報告書 ", "")}) を履歴に保存します。`)) return;
    setSaving(true);
    try {
      const payload = unsavedChecked.map((r) => ({
        tenant_id: tenantId,
        client_id: r.client.id,
        type: "rental_report",
        title: rentalReportTitle(targetMonth),
        params: { targetMonth, visitDate: visitOf(r), memo: "", selectedUsage: r.usage },
      }));
      const { data, error } = await supabase.from("client_documents").insert(payload).select();
      if (error) throw new Error(error.message);
      const docs = (data ?? []) as ClientDocument[];
      if (docs.length !== payload.length) throw new Error(`保存件数が合いません (${docs.length} / ${payload.length})`);
      setSavedClients((prev) => new Set([...prev, ...docs.map((d) => d.client_id)]));
      onSaved?.(docs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("貸与報告書の一括保存に失敗:", msg);
      alert(`保存に失敗しました: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const sheetFor = (r: Row, className: string) => (
    <RentalReportSheet
      key={r.client.id}
      client={r.client}
      items={r.items}
      orderPaymentMap={orderPayMap}
      equipment={equipment}
      companyInfo={companyInfo}
      priceHistory={priceHistory}
      targetMonth={targetMonth}
      visitDate={visitOf(r)}
      reportDate={reportDate}
      usage={new Set(r.usage)}
      memo=""
      checkedReqs={new Set()}
      className={className}
    />
  );

  const loading = !items && !loadError;

  return (
    <div id="bulk-rental-report-modal" className="fixed inset-0 bg-black/70 z-[60] flex flex-col">
      {/* 操作バー */}
      <div className="no-print bg-white border-b border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3 shrink-0">
        <button onClick={onClose} title="閉じる"><X size={20} className="text-gray-500" /></button>
        <span className="font-semibold text-gray-800">貸与報告書をまとめて作る</span>
        <label className="text-xs text-gray-500 ml-2">対象月</label>
        <input type="month" value={targetMonth} onChange={(e) => e.target.value && setTargetMonth(e.target.value)}
          className="border border-gray-200 rounded-lg px-2 py-1 text-sm outline-none" />
        <div className="flex text-xs rounded-lg border border-gray-300 overflow-hidden">
          {([["all", "貸与のある人 全員"], ["movement", "開始・解約のあった人だけ"]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setScope(k)}
              className={`px-3 py-1.5 ${scope === k ? "bg-blue-500 text-white" : "bg-white text-gray-600 hover:bg-gray-50"}`}>{label}</button>
          ))}
        </div>
        <span className="text-xs text-gray-500 flex-1">
          {loading ? "読み込み中…" : `${rows.length} 名中 ${checkedRows.length} 名を選択`}
          {monthLoading && <Loader2 size={12} className="inline animate-spin ml-1" />}
        </span>
        <button onClick={handleSave} disabled={saving || unsavedChecked.length === 0}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium border bg-white text-emerald-600 border-emerald-300 hover:bg-emerald-50 disabled:text-gray-400 disabled:border-gray-200 disabled:bg-gray-50">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          未保存の {unsavedChecked.length} 名を履歴に保存
        </button>
        <button onClick={() => setPrinting(true)} disabled={checkedRows.length === 0 || printing}
          className="flex items-center gap-1.5 bg-emerald-500 disabled:bg-gray-300 text-white px-4 py-2 rounded-xl text-sm font-medium">
          {printing ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />} {checkedRows.length} 名を印刷
        </button>
      </div>

      {loadError && <div className="no-print bg-red-50 text-red-700 text-sm px-4 py-2">読み込みに失敗しました: {loadError}</div>}

      <div className="no-print flex-1 flex min-h-0">
        {/* 左: ケアマネ事業所ごとの一覧 */}
        <div className="w-[380px] shrink-0 bg-white border-r border-gray-200 flex flex-col min-h-0">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-3 text-xs">
            <button onClick={() => toggle(rows.map((r) => r.client.id), true)} className="text-blue-600 hover:underline">全員選ぶ</button>
            <button onClick={() => toggle(rows.map((r) => r.client.id), false)} className="text-blue-600 hover:underline">全員外す</button>
            <span className="text-gray-400 ml-auto">訪問日 = その月のモニタリング記録</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && <div className="p-6 text-center text-gray-400"><Loader2 size={18} className="inline animate-spin" /></div>}
            {!loading && rows.length === 0 && (
              <p className="p-6 text-sm text-gray-400 text-center">
                {scope === "movement" ? "この月に開始・解約のあった人はいません" : "この月に貸与のある人はいません"}
              </p>
            )}
            {groups.map((g) => {
              const ids = g.rows.map((r) => r.client.id);
              const allOn = ids.every((id) => !unchecked.has(id));
              return (
                <div key={g.org}>
                  <label className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-gray-100 text-xs font-semibold text-gray-700 border-b border-gray-200">
                    <input type="checkbox" checked={allOn} onChange={(e) => toggle(ids, e.target.checked)} />
                    <span className="truncate flex-1">{g.org}</span>
                    <span className="text-gray-400 font-normal">{g.rows.length} 名</span>
                  </label>
                  {g.rows.map((r) => {
                    const id = r.client.id;
                    const on = !unchecked.has(id);
                    const isFocus = focus?.client.id === id;
                    return (
                      <div key={id} onClick={() => setFocusId(id)}
                        className={`flex items-center gap-2 px-3 py-1.5 border-b border-gray-50 cursor-pointer text-sm ${isFocus ? "bg-blue-50" : "hover:bg-gray-50"}`}>
                        <input type="checkbox" checked={on} onClick={(e) => e.stopPropagation()} onChange={(e) => toggle([id], e.target.checked)} />
                        <span className="w-24 truncate font-medium text-gray-800">{r.client.name}</span>
                        <span className="flex-1 truncate text-[11px] text-gray-500">{r.usage.join("・")}</span>
                        {r.saved && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 shrink-0">保存済</span>}
                        <input type="date" value={visitOf(r)} onClick={(e) => e.stopPropagation()}
                          onChange={(e) => { const v = e.target.value; setVisitOverride((prev) => new Map(prev).set(id, v)); }}
                          title="訪問日 (空欄なら報告書も空欄)"
                          className={`w-[118px] shrink-0 border rounded px-1 py-0.5 text-[11px] ${visitOf(r) ? "border-gray-200 text-gray-700" : "border-amber-300 bg-amber-50 text-gray-400"}`} />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* 右: 選んでいる人の報告書 */}
        <div className="flex-1 min-w-0 overflow-y-auto bg-gray-100">
          {focus ? sheetFor(focus, "max-w-4xl mx-auto my-6 bg-white shadow-lg px-10 py-8")
            : !loading && <p className="p-10 text-center text-gray-400 text-sm">左の一覧から選ぶと報告書が出ます</p>}
        </div>
      </div>

      {/* 印刷用: 選んだ人を全員 */}
      {printing && (
        <div id="bulk-rental-report-print" style={{ display: "none" }}>
          {checkedRows.map((r) => sheetFor(r, "bulk-rpt-sheet bg-white px-10 py-8"))}
        </div>
      )}
    </div>
  );
}
