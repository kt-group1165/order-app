-- =====================================================
-- 個別援助計画書テンプレートテーブル（種目別目標・留意点）
-- Supabase ダッシュボードの SQL Editor で実行してください
-- =====================================================

CREATE TABLE IF NOT EXISTS care_plan_templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  category TEXT NOT NULL,       -- 用具マスタのcategoryと一致
  goals TEXT NOT NULL DEFAULT '',       -- 福祉用具利用目標
  precautions TEXT NOT NULL DEFAULT '', -- 留意点
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, category)
);

CREATE INDEX IF NOT EXISTS idx_care_plan_templates_tenant
  ON care_plan_templates (tenant_id, category);
