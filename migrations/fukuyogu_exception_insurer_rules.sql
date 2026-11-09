-- ============================================================
-- 福祉用具 軽度者 例外給付 — 市町村 (保険者) ごとのルール (2026-11-09 user 合意)
-- ============================================================
-- 背景:
--   軽度者 (要支援1・2/要介護1) への原則対象外品目の例外給付は、市町村 (保険者) によって
--   「有効期間を区切って届け出る (期限が来たら出し直し)」所と「期間の定めが無い」所がある。
--   fukuyogu_exception_grants.valid_end は NULL (= 期限なし) を許しているので、
--   期間が要る市町村なのに終了日が空、という記録を当方では見分けられなかった。
--   → 保険者番号ごとに「期間が要るか」「標準の期間 (月数)」を持ち、
--     期間が要るのに終了日が空なら警告、開始日 + 期間を終了日の初期値として提案する。
--   当面は user が設定タブ (軽度者例外給付 市町村ルール) から手入力する。
--
-- 使う所: apps/order-app/lib/fukuyoguExceptionRules.ts (判定は純関数。検査 = scripts/fukuyogu-exception-rules-test.mts)
--         設定タブ / 利用者タブ (例外給付タブ・一覧の印) / 請求画面 (利用者行の印)
--   表が未適用でも画面と請求は壊れない (読めなければ「市町村ルール未設定」扱いにして console.error、画面にも出す)。
--
-- insurer_name: 保険者名のマスタは DB に無い (client_insurance_records.insurer_name に行ごとに入っているだけ)。
--   なので番号 + 自由入力の名前で持つ。画面では番号を入れると client_insurance_records から名前を補う。
--
-- RLS: order-app の tenant-scoped 表 (equipment_price_ceilings / fukuyogu_cm_units) と同じ
--   tenant_id IN (SELECT auth_visible_tenant_ids())。auth_visible_tenant_ids は SECURITY DEFINER の helper で、
--   この表を参照し返す policy は無いので循環参照 (CLAUDE.md 3.5) にはならない。
-- ⚠ Supabase SQL Editor は COMMIT が無いと終了時に rollback されるので、このまま 1 ブロックで流す。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fukuyogu_exception_insurer_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  -- 保険者番号 (6桁。例 122069 = 木更津市)。tenant 内で 1 行
  insurer_number  TEXT NOT NULL CHECK (insurer_number ~ '^[0-9]{6}$'),
  insurer_name    TEXT,
  -- true = 例外給付に有効期間を区切る市町村 (終了日が空なら警告)
  requires_period BOOLEAN NOT NULL DEFAULT false,
  -- 標準の期間 (月数)。入っていれば 開始日 + 期間 を終了日の初期値として提案する。NULL = 提案しない
  period_months   INTEGER CHECK (period_months IS NULL OR (period_months BETWEEN 1 AND 120)),
  notes           TEXT,
  created_by      UUID DEFAULT auth.uid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_fukuyogu_exception_insurer_rules UNIQUE (tenant_id, insurer_number)
);

COMMENT ON TABLE fukuyogu_exception_insurer_rules IS
  '福祉用具 軽度者 例外給付の市町村 (保険者) ごとのルール。requires_period=true なら例外給付記録の終了日が必須 (空なら警告)。'
  'period_months は終了日の初期値の提案に使う。設定タブで手入力。2026-11-09 新設';

ALTER TABLE fukuyogu_exception_insurer_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fukuyogu_exception_insurer_rules_authenticated ON fukuyogu_exception_insurer_rules;
CREATE POLICY fukuyogu_exception_insurer_rules_authenticated ON fukuyogu_exception_insurer_rules
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

CREATE OR REPLACE FUNCTION trg_fukuyogu_exception_insurer_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fukuyogu_exception_insurer_rules_updated_at ON fukuyogu_exception_insurer_rules;
CREATE TRIGGER fukuyogu_exception_insurer_rules_updated_at
  BEFORE UPDATE ON fukuyogu_exception_insurer_rules
  FOR EACH ROW
  EXECUTE FUNCTION trg_fukuyogu_exception_insurer_rules_updated_at();

COMMIT;

-- 確認 (適用後に流す):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'fukuyogu_exception_insurer_rules'::regclass;
--   SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'fukuyogu_exception_insurer_rules';
