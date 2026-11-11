"use client";

/**
 * 利用者別 → 利用状況 → 月別 の「提供票・実績」表示 (2026-11-11 user 依頼)。
 * ほのぼの福祉用具の提供票と同じく、用具ごとに 1〜末日 の貸与日に「1」を付ける。
 *
 * 貸与日 = 貸与開始日〜終了日 から 休止 (order_item_pauses) と 入院 (client_hospitalizations) を除いた日。
 * 判定は請求・伝送と同じ純関数 (rentalDayMask / halfMonthFlags) を使う (逐語コピーしない)。
 * 休止・入院が読めないときは 除かずに表示し、その旨を画面に出す (黙って違う値を出さない)。
 */
import { useEffect, useMemo, useState } from "react";
import { supabase, type OrderItem } from "@/lib/supabase";
import { rentalDayMask, halfMonthFlags, halfMonthUnits, type DateRange } from "@/lib/half-month-units";
import { groupPausesByItem } from "@/lib/fukuyoguPauses";

type Kind = "介護" | "自費" | "特価自費" | null;

export default function RentalDayGrid({
  clientId, items, yearMonth, kindOf, priceOf, nameOf,
}: {
  clientId: string;
  items: OrderItem[];
  yearMonth: string;
  kindOf: (item: OrderItem) => Kind;
  priceOf: (item: OrderItem) => number;
  nameOf: (item: OrderItem) => string;
}) {
  const [hosp, setHosp] = useState<DateRange[]>([]);
  const [pauses, setPauses] = useState<Map<string, DateRange[]>>(new Map());
  const [warn, setWarn] = useState<string[]>([]);

  const itemIdsKey = items.map((i) => i.id).sort().join(",");
  useEffect(() => {
    let cancelled = false;
    const ids = itemIdsKey ? itemIdsKey.split(",") : [];
    (async () => {
      const msgs: string[] = [];
      const h = await supabase.from("client_hospitalizations").select("admission_date, discharge_date").eq("client_id", clientId);
      if (h.error) {
        console.error("入院の読込失敗:", h.error.message);
        msgs.push(`入院を読めませんでした (${h.error.message}) — 入院日を除かずに表示しています`);
      }
      let pz = new Map<string, DateRange[]>();
      if (ids.length > 0) {
        const p = await supabase.from("order_item_pauses").select("order_item_id, pause_from, pause_to").in("order_item_id", ids);
        if (p.error) {
          console.error("休止の読込失敗:", p.error.message);
          msgs.push(`休止期間を読めませんでした (${p.error.message}) — 休止日を除かずに表示しています`);
        } else {
          pz = groupPausesByItem(p.data ?? []);
        }
      }
      if (cancelled) return;
      setHosp((h.data ?? []).map((r: { admission_date: string; discharge_date: string | null }) => ({ from: r.admission_date, to: r.discharge_date })));
      setPauses(pz);
      setWarn(msgs);
    })();
    return () => { cancelled = true; };
  }, [clientId, itemIdsKey]);

  const [y, m] = yearMonth.split("-").map(Number);
  const nDays = new Date(y, m, 0).getDate();
  const days = Array.from({ length: nDays }, (_, i) => i + 1);
  const DOW = ["日", "月", "火", "水", "木", "金", "土"];
  const dow = (d: number) => new Date(y, m - 1, d).getDay();

  // 入院日 (表の上に「入」を出す)
  const hospMask = useMemo(() => rentalDayMask(null, null, yearMonth, []).map((_, d) => {
    if (d === 0) return false;
    const day = `${yearMonth}-${String(d).padStart(2, "0")}`;
    return hosp.some((r) => (!r.from || day >= r.from.slice(0, 10)) && (!r.to || day <= r.to.slice(0, 10)));
  }), [hosp, yearMonth]);

  const rows = items.map((item) => {
    const ex = [...hosp, ...(pauses.get(item.id) ?? [])];
    const mask = rentalDayMask(item.rental_start_date, item.rental_end_date, yearMonth, ex);
    const inPeriod = rentalDayMask(item.rental_start_date, item.rental_end_date, yearMonth, []);
    const pz = pauses.get(item.id) ?? [];
    const pausedDay = (d: number) => {
      const day = `${yearMonth}-${String(d).padStart(2, "0")}`;
      return pz.some((r) => (!r.from || day >= r.from) && (!r.to || day <= r.to));
    };
    const { firstHalf: first, secondHalf: second } = halfMonthFlags(item.rental_start_date, item.rental_end_date, yearMonth, ex);
    const count = mask.filter(Boolean).length;
    const kubun = first && second ? "全額" : first || second ? "半額" : "—";
    const fullUnits = Math.round(priceOf(item) / 10);
    const units = halfMonthUnits(fullUnits, first, second) * (item.quantity || 1);
    return { item, mask, inPeriod, pausedDay, count, kubun, fullUnits, units };
  });

  return (
    <div className="space-y-2">
      {warn.map((w) => (
        <p key={w} className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">{w}</p>
      ))}
      <div className="overflow-x-auto bg-white rounded-xl shadow-sm">
        <table className="text-[11px] border-collapse min-w-full">
          <thead>
            <tr className="bg-gray-50 text-gray-600">
              <th className="sticky left-0 z-10 bg-gray-50 border-b border-r border-gray-200 px-2 py-1 text-left font-semibold min-w-[12rem]">用具</th>
              {days.map((d) => (
                <th key={d} className={`border-b border-gray-200 w-6 px-0 py-1 font-normal text-center ${dow(d) === 0 ? "text-rose-500" : dow(d) === 6 ? "text-blue-500" : ""} ${d === 16 ? "border-l-2 border-l-gray-300" : ""}`}>
                  <div className="tabular-nums">{d}</div>
                  <div className="text-[9px]">{DOW[dow(d)]}</div>
                  {hospMask[d] && <div className="text-[9px] text-rose-600 font-semibold" title="入院中">入</div>}
                </th>
              ))}
              <th className="border-b border-l border-gray-200 px-2 py-1 font-semibold text-center">回数</th>
              <th className="border-b border-gray-200 px-2 py-1 font-semibold text-center">日割区分</th>
              <th className="border-b border-gray-200 px-2 py-1 font-semibold text-right">単位数</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, mask, inPeriod, pausedDay, count, kubun, fullUnits, units }) => {
              const k = kindOf(item);
              const self = k === "自費" || k === "特価自費";
              return (
                <tr key={item.id} className="border-b border-dashed border-gray-200">
                  <td className={`sticky left-0 z-10 bg-white border-r border-gray-200 px-2 py-1 border-l-4 ${self ? "border-l-orange-400" : "border-l-emerald-400"}`}>
                    <div className="flex items-center gap-1 min-w-0">
                      <span className={`text-[10px] px-1.5 rounded-full shrink-0 ${self ? "bg-orange-100 text-orange-700" : "bg-emerald-100 text-emerald-700"}`}>{k ?? "—"}</span>
                      <span className="truncate max-w-[14rem]" title={nameOf(item)}>{nameOf(item)}</span>
                    </div>
                  </td>
                  {days.map((d) => {
                    const on = mask[d];
                    const off = inPeriod[d] && !on; // 貸与期間内だが 休止・入院で除いた日
                    return (
                      <td key={d} className={`text-center tabular-nums py-1 ${d === 16 ? "border-l-2 border-l-gray-300" : ""} ${on ? (self ? "bg-orange-50 text-orange-700" : "bg-emerald-50 text-emerald-700") : off ? "bg-gray-100 text-gray-400" : ""}`}
                        title={off ? (pausedDay(d) ? "休止" : "入院") : undefined}>
                        {on ? "1" : off ? (pausedDay(d) ? "休" : "入") : ""}
                      </td>
                    );
                  })}
                  <td className="text-center border-l border-gray-200 px-2 tabular-nums">{count}</td>
                  <td className={`text-center px-2 ${kubun === "半額" ? "text-amber-700 font-semibold" : "text-gray-600"}`}>{kubun}</td>
                  <td className="text-right px-2 tabular-nums whitespace-nowrap" title={`月額 ¥${priceOf(item).toLocaleString()} / 満額 ${fullUnits} 単位${(item.quantity || 1) > 1 ? ` × 数量 ${item.quantity}` : ""}`}>
                    {units.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            {(["介護", "自費"] as const).map((g) => {
              const rs = rows.filter((r) => { const k = kindOf(r.item); return g === "自費" ? (k === "自費" || k === "特価自費") : !(k === "自費" || k === "特価自費"); });
              if (rs.length === 0) return null;
              return (
                <tr key={g} className="bg-gray-50 font-semibold">
                  <td className="sticky left-0 z-10 bg-gray-50 px-2 py-1 border-r border-gray-200">{g === "介護" ? "介護レンタル 合計" : "自費レンタル 合計"}</td>
                  <td colSpan={nDays + 2} />
                  <td className="text-right px-2 tabular-nums whitespace-nowrap">{rs.reduce((s, r) => s + r.units, 0).toLocaleString()} 単位</td>
                </tr>
              );
            })}
          </tfoot>
        </table>
      </div>
      <p className="text-[10px] text-gray-400 px-1">
        1 = 貸与日 / 休 = 休止 / 入 = 入院 (どちらも貸与日に数えない)。日割区分は 前半 (1〜15日)・後半 (16日〜) の両方に貸与日があれば全額、片方だけなら半額。単位数 = 月額 ÷ 10 (半額は半分) × 数量。予定と実績は同じ (当システムは実績のみ持つ)。
      </p>
    </div>
  );
}
