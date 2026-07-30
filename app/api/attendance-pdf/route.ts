import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  calcDailyListWithWeekly,
  calcMonthlySummary,
  extendedMonthRange,
  type AttendanceRecord,
} from "@/lib/attendance/attendance-calc";
import { isJapaneseHoliday } from "@/lib/attendance/japan-holidays";
import { calcDailyAllowance, summarizeAllowance, DEFAULT_PHONE_DUTY_PAY } from "@/lib/attendance/allowance";
import { buildAttendancePdf, loadJapaneseFont, type PdfRow } from "@/lib/attendance/pdf";

// 出勤簿 PDF の生成 (管理者用)。
// GET ?employee_id=<uuid>&month=YYYY-MM → application/pdf
//
// 画面の印刷レイアウトと同じ内容をサーバー側で組み立てて返す。
// 呼出側はこれを File System Access API で指定フォルダに直接保存する。

const TENANT_ID = "kt-group";
const MONTH_RE = /^\d{4}-\d{2}$/;
const LEGAL_HOLIDAY_DOW = 0; // 日曜

export async function GET(req: Request) {
  const supabase = await createClient();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const employeeId = url.searchParams.get("employee_id") ?? "";
  const month = url.searchParams.get("month") ?? "";
  if (!employeeId || !MONTH_RE.test(month)) {
    return NextResponse.json({ error: "employee_id / month が不正です" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 職員 + 事業所
  const { data: emp, error: empErr } = await admin
    .from("payroll_employees")
    .select("*")
    .eq("id", employeeId)
    .maybeSingle();
  if (empErr) {
    console.error("attendance-pdf employee fetch failed:", empErr.message);
    return NextResponse.json({ error: `職員の取得に失敗: ${empErr.message}` }, { status: 500 });
  }
  if (!emp) return NextResponse.json({ error: "職員が見つかりません" }, { status: 404 });

  const { data: po, error: poErr } = await admin
    .from("payroll_offices")
    .select("id, office_id, office_type, work_week_start")
    .eq("id", emp.office_id as string)
    .maybeSingle();
  if (poErr) {
    console.error("attendance-pdf office fetch failed:", poErr.message);
    return NextResponse.json({ error: `事業所の取得に失敗: ${poErr.message}` }, { status: 500 });
  }
  const { data: common } = await admin
    .from("offices")
    .select("name")
    .eq("id", (po?.office_id as string) ?? "")
    .maybeSingle();

  const weekStart = (po?.work_week_start as number | null) ?? 0;
  const isHonbu = po?.office_type === "本社";
  const isOfficeWorker = (emp as { is_office_worker?: boolean }).is_office_worker === true;
  const phoneDutyPay =
    ((emp as { phone_duty_pay?: number | null }).phone_duty_pay as number | null) ??
    DEFAULT_PHONE_DUTY_PAY;

  // 出勤簿 (月跨ぎ週の計算のため拡張範囲で取得)
  const { start, end } = extendedMonthRange(month, weekStart);
  const [recordsRes, holidaysRes] = await Promise.all([
    admin
      .from("payroll_kyotaku_attendance_records")
      .select("*")
      .eq("employee_id", employeeId)
      .gte("work_date", start)
      .lte("work_date", end)
      .order("work_date"),
    admin
      .from("payroll_company_holidays")
      .select("holiday_date")
      .eq("tenant_id", TENANT_ID)
      .gte("holiday_date", start)
      .lte("holiday_date", end),
  ]);
  if (recordsRes.error) {
    console.error("attendance-pdf records fetch failed:", recordsRes.error.message);
    return NextResponse.json({ error: `出勤簿の取得に失敗: ${recordsRes.error.message}` }, { status: 500 });
  }
  const companyHolidays = new Set(
    (holidaysRes.data ?? []).map((r: { holiday_date: string }) => r.holiday_date),
  );

  // 月の全日を並べる
  const [yy, mm] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const byDate = new Map(
    (recordsRes.data ?? []).map((r) => [r.work_date as string, r as Record<string, unknown>]),
  );
  const toUi = (s: unknown) =>
    typeof s === "string" ? s.slice(0, 5) : "";

  const rows: PdfRow[] = [];
  const records: AttendanceRecord[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const dow = new Date(date + "T00:00:00Z").getUTCDay();
    const db = byDate.get(date);
    const start_time = toUi(db?.start_time);
    const end_time = toUi(db?.end_time);
    const paid =
      db?.paid_leave_type === "full" || db?.paid_leave_type === "half"
        ? (db.paid_leave_type as "full" | "half")
        : null;
    const sub = (db?.substitute_for_date as string | null) ?? "";
    const sub2 = (db?.substitute_for_date2 as string | null) ?? "";
    const phone = db?.phone_duty === true;
    const cnt = (db?.holiday_support_count as number | null) ?? 0;
    rows.push({
      work_date: date,
      dow,
      start_time,
      end_time,
      break_minutes: (db?.break_minutes as number | null) ?? 0,
      paid_leave_type: paid,
      business_km: db?.business_km === null || db?.business_km === undefined ? "" : String(db.business_km),
      business_trip_km:
        db?.business_trip_km === null || db?.business_trip_km === undefined
          ? ""
          : String(db.business_trip_km),
      substitute_for_date: sub,
      substitute_for_date2: sub2,
      note: (db?.note as string | null) ?? "",
      phone_duty: phone,
      holiday_support_count: cnt,
      allowance: isHonbu ? calcDailyAllowance(phone, cnt, phoneDutyPay) : 0,
      is_rest: dow === 0 || dow === 6 || isJapaneseHoliday(date) || companyHolidays.has(date),
    });
    records.push({
      work_date: date,
      start_time: start_time || null,
      end_time: end_time || null,
      break_minutes: (db?.break_minutes as number | null) ?? 0,
      is_legal_holiday: dow === LEGAL_HOLIDAY_DOW,
      paid_leave_type: paid,
      substitute_for_date: sub || sub2 || null,
    });
  }
  // 隣接月 (計算のみ)
  const neighbors: AttendanceRecord[] = (recordsRes.data ?? [])
    .filter((r) => !(r.work_date as string).startsWith(month))
    .map((r) => ({
      work_date: r.work_date as string,
      start_time: toUi(r.start_time) || null,
      end_time: toUi(r.end_time) || null,
      break_minutes: (r.break_minutes as number | null) ?? 0,
      is_legal_holiday: !!r.is_legal_holiday,
      paid_leave_type:
        r.paid_leave_type === "full" || r.paid_leave_type === "half"
          ? (r.paid_leave_type as "full" | "half")
          : null,
      substitute_for_date:
        (r.substitute_for_date as string | null) ?? (r.substitute_for_date2 as string | null) ?? null,
    }));

  const all = [...records, ...neighbors];
  const dailies = calcDailyListWithWeekly(all, weekStart, companyHolidays).slice(0, records.length);
  const summary = calcMonthlySummary(all, weekStart, month, companyHolidays);
  const allowance = summarizeAllowance(
    rows.map((r) => ({ phone_duty: r.phone_duty, holiday_support_count: r.holiday_support_count })),
    phoneDutyPay,
  );

  let pdf: Uint8Array;
  try {
    const fontBytes = await loadJapaneseFont(url.origin);
    pdf = await buildAttendancePdf(
      {
        officeName: (common?.name as string) ?? "",
        employeeName: emp.name as string,
        month,
        rows,
        dailies,
        summary,
        overtimeTotal: summary.total_daily_overtime + summary.total_weekly_overtime,
        kmTotal: rows.reduce((a, r) => a + (parseFloat(r.business_km) || 0), 0),
        tripKmTotal: rows.reduce((a, r) => a + (parseFloat(r.business_trip_km) || 0), 0),
        workDays: dailies.filter((d) => d.work_minutes > 0).length,
        isHonbu,
        isOfficeWorker,
        phoneDutyPay,
        allowanceTotal: isHonbu ? allowance.totalPay : 0,
        phoneDutyDays: allowance.phoneDutyDays,
        holidaySupportTotal: allowance.holidaySupportTotal,
      },
      fontBytes,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("attendance-pdf build failed:", msg);
    return NextResponse.json({ error: `PDF の生成に失敗: ${msg}` }, { status: 500 });
  }

  const safeName = (emp.name as string).replace(/[\\/:*?"<>|]/g, "_");
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`出勤簿_${safeName}_${month}.pdf`)}`,
      "Cache-Control": "no-store",
    },
  });
}
