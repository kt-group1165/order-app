import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyAttendanceToken } from "@/lib/attendanceToken";

// 本人による「確定＆提出」。
// 認証: 個人トークン (lib/attendanceToken.ts)。自分の月しか提出できない。
// 提出後は /api/attendance-self の POST が 409 を返し、本人は編集できなくなる。
// 差し戻し (未提出に戻す) は管理者のみ (出勤簿タブ)。

const TENANT_ID = "kt-group";
const MONTH_RE = /^\d{4}-\d{2}$/;

export async function POST(req: Request) {
  if (!process.env.ATTENDANCE_FORM_SECRET) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (ATTENDANCE_FORM_SECRET 未設定)" },
      { status: 503 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400 });
  }
  const { t, month } = (body ?? {}) as { t?: unknown; month?: unknown };
  const payload = typeof t === "string" ? verifyAttendanceToken(t) : null;
  if (!payload) {
    return NextResponse.json({ error: "URL が正しくありません" }, { status: 403 });
  }
  if (typeof month !== "string" || !MONTH_RE.test(month)) {
    return NextResponse.json({ error: "month が不正です" }, { status: 400 });
  }

  const admin = createAdminClient();

  // URL の有効性 (無効化 / 再発行) を self API と同じ基準で確認
  const { data: setting, error: settingErr } = await admin
    .from("attendance_url_settings")
    .select("disabled, token_version")
    .eq("employee_id", payload.employeeId)
    .maybeSingle();
  if (settingErr && settingErr.code !== "42P01") {
    console.error("submit settings fetch failed:", settingErr.message);
    return NextResponse.json({ error: `設定の取得に失敗: ${settingErr.message}` }, { status: 500 });
  }
  if (
    (setting?.disabled ?? false) ||
    payload.version !== ((setting?.token_version as number | null) ?? 1)
  ) {
    return NextResponse.json({ error: "この URL は無効です" }, { status: 403 });
  }

  const { data: emp, error: empErr } = await admin
    .from("payroll_employees")
    .select("id, name, employment_status")
    .eq("id", payload.employeeId)
    .maybeSingle();
  if (empErr) {
    console.error("submit employee fetch failed:", empErr.message);
    return NextResponse.json({ error: `職員の取得に失敗: ${empErr.message}` }, { status: 500 });
  }
  if (!emp || emp.employment_status === "退職者") {
    return NextResponse.json({ error: "この URL は無効です" }, { status: 403 });
  }

  const { error } = await admin.from("attendance_month_status").upsert(
    {
      tenant_id: TENANT_ID,
      employee_id: emp.id as string,
      month_start: `${month}-01`,
      status: "submitted",
      submitted_at: new Date().toISOString(),
      submitted_by: emp.name as string,
      approved_at: null,
      approved_by: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "employee_id,month_start" },
  );
  if (error) {
    if (error.code === "42P01") {
      return NextResponse.json(
        { error: "提出状況のテーブルが未適用です (管理者に連絡してください)" },
        { status: 503 },
      );
    }
    console.error("submit upsert failed:", error.message);
    return NextResponse.json({ error: `提出に失敗: ${error.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
