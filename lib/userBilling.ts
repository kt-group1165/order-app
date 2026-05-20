import { supabase } from "./supabase";

// ── 型定義 ────────────────────────────────────────────────────────────────

export type BillingUserInvoiceStatus = "未確定" | "確定" | "入金完";

export type BillingUserInvoice = {
  id: string;
  tenant_id: string;
  client_id: string;
  month: string; // "YYYY-MM"
  status: BillingUserInvoiceStatus;
  payment_method: string | null;
  issued_date: string | null; // "YYYY-MM-DD"
  total_amount: number;
  tax_amount: number;
  discount_amount: number;
  medical_deduction_amount: number;
  overpaid_offset_amount: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type BillingUserInvoiceItemKind = "福祉用具貸与" | "自費レンタル" | "その他";

export type BillingUserInvoiceItem = {
  id: string;
  invoice_id: string;
  item_kind: BillingUserInvoiceItemKind;
  name: string;
  unit_price: number;
  quantity: number;
  amount: number; // 税抜
  tax_amount: number;
  is_taxable: boolean;
  notes: string | null;
  created_at: string;
};

export type BillingUserPayment = {
  id: string;
  invoice_id: string;
  paid_at: string; // "YYYY-MM-DD"
  amount: number;
  method: string | null;
  notes: string | null;
  created_at: string;
};

// ── ページング ────────────────────────────────────────────────────────────
// PostgREST default limit 1000 回避用 (memory: project_pagination_audit_remaining)

const PAGE = 1000;

async function pagedSelect<T>(
  builder: (from: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await builder(from);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── 利用請求書 (invoices) ────────────────────────────────────────────────

export async function getUserInvoices(
  tenantId: string,
  month: string,
  opts?: { clientIds?: string[] }
): Promise<BillingUserInvoice[]> {
  return pagedSelect<BillingUserInvoice>((from) => {
    let q = supabase
      .from("billing_user_invoices")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("month", month);
    if (opts?.clientIds && opts.clientIds.length > 0) {
      q = q.in("client_id", opts.clientIds);
    }
    return q.range(from, from + PAGE - 1);
  });
}

export async function getUserInvoice(
  tenantId: string,
  clientId: string,
  month: string
): Promise<BillingUserInvoice | null> {
  const { data, error } = await supabase
    .from("billing_user_invoices")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("client_id", clientId)
    .eq("month", month)
    .maybeSingle();
  if (error) throw error;
  return (data as BillingUserInvoice | null) ?? null;
}

export type UpsertUserInvoicePatch = {
  tenant_id: string;
  client_id: string;
  month: string;
  status?: BillingUserInvoiceStatus;
  payment_method?: string | null;
  issued_date?: string | null;
  total_amount?: number;
  tax_amount?: number;
  discount_amount?: number;
  medical_deduction_amount?: number;
  overpaid_offset_amount?: number;
  notes?: string | null;
};

export async function upsertUserInvoice(patch: UpsertUserInvoicePatch): Promise<BillingUserInvoice> {
  const { data, error } = await supabase
    .from("billing_user_invoices")
    .upsert(
      { ...patch, updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,client_id,month" }
    )
    .select("*")
    .single();
  if (error) throw error;
  return data as BillingUserInvoice;
}

export async function updateUserInvoiceStatus(
  invoiceId: string,
  status: BillingUserInvoiceStatus
): Promise<void> {
  const { error } = await supabase
    .from("billing_user_invoices")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", invoiceId);
  if (error) throw error;
}

export async function deleteUserInvoice(invoiceId: string): Promise<void> {
  const { error } = await supabase.from("billing_user_invoices").delete().eq("id", invoiceId);
  if (error) throw error;
}

// ── 利用請求 明細行 (items) ──────────────────────────────────────────────

export async function getUserInvoiceItems(invoiceId: string): Promise<BillingUserInvoiceItem[]> {
  return pagedSelect<BillingUserInvoiceItem>((from) =>
    supabase
      .from("billing_user_invoice_items")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1)
  );
}

export type UserInvoiceItemInput = {
  item_kind: BillingUserInvoiceItemKind;
  name: string;
  unit_price: number;
  quantity: number;
  amount: number;
  tax_amount: number;
  is_taxable: boolean;
  notes?: string | null;
};

// delete + bulk insert
export async function setUserInvoiceItems(
  invoiceId: string,
  items: UserInvoiceItemInput[]
): Promise<void> {
  const { error: delError } = await supabase
    .from("billing_user_invoice_items")
    .delete()
    .eq("invoice_id", invoiceId);
  if (delError) throw delError;
  if (items.length === 0) return;
  const rows = items.map((it) => ({ invoice_id: invoiceId, ...it }));
  const { error: insError } = await supabase.from("billing_user_invoice_items").insert(rows);
  if (insError) throw insError;
}

// ── 入金 (payments) ──────────────────────────────────────────────────────

export async function getUserPayments(invoiceId: string): Promise<BillingUserPayment[]> {
  return pagedSelect<BillingUserPayment>((from) =>
    supabase
      .from("billing_user_payments")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("paid_at", { ascending: true })
      .range(from, from + PAGE - 1)
  );
}

export async function getUserPaymentsByInvoiceIds(
  invoiceIds: string[]
): Promise<BillingUserPayment[]> {
  if (invoiceIds.length === 0) return [];
  return pagedSelect<BillingUserPayment>((from) =>
    supabase
      .from("billing_user_payments")
      .select("*")
      .in("invoice_id", invoiceIds)
      .range(from, from + PAGE - 1)
  );
}

export async function addUserPayment(
  invoiceId: string,
  paidAt: string,
  amount: number,
  method?: string | null,
  notes?: string | null
): Promise<BillingUserPayment> {
  const { data, error } = await supabase
    .from("billing_user_payments")
    .insert({ invoice_id: invoiceId, paid_at: paidAt, amount, method: method ?? null, notes: notes ?? null })
    .select("*")
    .single();
  if (error) throw error;
  return data as BillingUserPayment;
}

export async function deleteUserPayment(paymentId: string): Promise<void> {
  const { error } = await supabase.from("billing_user_payments").delete().eq("id", paymentId);
  if (error) throw error;
}
