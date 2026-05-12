import { supabase, CarePlanElement } from "./supabase";

/** client の care_plan_elements 全件取得 (新しい順、completed 込みで灰色表示用)。 */
export async function getCarePlanElementsByClient(
  clientId: string,
): Promise<CarePlanElement[]> {
  const PAGE = 1000;
  const all: CarePlanElement[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("care_plan_elements")
      .select("*")
      .eq("client_id", clientId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as CarePlanElement[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/** 複数 element を completed にして linked_care_plan_id をセット。
 *  計画書保存時にまとめて呼ぶ。 */
export async function completeCarePlanElements(
  elementIds: string[],
  linkedCarePlanId: string,
): Promise<void> {
  if (elementIds.length === 0) return;
  const { error } = await supabase
    .from("care_plan_elements")
    .update({
      status: "completed",
      linked_care_plan_id: linkedCarePlanId,
      completed_at: new Date().toISOString(),
    })
    .in("id", elementIds);
  if (error) throw error;
}

/** element_type → 計画書冒頭チェックボックスのラベル */
export const CARE_PLAN_ELEMENT_LABEL: Record<CarePlanElement["element_type"], string> = {
  new_delivery: "新規納品",
  additional_delivery: "追加納品",
  pickup: "回収",
  plan_renewal: "プラン更新",
  plan_change: "プラン変更",
  care_office_change: "その他",
};

/** element の人間向け説明 (UI 表示用)。detail に応じて文言生成。 */
export function describeCarePlanElement(e: CarePlanElement): string {
  const d = e.detail ?? {};
  switch (e.element_type) {
    case "new_delivery":
    case "additional_delivery":
      return `${CARE_PLAN_ELEMENT_LABEL[e.element_type]}: ${d.equipment_name ?? d.product_code ?? "(用具不明)"}`;
    case "pickup":
      return `回収: ${d.equipment_name ?? d.product_code ?? "(用具不明)"}`;
    case "plan_renewal":
      return `プラン更新: ${d.from_care_level ?? "?"} → ${d.to_care_level ?? "?"}`;
    case "plan_change":
      return `プラン変更: ${d.from_care_level ?? "?"} → ${d.to_care_level ?? "?"}`;
    case "care_office_change":
      return `居宅事業所変更: ${d.from_care_office_name ?? "(無し)"} → ${d.to_care_office_name ?? "(無し)"}`;
    default:
      return e.element_type;
  }
}

/** 自由記述用「その他」欄に流す文言。care_office_change のみ生成、他は空文字。 */
export function buildOtherFreeText(elements: CarePlanElement[]): string {
  return elements
    .filter((e) => e.element_type === "care_office_change")
    .map((e) => {
      const d = e.detail ?? {};
      return `居宅事業所変更: ${d.from_care_office_name ?? "(無し)"} → ${d.to_care_office_name ?? "(無し)"}`;
    })
    .join(" / ");
}
