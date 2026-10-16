import { supabase, type ClientDocument, type DocTask } from "./supabase";
import { DOC_CHECK_CUTOFF } from "./docChecklist";

// 書類画面の左の一覧用: 利用者ごとの貸与明細 (介護保険のみ)・書類・運用で発生した書類タスクをまとめて読む。
// 貸与明細は全社で約 4,700 行なので 1000 行ずつページングして読み切る (order 必須: 無いと行が抜ける)。

export type ClientRental = {
  rental_start_date: string | null;
  rental_end_date: string | null;
  status: string;
};

export type DocIndex = {
  rentalsByClient: Map<string, ClientRental[]>;
  docsByClient: Map<string, ClientDocument[]>;
  /** 運用開始後に発生した pending の書類タスク (2026-05-20 の一括 backfill は除く) */
  tasksByClient: Map<string, DocTask[]>;
};

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function getDocIndex(tenantId: string): Promise<DocIndex> {
  type ItemRow = ClientRental & { orders: { client_id: string; payment_type: string | null } | null };
  const [items, docs, tasks] = await Promise.all([
    fetchAll<ItemRow>((from, to) =>
      supabase
        .from("order_items")
        .select("rental_start_date, rental_end_date, status, orders!inner(client_id, payment_type, tenant_id)")
        .eq("orders.tenant_id", tenantId)
        .order("id")
        .range(from, to)),
    fetchAll<ClientDocument>((from, to) =>
      supabase.from("client_documents").select("*").eq("tenant_id", tenantId).order("id").range(from, to)),
    fetchAll<DocTask>((from, to) =>
      supabase
        .from("doc_tasks")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("status", "pending")
        .is("merged_into_task_id", null)
        .gte("created_at", `${DOC_CHECK_CUTOFF}T00:00:00+09:00`)
        .order("id")
        .range(from, to)),
  ]);

  const rentalsByClient = new Map<string, ClientRental[]>();
  for (const it of items) {
    const cid = it.orders?.client_id;
    // 自費の貸与は介護保険の書類 (選定提案書・個別援助計画書) の対象外
    if (!cid || it.orders?.payment_type === "自費") continue;
    const list = rentalsByClient.get(cid) ?? [];
    list.push({ rental_start_date: it.rental_start_date, rental_end_date: it.rental_end_date, status: it.status });
    rentalsByClient.set(cid, list);
  }
  const docsByClient = new Map<string, ClientDocument[]>();
  for (const d of docs) {
    const list = docsByClient.get(d.client_id) ?? [];
    list.push(d);
    docsByClient.set(d.client_id, list);
  }
  const tasksByClient = new Map<string, DocTask[]>();
  for (const t of tasks) {
    const list = tasksByClient.get(t.client_id) ?? [];
    list.push(t);
    tasksByClient.set(t.client_id, list);
  }
  return { rentalsByClient, docsByClient, tasksByClient };
}

/** 今日時点で貸与中の品目数 (介護保険) */
export function activeRentalCount(rentals: ClientRental[] | undefined, today: string): number {
  return (rentals ?? []).filter((r) => r.status === "rental_started" && (!r.rental_end_date || r.rental_end_date >= today)).length;
}
