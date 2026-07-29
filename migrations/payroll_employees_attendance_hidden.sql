-- ============================================================
-- payroll_employees.attendance_hidden
-- 出勤簿での非表示フラグ
-- ============================================================
-- 背景:
--   payroll_employees には「対応者調整」「直納・直引き 立ち合いなし」のような
--   給与・シフト用の擬似エントリが混ざっており、出勤簿の入力対象としては不要。
--   退職者にはできない (現役の擬似エントリ) ため、独立した非表示フラグを持つ。
--
-- 効果 (order-app 出勤簿):
--   - 出勤簿入力画面の職員 dropdown に出ない
--   - 自己入力 URL の発行一覧に出ない / 既存 URL も 403
--   - スタッフ管理モーダルでは「非表示も表示」で確認・解除できる
-- payroll-app 側はこの列を参照しないため影響なし。
-- ============================================================

BEGIN;

ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS attendance_hidden BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN payroll_employees.attendance_hidden IS
  '出勤簿での非表示フラグ (擬似エントリ用)。true = 出勤簿の職員選択・URL 発行対象から除外';

COMMIT;
