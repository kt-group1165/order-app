-- 卸会社(suppliers)に論理非表示フラグ is_active を追加。
-- 削除はしない(過去の発注が supplier_id を参照するため DB には残す)。
-- is_active=false = UI の選択肢/列/卸別価格入力 から外す(= 非表示)。
-- Supabase SQL Editor にこのまま貼って Run。
BEGIN;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
COMMIT;
