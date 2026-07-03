-- =====================================================================
-- デモ機管理: demo_units / demo_loans (新規)
-- =====================================================================
-- 目的:
--   特定福祉用具販売の対象商品 (シャワーチェア等) をデモ用に貸し出す管理。
--   Excel 運用の置換。台帳 (demo_units) + 貸出履歴 (demo_loans)。
--   returned_date IS NULL の loan = 貸出中。
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

-- ── デモ機台帳 demo_units (新規) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS demo_units (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  office_id UUID,                          -- 事業所 (offices.id)
  unit_no TEXT NOT NULL DEFAULT '',        -- 管理番号 (例 "1-1")
  category TEXT NOT NULL DEFAULT '',       -- シャワーチェア / 浴槽手すり 等
  product_name TEXT NOT NULL DEFAULT '',
  color TEXT,
  storage_location TEXT DEFAULT '事務所',  -- 事務所/利用者宅/消毒庫/社用車
  cleaned BOOLEAN NOT NULL DEFAULT false,  -- 清掃済み
  memo TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true, -- 廃棄等は非表示 (論理削除)
  sort_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE demo_units IS
  'デモ機台帳。特定福祉用具販売対象商品のデモ用貸出管理 (Excel 運用の置換)。is_active=false で非表示 (廃棄等の論理削除)';

CREATE INDEX IF NOT EXISTS idx_demo_units_office
  ON demo_units (tenant_id, office_id, sort_order);

-- ── デモ機貸出履歴 demo_loans (新規) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS demo_loans (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  unit_id UUID NOT NULL,                   -- demo_units.id (FK は張らない)
  client_name TEXT NOT NULL DEFAULT '',    -- 利用者名 (手入力)
  taken_date DATE,                         -- 持出日
  taken_by TEXT,                           -- 持出者
  due_date DATE,                           -- 返却予定日
  returned_date DATE,                      -- 返却日 (NULL = 貸出中)
  returned_by TEXT,                        -- 返却者
  memo TEXT,                               -- 認定待ち 等
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE demo_loans IS
  'デモ機貸出履歴。returned_date IS NULL の行 = 貸出中。unit_id は demo_units.id (FK なし)';

CREATE INDEX IF NOT EXISTS idx_demo_loans_unit
  ON demo_loans (tenant_id, unit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_demo_loans_open
  ON demo_loans (tenant_id, returned_date);

-- ── RLS: order-app の他 tenant-scoped 表 (service_meeting_notes 等) と同パターン ──
-- FOR ALL TO authenticated / tenant_id IN (SELECT auth_visible_tenant_ids())
ALTER TABLE demo_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE demo_loans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS demo_units_authenticated ON demo_units;
CREATE POLICY demo_units_authenticated ON demo_units
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

DROP POLICY IF EXISTS demo_loans_authenticated ON demo_loans;
CREATE POLICY demo_loans_authenticated ON demo_loans
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMIT;

-- =====================================================================
-- 完了。
--
-- 検証クエリ (適用後に確認):
--   -- テーブルと RLS
--   SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('demo_units', 'demo_loans');
--   SELECT tablename, policyname, cmd, roles FROM pg_policies
--   WHERE tablename IN ('demo_units', 'demo_loans');
--   -- index
--   SELECT tablename, indexname FROM pg_indexes
--   WHERE tablename IN ('demo_units', 'demo_loans');
-- =====================================================================
