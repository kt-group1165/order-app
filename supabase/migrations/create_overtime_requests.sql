-- 残業許可制: 残業許可申請書 + 承認ワークフロー + 実績記録
--
-- フロー:
--   1) 職員 (または代理の事業所担当者) が対象日・予定時間・理由を入力して申請 (status=pending)
--   2) 事業所管理者 (office_admin 以上、auth_admin_office_ids()) が承認/却下
--   3) 承認済みのものについて、終業後に実績時間 (actual_minutes) を記録
--
-- 前提:
--   - offices / members テーブル存在
--   - auth_visible_office_ids() / auth_admin_office_ids() が存在
--     (モノレポ共有 migrations/phase2_05_02_helper_functions.sql,
--      migrations/phase2_07_02_admin_only_invitations.sql で作成済)
--
-- 影響範囲:
--   - 新規テーブル 1 個のみ。既存テーブル無変更
--
-- ロールバック:
--   DROP TABLE IF EXISTS overtime_requests CASCADE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_visible_office_ids') THEN
    RAISE EXCEPTION 'auth_visible_office_ids() が存在しません。共有 migrations/phase2_05_02_helper_functions.sql を先に適用してください。';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_admin_office_ids') THEN
    RAISE EXCEPTION 'auth_admin_office_ids() が存在しません。共有 migrations/phase2_07_02_admin_only_invitations.sql を先に適用してください。';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS overtime_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,

  -- 誰の残業か (members ロースター)。申請入力者と別人のケース (事業所担当者が代理入力) を許容。
  member_id UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  member_name TEXT NOT NULL, -- 表示用スナップショット (members 改名/削除後も申請書の記録は残す)

  -- 実際にこの行を作成したログインユーザ (audit + 本人によるキャンセル判定用)
  submitted_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  target_date DATE NOT NULL,
  scheduled_end_time TIME, -- 所定終業時刻 (任意)
  overtime_start_time TIME NOT NULL,
  overtime_end_time TIME NOT NULL,
  planned_minutes INT NOT NULL CHECK (planned_minutes > 0),
  work_content TEXT,
  reason TEXT NOT NULL CHECK (length(reason) > 0),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,

  -- 実績 (終業後に記録。予定と別管理)
  actual_minutes INT CHECK (actual_minutes IS NULL OR actual_minutes >= 0),
  actual_recorded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actual_recorded_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE overtime_requests IS
  '残業許可申請書 + 承認ワークフロー。事前申請 (pending) → 事業所管理者が承認/却下 → 実績記録。'
  ' 一覧が「残業時間管理表」を兼ねる (月次で member_id 集計)。';
COMMENT ON COLUMN overtime_requests.member_name IS
  '申請時点の members.name スナップショット。members 側の改名/退職後も申請書表記を保持するため。';
COMMENT ON COLUMN overtime_requests.submitted_by IS
  '本人 or 代理入力した事業所担当者の auth.users.id。本人によるキャンセル可否の判定に使用。';

CREATE INDEX IF NOT EXISTS idx_overtime_requests_office_date ON overtime_requests(office_id, target_date);
CREATE INDEX IF NOT EXISTS idx_overtime_requests_member ON overtime_requests(member_id, target_date);
CREATE INDEX IF NOT EXISTS idx_overtime_requests_pending ON overtime_requests(office_id) WHERE status = 'pending';

ALTER TABLE overtime_requests ENABLE ROW LEVEL SECURITY;

-- SELECT: 自事業所が見える人は全員閲覧可 (StaffTab 等既存の可視性ポリシーと同水準)
DROP POLICY IF EXISTS overtime_requests_read ON overtime_requests;
CREATE POLICY overtime_requests_read ON overtime_requests
  FOR SELECT
  TO authenticated
  USING (office_id IN (SELECT auth_visible_office_ids()));

-- INSERT: 自事業所が見える人が、自分を submitted_by として申請可
DROP POLICY IF EXISTS overtime_requests_insert ON overtime_requests;
CREATE POLICY overtime_requests_insert ON overtime_requests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    office_id IN (SELECT auth_visible_office_ids())
    AND submitted_by = auth.uid()
  );

-- UPDATE (本人): pending の間だけ編集/取消可能。承認/却下フィールドには触れない
-- (WITH CHECK で status を pending か cancelled に限定することで承認自体は不可にする)
DROP POLICY IF EXISTS overtime_requests_update_own ON overtime_requests;
CREATE POLICY overtime_requests_update_own ON overtime_requests
  FOR UPDATE
  TO authenticated
  USING (submitted_by = auth.uid() AND status = 'pending')
  WITH CHECK (submitted_by = auth.uid() AND status IN ('pending', 'cancelled'));

-- UPDATE (事業所管理者): 承認/却下/実績記録など全フィールド操作可
DROP POLICY IF EXISTS overtime_requests_update_admin ON overtime_requests;
CREATE POLICY overtime_requests_update_admin ON overtime_requests
  FOR UPDATE
  TO authenticated
  USING (office_id IN (SELECT auth_admin_office_ids()))
  WITH CHECK (office_id IN (SELECT auth_admin_office_ids()));

-- DELETE は提供しない (取消は status='cancelled' で表現。doc_tasks と同じ方針)

-- 検証クエリ (Supabase Studio で手動実行) ------------------------------
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename = 'overtime_requests';
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'overtime_requests' ORDER BY cmd, policyname;
