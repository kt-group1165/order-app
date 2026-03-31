-- モニタリング記録
CREATE TABLE IF NOT EXISTS monitoring_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  visit_date DATE,
  target_month TEXT,
  report_date DATE,
  staff_name TEXT,
  continuity_comment TEXT,
  report_comment TEXT,
  previous_comment TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- モニタリング用具チェック
CREATE TABLE IF NOT EXISTS monitoring_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitoring_id UUID NOT NULL REFERENCES monitoring_records(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  order_item_id TEXT,
  product_code TEXT NOT NULL,
  equipment_name TEXT,
  category TEXT,
  quantity INTEGER DEFAULT 1,
  no_issue BOOLEAN DEFAULT true,
  has_malfunction BOOLEAN DEFAULT false,
  has_deterioration BOOLEAN DEFAULT false,
  needs_replacement BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
