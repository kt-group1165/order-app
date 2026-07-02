-- =====================================================================
-- サービス担当者会議の要点 (第4表): service_meeting_notes (新規)
-- =====================================================================
-- 目的:
--   居宅の「サービス担当者会議の要点(第4表)」を入力 → プレビュー → 印刷し、
--   保存・一覧・再編集できるようにする。利用者名は移行期間のため手入力
--   (client_name TEXT)。将来の本体連動用に client_id 列だけ NULL 可で確保。
--
-- 適用方法:
--   Supabase ダッシュボードの SQL Editor に「この 1 ファイル全体」を貼り付けて
--   Run すること。全体が BEGIN; ... COMMIT; で 1 トランザクションになっている。
--   ※ BEGIN; だけで COMMIT; を忘れると実行終了時に auto-rollback されるので注意。
--
-- 冪等性: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--   DROP POLICY IF EXISTS → CREATE POLICY。再実行しても壊れない。
-- =====================================================================

BEGIN;

-- ── サービス担当者会議の要点 service_meeting_notes (新規) ──────────────
CREATE TABLE IF NOT EXISTS service_meeting_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id UUID,                    -- 将来の利用者連動用 (現状 NULL)
  client_name TEXT NOT NULL DEFAULT '',
  creator_name TEXT,                 -- 居宅サービス計画作成者氏名(担当者)
  created_date DATE,                 -- 作成年月日
  meeting_date DATE,                 -- 開催日
  meeting_time TEXT,                 -- 時間 (例 "14:00〜15:00")
  meeting_place TEXT,                -- 開催場所 (既定 "自宅")
  attendees JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{affiliation, name}] 最大6
  discussed_items TEXT,              -- 検討した項目
  discussion_content TEXT,           -- 検討内容
  conclusion TEXT,                   -- 結論
  remaining_issues TEXT,             -- 残された課題
  next_meeting TEXT,                 -- 次回の開催時期
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE service_meeting_notes IS
  'サービス担当者会議の要点 (第4表)。利用者名は移行期間のため手入力 (client_name)。client_id は将来の利用者マスタ連動用';

CREATE INDEX IF NOT EXISTS idx_smn_tenant_created
  ON service_meeting_notes (tenant_id, created_at DESC);

-- ── RLS: order-app の他 tenant-scoped 表 (document_templates 等) と同パターン ──
-- FOR ALL TO authenticated / tenant_id IN (SELECT auth_visible_tenant_ids())
ALTER TABLE service_meeting_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_meeting_notes_authenticated ON service_meeting_notes;
CREATE POLICY service_meeting_notes_authenticated ON service_meeting_notes
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMIT;

-- =====================================================================
-- 完了。
--
-- 検証クエリ (適用後に確認):
--   -- テーブルと RLS
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'service_meeting_notes';
--   SELECT policyname, cmd, roles FROM pg_policies
--   WHERE tablename = 'service_meeting_notes';
--   -- index
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'service_meeting_notes';
-- =====================================================================
