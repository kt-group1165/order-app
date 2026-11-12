// 福祉用具貸与の「月の算定単位」を計算する材料 (日割り設定 / 休止 / 入院) をまとめて読む (2026-11-12)
//   請求 (BillingTab)・伝送・利用請求 (UserBillingTab)・利用者向け請求書・貸与報告書 で同じ材料を使うため。
//   計算そのものは lib/half-month-units.ts の rentalMonthUnits。
//   ⚠ どれかが読めないときは その分を除かずに計算し、notices に理由を 1 行ずつ入れる (黙って違う額にしない)
import { useEffect, useState } from "react";
import { supabase, type ClientHospitalization } from "./supabase";
import { hospitalizationRanges, type DateRange, type ProrationMode } from "./half-month-units";
import { loadProrations, prorationModeOf, type ProrationLoad } from "./orderItemProration";
import { loadOrderItemPauses, type PausesLoad } from "./fukuyoguPauses";

export type RentalCalcContext = {
  prorations: ProrationLoad | null;
  pauses: PausesLoad | null;
  hospitalizations: ClientHospitalization[];
  notices: string[];
};

/** 明細 × 月の算定方法 (表が無い/行が無い = auto) */
export function modeOf(ctx: RentalCalcContext | null | undefined, orderItemId: string, ym: string): ProrationMode {
  return prorationModeOf(ctx?.prorations, orderItemId, ym);
}

/** 貸与日から除く日 (その利用者の入院 + その明細の休止) */
export function excludedOf(ctx: RentalCalcContext | null | undefined, clientId: string | null | undefined, orderItemId: string): DateRange[] {
  if (!ctx) return [];
  return [
    ...hospitalizationRanges(ctx.hospitalizations.filter((h) => h.client_id === clientId)),
    ...(ctx.pauses?.byItem.get(orderItemId) ?? []),
  ];
}

/** テナントの 日割り設定 / 休止 / 入院 を読む。失敗しても throw しない (notices に理由) */
export async function loadRentalCalcContext(tenantId: string): Promise<RentalCalcContext> {
  const notices: string[] = [];
  const [prorations, pauses, hospitalizations] = await Promise.all([
    loadProrations(tenantId).catch((e: unknown) => {
      console.error("日割り設定の読込失敗:", e);
      notices.push(`日割り設定を読めませんでした (${e instanceof Error ? e.message : String(e)}) — 全件 半月按分の自動で計算しています`);
      return null;
    }),
    loadOrderItemPauses(tenantId),
    (async () => {
      const out: ClientHospitalization[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("client_hospitalizations").select("*").eq("tenant_id", tenantId).order("id").range(from, from + 999);
        if (error) {
          console.error("client_hospitalizations 読込失敗:", error.message);
          notices.push(`入院記録を読めませんでした (${error.message}) — 入院日を除かずに計算しています`);
          return [];
        }
        out.push(...((data ?? []) as ClientHospitalization[]));
        if (!data || data.length < 1000) return out;
      }
    })(),
  ]);
  if (prorations?.notice) notices.push(prorations.notice);
  if (!pauses.available && pauses.message) notices.push(pauses.message);
  return { prorations, pauses, hospitalizations, notices };
}

/** 画面用: テナントの材料を 1 回読む。読み終わるまで null */
export function useRentalCalcContext(tenantId: string): RentalCalcContext | null {
  const [ctx, setCtx] = useState<RentalCalcContext | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadRentalCalcContext(tenantId).then((c) => { if (!cancelled) setCtx(c); });
    return () => { cancelled = true; };
  }, [tenantId]);
  return ctx;
}
