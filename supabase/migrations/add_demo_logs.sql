-- =====================================================================
-- デモ機 操作ログ: demo_logs (新規)
-- =====================================================================
--   持出/返却/台帳追加/編集/廃棄/復活 の全操作を append-only で記録する。
--   UI では表示しない (監査・調査用に DB にのみ保持)。
--   detail JSONB に入力値や変更前後の snapshot を残す。
-- 適用: Supabase SQL Editor に全体貼付で Run (BEGIN...COMMIT / 冪等)
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS demo_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  unit_id UUID,                 -- 対象デモ機 (demo_units.id)
  loan_id UUID,                 -- 関連貸出 (demo_loans.id、あれば)
  action TEXT NOT NULL,         -- checkout / return / unit_create / unit_update / unit_discard / unit_restore
  detail JSONB,                 -- 入力値・変更前後の snapshot
  actor TEXT,                   -- 操作者 (持出者/返却者/ログインユーザー等)
  source TEXT,                  -- 'app' (本体) / 'mobile' (スマホ)
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE demo_logs IS
  'デモ機の操作ログ (append-only・UI非表示)。持出/返却/台帳変更の監査用';

CREATE INDEX IF NOT EXISTS idx_demo_logs_unit
  ON demo_logs (tenant_id, unit_id, created_at DESC);

ALTER TABLE demo_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS demo_logs_authenticated ON demo_logs;
CREATE POLICY demo_logs_authenticated ON demo_logs
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMIT;

-- 検証:
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'demo_logs';
--   SELECT policyname FROM pg_policies WHERE tablename = 'demo_logs';
