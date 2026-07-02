-- =====================================================================
-- 担当者会議録に事業所を追加 (スマホ入力の事業所別 URL 対応)
-- =====================================================================
--   service_meeting_notes.office_id    : offices.id (本体との将来連結キー)
--   service_meeting_notes.office_label : 表示用の事業所名スナップショット
-- 適用: Supabase SQL Editor に全体を貼って Run (BEGIN...COMMIT / 冪等)
-- =====================================================================

BEGIN;

ALTER TABLE service_meeting_notes
  ADD COLUMN IF NOT EXISTS office_id UUID;
ALTER TABLE service_meeting_notes
  ADD COLUMN IF NOT EXISTS office_label TEXT;

CREATE INDEX IF NOT EXISTS idx_smn_tenant_office
  ON service_meeting_notes (tenant_id, office_id, created_at DESC);

COMMIT;

-- 検証:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'service_meeting_notes'
--     AND column_name IN ('office_id','office_label');
