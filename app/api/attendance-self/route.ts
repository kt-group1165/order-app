import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyAttendanceToken } from "@/lib/attendanceToken";
import { extendedMonthRange } from "@/lib/attendance/attendance-calc";

// 出勤簿 自己入力 API (/m/attendance から呼ばれる)。
// 認証: 個人トークン (HMAC 署名、lib/attendanceToken.ts) を検証してから
// service_role で読み書きする。どのパスでもトークンの employee_id 以外の row には
// 一切触れない (= URL を知っている本人は自分の分だけ操作できる)。

const TENANT_ID = "kt-group";
const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

type EmployeeCtx = {
  id: string;
  name: string;
  office_id: string;
  work_week_start: number;
};

async function resolveEmployee(token: string | null): Promise<EmployeeCtx | NextResponse> {
  if (!process.env.ATTENDANCE_FORM_SECRET) {
    return NextResponse.json(
      { error: "サーバー側の設定が未完了です (ATTENDANCE_FORM_SECRET 未設定)" },
      { status: 503 },
    );
  }
  const payload = token ? verifyAttendanceToken(token) : null;
  if (!payload) {
    return NextResponse.json({ error: "URL が正しくありません" }, { status: 403 });
  }
  const employeeId = payload.employeeId;
  const admin = createAdminClient();

  // 個別制御 (無効化 / 再発行)。row 無し = 有効 / version 1。
  // table 未 apply (42P01) は全員デフォルト扱いにフォールバックする (それ以外の error は 500)。
  const { data: setting, error: settingErr } = await admin
    .from("attendance_url_settings")
    .select("disabled, token_version")
    .eq("employee_id", employeeId)
    .maybeSingle();
  if (settingErr && settingErr.code !== "42P01") {
    console.error("attendance-self settings fetch failed:", settingErr.message);
    return NextResponse.json({ error: `設定の取得に失敗: ${settingErr.message}` }, { status: 500 });
  }
  const disabled = setting?.disabled ?? false;
  const currentVersion = (setting?.token_version as number | null) ?? 1;
  if (disabled || payload.version !== currentVersion) {
    return NextResponse.json({ error: "この URL は無効です" }, { status: 403 });
  }

  const { data, error } = await admin
    .from("payroll_employees")
    .select("id, name, office_id, employment_status")
    .eq("id", employeeId)
    .maybeSingle();
  if (error) {
    console.error("attendance-self employee fetch failed:", error.message);
    return NextResponse.json({ error: `職員の取得に失敗: ${error.message}` }, { status: 500 });
  }
  if (!data || data.employment_status === "退職者") {
    return NextResponse.json({ error: "この URL は無効です" }, { status: 403 });
  }
  const { data: office, error: officeErr } = await admin
    .from("payroll_offices")
    .select("id, work_week_start")
    .eq("id", data.office_id)
    .maybeSingle();
  if (officeErr) {
    console.error("attendance-self office fetch failed:", officeErr.message);
    return NextResponse.json({ error: `事業所の取得に失敗: ${officeErr.message}` }, { status: 500 });
  }
  return {
    id: data.id as string,
    name: data.name as string,
    office_id: data.office_id as string,
    work_week_start: (office?.work_week_start as number | null) ?? 0,
  };
}

