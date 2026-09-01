import { supabase, Client } from "./supabase";
import { cached, invalidateCache } from "./cache";

// Supabase のデフォルト 1000件制限を回避するためページング取得
// 既定では削除済み（deleted_at IS NOT NULL）を除外する
// officeId 指定時は clients.office_id でも絞り込む (Phase 8 office-centric)
export async function getClients(
  tenantId: string,
  opts: { includeDeleted?: boolean; onlyDeleted?: boolean; bypassCache?: boolean; officeId?: string | null } = {}
): Promise<Client[]> {
  const filterKey = opts.onlyDeleted ? "deleted" : opts.includeDeleted ? "all" : "active";
  const officeKey = opts.officeId ?? "all";
  const key = `clients:${tenantId}:${filterKey}:${officeKey}`;
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
      if (opts.officeId) {
        q = q.eq("office_id", opts.officeId);
      }
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
  //    テーブル非存在 (42P01/PGRST205) だけは「そもそも使っていない」ので無視してよいが、
  //    それ以外のエラー (RLS・制約違反等) は付け替えが本当に失敗しているので、
  //    3. の DELETE まで進めると旧 client_id を参照したままの孤立行が残る。
  //    無視してよいエラーかどうかを判定し、それ以外は集めて DELETE 前に throw する。
  const isMissingTable = (code?: string) => code === "42P01" || code === "PGRST205";
  const realFailures: string[] = [];

  const { error: eventsErr } = await supabase
    .from("events")
    .update({ client_id: newClient.id })
    .eq("client_id", provisionalClientId);
  if (eventsErr && !isMissingTable(eventsErr.code)) {
    console.warn("events.client_id 付け替え失敗:", eventsErr);
    realFailures.push(`events: ${eventsErr.message}`);
  }
  const { error: ordersErr } = await supabase
    .from("orders")
    .update({ client_id: newClient.id })
    .eq("client_id", provisionalClientId);
  if (ordersErr && !isMissingTable(ordersErr.code)) {
    console.warn("orders.client_id 付け替え失敗:", ordersErr);
    realFailures.push(`orders: ${ordersErr.message}`);
  }

  // その他の参照先（必要なら順次追加）
  for (const t of ["client_insurance_records", "client_rental_history", "client_hospitalizations", "client_documents", "monitoring_records", "client_public_expenses"]) {
    const { error } = await supabase.from(t).update({ client_id: newClient.id }).eq("client_id", provisionalClientId);
    if (error && !isMissingTable(error.code)) {
      console.warn(`${t}.client_id 付け替え失敗:`, error);
      realFailures.push(`${t}: ${error.message}`);
    }
  }

  // 参照の付け替えが (テーブル非存在以外の理由で) 1 件でも失敗していたら、
  // 旧 client 行を消さずに中断する。消してしまうと孤立参照が残り、後から気づけない。
  if (realFailures.length > 0) {
    throw new Error(
      `参照の付け替えに失敗したため統合を中断しました (旧利用者は削除していません): ${realFailures.join(" / ")}`,
    );
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
