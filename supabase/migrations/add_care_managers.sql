-- ケアマネマスタ
CREATE TABLE IF NOT EXISTS care_managers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  care_office_id UUID NOT NULL REFERENCES care_offices(id) ON DELETE CASCADE,
  name TEXT NOT NULL,           -- 氏名
  active BOOLEAN DEFAULT TRUE,  -- 在職フラグ（退職時はfalseに）
  created_at TIMESTAMPTZ DEFAULT NOW()
);
