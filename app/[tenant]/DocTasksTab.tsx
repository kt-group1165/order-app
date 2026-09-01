"use client";

import { useState, useEffect, useMemo } from "react";
import { FileWarning, Loader2, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, X } from "lucide-react";
import { supabase, Client, ClientDocument, ClientInsuranceRecord, DocTask, DocTaskStatus } from "@/lib/supabase";
import { getDocTasks, insertCertRenewalTask, markDocTaskReceived, mergeDocTasks, findMergeCandidates, type MergeCandidateGroup } from "@/lib/docTasks";

// ─── DocTasksTab v3 ───────────────────────────────────────────────────────────
// v1 (commit da99236) の「client × 書類種別」計算ベースから、event-driven な
// doc_tasks table ベースに refactor (cfd252e=v2, 2026-05-09)。
// v3 (2026-05-09): 受領管理 + 同 client × 同 expected_doc_type × 14 日以内の統合機能
//
// 設計:
//   - DB trigger (migrations/order_app_doc_tasks_triggers.sql) が
//     orders.status -> 'ordered' / order_items.status -> 'rental_started' /
//     一部解約 を観測して doc_tasks を 1 row INSERT
//   - cert_renewal は cron 不要、UI 表示時に client_insurance_records から
//     on-the-fly 仮想 doc_task を生成 (DB INSERT は「書類を作る」押下時のみ)
//   - 書類作成時: doc_task.status='completed' + linked_document_id をセット
//   - 受領時:     doc_task.status='received' + received_at + received_by をセット
//   - 統合時 (v3): source.merged_into_task_id=target.id + source.status='cancelled'
//
// 統合判定 (v3):
//   - 同 client × 同 expected_doc_type × 両方 pending (= 1 つ目未受領)
//   - 14 日以内かつ同月内 (year+month 一致)
//   - banner 表示 → user click で merge modal → 統合実行
//
// expected_doc_type の正規化:
//   - supplier_email   = 発注書 (実 client_documents.type='supplier_email')
//   - rental_contract  = 契約書 (実 type は rental_contract か important_matters)
//   - change_contract  = 契約書別紙
//   - care_plan        = 個別援助計画書
//   - proposal         = 提案書

// expected_doc_type → 表示ラベル
const DOC_LABEL: Record<string, string> = {
  supplier_email: "発注書",
  rental_contract: "契約書",
  change_contract: "契約書別紙",
  care_plan: "個別援助計画書",
  proposal: "提案書",
};

const DOC_BADGE_COLOR: Record<string, string> = {
  supplier_email: "bg-blue-100 text-blue-700",
  rental_contract: "bg-orange-100 text-orange-700",
  change_contract: "bg-amber-100 text-amber-700",
  care_plan: "bg-emerald-100 text-emerald-700",
  proposal: "bg-purple-100 text-purple-700",
};

// 書類種別の固定表示順 (人ごと grouped view で使用)
const DOC_TYPE_ORDER = ["supplier_email", "rental_contract", "change_contract", "care_plan", "proposal"];

// trigger_type → 表示ラベル (フィルタ用)
const TRIGGER_LABEL: Record<string, string> = {
  order_placed: "発注",
  rental_started: "レンタル開始",
  partial_termination: "一部解約",
  cert_renewal: "認定更新",
  plan_change: "プラン変更",
  care_office_change: "居宅変更",
};

// cert_renewal で警告を出す日数 (認定終了 N 日前)
const CERT_RENEWAL_WARNING_DAYS = 30;

// 表示用 task row (DB doc_task または cert_renewal の virtual row)
type DocTaskRow = {
  id: string;                    // virtual の場合は `cert:${insurance_record_id}:${expected_doc_type}`
  isVirtual: boolean;            // true = cert_renewal の DB 未 INSERT row
  trigger_type: string;
  trigger_label: string | null;
  trigger_date: string;
  expected_doc_type: string;
  client_id: string;
  office_id: string;
  due_date: string | null;
  status: DocTaskStatus;         // v3: pending / completed / received / cancelled
  received_at?: string | null;
  received_by?: string | null;
  // virtual cert_renewal 専用
  insuranceRecordId?: string;
  certEndDate?: string;
};

// v3: status filter chip
type StatusFilter = "pending" | "completed" | "received" | "all";
const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  pending:   "未作成",
  completed: "作成済・未受領",
  received:  "受領済",
  all:       "全て",
};

