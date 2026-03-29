-- =====================================================
-- 用具マスタ 並び順カラム追加
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

ALTER TABLE equipment_master ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- 既存データに sort_order を振る（created_at 順で連番）
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY tenant_id ORDER BY created_at) * 10 AS rn
  FROM equipment_master
)
UPDATE equipment_master
SET sort_order = ordered.rn
FROM ordered
WHERE equipment_master.id = ordered.id AND equipment_master.sort_order IS NULL;

-- インデックス追加（並び順クエリの高速化）
CREATE INDEX IF NOT EXISTS idx_equipment_master_sort_order ON equipment_master(tenant_id, sort_order);
