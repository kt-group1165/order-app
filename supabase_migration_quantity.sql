-- =====================================================
-- 発注明細に個数カラム追加
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;
