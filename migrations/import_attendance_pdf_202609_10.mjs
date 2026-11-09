/**
 * ケアサポ (介護ショップケア・サポート千葉) の 2026-09 / 2026-10 出勤簿 (スキャン PDF を目視で転記した JSON) を
 * 出勤簿 payroll_kyotaku_attendance_records に入れる
 *
 *   node migrations/import_attendance_pdf_202609_10.mjs                       # DRY RUN
 *   node migrations/import_attendance_pdf_202609_10.mjs --execute             # 本番 (★ user 確認後)
 *   node migrations/import_attendance_pdf_202609_10.mjs --revert <batch_id>   # 取り消し DRY RUN
 *   node migrations/import_attendance_pdf_202609_10.mjs --revert <batch_id> --execute
 *
 *   --json <path>   読み取り結果 (attendance_2026-09_10.json)。既定 = 下の DEFAULT_JSON
 *   --out <path>    DRY RUN の詳細 JSON の出力先。既定 = OS の一時フォルダ/attendance_pdf_202609_10_plan.json
 *
 * ── 変換は Excel 反映 (AttendanceExcelImportModal) と同じ ──────────────────
 *   lib/attendance/excelImport.ts の dayToPayload / diffPayload / normName を import して使う (逐語コピーしない)。
 *   ここで書くのは JSON の 1 日 → ExcelDay の adapter だけ:
 *     ・入力のある日 = 休暇理由 か 出社/退社 のある日 (parseSheet と同じ)。JSON に無い日・空欄の日は触らない
 *     ・走行距離 (km) の人は col7IsKm=true。交通費 (transport_yen) の人は false = business_km に入れない
 *     ・「PM有休」「AM有休」は 半日の有休なので reason を「半休 (PM有休)」にして渡す
 *       (dayToPayload は「有休」を含むと full にするため。備考には原文が残る)
 *   保存の形: onConflict employee_id,work_date / office_id = payroll_offices.id / tenant_id = kt-group (既存行・会社休日と同じ)
 *   備考の出どころ: dayToPayload の「Excel反映 日付」を「PDF反映 R8・9月出勤簿」等に差し替える
 *   (差分は既存の備考から PDF反映 / Excel反映 の印を除いて比べる = 何度流しても同じ)
 *
 * ── 残業は新ソフトの計算が正 ───────────────────────────────────────────────
 *   calcMonthlySummary (lib/attendance/attendance-calc) + overtimeConsumption (lib/attendance/overtime-limit)。
 *   既存行 (月跨ぎ週の週頭〜週末) に今回の行を重ねて計算する (Excel 反映のプレビューと同じ)。
 *   書類の残業 (footer.overtime_total) と日別合計を並べて出す。
 *
 * ── 書かないもの ──────────────────────────────────────────────────────────
 *   承認済みの月 (attendance_month_status.status=approved) / 突合できない職員 (作らない) / 氏名が複数一致する職員
 *
 * ── 書込みの作法 (--execute) ─────────────────────────────────────────────
 *   出どころ記録 data_import_batches / data_import_rows (migrations/data_import_provenance.sql) が無ければ拒否。
 *   DB を読み直して計画を作り直す。最初に batch を作り、職員×月ごとに upsert → 直後に data_import_rows
 *   (insert / update と before) を書く。書けなければ batch を failed にして止める。
 *   変更前の行は migrations/_backup_attendance_pdf_202609_10_<時刻>.json にも保存。
 *   --revert は「現在値 = 書いた値」の行だけ戻す (insert → 削除 / update → before に戻す)。後から人が触った行は戻さない。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
// lib の .ts を読むため tsx の下で自分自身を起動し直す (sync_fukuyogu_from_honobono.mjs と同じ)
if (!process.env.ATT_PDF_IMPORT_UNDER_TSX) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  const r = spawnSync(process.execPath, [tsxCli, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ATT_PDF_IMPORT_UNDER_TSX: "1" },
  });
  process.exit(r.status ?? 1);
}

// ── 定数 ──────────────────────────────────────────────────────────────────
const TENANT = "kt-group";
const PAYROLL_OFFICE_ID = "31614965-3b87-4c3b-901c-6e408cd89b96"; // ケアサポ payroll_offices.id
const TABLE = "payroll_kyotaku_attendance_records";
const SOURCE_SYSTEM = "pdf-attendance-caresupport";
const SCRIPT_REL = "apps/order-app/migrations/import_attendance_pdf_202609_10.mjs";
const MONTHS = ["2026-09", "2026-10"];
const DEFAULT_JSON =
  "C:/Users/domen-PC/AppData/Local/Temp/claude/86e0579a1baf6b3b/125aee8c-5732-4f4c-913b-d7baace40828/scratchpad/att/pdf/attendance_2026-09_10.json";
/** 備考の出どころ (月ごと) */
const sourceMark = (ym) => `PDF反映 R8・${Number(ym.slice(5, 7))}月出勤簿`;
const PDF_MARK_RE = /\s*(?:\/\s*)?PDF反映 R\d+・\d+月出勤簿\s*$/;
/** 異体字 (normName で一致しないときだけ使う。一致の仕方は一覧に出す) */
const ITAIJI = { 藏: "蔵", 髙: "高", 﨑: "崎", 邊: "辺", 邉: "辺", 齋: "斎", 齊: "斎", 濵: "浜", 德: "徳", 惠: "恵", 眞: "真", 澤: "沢", 櫻: "桜", 廣: "広" };

