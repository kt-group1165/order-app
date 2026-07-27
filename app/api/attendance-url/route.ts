import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { issueAttendanceToken } from "@/lib/attendanceToken";

// 出勤簿 自己入力 URL の発行 API (管理者用)。
// 認証: Supabase Auth (middleware 通過後、念のため getUser でも確認)。
// GET ?payroll_office_id=<uuid> → 事業所の在籍職員全員分の URL を返す。

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  if (!process.env.ATTENDANCE_FORM_SECRET) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (ATTENDANCE_FORM_SECRET 未設定)" },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const payrollOfficeId = url.searchParams.get("payroll_office_id");
  if (!payrollOfficeId) {
    return NextResponse.json({ error: "payroll_office_id が必要です" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("payroll_employees")
    .select("id, name")
    .eq("office_id", payrollOfficeId)
    .neq("employment_status", "退職者")
    .order("name");
  if (error) {
    console.error("attendance-url employees fetch failed:", error.message);
    return NextResponse.json({ error: `職員の取得に失敗: ${error.message}` }, { status: 500 });
  }

  const origin = url.origin;
  const staff = (data ?? []).map((e) => {
    const token = issueAttendanceToken(e.id as string);
    return {
      employee_id: e.id as string,
      name: e.name as string,
      url: token ? `${origin}/m/attendance?t=${token}` : null,
    };
  });

  return NextResponse.json({ staff });
}
