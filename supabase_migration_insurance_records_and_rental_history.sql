-- ============================================================
-- 保険情報の複数レコード管理テーブル
-- ============================================================
CREATE TABLE IF NOT EXISTS client_insurance_records (
  id                       UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id                TEXT         NOT NULL,
  client_id                UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  effective_date           DATE,                          -- 有効期間開始日
  insured_number           TEXT,                          -- 被保険者番号
  birth_date               DATE,                          -- 生年月日
  care_level               TEXT,                          -- 要介護度
  certification_start_date DATE,                          -- 認定開始日
  certification_end_date   DATE,                          -- 認定終了日
  insurer_number           TEXT,                          -- 保険者番号
  copay_rate               TEXT,                          -- 利用者負担割合（1割/2割/3割）
  public_expense           TEXT,                          -- 公費負担情報
  notes                    TEXT,                          -- メモ
  created_at               TIMESTAMPTZ  DEFAULT NOW()
);

-- ============================================================
-- レンタル履歴テーブル（手動登録分）
-- ============================================================
CREATE TABLE IF NOT EXISTS client_rental_history (
  id             UUID         DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      TEXT         NOT NULL,
  client_id      UUID         NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  equipment_name TEXT         NOT NULL,                   -- 用具名
  model_number   TEXT,                                    -- 型番
  start_date     DATE,                                    -- 開始日
  end_date       DATE,                                    -- 終了日
  monthly_price  INTEGER,                                 -- 月額
  notes          TEXT,                                    -- メモ
  source         TEXT         NOT NULL DEFAULT 'manual',  -- 'manual'
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- ============================================================
-- 利用者テーブルの保険情報個別カラムを削除（新テーブルへ移行）
-- ============================================================
ALTER TABLE clients
  DROP COLUMN IF EXISTS insured_number,
  DROP COLUMN IF EXISTS birth_date,
  DROP COLUMN IF EXISTS certification_start_date,
  DROP COLUMN IF EXISTS insurer_number,
  DROP COLUMN IF EXISTS copay_rate,
  DROP COLUMN IF EXISTS public_expense;
