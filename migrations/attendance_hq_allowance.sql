-- ============================================================
-- 出勤簿: 電話当番・土日祝対応 (統括営業本部のみ)
-- ============================================================
-- 仕様 (2026-07-29 user 確定、Excel 出勤簿の踏襲):
--   電話当番     = 1回 3,000 円
--   土日祝対応   = 件数入力。1件 6,000 円 / 2件以上 10,000 円
--   併給しない   = 両方該当の日は土日祝対応のみ支給 (額は日次で決まる)
--
-- 金額はコード側の定数 (apps/order-app/lib/attendance/allowance.ts)。
-- 列は共有 table に足すが、入力 UI は 統括営業本部 (office_type='本社') のみに出す。
-- 他事業所の row は default (false / 0) のままで無影響。
-- ============================================================

BEGIN;

ALTER TABLE payroll_kyotaku_attendance_records
  ADD COLUMN IF NOT EXISTS phone_duty BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS holiday_support_count INT NOT NULL DEFAULT 0
    CHECK (holiday_support_count >= 0);

COMMENT ON COLUMN payroll_kyotaku_attendance_records.phone_duty IS
  '電話当番 (統括営業本部のみ)。1回 3,000円。土日祝対応がある日は併給しない';
COMMENT ON COLUMN payroll_kyotaku_attendance_records.holiday_support_count IS
  '土日祝対応 件数 (統括営業本部のみ)。1件 6,000円 / 2件以上 10,000円';

COMMIT;
