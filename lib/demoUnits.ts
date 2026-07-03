import { supabase } from "./supabase";

// デモ機管理 — demo_units (台帳) + demo_loans (貸出履歴)
// 特定福祉用具販売の対象商品 (シャワーチェア等) をデモ用に貸し出す管理。
// returned_date IS NULL の loan = 貸出中。利用者名は手入力 (client_name)。

export type DemoUnit = {
  id: string;
  tenant_id: string;
  office_id: string | null;         // 事業所 (offices.id)
  unit_no: string;                  // 管理番号 (例 "1-1")
  category: string;                 // シャワーチェア / 浴槽手すり 等
  product_name: string;
  color: string | null;
  storage_location: string | null;  // 事務所/利用者宅/消毒庫/社用車
  cleaned: boolean;                 // 清掃済み
  memo: string | null;
  is_active: boolean;               // 廃棄等は非表示 (論理削除)
  sort_order: number | null;
  created_at?: string;
  updated_at?: string;
};

export type DemoLoan = {
  id: string;
  tenant_id: string;
  unit_id: string;                  // demo_units.id
  client_name: string;              // 利用者名 (手入力)
  taken_date: string | null;        // 持出日
  taken_by: string | null;          // 持出者
  due_date: string | null;          // 返却予定日
  returned_date: string | null;     // 返却日 (NULL = 貸出中)
  returned_by: string | null;       // 返却者
  memo: string | null;              // 認定待ち 等
  created_at?: string;
};

// 操作ログ (demo_logs) — append-only・UI非表示の監査用。
// 本操作の成功後に記録するため、ログ失敗で操作自体は失敗させない (console.error のみ)。
async function logDemoAction(
  tenantId: string,
  action: "checkout" | "return" | "unit_create" | "unit_update" | "unit_discard" | "unit_restore",
  opts: { unitId?: string | null; loanId?: string | null; detail?: Record<string, unknown>; actor?: string | null }
): Promise<void> {
  const { error } = await supabase.from("demo_logs").insert({
    tenant_id: tenantId,
    unit_id: opts.unitId ?? null,
    loan_id: opts.loanId ?? null,
    action,
    detail: opts.detail ?? null,
    actor: opts.actor ?? null,
    source: "app",
  });
  if (error) console.error("demo_logs insert failed:", error.message);
}

// 台帳一覧 (既定 is_active=true のみ。includeInactive=true で廃棄済みも返す)。officeId 指定時はその事業所分だけ
export async function listDemoUnits(tenantId: string, officeId?: string, includeInactive?: boolean): Promise<DemoUnit[]> {
  let q = supabase
    .from("demo_units")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("unit_no", { ascending: true });
  if (!includeInactive) q = q.eq("is_active", true);
  if (officeId) q = q.eq("office_id", officeId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as DemoUnit[];
}

// 貸出中 loan 一覧 (returned_date IS NULL)。
// office 絞りは loan 側では出来ないため全件を返し、呼び出し側で unit と突合する
export async function listOpenLoans(tenantId: string): Promise<DemoLoan[]> {
  const { data, error } = await supabase
    .from("demo_loans")
    .select("*")
    .eq("tenant_id", tenantId)
    .is("returned_date", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DemoLoan[];
}

// 1 台分の貸出履歴 (新しい順)
export async function listLoansForUnit(tenantId: string, unitId: string): Promise<DemoLoan[]> {
  const { data, error } = await supabase
    .from("demo_loans")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("unit_id", unitId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DemoLoan[];
}

export async function createDemoUnit(
  unit: Omit<DemoUnit, "id" | "created_at" | "updated_at">
): Promise<DemoUnit> {
  const { data, error } = await supabase
    .from("demo_units")
    .insert(unit)
    .select()
    .single();
  if (error) throw error;
  await logDemoAction(unit.tenant_id, "unit_create", { unitId: (data as DemoUnit).id, detail: unit as unknown as Record<string, unknown> });
  return data as DemoUnit;
}

export async function updateDemoUnit(
  id: string,
  patch: Partial<Omit<DemoUnit, "id" | "tenant_id" | "created_at">>
): Promise<DemoUnit> {
  const { data, error } = await supabase
    .from("demo_units")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  const updated = data as DemoUnit;
  const action = patch.is_active === false ? "unit_discard" : patch.is_active === true ? "unit_restore" : "unit_update";
  await logDemoAction(updated.tenant_id, action, { unitId: id, detail: patch as Record<string, unknown> });
  return updated;
}

// 持出: loan insert + unit を「利用者宅・未清掃」に更新
export async function checkoutUnit(params: {
  tenantId: string;
  unitId: string;
  clientName: string;
  takenDate: string;
  takenBy?: string | null;
  dueDate?: string | null;
  memo?: string | null;
}): Promise<void> {
  const { data: loanRow, error: loanError } = await supabase.from("demo_loans").insert({
    tenant_id: params.tenantId,
    unit_id: params.unitId,
    client_name: params.clientName,
    taken_date: params.takenDate,
    taken_by: params.takenBy || null,
    due_date: params.dueDate || null,
    memo: params.memo || null,
  }).select("id").single();
  if (loanError) throw loanError;
  const { error: unitError } = await supabase
    .from("demo_units")
    .update({ storage_location: "利用者宅", cleaned: false, updated_at: new Date().toISOString() })
    .eq("id", params.unitId);
  if (unitError) throw unitError;
  await logDemoAction(params.tenantId, "checkout", {
    unitId: params.unitId,
    loanId: loanRow?.id ?? null,
    actor: params.takenBy ?? null,
    detail: { clientName: params.clientName, takenDate: params.takenDate, dueDate: params.dueDate ?? null, memo: params.memo ?? null },
  });
}

// 返却: loan に返却日/返却者を記録 + unit の保管場所・清掃状態を更新
export async function returnUnit(params: {
  tenantId: string;
  loanId: string;
  unitId: string;
  returnedDate: string;
  returnedBy?: string | null;
  storageLocation: string;
  cleaned: boolean;
}): Promise<void> {
  const { error: loanError } = await supabase
    .from("demo_loans")
    .update({
      returned_date: params.returnedDate,
      returned_by: params.returnedBy || null,
    })
    .eq("id", params.loanId);
  if (loanError) throw loanError;
  const { error: unitError } = await supabase
    .from("demo_units")
    .update({
      storage_location: params.storageLocation,
      cleaned: params.cleaned,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.unitId);
  if (unitError) throw unitError;
  await logDemoAction(params.tenantId, "return", {
    unitId: params.unitId,
    loanId: params.loanId,
    actor: params.returnedBy ?? null,
    detail: { returnedDate: params.returnedDate, storageLocation: params.storageLocation, cleaned: params.cleaned },
  });
}
