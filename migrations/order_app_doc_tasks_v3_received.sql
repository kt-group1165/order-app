-- order-app doc_tasks v3: 受領管理 + 統合用カラム
--
-- 変更点:
--   1. status に 'received' を追加 (作成済 → 受領済)
--   2. received_at / received_by カラム追加
--   3. merged_into_task_id カラム追加 (統合先 task の自己参照)
--      - 統合時は source.merged_into_task_id = target.id にして source.status='cancelled'
--      - target.linked_document_id は既存の書類紐付けで使う
--
-- apply: psql or Supabase SQL Editor (BEGIN/COMMIT 1 ブロックで OK)
BEGIN;

-- 1. status check 拡張
ALTER TABLE doc_tasks DROP CONSTRAINT IF EXISTS doc_tasks_status_check;
ALTER TABLE doc_tasks ADD CONSTRAINT doc_tasks_status_check
  CHECK (status IN ('pending', 'completed', 'received', 'cancelled'));

-- 2. 受領情報
ALTER TABLE doc_tasks
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS received_by TEXT;

-- 3. 統合 (merge) 自己参照
ALTER TABLE doc_tasks
  ADD COLUMN IF NOT EXISTS merged_into_task_id UUID
    REFERENCES doc_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS doc_tasks_merged_into_idx
  ON doc_tasks(merged_into_task_id)
  WHERE merged_into_task_id IS NOT NULL;

-- 補助 index: status filter をする UI のため
CREATE INDEX IF NOT EXISTS doc_tasks_tenant_status_idx
  ON doc_tasks(tenant_id, status);

COMMIT;
