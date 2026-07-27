import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { issueAttendanceToken } from "@/lib/attendanceToken";

// 出勤簿 自己入力 URL の発行・個別制御 API (管理者用)。
// 認証: Supabase Auth (middleware 通過後、念のため getUser でも確認)。
//
// GET  ?payroll_office_id=<uuid>
//   → 事業所の在籍職員全員分の { name, url, disabled } を返す。
// POST { employee_id, action: "disable" | "enable" | "reissue" }
//   → attendance_url_settings を upsert して結果 (新 URL 含む) を返す。
//     disable = URL を無効化 (URL 自体は変えない。再有効化で同じ URL が復活)
//     enable  = 無効化を解除
//     reissue = token_version+1 で旧 URL を失効させ、新 URL を発行 (有効化も兼ねる)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function requireAuth(): Promise<NextResponse | null> {
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
  return null;
}

function buildUrl(origin: string, employeeId: string, version: number): string | null {
  const token = issueAttendanceToken(employeeId, version);
  return token ? `${origin}/m/attendance?t=${token}` : null;
}

export async function GET(req: Request) {
  const authErr = await requireAuth();
  if (authErr) return authErr;

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
  const employees = data ?? [];

  // 個別制御の状態。row 無し = 有効 / version 1。
  // table 未 apply (42P01) は全員デフォルト (settingsAvailable=false で UI に伝える)。
  const ids = employees.map((e) => e.id as string);
  let settingsAvailable = true;
  const settingMap = new Map<string, { disabled: boolean; token_version: number }>();
  if (ids.length > 0) {
    const { data: settings, error: settingsErr } = await admin
      .from("attendance_url_settings")
      .select("employee_id, disabled, token_version")
      .in("employee_id", ids);
    if (settingsErr) {
      if (settingsErr.code === "42P01") {
        settingsAvailable = false;
      } else {
        console.error("attendance-url settings fetch failed:", settingsErr.message);
        return NextResponse.json({ error: `設定の取得に失敗: ${settingsErr.message}` }, { status: 500 });
      }
    } else {
      for (const s of settings ?? []) {
        settingMap.set(s.employee_id as string, {
          disabled: !!s.disabled,
          token_version: (s.token_version as number) ?? 1,
        });
      }
    }
  }

  const origin = url.origin;
  const staff = employees.map((e) => {
    const id = e.id as string;
    const s = settingMap.get(id) ?? { disabled: false, token_version: 1 };
    return {
      employee_id: id,
      name: e.name as string,
      disabled: s.disabled,
      url: s.disabled ? null : buildUrl(origin, id, s.token_version),
    };
  });

  return NextResponse.json({ staff, settings_available: settingsAvailable });
}

export async function POST(req: Request) {
  const authErr = await requireAuth();
  if (authErr) return authErr;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400 });
  }
  const { employee_id, action } = (body ?? {}) as { employee_id?: unknown; action?: unknown };
  if (typeof employee_id !== "string" || !UUID_RE.test(employee_id)) {
    return NextResponse.json({ error: "employee_id が不正です" }, { status: 400 });
  }
  if (action !== "disable" && action !== "enable" && action !== "reissue") {
    return NextResponse.json({ error: "action が不正です" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 対象職員の存在確認 (payroll_employees に居ない id への row 作成を防ぐ)
  const { data: emp, error: empErr } = await admin
    .from("payroll_employees")
    .select("id")
    .eq("id", employee_id)
    .maybeSingle();
  if (empErr) {
    console.error("attendance-url employee check failed:", empErr.message);
    return NextResponse.json({ error: `職員の確認に失敗: ${empErr.message}` }, { status: 500 });
  }
  if (!emp) {
    return NextResponse.json({ error: "職員が見つかりません" }, { status: 404 });
  }

  const { data: current, error: curErr } = await admin
    .from("attendance_url_settings")
    .select("disabled, token_version")
    .eq("employee_id", employee_id)
    .maybeSingle();
  if (curErr) {
    if (curErr.code === "42P01") {
      return NextResponse.json(
        { error: "attendance_url_settings テーブルが未適用です (migrations/attendance_url_settings.sql を適用してください)" },
        { status: 503 },
      );
    }
    console.error("attendance-url settings fetch failed:", curErr.message);
    return NextResponse.json({ error: `設定の取得に失敗: ${curErr.message}` }, { status: 500 });
  }

  const currentVersion = (current?.token_version as number | null) ?? 1;
  const next = {
    employee_id,
    disabled: action === "disable",
    token_version: action === "reissue" ? currentVersion + 1 : currentVersion,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await admin
    .from("attendance_url_settings")
    .upsert(next, { onConflict: "employee_id" });
  if (upsertErr) {
    console.error("attendance-url settings upsert failed:", upsertErr.message);
    return NextResponse.json({ error: `設定の保存に失敗: ${upsertErr.message}` }, { status: 500 });
  }

  const origin = new URL(req.url).origin;
  return NextResponse.json({
    employee_id,
    disabled: next.disabled,
    url: next.disabled ? null : buildUrl(origin, employee_id, next.token_version),
  });
}
