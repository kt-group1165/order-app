-- =====================================================
-- 利用者書類履歴テーブル作成
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

CREATE TABLE IF NOT EXISTS client_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  type TEXT NOT NULL,        -- 'rental_report' など
  title TEXT NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_documents_lookup
  ON client_documents (tenant_id, client_id, created_at DESC);
