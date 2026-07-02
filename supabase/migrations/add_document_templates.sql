-- =====================================================================
-- 帳票文面テンプレート: document_templates (新規)
-- =====================================================================
-- 目的:
--   重要事項説明書兼契約書などの帳票について、レイアウト (表組み・構成) は
--   コード側で固定のまま、「文章ブロック」だけを tenant 単位で差し替え可能に
--   する。sections JSONB = { section_key: 差し替え後の文面 }。
--   未保存 / 未編集のセクションはコード内の既定文がそのまま使われるため、
--   本テーブルが空でも既存の帳票出力は不変。
--
-- 適用方法:
--   Supabase ダッシュボードの SQL Editor に「この 1 ファイル全体」を貼り付けて
--   Run すること。全体が BEGIN; ... COMMIT; で 1 トランザクションになっている。
--   ※ BEGIN; だけで COMMIT; を忘れると実行終了時に auto-rollback されるので注意。
--
-- 冪等性: CREATE TABLE IF NOT EXISTS / CREATE UNIQUE INDEX IF NOT EXISTS /
--   DROP POLICY IF EXISTS → CREATE POLICY。再実行しても壊れない。
-- =====================================================================

BEGIN;

-- ── 帳票文面テンプレート document_templates (新規) ─────────────────
CREATE TABLE IF NOT EXISTS document_templates (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  doc_type   TEXT NOT NULL,                        -- 'rental_contract' 等
  sections   JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { section_key: text }
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE document_templates IS
  '帳票の文章ブロック差し替えテンプレート (tenant × doc_type)。sections = { section_key: 文面 }。未登録セクションはコード内既定文を使用';

-- tenant × doc_type で 1 行 (upsert onConflict 用)
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_templates
  ON document_templates (tenant_id, doc_type);

-- ── RLS: order-app の他 tenant-scoped 表 (order_item_price_changes 等) と同パターン ──
-- FOR ALL TO authenticated / tenant_id IN (SELECT auth_visible_tenant_ids())
ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS document_templates_authenticated ON document_templates;
CREATE POLICY document_templates_authenticated ON document_templates
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMIT;

-- =====================================================================
-- 完了。
--
-- 検証クエリ (適用後に確認):
--   -- テーブルと RLS
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'document_templates';
--   SELECT policyname, cmd, roles FROM pg_policies
--   WHERE tablename = 'document_templates';
--   -- unique index
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'document_templates';
-- =====================================================================
