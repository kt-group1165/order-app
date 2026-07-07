import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// スマホ入力ページ (/m/meeting) からの担当者会議録 送信 API。
// 認証: URL 共有キー (env MEETING_FORM_KEY) の一致を検証してから
// service_role で service_meeting_notes に INSERT する。
// キー未設定時は 503 を返す (Vercel の環境変数に設定が必要)。

const TENANT_ID = "kt-group";
const MAX_LEN = 4000;

// 事業所別 URL の slug → 本体 offices.id (将来のデータ連結キー) + 表示名
const OFFICES: Record<string, { id: string; label: string }> = {
  "caresupo":   { id: "1bfc0d57-9ee0-4ae2-baa5-80edb776290a", label: "介護ショップケア・サポート千葉" },
  "hana-mutsumi": { id: "bf2cbf8d-d4ca-4887-beae-a867d71a2b16", label: "Ｈａｎａムツミ福祉用具" },
  "takashina":  { id: "ea7d88ea-5373-4054-8b6d-e8a11fbae217", label: "千葉ムツミ福祉用具高品" },
  "hanamigawa": { id: "e1b7b604-a4fd-44d5-98d1-efcb440ba035", label: "Ｈａｎａ福祉用具花見川" },
  "links":      { id: "c3a5a2f7-a8f9-4d7a-81f5-3cf6a9c51f08", label: "リンクス福祉用具" },
};

const s = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, MAX_LEN);
};

// 一覧取得 (スマホページの「一覧」タブ用)。キー検証付き。
export async function GET(req: Request) {
  const formKey = process.env.MEETING_FORM_KEY;
  if (!formKey) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (MEETING_FORM_KEY 未設定)" },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== formKey) {
    return NextResponse.json({ error: "キーが正しくありません" }, { status: 403 });
  }
  const officeSlug = url.searchParams.get("office");
  const office = officeSlug ? OFFICES[officeSlug] : null;
  if (officeSlug && !office) {
    return NextResponse.json({ error: "事業所の指定が正しくありません" }, { status: 400 });
  }
  const admin = createAdminClient();
  let q = admin
    .from("service_meeting_notes")
    .select("id, client_name, creator_name, created_date, meeting_date, meeting_time, meeting_place, attendees, discussed_items, discussion_content, conclusion, remaining_issues, next_meeting, office_label, created_at")
    .eq("tenant_id", TENANT_ID)
    .order("created_at", { ascending: false })
    .limit(100);
  // 事業所指定 URL からはその事業所の分だけ (指定なし = 全件: 旧共通URL互換)
  if (office) q = q.eq("office_id", office.id);
  const { data, error } = await q;
  if (error) {
    console.error("meeting-submit list failed:", error.message);
    return NextResponse.json({ error: `取得に失敗しました: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ notes: data ?? [] });
}

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

  // 事業所 (slug): 未指定は共通 (office 無し) として保存
  const officeSlug = typeof body.office === "string" ? body.office : null;
  const office = officeSlug ? OFFICES[officeSlug] : null;
  if (officeSlug && !office) {
    return NextResponse.json({ error: "事業所の指定が正しくありません" }, { status: 400 });
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

  // 内容フィールド (新規/更新 共通)。office_id/office_label は新規時のみ設定
  const content = {
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

  // id あり → 既存レコードの更新 (編集)。office 指定時はその事業所分に限定。
  // office_id/office_label は変更しない (共通URL からの更新で消さないため)。
  const editId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
  if (editId) {
    let upd = admin
      .from("service_meeting_notes")
      .update({ ...content, updated_at: new Date().toISOString() })
      .eq("id", editId)
      .eq("tenant_id", TENANT_ID);
    if (office) upd = upd.eq("office_id", office.id);
    const { error } = await upd;
    if (error) {
      console.error("meeting-submit update failed:", error.message);
      return NextResponse.json({ error: `更新に失敗しました: ${error.message}` }, { status: 500 });
    }
    return NextResponse.json({ ok: true, id: editId });
  }

  const { error } = await admin
    .from("service_meeting_notes")
    .insert({ tenant_id: TENANT_ID, office_id: office?.id ?? null, office_label: office?.label ?? null, ...content });
  if (error) {
    console.error("meeting-submit insert failed:", error.message);
    return NextResponse.json({ error: `保存に失敗しました: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

// 会議録の削除。キー + id 検証付き。office 指定時はその事業所分に限定。
export async function DELETE(req: Request) {
  const formKey = process.env.MEETING_FORM_KEY;
  if (!formKey) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (MEETING_FORM_KEY 未設定)" },
      { status: 503 }
    );
  }
  const url = new URL(req.url);
  if (url.searchParams.get("key") !== formKey) {
    return NextResponse.json({ error: "キーが正しくありません" }, { status: 403 });
  }
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id が指定されていません" }, { status: 400 });
  }
  const officeSlug = url.searchParams.get("office");
  const office = officeSlug ? OFFICES[officeSlug] : null;
  if (officeSlug && !office) {
    return NextResponse.json({ error: "事業所の指定が正しくありません" }, { status: 400 });
  }
  const admin = createAdminClient();
  let del = admin
    .from("service_meeting_notes")
    .delete()
    .eq("id", id)
    .eq("tenant_id", TENANT_ID);
  if (office) del = del.eq("office_id", office.id);
  const { error } = await del;
  if (error) {
    console.error("meeting-submit delete failed:", error.message);
    return NextResponse.json({ error: `削除に失敗しました: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
