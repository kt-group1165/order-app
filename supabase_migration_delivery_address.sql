-- =====================================================
-- 発注テーブルに納品先住所カラム追加
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
