-- ============================================================
-- 福祉用具 月途中の公費 (生保) の扱い + 公費の本人支払額 (2026-11-09 user 要件)
-- ============================================================
-- (1) fukuyogu_kohi_month_mode
--   月の途中で生活保護 (公費 法別12) が始まる/終わる利用者の、その月の福祉用具貸与 (月額) を
--   どう請求するかは ケアマネの方針で 3 通りある。利用者ごと・月ごとに請求画面で選ぶ:
--     none  = その月は全部 利用者負担 (公費を付けない)
--     daily = 公費の期間だけ公費 (日割り。貸与日数のうち公費の日数の割合)
--     half  = 半月 利用者負担・半月 公費 (福祉用具の半月按分と同じ考え方)
--   行が無い = 未選択 = 既定の扱い (lib/kokuho-densou/fukuyogu-amounts.ts の KOHI_MONTH_MODE_DEFAULT)。
--   公費が月の全期間 (= 貸与の全期間) を覆う利用者には関係しない (選んでも使わない)。
--   実例: 飯村 昭 (被保番 1001328079) 生保 2026-09-28 開始。ほのぼのは 9 月分を公費なしで請求済み。
--
-- (2) client_public_expenses.self_pay_amount
--   生保の介護券に書かれた「本人支払額」(月額・円)。公費対象の利用者負担のうち この額までは本人が払い、
--   残りを公費に請求する (kaigo-app の client_kohi_records.honnin_futan と同じ扱い)。
--   伝送では 7131/7132-01 項41・10 項20 (公費1本人負担額) に出し、項35/17 (保険分の利用者負担) には含めない。
--   実例: 中島 紀久子 (1000063779) 月 1,200 円。ほのぼの KK261004: 公費請求 0 / 公費本人負担 1,200。
--   ほのぼの 公費 CSV の「本人支払額」列 (index 36) から取り込む (migrations/sync_fukuyogu_from_honobono.mjs)。
--   NULL = 未登録 = 0 円扱い (従来どおり公費対象の利用者負担を全額公費に請求)。
--
-- 使う所: lib/fukuyoguKohiMonth.ts (請求画面 BillingTab) / ClientsTab の公費入力欄 /
--         migrations/seed_kohi_self_pay_202609.mjs / migrations/sync_fukuyogu_from_honobono.mjs
--   表・列が未適用でも画面と伝送は壊れない (読めなければ 未選択・本人支払額 0 として扱い、画面に理由を出す)。
--
-- RLS: fukuyogu_cm_units と同じ tenant_id IN (SELECT auth_visible_tenant_ids())。
--   auth_visible_tenant_ids は SECURITY DEFINER の helper で、この表を参照し返す policy は無いので循環参照にならない。
-- ⚠ Supabase SQL Editor は COMMIT が無いと終了時に rollback されるので、このまま 1 ブロックで流す。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fukuyogu_kohi_month_mode (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  office_id     UUID NOT NULL REFERENCES offices(id),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- サービス提供月 "YYYY-MM" (fukuyogu_cm_units.service_month と同じ書式)
  service_month TEXT NOT NULL CHECK (service_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  mode          TEXT NOT NULL CHECK (mode IN ('none', 'daily', 'half')),
  note          TEXT,
  created_by    UUID DEFAULT auth.uid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_fukuyogu_kohi_month_mode UNIQUE (tenant_id, office_id, client_id, service_month)
);

CREATE INDEX IF NOT EXISTS idx_fukuyogu_kohi_month_mode_month
  ON fukuyogu_kohi_month_mode (tenant_id, service_month);

COMMENT ON TABLE fukuyogu_kohi_month_mode IS
  '福祉用具 月途中に公費 (生保) が始まる/終わる月の扱い (none=全部利用者負担 / daily=日割り / half=半月)。'
  'ケアマネの方針で利用者ごと・月ごとに請求画面で選ぶ。行が無ければ既定。2026-11-09 新設';

ALTER TABLE fukuyogu_kohi_month_mode ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fukuyogu_kohi_month_mode_authenticated ON fukuyogu_kohi_month_mode;
CREATE POLICY fukuyogu_kohi_month_mode_authenticated ON fukuyogu_kohi_month_mode
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

CREATE OR REPLACE FUNCTION trg_fukuyogu_kohi_month_mode_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fukuyogu_kohi_month_mode_updated_at ON fukuyogu_kohi_month_mode;
CREATE TRIGGER fukuyogu_kohi_month_mode_updated_at
  BEFORE UPDATE ON fukuyogu_kohi_month_mode
  FOR EACH ROW
  EXECUTE FUNCTION trg_fukuyogu_kohi_month_mode_updated_at();

-- (2) 公費の本人支払額 (月額・円)。集計 10 項20 は数字6
ALTER TABLE client_public_expenses
  ADD COLUMN IF NOT EXISTS self_pay_amount INTEGER;
ALTER TABLE client_public_expenses
  DROP CONSTRAINT IF EXISTS client_public_expenses_self_pay_amount_check;
ALTER TABLE client_public_expenses
  ADD CONSTRAINT client_public_expenses_self_pay_amount_check
  CHECK (self_pay_amount IS NULL OR (self_pay_amount >= 0 AND self_pay_amount <= 999999));
COMMENT ON COLUMN client_public_expenses.self_pay_amount IS
  '本人支払額 (介護券・受給者証の月額・円)。公費対象の利用者負担のうちこの額までを本人負担、残りを公費請求。NULL=0円扱い。2026-11-09 追加';

COMMIT;

-- 確認 (適用後に流す):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'fukuyogu_kohi_month_mode'::regclass;
--   SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'fukuyogu_kohi_month_mode';
--   SELECT column_name, data_type FROM information_schema.columns
--     WHERE table_name = 'client_public_expenses' AND column_name = 'self_pay_amount';
