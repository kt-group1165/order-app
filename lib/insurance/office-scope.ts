/**
 * 保険・認定・公費・負担割合を「事業所ごと」に持つ (DESIGN_INSURANCE_PER_OFFICE.md §3.2) — order-app 側。
 *
 *   offices.insurance_scope
 *     'per_office' (切替済み) … その事業所の行 (office_id = 自事業所) だけを使う。無ければ「認定なし」(請求に出さない)
 *     'shared'     (未切替)   … 今の動きのまま。ただし per_office の事業所の行は候補から外す (規則 3)
 *   office_id が NULL の行 (事業所未定) は shared のときだけ候補に入る。per_office では使わない (参考表示・複写のみ)。
 *
 * ★ per_office の事業所が 0 のときは何も絞らない (= 今の動きと 1 行も変わらない)。
 * kaigo-app 側は src/lib/insurance/office-scope.ts (kaigo の事業所は当面すべて shared なので 規則 3 だけ)。
 */
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
export { isPerOffice, rowsForOffice, ownerKind, copyRowForOffice } from "./office-scope-rules";

/** insurance_scope = 'per_office' の事業所 id (全 tenant。読めなければ空 = 絞らない + console.error) */
export async function loadPerOfficeOfficeIds(): Promise<string[]> {
  const { data, error } = await supabase.from("offices").select("id").eq("insurance_scope", "per_office");
  if (error) {
    console.error("offices.insurance_scope を読めない (事業所別の保険の切替を見ずに続ける):", error.message);
    return [];
  }
  return ((data ?? []) as { id: string }[]).map((r) => r.id).sort();
}

/** 画面用: per_office の事業所 id を読む (読めなければ空) */
export function usePerOfficeIds(): string[] {
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadPerOfficeOfficeIds().then((r) => { if (!cancelled) setIds(r); });
    return () => { cancelled = true; };
  }, []);
  return ids;
}

