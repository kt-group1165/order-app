-- 利用者×事業所の適用紐付け（多対多）
CREATE TABLE IF NOT EXISTS client_office_assignments (
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, client_id, office_id)
);

-- 注文に事業所を紐付け
ALTER TABLE orders ADD COLUMN IF NOT EXISTS office_id UUID REFERENCES offices(id);

-- RLS
ALTER TABLE client_office_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "client_office_assignments_all" ON client_office_assignments;
CREATE POLICY "client_office_assignments_all" ON client_office_assignments FOR ALL USING (true) WITH CHECK (true);
