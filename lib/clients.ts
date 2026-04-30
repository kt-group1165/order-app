import { supabase, Client } from "./supabase";
import { cached, invalidateCache } from "./cache";

// Supabase のデフォルト 1000件制限を回避するためページング取得
// 既定では削除済み（deleted_at IS NOT NULL）を除外する
export async function getClients(
  tenantId: string,
  opts: { includeDeleted?: boolean; onlyDeleted?: boolean; bypassCache?: boolean } = {}
): Promise<Client[]> {
  const filterKey = opts.onlyDeleted ? "deleted" : opts.includeDeleted ? "all" : "active";
  const key = `clients:${tenantId}:${filterKey}`;
  const fetcher = async (): Promise<Client[]> => {
    const PAGE = 1000;
    const all: Client[] = [];
    let from = 0;
    while (true) {
      let q = supabase
        .from("clients")
        .select("*")
        .eq("tenant_id", tenantId)
        .order("furigana", { ascending: true, nullsFirst: false })
        .range(from, from + PAGE - 1);
      if (opts.onlyDeleted) {
        q = q.not("deleted_at", "is", null);
      } else if (!opts.includeDeleted) {
        q = q.is("deleted_at", null);
      }
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
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

// 新規利用者を正式登録し、指定した仮登録を「同一人物」として置き換える。
//   1. 新しい clients 行を作成（新UUID, is_provisional=false）
//   2. events.client_id / orders.client_id を旧→新にUPDATE
//   3. 旧仮登録の clients 行を DELETE
//
//   トランザクション相当の処理だが Supabase のJSクライアントでは純粋なトランザクションが張れないため、
//   順次実行＋途中失敗時のログで対応。運用ではまず新規作成→付け替え→削除の順を守る。
export async function mergeProvisionalIntoNewClient(
  provisionalClientId: string,
  newClientData: Partial<Omit<Client, "id" | "created_at">> & { tenant_id: string; name: string },
): Promise<Client> {
  // 1. 新規 clients 行作成
  const payload: Record<string, unknown> = { ...newClientData, is_provisional: false };
  const { data: created, error: insertErr } = await supabase
    .from("clients")
    .insert(payload)
    .select()
    .single();
  if (insertErr) throw insertErr;
  const newClient = created as Client;

  // 2. 参照の付け替え
  //    events は calendar-app と共有。order-app には events テーブルが無いので直接 update する
  const { error: eventsErr } = await supabase
    .from("events")
    .update({ client_id: newClient.id })
    .eq("client_id", provisionalClientId);
  if (eventsErr) {
    // 失敗しても続行（テーブルが無いケース等）しつつログに残す
    console.warn("events.client_id 付け替え失敗:", eventsErr);
  }
  const { error: ordersErr } = await supabase
    .from("orders")
    .update({ client_id: newClient.id })
    .eq("client_id", provisionalClientId);
  if (ordersErr) console.warn("orders.client_id 付け替え失敗:", ordersErr);

  // その他の参照先（必要なら順次追加）
  for (const t of ["client_insurance_records", "client_rental_history", "client_hospitalizations", "client_documents", "monitoring_records", "client_public_expenses"]) {
    const { error } = await supabase.from(t).update({ client_id: newClient.id }).eq("client_id", provisionalClientId);
    if (error) console.warn(`${t}.client_id 付け替え失敗（テーブル非存在なら無視可）:`, error);
  }

  // 3. 旧仮登録の削除
  const { error: delErr } = await supabase.from("clients").delete().eq("id", provisionalClientId);
  if (delErr) throw delErr;

  invalidateCache("clients:");
  return newClient;
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
