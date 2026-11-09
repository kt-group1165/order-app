"use client";

// 出勤簿 › 残業集計 › 反映 (Excel)
// ケアサポの出勤簿 Excel (.xls) をブラウザで読み、職員の追加と日々の出退勤を
// payroll_kyotaku_attendance_records に入れる。
//   1. ファイルを選ぶ (or ドラッグ) → ブラウザ内で解析 (Box のローカルパスは Vercel から読めないため)
//   2. シートごとに 年月・氏名・職員の突合・新規/上書き/変更なし を出す (ここまで DB に書かない)
//   3. 「反映」で保存。同じ (職員, 日) は上書き、Excel に無い日は触らない、内容が同じ日は書かない
//      (= 何度押しても同じ)。承認済みの月は書かない。
// 既定でチェックするのは シートの年月が今月 のものだけ (毎月この Excel から当月分を入れる運用)。
// 解析・変換・差分は lib/attendance/excelImport.ts (検査: scripts/attendance-excel-import-check.mts)。

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, FileSpreadsheet, Loader2, Upload, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { selectInChunks } from "@/lib/inChunks";
import { toRecord, type AttendanceOffice, type AttendanceDbRow } from "@/lib/attendance";
import { calcMonthlySummary, extendedMonthRange, formatHM } from "@/lib/attendance/attendance-calc";
import { overtimeConsumption, overtimeLimitHours } from "@/lib/attendance/overtime-limit";
import {
  fetchAttendanceRowsRange,
  fetchCompanyHolidaysRange,
  fetchMonthStatuses,
} from "@/lib/attendance/summary-data";
import {
  readWorkbookSheets,
  parseWorkbookSheets,
  dayToPayload,
  diffPayload,
  sheetSelectable,
  defaultChecked,
  normName,
  type ParsedSheet,
  type DiffEntry,
} from "@/lib/attendance/excelImport";
import { todayYmd } from "@/lib/date-jst";

/** ケアサポ (介護ショップケア・サポート千葉) の共通 offices.id。この Excel の事業所 */
const CARE_SUPPORT_OFFICE_ID = "1bfc0d57-9ee0-4ae2-baa5-80edb776290a";

type EmpRow = {
  id: string;
  name: string;
  employment_status: string | null;
  attendance_hidden?: boolean | null;
  member_id?: string | null;
};

/** 職員の突合結果 */
type EmpPlan =
  | { kind: "existing"; employeeId: string; name: string; retired: boolean }
  | { kind: "link-member"; memberId: string; name: string }
  | { kind: "create"; name: string }
  | { kind: "ambiguous"; names: string[] };

type SheetPlan = {
  sheet: ParsedSheet;
  emp: EmpPlan;
  /** 選べない理由 (null = 選べる) */
  blocked: string | null;
  /** 提出済み (警告のみ) */
  submitted: boolean;
  entries: DiffEntry[];
  /** 反映後のアプリ計算 (通常残業・分) */
  appOvertime: number;
  /** 反映後の 月間残業枠の消費 (分) */
  appConsumed: number;
};

type Result = { sheetName: string; name: string; ok: boolean; written: number; message: string };

/** 氏名を members / payroll_employees に入れる形に (全角/連続スペース → 半角 1 つ) */
function displayName(s: string): string {
  return s.replace(/[\s　]+/g, " ").trim();
}

