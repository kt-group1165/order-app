-- ============================================================
-- 福祉用具貸与: 明細 × 月 ごとの算定方法 (2026-11-12 user 依頼)
-- ============================================================
-- 既定 = 自動 (半月按分: 前半・後半の両方に貸与日 → 全額 / 片方 → 半額)。行が無い月は自動。
-- 行がある月だけ 日割り = round(月額単位 × 貸与日数 ÷ その月の日数)
--   (ほのぼの福祉用具 提供票の「日割(31日)」の実例と一致: 森 早百合 2026-05)。
-- 使う所: lib/orderItemProration.ts / lib/half-month-units.ts rentalMonthUnits
-- 表が未適用でも画面と請求は壊れない (読めなければ全件 自動 で計算し、画面に未適用と出す)。
-- RLS: fukuyogu_cm_units と同じ tenant_id IN (SELECT auth_visible_tenant_ids())。
-- ⚠ Supabase SQL Editor は COMMIT が無いと終了時に rollback されるので、このまま 1 ブロックで流す。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS order_item_proration (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  -- サービス提供月 "YYYY-MM"
  month         TEXT NOT NULL CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- 今は 日割り だけ (自動 = 行なし)
  mode          TEXT NOT NULL CHECK (mode IN ('daily')),
  created_by    UUID DEFAULT auth.uid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_order_item_proration UNIQUE (order_item_id, month)
);

CREATE INDEX IF NOT EXISTS idx_order_item_proration_month ON order_item_proration (tenant_id, month);

COMMENT ON TABLE order_item_proration IS
  '福祉用具貸与の算定方法 (明細×月)。行があれば その月は日割り、無ければ半月按分の自動。2026-11-12 新設';

ALTER TABLE order_item_proration ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_item_proration_authenticated ON order_item_proration;
CREATE POLICY order_item_proration_authenticated ON order_item_proration
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

CREATE OR REPLACE FUNCTION trg_order_item_proration_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_item_proration_updated_at ON order_item_proration;
CREATE TRIGGER order_item_proration_updated_at
  BEFORE UPDATE ON order_item_proration
  FOR EACH ROW
  EXECUTE FUNCTION trg_order_item_proration_updated_at();

COMMIT;

-- 確認 (適用後に流す):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'order_item_proration'::regclass;
--   SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'order_item_proration';
