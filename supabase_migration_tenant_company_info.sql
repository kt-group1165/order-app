-- =====================================================
-- テナント会社情報カラム追加
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_number TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_name     TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_address  TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_tel      TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_fax      TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS staff_name       TEXT;
