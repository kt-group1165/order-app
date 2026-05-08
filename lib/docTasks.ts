import { supabase, DocTask, DocTaskTriggerType } from "./supabase";

/** 書類タスク fetch (office × pending のみ)。office_id NULL は対象外。 */
export async function getPendingDocTasks(
  tenantId: string,
  officeIds: string[] | null,
): Promise<DocTask[]> {
  const PAGE = 1000;
  const all: DocTask[] = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from("doc_tasks")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .order("trigger_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (officeIds && officeIds.length > 0) q = q.in("office_id", officeIds);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as DocTask[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/** doc_task を completed にして linked_document_id をセット。
 *  (trigger 由来 doc_task のみ。仮想 cert_renewal task は client 側で INSERT 後に呼ぶ) */
export async function completeDocTask(
  taskId: string,
  linkedDocumentId: string,
): Promise<void> {
  const { error } = await supabase
    .from("doc_tasks")
    .update({
      status: "completed",
      linked_document_id: linkedDocumentId,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) throw error;
}

/** 仮想 cert_renewal task を実体化 INSERT (UI で「書類を作る」押下時) */
export async function insertCertRenewalTask(input: {
  tenantId: string;
  officeId: string;
  clientId: string;
  insuranceRecordId: string;
  certEndDate: string; // YYYY-MM-DD
  expectedDocType: string;
}): Promise<DocTask | null> {
  const { tenantId, officeId, clientId, insuranceRecordId, certEndDate, expectedDocType } = input;
  const { data, error } = await supabase
    .from("doc_tasks")
    .upsert(
      {
        tenant_id: tenantId,
        office_id: officeId,
        client_id: clientId,
        trigger_type: "cert_renewal" as DocTaskTriggerType,
        trigger_ref_id: insuranceRecordId,
        trigger_ref_table: "client_insurance_records",
        trigger_label: `認定更新 ${certEndDate}`,
        trigger_date: certEndDate,
        expected_doc_type: expectedDocType,
        due_date: certEndDate,
      },
      { onConflict: "trigger_type,trigger_ref_id,expected_doc_type", ignoreDuplicates: false },
    )
    .select()
    .single();
  if (error) {
    console.error("insertCertRenewalTask error:", error);
    return null;
  }
  return data as DocTask;
}
