-- =====================================================================
-- 仕入価格 一括訂正の監査ログ: order_item_price_changes (新規)
-- =====================================================================
-- 目的:
--   発生主義の月次損益では原価の正 = order_items.purchase_price
--   (発注時スナップショット)。誤りの「訂正」は該当月の order_items を
--   そのまま restate するが、「黙って変えない」ために変更 1 件ごとに
--   本テーブルへ監査行を append する (old_price → new_price / 理由 / 実行者)。
--
--   append-only 運用想定だが、DB 制約では縛らない
--   (UPDATE/DELETE も通常の tenant-scoped ポリシーのまま)。
--
-- 適用方法:
--   Supabase ダッシュボードの SQL Editor に「この 1 ファイル全体」を貼り付けて
--   Run すること。全体が BEGIN; ... COMMIT; で 1 トランザクションになっている。
--   ※ BEGIN; だけで COMMIT; を忘れると実行終了時に auto-rollback されるので注意。
--
-- 冪等性: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--   DROP POLICY IF EXISTS → CREATE POLICY。再実行しても壊れない。
-- =====================================================================

BEGIN;

-- ── 監査ログテーブル order_item_price_changes (新規) ────────────────
CREATE TABLE IF NOT EXISTS order_item_price_changes (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  order_item_id   UUID NOT NULL,          -- order_items.id 参照 (FK は張らない)
  old_price       NUMERIC,                -- 訂正前 (NULL 可 = 未設定だった)
  new_price       NUMERIC NOT NULL,       -- 訂正後
  effective_month TEXT NOT NULL,          -- "YYYY-MM" ユーザーが明示した対象月
  reason          TEXT,                   -- 訂正理由
  changed_by      TEXT,                   -- 実行者 (email 等)
  changed_at      TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE order_item_price_changes IS
  '仕入価格訂正の監査ログ (append-only 運用)。order_items.purchase_price を restate した履歴';

-- 検索用 index: 明細単位の履歴 / 対象月単位の一覧
CREATE INDEX IF NOT EXISTS idx_oipc_tenant_order_item
  ON order_item_price_changes (tenant_id, order_item_id);
CREATE INDEX IF NOT EXISTS idx_oipc_tenant_month
  ON order_item_price_changes (tenant_id, effective_month);

-- ── RLS: order-app の他 tenant-scoped 表 (equipment_set_items 等) と同パターン ──
-- FOR ALL TO authenticated / tenant_id IN (SELECT auth_visible_tenant_ids())
ALTER TABLE order_item_price_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_item_price_changes_authenticated ON order_item_price_changes;
CREATE POLICY order_item_price_changes_authenticated ON order_item_price_changes
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMIT;

-- =====================================================================
-- 完了。
--
-- 検証クエリ (適用後に確認):
--   -- テーブルと RLS
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'order_item_price_changes';
--   SELECT policyname, cmd, roles FROM pg_policies
--   WHERE tablename = 'order_item_price_changes';
--   -- index
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'order_item_price_changes';
-- =====================================================================