// ── 引数 ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const EXECUTE = argv.includes("--execute");
const REVERT = opt("--revert");
const JSON_PATH = resolve(opt("--json") ?? DEFAULT_JSON);
const OUT_PATH = resolve(opt("--out") ?? join(tmpdir(), "attendance_pdf_202609_10_plan.json"));

// ── lib (本物を import) ───────────────────────────────────────────────────
const { dayToPayload, diffPayload, normName } = await import("../lib/attendance/excelImport");
const { calcMonthlySummary, extendedMonthRange, formatHM } = await import("../lib/attendance/attendance-calc");
const { overtimeConsumption, MONTHLY_OVERTIME_LIMIT_MIN } = await import("../lib/attendance/overtime-limit");

function readEnv() {
  const env = {};
  for (const p of [join(HERE, "../../kaigo-app/.env.local"), join(HERE, "../.env.local")]) {
    let txt = "";
    try {
      txt = readFileSync(p, "utf8");
    } catch {
      continue; // 無いファイルは飛ばす (どちらかにあればよい。無ければ下で止める)
    }
    for (const l of txt.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}
const ENV = readEnv();
if (!ENV.NEXT_PUBLIC_SUPABASE_URL || !ENV.SUPABASE_SERVICE_ROLE_KEY) {
  console.error("kaigo-app/.env.local に NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が無い");
  process.exit(1);
}
// toRecord は lib/attendance.ts にあり、読み込み時に browser client (lib/supabase) を作るので env を先に入れておく (通信はしない)
process.env.NEXT_PUBLIC_SUPABASE_URL ??= ENV.NEXT_PUBLIC_SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "unused";
const { toRecord } = await import("../lib/attendance");
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(ENV.NEXT_PUBLIC_SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ── 小道具 ────────────────────────────────────────────────────────────────
const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const h = (min) => formatHM(Math.round(min));
const pad = (s, n) => {
  const str = String(s);
  const w = [...str].reduce((a, c) => a + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return str + " ".repeat(Math.max(0, n - w));
};
const lpad = (s, n) => " ".repeat(Math.max(0, n - String(s).length)) + String(s);
const foldItaiji = (s) => [...s].map((c) => ITAIJI[c] ?? c).join("");
const stripMarks = (note) => (note ?? "").replace(PDF_MARK_RE, "").trim();

async function selectAll(table, select, build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(sb.from(table).select(select)).order("id").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
async function selectIn(table, select, col, ids, extra = (q) => q) {
  const out = [];
  for (const c of chunks([...new Set(ids)], 150)) out.push(...(await selectAll(table, select, (q) => extra(q.in(col, c)))));
  return out;
}
/** 出どころ記録の表があるか (SELECT 1 件で見る) */
async function provenanceReady() {
  for (const t of ["data_import_batches", "data_import_rows"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (error) return { ok: false, why: `${t}: ${error.message}` };
  }
  return { ok: true };
}

// ── JSON の 1 日 → ExcelDay (adapter) ────────────────────────────────────
function toExcelDay(d) {
  let reason = (d.leave_reason ?? "").trim();
  // 「PM有休」「AM有休」= 半日の有休。dayToPayload は「有休」を含むと full にするので 半休 として渡す
  if (/^(AM|PM|午前|午後)\s*有[休給]$/.test(reason)) reason = `半休 (${reason})`;
  const col7 = d.transport_yen ?? d.km ?? null;
  return {
    work_date: d.date,
    reason,
    start: d.start ?? null,
    end: d.end ?? null,
    endShifted12h: false,
    excelWorkHours: d.work_hours ?? null,
    excelOvertimeHours: d.overtime_hours ?? null,
    col7: typeof col7 === "number" ? col7 : null,
  };
}

// ── 計画 ──────────────────────────────────────────────────────────────────
async function buildPlan() {
  const src = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const sheets = src.employees.filter((e) => MONTHS.includes(e.month));

  const { data: offRows, error: offErr } = await sb.from("payroll_offices").select("id, work_week_start").eq("id", PAYROLL_OFFICE_ID);
  if (offErr) throw new Error(`payroll_offices: ${offErr.message}`);
  if (!offRows?.length) throw new Error(`payroll_offices ${PAYROLL_OFFICE_ID} が無い`);
  const weekStart = offRows[0].work_week_start ?? 0;

  const emps = await selectAll("payroll_employees", "id, name, employment_status", (q) => q.eq("office_id", PAYROLL_OFFICE_ID));
  const byKey = new Map();
  const byFold = new Map();
  for (const e of emps) {
    const k = normName(e.name);
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
    const f = foldItaiji(k);
    byFold.set(f, [...(byFold.get(f) ?? []), e]);
  }
  const matchEmp = (name) => {
    const k = normName(name);
    const hit = byKey.get(k) ?? [];
    if (hit.length === 1) return { kind: "existing", emp: hit[0], how: "氏名一致" };
    if (hit.length > 1) return { kind: "ambiguous", names: hit.map((x) => x.name) };
    const fh = byFold.get(foldItaiji(k)) ?? [];
    if (fh.length === 1) return { kind: "existing", emp: fh[0], how: `異体字で一致 (${name} → ${fh[0].name})` };
    if (fh.length > 1) return { kind: "ambiguous", names: fh.map((x) => x.name) };
    return { kind: "none" };
  };

  // 範囲: 対象月の月跨ぎ週ぶん
  const exts = MONTHS.map((m) => extendedMonthRange(m, weekStart));
  const rangeStart = exts.map((e) => e.start).sort()[0];
  const rangeEnd = exts.map((e) => e.end).sort().reverse()[0];
  const matched = sheets.map((s) => ({ s, m: matchEmp(s.name) }));
  const empIds = [...new Set(matched.filter((x) => x.m.kind === "existing").map((x) => x.m.emp.id))];
  const existing = empIds.length
    ? await selectIn(TABLE, "*", "employee_id", empIds, (q) => q.gte("work_date", rangeStart).lte("work_date", rangeEnd))
    : [];
  const { data: hol, error: holErr } = await sb
    .from("payroll_company_holidays")
    .select("holiday_date")
    .eq("tenant_id", TENANT)
    .gte("holiday_date", rangeStart)
    .lte("holiday_date", rangeEnd)
    .order("holiday_date");
  if (holErr) throw new Error(`payroll_company_holidays: ${holErr.message}`);
  const holidays = new Set((hol ?? []).map((r) => r.holiday_date));
  const statuses = new Map();
  if (empIds.length) {
    const st = await selectIn("attendance_month_status", "id, employee_id, month_start, status", "employee_id", empIds, (q) =>
      q.in("month_start", MONTHS.map((m) => `${m}-01`)),
    );
    for (const r of st) statuses.set(`${r.employee_id}|${r.month_start.slice(0, 7)}`, r.status);
  }
  const rowsByEmp = new Map();
  for (const r of existing) rowsByEmp.set(r.employee_id, [...(rowsByEmp.get(r.employee_id) ?? []), r]);

  const plans = [];
  for (const { s, m } of matched) {
    const isKm = !s.days.some((d) => d.transport_yen != null);
    const empId = m.kind === "existing" ? m.emp.id : null;
    const status = empId ? statuses.get(`${empId}|${s.month}`) : undefined;
    let blocked = null;
    if (m.kind === "none") blocked = "職員が見つからない (作らない)";
    else if (m.kind === "ambiguous") blocked = `同じ氏名が複数 (${m.names.join(" / ")})`;
    else if (status === "approved") blocked = "この月は承認済みのため上書きしません";

    const exByDate = new Map((empId ? (rowsByEmp.get(empId) ?? []) : []).map((r) => [r.work_date, r]));
    const inputDays = s.days.filter((d) => d.date.startsWith(s.month) && (d.leave_reason || d.start || d.end));
    const dropped = s.days
      .filter((d) => d.date.startsWith(s.month) && !d.start && (d.km || d.transport_yen))
      .map((d) => `${d.date} ${d.leave_reason ?? "(空欄)"} に ${isKm ? `km=${d.km}` : `交通費=${d.transport_yen}`} → 出勤時刻が無いので入れない`);
    const entries = inputDays.map((d) => {
      const ex = exByDate.get(d.date) ?? null;
      const day = toExcelDay(d);
      const base = dayToPayload(day, { col7IsKm: isKm, importedOn: "0000-00-00", existing: ex });
      const diff = diffPayload(base, ex ? { ...ex, note: stripMarks(ex.note) } : null);
      const core = base.note.replace(/\s*(?:\/\s*)?Excel反映 0000-00-00\s*$/, "").trim();
      const payload = { ...base, note: core ? `${core} / ${sourceMark(s.month)}` : sourceMark(s.month) };
      return { ...diff, payload, existing: ex, src: d };
    });

    plans.push({
      sheet: s,
      name: s.name,
      ym: s.month,
      match: m,
      empId,
      isKm,
      blocked,
      submitted: status === "submitted",
      entries,
      dropped,
      app: null, // 下で同じ職員の両月を重ねてから計算する
    });
  }

  // 新ソフトの残業: 同じ職員の 9月・10月 両方の行を重ねて (月跨ぎ週のため) 月ごとに計算
  const byEmpPlans = new Map();
  for (const p of plans) if (p.empId) byEmpPlans.set(p.empId, [...(byEmpPlans.get(p.empId) ?? []), p]);
  for (const [empId, ps] of byEmpPlans) {
    const merged = new Map((rowsByEmp.get(empId) ?? []).map((r) => [r.work_date, r]));
    for (const p of ps) {
      if (p.blocked) continue;
      for (const e of p.entries) merged.set(e.payload.work_date, { ...e.payload, tenant_id: TENANT, office_id: PAYROLL_OFFICE_ID, employee_id: empId });
    }
    const recs = [...merged.values()].sort((a, b) => a.work_date.localeCompare(b.work_date)).map(toRecord);
    for (const p of ps) {
      const summary = calcMonthlySummary(recs, weekStart, p.ym, holidays);
      p.app = { summary, c: overtimeConsumption(summary) };
    }
  }
  return { src, plans, weekStart, holidays, rangeStart, rangeEnd, emps, existingCount: existing.length };
}

// ── 表示 ──────────────────────────────────────────────────────────────────
function printPlan({ plans, weekStart, holidays, rangeStart, rangeEnd, emps, existingCount }) {
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} ケアサポ出勤簿 PDF → ${TABLE}`);
  console.log(`  JSON ${JSON_PATH}`);
  console.log(`  payroll_offices ${PAYROLL_OFFICE_ID} / tenant ${TENANT} / 週の起算 ${weekStart} / 会社休日 ${[...holidays].join(",") || "なし"}`);
  console.log(`  既存行 (対象職員 × ${rangeStart}〜${rangeEnd}) ${existingCount} 行`);

  console.log("\n══ 職員 × 月 ══ (新規/上書き/変更なし は 日数。残業は h:mm)");
  console.log(
    `${pad("職員", 14)}${pad("月", 9)}${pad("職員突合", 10)}${lpad("新規", 5)}${lpad("上書", 5)}${lpad("同じ", 5)}  ${lpad("新:通常残業", 11)}${lpad("新:換算込", 10)}${lpad("書類残業", 9)}${lpad("日別計", 8)}${lpad("差(新-書類)", 12)}  備考`,
  );
  for (const p of plans) {
    const n = (st) => p.entries.filter((e) => e.status === st).length;
    const paper = p.sheet.footer?.overtime_total;
    const daySum = p.sheet.days.reduce((s, d) => s + (typeof d.overtime_hours === "number" ? d.overtime_hours : 0), 0);
    const ot = p.app ? p.app.c.overtime : null;
    const cons = p.app ? p.app.c.consumed : null;
    const diff = ot !== null && typeof paper === "number" ? ot - paper * 60 : null;
    const notes = [];
    if (p.blocked) notes.push(`★書かない: ${p.blocked}`);
    if (p.submitted) notes.push("提出済み (上書きする)");
    if (p.match.kind === "existing" && p.match.how !== "氏名一致") notes.push(p.match.how);
    if (cons !== null && cons > MONTHLY_OVERTIME_LIMIT_MIN) notes.push("★35h超");
    if (p.app && p.app.c.holidayEquiv) notes.push(`法定休日 ${h(p.app.summary.total_holiday)}→換算${h(p.app.c.holidayEquiv)}`);
    if (p.app && p.app.c.midnightEquiv) notes.push(`深夜 ${h(p.app.summary.total_midnight)}`);
    console.log(
      `${pad(p.name, 14)}${pad(p.ym, 9)}${pad(p.match.kind === "existing" ? "○" : "×", 10)}${lpad(n("new"), 5)}${lpad(n("changed"), 5)}${lpad(n("same"), 5)}  ${lpad(ot === null ? "-" : h(ot), 11)}${lpad(cons === null ? "-" : h(cons), 10)}${lpad(typeof paper === "number" ? h(paper * 60) : "-", 9)}${lpad(h(daySum * 60), 8)}${lpad(diff === null ? "-" : (diff >= 0 ? "+" : "-") + h(Math.abs(diff)), 12)}  ${notes.join(" / ")}`,
    );
  }
  const writable = plans.filter((p) => !p.blocked);
  const tot = (st) => writable.reduce((s, p) => s + p.entries.filter((e) => e.status === st).length, 0);
  console.log(`\n書く: 新規 ${tot("new")} 日 / 上書き ${tot("changed")} 日 / 変更なし ${tot("same")} 日 (書かない) — ${writable.length}/${plans.length} 職員×月`);

  const unmatched = plans.filter((p) => p.match.kind !== "existing");
  console.log(`\n══ 突合できない職員 ══ ${unmatched.length ? "" : "なし"}`);
  for (const p of unmatched) console.log(`  ${p.name} ${p.ym}: ${p.blocked}`);
  const itaiji = plans.filter((p) => p.match.kind === "existing" && p.match.how !== "氏名一致");
  if (itaiji.length) {
    console.log("  (異体字で一致したもの — Excel 反映 (normName のみ) では一致しない)");
    for (const p of itaiji) console.log(`    ${p.ym} ${p.match.how}`);
  }
  const jsonNames = new Set(plans.filter((p) => p.empId).map((p) => p.empId));
  const notInJson = emps.filter((e) => !jsonNames.has(e.id) && e.employment_status !== "退職者");
  console.log(`  参考: DB にいて JSON に無い職員 ${notInJson.map((e) => e.name).join(" / ")}`);

  const approved = plans.filter((p) => p.blocked?.includes("承認済み"));
  console.log(`\n══ 承認済みで書かない月 ══ ${approved.length ? approved.map((p) => `${p.name} ${p.ym}`).join(" / ") : "なし"}`);

  const changed = writable.flatMap((p) => p.entries.filter((e) => e.status === "changed").map((e) => ({ p, e })));
  console.log(`\n══ 上書きされる既存行 ══ ${changed.length} 日`);
  for (const { p, e } of changed.slice(0, 15)) {
    console.log(`  ${p.name} ${e.payload.work_date}: ${e.changes.map((c) => `${c.field} 「${c.before}」→「${c.after}」`).join(" / ")}`);
  }
  if (changed.length > 15) console.log(`  … ほか ${changed.length - 15} 日 (詳細は ${OUT_PATH})`);

  console.log("\n══ 入れ方の注意 (書類の値と違う扱いになる日) ══");
  for (const p of plans) {
    for (const x of p.dropped) console.log(`  ${p.name} ${x}`);
    for (const e of p.entries) {
      if (/^(AM|PM|午前|午後)\s*有[休給]$/.test(e.src.leave_reason ?? "")) {
        console.log(`  ${p.name} ${e.src.date} 「${e.src.leave_reason}」→ 半休 (paid_leave_type=half) として入れる`);
      }
      if (e.src.start && e.src.work_hours === 0) {
        console.log(`  ${p.name} ${e.src.date} 書類の勤務時間 0 だが時刻 ${e.src.start}-${e.src.end} があるので時刻どおり入れる (新ソフトは勤務として数える)`);
      }
    }
  }

  console.log("\n══ 書類の食い違い (check.issues の転記。時刻・休暇理由は日ごとの値を正として入れる) ══");
  for (const p of plans) for (const i of p.sheet.check?.issues ?? []) console.log(`  ${p.name} ${p.ym}: ${i}`);

  const over = plans.filter((p) => p.app && p.app.c.consumed > MONTHLY_OVERTIME_LIMIT_MIN);
  console.log(`\n══ 35h 超 (新ソフト計算・換算込み) ══ ${over.length ? over.map((p) => `${p.name} ${p.ym} ${h(p.app.c.consumed)}`).join(" / ") : "なし"}`);
}

function planJson(plans) {
  return plans.map((p) => ({
    name: p.name,
    ym: p.ym,
    match: p.match.kind === "existing" ? { id: p.match.emp.id, name: p.match.emp.name, how: p.match.how } : p.match,
    blocked: p.blocked,
    km: p.isKm,
    app: p.app ? { overtime_min: p.app.c.overtime, consumed_min: p.app.c.consumed, summary: p.app.summary } : null,
    paper_overtime_h: p.sheet.footer?.overtime_total ?? null,
    entries: p.entries.map((e) => ({ status: e.status, changes: e.changes, payload: e.payload, existing_id: e.existing?.id ?? null })),
    dropped: p.dropped,
  }));
}

// ── 書込み ────────────────────────────────────────────────────────────────
async function execute(plan) {
  const ready = await provenanceReady();
  if (!ready.ok) {
    console.error(`★ 出どころ記録の表が無い (${ready.why})。migrations/data_import_provenance.sql を先に適用すること`);
    process.exit(2);
  }
  const targets = plan.plans.filter((p) => !p.blocked && p.entries.some((e) => e.status !== "same"));
  if (!targets.length) {
    console.log("\n書く行が無い");
    return;
  }
  const jsonBuf = readFileSync(JSON_PATH);
  const pdfs = [...new Set(plan.src.employees.map((e) => e.source?.file).filter(Boolean))];
  const { data: batch, error: bErr } = await sb
    .from("data_import_batches")
    .insert({
      tenant_id: TENANT,
      source_system: SOURCE_SYSTEM,
      source_files: [
        { path: basename(JSON_PATH), sha256: createHash("sha256").update(jsonBuf).digest("hex"), rows: plan.src.employees.length, kind: "出勤簿 PDF 目視転記 JSON (2026-09/10)" },
        ...pdfs.map((f) => ({ path: f, kind: "ケアサポ 出勤簿スキャン PDF" })),
      ],
      script: SCRIPT_REL,
      args: argv.join(" "),
      step: "attendance",
      status: "running",
      notes: `ケアサポ 出勤簿 ${MONTHS.join(",")}`,
    })
    .select("id")
    .single();
  if (bErr || !batch) throw new Error(`data_import_batches: ${bErr?.message ?? "id が返らない"}`);
  const BATCH = batch.id;
  console.log(`\nbatch ${BATCH}`);
  const fail = async (msg) => {
    const { error } = await sb.from("data_import_batches").update({ status: "failed", notes: `失敗: ${msg}`.slice(0, 2000) }).eq("id", BATCH);
    if (error) console.error(`batch を failed にできない: ${error.message}`);
    throw new Error(msg);
  };
  const backup = {};
  let written = 0;
  for (const p of targets) {
    const ws = p.entries.filter((e) => e.status !== "same");
    // キー集合は全行で同じ (バッチ insert でキーが違うと DEFAULT が効かず NULL が入るため)
    const rows = ws.map((e) => ({ ...e.payload, tenant_id: TENANT, office_id: PAYROLL_OFFICE_ID, employee_id: p.empId }));
    for (const e of ws) if (e.existing) backup[e.existing.id] = e.existing;
    writeFileSync(join(HERE, `_backup_attendance_pdf_202609_10_${BATCH}.json`), JSON.stringify({ batch: BATCH, before: backup }, null, 2));
    const { data, error } = await sb.from(TABLE).upsert(rows, { onConflict: "employee_id,work_date" }).select("id, work_date");
    if (error) await fail(`${p.name} ${p.ym} upsert: ${error.message}`);
    if ((data ?? []).length !== rows.length) await fail(`${p.name} ${p.ym} upsert の件数 ${data?.length} ≠ ${rows.length}`);
    const idByDate = new Map(data.map((r) => [r.work_date, r.id]));
    const recs = ws.map((e, i) => ({
      batch_id: BATCH,
      tenant_id: TENANT,
      table_name: TABLE,
      row_id: idByDate.get(e.payload.work_date),
      op: e.existing ? "update" : "insert",
      source_key: `${p.name}|${e.payload.work_date}`,
      source_ref: { file: p.sheet.source?.file ?? null, page: p.sheet.source?.page ?? null, day: e.src },
      before: e.existing ?? null,
      after: rows[i],
    }));
    if (recs.some((r) => !r.row_id)) await fail(`${p.name} ${p.ym}: upsert の戻りに無い日がある`);
    const { error: rErr } = await sb.from("data_import_rows").insert(recs);
    if (rErr) await fail(`data_import_rows: ${rErr.message}`);
    written += rows.length;
    console.log(`  ${p.name} ${p.ym}: ${rows.length} 日`);
  }
  const { count, error: cErr } = await sb.from("data_import_rows").select("id", { count: "exact", head: true }).eq("batch_id", BATCH);
  if (cErr) throw new Error(`data_import_rows 件数: ${cErr.message}`);
  if (count !== written) await fail(`data_import_rows ${count} ≠ 書いた ${written}`);
  const { error: e2 } = await sb.from("data_import_batches").update({ status: "executed", executed_at: new Date().toISOString() }).eq("id", BATCH);
  if (e2) throw new Error(`batch を executed にできない: ${e2.message}`);
  // 確認: 書いた行を読み直す
  const empIds = [...new Set(targets.map((p) => p.empId))];
  const after = await selectIn(TABLE, "id, note", "employee_id", empIds, (q) => q.gte("work_date", `${MONTHS[0]}-01`).lte("work_date", `${MONTHS[MONTHS.length - 1]}-31`));
  const marked = after.filter((r) => PDF_MARK_RE.test(r.note ?? "")).length;
  console.log(`\n完了。書いた ${written} 行 / data_import_rows ${count} 行 / 読み直し: PDF反映の印がある行 ${marked} 行`);
  console.log(`取り消しは node migrations/import_attendance_pdf_202609_10.mjs --revert ${BATCH}`);
}

async function revert(batchId) {
  const ready = await provenanceReady();
  if (!ready.ok) {
    console.error(`出どころ記録の表が無い (${ready.why})`);
    process.exit(2);
  }
  const { data: batch, error } = await sb.from("data_import_batches").select("*").eq("id", batchId).maybeSingle();
  if (error) throw new Error(`data_import_batches: ${error.message}`);
  if (!batch) {
    console.error(`batch ${batchId} が無い`);
    process.exit(1);
  }
  if (batch.source_system !== SOURCE_SYSTEM) {
    console.error(`batch ${batchId} はこの script のものではない (${batch.source_system})`);
    process.exit(1);
  }
  console.log(`${EXECUTE ? "★★ EXECUTE" : "DRY RUN"} 取り消し batch ${batchId} (${batch.status} / ${batch.created_at})`);
  if (batch.status === "reverted") {
    console.log("既に取り消し済み");
    return;
  }
  const recs = await selectAll("data_import_rows", "*", (q) => q.eq("batch_id", batchId));
  const cur = new Map((await selectIn(TABLE, "*", "id", recs.map((r) => r.row_id))).map((r) => [r.id, r]));
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null) || (a != null && b != null && String(a) === String(b)) || (a != null && b != null && Number(a) === Number(b) && a !== "" && b !== "");
  const plan = { del: [], restore: [], skip: [] };
  for (const r of recs) {
    const now = cur.get(r.row_id);
    if (!now) {
      plan.skip.push({ id: r.row_id, key: r.source_key, why: "既に無い" });
      continue;
    }
    const changed = Object.keys(r.after ?? {}).filter((k) => !same(now[k], r.after[k]));
    if (changed.length) {
      plan.skip.push({ id: r.row_id, key: r.source_key, why: `後から変わった列 ${changed.join(",")} (★ 戻さない)` });
      continue;
    }
    if (r.op === "insert") plan.del.push(r.row_id);
    else plan.restore.push({ id: r.row_id, patch: Object.fromEntries(Object.keys(r.after).map((k) => [k, r.before?.[k] ?? null])) });
  }
  console.log(`記録 ${recs.length} 行 → 消す ${plan.del.length} / 戻す ${plan.restore.length} / 戻さない ${plan.skip.length}`);
  for (const s of plan.skip.slice(0, 10)) console.log(`   - ${JSON.stringify(s)}`);
  if (!EXECUTE) {
    console.log("\nDRY RUN — 何も変えていない。--execute で取り消し");
    return;
  }
  for (const r of plan.restore) {
    const { error: e, count } = await sb.from(TABLE).update(r.patch, { count: "exact" }).eq("id", r.id);
    if (e || count !== 1) throw new Error(`restore ${r.id}: ${e?.message ?? `件数 ${count}`}`);
  }
  for (const c of chunks(plan.del, 150)) {
    const { error: e, count } = await sb.from(TABLE).delete({ count: "exact" }).in("id", c);
    if (e || count !== c.length) throw new Error(`delete: ${e?.message ?? `件数 ${count} ≠ ${c.length}`}`);
  }
  const status = plan.skip.some((s) => s.why !== "既に無い") ? "partially_reverted" : "reverted";
  const { error: e3 } = await sb.from("data_import_batches").update({ status, reverted_at: new Date().toISOString() }).eq("id", batchId);
  if (e3) throw new Error(`batch 更新: ${e3.message}`);
  console.log(`\n取り消し完了 (${status})。消した ${plan.del.length} / 戻した ${plan.restore.length} / 戻さなかった ${plan.skip.length}`);
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  if (REVERT) return revert(REVERT);
  const plan = await buildPlan(); // --execute でも必ず DB を読み直した計画で書く
  printPlan(plan);
  writeFileSync(OUT_PATH, JSON.stringify(planJson(plan.plans), null, 2));
  console.log(`\n詳細 ${OUT_PATH}`);
  const ready = await provenanceReady();
  console.log(`出どころ記録の表: ${ready.ok ? "あり" : `無い (${ready.why})`}`);
  if (!EXECUTE) {
    console.log("\nDRY RUN — 何も書いていない。--execute で書込み");
    return;
  }
  await execute(plan);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
