import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  generateInitialPassword,
  generateToken,
  hashPassword,
} from "@/lib/invitations";
import {
  dedupLoginId,
  extractLoginIdHint,
  isValidLoginId,
} from "@/lib/login_id";
import { createClient as createAdminClient } from "@supabase/supabase-js";

// POST /api/staff/invite (order-app)
//
// office_admin / company_admin / group_admin が新しいスタッフを招待する。
// 入力:   { display_name, office_id, role, member_id?, login_id? }
// 出力:   { token, invite_url, initial_password, expires_at }
//
// invite_url は calendar-app の /invite/<token> に向ける (consume page は
// calendar-app に集約)。NEXT_PUBLIC_CALENDAR_APP_URL があればそれを base に、
// 無ければ request の origin を fallback。

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const { display_name, office_id, role, member_id, login_id } = (body ?? {}) as {
    display_name?: unknown;
    office_id?: unknown;
    role?: unknown;
    member_id?: unknown;
    login_id?: unknown;
  };

  if (typeof display_name !== "string" || display_name.trim().length === 0 || display_name.length > 64) {
    return NextResponse.json({ error: "display_name_invalid" }, { status: 400 });
  }
  if (typeof office_id !== "string" || office_id.length === 0) {
    return NextResponse.json({ error: "office_id_invalid" }, { status: 400 });
  }
  if (role !== "office_admin" && role !== "member") {
    return NextResponse.json({ error: "role_invalid" }, { status: 400 });
  }
  if (member_id !== undefined && member_id !== null && typeof member_id !== "string") {
    return NextResponse.json({ error: "member_id_invalid" }, { status: 400 });
  }
  if (login_id !== undefined && login_id !== null && typeof login_id !== "string") {
    return NextResponse.json({ error: "login_id_invalid" }, { status: 400 });
  }
  const requestedLoginId = typeof login_id === "string" && login_id.trim().length > 0
    ? login_id.trim().toLowerCase()
    : null;
  if (requestedLoginId !== null && !isValidLoginId(requestedLoginId)) {
    return NextResponse.json({ error: "login_id_invalid" }, { status: 400 });
  }

  const supabase = await createClient();

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const callerId = userData.user.id;

  const { data: adminRows, error: adminError } = await supabase.rpc(
    "auth_admin_office_ids"
  );
  if (adminError) {
    return NextResponse.json({ error: "permission_check_failed" }, { status: 500 });
  }
  type AdminRow = { auth_admin_office_ids?: string } | string;
  const adminOfficeIds = ((adminRows ?? []) as AdminRow[]).map((r) =>
    typeof r === "string" ? r : r.auth_admin_office_ids ?? ""
  );
  if (!adminOfficeIds.includes(office_id)) {
    return NextResponse.json({ error: "office_not_allowed" }, { status: 403 });
  }

  const baseLoginId = requestedLoginId ?? extractLoginIdHint(display_name.trim());
  if (!baseLoginId) {
    return NextResponse.json(
      {
        error: "login_id_required",
        message: "表示名から login_id を自動派生できませんでした。login_id を明示的に指定してください。",
      },
      { status: 400 }
    );
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

  const taken = new Set<string>();
  const { data: usersList, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listError) {
    return NextResponse.json({ error: "list_users_failed" }, { status: 500 });
  }
  for (const u of usersList?.users ?? []) {
    const email = u.email ?? "";
    const lid = email.endsWith("@kt-staff.invalid") ? email.split("@")[0] : null;
    if (lid) taken.add(lid);
  }
  const { data: pendingInvites } = await admin
    .from("staff_invitations")
    .select("login_id")
    .is("consumed_at", null)
    .not("login_id", "is", null);
  for (const r of (pendingInvites ?? []) as { login_id: string | null }[]) {
    if (r.login_id) taken.add(r.login_id);
  }

  const finalLoginId = dedupLoginId(baseLoginId, taken);
  if (!finalLoginId) {
    return NextResponse.json(
      { error: "login_id_dedup_exhausted", message: "login_id の連番候補を使い切りました。別の base を指定してください。" },
      { status: 409 }
    );
  }

  const token = generateToken();
  const initialPassword = generateInitialPassword();
  const initialPasswordHash = await hashPassword(initialPassword);

  const { error: insertError } = await supabase.from("staff_invitations").insert({
    token,
    display_name: display_name.trim(),
    office_id,
    role,
    member_id: member_id ?? null,
    login_id: finalLoginId,
    initial_password_hash: initialPasswordHash,
    created_by: callerId,
  });
  if (insertError) {
    return NextResponse.json(
      { error: "insert_failed", detail: insertError.message },
      { status: 400 }
    );
  }

  const { data: row } = await supabase
    .from("staff_invitations")
    .select("expires_at")
    .eq("token", token)
    .maybeSingle();

  // calendar-app の /invite/<token> に向ける (consume page は calendar-app に集約)
  const calendarBase = process.env.NEXT_PUBLIC_CALENDAR_APP_URL
    ?? request.headers.get("origin")
    ?? new URL(request.url).origin;
  const inviteUrl = `${calendarBase}/invite/${token}`;

  return NextResponse.json({
    token,
    invite_url: inviteUrl,
    initial_password: initialPassword,
    login_id: finalLoginId,
    login_id_was_renamed: requestedLoginId !== null && requestedLoginId !== finalLoginId,
    expires_at: row?.expires_at ?? null,
  });
}
