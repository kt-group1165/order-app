import { supabase, DocTask, DocTaskStatus, DocTaskTriggerType } from "./supabase";

/** 書類タスク fetch (office × pending のみ)。office_id NULL は対象外。 */
export async function getPendingDocTasks(
  tenantId: string,
  officeIds: string[] | null,
): Promise<DocTask[]> {
  return getDocTasks(tenantId, officeIds, ["pending"]);
}

/** 書類タスク fetch (任意 status filter)。
 *  v3: 受領管理 UI のため status 複数指定 fetch を提供。
 *  - statuses=null or 空配列 のときは「cancelled 以外 + merged_into_task_id IS NULL」をデフォで取る (= active rows) */
export async function getDocTasks(
  tenantId: string,
  officeIds: string[] | null,
  statuses: DocTaskStatus[] | null,
): Promise<DocTask[]> {
  const PAGE = 1000;
  const all: DocTask[] = [];
  let from = 0;
  // 統合された子 task は表示対象から除外したいので、fetch 時に弾く
  while (true) {
    let q = supabase
      .from("doc_tasks")
      .select("*")
      .eq("tenant_id", tenantId)
      .is("merged_into_task_id", null)
      .order("trigger_date", { ascending: true })
      .range(from, from + PAGE - 1);
    if (statuses && statuses.length > 0) {
      q = q.in("status", statuses);
    } else {
      q = q.neq("status", "cancelled");
    }
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
 *  (trigger 由来 doc_task のみ。仮想 cert_renewal task は client 側で INSERT 後に呼ぶ)
 *
 *  契約書 (rental_contract) ⇔ 追加契約書 (change_contract) は同一 trigger では
 *  二者択一の関係 (どちらか作成すればもう一方は不要)。一方を completed にすると
 *  対になる pending task を auto-cancel する。
 */
const PAIRED_DOC_TYPES: Record<string, string> = {
  rental_contract: "change_contract",
  change_contract: "rental_contract",
};

export async function completeDocTask(
  taskId: string,
  linkedDocumentId: string,
): Promise<void> {
  // 1. 完了対象 task の trigger / doc_type を取得 (排他処理用)
  const { data: task, error: fetchErr } = await supabase
    .from("doc_tasks")
    .select("trigger_type, trigger_ref_id, expected_doc_type")
    .eq("id", taskId)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  // 2. 当該 task を completed に
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("doc_tasks")
    .update({
      status: "completed",
      linked_document_id: linkedDocumentId,
      completed_at: now,
      updated_at: now,
    })
    .eq("id", taskId);
  if (error) throw error;

  // 3. 排他: 同一 trigger の対 doc_type の pending task を cancelled に
  if (task && task.trigger_type && task.trigger_ref_id) {
    const pairedType = PAIRED_DOC_TYPES[task.expected_doc_type];
    if (pairedType) {
      await supabase
        .from("doc_tasks")
        .update({
          status: "cancelled",
          cancelled_at: now,
          updated_at: now,
        })
        .eq("trigger_type", task.trigger_type)
        .eq("trigger_ref_id", task.trigger_ref_id)
        .eq("expected_doc_type", pairedType)
        .eq("status", "pending");
    }
  }
}

/** v3: completed の task を received にする。
 *  receivedBy は受領者氏名 (free text)。空文字も許容するが UI 側で必須にする。 */
export async function markDocTaskReceived(
  taskId: string,
  receivedBy: string,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("doc_tasks")
    .update({
      status: "received",
      received_at: now,
      received_by: receivedBy,
      updated_at: now,
    })
    .eq("id", taskId)
    .eq("status", "completed"); // race-condition guard
  if (error) throw error;
}

/** v3: 同 client × 同 expected_doc_type の近接 task を 1 つに統合する。
 *  - sourceIds の各 task を cancelled にし merged_into_task_id=targetId をセット
 *  - target はそのまま (UI 側で状態保存するなら別途 completeDocTask 呼ぶ) */
export async function mergeDocTasks(
  targetId: string,
  sourceIds: string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("doc_tasks")
    .update({
      status: "cancelled",
      merged_into_task_id: targetId,
      cancelled_at: now,
      updated_at: now,
    })
    .in("id", sourceIds);
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

/** v3: 統合候補の判定。
 *  仕様: 同 client × 同 expected_doc_type × pending な doc_task 群について
 *    - 14 日以内
 *    - 同月内 (year+month 一致)
 *    - 1 つ目が pending or completed (= 未受領)
 *    のとき統合可能。
 *
 *  ここでは「両方 pending」ペアの検出に絞る (UI 簡素化)。
 *  検出キー: client_id + expected_doc_type。各グループ内で trigger_date 昇順に並べ、
 *  連続 2 件が条件満たすペアを返す。
 */
export type MergeCandidateGroup = {
  clientId: string;
  expectedDocType: string;
  taskIds: string[]; // 2 件以上 (時系列順)
};

export function findMergeCandidates(tasks: DocTask[]): MergeCandidateGroup[] {
  // pending の task を client × expected_doc_type でグルーピング
  const groups = new Map<string, DocTask[]>();
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const key = `${t.client_id}|${t.expected_doc_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  const out: MergeCandidateGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.trigger_date.localeCompare(b.trigger_date));
    // 連続するペアで条件 check し、満たすものを 1 グループに膨らませる
    const merged: DocTask[] = [list[0]];
    for (let i = 1; i < list.length; i += 1) {
      const prev = merged[merged.length - 1];
      const curr = list[i];
      const prevDate = new Date(prev.trigger_date);
      const currDate = new Date(curr.trigger_date);
      const diffDays = Math.abs((currDate.getTime() - prevDate.getTime()) / (24 * 3600 * 1000));
      const sameMonth =
        prev.trigger_date.slice(0, 7) === curr.trigger_date.slice(0, 7);
      if (diffDays <= 14 && sameMonth) {
        merged.push(curr);
      } else {
        if (merged.length >= 2) {
          out.push({
            clientId: prev.client_id,
            expectedDocType: prev.expected_doc_type,
            taskIds: merged.map((m) => m.id),
          });
        }
        merged.length = 0;
        merged.push(curr);
      }
    }
    if (merged.length >= 2) {
      const first = merged[0];
      out.push({
        clientId: first.client_id,
        expectedDocType: first.expected_doc_type,
        taskIds: merged.map((m) => m.id),
      });
    }
  }
  return out;
}