// ─── GET: 本人情報 + 指定月の出勤簿 ─────────────────────────────────
// ?t=<token>&month=YYYY-MM
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ctx = await resolveEmployee(url.searchParams.get("t"));
  if (ctx instanceof NextResponse) return ctx;

  const month = url.searchParams.get("month") ?? "";
  if (!MONTH_RE.test(month)) {
    return NextResponse.json({ error: "month が不正です" }, { status: 400 });
  }
  const { start, end } = extendedMonthRange(month, ctx.work_week_start);

  const admin = createAdminClient();
  const [recordsRes, holidaysRes] = await Promise.all([
    admin
      .from("payroll_kyotaku_attendance_records")
      .select("*")
      .eq("employee_id", ctx.id)
      .gte("work_date", start)
      .lte("work_date", end),
    admin
      .from("payroll_company_holidays")
      .select("holiday_date")
      .eq("tenant_id", TENANT_ID)
      .gte("holiday_date", start)
      .lte("holiday_date", end),
  ]);
  if (recordsRes.error) {
    console.error("attendance-self records fetch failed:", recordsRes.error.message);
    return NextResponse.json({ error: `出勤簿の取得に失敗: ${recordsRes.error.message}` }, { status: 500 });
  }
  if (holidaysRes.error) {
    console.error("attendance-self holidays fetch failed:", holidaysRes.error.message);
    return NextResponse.json({ error: `会社休日の取得に失敗: ${holidaysRes.error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    employee: { name: ctx.name, work_week_start: ctx.work_week_start },
    records: recordsRes.data ?? [],
    company_holidays: (holidaysRes.data ?? []).map(
      (r: { holiday_date: string }) => r.holiday_date,
    ),
  });
}

// ─── POST: 本人の row を upsert / delete ────────────────────────────
// body: { t, upserts: [...], delete_dates: ["YYYY-MM-DD", ...] }
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400 });
  }
  const { t, upserts, delete_dates } = (body ?? {}) as {
    t?: unknown;
    upserts?: unknown;
    delete_dates?: unknown;
  };

  const ctx = await resolveEmployee(typeof t === "string" ? t : null);
  if (ctx instanceof NextResponse) return ctx;

  const upsertArr = Array.isArray(upserts) ? upserts : [];
  const deleteArr = Array.isArray(delete_dates) ? delete_dates : [];
  if (upsertArr.length === 0 && deleteArr.length === 0) {
    return NextResponse.json({ error: "変更がありません" }, { status: 400 });
  }
  if (upsertArr.length > 62 || deleteArr.length > 62) {
    return NextResponse.json({ error: "件数が多すぎます" }, { status: 400 });
  }

  // クライアント入力は一切信用せず、許可 field だけ拾って identity は token 由来で固定する
  const rows: Record<string, unknown>[] = [];
  for (const raw of upsertArr) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const workDate = typeof r.work_date === "string" ? r.work_date : "";
    if (!DATE_RE.test(workDate)) {
      return NextResponse.json({ error: `日付が不正です: ${String(r.work_date)}` }, { status: 400 });
    }
    const time = (v: unknown): string | null =>
      typeof v === "string" && TIME_RE.test(v) ? v : null;
    const breakMin = Number(r.break_minutes);
    const km = r.business_km === null || r.business_km === undefined || r.business_km === ""
      ? null
      : Number(r.business_km);
    if (km !== null && !Number.isFinite(km)) {
      return NextResponse.json({ error: `出張距離が不正です (${workDate})` }, { status: 400 });
    }
    const paidLeave =
      r.paid_leave_type === "full" || r.paid_leave_type === "half" ? r.paid_leave_type : null;
    rows.push({
      tenant_id: TENANT_ID,
      office_id: ctx.office_id,
      employee_id: ctx.id,
      work_date: workDate,
      start_time: time(r.start_time),
      end_time: time(r.end_time),
      break_minutes: Number.isFinite(breakMin) ? Math.max(0, Math.floor(breakMin)) : 0,
      is_legal_holiday: r.is_legal_holiday === true,
      is_paid_leave: paidLeave !== null,
      paid_leave_type: paidLeave,
      note: typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 500) : null,
      business_km: km,
      substitute_for_date:
        typeof r.substitute_for_date === "string" && DATE_RE.test(r.substitute_for_date)
          ? r.substitute_for_date
          : null,
    });
  }
  const delDates: string[] = [];
  for (const d of deleteArr) {
    if (typeof d !== "string" || !DATE_RE.test(d)) {
      return NextResponse.json({ error: `削除日付が不正です: ${String(d)}` }, { status: 400 });
    }
    delDates.push(d);
  }

  const admin = createAdminClient();
  if (rows.length > 0) {
    const { error } = await admin
      .from("payroll_kyotaku_attendance_records")
      .upsert(rows, { onConflict: "employee_id,work_date" });
    if (error) {
      console.error("attendance-self upsert failed:", error.message);
      return NextResponse.json({ error: `保存に失敗: ${error.message}` }, { status: 500 });
    }
  }
  if (delDates.length > 0) {
    // 削除も token の employee_id で必ず絞る
    const { error } = await admin
      .from("payroll_kyotaku_attendance_records")
      .delete()
      .eq("employee_id", ctx.id)
      .in("work_date", delDates);
    if (error) {
      console.error("attendance-self delete failed:", error.message);
      return NextResponse.json({ error: `削除に失敗: ${error.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, upserted: rows.length, deleted: delDates.length });
}
