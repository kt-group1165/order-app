-- ============================================================
-- payroll_employees.member_id + members → payroll 同期 trigger
-- 従業員マスタの一本化 (members = 人の正マスタ)
-- ============================================================
-- 背景 (2026-07-29 user 確定):
--   従業員は members (カレンダー/order-app/kaigo-app) と payroll_employees
--   (payroll/出勤簿) の 2 マスタに分裂していた。members を「人の正マスタ」とし、
--   payroll_employees は member_id で紐づく従属データにする。
--
-- 設計:
--   - member_id は NULLABLE。NULL = payroll 専用の擬似エントリ
--     (「対応者調整」等) や未紐付けの既存行
--   - UNIQUE は付けない (既存の兼務合算パターン = 同一人物の複数 office 行を許容)。
--     ただし新規作成 (出勤簿の members 取込) は「主所属に 1 行」のみ作る運用
--   - 同期は members → payroll の一方向。members の 氏名 / 在籍状態の変更が
--     紐づく全 payroll 行に自動反映される (どのアプリで操作しても共有される)
--   - trigger は SECURITY DEFINER: 呼出元 (カレンダー等の一般ユーザー) の RLS で
--     payroll_employees が見えなくても同期が欠けないようにする (house pattern)
--
-- 注意:
--   - 在籍状態は members が常に正。payroll 側で手動で 退職者 にしても、
--     members が active のまま更新されると 在職者 に戻る (= SSOT の意図的挙動)
-- ============================================================

BEGIN;

-- ─── 1. 紐付け列 ────────────────────────────────────────────
ALTER TABLE payroll_employees
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES members(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_payroll_employees_member_id
  ON payroll_employees (member_id) WHERE member_id IS NOT NULL;

COMMENT ON COLUMN payroll_employees.member_id IS
  '人の正マスタ members への紐付け。NULL = payroll 専用擬似エントリ or 未紐付け。氏名・在籍は members から trigger 同期';

-- ─── 2. members → payroll_employees 同期 trigger ────────────
CREATE OR REPLACE FUNCTION sync_member_to_payroll_employees()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE payroll_employees pe
     SET name = NEW.name,
         employment_status = CASE
           WHEN NEW.deleted_at IS NOT NULL OR NEW.status <> 'active' THEN '退職者'
           ELSE '在職者'
         END
   WHERE pe.member_id = NEW.id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_member_to_payroll ON members;
CREATE TRIGGER trg_sync_member_to_payroll
AFTER UPDATE OF name, status, deleted_at ON members
FOR EACH ROW
WHEN (
  OLD.name IS DISTINCT FROM NEW.name
  OR OLD.status IS DISTINCT FROM NEW.status
  OR OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
)
EXECUTE FUNCTION sync_member_to_payroll_employees();

COMMENT ON FUNCTION sync_member_to_payroll_employees() IS
  'members の氏名/在籍変更を member_id で紐づく payroll_employees 全行へ一方向同期。SECURITY DEFINER で RLS を跨ぐ';

COMMIT;
