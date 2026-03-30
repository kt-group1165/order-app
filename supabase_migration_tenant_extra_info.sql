-- =====================================================
-- テナント重要事項説明書用フィールド追加
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS service_area         TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_days        TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_hours       TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_manager_full   TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_manager_part   TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_specialist_full TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_specialist_part TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_admin_full     TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_admin_part     TEXT;
