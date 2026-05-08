import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// POST /api/orders/unmerge
//
// 統合済 order を元の order 単位に戻す:
//   1. target.merged_from_order_ids 各要素を元 order として再 INSERT (id 保持)
//   2. items.created_at に基づき、最も近い ordered_at の元 order に items を割り戻し
//      (= 各 item の created_at <= source.ordered_at + 1day を超えない最古の source)
//      … 単純化: items の created_at が source.ordered_at とほぼ一致するよう、
//      created_at <= source.ordered_at をベースに最も近いものへ割り当てる
//   3. target.merged_from_order_ids = []
//
// items 割り戻しロジック:
//   - target に残った items のうち、created_at が source の ordered_at に最も近い
//     (= |item.created_at - source.ordered_at| 最小) ものを割り当て。
//   - target.ordered_at にも近い items は target に残す。
//
// 入力: { order_id: string }
// 出力: { ok: true, restored_orders: number, items_reassigned: number }
//
// 認証: Supabase Auth ログイン必須

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
  const { order_id } = (body ?? {}) as { order_id?: unknown };
  if (typeof order_id !== "string" || order_id.length === 0) {
    return NextResponse.json({ error: "order_id_invalid" }, { status: 400 });
  }

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

  // 1) target を取得
  const { data: targetRow, error: targetError } = await admin
    .from("orders")
    .select("*")
    .eq("id", order_id)
    .maybeSingle();
  if (targetError) {
    return NextResponse.json({ error: "target_lookup_failed", detail: targetError.message }, { status: 500 });
  }
  if (!targetRow) {
    return NextResponse.json({ error: "target_not_found" }, { status: 404 });
  }
  const target = targetRow as Record<string, unknown> & { merged_from_order_ids?: MergedFromEntry[] | null };
  const merged = target.merged_from_order_ids ?? [];
  if (!Array.isArray(merged) || merged.length === 0) {
    return NextResponse.json({ error: "no_merged_sources" }, { status: 400 });
  }

  // 2) target に紐付く items を取得
  const { data: itemsRows, error: itemsError } = await admin
    .from("order_items")
    .select("id, created_at")
    .eq("order_id", order_id);
  if (itemsError) {
    return NextResponse.json({ error: "items_lookup_failed", detail: itemsError.message }, { status: 500 });
  }
  const items = (itemsRows ?? []) as { id: string; created_at: string | null }[];

  // 3) 元 order を再 INSERT (id 保持)
  // 注: id 衝突は通常無い (DELETE 済) が念のため check
  const restorePayloads = merged.map((m) => ({
    id: m.id,
    tenant_id: m.tenant_id,
    client_id: m.client_id,
    event_id: m.event_id,
    ordered_at: m.ordered_at,
    created_by: m.created_by,
    status: m.status ?? "ordered",
    notes: m.notes,
    payment_type: m.payment_type ?? "介護",
    delivery_date: m.delivery_date,
    delivery_time: m.delivery_time,
    delivery_address: m.delivery_address,
    delivery_type: m.delivery_type ?? "自社納品",
    attendance_required: m.attendance_required ?? false,
    attendee_ids: m.attendee_ids ?? [],
    supplier_id: m.supplier_id,
    email_sent_at: m.email_sent_at,
    email_sent_count: m.email_sent_count ?? 0,
    tokka_set_price: m.tokka_set_price,
    office_id: m.office_id,
    merged_from_order_ids: [],
    // created_at / updated_at は server default に任せる
  }));

  // id 衝突チェック
  const restoreIds = restorePayloads.map((p) => p.id);
  const { data: collideRows } = await admin
    .from("orders")
    .select("id")
    .in("id", restoreIds);
  if ((collideRows ?? []).length > 0) {
    return NextResponse.json({
      error: "restore_id_collision",
      detail: `元 order id が既存 orders と衝突: ${(collideRows ?? []).map((r: { id: string }) => r.id).join(", ")}`,
    }, { status: 409 });
  }

  const { error: insertError } = await admin
    .from("orders")
    .insert(restorePayloads);
  if (insertError) {
    return NextResponse.json({ error: "restore_failed", detail: insertError.message }, { status: 500 });
  }

  // 4) items を割り戻し
  // 各 item を ordered_at が最も近い source (= |item.created_at - source.ordered_at| 最小)
  // に割り当てる。target 自身も candidate に含める (元々 target にあった items は残す)。
  const targetOriginalOrderedAt = (target.ordered_at as string | null) ?? null;
  const candidates: { id: string; ordered_at: string | null }[] = [
    { id: order_id, ordered_at: targetOriginalOrderedAt },
    ...merged.map((m) => ({ id: m.id, ordered_at: m.ordered_at })),
  ];

  // item ごとに best match を決定し、order_id ごとに UPDATE をまとめる
  const reassignMap = new Map<string, string[]>(); // newOrderId -> itemIds
  let reassigned = 0;
  for (const it of items) {
    const itemTime = it.created_at ? new Date(it.created_at).getTime() : 0;
    let bestId: string = order_id;
    let bestDiff = Infinity;
    for (const c of candidates) {
      const t = c.ordered_at ? new Date(c.ordered_at).getTime() : 0;
      const diff = Math.abs(itemTime - t);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestId = c.id;
      }
    }
    if (bestId !== order_id) reassigned++;
    const arr = reassignMap.get(bestId) ?? [];
    arr.push(it.id);
    reassignMap.set(bestId, arr);
  }

  // target 以外への割当てだけ UPDATE
  for (const [newOrderId, itemIds] of reassignMap) {
    if (newOrderId === order_id) continue; // target に残すので no-op
    if (itemIds.length === 0) continue;
    const { error: updError } = await admin
      .from("order_items")
      .update({ order_id: newOrderId })
      .in("id", itemIds);
    if (updError) {
      // revert (best effort): 復元した orders を削除し、items は target に戻す
      await admin.from("orders").delete().in("id", restoreIds);
      // 既に他 source に動いた items を target に戻す
      for (const [movedId, movedItemIds] of reassignMap) {
        if (movedId === order_id) continue;
        await admin.from("order_items").update({ order_id: order_id }).in("id", movedItemIds);
      }
      return NextResponse.json({ error: "items_reassign_failed", detail: updError.message }, { status: 500 });
    }
  }

  // 5) target.merged_from_order_ids = []
  const { error: clearError } = await admin
    .from("orders")
    .update({
      merged_from_order_ids: [],
      updated_at: new Date().toISOString(),
    })
    .eq("id", order_id);
  if (clearError) {
    // 既に items 移動済み・order 復元済み。clear だけ失敗 = 軽微。warn 返す
    return NextResponse.json({
      ok: true,
      restored_orders: restorePayloads.length,
      items_reassigned: reassigned,
      warning: "merged_from_order_ids のクリアに失敗 (手動で除去要)",
    });
  }

  return NextResponse.json({
    ok: true,
    restored_orders: restorePayloads.length,
    items_reassigned: reassigned,
  });
}