const STATUS_BADGE: Record<DocTaskStatus, { cls: string; label: string }> = {
  pending:   { cls: "bg-amber-100 text-amber-700",    label: "未作成"   },
  completed: { cls: "bg-blue-100 text-blue-700",      label: "作成済"   },
  received:  { cls: "bg-emerald-100 text-emerald-700", label: "受領済"   },
  cancelled: { cls: "bg-gray-100 text-gray-500",      label: "取消"     },
};

export default function DocTasksTab({
  tenantId,
  currentOfficeId,
  officeViewAll,
  onOpenDocuments,
}: {
  tenantId: string;
  currentOfficeId: string | null;
  officeViewAll: boolean;
  onOpenDocuments: (clientId?: string, docTaskId?: string | null, expectedDocType?: string | null) => void;
}) {
  const [tasks, setTasks] = useState<DocTask[]>([]);
  const [insuranceRecords, setInsuranceRecords] = useState<ClientInsuranceRecord[]>([]);
  const [clientById, setClientById] = useState<Map<string, Client>>(new Map());
  const [careplanByClient, setCareplanByClient] = useState<Map<string, string>>(new Map()); // clientId → 最新 care_plan の created_at
  const [loading, setLoading] = useState(true);
  const [triggerFilter, setTriggerFilter] = useState<string | null>(null);
  const [docTypeFilter, setDocTypeFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [reload, setReload] = useState(0);
  // 表示モード: 'client' (人 → 書類 → 発生要因 grouped) / 'flat' (期限順 flat list)
  const [viewMode, setViewMode] = useState<"client" | "flat">("client");
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set());

  // v3: 受領モーダル / 統合モーダル
  const [receiveTarget, setReceiveTarget] = useState<DocTask | null>(null);
  const [mergeTarget, setMergeTarget] = useState<MergeCandidateGroup | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // 1. office filter
        const officeIds: string[] | null = officeViewAll
          ? null
          : currentOfficeId
            ? [currentOfficeId]
            : []; // 全社 view OFF & office 未選択 → 何も見せない

        // 2. doc_tasks (v3: 全 active status を fetch して client 側で filter)
        // 統合候補検出のため pending / completed / received すべて取る (cancelled は除外)
        const fetchedTasks = officeIds && officeIds.length === 0
          ? []
          : await getDocTasks(tenantId, officeIds, ["pending", "completed", "received"]);

        // 3. clients (office 絞り込み) — task client_id 解決と cert_renewal 表示用
        const PAGE = 1000;
        const allClients: Client[] = [];
        let from = 0;
        while (true) {
          let q = supabase.from("clients").select("*").eq("tenant_id", tenantId).is("deleted_at", null).order("id").range(from, from + PAGE - 1);
          if (officeIds && officeIds.length > 0) q = q.in("office_id", officeIds);
          const { data, error } = await q;
          if (error) throw error;
          if (!data || data.length === 0) break;
          allClients.push(...(data as Client[]));
          if (data.length < PAGE) break;
          from += PAGE;
        }

        // 4. client_insurance_records (cert_renewal 計算用)
        //    chunk は並列 fetch (lib/renovations.ts と同じ型)。直列だと全社規模で
        //    chunk 数 × 往復時間が積み上がってページ読み込みが遅くなる。
        const clientIdSet = new Set(allClients.map((c) => c.id));
        const insRecs: ClientInsuranceRecord[] = [];
        if (clientIdSet.size > 0) {
          const ids = Array.from(clientIdSet);
          const CHUNK = 200;
          const idChunks: string[][] = [];
          for (let i = 0; i < ids.length; i += CHUNK) idChunks.push(ids.slice(i, i + CHUNK));
          const results = await Promise.all(
            idChunks.map(async (slice) => {
              const { data, error } = await supabase
                .from("client_insurance_records")
                .select("*")
                .eq("tenant_id", tenantId)
                .in("client_id", slice);
              if (error) throw error;
              return (data ?? []) as ClientInsuranceRecord[];
            }),
          );
          for (const rows of results) insRecs.push(...rows);
        }

        // 5. care_plan documents (cert_renewal で「対応 care_plan が無い場合のみ」絞るため)
        const carePlanMap = new Map<string, string>();
        if (clientIdSet.size > 0) {
          const { data, error } = await supabase
            .from("client_documents")
            .select("client_id, type, created_at")
            .eq("tenant_id", tenantId)
            .eq("type", "care_plan")
            .order("created_at", { ascending: false });
          if (error) throw error;
          for (const d of (data ?? []) as Pick<ClientDocument, "client_id" | "type" | "created_at">[]) {
            if (!carePlanMap.has(d.client_id)) carePlanMap.set(d.client_id, d.created_at);
          }
        }

        if (cancelled) return;
        setTasks(fetchedTasks);
        setInsuranceRecords(insRecs);
        setClientById(new Map(allClients.map((c) => [c.id, c])));
        setCareplanByClient(carePlanMap);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, currentOfficeId, officeViewAll, reload]);

  // cert_renewal の仮想 task 生成 (DB 未 INSERT)
  const certRenewalRows = useMemo<DocTaskRow[]>(() => {
    const today = new Date();
    const todayMs = today.getTime();
    const warningMs = todayMs + CERT_RENEWAL_WARNING_DAYS * 24 * 3600 * 1000;
    const out: DocTaskRow[] = [];
    // client × end_date 単位で最新 1 件のみ拾う (重複認定 record 対応)
    const seen = new Set<string>();
    // DB 上に既に実体化済の cert_renewal task が居るかどうか (insurance_record_id で照合) → 仮想 row 抑止
    const existingCertRefIds = new Set(
      tasks.filter((t) => t.trigger_type === "cert_renewal").map((t) => t.trigger_ref_id),
    );
    for (const r of insuranceRecords) {
      if (!r.certification_end_date) continue;
      if (existingCertRefIds.has(r.id)) continue; // 実 task が居るなら仮想は出さない
      const endMs = new Date(r.certification_end_date).getTime();
      if (Number.isNaN(endMs)) continue;
      // 今日 ≦ end ≦ today + 30 日 が警告対象
      if (endMs < todayMs || endMs > warningMs) continue;
      // 対応する care_plan が「認定終了日より後に作成」されていれば skip
      const lastPlan = careplanByClient.get(r.client_id);
      if (lastPlan && new Date(lastPlan).getTime() > endMs - 90 * 24 * 3600 * 1000) {
        // 認定終了の 90 日前以降に care_plan が作られていれば対応済とみなす
        continue;
      }
      const c = clientById.get(r.client_id);
      if (!c || !c.office_id) continue;
      const seenKey = `${r.client_id}|${r.certification_end_date}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      out.push({
        id: `cert:${r.id}:care_plan`,
        isVirtual: true,
        trigger_type: "cert_renewal",
        trigger_label: `認定更新 ${r.certification_end_date}`,
        trigger_date: r.certification_end_date,
        expected_doc_type: "care_plan",
        client_id: r.client_id,
        office_id: c.office_id,
        due_date: r.certification_end_date,
        status: "pending" as DocTaskStatus,
        insuranceRecordId: r.id,
        certEndDate: r.certification_end_date,
      });
    }
    return out;
  }, [insuranceRecords, careplanByClient, clientById, tasks]);

  // 全 row (DB tasks + virtual cert_renewal)
  const allRows = useMemo<DocTaskRow[]>(() => {
    const rows: DocTaskRow[] = tasks.map((t) => ({
      id: t.id,
      isVirtual: false,
      trigger_type: t.trigger_type,
      trigger_label: t.trigger_label,
      trigger_date: t.trigger_date,
      expected_doc_type: t.expected_doc_type,
      client_id: t.client_id,
      office_id: t.office_id,
      due_date: t.due_date,
      status: t.status,
      received_at: t.received_at,
      received_by: t.received_by,
    }));
    return [...rows, ...certRenewalRows];
  }, [tasks, certRenewalRows]);

  // フィルタ適用
  const filteredRows = useMemo(() => {
    return allRows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (triggerFilter && r.trigger_type !== triggerFilter) return false;
      if (docTypeFilter && r.expected_doc_type !== docTypeFilter) return false;
      return true;
    }).sort((a, b) => {
      // due_date あり (cert_renewal) を上に。同じカテゴリ内では trigger_date 昇順
      if (!!a.due_date !== !!b.due_date) return a.due_date ? -1 : 1;
      return a.trigger_date.localeCompare(b.trigger_date);
    });
  }, [allRows, statusFilter, triggerFilter, docTypeFilter]);

  // 集計 (status / 他フィルタを反映した chip count)
  // - countByTrigger: docType filter のみ反映 (= trigger ごとの「他フィルタ AND 後」件数)
  // - countByDocType: trigger filter のみ反映 (= docType ごとの「他フィルタ AND 後」件数)
  // これで chip 表示の (N) が AND 適用後の実件数となり、0 件 chip は混乱を回避
  const countByTrigger: Record<string, number> = {};
  const countByDocType: Record<string, number> = {};
  const countByStatus: Record<StatusFilter, number> = { pending: 0, completed: 0, received: 0, all: allRows.length };
  for (const r of allRows) {
    if (r.status === "pending")   countByStatus.pending   += 1;
    if (r.status === "completed") countByStatus.completed += 1;
    if (r.status === "received")  countByStatus.received  += 1;
    if (statusFilter !== "all" && r.status !== statusFilter) continue;
    // trigger chip: docType filter を反映
    if (docTypeFilter === null || r.expected_doc_type === docTypeFilter) {
      countByTrigger[r.trigger_type] = (countByTrigger[r.trigger_type] ?? 0) + 1;
    }
    // docType chip: trigger filter を反映
    if (triggerFilter === null || r.trigger_type === triggerFilter) {
      countByDocType[r.expected_doc_type] = (countByDocType[r.expected_doc_type] ?? 0) + 1;
    }
  }

  // v3: 統合候補 (DB tasks のみ。virtual は対象外)
  const mergeCandidates = useMemo(() => findMergeCandidates(tasks), [tasks]);

  // 統合候補 lookup: clientId|docType → MergeCandidateGroup
  const mergeByKey = useMemo(() => {
    const m = new Map<string, MergeCandidateGroup>();
    for (const g of mergeCandidates) {
      m.set(`${g.clientId}|${g.expectedDocType}`, g);
    }
    return m;
  }, [mergeCandidates]);

  // 人 → 書類 → 発生要因 の 3 階層 grouped view
  const groupedByClient = useMemo(() => {
    type DocGroup = { docType: string; rows: DocTaskRow[]; mergeGroup: MergeCandidateGroup | undefined };
    type ClientGroup = { clientId: string; client: Client | undefined; docGroups: DocGroup[]; totalCount: number };

    const byClient = new Map<string, Map<string, DocTaskRow[]>>();
    for (const r of filteredRows) {
      if (!byClient.has(r.client_id)) byClient.set(r.client_id, new Map());
      const docMap = byClient.get(r.client_id)!;
      if (!docMap.has(r.expected_doc_type)) docMap.set(r.expected_doc_type, []);
      docMap.get(r.expected_doc_type)!.push(r);
    }

    const out: ClientGroup[] = [];
    for (const [clientId, docMap] of byClient) {
      const client = clientById.get(clientId);
      const docGroups: DocGroup[] = [];
      // 書類は DOC_TYPE_ORDER で固定順
      for (const dt of DOC_TYPE_ORDER) {
        const rows = docMap.get(dt);
        if (!rows) continue;
        // 行は trigger_date ASC
        rows.sort((a, b) => a.trigger_date.localeCompare(b.trigger_date));
        docGroups.push({ docType: dt, rows, mergeGroup: mergeByKey.get(`${clientId}|${dt}`) });
      }
      const totalCount = docGroups.reduce((s, g) => s + g.rows.length, 0);
      out.push({ clientId, client, docGroups, totalCount });
    }
    // 施設は末尾、人はフリガナ ASC (なければ name)
    out.sort((a, b) => {
      const fa = a.client?.is_facility ? 1 : 0;
      const fb = b.client?.is_facility ? 1 : 0;
      if (fa !== fb) return fa - fb;
      const ka = a.client?.furigana ?? a.client?.name ?? "";
      const kb = b.client?.furigana ?? b.client?.name ?? "";
      return ka.localeCompare(kb, "ja");
    });
    return out;
  }, [filteredRows, clientById, mergeByKey]);

  const toggleClient = (clientId: string) => {
    setExpandedClients((prev) => {
      const n = new Set(prev);
      if (n.has(clientId)) n.delete(clientId); else n.add(clientId);
      return n;
    });
  };
  const expandAll = () => setExpandedClients(new Set(groupedByClient.map((g) => g.clientId)));
  const collapseAll = () => setExpandedClients(new Set());

  const handleOpenDocs = async (row: DocTaskRow) => {
    let docTaskId: string | null = row.isVirtual ? null : row.id;
    if (row.isVirtual && row.insuranceRecordId && row.certEndDate) {
      // cert_renewal 仮想 row → DB INSERT して実体化
      const created = await insertCertRenewalTask({
        tenantId,
        officeId: row.office_id,
        clientId: row.client_id,
        insuranceRecordId: row.insuranceRecordId,
        certEndDate: row.certEndDate,
        expectedDocType: row.expected_doc_type,
      });
      if (created) docTaskId = created.id;
    }
    onOpenDocuments(row.client_id, docTaskId, row.expected_doc_type);
  };

  const handleClickReceive = (row: DocTaskRow) => {
    if (row.isVirtual || row.status !== "completed") return;
    const t = tasks.find((tt) => tt.id === row.id);
    if (t) setReceiveTarget(t);
  };

  const handleClickMerge = (group: MergeCandidateGroup) => {
    setMergeTarget(group);
  };

  const totalCount = allRows.length;

  return (
    <div className="flex flex-col h-full bg-white text-sm">
      {/* ツールバー */}
      <div className="border-b border-gray-300 bg-gray-100 px-3 py-2 shrink-0 flex items-center gap-2 flex-wrap">
        <FileWarning size={16} className="text-amber-600" />
        <span className="font-semibold text-gray-700">書類タスク</span>
        <span className="text-xs text-gray-500">動きに紐付く書類タスク (event-driven, v3)</span>
        <span className="ml-auto text-xs text-gray-600 flex items-center gap-3">
          <span>未作成 <strong className="text-amber-700">{countByStatus.pending}</strong></span>
          <span>受領待ち <strong className="text-blue-700">{countByStatus.completed}</strong></span>
          <span>受領済 <strong className="text-emerald-700">{countByStatus.received}</strong></span>
          <span className="text-gray-400">/ 表示 {filteredRows.length} 件</span>
        </span>
      </div>

      {/* フィルタ: status (v3) */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1 flex-wrap shrink-0">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">状態</span>
        {(["pending", "completed", "received", "all"] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${statusFilter === s ? "bg-gray-700 text-white border-gray-700" : "text-gray-600 border-gray-300 hover:border-gray-500"}`}
          >
            {STATUS_FILTER_LABEL[s]} ({countByStatus[s]})
          </button>
        ))}
      </div>

      {/* v3: 統合候補 banner */}
      {mergeCandidates.length > 0 && (
        <div className="px-3 py-2 border-b border-amber-200 bg-amber-50 shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <AlertCircle size={14} className="text-amber-600 shrink-0" />
            <span className="text-xs font-semibold text-amber-800">
              統合候補 {mergeCandidates.length} 組
            </span>
            <span className="text-[11px] text-amber-700">
              同利用者 × 同書類種別 × 14 日以内 (1 つ目未受領) の task は 1 通にまとめられます
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {mergeCandidates.map((g, gi) => {
              const c = clientById.get(g.clientId);
              return (
                <button
                  key={`merge-${gi}`}
                  onClick={() => handleClickMerge(g)}
                  className="text-[11px] px-2 py-1 rounded border border-amber-300 bg-white text-amber-700 hover:bg-amber-100 flex items-center gap-1"
                >
                  <span className="font-medium">{c?.name ?? g.clientId.slice(0, 8)}</span>
                  <span className="text-amber-500">·</span>
                  <span>{DOC_LABEL[g.expectedDocType] ?? g.expectedDocType}</span>
                  <span className="text-amber-500">·</span>
                  <span>{g.taskIds.length} 件</span>
                  <span className="ml-1 text-[10px] underline">統合</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* フィルタ: trigger_type */}
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1 flex-wrap shrink-0">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">トリガー</span>
        <button
          onClick={() => setTriggerFilter(null)}
          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${triggerFilter === null ? "bg-gray-700 text-white border-gray-700" : "text-gray-600 border-gray-300 hover:border-gray-500"}`}
        >
          全
        </button>
        {Object.entries(TRIGGER_LABEL).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTriggerFilter(triggerFilter === key ? null : key)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${triggerFilter === key ? "bg-gray-700 text-white border-gray-700" : "text-gray-600 border-gray-300 hover:border-gray-500"}`}
          >
            {label} ({countByTrigger[key] ?? 0})
          </button>
        ))}
      </div>

      {/* フィルタ: 書類種別 */}
      <div className="px-3 py-2 border-b border-gray-200 flex items-center gap-1 flex-wrap shrink-0">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">書類</span>
        <button
          onClick={() => setDocTypeFilter(null)}
          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${docTypeFilter === null ? "bg-gray-700 text-white border-gray-700" : "text-gray-600 border-gray-300 hover:border-gray-500"}`}
        >
          全
        </button>
        {Object.entries(DOC_LABEL).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setDocTypeFilter(docTypeFilter === key ? null : key)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${docTypeFilter === key ? "bg-gray-700 text-white border-gray-700" : "text-gray-600 border-gray-300 hover:border-gray-500"}`}
          >
            {label} ({countByDocType[key] ?? 0})
          </button>
        ))}
      </div>

      {/* 表示モード切替 */}
      <div className="px-3 py-2 border-b border-gray-200 flex items-center gap-2 shrink-0">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide mr-1">表示</span>
        <button
          onClick={() => setViewMode("client")}
          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${viewMode === "client" ? "bg-gray-700 text-white border-gray-700" : "text-gray-600 border-gray-300 hover:border-gray-500"}`}
        >
          人ごと
        </button>
        <button
          onClick={() => setViewMode("flat")}
          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${viewMode === "flat" ? "bg-gray-700 text-white border-gray-700" : "text-gray-600 border-gray-300 hover:border-gray-500"}`}
        >
          期限順
        </button>
        {viewMode === "client" && (
          <div className="ml-auto flex gap-2">
            <button onClick={expandAll} className="text-[11px] text-gray-500 hover:text-gray-700 underline">全展開</button>
            <button onClick={collapseAll} className="text-[11px] text-gray-500 hover:text-gray-700 underline">全折りたたみ</button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-amber-400" /></div>
      ) : filteredRows.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <CheckCircle2 size={32} className="text-emerald-400 mx-auto mb-2" />
            <p className="text-sm text-gray-500">{totalCount === 0 ? "該当する書類タスクはありません" : "該当する書類タスクはありません"}</p>
          </div>
        </div>
      ) : viewMode === "client" ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {groupedByClient.map(({ clientId, client, docGroups, totalCount }) => {
            const expanded = expandedClients.has(clientId);
            return (
              <div key={clientId} className="border border-gray-200 rounded-lg bg-white overflow-hidden">
                <button
                  onClick={() => toggleClient(clientId)}
                  className="w-full px-3 py-2 flex items-center gap-2 hover:bg-gray-50 text-left"
                >
                  {expanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                  <span className="font-semibold text-gray-800">{client?.name ?? clientId.slice(0, 8)}</span>
                  {client?.furigana && <span className="text-[10px] text-gray-400">{client.furigana}</span>}
                  <span className="ml-auto text-[11px] text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                    未作成 {totalCount}
                  </span>
                </button>
                {expanded && (
                  <div className="border-t border-gray-100">
                    {docGroups.map(({ docType, rows, mergeGroup }) => (
                      <div key={docType} className="border-b border-gray-100 last:border-b-0">
                        <div className="px-3 py-1.5 bg-gray-50 flex items-center gap-2">
                          <span className={`text-[11px] px-2 py-0.5 rounded-full ${DOC_BADGE_COLOR[docType] ?? "bg-gray-100 text-gray-700"}`}>
                            {DOC_LABEL[docType] ?? docType}
                          </span>
                          <span className="text-[11px] text-gray-500">×{rows.length}</span>
                          {mergeGroup && (
                            <button
                              onClick={() => handleClickMerge(mergeGroup)}
                              className="ml-auto text-[10px] px-2 py-0.5 rounded border border-amber-300 text-amber-700 bg-white hover:bg-amber-50"
                            >
                              統合する
                            </button>
                          )}
                        </div>
                        <div>
                          {rows.map((row) => {
                            const badge = STATUS_BADGE[row.status];
                            return (
                              <div key={row.id} className="px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-gray-50 border-t border-gray-50">
                                <span className="text-[10px] text-gray-500 w-20 shrink-0">{TRIGGER_LABEL[row.trigger_type] ?? row.trigger_type}</span>
                                <span className="text-[11px] text-gray-700 flex-1 truncate">{row.trigger_label ?? row.trigger_date}</span>
                                {row.isVirtual && <span className="text-[9px] text-amber-600 bg-amber-50 px-1 rounded shrink-0">仮</span>}
                                <span className="text-[11px] text-gray-500 shrink-0">{row.due_date ?? "—"}</span>
                                <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${badge.cls}`}>{badge.label}</span>
                                {row.status === "pending" && (
                                  <button
                                    onClick={() => { void handleOpenDocs(row); }}
                                    className="text-[11px] px-2 py-0.5 rounded border border-blue-300 text-blue-600 hover:bg-blue-50 shrink-0"
                                  >
                                    書類を作る
                                  </button>
                                )}
                                {row.status === "completed" && (
                                  <button
                                    onClick={() => handleClickReceive(row)}
                                    className="text-[11px] px-2 py-0.5 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50 shrink-0"
                                  >
                                    受領
                                  </button>
                                )}
                                {row.status === "received" && (
                                  <span className="text-[10px] text-gray-400 shrink-0">完了</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="overflow-x-auto">
            <table className="w-full table-auto bg-white text-left text-xs border-collapse min-w-[680px]">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-gray-600">
                  <th className="border-b border-gray-200 px-3 py-2 font-semibold w-44">トリガー</th>
                  <th className="border-b border-gray-200 px-3 py-2 font-semibold w-40">利用者</th>
                  <th className="border-b border-gray-200 px-3 py-2 font-semibold w-28">期待書類</th>
                  <th className="border-b border-gray-200 px-3 py-2 font-semibold w-20">期限</th>
                  <th className="border-b border-gray-200 px-3 py-2 font-semibold w-24">状態</th>
                  <th className="border-b border-gray-200 px-3 py-2 font-semibold w-32 text-center">操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const client = clientById.get(row.client_id);
                  const badge = STATUS_BADGE[row.status];
                  return (
                    <tr key={row.id} className="hover:bg-gray-50 align-top">
                      <td className="border-b border-gray-100 px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-gray-500">{TRIGGER_LABEL[row.trigger_type] ?? row.trigger_type}</span>
                          {row.isVirtual && <span className="text-[9px] text-amber-600 bg-amber-50 px-1 rounded">仮</span>}
                        </div>
                        <div className="text-[11px] text-gray-700 mt-0.5">{row.trigger_label ?? row.trigger_date}</div>
                      </td>
                      <td className="border-b border-gray-100 px-3 py-2 font-medium text-gray-800">
                        {client ? (
                          <>
                            <div>{client.name}</div>
                            {client.furigana && <div className="text-gray-400 text-[10px] mt-0.5">{client.furigana}</div>}
                          </>
                        ) : (
                          <span className="text-gray-400">{row.client_id.slice(0, 8)}…</span>
                        )}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-2">
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${DOC_BADGE_COLOR[row.expected_doc_type] ?? "bg-gray-100 text-gray-700"}`}
                        >
                          {DOC_LABEL[row.expected_doc_type] ?? row.expected_doc_type}
                        </span>
                      </td>
                      <td className="border-b border-gray-100 px-3 py-2 text-gray-600 text-[11px]">
                        {row.due_date ?? "—"}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-2">
                        <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full ${badge.cls}`}>
                          {badge.label}
                        </span>
                        {row.status === "received" && row.received_by && (
                          <div className="text-[9px] text-gray-400 mt-0.5">
                            {row.received_by} / {row.received_at?.slice(0, 10) ?? ""}
                          </div>
                        )}
                      </td>
                      <td className="border-b border-gray-100 px-3 py-2 text-center">
                        {row.status === "pending" && (
                          <button
                            onClick={() => { void handleOpenDocs(row); }}
                            className="text-[11px] px-2 py-1 rounded border border-blue-300 text-blue-600 hover:bg-blue-50"
                          >
                            書類を作る
                          </button>
                        )}
                        {row.status === "completed" && (
                          <button
                            onClick={() => handleClickReceive(row)}
                            className="text-[11px] px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                          >
                            受領
                          </button>
                        )}
                        {row.status === "received" && (
                          <span className="text-[10px] text-gray-400">完了</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* v3: 受領モーダル */}
      {receiveTarget && (
        <DocTaskReceiveModal
          task={receiveTarget}
          client={clientById.get(receiveTarget.client_id) ?? null}
          onClose={() => setReceiveTarget(null)}
          onSaved={() => { setReceiveTarget(null); setReload((r) => r + 1); }}
        />
      )}

      {/* v3: 統合モーダル */}
      {mergeTarget && (
        <DocTaskMergeModal
          group={mergeTarget}
          tasks={tasks}
          client={clientById.get(mergeTarget.clientId) ?? null}
          onClose={() => setMergeTarget(null)}
          onSaved={() => { setMergeTarget(null); setReload((r) => r + 1); }}
        />
      )}
    </div>
  );
}

// ─── DocTaskReceiveModal (v3) ─────────────────────────────────────────────────
function DocTaskReceiveModal({
  task,
  client,
  onClose,
  onSaved,
}: {
  task: DocTask;
  client: Client | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [receivedBy, setReceivedBy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmed = receivedBy.trim();
    if (!trimmed) {
      setError("受領者氏名を入力してください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await markDocTaskReceived(task.id, trimmed);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white w-full max-w-sm rounded-2xl shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <CheckCircle2 size={18} className="text-emerald-500" />
          <h3 className="font-semibold text-gray-800">受領記録</h3>
          <button onClick={onClose} className="ml-auto"><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="text-xs text-gray-500">
            <div>利用者: <span className="font-medium text-gray-800">{client?.name ?? task.client_id.slice(0, 8)}</span></div>
            <div>書類: <span className="font-medium text-gray-800">{DOC_LABEL[task.expected_doc_type] ?? task.expected_doc_type}</span></div>
            <div>トリガー: {task.trigger_label ?? task.trigger_date}</div>
          </div>
          <div>
            <label className="text-xs text-gray-600 block mb-1">受領者氏名</label>
            <input
              type="text"
              value={receivedBy}
              onChange={(e) => setReceivedBy(e.target.value)}
              placeholder="例: 山田太郎"
              className="w-full text-sm px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:border-emerald-400"
              autoFocus
            />
          </div>
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <div className="px-4 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={() => { void handleSave(); }}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            受領済にする
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── DocTaskMergeModal (v3) ───────────────────────────────────────────────────
function DocTaskMergeModal({
  group,
  tasks,
  client,
  onClose,
  onSaved,
}: {
  group: MergeCandidateGroup;
  tasks: DocTask[];
  client: Client | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const groupTasks = useMemo(
    () => group.taskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is DocTask => !!t),
    [group, tasks],
  );
  // default target: 最新 (= 最後の trigger_date)
  const [targetId, setTargetId] = useState<string>(() => groupTasks[groupTasks.length - 1]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMerge = async () => {
    const sourceIds = group.taskIds.filter((id) => id !== targetId);
    if (sourceIds.length === 0) {
      setError("統合先以外の task が必要です");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await mergeDocTasks(targetId, sourceIds);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
          <AlertCircle size={18} className="text-amber-500" />
          <h3 className="font-semibold text-gray-800">書類タスクの統合</h3>
          <button onClick={onClose} className="ml-auto"><X size={18} className="text-gray-400" /></button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <div className="text-xs text-gray-500">
            <div>利用者: <span className="font-medium text-gray-800">{client?.name ?? group.clientId.slice(0, 8)}</span></div>
            <div>書類: <span className="font-medium text-gray-800">{DOC_LABEL[group.expectedDocType] ?? group.expectedDocType}</span></div>
            <div className="mt-1">統合先 (= 残す task) を選択してください。残り {groupTasks.length - 1} 件は取消扱いになります。</div>
          </div>
          <div className="space-y-1">
            {groupTasks.map((t) => (
              <label
                key={t.id}
                className={`flex items-start gap-2 px-2.5 py-2 border rounded-lg cursor-pointer ${targetId === t.id ? "border-amber-400 bg-amber-50" : "border-gray-200 hover:border-gray-300"}`}
              >
                <input
                  type="radio"
                  name="merge-target"
                  checked={targetId === t.id}
                  onChange={() => setTargetId(t.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-800 font-medium">
                    {t.trigger_label ?? t.trigger_date}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    {TRIGGER_LABEL[t.trigger_type] ?? t.trigger_type} · {t.trigger_date}
                  </div>
                </div>
              </label>
            ))}
          </div>
          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <div className="px-4 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={() => { void handleMerge(); }}
            disabled={saving || !targetId}
            className="text-xs px-3 py-1.5 rounded bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 flex items-center gap-1"
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            統合する
          </button>
        </div>
      </div>
    </div>
  );
}
