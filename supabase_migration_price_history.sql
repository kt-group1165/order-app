-- =====================================================
-- 価格改定履歴テーブル作成
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

CREATE TABLE IF NOT EXISTS equipment_price_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_code TEXT NOT NULL,
  rental_price INTEGER NOT NULL,
  valid_from DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_price_history_lookup
  ON equipment_price_history (tenant_id, product_code, valid_from DESC);

-- 既存の rental_price を 2020-01-01 から有効として初期登録
INSERT INTO equipment_price_history (tenant_id, product_code, rental_price, valid_from)
SELECT tenant_id, product_code, rental_price::INTEGER, '2020-01-01'::DATE
FROM equipment_master
WHERE rental_price IS NOT NULL;
