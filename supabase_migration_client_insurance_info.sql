-- 利用者テーブルに介護保険情報フィールドを追加
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS insured_number       TEXT,          -- 被保険者番号
  ADD COLUMN IF NOT EXISTS birth_date           DATE,          -- 生年月日
  ADD COLUMN IF NOT EXISTS certification_start_date DATE,      -- 認定開始日
  ADD COLUMN IF NOT EXISTS insurer_number       TEXT,          -- 保険者番号
  ADD COLUMN IF NOT EXISTS copay_rate           TEXT,          -- 利用者負担割合（1割/2割/3割）
  ADD COLUMN IF NOT EXISTS public_expense       TEXT;          -- 公費負担情報
