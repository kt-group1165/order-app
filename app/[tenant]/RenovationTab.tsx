"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Hammer, Plus, Loader2, AlertTriangle, Trash2, X, RefreshCw, Search } from "lucide-react";
import { Client, Member } from "@/lib/supabase";
import { getClients } from "@/lib/clients";
import { getMembers } from "@/lib/orders";
import { getCareOffices, getCareManagers, CareOffice, CareManager } from "@/lib/careOffices";
import {
  RENOVATION_STEPS,
  RENOVATION_STATUS_LABEL,
  RenovationProject,
  RenovationProjectWithSteps,
  RenovationStep,
  RenovationStepInput,
  RenovationStepKey,
  calcProgress,
  computePlannedDates,
  constructionMonth,
  costRate,
  deleteRenovationProject,
  fiscalYearLabel,
  fiscalYearOf,
  getRenovationFiscalYears,
  getRenovationProjects,
  grossProfit,
  saveRenovationProject,
  summarizeByMonth,
  summarizeTotal,
  todayYmd,
  updateRenovationStep,
} from "@/lib/renovations";

type SubTab = "board" | "delayed" | "summary";

const EMPTY_PROJECTS: RenovationProjectWithSteps[] = [];

const PROJECT_STATUS_COLOR: Record<RenovationProject["status"], string> = {
  in_progress: "bg-sky-100 text-sky-700",
  completed: "bg-emerald-100 text-emerald-700",
  on_hold: "bg-amber-100 text-amber-700",
  cancelled: "bg-gray-200 text-gray-500",
};

