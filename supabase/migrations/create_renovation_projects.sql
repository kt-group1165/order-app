-- 住宅改修 進行管理 (= Excel「◆住宅改修 進行表」の置換)
--
-- 元 Excel: apps/order-app/住宅改修進行表/ケア・サポート千葉◆住宅改修　進行表2023年～.xlsx
--   年度ごとに 1 sheet、1 案件 = 2〜4 行ブロック (予定行 / ラベル行 / 実績行 / 〇×行) で
--   訪問 → 見積作成 → 見積提出 → 事前協議 → 工事 → 受注票作成 → 集金 → 役所提出
--   の 8 工程を横に並べ、施工月ごとに 仕切り合計 / 計上金額 / 仕入率 / 粗利 を集計していた。
--
-- ここでは
--   renovation_projects       … 案件 1 件 = 1 行 (利用者・ケアマネ・金額・施工会社)
--   renovation_project_steps  … 案件 × 工程 (予定日 / 実績日 / 状態) の子テーブル
-- に正規化する。〇 = status 'done'、× = status 'skipped' (自費案件の事前協議・役所提出等)。
--
-- 前提:
--   - offices / clients / care_offices / care_managers / members テーブル存在
--   - auth_visible_office_ids() / auth_admin_office_ids() が存在
--     (モノレポ共有 migrations/phase2_05_02_helper_functions.sql,
--      migrations/phase2_07_02_admin_only_invitations.sql で作成済)
--
-- 影響範囲:
--   - 新規テーブル 2 個のみ。既存テーブル無変更
--
-- ロールバック:
--   DROP TABLE IF EXISTS renovation_project_steps CASCADE;
--   DROP TABLE IF EXISTS renovation_projects CASCADE;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_visible_office_ids') THEN
    RAISE EXCEPTION 'auth_visible_office_ids() が存在しません。共有 migrations/phase2_05_02_helper_functions.sql を先に適用してください。';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auth_admin_office_ids') THEN
    RAISE EXCEPTION 'auth_admin_office_ids() が存在しません。共有 migrations/phase2_07_02_admin_only_invitations.sql を先に適用してください。';
  END IF;
END $$;

-- ─── 案件 ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS renovation_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,

  -- 年度 (4/1〜3/31)。工事日から導出できるが、工事日未定の案件も一覧に出すため明示保持。
  -- 西暦年度 (2026年度 = 令和8年度) で持つ。
  fiscal_year INT NOT NULL,

  -- 利用者。マスタ未登録のまま先に進行表へ載せるケースがあるので client_id は NULL 可、
  -- client_name は常に必須 (Excel の氏名列がそのまま入る)。
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL CHECK (length(btrim(client_name)) > 0),
  client_address TEXT,

  -- 居宅介護支援事業所 / ケアマネ。マスタ紐付けがあれば *_id、無ければテキストを表示。
  care_office_id UUID REFERENCES care_offices(id) ON DELETE SET NULL,
  care_office_text TEXT,
  care_manager_id UUID REFERENCES care_managers(id) ON DELETE SET NULL,
  care_manager_text TEXT,

  -- 自社担当者
  staff_member_id UUID REFERENCES members(id) ON DELETE SET NULL,
  staff_name TEXT,

  work_content TEXT,                 -- 工事内容 (手すり / 段差解消 / 「2回目」等の注記も含む)
  contractor TEXT,                   -- 施工会社 (例: 行方)
  -- 負担割合。保険給付を使わない案件は '自費'。
  copay_rate TEXT CHECK (copay_rate IS NULL OR copay_rate IN ('1割', '2割', '3割', '自費')),
  notes TEXT,                        -- 備考 (「退院後希望」「入院中」「ご逝去」等)

  -- 金額。仕切り合計 = 原価、計上金額 = 売上。仕入率/粗利はアプリ側で算出 (0除算回避のため)。
  cost_total NUMERIC(12, 2) CHECK (cost_total IS NULL OR cost_total >= 0),
  sales_total NUMERIC(12, 2) CHECK (sales_total IS NULL OR sales_total >= 0),

  -- 案件全体の状態。工程の消化状況とは独立に、中止/保留を明示するために持つ。
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'on_hold', 'cancelled')),

  -- Excel からの一括取込行を後で判別・巻き戻しできるようにするマーカー
  import_marker TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE renovation_projects IS
  '住宅改修の案件 1 件。工程の予定/実績は renovation_project_steps 側に持つ。'
  ' 旧 Excel「◆住宅改修 進行表」の 1 ブロックに相当。';
