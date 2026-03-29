-- =====================================================
-- 納品日カラム追加（order_items）
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS delivered_at DATE;
