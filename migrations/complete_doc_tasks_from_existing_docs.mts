/**
 * 書類タスク (doc_tasks) のうち「書類は既に client_documents にあるのに pending のまま」の行を
 * completed にする是正 script (DECISIONS_PENDING B-2n / 2026-10-15)。
 *
 * 背景:
 *   - supplier_email (発注書) は発注メール送信で client_documents に保存されるが、
 *     doc_tasks を完了にする処理が無く、誰がやっても永久に pending だった (コードは修正済み)。
 *   - 他の 4 種も「書類タスク → 書類を作る」経由でしか完了しなかったので、
 *     利用者タブ・書類タブから直接作った書類は task に結び付いていない。
 *
 * 照合ロジックは UI と同じ lib/docTaskMatch.ts の findExistingDocForTask を使う (逐語コピーしない)。
 *
 * 2 段階に分ける:
 *   確実    supplier_email × 同じ発注 (params.orderId = trigger_ref_id) の発注メール書類
 *           → --execute で完了にする
 *   推定    その他の種類 × 同じ利用者 × 対応 type × 作成日 >= trigger_date
 *           (1 つの書類がどの発生要因 (どの品目のレンタル開始等) に対するものかは判定できない)
 *           → --include-heuristic を付けたときだけ完了にする。既定は一覧表示のみ
 *
 * completed にした行は linked_document_id に書類 id が入る。対 (rental_contract ⇔ change_contract) の
 * pending は completeDocTask と同じく cancelled にする。
 * doc_tasks に notes 列は無いので、マーカーの代わりに実行前の行を backup JSON に保存する
 * (元に戻すときは backup の status / linked_document_id / completed_at / cancelled_at / updated_at を書き戻す)。
 *
 * Usage (apps/order-app で):
 *   npx tsx migrations/complete_doc_tasks_from_existing_docs.mts                                   # DRY RUN
 *   npx tsx migrations/complete_doc_tasks_from_existing_docs.mts --execute                         # 確実のみ
 *   npx tsx migrations/complete_doc_tasks_from_existing_docs.mts --execute --include-heuristic     # 推定も
 *
 * ⚠ 2026-05-20 の一括 backfill (rental_started × 4 種 × 1,056 件) を ★ 一括で取り消す処理はしない。
 *   旧システムで紙の書類を作っていた既存利用者ぶんで、書類が DB に無いのは当然のため。
 *   消す / 取り消すかは user 判断 (B-2n「決めていただきたいこと」3)。件数だけ表示する。
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { findExistingDocForTask, PAIRED_DOC_TYPES } from "../lib/docTaskMatch";
import type { ClientDocument, DocTask } from "../lib/supabase";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path: string): Record<string, string> {
  try {
    const env = readFileSync(path, "utf8");
    const vars: Record<string, string> = {};
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(/^([^=]+)=(.+)$/);
      if (m) vars[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return vars;
  } catch {
    return {};
  }
}
const envOrder = loadEnvFile(join(__dirname, "..", ".env.local"));
const envKaigo = loadEnvFile(join(__dirname, "..", "..", "kaigo-app", ".env.local"));
const SB_URL = envOrder.NEXT_PUBLIC_SUPABASE_URL || envKaigo.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = envOrder.SUPABASE_SERVICE_ROLE_KEY || envKaigo.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error("❌ SUPABASE URL / SERVICE_ROLE_KEY が読めません");
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const EXECUTE = process.argv.includes("--execute");
const INCLUDE_HEURISTIC = process.argv.includes("--include-heuristic");
const BACKFILL_DAY = "2026-05-20";

type DocLite = Pick<ClientDocument, "id" | "client_id" | "type" | "title" | "created_at" | "params">;

async function fetchAll<T>(table: string, select: string, filter: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(sb.from(table).select(select)).order("id").range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 取得失敗: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const tasks = await fetchAll<DocTask>("doc_tasks", "*", (q) => q.eq("status", "pending").is("merged_into_task_id", null));
const docs = await fetchAll<DocLite>("client_documents", "id, client_id, type, title, created_at, params", (q) => q.neq("type", "rental_report"));
console.log(`母数: pending かつ未統合の doc_tasks ${tasks.length} 件 / client_documents (rental_report 除く) ${docs.length} 件`);

const backfill = tasks.filter((t) => t.created_at.slice(0, 10) === BACKFILL_DAY);
console.log(`  うち ${BACKFILL_DAY} の一括 backfill: ${backfill.length} 件 (一括で取り消す処理はしない。書類が見つかった行だけ下に「推定」として出る)`);

const docsByClient = new Map<string, DocLite[]>();
for (const d of docs) {
  if (!docsByClient.has(d.client_id)) docsByClient.set(d.client_id, []);
  docsByClient.get(d.client_id)!.push(d);
}

type Hit = { task: DocTask; doc: DocLite; kind: "確実" | "推定" };
const hits: Hit[] = [];
for (const t of tasks) {
  const doc = findExistingDocForTask(t, docsByClient.get(t.client_id) ?? []);
  if (!doc) continue;
  hits.push({ task: t, doc: doc as DocLite, kind: t.expected_doc_type === "supplier_email" ? "確実" : "推定" });
}

const sure = hits.filter((h) => h.kind === "確実");
const guess = hits.filter((h) => h.kind === "推定");
console.log(`\n書類が既にある pending task: ${hits.length} 件 (確実 ${sure.length} / 推定 ${guess.length})`);
for (const h of hits) {
  console.log(
    `  [${h.kind}] task ${h.task.id} ${h.task.trigger_type}×${h.task.expected_doc_type} trigger_date=${h.task.trigger_date}` +
      ` client=${h.task.client_id}\n          → doc ${h.doc.id} type=${h.doc.type} ${h.doc.created_at.slice(0, 10)} 「${h.doc.title}」`,
  );
}

const targets = INCLUDE_HEURISTIC ? hits : sure;
// 同じ trigger の対 (rental_contract ⇔ change_contract) で両方とも完了候補になる場合は先勝ちにする
const targetIds = new Set(targets.map((h) => h.task.id));
const pairCancels: DocTask[] = [];
for (const h of targets) {
  const paired = PAIRED_DOC_TYPES[h.task.expected_doc_type];
  if (!paired) continue;
  for (const t of tasks) {
    if (t.trigger_type === h.task.trigger_type && t.trigger_ref_id === h.task.trigger_ref_id && t.expected_doc_type === paired && !targetIds.has(t.id)) {
      pairCancels.push(t);
    }
  }
}

console.log(`\n実行対象: completed ${targets.length} 件 / 対の取消 (cancelled) ${pairCancels.length} 件` +
  (INCLUDE_HEURISTIC ? " (--include-heuristic: 推定も含む)" : " (確実のみ。推定も入れるなら --include-heuristic)"));

if (!EXECUTE) {
  console.log("\nDRY RUN — DB は変更していません。実行するには --execute");
  process.exit(0);
}
if (targets.length === 0) {
  console.log("対象 0 件。何もしません。");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = join(__dirname, `_backup_doc_tasks_complete_${stamp}.json`);
writeFileSync(backupPath, JSON.stringify({ completed: targets.map((h) => h.task), cancelled: pairCancels }, null, 2));
console.log(`backup: ${backupPath}`);

const now = new Date().toISOString();
let done = 0;
let cancelled = 0;
for (const h of targets) {
  const { data, error } = await sb
    .from("doc_tasks")
    .update({ status: "completed", linked_document_id: h.doc.id, completed_at: now, updated_at: now })
    .eq("id", h.task.id)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(`完了失敗 ${h.task.id}: ${error.message}`);
  done += data?.length ?? 0;
}
for (const t of pairCancels) {
  const { data, error } = await sb
    .from("doc_tasks")
    .update({ status: "cancelled", cancelled_at: now, updated_at: now })
    .eq("id", t.id)
    .eq("status", "pending")
    .select("id");
  if (error) throw new Error(`取消失敗 ${t.id}: ${error.message}`);
  cancelled += data?.length ?? 0;
}
console.log(`完了 ${done}/${targets.length} 件・取消 ${cancelled}/${pairCancels.length} 件`);

// 件数確認 (書いた結果を読み直す)
const ids = [...targets.map((h) => h.task.id), ...pairCancels.map((t) => t.id)];
const { data: after, error: afterErr } = await sb.from("doc_tasks").select("id, status, linked_document_id").in("id", ids);
if (afterErr) throw new Error(`確認失敗: ${afterErr.message}`);
const stillPending = (after ?? []).filter((r) => r.status === "pending").length;
console.log(`確認: 対象 ${ids.length} 件中 まだ pending ${stillPending} 件`);
if (stillPending > 0) process.exit(2);