COMMENT ON COLUMN renovation_projects.fiscal_year IS
  '西暦の年度 (4/1〜3/31 起点)。2026 = 令和8年度。工事日未定でも一覧に出せるよう明示保持。';
COMMENT ON COLUMN renovation_projects.client_name IS
  '利用者名。clients マスタ未登録でも進行表に載せられるようテキストを正とする。';
COMMENT ON COLUMN renovation_projects.copay_rate IS
  '負担割合。保険給付を使わない案件は 自費 (この場合 事前申請/役所提出 工程が skipped になる)。';
COMMENT ON COLUMN renovation_projects.import_marker IS
  'Excel 一括取込のマーカー (例: fake-renovation-import-2026-08)。手入力行は NULL。';

CREATE INDEX IF NOT EXISTS idx_renovation_projects_office_year
  ON renovation_projects(office_id, fiscal_year);
CREATE INDEX IF NOT EXISTS idx_renovation_projects_client
  ON renovation_projects(client_id);
CREATE INDEX IF NOT EXISTS idx_renovation_projects_open
  ON renovation_projects(office_id) WHERE status = 'in_progress';

-- ─── 工程 ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS renovation_project_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES renovation_projects(id) ON DELETE CASCADE,

  -- 工程キー。表示名・並び順・予定日オフセットは lib/renovations.ts の RENOVATION_STEPS が正。
  -- CHECK で固定するのは、typo 由来の「どこにも表示されない工程」を防ぐため。
  step_key TEXT NOT NULL CHECK (step_key IN (
    'visit',            -- 訪問
    'quote_created',    -- 見積作成
    'quote_presented',  -- 見積提出
    'pre_application',  -- 事前申請 (事前協議)
    'construction',     -- 工事
    'order_sheet',      -- 受注票作成
    'collection',       -- 集金
    'office_submit'     -- 役所提出 (事後申請)
  )),

  planned_date DATE,
  actual_date DATE,

  -- pending = 未着手/予定のみ、done = 〇、skipped = × (自費で事前協議不要 等)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'done', 'skipped')),

  -- 実績が日付で表せないケース (「ポスト」「引き落とし」「1/23.25」「1月希望」等) の逃がし先
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (project_id, step_key)
);

COMMENT ON TABLE renovation_project_steps IS
  '住宅改修案件の工程 1 つ。予定日 (planned_date) と実績日 (actual_date) を別列で持ち、'
  ' 遅延判定は planned_date < today AND status = pending で行う。';
COMMENT ON COLUMN renovation_project_steps.status IS
  'pending=未 / done=完了(旧 Excel の 〇) / skipped=対象外(旧 Excel の ×)。';
COMMENT ON COLUMN renovation_project_steps.note IS
  '日付にならない実績表記の逃がし先。旧 Excel に「ポスト」「引き落とし」「1/23.25」等が入っていた。';

CREATE INDEX IF NOT EXISTS idx_renovation_steps_project
  ON renovation_project_steps(project_id);
-- 遅延一覧 (planned_date 経過 & 未消化) の抽出用
CREATE INDEX IF NOT EXISTS idx_renovation_steps_overdue
  ON renovation_project_steps(planned_date) WHERE status = 'pending';

-- ─── updated_at 自動更新 ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION renovation_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_renovation_projects_touch ON renovation_projects;
CREATE TRIGGER trg_renovation_projects_touch
  BEFORE UPDATE ON renovation_projects
  FOR EACH ROW EXECUTE FUNCTION renovation_touch_updated_at();

