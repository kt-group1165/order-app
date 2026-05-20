-- 利用請求書 (利用者 × 月の本人請求)
CREATE TABLE IF NOT EXISTS billing_user_invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL, -- "YYYY-MM"
  status TEXT NOT NULL DEFAULT '未確定', -- '未確定' | '確定' | '入金完'
  payment_method TEXT, -- '払込票' | '振込' | '集金' | etc.
  issued_date DATE,
  total_amount INTEGER NOT NULL DEFAULT 0, -- 確定請求額 (税込)
  tax_amount INTEGER NOT NULL DEFAULT 0,
  discount_amount INTEGER NOT NULL DEFAULT 0, -- 軽減額
  medical_deduction_amount INTEGER NOT NULL DEFAULT 0, -- 医療費控除対象額
  overpaid_offset_amount INTEGER NOT NULL DEFAULT 0, -- 過入金充当額
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, client_id, month)
);
CREATE INDEX IF NOT EXISTS idx_billing_user_invoices_tenant_month ON billing_user_invoices(tenant_id, month);

-- 利用請求 明細行 (1 invoice に N 行)
CREATE TABLE IF NOT EXISTS billing_user_invoice_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES billing_user_invoices(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL, -- '福祉用具貸与' | '自費レンタル' | 'その他'
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL DEFAULT 0,
  quantity NUMERIC NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL DEFAULT 0, -- (税抜)
  tax_amount INTEGER NOT NULL DEFAULT 0,
  is_taxable BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_user_invoice_items_invoice ON billing_user_invoice_items(invoice_id);

-- 入金 (1 invoice に 0..N 件)
CREATE TABLE IF NOT EXISTS billing_user_payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_id UUID NOT NULL REFERENCES billing_user_invoices(id) ON DELETE CASCADE,
  paid_at DATE NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT, -- '振込' | '集金' | etc.
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_billing_user_payments_invoice ON billing_user_payments(invoice_id);

-- RLS は他の billing_* table を踏襲。後で別 migration で adjust 可。
