-- migrations/order_app_equipment_price_ceilings.sql
-- Phase: 福祉用具 上限価格・平均価格マスタ (厚労省公表データ取込) (user 確定 2026-07-08)
--
-- 背景:
--   厚労省が定期的に公表する「福祉用具の全国平均貸与価格及び貸与価格の上限一覧」を
--   取り込んで保持する。上限価格は TAIS コード (商品コード) ごとに 1 つ決まる。
--   公表 Excel の A1/A2 に適用月 (例: 令和8年7月) が書かれているので、適用開始月
--   (effective_from = 適用月の初日) を持たせて世代管理する。
--   商品名は TAIS 単位では本来不要だが、後で用具マスタ連携に使えるよう法人名・型番と共に保持。
--
-- 用途:
--   現時点では「上限・平均価格の管理」専用 (用具マスタ画面の新サブタブ)。
--   equipment_master への自動反映は後日 (今回は入れない)。
--
-- 適用方法:
--   Supabase SQL Editor で 1 ファイルとして実行 (BEGIN/COMMIT 入り)。

BEGIN;

CREATE TABLE IF NOT EXISTS equipment_price_ceilings (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL DEFAULT 'kt-group',
  tais_code      TEXT NOT NULL,             -- 商品コード (TAIS) 例: 00030-000243
  effective_from DATE NOT NULL,             -- 適用開始月の初日 例: 2026-07-01
  ceiling_price  INTEGER NOT NULL,          -- 貸与価格の上限（円）
  average_price  INTEGER,                   -- 全国平均貸与価格（円）
  corp_name      TEXT,                      -- 法人名 (後で使う用に保持)
  product_name   TEXT,                      -- 商品名 (TAIS単位では本来不要だが保持)
  model_number   TEXT,                      -- 型番 (後で使う用に保持)
  publication_label TEXT,                   -- 公表回/月ラベル 例: 29 回目公表 / 令和8年7月
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 同一 TAIS × 適用月 は 1 行 (再取込は上書き)
  UNIQUE (tenant_id, tais_code, effective_from)
);

-- 適用月降順一覧 / 月別サマリ用
CREATE INDEX IF NOT EXISTS idx_eq_price_ceilings_month
  ON equipment_price_ceilings (tenant_id, effective_from DESC);
-- TAIS 逆引き (用具マスタ連携時)
CREATE INDEX IF NOT EXISTS idx_eq_price_ceilings_tais
  ON equipment_price_ceilings (tenant_id, tais_code);

-- RLS: order-app の他 tenant-scoped 表 (equipment_master 等) と同じパターン
ALTER TABLE equipment_price_ceilings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS equipment_price_ceilings_authenticated ON equipment_price_ceilings;
CREATE POLICY equipment_price_ceilings_authenticated ON equipment_price_ceilings
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMIT;
