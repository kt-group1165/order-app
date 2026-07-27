-- overtime_requests の閲覧範囲を変更:
--   変更前: 自事業所が見える人は全員、事業所内の全申請を閲覧可
--   変更後: 一般職員は自分が申請した (submitted_by = 自分) 行のみ閲覧可。
--           事業所管理者 (auth_admin_office_ids()) は事業所内の全申請を閲覧可。
--
-- 前提: create_overtime_requests.sql 適用済

DROP POLICY IF EXISTS overtime_requests_read ON overtime_requests;

-- 本人: 自分が submitted_by の行のみ
CREATE POLICY overtime_requests_read_own ON overtime_requests
  FOR SELECT
  TO authenticated
  USING (submitted_by = auth.uid());

-- 事業所管理者: 事業所内の全申請
CREATE POLICY overtime_requests_read_admin ON overtime_requests
  FOR SELECT
  TO authenticated
  USING (office_id IN (SELECT auth_admin_office_ids()));

-- 検証クエリ (Supabase Studio で手動実行) ------------------------------
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'overtime_requests' ORDER BY cmd, policyname;
