/**
 * 出勤簿の計算が 3 app で食い違っていないかを実データで測る (READ ONLY)
 *
 *   npx tsx scripts/attendance-calc-parity.mts
 *
 * ⚠ **3 app は同じ table (`payroll_kyotaku_attendance_records`) を
 *   違う解釈で読んでいる。**同じ職員・同じ月を開く画面によって金額が変わる。
 *
 *   order-app    lib/attendance/attendance-calc.ts          ← ★ 正 (user 確定済み)
 *   kaigo-app    src/lib/attendance/attendance-calc.ts
 *   payroll-app  src/lib/payroll/attendance-calc.ts
 *
 * このハーネスは **3 つの実装をそのまま import して同じ入力を流す**。
 * 逐語コピーは乖離源なので書かない。
 *
 * 見るのは 2 つ:
 *   ⓪ 3 file が同一か   ← ★ 実データで発動しなくてもズレに気づける
 *   ① 同じ入力を流して **分数** が一致するか (これが本体)
 * 金額は桁を示す参考値 (下の money() の注記)。
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

import * as ORDER from "../lib/attendance/attendance-calc";
import * as KAIGO from "../../kaigo-app/src/lib/attendance/attendance-calc";
import * as PAYROLL from "../../payroll-app/src/lib/payroll/attendance-calc";

type Rec = ORDER.AttendanceRecord & { employee_id: string; office_id: string };

// ── ⓪ file そのものが同一か (実データで発動しなくてもズレに気づけるように) ────
const SRC = [
  "lib/attendance/attendance-calc.ts",
  "../kaigo-app/src/lib/attendance/attendance-calc.ts",
  "../payroll-app/src/lib/payroll/attendance-calc.ts",
];
const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const base = norm(SRC[0]);
const SRC_IDENTICAL = SRC.every((p) => norm(p) === base);
console.log("══ ⓪ 3 file が同一か (order-app が正本) ══");
for (const p of SRC) console.log(`  ${norm(p) === base ? "✅ 一致" : "❌ 相違"}  ${p}`);
if (!SRC_IDENTICAL) console.log("  ⚠ **相違あり。order-app を正本として揃えること。**");

// ── env ────────────────────────────────────────────────────────────────
const env: Record<string, string> = {};
for (const p of ["../kaigo-app/.env.local", ".env.local"]) {
  let t = "";
  try { t = readFileSync(p, "utf8"); } catch { continue; }
  for (const l of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
if (!env.SUPABASE_SERVICE_ROLE_KEY) {
  console.log("⚠ SUPABASE_SERVICE_ROLE_KEY が無いのでスキップ (anon だと RLS で 0 行になり誤判定する)");
  process.exit(0);
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── 入力 ───────────────────────────────────────────────────────────────
const { data: rowsRaw, error } = await sb
  .from("payroll_kyotaku_attendance_records")
  .select("employee_id, office_id, work_date, start_time, end_time, break_minutes, is_legal_holiday, is_paid_leave, substitute_for_date, paid_leave_type")
  .order("work_date");
if (error) throw new Error(error.message);

/**
 * ⚠ DB は `"09:00:00"` (time 型) だが `parseTime` は `"HH:mm"` しか受けない。
 *   画面は `toUiTime()` で切ってから渡している。**ここを写さないと全日 0h になり、
 *   全員が欠勤 160h に見える**(最初これで誤った表を出しかけた)。
 */
