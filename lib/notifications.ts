"use client";

import { supabase } from "@/lib/supabase";

// 事業所間書類連携 v1: notifications + shared_documents 用の薄い fetch helper。
// kaigo-app の lib/notifications.ts を移植 (commit 7e4ac7a + 9f397e7)。
// RLS 側で office 可視性を担保するため、UI 側は素直に query を投げるだけ。

export interface NotificationRow {
  id: string;
  tenant_id: string;
  office_id: string;
  user_id: string | null;
  type: string;
  ref_table: string | null;
  ref_id: string | null;
  title: string;
  body: string | null;
  read_at: string | null;
  read_by: string | null;
  created_at: string;
}

export interface SharedDocumentRow {
  id: string;
  tenant_id: string;
  client_id: string;
  source_office_id: string;
  target_office_id: string;
  document_type: string;
  title: string;
  html_content: string;
  payload: Record<string, unknown> | null;
  source_document_id: string | null;
  sent_at: string;
  sent_by: string | null;
  read_at: string | null;
  read_by: string | null;
  created_at: string;
}

/**
 * 指定 office の未読 notifications 件数を返す。
 * RLS で見えない office_id なら 0 が返る (filter が空一致)。
 */
export async function getUnreadCount(officeId: string): Promise<number> {
  if (!officeId) return 0;
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("office_id", officeId)
    .is("read_at", null);
  if (error) {
    // 通知 table 未適用 / RLS 拒否などは 0 件扱い (UI を壊さない)
    return 0;
  }
  return count ?? 0;
}

/**
 * 指定 office の通知一覧 (sent_at desc)。
 * 件数上限は 200 件 (Phase 9 close で audit 済の 1000 行 limit よりは小さく抑える)。
 */
export async function getNotifications(
  officeId: string,
  limit = 200,
): Promise<NotificationRow[]> {
  if (!officeId) return [];
  const { data, error } = await supabase
    .from("notifications")
    .select(
      "id, tenant_id, office_id, user_id, type, ref_table, ref_id, title, body, read_at, read_by, created_at",
    )
    .eq("office_id", officeId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as NotificationRow[];
}

/**
 * 通知 1 件を既読化。
 * 既に read_at 入りなら no-op (RLS UPDATE は常に WHERE id 経由)。
 */
export async function markRead(id: string): Promise<void> {
  if (!id) return;
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);
}

/**
 * shared_documents 1 件取得 (RLS で source/target どちらかに含まれてれば可視)。
 */
export async function getSharedDocument(id: string): Promise<SharedDocumentRow | null> {
  if (!id) return null;
  const { data, error } = await supabase
    .from("shared_documents")
    .select(
      "id, tenant_id, client_id, source_office_id, target_office_id, document_type, title, html_content, payload, source_document_id, sent_at, sent_by, read_at, read_by, created_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) return null;
  return (data ?? null) as SharedDocumentRow | null;
}

/**
 * shared_documents の read_at / read_by を初回 1 度だけ更新。
 * 既に read_at 入りなら no-op (RLS UPDATE は target_office に限定)。
 *
 * 同時に「同じ ref_id を指す document_received 通知」も既読化する。
 */
export async function markSharedDocumentRead(sharedDocId: string): Promise<void> {
  if (!sharedDocId) return;
  const now = new Date().toISOString();
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData?.user?.id ?? null;

  await supabase
    .from("shared_documents")
    .update({ read_at: now, read_by: uid })
    .eq("id", sharedDocId)
    .is("read_at", null);

  // 関連 notifications を一括既読化
  await supabase
    .from("notifications")
    .update({ read_at: now, read_by: uid })
    .eq("type", "document_received")
    .eq("ref_table", "shared_documents")
    .eq("ref_id", sharedDocId)
    .is("read_at", null);
}
