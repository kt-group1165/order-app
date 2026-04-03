-- 入退院管理テーブル
CREATE TABLE IF NOT EXISTS client_hospitalizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  admission_date DATE NOT NULL,   -- 入院日
  discharge_date DATE,            -- 退院日（NULL = 現在入院中）
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_hosp_tenant ON client_hospitalizations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_client_hosp_client ON client_hospitalizations(client_id);
CREATE INDEX IF NOT EXISTS idx_client_hosp_dates ON client_hospitalizations(admission_date, discharge_date);
