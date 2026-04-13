-- 月遅れフラグ（利用者×月）
CREATE TABLE IF NOT EXISTS billing_late_flags (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL, -- "YYYY-MM"
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, client_id, month)
);

-- 単位数上書き（利用者×月×用具）
CREATE TABLE IF NOT EXISTS billing_unit_overrides (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  units_override INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, client_id, month, order_item_id)
);

-- 返戻・取り下げフラグ（利用者×月）
CREATE TABLE IF NOT EXISTS billing_rebill_flags (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL,
  flag_type VARCHAR(10) NOT NULL, -- "返戻" | "取り下げ"
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, client_id, month)
);
