-- ============================================================
-- 福祉用具 CM 指示単位数 (2026-11-09 user 合意)
-- ============================================================
-- 背景:
--   ケアマネ (CM) が給付管理で割り付けた単位数 (= 給付管理票の計画単位数) が 当方の実績より少ないことがある。
--   ほのぼのは CM の単位数で頭打ちにし、超えた分を保険外 (全額自己負担) にしている
--   (ケアサポ KK261004 = 提供 2026-09 で 6 名。正木清 / 髙畠孝祐 / 石原照子 / 露﨑均 / 中村弘子 / 石原昌代)。
--   国保連の審査は「明細書の合計請求単位数 ≤ 給付管理票の計画単位数」で、超えると査定される (_if_svc.txt)。
--   計画単位数のマスタは作らない (user 判断)。請求画面で 利用者ごと・月ごとに「CM から言われた単位数」を入れる。
--   行が無い = 入力なし = 従来どおり実績で請求。
--
-- 使う所: apps/order-app/lib/fukuyoguCmUnits.ts (請求画面 BillingTab) /
--         scripts/fukuyogu-densou-honobono-diff.mts / migrations/seed_fukuyogu_cm_units_202609.mjs
--   計算は lib/kokuho-densou/fukuyogu-amounts.ts (computeFukuyoguAmounts の cmUnits)。
--   表が未適用でも画面と伝送は壊れない (読めなければ全員 実績で請求し、画面に未適用と出す)。
--
-- RLS: order-app の tenant-scoped 表 (equipment_price_ceilings 等) と同じ
--   tenant_id IN (SELECT auth_visible_tenant_ids())。auth_visible_tenant_ids は SECURITY DEFINER の helper で、
--   この表を参照し返す policy は無いので循環参照 (CLAUDE.md 3.5) にはならない。
-- ⚠ Supabase SQL Editor は COMMIT が無いと終了時に rollback されるので、このまま 1 ブロックで流す。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fukuyogu_cm_units (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  office_id     UUID NOT NULL REFERENCES offices(id),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- サービス提供月 "YYYY-MM" (billing_unit_overrides.month と同じ書式)
  service_month TEXT NOT NULL CHECK (service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  -- CM 指示単位数。0 も可 (CM が 0 単位と言った = 全額保険外)。集計 10 項9 は数字6
  units         INTEGER NOT NULL CHECK (units >= 0 AND units <= 999999),
  note          TEXT,
  created_by    UUID DEFAULT auth.uid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_fukuyogu_cm_units UNIQUE (tenant_id, office_id, client_id, service_month)
);

CREATE INDEX IF NOT EXISTS idx_fukuyogu_cm_units_month
  ON fukuyogu_cm_units (tenant_id, service_month);

COMMENT ON TABLE fukuyogu_cm_units IS
  '福祉用具 CM 指示単位数 (給付管理票の計画単位数)。行があれば その単位数までを保険請求し 超過は保険外 (全額自己負担)。'
  '行が無ければ実績で請求。請求画面で入力。2026-11-09 新設';

ALTER TABLE fukuyogu_cm_units ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fukuyogu_cm_units_authenticated ON fukuyogu_cm_units;
CREATE POLICY fukuyogu_cm_units_authenticated ON fukuyogu_cm_units
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

CREATE OR REPLACE FUNCTION trg_fukuyogu_cm_units_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fukuyogu_cm_units_updated_at ON fukuyogu_cm_units;
CREATE TRIGGER fukuyogu_cm_units_updated_at
  BEFORE UPDATE ON fukuyogu_cm_units
  FOR EACH ROW
  EXECUTE FUNCTION trg_fukuyogu_cm_units_updated_at();

COMMIT;

-- 確認 (適用後に流す):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'fukuyogu_cm_units'::regclass;
--   SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'fukuyogu_cm_units';