const toUiTime = (t: unknown): string | null => {
  if (typeof t !== "string" || !t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t.trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};
const rows = (rowsRaw ?? []).map((r) => ({
  ...r,
  start_time: toUiTime(r.start_time),
  end_time: toUiTime(r.end_time),
  break_minutes: r.break_minutes ?? 0,
  is_legal_holiday: !!r.is_legal_holiday,
  // 画面と同じ fallback: paid_leave_type が無ければ is_paid_leave から "full"
  paid_leave_type: (r.paid_leave_type === "full" || r.paid_leave_type === "half")
    ? r.paid_leave_type
    : (r.is_paid_leave ? "full" : null),
  substitute_for_date: r.substitute_for_date ?? null,
}));

// ⚠ PostgREST の既定 1000 行上限。employees は 1000 名超なので **必ずページングする**
//   (id で引かないと「(不明)」になり、給与も引けず金額が 0 に見える)
async function fetchAll<T>(table: string, cols: string, order: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(cols).order(order).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

const empRaw = await fetchAll<Record<string, unknown>>("payroll_employees", "id, name, office_id, role_type, job_type", "id");
const empById = new Map(empRaw.map((e) => [String(e.id), e]));

// 給与設定 (effective_from の最新)
const salRaw = await fetchAll<Record<string, number | string>>("payroll_salary_settings", "*", "effective_from");
const salByEmp = new Map<string, Record<string, number>>();
for (const s of salRaw) salByEmp.set(String(s.employee_id), s as never); // 後勝ち = 最新


const { data: offRaw, error: e3 } = await sb.from("payroll_offices").select("office_id, work_week_start");
if (e3) throw new Error(e3.message);
const weekStartByOffice = new Map((offRaw ?? []).map((o) => [o.office_id, o.work_week_start ?? 0]));

const { data: hRaw, error: e4 } = await sb.from("payroll_company_holidays").select("holiday_date");
if (e4) throw new Error(e4.message);
const companyHolidays = new Set((hRaw ?? []).map((h) => String(h.holiday_date)));

console.log("══ 分母 ══");
console.log(`  出勤簿 ${rows.length} 行 / 職員 ${new Set(rows.map((r) => r.employee_id)).size} 名 / 会社休日 ${companyHolidays.size} 日`);
const byMonth: Record<string, number> = {};
for (const r of rows) byMonth[r.work_date.slice(0, 7)] = (byMonth[r.work_date.slice(0, 7)] ?? 0) + 1;
console.log(`  月別 ${JSON.stringify(byMonth)}`);
console.log(`  substitute_for_date あり ${rows.filter((r) => r.substitute_for_date).length} 行`);
console.log(`  is_legal_holiday=true (manual) ${rows.filter((r) => r.is_legal_holiday).length} 行`);

// ── (employee, month) ごとに 3 実装を流す ──────────────────────────────
// ⚠ 画面は **月跨ぎ週まで含めた extended 範囲**を渡して monthFilter で当月だけ積む。
//   月で切って渡すと週が 7 日揃わず、法定休日 auto-detect が発動しなくなる。
const byEmp = new Map<string, Rec[]>();
for (const r of rows) {
  if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
  byEmp.get(r.employee_id)!.push(r as unknown as Rec);
}
const keys = new Map<string, Rec[]>();
for (const [empId, recs] of byEmp) {
  for (const month of new Set(recs.map((r) => r.work_date.slice(0, 7)))) {
    keys.set(`${empId}|${month}`, recs); // 全期間を渡し monthFilter で絞る
  }
}

type Sum = ORDER.MonthlySummary;
const FIELDS: (keyof Sum)[] = [
  "total_work", "total_daily_overtime", "total_weekly_overtime",
  "total_midnight", "total_holiday", "total_absence", "total_paid_leave_days",
];

// ⚠ **出勤簿を持つ 10 名は全員 payroll_salary_settings が 0 行**なので、
//   実データだけでは金額を出せない (そのまま出すと全部 ¥0 = 偽の「差なし」になる)。
//   そこで **設定を持つ職員の実データから中央値の時給**を作り、それを当てて桁を示す。
//   ★ この列は「もし時給がこれなら」の参考値。実支給額ではない。
const refSalaries = salRaw.map((s) =>
  Number(s.base_personal_salary ?? 0) + Number(s.skill_salary ?? 0) +
  Number(s.position_allowance ?? 0) + Number(s.qualification_allowance ?? 0) +
  Number(s.tenure_allowance ?? 0) + Number(s.treatment_improvement ?? 0) +
  Number(s.specific_treatment_improvement ?? 0) + Number(s.treatment_subsidy ?? 0)
).filter((v) => v > 0).sort((a, b) => a - b);
const REF_MONTHLY = refSalaries.length ? refSalaries[Math.floor(refSalaries.length / 2)] : 0;
const REF_HOURLY = REF_MONTHLY / 160;

/**
 * ⚠ 金額は **桁を示すための参考値**。このハーネスの本体は ⓪ と ① (分数の一致)。
 *   payroll の `calcOvertimePayBreakdown` を直接呼びたかったが、あちらが
 *   `@/lib/...` alias を使うため order-app からは型解決できない。
 *   **割増率そのものの検証は payroll-app/scripts/payroll-sample-check.mts (22 項目) 済み**
 *   なので、ここでは労基の法定率をそのまま当てる。
 *     時間外 1.25 / 深夜 +0.25 / 法定休日 1.35
 *   (60h 超 1.50 は差分の桁を見る目的では効かないので使わない)
 *
 * ⚠⚠ **欠勤は残業代と足し引きしない。**
 *   `payroll/page.tsx` の `monthlyGrandTotal` は
 *     fixedTotal + 賞与 + travelFee + commuteFee + 出張費 + 育児 + careOvertime
 *     + yocho + overtimeExcess
 *   で構成され **欠勤の項が 1 つも無い** (実測。`total_absence`/`absenceMin` の参照先は
 *   3 app とも画面表示と労務チェック一覧だけで、金額計算に入る箇所は 0 件)。
 *   → **欠勤が何時間立っても支給額は動かない。**
 *   2026-09-03 に一度「残業代 − 欠勤控除」で出して **¥-124,334 = 支給額が減っていた**
 *   かのような報告をしかけた。実際に動いていたのは残業代ぶんの **+¥876** だけ。
 *   欠勤は別の列に分けて出し、**足さない**こと。
 */
function money(s: Sum, empId: string): { ot: number; absence: number; hourly: number; real: boolean } {
  const sal = salByEmp.get(empId);
  const monthly = sal
    ? Number(sal.base_personal_salary ?? 0) + Number(sal.skill_salary ?? 0) +
      Number(sal.position_allowance ?? 0) + Number(sal.qualification_allowance ?? 0) +
      Number(sal.tenure_allowance ?? 0) + Number(sal.treatment_improvement ?? 0) +
      Number(sal.specific_treatment_improvement ?? 0) + Number(sal.treatment_subsidy ?? 0)
    : REF_MONTHLY;
  const hourly = monthly / 160;
  const h = (m: number) => (m / 60) * hourly;
  return {
    ot: Math.round(h(s.total_daily_overtime + s.total_weekly_overtime) * 1.25 + h(s.total_midnight) * 0.25 + h(s.total_holiday) * 1.35),
    absence: Math.round(h(s.total_absence) * 1.0),
    hourly,
    real: !!sal,
  };
}

const diffs: {
  key: string; name: string; month: string; hourly: number;
  o: Sum; k: Sum; p: Sum;
  kDiff: string[]; pDiff: string[];
  kYen: number; pYen: number;
  kAbs: number; pAbs: number;
}[] = [];

const causeDays = { kaigo: {} as Record<string, number>, payroll: {} as Record<string, number> };

let nSame = 0;
for (const [k, recs] of keys) {
  const [empId, month] = k.split("|");
  const emp = empById.get(empId);
  const weekStart = weekStartByOffice.get(recs[0].office_id as unknown as string) ?? 0;
  const o = ORDER.calcMonthlySummary(recs, weekStart, month, companyHolidays);
  const kk = KAIGO.calcMonthlySummary(recs as never, weekStart, month, companyHolidays);
  const pp = PAYROLL.calcMonthlySummary(recs as never, weekStart, month, companyHolidays);

  const kDiff = FIELDS.filter((f) => o[f] !== kk[f]).map((f) => `${f} ${o[f]}→${kk[f]}`);
  const pDiff = FIELDS.filter((f) => o[f] !== pp[f]).map((f) => `${f} ${o[f]}→${pp[f]}`);
  if (kDiff.length === 0 && pDiff.length === 0) { nSame++; continue; }

  const mo = money(o, empId), mk = money(kk, empId), mp = money(pp, empId);

  // ── 差の原因を **日単位で** 特定する (3 つのどれで動いたのか) ──
  const dO = ORDER.calcDailyListWithWeekly(recs, weekStart, companyHolidays);
  const dK = KAIGO.calcDailyListWithWeekly(recs as never, weekStart, companyHolidays);
  const dP = PAYROLL.calcDailyListWithWeekly(recs as never, weekStart, companyHolidays);
  for (let i = 0; i < recs.length; i++) {
    if (!recs[i].work_date.startsWith(month)) continue;
    const r = recs[i];
    const cause =
      r.substitute_for_date ? "A 代休/振替の向き"
        : (!r.start_time && !r.end_time && !r.paid_leave_type) ? "B 未入力を欠勤にするか"
          : "C 法定休日の判定日 (日曜 vs 週最終日)";
    if (dO[i].absence_minutes !== dK[i].absence_minutes || dO[i].holiday_work !== dK[i].holiday_work
      || dO[i].daily_overtime !== dK[i].daily_overtime || dO[i].weekly_overtime !== dK[i].weekly_overtime) {
      causeDays.kaigo[cause] = (causeDays.kaigo[cause] ?? 0) + 1;
    }
    if (dO[i].absence_minutes !== dP[i].absence_minutes || dO[i].holiday_work !== dP[i].holiday_work
      || dO[i].daily_overtime !== dP[i].daily_overtime || dO[i].weekly_overtime !== dP[i].weekly_overtime) {
      causeDays.payroll[cause] = (causeDays.payroll[cause] ?? 0) + 1;
    }
  }

  diffs.push({
    key: k, name: String(emp?.name ?? "(不明)"), month, hourly: mo.hourly,
    o, k: kk, p: pp, kDiff, pDiff,
    // ★ 支給額が動くのは残業代だけ。欠勤は足さず別列で出す (上の注記)
    kYen: mk.ot - mo.ot, pYen: mp.ot - mo.ot,
    kAbs: mk.absence - mo.absence, pAbs: mp.absence - mo.absence,
  });
}

console.log(`\n══ ① 3 実装に同じ入力を流した結果 ══`);
console.log(`  【分母】(職員 × 月) ${keys.size} 組`);
console.log(`  完全一致              ${nSame} 組`);
console.log(`  ★ 食い違う            ${diffs.length} 組`);

if (diffs.length === 0) {
  if (SRC_IDENTICAL) {
    console.log("\n  ✅ 3 file が同一 (= 構造的に食い違わない)。");
  } else {
    console.log("\n  ⚠ **差 0 だが 3 file は同一ではない。**");
    console.log("    実装差が今のデータで発動していないだけ。データが増えると出る。");
    console.log("    (差が出る条件 = 7日連続勤務の週 / substitute_for_date / 未入力日)");
  }
}

const fmt = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
for (const d of diffs.sort((a, b) => Math.abs(b.kYen) + Math.abs(b.pYen) - Math.abs(a.kYen) - Math.abs(a.pYen))) {
  console.log(`\n  ── ${d.name} ${d.month} (時給 ¥${Math.round(d.hourly)})`);
  console.log(`     order (正) 実労${fmt(d.o.total_work)} 日残${fmt(d.o.total_daily_overtime)} 週残${fmt(d.o.total_weekly_overtime)} 法休${fmt(d.o.total_holiday)} 欠勤${fmt(d.o.total_absence)}`);
  const yen = (ot: number, abs: number) =>
    `→ 残業代 ${ot >= 0 ? "+" : ""}¥${ot} / 欠勤 ${abs >= 0 ? "+" : ""}¥${abs} (支給には効かない)`;
  if (d.kDiff.length) console.log(`     kaigo   ${d.kDiff.join(" / ")}   ${yen(d.kYen, d.kAbs)}`);
  if (d.pDiff.length) console.log(`     payroll ${d.pDiff.join(" / ")}   ${yen(d.pYen, d.pAbs)}`);
}

const sum = (f: (d: typeof diffs[number]) => number) => diffs.reduce((s, d) => s + f(d), 0);
const yenStr = (v: number) => `${v >= 0 ? "+" : ""}¥${v.toLocaleString()}`;
console.log(`\n══ ② 金額差 (order を正としたときの、他 app 画面が出す額のズレ) ══`);
console.log(`  ⚠ 出勤簿を持つ 10 名は **payroll_salary_settings が 0 行**。実支給額は出せない。`);
console.log(`     設定を持つ職員の中央値 (月 ¥${REF_MONTHLY.toLocaleString()} / 160h = 時給 ¥${Math.round(REF_HOURLY)}) を当てた **参考値**。`);
console.log(`                ★ 残業代 (支給に効く)      欠勤 (支給に効かない)`);
console.log(`  kaigo-app     ${yenStr(sum((d) => d.kYen)).padEnd(24)} ${yenStr(sum((d) => d.kAbs))}   (${diffs.filter((d) => d.kDiff.length).length} 組)`);
console.log(`  payroll-app   ${yenStr(sum((d) => d.pYen)).padEnd(24)} ${yenStr(sum((d) => d.pAbs))}   (${diffs.filter((d) => d.pDiff.length).length} 組)`);
console.log(`  ⚠ **2 列を足さないこと。**欠勤は monthlyGrandTotal に入っていない (上の注記)。`);

// ── ③ 実装差が「発動しうる」条件が実データにどれだけあるか ─────────────
console.log(`\n══ ②-2 その差は 3 つのどれで出たのか (日単位で分類) ══`);
for (const app of ["kaigo", "payroll"] as const) {
  const t = causeDays[app];
  const tot = Object.values(t).reduce((a, b) => a + b, 0);
  console.log(`  ${app.padEnd(8)} 計 ${tot} 日`);
  for (const c of Object.keys(t).sort()) console.log(`    ${c.padEnd(36)} ${t[c]} 日`);
}

console.log(`\n══ ③ 差が出る条件が実データにいくつあるか (発動していなくても数える) ══`);
let weeks7 = 0, weeks7NoRest = 0, weeks7SunRest = 0;
for (const [, recs] of keys) {
  const weekStart = weekStartByOffice.get(recs[0].office_id as unknown as string) ?? 0;
  const g = new Map<string, Rec[]>();
  for (const r of recs) {
    const wk = ORDER.weekKeyOf(r.work_date, weekStart);
    if (!wk) continue;
    if (!g.has(wk)) g.set(wk, []);
    g.get(wk)!.push(r);
  }
  for (const list of g.values()) {
    if (list.length !== 7) continue;
    weeks7++;
    const dl = list.map((r) => ORDER.calcDaily(r));
    if (dl.every((d) => d.work_minutes > 0)) {
      weeks7NoRest++;
      const sunIsLast = list
        .slice()
        .sort((a, b) => a.work_date.localeCompare(b.work_date));
      const sunday = sunIsLast.find((r) => new Date(`${r.work_date}T00:00:00Z`).getUTCDay() === 0);
      if (sunday && sunday.work_date !== sunIsLast[sunIsLast.length - 1].work_date) weeks7SunRest++;
    }
  }
}
console.log(`  7 日揃った週                       ${weeks7}`);
console.log(`  └ うち全日出勤 (= 法休 auto 発動)  ${weeks7NoRest}`);
console.log(`    └ ★ 日曜 ≠ 週最終日 (= 判定日がズレる) ${weeks7SunRest}`);
const subRows = rows.filter((r) => r.substitute_for_date);
console.log(`  substitute_for_date (代休) あり     ${subRows.length} 行`);
const unfilled = rows.filter((r) => !r.start_time && !r.end_time && !r.paid_leave_type && !r.substitute_for_date);
console.log(`  完全未入力の日                      ${unfilled.length} 行`);
console.log(`  ⚠ この 3 つが実装差の発動条件。file が揃っていれば差は出ない。`);