export default function AttendanceExcelImportModal({
  tenantId,
  office,
  onClose,
}: {
  tenantId: string;
  /** 反映先の payroll 事業所 (出勤簿タブで選択中のもの) */
  office: AttendanceOffice;
  /** changed = 1 件でも書いた */
  onClose: (changed: boolean) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string>("");
  const [parsing, setParsing] = useState(false);
  const [plans, setPlans] = useState<SheetPlan[]>([]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [memberTenantId, setMemberTenantId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importedOn = todayYmd();
  const currentYm = importedOn.slice(0, 7);
  const weekStart = office.work_week_start ?? 0;
  const notCareSupport = office.office_id !== CARE_SUPPORT_OFFICE_ID;

  // ─── 解析 + DB との突合 (読むだけ) ─────────────────────────────────
  const analyze = useCallback(
    async (file: File) => {
      setParsing(true);
      setError(null);
      setResults(null);
      setPlans([]);
      setFileName(file.name);
      try {
        const sheets = parseWorkbookSheets(await readWorkbookSheets(await file.arrayBuffer()));
        if (sheets.length === 0) throw new Error("出勤簿の様式のシートが見つかりません (行6に「日付」の見出しがあるシート)");

        // 職員 (退職者・非表示も含めて突合する。同じ人を二重に作らないため)
        const { data: empData, error: empErr } = await supabase
          .from("payroll_employees")
          .select("*")
          .eq("office_id", office.id)
          .order("name")
          .order("id");
        if (empErr) throw new Error(`職員の取得に失敗: ${empErr.message}`);
        const emps = (empData ?? []) as EmpRow[];
        const empsByKey = new Map<string, EmpRow[]>();
        for (const e of emps) {
          const k = normName(e.name);
          empsByKey.set(k, [...(empsByKey.get(k) ?? []), e]);
        }

        // members (この事業所が主所属・在籍・payroll 未紐付け) — いれば新規 member を作らず紐付ける
        const { data: offRow, error: offErr } = await supabase
          .from("offices")
          .select("tenant_id")
          .eq("id", office.office_id)
          .maybeSingle();
        if (offErr) throw new Error(`事業所の取得に失敗: ${offErr.message}`);
        setMemberTenantId((offRow as { tenant_id?: string } | null)?.tenant_id ?? "");
        const { data: links, error: linkErr } = await supabase
          .from("member_offices")
          .select("member_id")
          .eq("office_id", office.office_id)
          .eq("is_primary", true);
        if (linkErr) throw new Error(`所属の取得に失敗: ${linkErr.message}`);
        const mids = [...new Set((links ?? []).map((l) => (l as { member_id: string }).member_id))];
        const members = await selectInChunks<{ id: string; name: string; status: string; deleted_at: string | null }>(
          mids,
          (chunk) => supabase.from("members").select("id, name, status, deleted_at").in("id", chunk),
        );
        const linkedMemberIds = new Set(
          (
            await selectInChunks<{ member_id: string | null }>(mids, (chunk) =>
              supabase.from("payroll_employees").select("member_id").in("member_id", chunk),
            )
          ).map((r) => r.member_id),
        );
        const freeMembersByKey = new Map<string, { id: string; name: string }[]>();
        for (const m of members) {
          if (m.deleted_at || m.status !== "active" || linkedMemberIds.has(m.id)) continue;
          const k = normName(m.name);
          freeMembersByKey.set(k, [...(freeMembersByKey.get(k) ?? []), m]);
        }

        const empPlanOf = (s: ParsedSheet): EmpPlan => {
          const hit = empsByKey.get(s.nameKey) ?? [];
          if (hit.length > 1) return { kind: "ambiguous", names: hit.map((h) => h.name) };
          if (hit.length === 1) {
            return {
              kind: "existing",
              employeeId: hit[0].id,
              name: hit[0].name,
              retired: hit[0].employment_status === "退職者",
            };
          }
          const mem = freeMembersByKey.get(s.nameKey) ?? [];
          if (mem.length > 1) return { kind: "ambiguous", names: mem.map((m) => m.name) };
          if (mem.length === 1) return { kind: "link-member", memberId: mem[0].id, name: mem[0].name };
          return { kind: "create", name: displayName(s.fullName) };
        };

        // 既存の出勤簿行 (月跨ぎ週の計算のため 週頭〜週末 まで) と 提出状況
        const selectableSheets = sheets.filter((s) => sheetSelectable(s).ok);
        const exts = selectableSheets.map((s) => extendedMonthRange(s.ym!, weekStart));
        const rangeStart = exts.map((e) => e.start).sort()[0] ?? "";
        const rangeEnd = exts.map((e) => e.end).sort().reverse()[0] ?? "";
        const existingIds = [
          ...new Set(
            selectableSheets
              .map((s) => empPlanOf(s))
              .flatMap((p) => (p.kind === "existing" ? [p.employeeId] : [])),
          ),
        ];
        const [existingRows, holidays, statuses] = await Promise.all([
          rangeStart ? fetchAttendanceRowsRange(existingIds, rangeStart, rangeEnd) : Promise.resolve([] as AttendanceDbRow[]),
          rangeStart ? fetchCompanyHolidaysRange(tenantId, rangeStart, rangeEnd) : Promise.resolve(new Set<string>()),
          fetchMonthStatuses(existingIds, selectableSheets.map((s) => s.ym!)),
        ]);
        const rowsByEmp = new Map<string, AttendanceDbRow[]>();
        for (const r of existingRows) rowsByEmp.set(r.employee_id, [...(rowsByEmp.get(r.employee_id) ?? []), r]);

        const next: SheetPlan[] = sheets.map((s) => {
          const emp = empPlanOf(s);
          const sel = sheetSelectable(s);
          let blocked = sel.reason;
          const empId = emp.kind === "existing" ? emp.employeeId : null;
          const status = empId && s.ym ? statuses.get(`${empId}|${s.ym}`) : undefined;
          if (!blocked && emp.kind === "ambiguous") blocked = `同じ氏名が複数 (${emp.names.join(" / ")})`;
          if (!blocked && status === "approved") blocked = "この月は承認済みのため上書きしません";

          const mine = empId ? (rowsByEmp.get(empId) ?? []) : [];
          const existingByDate = new Map(mine.map((r) => [r.work_date, r]));
          const entries: DiffEntry[] = sel.ok
            ? s.days.map((d) => {
                const ex = existingByDate.get(d.work_date) ?? null;
                return diffPayload(
                  dayToPayload(d, { col7IsKm: s.col7IsKm, importedOn, existing: ex }),
                  ex,
                );
              })
            : [];

          // 反映後のアプリ計算: 既存行 (週頭〜週末) を Excel の行で上書きしたもので計算
          let appOvertime = 0;
          let appConsumed = 0;
          if (sel.ok && s.ym) {
            const merged = new Map(mine.map((r) => [r.work_date, r]));
            for (const e of entries) {
              merged.set(e.payload.work_date, {
                ...e.payload,
                tenant_id: tenantId,
                office_id: office.id,
                employee_id: empId ?? "",
              });
            }
            const c = overtimeConsumption(
              calcMonthlySummary([...merged.values()].map(toRecord), weekStart, s.ym, holidays),
              overtimeLimitHours(office.id),
            );
            appOvertime = c.overtime;
            appConsumed = c.consumed;
          }
          return { sheet: s, emp, blocked, submitted: status === "submitted", entries, appOvertime, appConsumed };
        });
        // 新しい月が上、同じ月はシート順
        next.sort((a, b) => (b.sheet.ym ?? "").localeCompare(a.sheet.ym ?? ""));
        setPlans(next);
        setChecked(
          new Set(next.filter((p) => !p.blocked && defaultChecked(p.sheet, currentYm)).map((p) => p.sheet.sheetName)),
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String((e as { message?: string }).message ?? e);
        setError(msg);
      } finally {
        setParsing(false);
      }
    },
    [office.id, office.office_id, tenantId, weekStart, importedOn, currentYm],
  );

  const onPick = (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (!/\.(xls|xlsx|xlsm)$/i.test(file.name)) {
      setError("Excel ファイル (.xls / .xlsx / .xlsm) を選んでください");
      return;
    }
    analyze(file);
  };

  const targets = useMemo(
    () => plans.filter((p) => !p.blocked && checked.has(p.sheet.sheetName)),
    [plans, checked],
  );
  const writeCount = targets.reduce((s, p) => s + p.entries.filter((e) => e.status !== "same").length, 0);
  const createCount = targets.filter((p) => p.emp.kind === "create" || p.emp.kind === "link-member").length;

  // ─── 職員を用意 (既存 / members 紐付け / 新規作成) ────────────────
  const ensureEmployee = async (p: SheetPlan): Promise<string> => {
    const emp = p.emp;
    if (emp.kind === "existing") return emp.employeeId;
    if (emp.kind === "ambiguous") throw new Error("同じ氏名が複数あるため職員を決められません");
    let memberId: string;
    let name: string;
    if (emp.kind === "link-member") {
      memberId = emp.memberId;
      name = emp.name;
    } else {
      // members → member_offices (主所属) → payroll_employees の順 (migrations/sync_fukuyogu_roster.mjs と同じ流儀)
      if (!memberTenantId) throw new Error("事業所の tenant が分からないため職員を作れません");
      name = emp.name;
      const { data: m, error: mErr } = await supabase
        .from("members")
        .insert({ tenant_id: memberTenantId, name, status: "active" })
        .select("id")
        .single();
      if (mErr || !m) throw new Error(`職員 (members) の作成に失敗: ${mErr?.message ?? "id が返りません"}`);
      memberId = (m as { id: string }).id;
      const { error: moErr } = await supabase
        .from("member_offices")
        .insert({ member_id: memberId, office_id: office.office_id, is_primary: true });
      if (moErr) throw new Error(`所属 (member_offices) の作成に失敗: ${moErr.message}`);
    }
    const { data: pe, error: peErr } = await supabase
      .from("payroll_employees")
      .insert({
        employee_number: `M-${memberId.slice(0, 8)}`,
        name,
        office_id: office.id,
        employment_status: "在職者",
        member_id: memberId,
      })
      .select("id")
      .single();
    if (peErr || !pe) throw new Error(`出勤簿の職員 (payroll_employees) の作成に失敗: ${peErr?.message ?? "id が返りません"}`);
    return (pe as { id: string }).id;
  };

  // ─── 反映 ─────────────────────────────────────────────────────────
  const handleApply = async () => {
    if (targets.length === 0) return;
    const lines = targets.map(
      (p) =>
        `・${p.sheet.sheetName} ${p.sheet.ym} ${p.emp.kind === "existing" ? p.emp.name : `${displayName(p.sheet.fullName)} (職員を新規作成)`} ` +
        `${p.entries.filter((e) => e.status !== "same").length} 日`,
    );
    if (
      !window.confirm(
        `${office.name} の出勤簿に反映します。\n\n${lines.join("\n")}\n\n同じ日の既存の入力は Excel の値で上書きされます。よろしいですか？`,
      )
    ) {
      return;
    }
    setSaving(true);
    const out: Result[] = [];
    for (const p of targets) {
      const label = p.emp.kind === "existing" ? p.emp.name : displayName(p.sheet.fullName);
      try {
        const employeeId = await ensureEmployee(p);
        const rows = p.entries
          .filter((e) => e.status !== "same")
          // キー集合は全行で同じ (バッチ insert でキーが違うと DEFAULT が効かず NULL が入るため)
          .map((e) => ({ ...e.payload, tenant_id: tenantId, office_id: office.id, employee_id: employeeId }));
        if (rows.length > 0) {
          const { error } = await supabase
            .from("payroll_kyotaku_attendance_records")
            .upsert(rows, { onConflict: "employee_id,work_date" });
          if (error) throw new Error(`出勤簿の保存に失敗: ${error.message}`);
        }
        out.push({
          sheetName: p.sheet.sheetName,
          name: label,
          ok: true,
          written: rows.length,
          message: p.emp.kind === "existing" ? "" : "職員を作成",
        });
      } catch (e) {
        out.push({
          sheetName: p.sheet.sheetName,
          name: label,
          ok: false,
          written: 0,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    setSaving(false);
    setResults(out);
    const ng = out.filter((r) => !r.ok);
    const total = out.reduce((s, r) => s + r.written, 0);
    alert(
      ng.length === 0
        ? `反映しました (${out.length} 名・${total} 日)`
        : `${ng.length} 名で失敗しました\n\n${ng.map((r) => `${r.name}: ${r.message}`).join("\n")}`,
    );
  };

  const changedAny = (results ?? []).some((r) => r.ok && (r.written > 0 || r.message));

  const toggle = (set: Set<string>, key: string) => {
    const n = new Set(set);
    if (n.has(key)) n.delete(key);
    else n.add(key);
    return n;
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b flex items-center gap-2 shrink-0">
          <FileSpreadsheet size={18} className="text-emerald-600" />
          <h3 className="font-semibold text-gray-800">Excel 出勤簿から反映</h3>
          <span className="text-xs text-gray-500">反映先: {office.name}</span>
          <button
            onClick={() => onClose(changedAny)}
            disabled={saving}
            className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-500 disabled:opacity-30"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {notCareSupport && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2 flex items-start gap-1.5">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              この Excel はケアサポ (介護ショップケア・サポート千葉) の様式です。反映先が {office.name} になっています。
              氏名が合わない職員は新規作成されるので、事業所を確認してください。
            </div>
          )}

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              onPick(e.dataTransfer.files?.[0]);
            }}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-lg px-4 py-4 text-center text-xs cursor-pointer ${
              dragOver ? "border-emerald-400 bg-emerald-50" : "border-gray-300 hover:bg-gray-50"
            }`}
          >
            {parsing ? (
              <span className="inline-flex items-center gap-1.5 text-gray-500"><Loader2 size={14} className="animate-spin" />読み込み中…</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-gray-600">
                <Upload size={14} />
                {fileName ? `${fileName} (別のファイルを選ぶ)` : "出勤簿の Excel (♦2024.3月～【出勤簿】.xls) を選ぶか、ここにドラッグ"}
              </span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".xls,.xlsx,.xlsm"
              className="hidden"
              onChange={(e) => onPick(e.target.files?.[0])}
            />
          </div>
          <p className="text-[10px] text-gray-400">
            Box の「ケアサポ(共有) › 【 業務書類 】 › 【出勤簿】+小口精算表」にあるファイルです。ファイルはブラウザの中だけで読み、反映を押すまで何も保存しません。
          </p>

          {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>}

          {plans.length > 0 && (
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="w-8 px-1 py-1.5" />
                  <th className="text-left px-2 py-1.5 w-16">シート</th>
                  <th className="text-left px-2 py-1.5 w-16">年月</th>
                  <th className="text-left px-2 py-1.5 w-48">職員</th>
                  <th className="text-right px-2 py-1.5 w-12">入力</th>
                  <th className="text-right px-2 py-1.5 w-28" title="新規 / 上書き / 変更なし (日数)">新規/上書/同じ</th>
                  <th className="text-right px-2 py-1.5 w-20" title="Excel の残業時間合計 (行27)。参考">Excel残業</th>
                  <th className="text-right px-2 py-1.5 w-20" title="反映後にアプリで計算した通常残業 (1日8h超+週40h超)。これが正">アプリ計算</th>
                  <th className="text-right px-2 py-1.5 w-16">差</th>
                  <th className="text-left px-2 py-1.5">注意</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((p) => {
                  const key = p.sheet.sheetName;
                  const isOpen = expanded.has(key);
                  const nNew = p.entries.filter((e) => e.status === "new").length;
                  const nChg = p.entries.filter((e) => e.status === "changed").length;
                  const nSame = p.entries.filter((e) => e.status === "same").length;
                  const excelMin =
                    p.sheet.excelOvertimeTotal === null ? null : Math.round(p.sheet.excelOvertimeTotal * 60);
                  const notes: string[] = [];
                  if (p.blocked) notes.push(p.blocked);
                  if (p.submitted) notes.push("提出済みの月 (上書きすると本人の提出内容が変わります)");
                  if (p.emp.kind === "existing" && p.emp.retired) notes.push("退職者の職員に入ります");
                  // 件数だけでは何のことか分からないので、注意の本文をそのまま並べる
                  notes.push(...p.sheet.warnings);
                  const result = results?.find((r) => r.sheetName === key);
                  return (
                    <Fragment key={key}>
                      <tr className={`border-b border-gray-100 ${p.blocked ? "text-gray-400" : ""}`}>
                        <td className="px-1 py-1 text-center">
                          <input
                            type="checkbox"
                            disabled={!!p.blocked || saving}
                            checked={!p.blocked && checked.has(key)}
                            onChange={() => setChecked((s) => toggle(s, key))}
                          />
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap">
                          <button
                            onClick={() => setExpanded((s) => toggle(s, key))}
                            className="inline-flex items-center gap-0.5 hover:text-emerald-700"
                          >
                            {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            {key}
                          </button>
                        </td>
                        <td className={`px-2 py-1 whitespace-nowrap tabular-nums ${p.sheet.ym === currentYm ? "font-semibold text-emerald-700" : ""}`}>
                          {p.sheet.ym ?? "—"}
                        </td>
                        <td className="px-2 py-1 whitespace-nowrap truncate max-w-[12rem]" title={p.sheet.fullName}>
                          {p.emp.kind === "existing" ? (
                            p.emp.name
                          ) : p.emp.kind === "ambiguous" ? (
                            <span className="text-red-600">{p.sheet.fullName}</span>
                          ) : (
                            <>
                              {displayName(p.sheet.fullName)}
                              <span className="ml-1 text-[10px] px-1 rounded bg-sky-100 text-sky-700">
                                {p.emp.kind === "link-member" ? "新規 (登録済みの職員に紐付け)" : "新規作成"}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{p.sheet.days.length}</td>
                        <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                          {p.entries.length > 0 ? `${nNew} / ${nChg} / ${nSame}` : "—"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums">{excelMin === null ? "—" : formatHM(excelMin)}</td>
                        <td className="px-2 py-1 text-right tabular-nums font-medium" title={`${overtimeLimitHours(office.id)}h 枠の消費 ${formatHM(p.appConsumed)}`}>
                          {p.entries.length > 0 ? formatHM(p.appOvertime) : "—"}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-gray-500">
                          {p.entries.length > 0 && excelMin !== null ? formatHM(p.appOvertime - excelMin) : ""}
                        </td>
                        <td className="px-2 py-1 max-w-[28rem] whitespace-normal break-words text-xs" title={notes.join("\n")}>
                          {result ? (
                            result.ok ? (
                              <span className="text-emerald-700">反映済み {result.written} 日{result.message ? ` (${result.message})` : ""}</span>
                            ) : (
                              <span className="text-red-600">失敗: {result.message}</span>
                            )
                          ) : (
                            <span className={p.blocked ? "" : notes.length ? "text-amber-700" : ""}>{notes.join(" / ")}</span>
                          )}
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="bg-gray-50/60 border-b border-gray-100">
                          <td />
                          <td colSpan={9} className="px-2 py-2">
                            {p.sheet.warnings.length > 0 && (
                              <ul className="mb-1.5 text-[11px] text-amber-700 list-disc pl-4">
                                {p.sheet.warnings.map((w, i) => <li key={i}>{w}</li>)}
                              </ul>
                            )}
                            <table className="text-[11px]">
                              <tbody>
                                {p.sheet.days.map((d, i) => {
                                  const e = p.entries[i];
                                  return (
                                    <tr key={d.work_date}>
                                      <td className="pr-3 tabular-nums whitespace-nowrap">{d.work_date.slice(5).replace("-", "/")}</td>
                                      <td className="pr-3 w-12">{d.reason}</td>
                                      <td className="pr-3 tabular-nums whitespace-nowrap w-24">
                                        {d.start || d.end ? `${d.start ?? ""}-${d.end ?? ""}` : ""}
                                      </td>
                                      <td className="pr-3 tabular-nums text-gray-500 w-24 whitespace-nowrap">
                                        {d.excelOvertimeHours !== null ? `Excel残業 ${d.excelOvertimeHours}h` : ""}
                                      </td>
                                      <td className="pr-3 whitespace-nowrap">
                                        {!e ? (
                                          ""
                                        ) : e.status === "new" ? (
                                          <span className="text-sky-700">新規</span>
                                        ) : e.status === "same" ? (
                                          <span className="text-gray-400">変更なし</span>
                                        ) : (
                                          <span className="text-amber-700">
                                            上書き: {e.changes.map((c) => `${c.field} ${c.before || "空"}→${c.after || "空"}`).join(" / ")}
                                          </span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}

          {plans.length > 0 && (
            <div className="text-[10px] text-gray-500 space-y-0.5">
              <p>・既定でチェックするのは シートの年月が今月 ({currentYm}) のものだけです。古い月も選べば入れられます。</p>
              <p>・残業はアプリの計算 (1日8時間超 + 週40時間超) が正です。Excel の残業 (18時以降を30分単位で切り捨て) は参考です。</p>
              <p>・休憩は拘束6時間以上なら60分 (出勤簿の入力画面の既定と同じ)。有休・半休は有給欄に、振替・欠勤・在宅などは備考に入ります。振替元の出勤日は Excel に無いので入りません (必要なら入力画面で入れてください)。</p>
              <p>・同じ日の既存の入力は上書きします。Excel に無い日は触りません。内容が同じ日は書きません。承認済みの月は書きません。</p>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-500">
            {targets.length > 0
              ? `${targets.length} 名・${writeCount} 日を書き込み${createCount > 0 ? ` (うち職員の新規作成 ${createCount} 名)` : ""}`
              : "反映するシートを選んでください"}
          </span>
          <button
            onClick={() => onClose(changedAny)}
            disabled={saving}
            className="ml-auto text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          >
            閉じる
          </button>
          <button
            onClick={handleApply}
            disabled={saving || parsing || targets.length === 0 || (writeCount === 0 && createCount === 0) || results !== null}
            className="text-xs px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
            title={results !== null ? "反映済みです。もう一度行うときはファイルを選び直してください" : undefined}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            反映
          </button>
        </div>
      </div>
    </div>
  );
}

