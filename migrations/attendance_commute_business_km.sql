-- ============================================================
-- 通勤距離 / 出張距離 の分離 (福祉用具部門・統括営業本部)
-- ============================================================
-- 仕様 (2026-07-29 user 確定):
--   福祉用具事業所 + 統括営業本部の出勤簿では、既存の距離欄は「通勤距離」とする。
--   事務員のみ「通勤距離」と「出張距離」の 2 列を持つ。
--
--   既存 business_km の実体は Excel の「走行距離」= 通勤 (自宅⇔事業所) なので、
--   列名はそのままにして表示だけ「通勤(km)」に変える (データ移行なし)。
--   事務員の出張距離は新設の business_trip_km に入れる。
--
--   事務員の判定は payroll_employees.is_office_worker (スタッフ管理で切替)。
-- ============================================================

BEGIN;

-- 事務員フラグ (true = 出張距離の列も出す)
ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS is_office_worker BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN payroll_employees.is_office_worker IS
  '事務員か。true の職員は出勤簿に 通勤距離 と 出張距離 の 2 列が出る (false は通勤距離のみ)';

-- 出張距離 (事務員のみ使用)
ALTER TABLE payroll_kyotaku_attendance_records
  ADD COLUMN IF NOT EXISTS business_trip_km NUMERIC(6,1);

COMMENT ON COLUMN payroll_kyotaku_attendance_records.business_trip_km IS
  '出張距離 (km)。事務員のみ入力。business_km は通勤距離として扱う';

COMMIT;