const yen = (v: number | null): string => (v === null ? "—" : `¥${Math.round(v).toLocaleString()}`);
const pct = (v: number | null): string => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const md = (ymd: string | null): string => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}` : "");

/** "YYYY-MM" → "1月施工分"。旧 Excel の月見出しに合わせる */
const monthHeading = (m: string): string => (m === "unscheduled" ? "施工月 未定" : `${Number(m.slice(5, 7))}月施工分`);

function stepOf(p: RenovationProjectWithSteps, key: RenovationStepKey): RenovationStep | undefined {
  return p.steps.find((s) => s.step_key === key);
}

export default function RenovationTab({
  tenantId,
  currentOfficeId,
  officeViewAll,
}: {
  tenantId: string;
  currentOfficeId: string | null;
  officeViewAll: boolean;
}) {
  const [subTab, setSubTab] = useState<SubTab>("board");
  const [projects, setProjects] = useState<RenovationProjectWithSteps[]>(EMPTY_PROJECTS);
  const [years, setYears] = useState<number[]>([]);
  const [fiscalYear, setFiscalYear] = useState<number>(fiscalYearOf(todayYmd()));
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<RenovationProjectWithSteps | "new" | null>(null);

  const officeFilter = officeViewAll ? null : currentOfficeId;

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [rows, ys] = await Promise.all([
        getRenovationProjects(tenantId, officeFilter, fiscalYear),
        getRenovationFiscalYears(tenantId, officeFilter),
      ]);
      setProjects(rows);
      setYears(ys);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("住宅改修案件の取得に失敗:", msg);
      setLoadError(msg);
      setProjects(EMPTY_PROJECTS);
    } finally {
      setLoading(false);
    }
  }, [tenantId, officeFilter, fiscalYear]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount 時の async fetch
    load();
  }, [load]);

  const today = todayYmd();

  // 施工月ごとにまとめ、月内は工事日順 (旧 Excel の「n月施工分」ブロックに相当)
  const grouped = useMemo(() => {
    const map = new Map<string, RenovationProjectWithSteps[]>();
    for (const p of projects) {
      const m = constructionMonth(p.steps) ?? "unscheduled";
      const list = map.get(m);
      if (list) list.push(p);
      else map.set(m, [p]);
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === "unscheduled") return 1;
      if (b === "unscheduled") return -1;
      return a.localeCompare(b);
    });
    return keys.map((m) => ({
      month: m,
      rows: (map.get(m) ?? []).sort((a, b) => {
        const ca = stepOf(a, "construction");
        const cb = stepOf(b, "construction");
        const da = ca?.actual_date ?? ca?.planned_date ?? "9999-99-99";
        const db = cb?.actual_date ?? cb?.planned_date ?? "9999-99-99";
        return da === db ? a.client_name.localeCompare(b.client_name) : da.localeCompare(db);
      }),
    }));
  }, [projects]);

  const delayed = useMemo(
    () =>
      projects
        .filter((p) => p.status === "in_progress")
        .map((p) => ({ p, prog: calcProgress(p.steps, today) }))
        .filter((x) => x.prog.overdueSteps.length > 0)
        .sort((a, b) => b.prog.maxOverdueDays - a.prog.maxOverdueDays),
    [projects, today],
  );

  const summaryRows = useMemo(() => summarizeByMonth(projects), [projects]);
  const summaryTotal = useMemo(() => summarizeTotal(summaryRows), [summaryRows]);

  const handleCycleStep = async (p: RenovationProjectWithSteps, key: RenovationStepKey) => {
    const s = stepOf(p, key);
    const cur = s?.status ?? "pending";
    // 未 → 完了 (実績日=今日) → 対象外 → 未 の 3 状態を回す。日付の細かい調整は編集画面で行う
    const next: RenovationStep["status"] = cur === "pending" ? "done" : cur === "done" ? "skipped" : "pending";
    const patch: Partial<Pick<RenovationStep, "actual_date" | "status">> =
      next === "done"
        ? { status: next, actual_date: s?.actual_date ?? today }
        : next === "skipped"
          ? { status: next }
          : { status: next, actual_date: null };
    try {
      const saved = await updateRenovationStep(p.id, key, patch);
      setProjects((prev) =>
        prev.map((x) =>
          x.id !== p.id
            ? x
            : { ...x, steps: [...x.steps.filter((st) => st.step_key !== key), saved] },
        ),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("工程の更新に失敗:", msg);
      alert(`工程の更新に失敗しました: ${msg}`);
    }
  };

  const subTabBar = (
    <div className="bg-white border-b border-gray-200 px-3 pt-2 flex gap-1 shrink-0">
      {(
        [
          ["board", "進行表"],
          ["delayed", `遅延${delayed.length > 0 ? ` (${delayed.length})` : ""}`],
          ["summary", "集計"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          onClick={() => setSubTab(id)}
          className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
            subTab === id ? "border-emerald-500 text-emerald-600" : "border-transparent text-gray-400 hover:text-gray-600"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0">
        <Hammer size={18} className="text-emerald-600" />
        <h2 className="font-semibold text-gray-700">住宅改修</h2>
        <select
          value={fiscalYear}
          onChange={(e) => setFiscalYear(Number(e.target.value))}
          className="ml-2 text-xs border border-gray-300 rounded px-2 py-1"
        >
          {years.map((y) => (
            <option key={y} value={y}>{fiscalYearLabel(y)}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            onClick={load}
            className="text-xs px-2 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1"
            title="再読み込み"
          >
            <RefreshCw size={13} />
          </button>
          <button
            onClick={() => setEditing("new")}
            disabled={!currentOfficeId}
            className="text-xs px-3 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
            title={currentOfficeId ? undefined : "事業所を選択してください"}
          >
            <Plus size={14} />
            新規案件
          </button>
        </div>
      </div>
      {subTabBar}

      {loadError && (
        <div className="px-3 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 shrink-0">
          読み込みに失敗しました: {loadError}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin text-emerald-400" /></div>
      ) : subTab === "board" ? (
        <BoardView
          grouped={grouped}
          today={today}
          onCycleStep={handleCycleStep}
          onEdit={(p) => setEditing(p)}
        />
      ) : subTab === "delayed" ? (
        <DelayedView rows={delayed} onEdit={(p) => setEditing(p)} />
      ) : (
        <SummaryView rows={summaryRows} total={summaryTotal} fiscalYear={fiscalYear} />
      )}

      {editing && currentOfficeId && (
        <ProjectModal
          tenantId={tenantId}
          officeId={currentOfficeId}
          fiscalYear={fiscalYear}
          project={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── 進行表 ────────────────────────────────────────────────────────────────

function StepCell({
  step,
  today,
  onClick,
}: {
  step: RenovationStep | undefined;
  today: string;
  onClick: () => void;
}) {
  const status = step?.status ?? "pending";
  const planned = step?.planned_date ?? null;
  const actual = step?.actual_date ?? null;
  const overdue = status === "pending" && planned !== null && planned < today;

  let cls = "bg-gray-50 text-gray-400 border-gray-200";
  let text = "—";
  if (status === "done") {
    cls = "bg-emerald-100 text-emerald-700 border-emerald-200";
    text = actual ? md(actual) : "〇";
  } else if (status === "skipped") {
    cls = "bg-gray-200 text-gray-400 border-gray-300";
    text = "×";
  } else if (overdue) {
    cls = "bg-red-100 text-red-700 border-red-300 font-semibold";
    text = md(planned);
  } else if (planned) {
    cls = "bg-white text-gray-500 border-gray-200";
    text = md(planned);
  }

  const title = [
    planned ? `予定 ${planned}` : null,
    actual ? `実績 ${actual}` : null,
    step?.note ? `メモ ${step.note}` : null,
    "クリックで 未→完了→対象外",
  ]
    .filter(Boolean)
    .join(" / ");

  return (
    <td className="px-1 py-1">
      <button
        onClick={onClick}
        title={title}
        className={`w-full min-w-[42px] text-[10px] leading-tight px-1 py-1 rounded border ${cls} hover:ring-1 hover:ring-emerald-300`}
      >
        {text}
        {step?.note && <span className="block text-[9px] truncate">{step.note}</span>}
      </button>
    </td>
  );
}

function BoardView({
  grouped,
  today,
  onCycleStep,
  onEdit,
}: {
  grouped: { month: string; rows: RenovationProjectWithSteps[] }[];
  today: string;
  onCycleStep: (p: RenovationProjectWithSteps, key: RenovationStepKey) => void;
  onEdit: (p: RenovationProjectWithSteps) => void;
}) {
  if (grouped.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">この年度の案件はありません</div>;
  }

  return (
    <div className="flex-1 overflow-auto p-3">
      <table className="w-full min-w-[1180px] text-xs bg-white">
        <thead className="bg-gray-50 text-[11px] text-gray-600 sticky top-0 z-10">
          <tr>
            <th className="text-left px-2 py-2 w-16">状態</th>
            <th className="text-left px-2 py-2 w-32">利用者</th>
            <th className="text-left px-2 py-2 w-36">ケアマネ</th>
            <th className="text-left px-2 py-2 w-28">住所</th>
            <th className="text-left px-2 py-2 w-16">担当</th>
            {RENOVATION_STEPS.map((s) => (
              <th key={s.key} className="px-1 py-2 w-[46px] text-center" title={s.label}>{s.short}</th>
            ))}
            <th className="text-right px-2 py-2 w-24">計上金額</th>
            <th className="text-right px-2 py-2 w-24">粗利</th>
            <th className="text-right px-2 py-2 w-16">仕入率</th>
            <th className="px-2 py-2 w-12" />
          </tr>
        </thead>
        <tbody>
          {grouped.map(({ month, rows }) => (
            <Fragment key={month}>
              <tr className="bg-emerald-50/70">
                <td colSpan={5 + RENOVATION_STEPS.length + 4} className="px-2 py-1 text-[11px] font-semibold text-emerald-800">
                  {monthHeading(month)} <span className="font-normal text-emerald-600">({rows.length}件)</span>
                </td>
              </tr>
              {rows.map((p) => {
                const prog = calcProgress(p.steps, today);
                const careLabel = [p.care_office_text, p.care_manager_text].filter(Boolean).join(" ");
                return (
                  <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="px-2 py-1 whitespace-nowrap">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${PROJECT_STATUS_COLOR[p.status]}`}>
                        {RENOVATION_STATUS_LABEL[p.status]}
                      </span>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap max-w-[128px] truncate" title={p.client_name}>
                      {prog.overdueSteps.length > 0 && p.status === "in_progress" && (
                        <AlertTriangle size={11} className="inline text-red-500 mr-0.5 -mt-0.5" />
                      )}
                      {p.client_name}
                      {p.work_content && <span className="text-gray-400 ml-1">({p.work_content})</span>}
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap max-w-[144px] truncate" title={careLabel}>{careLabel || "—"}</td>
                    <td className="px-2 py-1 whitespace-nowrap max-w-[112px] truncate" title={p.client_address ?? ""}>{p.client_address ?? "—"}</td>
                    <td className="px-2 py-1 whitespace-nowrap max-w-[64px] truncate" title={p.staff_name ?? ""}>{p.staff_name ?? "—"}</td>
                    {RENOVATION_STEPS.map((def) => (
                      <StepCell
                        key={def.key}
                        step={stepOf(p, def.key)}
                        today={today}
                        onClick={() => onCycleStep(p, def.key)}
                      />
                    ))}
                    <td className="px-2 py-1 text-right whitespace-nowrap">{yen(p.sales_total)}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap">{yen(grossProfit(p.cost_total, p.sales_total))}</td>
                    <td className="px-2 py-1 text-right whitespace-nowrap text-gray-500">{pct(costRate(p.cost_total, p.sales_total))}</td>
                    <td className="px-2 py-1 text-right">
                      <button
                        onClick={() => onEdit(p)}
                        className="text-[10px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                      >
                        編集
                      </button>
                    </td>
                  </tr>
                );
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-gray-400">
        工程セルをクリックすると 未 → 完了 → 対象外 と切り替わります (完了時は実績日に本日が入ります)。日付の調整は「編集」から。
      </p>
    </div>
  );
}

