import { supabase } from "./supabase";

// 住宅改修 進行管理。
// 旧 Excel「◆住宅改修 進行表」(年度ごと 1 sheet / 1 案件 = 2〜4 行ブロック) の置換。
// DB: apps/order-app/supabase/migrations/create_renovation_projects.sql

// ─── 工程定義 ────────────────────────────────────────────────────────────────

export type RenovationStepKey =
  | "visit"
  | "quote_created"
  | "quote_presented"
  | "pre_application"
  | "construction"
  | "order_sheet"
  | "collection"
  | "office_submit";

export type RenovationStepDef = {
  key: RenovationStepKey;
  label: string;
  short: string; // 進行表マトリクスのヘッダ用 (2〜3文字)
  /** 予定日の起点となる工程。null = 起点そのもの (訪問日を入れると以降が芋づるで埋まる) */
  plannedFrom: RenovationStepKey | null;
  /** plannedFrom の予定日 + この日数 = この工程の予定日 */
  plannedOffsetDays: number;
  /** 自費案件 (copay_rate='自費') では既定で対象外にする工程 */
  skippedWhenSelfPay: boolean;
};

// 予定日オフセットは旧 Excel「令和8年度」シートの数式をそのまま移植:
//   H = F+7 (見積提出), I = H+7 (事前協議), J = I+10 (工事), M = J+7 (集金), N = M+7 (役所提出)
// 見積作成 / 受注票作成 は Excel に予定日の数式が無かったため、
// 前後の工程の間に収まる日数を既定値として置いている (運用に合わせてここだけ直せばよい)。
export const RENOVATION_STEPS: RenovationStepDef[] = [
  { key: "visit",           label: "訪問",              short: "訪問", plannedFrom: null,              plannedOffsetDays: 0,  skippedWhenSelfPay: false },
  { key: "quote_created",   label: "見積作成",          short: "見作", plannedFrom: "visit",           plannedOffsetDays: 4,  skippedWhenSelfPay: false },
  { key: "quote_presented", label: "見積提出",          short: "見出", plannedFrom: "visit",           plannedOffsetDays: 7,  skippedWhenSelfPay: false },
  { key: "pre_application", label: "事前申請",          short: "事前", plannedFrom: "quote_presented", plannedOffsetDays: 7,  skippedWhenSelfPay: true  },
  { key: "construction",    label: "工事",              short: "工事", plannedFrom: "pre_application", plannedOffsetDays: 10, skippedWhenSelfPay: false },
  { key: "order_sheet",     label: "受注票作成",        short: "受注", plannedFrom: "construction",    plannedOffsetDays: 3,  skippedWhenSelfPay: false },
  { key: "collection",      label: "集金",              short: "集金", plannedFrom: "construction",    plannedOffsetDays: 7,  skippedWhenSelfPay: false },
  { key: "office_submit",   label: "役所提出",          short: "役所", plannedFrom: "collection",      plannedOffsetDays: 7,  skippedWhenSelfPay: true  },
];

export const RENOVATION_STEP_MAP: Record<RenovationStepKey, RenovationStepDef> =
  Object.fromEntries(RENOVATION_STEPS.map((s) => [s.key, s])) as Record<RenovationStepKey, RenovationStepDef>;

export const RENOVATION_STATUS_LABEL: Record<RenovationProject["status"], string> = {
  in_progress: "進行中",
  completed: "完了",
  on_hold: "保留",
  cancelled: "中止",
};

// ─── 型 ──────────────────────────────────────────────────────────────────────

export type RenovationStep = {
  id: string;
  project_id: string;
  step_key: RenovationStepKey;
  planned_date: string | null;
  actual_date: string | null;
  status: "pending" | "done" | "skipped";
  note: string | null;
  created_at: string;
  updated_at: string;
};

export type RenovationProject = {
  id: string;
  tenant_id: string;
  office_id: string;
  fiscal_year: number;
  client_id: string | null;
  client_name: string;
  client_address: string | null;
  care_office_id: string | null;
  care_office_text: string | null;
  care_manager_id: string | null;
  care_manager_text: string | null;
  staff_member_id: string | null;
  staff_name: string | null;
  work_content: string | null;
  contractor: string | null;
  copay_rate: "1割" | "2割" | "3割" | "自費" | null;
  notes: string | null;
  cost_total: number | null;
  sales_total: number | null;
  status: "in_progress" | "completed" | "on_hold" | "cancelled";
  import_marker: string | null;
  created_at: string;
  updated_at: string;
};

