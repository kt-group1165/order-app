-- client_insurance_records に不足カラムを追加
ALTER TABLE client_insurance_records
  ADD COLUMN IF NOT EXISTS care_manager TEXT,
  ADD COLUMN IF NOT EXISTS care_manager_org TEXT,
  ADD COLUMN IF NOT EXISTS insurer_name TEXT;
