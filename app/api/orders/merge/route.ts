import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// POST /api/orders/merge
//
// 同 tenant_id (+ 同 client_id) の複数 order を 1 件にマージ:
//   1. source orders の order_items を target に UPDATE (items.created_at 保持)
//   2. target.merged_from_order_ids に source orders の発注情報 array 追記
//   3. source orders を DELETE
//
// 入力: { target_order_id: string, source_order_ids: string[] }
// 出力: { ok: true, items_moved: number, warnings: string[] }
//
// 失敗時 best-effort revert (items を source に戻す)。
//
// 認証: Supabase Auth ログイン必須 (route 共通)
// 警告: source に supplier_email 書類が紐付くものがあれば warnings に含める

export const dynamic = "force-dynamic";

type MergedFromEntry = {
  id: string;
  ordered_at: string | null;
  created_by: string | null;
  status: string | null;
  notes: string | null;
  supplier_id: string | null;
  payment_type: string | null;
  delivery_date: string | null;
  delivery_time: string | null;
  delivery_address: string | null;
  delivery_type: string | null;
  attendance_required: boolean | null;
  attendee_ids: string[] | null;
  tokka_set_price: number | null;
  email_sent_at: string | null;
  email_sent_count: number | null;
  office_id: string | null;
  event_id: string | null;
  client_id: string | null;
  tenant_id: string;
  created_at: string | null;
};

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { target_order_id, source_order_ids } = (body ?? {}) as {
    target_order_id?: unknown;
    source_order_ids?: unknown;
  };
  if (typeof target_order_id !== "string" || target_order_id.length === 0) {
    return NextResponse.json({ error: "target_order_id_invalid" }, { status: 400 });
  }
  if (!Array.isArray(source_order_ids) || source_order_ids.length === 0) {
    return NextResponse.json({ error: "source_order_ids_invalid" }, { status: 400 });
  }
  if (!source_order_ids.every((s): s is string => typeof s === "string" && s.length > 0)) {
    return NextResponse.json({ error: "source_order_ids_invalid" }, { status: 400 });
  }
  if (source_order_ids.includes(target_order_id)) {
    return NextResponse.json({ error: "source_must_not_include_target" }, { status: 400 });
  }
  // 重複除去
  const sourceIds = Array.from(new Set(source_order_ids));

  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SERVICE_KEY) {
    return NextResponse.json({ error: "service_key_missing" }, { status: 500 });
  }
  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // 1) target + source の orders を取得し、整合性チェック
  const allIds = [target_order_id, ...sourceIds];
  const { data: ordersRows, error: ordersError } = await admin
    .from("orders")
    .select("*")
    .in("id", allIds);
  if (ordersError) {
    return NextResponse.json({ error: "orders_lookup_failed", detail: ordersError.message }, { status: 500 });
  }
  const orders = (ordersRows ?? []) as Record<string, unknown>[];
  if (orders.length !== allIds.length) {
    return NextResponse.json({ error: "some_orders_not_found" }, { status: 404 });
  }
  const target = orders.find((o) => o.id === target_order_id);
  const sources = orders.filter((o) => sourceIds.includes(o.id as string));
  if (!target) {
    return NextResponse.json({ error: "target_not_found" }, { status: 404 });
  }
  // tenant_id は全件一致必須
  const targetTenant = target.tenant_id as string;
  if (sources.some((s) => s.tenant_id !== targetTenant)) {
    return NextResponse.json({ error: "tenant_mismatch" }, { status: 400 });
  }

  // 2) source の supplier_email 書類をチェック (警告のみ、統合は実行)
  const warnings: string[] = [];
  const { data: docsRows } = await admin
    .from("client_documents")
    .select("id, title, params")
    .eq("type", "supplier_email")
    .eq("tenant_id", targetTenant);
  type Doc = { id: string; title: string | null; params: { orderId?: string } | null };
  const supplierDocs = ((docsRows ?? []) as Doc[]).filter((d) => {
    const oid = d.params?.orderId;
    return typeof oid === "string" && sourceIds.includes(oid);
  });
  if (supplierDocs.length > 0) {
    warnings.push(
      `送信済みメール書類が ${supplierDocs.length} 件、統合元の発注に紐付いています (タイトル例: ${supplierDocs[0].title ?? "不明"})。統合後も再生成は可能ですが、個別の発注単位ではなく統合先の発注として表示されます。`
    );
  }

  // 3) source の order_items を取得 (revert 用に id 一覧記録)
  const { data: sourceItemsRows, error: itemsLookupError } = await admin
    .from("order_items")
    .select("id, order_id")
    .in("order_id", sourceIds);
  if (itemsLookupError) {
    return NextResponse.json({ error: "items_lookup_failed", detail: itemsLookupError.message }, { status: 500 });
  }
  const sourceItems = (sourceItemsRows ?? []) as { id: string; order_id: string }[];

  // 4) source items の order_id を target に UPDATE
  let itemsMoved = 0;
  if (sourceItems.length > 0) {
    const { data: updItems, error: updItemsError } = await admin
      .from("order_items")
      .update({ order_id: target_order_id })
      .in("order_id", sourceIds)
      .select("id");
    if (updItemsError) {
      return NextResponse.json({ error: "items_move_failed", detail: updItemsError.message }, { status: 500 });
    }
    itemsMoved = updItems?.length ?? 0;
  }

  // 5) target.merged_from_order_ids に source 情報を追記
  type Existing = { merged_from_order_ids?: MergedFromEntry[] | null };
  const existingMerged = (target as Existing).merged_from_order_ids ?? [];
  const newEntries: MergedFromEntry[] = sources.map((s) => ({
    id: s.id as string,
    ordered_at: (s.ordered_at as string) ?? null,
    created_by: (s.created_by as string | null) ?? null,
    status: (s.status as string | null) ?? null,
    notes: (s.notes as string | null) ?? null,
    supplier_id: (s.supplier_id as string | null) ?? null,
    payment_type: (s.payment_type as string | null) ?? null,
    delivery_date: (s.delivery_date as string | null) ?? null,
    delivery_time: (s.delivery_time as string | null) ?? null,
    delivery_address: (s.delivery_address as string | null) ?? null,
    delivery_type: (s.delivery_type as string | null) ?? null,
    attendance_required: (s.attendance_required as boolean | null) ?? null,
    attendee_ids: (s.attendee_ids as string[] | null) ?? null,
    tokka_set_price: (s.tokka_set_price as number | null) ?? null,
    email_sent_at: (s.email_sent_at as string | null) ?? null,
    email_sent_count: (s.email_sent_count as number | null) ?? null,
    office_id: (s.office_id as string | null) ?? null,
    event_id: (s.event_id as string | null) ?? null,
    client_id: (s.client_id as string | null) ?? null,
    tenant_id: targetTenant,
    created_at: (s.created_at as string | null) ?? null,
  }));
  const combined = [...existingMerged, ...newEntries];
  const { error: updTargetError } = await admin
    .from("orders")
    .update({
      merged_from_order_ids: combined,
      updated_at: new Date().toISOString(),
    })
    .eq("id", target_order_id);
  if (updTargetError) {
    // revert: items を元に戻す
    await revertItems(admin, sourceItems);
    return NextResponse.json({ error: "target_update_failed", detail: updTargetError.message }, { status: 500 });
  }

  // 6) source orders を DELETE
  const { error: delError } = await admin
    .from("orders")
    .delete()
    .in("id", sourceIds);
  if (delError) {
    // revert: items を元に戻し、target.merged_from_order_ids も戻す
    await revertItems(admin, sourceItems);
    await admin
      .from("orders")
      .update({ merged_from_order_ids: existingMerged })
      .eq("id", target_order_id);
    return NextResponse.json({ error: "source_delete_failed", detail: delError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    items_moved: itemsMoved,
    sources_merged: sources.length,
    warnings,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase admin client の generic 推論が tsc で食い違うため
async function revertItems(admin: any, sourceItems: { id: string; order_id: string }[]) {
  // 元の order_id ごとにグループ化して個別 UPDATE
  const groups = new Map<string, string[]>();
  for (const it of sourceItems) {
    const arr = groups.get(it.order_id) ?? [];
    arr.push(it.id);
    groups.set(it.order_id, arr);
  }
  for (const [orderId, ids] of groups) {
    await admin.from("order_items").update({ order_id: orderId }).in("id", ids);
  }
}
