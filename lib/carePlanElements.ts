import { supabase, CarePlanElement } from "./supabase";

/** 仮想 cert_renewal 要素の id prefix (DB 永続化されない一時要素を識別) */
export const VIRTUAL_CERT_RENEWAL_PREFIX = "virtual:cert_renewal:";

/** 仮想要素か判定 */
export function isVirtualElement(id: string): boolean {
  return id.startsWith(VIRTUAL_CERT_RENEWAL_PREFIX);
}

/** 仮想要素から insurance_record_id を抽出 */
export function parseVirtualInsuranceId(id: string): string | null {
  if (!id.startsWith(VIRTUAL_CERT_RENEWAL_PREFIX)) return null;
  return id.slice(VIRTUAL_CERT_RENEWAL_PREFIX.length);
}

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
      // 日付は新しい順、同日内は INSERT 順 (作業順: 新規 → 追加 → 回収)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as CarePlanElement[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/** 認定終了 30 日前 〜 終了日 の insurance_record で対応 care_plan 未作成のものを
 *  仮想要素 (id=virtual:cert_renewal:<insurance_id>) として返す。
 *  - DB 永続化しない、UI 表示と保存時の doc_task 連携用
 *  - 既に doc_tasks WHERE trigger_type='cert_renewal' AND status='completed' があれば除外 */
export async function getCertRenewalVirtuals(
  clientId: string,
  tenantId: string,
  officeId: string,
): Promise<CarePlanElement[]> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const horizonDate = new Date(today.getTime() + 30 * 86400000);
  const horizonStr = horizonDate.toISOString().slice(0, 10);

  // 認定終了 30 日前以内の record
  const { data: records, error: recErr } = await supabase
    .from("client_insurance_records")
    .select("id, care_level, certification_start_date, certification_end_date, effective_date")
    .eq("client_id", clientId)
    .gte("certification_end_date", todayStr)
    .lte("certification_end_date", horizonStr);
  if (recErr) throw recErr;
  if (!records || records.length === 0) return [];

  // 既に完了済の cert_renewal doc_task がある insurance_id を除外
  const insuranceIds = records.map((r) => r.id);
  const { data: tasks, error: taskErr } = await supabase
    .from("doc_tasks")
    .select("trigger_ref_id, status")
    .eq("trigger_type", "cert_renewal")
    .eq("expected_doc_type", "care_plan")
    .in("trigger_ref_id", insuranceIds);
  if (taskErr) throw taskErr;
  const completedSet = new Set(
    (tasks ?? []).filter((t) => t.status === "completed" || t.status === "received").map((t) => t.trigger_ref_id),
  );

  return records
    .filter((r) => !completedSet.has(r.id) && r.certification_end_date)
    .map((r) => ({
      id: `${VIRTUAL_CERT_RENEWAL_PREFIX}${r.id}`,
      tenant_id: tenantId,
      office_id: officeId,
      client_id: clientId,
      occurred_at: r.certification_end_date as string,
      element_type: "plan_renewal" as const,
      ref_table: "client_insurance_records",
      ref_id: r.id,
      detail: {
        from_care_level: r.care_level,
        to_care_level: null,
        cert_start: r.certification_start_date,
        cert_end: r.certification_end_date,
        virtual: true,
      },
      status: "pending" as const,
      linked_care_plan_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    }));
}

/** 複数 element を completed にして linked_care_plan_id をセット。
 *  計画書保存時にまとめて呼ぶ (仮想要素 id は事前に除外しておくこと)。 */
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
      if (d.virtual) {
        return `プラン更新（認定終了予定: ${d.cert_end ?? "?"}）`;
      }
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
