-- OpenAI API 使用量・料金を記録するテーブル
-- カナ変換（音声発注時の transcribe / 用具マスタの自動フリガナ生成）で利用
CREATE TABLE IF NOT EXISTS openai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,            -- 'transcribe_kana' | 'manual_kana' | 'bulk_furigana' など
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_jpy NUMERIC(12, 4) NOT NULL DEFAULT 0,
  text_count INTEGER NOT NULL DEFAULT 0, -- 一度に変換した文字列の件数
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_openai_usage_tenant_created
  ON openai_usage(tenant_id, created_at DESC);
