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
      {/* ほのぼのの提供票に合わせて詰めた表: 左に 用具・数量・単位数・日割区分・回数、右に 1〜末日 (2026-11-11) */}
      <div className="overflow-x-auto">
        <table className="text-[11px] leading-tight border-collapse bg-white border border-gray-300 w-max">
          <thead>
            <tr className="bg-gray-100 text-gray-600">
              <th rowSpan={2} className="sticky left-0 z-10 bg-gray-100 border border-gray-300 px-1.5 font-semibold text-left w-[15rem]">サービス内容 (用具)</th>
              <th rowSpan={2} className="border border-gray-300 px-1 font-semibold">数量</th>
              <th rowSpan={2} className="border border-gray-300 px-1 font-semibold">単位数</th>
              <th rowSpan={2} className="border border-gray-300 px-1 font-semibold">日割<br />区分</th>
              <th rowSpan={2} className="border border-gray-300 px-1 font-semibold">回数</th>
              {days.map((d) => (
                <th key={d} className={`border border-gray-300 w-5 min-w-[1.25rem] px-0 font-normal tabular-nums ${dow(d) === 0 ? "text-rose-500 bg-rose-50" : dow(d) === 6 ? "text-blue-500 bg-blue-50" : ""} ${d === 16 ? "border-l-2 border-l-gray-500" : ""}`}>{d}</th>
              ))}
            </tr>
            <tr className="bg-gray-100 text-gray-500">
              {days.map((d) => (
                <th key={d} className={`border border-gray-300 px-0 font-normal text-[10px] ${dow(d) === 0 ? "text-rose-500 bg-rose-50" : dow(d) === 6 ? "text-blue-500 bg-blue-50" : ""} ${d === 16 ? "border-l-2 border-l-gray-500" : ""}`}
                  title={hospMask[d] ? "入院中" : undefined}>
                  {hospMask[d] ? <span className="text-rose-600 font-semibold">入</span> : DOW[dow(d)]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, mask, inPeriod, pausedDay, count, kubun, fullUnits, units }) => {
              const k = kindOf(item);
              const self = k === "自費" || k === "特価自費";
              return (
                <tr key={item.id} className="hover:bg-yellow-50">
                  <td className={`sticky left-0 z-10 bg-white border border-gray-300 px-1.5 py-0.5 border-l-4 ${self ? "border-l-orange-400" : "border-l-emerald-400"}`}>
                    <div className="flex items-center gap-1 min-w-0 w-[14rem]">
                      {self && <span className="text-[9px] px-1 rounded bg-orange-100 text-orange-700 shrink-0">{k}</span>}
                      <span className="truncate" title={nameOf(item)}>{nameOf(item)}</span>
                    </div>
                  </td>
                  <td className="border border-gray-300 px-1 text-center tabular-nums">{item.quantity || 1}</td>
                  <td className="border border-gray-300 px-1 text-right tabular-nums" title={`月額 ¥${priceOf(item).toLocaleString()} / 満額 ${fullUnits} 単位`}>{units.toLocaleString()}</td>
                  <td className={`border border-gray-300 px-1 text-center ${kubun === "半額" ? "text-amber-700 font-semibold" : ""}`}>{kubun}</td>
                  <td className="border border-gray-300 px-1 text-center tabular-nums">{count}</td>
                  {days.map((d) => {
                    const on = mask[d];
                    const off = inPeriod[d] && !on; // 貸与期間内だが 休止・入院で除いた日
                    return (
                      <td key={d} className={`border border-gray-200 px-0 text-center tabular-nums ${d === 16 ? "border-l-2 border-l-gray-500" : ""} ${off ? "bg-gray-100 text-gray-400" : dow(d) === 0 ? "bg-rose-50/60" : dow(d) === 6 ? "bg-blue-50/60" : ""}`}
                        title={off ? (pausedDay(d) ? "休止" : "入院") : undefined}>
                        {on ? "1" : off ? (pausedDay(d) ? "休" : "入") : ""}
                      </td>
                    );
                  })}
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
                  <td className="sticky left-0 z-10 bg-gray-50 border border-gray-300 px-1.5 py-0.5">{g === "介護" ? "介護 合計" : "自費 合計"}</td>
                  <td className="border border-gray-300" />
                  <td className="border border-gray-300 px-1 text-right tabular-nums whitespace-nowrap">{rs.reduce((s, r) => s + r.units, 0).toLocaleString()}</td>
                  <td colSpan={2 + nDays} className="border border-gray-300 px-1 text-gray-500 font-normal">単位</td>
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
