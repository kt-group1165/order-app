// 書類タスク ⇔ 既存書類の照合 (pure。supabase に依存しない)
// lib/docTasks.ts (UI) と migrations/complete_doc_tasks_from_existing_docs.mts (是正 script) の
// 両方から使う。逐語コピーで二重に持つと片方だけ直したときに乖離するため 1 箇所に置く。
import type { ClientDocument, DocTask } from "./supabase";

/** 契約書 (rental_contract) ⇔ 追加契約書 (change_contract) は同一 trigger では二者択一。
 *  一方を completed にすると対になる pending task を cancel する (completeDocTask)。 */
export const PAIRED_DOC_TYPES: Record<string, string> = {
  rental_contract: "change_contract",
  change_contract: "rental_contract",
};

/** expected_doc_type → それを満たす client_documents.type の一覧。
 *  rental_contract task は実 type が contract (統合後) / rental_contract / important_matters (旧) のいずれか。 */
export function docTypesSatisfying(expectedDocType: string): string[] {
  return expectedDocType === "rental_contract"
    ? ["contract", "rental_contract", "important_matters"]
    : [expectedDocType];
}

/** client_documents.created_at (timestamptz) → JST の暦日 YYYY-MM-DD */
function jstYmd(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(0, 10);
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** pending task に対して「既に作成済みの書類」を探す (pure)。
 *
 *  B-2n (2026-10-15): 書類タスクは「書類タスク → 書類を作る」経由でしか完了しなかった。
 *  利用者タブ・書類タブから直接作った書類や、発注メールで自動保存された書類は
 *  task に結び付かず pending のまま残る。ここで候補を出し、UI で人が確認して紐付ける。
 *
 *  - supplier_email: 同じ発注 (params.orderId = trigger_ref_id) の「発注メール」(new_order) のみ。
 *      レンタル開始通知・解約通知 (emailType=rental_started/terminated) も type=supplier_email
 *      だが発注書ではないので対象外。
 *  - その他: 同じ利用者 × 対応する type × 作成日 (JST) が trigger_date 以降。最新を返す。
 */
export function findExistingDocForTask(
  task: Pick<DocTask, "client_id" | "trigger_type" | "trigger_ref_id" | "trigger_date" | "expected_doc_type">,
  docs: Pick<ClientDocument, "id" | "client_id" | "type" | "created_at" | "params">[],
): Pick<ClientDocument, "id" | "client_id" | "type" | "created_at" | "params"> | null {
  if (task.expected_doc_type === "supplier_email") {
    if (task.trigger_type !== "order_placed") return null;
    for (const d of docs) {
      if (d.type !== "supplier_email") continue;
      const p = (d.params ?? {}) as Record<string, unknown>;
      if (p.orderId !== task.trigger_ref_id) continue;
      const emailType = typeof p.emailType === "string" ? p.emailType : "new_order";
      if (emailType !== "new_order") continue;
      return d;
    }
    return null;
  }
  const types = docTypesSatisfying(task.expected_doc_type);
  let best: Pick<ClientDocument, "id" | "client_id" | "type" | "created_at" | "params"> | null = null;
  for (const d of docs) {
    if (d.client_id !== task.client_id) continue;
    if (!types.includes(d.type)) continue;
    if (jstYmd(d.created_at) < task.trigger_date) continue;
    if (!best || d.created_at > best.created_at) best = d;
  }
  return best;
}

