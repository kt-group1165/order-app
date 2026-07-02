-- =====================================================================
-- モニタリング様式の増補 (運営指導対応・ふくせん様式準拠)
-- =====================================================================
--   1) monitoring_items.has_usage_issue  : 用具ごとの「使用状況の問題」なし/あり
--   2) monitoring_records.goal_achievement / goal_comment
--        : 記録全体で1箇所の「利用目標の達成状況」(達成/一部達成/未達成 + コメント)
--
-- 適用方法: Supabase SQL Editor にこのファイル全体を貼り付けて Run。
--           BEGIN; ... COMMIT; の 1 トランザクション。再実行しても壊れない(冪等)。
-- =====================================================================

BEGIN;

-- 用具ごと: 使用状況の問題 (false=なし / true=あり)
ALTER TABLE monitoring_items
  ADD COLUMN IF NOT EXISTS has_usage_issue BOOLEAN NOT NULL DEFAULT false;

-- 記録全体: 利用目標の達成状況
ALTER TABLE monitoring_records
  ADD COLUMN IF NOT EXISTS goal_achievement TEXT;
ALTER TABLE monitoring_records
  ADD COLUMN IF NOT EXISTS goal_comment TEXT;

-- goal_achievement の許可値 (NULL = 未記入 を許容)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'monitoring_records_goal_achievement_check'
  ) THEN
    ALTER TABLE monitoring_records
      ADD CONSTRAINT monitoring_records_goal_achievement_check
      CHECK (goal_achievement IS NULL OR goal_achievement IN ('達成', '一部達成', '未達成'));
  END IF;
END $$;

COMMIT;

-- 検証 (適用後):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name IN ('monitoring_items','monitoring_records')
--     AND column_name IN ('has_usage_issue','goal_achievement','goal_comment');
