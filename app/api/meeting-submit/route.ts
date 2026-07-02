import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// スマホ入力ページ (/m/meeting) からの担当者会議録 送信 API。
// 認証: URL 共有キー (env MEETING_FORM_KEY) の一致を検証してから
// service_role で service_meeting_notes に INSERT する。
// キー未設定時は 503 を返す (Vercel の環境変数に設定が必要)。

const TENANT_ID = "kt-group";
const MAX_LEN = 4000;

const s = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, MAX_LEN);
};

export async function POST(req: Request) {
  const formKey = process.env.MEETING_FORM_KEY;
  if (!formKey) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (MEETING_FORM_KEY 未設定)" },
      { status: 503 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  if (typeof body.key !== "string" || body.key !== formKey) {
    return NextResponse.json({ error: "キーが正しくありません" }, { status: 403 });
  }

  const clientName = s(body.client_name);
  if (!clientName) {
    return NextResponse.json({ error: "利用者名は必須です" }, { status: 400 });
  }

  // attendees: [{affiliation, name}] を最大6件・文字列のみ許可
  const attendees: { affiliation: string; name: string }[] = [];
  if (Array.isArray(body.attendees)) {
    for (const a of body.attendees.slice(0, 6)) {
      if (a && typeof a === "object") {
        const affiliation = s((a as Record<string, unknown>).affiliation) ?? "";
        const name = s((a as Record<string, unknown>).name) ?? "";
        if (affiliation || name) attendees.push({ affiliation, name });
      }
    }
  }

  const row = {
    tenant_id: TENANT_ID,
    client_name: clientName,
    creator_name: s(body.creator_name),
    created_date: s(body.created_date),
    meeting_date: s(body.meeting_date),
    meeting_time: s(body.meeting_time),
    meeting_place: s(body.meeting_place),
    attendees,
    discussed_items: s(body.discussed_items),
    discussion_content: s(body.discussion_content),
    conclusion: s(body.conclusion),
    remaining_issues: s(body.remaining_issues),
    next_meeting: s(body.next_meeting),
  };

  const admin = createAdminClient();
  const { error } = await admin.from("service_meeting_notes").insert(row);
  if (error) {
    console.error("meeting-submit insert failed:", error.message);
    return NextResponse.json({ error: `保存に失敗しました: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