DROP TRIGGER IF EXISTS trg_renovation_steps_touch ON renovation_project_steps;
CREATE TRIGGER trg_renovation_steps_touch
  BEFORE UPDATE ON renovation_project_steps
  FOR EACH ROW EXECUTE FUNCTION renovation_touch_updated_at();

-- ─── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE renovation_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE renovation_project_steps ENABLE ROW LEVEL SECURITY;

-- 案件: 自事業所が見える人は閲覧・編集可 (発注/モニタリング等と同水準)
DROP POLICY IF EXISTS renovation_projects_read ON renovation_projects;
CREATE POLICY renovation_projects_read ON renovation_projects
  FOR SELECT TO authenticated
  USING (office_id IN (SELECT auth_visible_office_ids()));

DROP POLICY IF EXISTS renovation_projects_insert ON renovation_projects;
CREATE POLICY renovation_projects_insert ON renovation_projects
  FOR INSERT TO authenticated
  WITH CHECK (office_id IN (SELECT auth_visible_office_ids()));

DROP POLICY IF EXISTS renovation_projects_update ON renovation_projects;
CREATE POLICY renovation_projects_update ON renovation_projects
  FOR UPDATE TO authenticated
  USING (office_id IN (SELECT auth_visible_office_ids()))
  WITH CHECK (office_id IN (SELECT auth_visible_office_ids()));

-- 削除は事業所管理者のみ (誤操作で金額履歴ごと消えるのを防ぐ)
DROP POLICY IF EXISTS renovation_projects_delete ON renovation_projects;
CREATE POLICY renovation_projects_delete ON renovation_projects
  FOR DELETE TO authenticated
  USING (office_id IN (SELECT auth_admin_office_ids()));

-- 工程: 親案件の可視性に従う。
-- 親 (renovation_projects) の policy は offices しか参照しないため、
-- ここから親を subquery しても循環参照 (feedback_rls_circular_reference) にはならない。
DROP POLICY IF EXISTS renovation_steps_read ON renovation_project_steps;
CREATE POLICY renovation_steps_read ON renovation_project_steps
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM renovation_projects p
    WHERE p.id = renovation_project_steps.project_id
      AND p.office_id IN (SELECT auth_visible_office_ids())
  ));

DROP POLICY IF EXISTS renovation_steps_insert ON renovation_project_steps;
CREATE POLICY renovation_steps_insert ON renovation_project_steps
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM renovation_projects p
    WHERE p.id = renovation_project_steps.project_id
      AND p.office_id IN (SELECT auth_visible_office_ids())
  ));

DROP POLICY IF EXISTS renovation_steps_update ON renovation_project_steps;
CREATE POLICY renovation_steps_update ON renovation_project_steps
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM renovation_projects p
    WHERE p.id = renovation_project_steps.project_id
      AND p.office_id IN (SELECT auth_visible_office_ids())
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM renovation_projects p
    WHERE p.id = renovation_project_steps.project_id
      AND p.office_id IN (SELECT auth_visible_office_ids())
  ));

DROP POLICY IF EXISTS renovation_steps_delete ON renovation_project_steps;
CREATE POLICY renovation_steps_delete ON renovation_project_steps
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM renovation_projects p
    WHERE p.id = renovation_project_steps.project_id
      AND p.office_id IN (SELECT auth_visible_office_ids())
  ));

COMMIT;

-- 検証クエリ (Supabase Studio で手動実行) ------------------------------
-- SELECT tablename, rowsecurity FROM pg_tables WHERE tablename LIKE 'renovation_%';
-- SELECT tablename, policyname, cmd FROM pg_policies WHERE tablename LIKE 'renovation_%' ORDER BY tablename, cmd;
-- SELECT fiscal_year, count(*) FROM renovation_projects GROUP BY 1 ORDER BY 1;
