-- ============================================================
-- attendance_month_status
-- 出勤簿の月次ステータス (確定＆提出 / 承認)
-- ============================================================
-- 仕様 (2026-07-29 user 要望):
--   本人が月の入力を終えたら「確定＆提出」→ 管理者が「承認」する 2 段階。
--   提出後は本人 URL からは編集不可 (管理者は引き続き編集でき、必要なら差し戻す)。
--
--   submitted : 本人が提出済み (本人ロック)
--   approved  : 管理者が承認済み (給与計算の対象)
--   row 無し  : 未提出 (自由に編集できる)
--
--   差し戻し = row 削除 (履歴を残さず単純化。誰がいつ提出/承認したかは列で保持)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS attendance_month_status (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  employee_id   UUID NOT NULL REFERENCES payroll_employees(id) ON DELETE CASCADE,
  month_start   DATE NOT NULL,            -- YYYY-MM-01
  status        TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted', 'approved')),
  submitted_at  TIMESTAMPTZ,
  -- 本人 URL からの提出は auth を持たないため NULL。管理者提出時のみ入る
  submitted_by  TEXT,
  approved_at   TIMESTAMPTZ,
  approved_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, month_start)
);

CREATE INDEX IF NOT EXISTS idx_attendance_month_status_month
  ON attendance_month_status (month_start);

ALTER TABLE attendance_month_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attendance_month_status_authenticated ON attendance_month_status;
CREATE POLICY attendance_month_status_authenticated
  ON attendance_month_status
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE attendance_month_status IS
  '出勤簿の月次ステータス。row 無し=未提出 / submitted=本人提出済 (本人ロック) / approved=管理者承認済。差し戻しは row 削除';

COMMIT;
