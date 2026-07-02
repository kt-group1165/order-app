import { supabase } from "./supabase";

// サービス担当者会議の要点 (第4表) — service_meeting_notes
// 利用者名は移行期間のため手入力 (client_name)。client_id は将来の連動用 (現状 NULL)。

export type MeetingAttendee = {
  affiliation: string; // 所属(職種)
  name: string;        // 氏名
};

export type ServiceMeetingNote = {
  id?: string;
  tenant_id: string;
  client_id?: string | null;         // 将来の利用者連動用 (現状 NULL)
  client_name: string;
  creator_name?: string | null;      // 居宅サービス計画作成者氏名(担当者)
  created_date?: string | null;      // 作成年月日 (YYYY-MM-DD)
  meeting_date?: string | null;      // 開催日 (YYYY-MM-DD)
  meeting_time?: string | null;      // 時間 (例 "14:00〜15:00")
  meeting_place?: string | null;     // 開催場所
  attendees: MeetingAttendee[];      // 最大 6 名
  discussed_items?: string | null;   // 検討した項目
  discussion_content?: string | null; // 検討内容
  conclusion?: string | null;        // 結論
  remaining_issues?: string | null;  // 残された課題
  next_meeting?: string | null;      // 次回の開催時期
  created_at?: string;
  updated_at?: string;
};

export async function listMeetingNotes(tenantId: string): Promise<ServiceMeetingNote[]> {
  const { data, error } = await supabase
    .from("service_meeting_notes")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as ServiceMeetingNote[];
}

// id あり → update (updated_at 更新)、無し → insert。保存後の行を返す。
export async function saveMeetingNote(note: ServiceMeetingNote): Promise<ServiceMeetingNote> {
  const payload = {
    tenant_id: note.tenant_id,
    client_id: note.client_id ?? null,
    client_name: note.client_name,
    creator_name: note.creator_name || null,
    created_date: note.created_date || null,
    meeting_date: note.meeting_date || null,
    meeting_time: note.meeting_time || null,
    meeting_place: note.meeting_place || null,
    attendees: note.attendees,
    discussed_items: note.discussed_items || null,
    discussion_content: note.discussion_content || null,
    conclusion: note.conclusion || null,
    remaining_issues: note.remaining_issues || null,
    next_meeting: note.next_meeting || null,
  };
  if (note.id) {
    const { data, error } = await supabase
      .from("service_meeting_notes")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", note.id)
      .select()
      .single();
    if (error) throw error;
    return data as ServiceMeetingNote;
  }
  const { data, error } = await supabase
    .from("service_meeting_notes")
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data as ServiceMeetingNote;
}

export async function deleteMeetingNote(id: string): Promise<void> {
  const { error } = await supabase
    .from("service_meeting_notes")
    .delete()
    .eq("id", id);
  if (error) throw error;
}
