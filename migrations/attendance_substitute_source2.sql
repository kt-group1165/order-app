-- ============================================================
-- 出勤簿: 振替・代休元の 2 件目 (substitute_for_date2)
-- ============================================================
-- 仕様 (2026-07-29 user 確定):
--   休日の振替 (代休) は元日付を最大 2 つまで入力できる。
--   例: 土曜半日 + 日曜半日 の出勤 2 回を組み合わせて平日 1 日の代休にする。
--
-- 列の意味 (アプリで異なるので注意):
--   - order-app (用具 + 本社) の行:
--       substitute_for_date / substitute_for_date2 = 「この日の休みの元になった出勤日」
--       (= Excel 出勤簿の 振替元 列と同じ向き。set された日は休み扱い = 欠勤なし)
--   - payroll-app / kaigo-app (居宅) の行:
--       substitute_for_date = 従来どおり「この出勤の振替先の休日」(逆向き)。
--       事業所でアプリが分かれるため同一 row で意味が混ざることはない。
--       order-app 側の既存データに旧方式の使用は無いことを確認済 (2026-07-29)。
-- ============================================================

BEGIN;

ALTER TABLE payroll_kyotaku_attendance_records
  ADD COLUMN IF NOT EXISTS substitute_for_date2 DATE;

COMMENT ON COLUMN payroll_kyotaku_attendance_records.substitute_for_date2 IS
  '振替・代休元の 2 件目 (order-app 用。半日出勤 2 回を 1 日の代休に組み合わせる用途)';

COMMIT;
