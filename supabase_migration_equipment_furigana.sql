-- 用具マスタにフリガナ列を追加
-- 音声発注時のカナでのマッチング精度向上のため
ALTER TABLE equipment_master
  ADD COLUMN IF NOT EXISTS furigana TEXT;

-- フリガナでの検索を高速化（部分一致用）
CREATE INDEX IF NOT EXISTS idx_equipment_master_furigana
  ON equipment_master (tenant_id, furigana);