export type RenovationProjectWithSteps = RenovationProject & { steps: RenovationStep[] };

/** 保存フォームから渡ってくる案件本体の入力値 (id 有りなら更新) */
export type RenovationProjectInput = {
  id?: string;
  fiscal_year: number;
  client_id: string | null;
  client_name: string;
  client_address: string | null;
  care_office_id: string | null;
  care_office_text: string | null;
  care_manager_id: string | null;
  care_manager_text: string | null;
  staff_member_id: string | null;
  staff_name: string | null;
  work_content: string | null;
  contractor: string | null;
  copay_rate: RenovationProject["copay_rate"];
  notes: string | null;
  cost_total: number | null;
  sales_total: number | null;
  status: RenovationProject["status"];
};

/** 保存フォームから渡ってくる工程 1 行分の入力値 */
export type RenovationStepInput = {
  step_key: RenovationStepKey;
  planned_date: string | null;
  actual_date: string | null;
  status: RenovationStep["status"];
  note: string | null;
};

// ─── 日付ユーティリティ ──────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" に日数を足す。ローカルタイムゾーンの影響を避けるため UTC で計算する */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** 年度 (4/1〜3/31) を返す。2026-03-31 → 2025、2026-04-01 → 2026 */
export function fiscalYearOf(ymd: string): number {
  const [y, m] = ymd.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

/** 西暦年度 → 和暦表記 ("令和8年度")。令和元年 = 2019 */
export function fiscalYearLabel(fy: number): string {
  const reiwa = fy - 2018;
  if (reiwa <= 0) return `${fy}年度`;
  return `令和${reiwa === 1 ? "元" : reiwa}年度`;
}

export function todayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * 訪問日を起点に、未入力の予定日を工程定義のオフセットで埋める。
 * 既に予定日が入っている工程は上書きしない (手で動かした予定を消さないため)。
 * `overwrite: true` の時だけ全工程を再計算する。
 */
export function computePlannedDates(
  steps: Pick<RenovationStepInput, "step_key" | "planned_date">[],
  opts: { overwrite?: boolean } = {},
): Record<RenovationStepKey, string | null> {
  const current = new Map(steps.map((s) => [s.step_key, s.planned_date]));
  const out = {} as Record<RenovationStepKey, string | null>;
  for (const def of RENOVATION_STEPS) {
    const existing = current.get(def.key) ?? null;
    if (existing && !opts.overwrite) {
      out[def.key] = existing;
      continue;
    }
    if (def.plannedFrom === null) {
      // 起点 (訪問日) は自動算出できない。既存値をそのまま使う
      out[def.key] = existing;
      continue;
    }
    const base = out[def.plannedFrom];
    out[def.key] = base ? addDays(base, def.plannedOffsetDays) : existing;
  }
  return out;
}

// ─── 進捗・遅延の判定 ────────────────────────────────────────────────────────

export type RenovationProgress = {
  /** 対象工程数 (skipped を除く) */
  total: number;
  /** 完了した工程数 */
  done: number;
  /** 0〜100 */
  percent: number;
  /** 次にやるべき工程 (全部済んでいれば null) */
  nextStep: RenovationStepDef | null;
  /** 予定日を過ぎているのに未消化の工程 */
  overdueSteps: RenovationStepDef[];
  /** 最も古い遅延の日数 (遅延なしは 0) */
  maxOverdueDays: number;
};

export function calcProgress(
  steps: Pick<RenovationStep, "step_key" | "planned_date" | "status">[],
  today: string = todayYmd(),
): RenovationProgress {
  const byKey = new Map(steps.map((s) => [s.step_key, s]));
  let total = 0;
  let done = 0;
  let nextStep: RenovationStepDef | null = null;
  const overdueSteps: RenovationStepDef[] = [];
  let maxOverdueDays = 0;

  for (const def of RENOVATION_STEPS) {
    const s = byKey.get(def.key);
    const status = s?.status ?? "pending";
    if (status === "skipped") continue;
    total += 1;
    if (status === "done") {
      done += 1;
      continue;
    }
    if (!nextStep) nextStep = def;
    const planned = s?.planned_date;
    if (planned && planned < today) {
      overdueSteps.push(def);
      const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${planned}T00:00:00Z`)) / DAY_MS);
      if (days > maxOverdueDays) maxOverdueDays = days;
    }
  }

  return {
    total,
    done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    nextStep,
    overdueSteps,
    maxOverdueDays,
  };
}

/** 施工月 ("YYYY-MM")。工事の実績日 > 予定日 の順で採用。どちらも無ければ null */
export function constructionMonth(steps: Pick<RenovationStep, "step_key" | "planned_date" | "actual_date">[]): string | null {
  const s = steps.find((x) => x.step_key === "construction");
  const d = s?.actual_date ?? s?.planned_date ?? null;
  return d ? d.slice(0, 7) : null;
}

// ─── 金額 ────────────────────────────────────────────────────────────────────

/** 仕入率 = 仕切り合計 / 計上金額。売上 0/未入力 は null (Excel の #DIV/0! 相当) */
export function costRate(cost: number | null, sales: number | null): number | null {
  if (cost === null || sales === null || sales === 0) return null;
  return cost / sales;
}

/** 粗利 = 計上金額 − 仕切り合計。片方でも未入力なら null */
export function grossProfit(cost: number | null, sales: number | null): number | null {
  if (cost === null || sales === null) return null;
  return sales - cost;
}

export type RenovationSummaryRow = {
  /** "YYYY-MM" (施工月) または "unscheduled" */
  month: string;
  count: number;
  cost: number;
  sales: number;
  profit: number;
  /** 集計後の仕入率 (合計 cost / 合計 sales)。sales 0 は null */
  rate: number | null;
};

/** 施工月ごとに 件数 / 仕切り / 計上 / 粗利 を集計する (Excel の月次集計行の置換) */
export function summarizeByMonth(projects: RenovationProjectWithSteps[]): RenovationSummaryRow[] {
  const map = new Map<string, RenovationSummaryRow>();
  for (const p of projects) {
    const month = constructionMonth(p.steps) ?? "unscheduled";
    let row = map.get(month);
    if (!row) {
      row = { month, count: 0, cost: 0, sales: 0, profit: 0, rate: null };
      map.set(month, row);
    }
    row.count += 1;
    row.cost += p.cost_total ?? 0;
    row.sales += p.sales_total ?? 0;
  }
  for (const row of map.values()) {
    row.profit = row.sales - row.cost;
    row.rate = row.sales === 0 ? null : row.cost / row.sales;
  }
  // 施工月未定は末尾に置く
  return Array.from(map.values()).sort((a, b) => {
    if (a.month === "unscheduled") return 1;
    if (b.month === "unscheduled") return -1;
    return a.month.localeCompare(b.month);
  });
}

export function summarizeTotal(rows: RenovationSummaryRow[]): RenovationSummaryRow {
  const total = rows.reduce(
    (acc, r) => ({ ...acc, count: acc.count + r.count, cost: acc.cost + r.cost, sales: acc.sales + r.sales }),
    { month: "total", count: 0, cost: 0, sales: 0, profit: 0, rate: null as number | null },
  );
  total.profit = total.sales - total.cost;
  total.rate = total.sales === 0 ? null : total.cost / total.sales;
  return total;
}

// ─── 取得 ────────────────────────────────────────────────────────────────────

/**
 * 案件 + 工程をまとめて取得。
 * officeId=null は「全事業所表示」用で office 絞り込みを行わない (RLS 側で可視範囲に絞られる)。
 */
export async function getRenovationProjects(
  tenantId: string,
  officeId: string | null,
  fiscalYear: number | null,
): Promise<RenovationProjectWithSteps[]> {
  const PAGE = 1000;
  const projects: RenovationProject[] = [];
  let from = 0;
  while (true) {
    let q = supabase
      .from("renovation_projects")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (officeId) q = q.eq("office_id", officeId);
    if (fiscalYear !== null) q = q.eq("fiscal_year", fiscalYear);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    projects.push(...(data as RenovationProject[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  if (projects.length === 0) return [];

  // 工程は project_id の IN で分割取得 (URL 長対策)。
  // 1 案件 = 最大 8 工程なので chunk 200 では 1600 行になり PostgREST の 1000 行上限を超える。
  // chunk 内でも range() で最後まで読み切ること (ここを怠ると工程が黙って欠ける)。
  const stepsByProject = new Map<string, RenovationStep[]>();
  const CHUNK = 100;
  const ids = projects.map((p) => p.id);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const PAGE = 1000;
      const out: RenovationStep[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from("renovation_project_steps")
          .select("*")
          .in("project_id", chunk)
          .order("project_id")
          .order("step_key")
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        out.push(...(data as RenovationStep[]));
        if (data.length < PAGE) break;
        from += PAGE;
      }
      return out;
    }),
  );
  for (const rows of results) {
    for (const s of rows) {
      const list = stepsByProject.get(s.project_id);
      if (list) list.push(s);
      else stepsByProject.set(s.project_id, [s]);
    }
  }

  return projects.map((p) => ({ ...p, steps: stepsByProject.get(p.id) ?? [] }));
}

/** 進行表に出す年度の一覧 (データがある年度 + 今年度) を降順で返す */
export async function getRenovationFiscalYears(tenantId: string, officeId: string | null): Promise<number[]> {
  let q = supabase.from("renovation_projects").select("fiscal_year").eq("tenant_id", tenantId);
  if (officeId) q = q.eq("office_id", officeId);
  const { data, error } = await q;
  if (error) throw error;
  const set = new Set<number>((data ?? []).map((r) => (r as { fiscal_year: number }).fiscal_year));
  set.add(fiscalYearOf(todayYmd()));
  return Array.from(set).sort((a, b) => b - a);
}

// ─── 保存 ────────────────────────────────────────────────────────────────────

/**
 * 案件と工程をまとめて保存する。
 * 工程は (project_id, step_key) の UNIQUE で upsert するため、
 * 呼び出し側は「全 8 工程を毎回渡す」形でよい。
 */
export async function saveRenovationProject(
  tenantId: string,
  officeId: string,
  project: RenovationProjectInput,
  steps: RenovationStepInput[],
): Promise<RenovationProjectWithSteps> {
  const payload = {
    tenant_id: tenantId,
    office_id: officeId,
    fiscal_year: project.fiscal_year,
    client_id: project.client_id,
    client_name: project.client_name.trim(),
    client_address: project.client_address,
    care_office_id: project.care_office_id,
    care_office_text: project.care_office_text,
    care_manager_id: project.care_manager_id,
    care_manager_text: project.care_manager_text,
    staff_member_id: project.staff_member_id,
    staff_name: project.staff_name,
    work_content: project.work_content,
    contractor: project.contractor,
    copay_rate: project.copay_rate,
    notes: project.notes,
    cost_total: project.cost_total,
    sales_total: project.sales_total,
    status: project.status,
  };

  let saved: RenovationProject;
  if (project.id) {
    const { data, error } = await supabase
      .from("renovation_projects")
      .update(payload)
      .eq("id", project.id)
      .select()
      .single();
    if (error) throw error;
    saved = data as RenovationProject;
  } else {
    const { data, error } = await supabase
      .from("renovation_projects")
      .insert(payload)
      .select()
      .single();
    if (error) throw error;
    saved = data as RenovationProject;
  }

  const stepRows = steps.map((s) => ({
    project_id: saved.id,
    step_key: s.step_key,
    planned_date: s.planned_date,
    actual_date: s.actual_date,
    status: s.status,
    note: s.note,
  }));
  const { data: stepData, error: stepError } = await supabase
    .from("renovation_project_steps")
    .upsert(stepRows, { onConflict: "project_id,step_key" })
    .select();
  if (stepError) throw stepError;

  return { ...saved, steps: (stepData ?? []) as RenovationStep[] };
}

/** 進行表マトリクス上での 1 工程だけの更新 (クリックで 未→完了→対象外 を回す用) */
export async function updateRenovationStep(
  projectId: string,
  stepKey: RenovationStepKey,
  patch: Partial<Pick<RenovationStep, "planned_date" | "actual_date" | "status" | "note">>,
): Promise<RenovationStep> {
  const { data, error } = await supabase
    .from("renovation_project_steps")
    .upsert(
      { project_id: projectId, step_key: stepKey, ...patch },
      { onConflict: "project_id,step_key" },
    )
    .select()
    .single();
  if (error) throw error;
  return data as RenovationStep;
}

export async function deleteRenovationProject(id: string): Promise<void> {
  // 工程は ON DELETE CASCADE で一緒に消える
  const { error } = await supabase.from("renovation_projects").delete().eq("id", id);
  if (error) throw error;
}
