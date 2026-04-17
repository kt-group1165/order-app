-- Phase 1: 事業所にサービス種別、利用者×事業所に開始/終了日
-- 1. offices.service_type: 福祉用具 / 居宅介護支援 / 訪問介護 / 本社 / その他
ALTER TABLE offices ADD COLUMN IF NOT EXISTS service_type VARCHAR(20);

-- 2. client_office_assignments に開始/終了日
ALTER TABLE client_office_assignments ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE client_office_assignments ADD COLUMN IF NOT EXISTS end_date DATE;

-- 現役判定用インデックス
CREATE INDEX IF NOT EXISTS idx_coa_end_date ON client_office_assignments(tenant_id, office_id, end_date);
