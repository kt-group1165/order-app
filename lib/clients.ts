import { supabase, Client } from "./supabase";
import { cached, invalidateCache } from "./cache";
import { selectAllPagedParallel } from "./pagedParallel";
import { mapWithConcurrency } from "./concurrency";

// Supabase のデフォルト 1000件制限を回避するためページング取得
// 既定では削除済み（deleted_at IS NOT NULL）を除外する
// officeId 指定時は clients.office_id でも絞り込む (Phase 8 office-centric)
type GetClientsOpts = { includeDeleted?: boolean; onlyDeleted?: boolean; bypassCache?: boolean; officeId?: string | null };

export async function getClients(tenantId: string, opts: GetClientsOpts = {}): Promise<Client[]> {
  return getClientsImpl<Client>(tenantId, opts, "*", "");
}

/**
 * getClients と同じ絞り込み・並び (furigana → id) で、指定した列だけ読む (2026-11-13 高速化: 全 47 列 ≒ 1.27MB/1000 行)。
 *   読むだけの画面用。戻り値の型は Pick なので、画面が読んでいない列を使うと tsc が落ちる。
 *   ⚠ 編集・保存に渡す画面 (ClientsTab の詳細 等) では使わない (欠けた列を保存で消しうる)
 *   id・furigana は内部 (割当で足す分の重複除き・並べ直し) で使うので常に読む。キャッシュは列の組ごとに別
 */
export async function getClientsCols<K extends keyof Client>(
  tenantId: string, opts: GetClientsOpts, cols: readonly K[],
): Promise<Pick<Client, K | "id" | "furigana">[]> {
  const sel = [...new Set<string>(["id", "furigana", ...cols])].join(", ");
  return getClientsImpl<Pick<Client, K | "id" | "furigana">>(tenantId, opts, sel, `:cols=${sel}`);
}

async function getClientsImpl<C extends Pick<Client, "id" | "furigana">>(
  tenantId: string, opts: GetClientsOpts, sel: string, keySuffix: string,
): Promise<C[]> {
  const filterKey = opts.onlyDeleted ? "deleted" : opts.includeDeleted ? "all" : "active";
  const officeKey = opts.officeId ?? "all";
  const key = `clients:${tenantId}:${filterKey}:${officeKey}${keySuffix}`;
  const fetcher = async (): Promise<C[]> => {
    // 削除済みの扱い (clients 本体と 割当で足す分で同じ条件)
    const withDeletedFilter = <Q extends { is: (c: string, v: null) => Q; not: (c: string, op: string, v: null) => Q }>(q: Q): Q =>
      opts.onlyDeleted ? q.not("deleted_at", "is", null) : !opts.includeDeleted ? q.is("deleted_at", null) : q;
    const clientsQ = (head: boolean) => {
      let q = head
        ? supabase.from("clients").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
        : supabase.from("clients").select(sel).eq("tenant_id", tenantId);
      if (opts.officeId) q = q.eq("office_id", opts.officeId);
      return withDeletedFilter(q);
    };
    // ★ 2026-11-13 高速化: clients は 件数を聞いてページを並列に読む (並び順・中身は従来どおり furigana → id)。
    //   事業所指定時の割当の読込は clients の結果に依存しないので 同時に始める (旧: clients を読み終わってから直列)
    const clientsP = selectAllPagedParallel<C>(
      () => clientsQ(true),
      (from, to) => clientsQ(false).order("furigana", { ascending: true, nullsFirst: false }).order("id").range(from, to),
    );
    const assignedP = opts.officeId
      ? selectAllPagedParallel<{ client_id: string | null }>(
          () => supabase.from("client_office_assignments").select("id", { count: "exact", head: true }).eq("office_id", opts.officeId!),
          (from, to) => supabase.from("client_office_assignments").select("client_id").eq("office_id", opts.officeId!).order("id").range(from, to),
        )
      : Promise.resolve([] as { client_id: string | null }[]);
    const [all, assignedRows] = await Promise.all([clientsP, assignedP]);
    // ★ 2026-11-10: 事業所で絞るときは client_office_assignments (junction) で割り当てられた利用者も含める。
    //   kaigo と共有の利用者は clients.office_id が空 (または kaigo 側の事業所) のことがあり、
    //   office_id だけで絞ると ケアサポの貸与があるのに請求画面に出ず 請求漏れになる
    //   (2026-10 で 18 名。川名正子・富田行良・在原一善 ほか。CLAUDE.md §3.1)。
    //   終了した割当も含める (office_id で絞る側も元利用者を含むのと揃える。過去月の請求・過誤で要る)。
    if (opts.officeId) {
      const have = new Set(all.map((c) => c.id));
      const extraIds = [...new Set(assignedRows.map((r) => r.client_id).filter((id): id is string => !!id && !have.has(id)))];
      const chunks: string[][] = [];
      for (let i = 0; i < extraIds.length; i += 150) chunks.push(extraIds.slice(i, i + 150));
      const errors: string[] = [];
      const extra = await mapWithConcurrency(chunks, async (ids) => {
        const { data, error } = await withDeletedFilter(supabase.from("clients").select(sel).eq("tenant_id", tenantId).in("id", ids));
        if (error) { errors.push(error.message); return [] as C[]; }
        return (data ?? []) as unknown as C[];
      });
      if (errors.length) throw new Error(errors[0]);
      all.push(...extra.flat());
      if (extraIds.length) all.sort((a, b) => (a.furigana ?? "￿").localeCompare(b.furigana ?? "￿", "ja"));
    }
    return all;
  };
  if (opts.bypassCache) return fetcher();
  return cached(key, fetcher);
}

// ソフト削除
export async function softDeleteClient(clientId: string): Promise<void> {
  const { error } = await supabase
    .from("clients")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", clientId);
  if (error) throw error;
  invalidateCache("clients:");
}

// 復元
export async function restoreClient(clientId: string): Promise<void> {
  const { error } = await supabase
    .from("clients")
    .update({ deleted_at: null })
    .eq("id", clientId);
  if (error) throw error;
  invalidateCache("clients:");
}

// 仮登録の本登録化（編集フローで使用）
// 同じ client_id のまま、is_provisional=false + 追加情報で更新
//   events.client_id / orders.client_id は UUID 参照のため自動で追従する
export async function promoteProvisionalClient(
  clientId: string,
  updates: Partial<Omit<Client, "id" | "tenant_id" | "created_at">>,
): Promise<void> {
  const payload = { ...updates, is_provisional: false };
  const { error } = await supabase.from("clients").update(payload).eq("id", clientId);
  if (error) throw error;
  invalidateCache("clients:");
}

// 仮登録利用者のみ取得
export async function getProvisionalClients(tenantId: string): Promise<Client[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("is_provisional", true)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Client[];
}