// ─── 遅延 ──────────────────────────────────────────────────────────────────

function DelayedView({
  rows,
  onEdit,
}: {
  rows: { p: RenovationProjectWithSteps; prog: ReturnType<typeof calcProgress> }[];
  onEdit: (p: RenovationProjectWithSteps) => void;
}) {
  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">予定日を過ぎた工程はありません</div>;
  }
  return (
    <div className="flex-1 overflow-y-auto overflow-x-auto p-3">
      <table className="w-full min-w-[760px] text-sm bg-white">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="text-left px-3 py-2 w-20">遅延</th>
            <th className="text-left px-3 py-2 w-40">利用者</th>
            <th className="text-left px-3 py-2 w-44">ケアマネ</th>
            <th className="text-left px-3 py-2">遅れている工程</th>
            <th className="text-left px-3 py-2 w-24">進捗</th>
            <th className="px-3 py-2 w-16" />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, prog }) => (
            <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-2 whitespace-nowrap">
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold">
                  {prog.maxOverdueDays}日
                </span>
              </td>
              <td className="px-3 py-2 whitespace-nowrap max-w-[160px] truncate" title={p.client_name}>{p.client_name}</td>
              <td className="px-3 py-2 whitespace-nowrap max-w-[176px] truncate text-gray-600">
                {[p.care_office_text, p.care_manager_text].filter(Boolean).join(" ") || "—"}
              </td>
              <td className="px-3 py-2 text-gray-700 whitespace-nowrap truncate">
                {prog.overdueSteps.map((s) => s.label).join(" / ")}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-gray-500">{prog.done}/{prog.total} ({prog.percent}%)</td>
              <td className="px-3 py-2 text-right">
                <button onClick={() => onEdit(p)} className="text-[10px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50">
                  編集
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 集計 ──────────────────────────────────────────────────────────────────

function SummaryView({
  rows,
  total,
  fiscalYear,
}: {
  rows: ReturnType<typeof summarizeByMonth>;
  total: ReturnType<typeof summarizeTotal>;
  fiscalYear: number;
}) {
  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">この年度の案件はありません</div>;
  }
  return (
    <div className="flex-1 overflow-y-auto overflow-x-auto p-3">
      <table className="w-full min-w-[620px] text-sm bg-white">
        <thead className="bg-gray-50 text-xs text-gray-600">
          <tr>
            <th className="text-left px-3 py-2 w-32">施工月</th>
            <th className="text-right px-3 py-2 w-20">件数</th>
            <th className="text-right px-3 py-2 w-32">仕切り合計</th>
            <th className="text-right px-3 py-2 w-32">計上金額</th>
            <th className="text-right px-3 py-2 w-32">粗利</th>
            <th className="text-right px-3 py-2 w-24">仕入率</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.month} className="border-b border-gray-100 hover:bg-gray-50">
              <td className="px-3 py-2 whitespace-nowrap">{monthHeading(r.month)}</td>
              <td className="px-3 py-2 text-right">{r.count}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">{yen(r.cost)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">{yen(r.sales)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">{yen(r.profit)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap text-gray-500">{pct(r.rate)}</td>
            </tr>
          ))}
          <tr className="bg-emerald-50 font-semibold text-emerald-900">
            <td className="px-3 py-2 whitespace-nowrap">{fiscalYearLabel(fiscalYear)} 合計</td>
            <td className="px-3 py-2 text-right">{total.count}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">{yen(total.cost)}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">{yen(total.sales)}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">{yen(total.profit)}</td>
            <td className="px-3 py-2 text-right whitespace-nowrap">{pct(total.rate)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── 案件 編集モーダル ──────────────────────────────────────────────────────

type StepForm = Record<RenovationStepKey, RenovationStepInput>;

function blankSteps(): StepForm {
  return Object.fromEntries(
    RENOVATION_STEPS.map((d) => [
      d.key,
      { step_key: d.key, planned_date: null, actual_date: null, status: "pending" as const, note: null },
    ]),
  ) as StepForm;
}

function stepsFrom(p: RenovationProjectWithSteps): StepForm {
  const base = blankSteps();
  for (const s of p.steps) {
    base[s.step_key] = {
      step_key: s.step_key,
      planned_date: s.planned_date,
      actual_date: s.actual_date,
      status: s.status,
      note: s.note,
    };
  }
  return base;
}

function ProjectModal({
  tenantId,
  officeId,
  fiscalYear,
  project,
  onClose,
  onSaved,
}: {
  tenantId: string;
  officeId: string;
  fiscalYear: number;
  project: RenovationProjectWithSteps | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [clientId, setClientId] = useState<string | null>(project?.client_id ?? null);
  const [clientName, setClientName] = useState(project?.client_name ?? "");
  const [clientAddress, setClientAddress] = useState(project?.client_address ?? "");
  const [careOfficeId, setCareOfficeId] = useState<string | null>(project?.care_office_id ?? null);
  const [careOfficeText, setCareOfficeText] = useState(project?.care_office_text ?? "");
  const [careManagerId, setCareManagerId] = useState<string | null>(project?.care_manager_id ?? null);
  const [careManagerText, setCareManagerText] = useState(project?.care_manager_text ?? "");
  const [staffMemberId, setStaffMemberId] = useState<string | null>(project?.staff_member_id ?? null);
  const [staffName, setStaffName] = useState(project?.staff_name ?? "");
  const [workContent, setWorkContent] = useState(project?.work_content ?? "");
  const [contractor, setContractor] = useState(project?.contractor ?? "");
  const [copayRate, setCopayRate] = useState<RenovationProject["copay_rate"]>(project?.copay_rate ?? null);
  const [notes, setNotes] = useState(project?.notes ?? "");
  const [costTotal, setCostTotal] = useState(project?.cost_total !== null && project?.cost_total !== undefined ? String(project.cost_total) : "");
  const [salesTotal, setSalesTotal] = useState(project?.sales_total !== null && project?.sales_total !== undefined ? String(project.sales_total) : "");
  const [status, setStatus] = useState<RenovationProject["status"]>(project?.status ?? "in_progress");
  const [steps, setSteps] = useState<StepForm>(project ? stepsFrom(project) : blankSteps());

  const [clients, setClients] = useState<Client[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [careOffices, setCareOffices] = useState<CareOffice[]>([]);
  const [careManagers, setCareManagers] = useState<CareManager[]>([]);
  const [clientQuery, setClientQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cs, ms, cos, cms] = await Promise.all([
          getClients(tenantId, { officeId }),
          getMembers(tenantId),
          getCareOffices(tenantId),
          getCareManagers(tenantId),
        ]);
        if (cancelled) return;
        setClients(cs);
        setMembers(ms);
        setCareOffices(cos);
        setCareManagers(cms);
      } catch (e) {
        console.warn("マスタ取得に失敗:", e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId, officeId]);

  const clientMatches = useMemo(() => {
    const q = clientQuery.trim();
    if (!q) return [];
    return clients
      .filter((c) => c.name.includes(q) || (c.furigana ?? "").includes(q) || (c.user_number ?? "").includes(q))
      .slice(0, 12);
  }, [clients, clientQuery]);

  const managersOfOffice = useMemo(
    () => (careOfficeId ? careManagers.filter((m) => m.care_office_id === careOfficeId) : []),
    [careManagers, careOfficeId],
  );

  const patchStep = (key: RenovationStepKey, patch: Partial<RenovationStepInput>) =>
    setSteps((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  /** 訪問日を起点に未入力の予定日を埋める。第2引数 true で全工程を上書き再計算 */
  const recalcPlanned = (overwrite: boolean) => {
    const next = computePlannedDates(RENOVATION_STEPS.map((d) => steps[d.key]), { overwrite });
    setSteps((prev) => {
      const out = { ...prev };
      for (const d of RENOVATION_STEPS) out[d.key] = { ...out[d.key], planned_date: next[d.key] };
      return out;
    });
  };

  /** 自費に切り替えたら 事前申請 / 役所提出 を対象外にする (旧 Excel の × と同じ扱い) */
  const applyCopayRate = (rate: RenovationProject["copay_rate"]) => {
    setCopayRate(rate);
    if (rate !== "自費") return;
    setSteps((prev) => {
      const out = { ...prev };
      for (const d of RENOVATION_STEPS) {
        if (d.skippedWhenSelfPay && out[d.key].status === "pending") {
          out[d.key] = { ...out[d.key], status: "skipped" };
        }
      }
      return out;
    });
  };

  const parseMoney = (s: string): number | null => {
    const t = s.replace(/[,¥￥\s]/g, "").trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const cost = parseMoney(costTotal);
  const sales = parseMoney(salesTotal);

  // 年度は工事日 (実績優先) から導出。工事日未定なら画面で選択中の年度を使う
  const constructionDate = steps.construction.actual_date ?? steps.construction.planned_date;
  const derivedFiscalYear = constructionDate ? fiscalYearOf(constructionDate) : fiscalYear;

  const handleSave = async () => {
    if (!clientName.trim()) {
      setError("利用者名を入力してください");
      return;
    }
    if (costTotal.trim() && cost === null) {
      setError("仕切り合計が数値として読めません");
      return;
    }
    if (salesTotal.trim() && sales === null) {
      setError("計上金額が数値として読めません");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveRenovationProject(
        tenantId,
        officeId,
        {
          id: project?.id,
          fiscal_year: derivedFiscalYear,
          client_id: clientId,
          client_name: clientName,
          client_address: clientAddress.trim() || null,
          care_office_id: careOfficeId,
          care_office_text: careOfficeText.trim() || null,
          care_manager_id: careManagerId,
          care_manager_text: careManagerText.trim() || null,
          staff_member_id: staffMemberId,
          staff_name: staffName.trim() || null,
          work_content: workContent.trim() || null,
          contractor: contractor.trim() || null,
          copay_rate: copayRate,
          notes: notes.trim() || null,
          cost_total: cost,
          sales_total: sales,
          status,
        },
        RENOVATION_STEPS.map((d) => steps[d.key]),
      );
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("住宅改修案件の保存に失敗:", msg);
      setError(`保存に失敗しました: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!project) return;
    if (!window.confirm(`「${project.client_name}」の案件を削除します。工程の記録もまとめて消えます。よろしいですか？`)) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteRenovationProject(project.id);
      onSaved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("住宅改修案件の削除に失敗:", msg);
      setError(`削除に失敗しました: ${msg}`);
      setDeleting(false);
    }
  };

  const field = "w-full text-sm border border-gray-300 rounded px-2 py-1.5";
  const label = "block text-[11px] text-gray-500 mb-0.5";

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-4xl max-h-[92vh] flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center gap-2 shrink-0">
          <Hammer size={18} className="text-emerald-600" />
          <h3 className="font-semibold text-gray-800">{project ? "住宅改修 案件の編集" : "住宅改修 新規案件"}</h3>
          <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 基本情報 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-1">
              <label className={label}>利用者名 <span className="text-red-500">*</span></label>
              <input value={clientName} onChange={(e) => { setClientName(e.target.value); setClientId(null); }} className={field} />
            </div>
            <div className="sm:col-span-2">
              <label className={label}>利用者マスタから選択 (任意)</label>
              <div className="relative">
                <Search size={13} className="absolute left-2 top-2.5 text-gray-400" />
                <input
                  value={clientQuery}
                  onChange={(e) => setClientQuery(e.target.value)}
                  placeholder="氏名 / フリガナ / 利用者番号で検索"
                  className={`${field} pl-7`}
                />
                {clientMatches.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full max-h-52 overflow-y-auto bg-white border border-gray-200 rounded shadow-lg">
                    {clientMatches.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          setClientId(c.id);
                          setClientName(c.name);
                          if (c.address) setClientAddress(c.address);
                          if (c.care_office_id) setCareOfficeId(c.care_office_id);
                          if (c.care_manager_org) setCareOfficeText(c.care_manager_org);
                          if (c.care_manager_id) setCareManagerId(c.care_manager_id);
                          if (c.care_manager) setCareManagerText(c.care_manager);
                          // clients.copay_rate は "1" と "1割" のどちらの表記もあり得るため数字だけ拾う
                          const rateDigit = (c.copay_rate ?? "").match(/^([123])/)?.[1];
                          if (rateDigit) applyCopayRate(`${rateDigit}割` as RenovationProject["copay_rate"]);
                          setClientQuery("");
                        }}
                        className="block w-full text-left px-2 py-1.5 text-xs hover:bg-emerald-50 border-b border-gray-100 last:border-0"
                      >
                        {c.name}
                        <span className="text-gray-400 ml-2">{c.furigana ?? ""} {c.user_number ?? ""}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {clientId && <p className="text-[10px] text-emerald-600 mt-0.5">利用者マスタに紐付け済み</p>}
            </div>

            <div>
              <label className={label}>住所</label>
              <input value={clientAddress} onChange={(e) => setClientAddress(e.target.value)} className={field} />
            </div>
            <div>
              <label className={label}>居宅介護支援事業所</label>
              <select
                value={careOfficeId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  setCareOfficeId(id);
                  setCareManagerId(null);
                  setCareOfficeText(id ? (careOffices.find((o) => o.id === id)?.name ?? "") : careOfficeText);
                }}
                className={field}
              >
                <option value="">(マスタ外 / 手入力)</option>
                {careOffices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
              {!careOfficeId && (
                <input
                  value={careOfficeText}
                  onChange={(e) => setCareOfficeText(e.target.value)}
                  placeholder="事業所名 (手入力)"
                  className={`${field} mt-1`}
                />
              )}
            </div>
            <div>
              <label className={label}>ケアマネ</label>
              {managersOfOffice.length > 0 ? (
                <select
                  value={careManagerId ?? ""}
                  onChange={(e) => {
                    const id = e.target.value || null;
                    setCareManagerId(id);
                    setCareManagerText(id ? (careManagers.find((m) => m.id === id)?.name ?? "") : "");
                  }}
                  className={field}
                >
                  <option value="">(選択なし)</option>
                  {managersOfOffice.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              ) : (
                <input value={careManagerText} onChange={(e) => setCareManagerText(e.target.value)} className={field} />
              )}
            </div>

            <div>
              <label className={label}>自社担当</label>
              <select
                value={staffMemberId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  setStaffMemberId(id);
                  setStaffName(id ? (members.find((m) => m.id === id)?.name ?? "") : "");
                }}
                className={field}
              >
                <option value="">(選択なし)</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div>
              <label className={label}>工事内容</label>
              <input value={workContent} onChange={(e) => setWorkContent(e.target.value)} placeholder="手すり / 段差解消 など" className={field} />
            </div>
            <div>
              <label className={label}>施工会社</label>
              <input value={contractor} onChange={(e) => setContractor(e.target.value)} className={field} />
            </div>

            <div>
              <label className={label}>負担割合</label>
              <select
                value={copayRate ?? ""}
                onChange={(e) => applyCopayRate((e.target.value || null) as RenovationProject["copay_rate"])}
                className={field}
              >
                <option value="">(未確認)</option>
                <option value="1割">1割</option>
                <option value="2割">2割</option>
                <option value="3割">3割</option>
                <option value="自費">自費</option>
              </select>
            </div>
            <div>
              <label className={label}>仕切り合計 (原価)</label>
              <input value={costTotal} onChange={(e) => setCostTotal(e.target.value)} inputMode="decimal" className={`${field} text-right`} />
            </div>
            <div>
              <label className={label}>計上金額 (売上)</label>
              <input value={salesTotal} onChange={(e) => setSalesTotal(e.target.value)} inputMode="decimal" className={`${field} text-right`} />
            </div>

            <div>
              <label className={label}>状態</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as RenovationProject["status"])} className={field}>
                {(Object.keys(RENOVATION_STATUS_LABEL) as RenovationProject["status"][]).map((s) => (
                  <option key={s} value={s}>{RENOVATION_STATUS_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className={label}>備考</label>
              <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="退院後希望 / 入院中 など" className={field} />
            </div>
          </div>

          <div className="text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-1.5">
            粗利 {yen(grossProfit(cost, sales))} ／ 仕入率 {pct(costRate(cost, sales))} ／ 年度 {fiscalYearLabel(derivedFiscalYear)}
            {constructionDate ? "（工事日から自動判定）" : "（工事日未定のため表示中の年度）"}
          </div>

          {/* 工程 */}
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <h4 className="text-sm font-semibold text-gray-700">工程</h4>
              <button
                onClick={() => recalcPlanned(false)}
                className="text-[11px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                title="訪問日を起点に、空欄の予定日だけを標準日数で埋めます"
              >
                空欄の予定日を自動計算
              </button>
              <button
                onClick={() => recalcPlanned(true)}
                className="text-[11px] px-2 py-1 border border-gray-300 rounded hover:bg-gray-50"
                title="訪問日を起点に、すべての予定日を標準日数で引き直します"
              >
                予定日を全て引き直す
              </button>
            </div>
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-[11px] text-gray-600">
                <tr>
                  <th className="text-left px-2 py-1.5 w-24">工程</th>
                  <th className="text-left px-2 py-1.5 w-32">予定日</th>
                  <th className="text-left px-2 py-1.5 w-32">実績日</th>
                  <th className="text-left px-2 py-1.5 w-28">状態</th>
                  <th className="text-left px-2 py-1.5">メモ</th>
                </tr>
              </thead>
              <tbody>
                {RENOVATION_STEPS.map((d) => {
                  const s = steps[d.key];
                  return (
                    <tr key={d.key} className="border-b border-gray-100">
                      <td className="px-2 py-1 whitespace-nowrap text-gray-700">{d.label}</td>
                      <td className="px-2 py-1">
                        <input
                          type="date"
                          value={s.planned_date ?? ""}
                          onChange={(e) => patchStep(d.key, { planned_date: e.target.value || null })}
                          className="w-full text-xs border border-gray-300 rounded px-1 py-1"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <input
                          type="date"
                          value={s.actual_date ?? ""}
                          onChange={(e) => {
                            const v = e.target.value || null;
                            // 実績日を入れたら完了扱いにする (対象外にしていた工程は触らない)
                            patchStep(d.key, {
                              actual_date: v,
                              status: v && s.status === "pending" ? "done" : s.status,
                            });
                          }}
                          className="w-full text-xs border border-gray-300 rounded px-1 py-1"
                        />
                      </td>
                      <td className="px-2 py-1">
                        <select
                          value={s.status}
                          onChange={(e) => patchStep(d.key, { status: e.target.value as RenovationStepInput["status"] })}
                          className="w-full text-xs border border-gray-300 rounded px-1 py-1"
                        >
                          <option value="pending">未</option>
                          <option value="done">完了</option>
                          <option value="skipped">対象外</option>
                        </select>
                      </td>
                      <td className="px-2 py-1">
                        <input
                          value={s.note ?? ""}
                          onChange={(e) => patchStep(d.key, { note: e.target.value || null })}
                          placeholder="ポスト投函 / 引き落とし など"
                          className="w-full text-xs border border-gray-300 rounded px-1 py-1"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">{error}</div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-gray-200 flex items-center gap-2 shrink-0">
          {project && (
            <button
              onClick={handleDelete}
              disabled={deleting || saving}
              className="text-xs px-2.5 py-1.5 rounded border border-red-300 text-red-600 hover:bg-red-50 inline-flex items-center gap-1 disabled:opacity-40"
            >
              <Trash2 size={13} />削除
            </button>
          )}
          <div className="ml-auto flex gap-2">
            <button onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50">
              キャンセル
            </button>
            <button
              onClick={handleSave}
              disabled={saving || deleting}
              className="text-sm px-4 py-1.5 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1 disabled:opacity-40"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
