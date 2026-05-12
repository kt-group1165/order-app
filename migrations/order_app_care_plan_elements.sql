-- migrations/order_app_care_plan_elements.sql
-- Phase: order-app 個別援助計画書 要素ベース化 (user 確定 2026-05-12)
--
-- 背景:
--   個別援助計画書の作成画面を「要素 list からチェックボックス選択 → 自動生成」に
--   置換。発生事象 (用具追加/解約・保険情報更新/区分変更/居宅変更) を care_plan_elements
--   に時系列で蓄積し、UI でチェックして 1 計画書にまとめる。
--   doc_tasks v2 とは別系統 (doc_tasks は書類タスク管理用に残す)。
--
-- spec:
--   - element_type 6 種: 'new_delivery' / 'additional_delivery' / 'pickup'
--                       / 'plan_renewal' / 'plan_change' / 'care_office_change'
--   - status: 'pending' (未消化) / 'completed' (灰色で残る、再使用不可)
--   - 1 要素 → 1 計画書 (linked_care_plan_id で紐付け、再利用なし)
--   - 複数要素 → 1 計画書 (UI 側で束ねて生成)
--   - 古い未消化要素は永続表示 (自動 cancel なし)
--
-- 適用方法:
--   Supabase SQL Editor で 1 ファイルとして実行 (BEGIN/COMMIT 入り)。
--   trigger 関数は別 migration (order_app_care_plan_elements_triggers.sql) で適用。

BEGIN;

-- ── care_plan_elements テーブル本体 ──────────────────────────────────
CREATE TABLE care_plan_elements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  office_id UUID NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- 発生日 (display 番号は occurred_at DESC で 1 から付ける)
  occurred_at DATE NOT NULL,

  -- 要素種別 → 計画書冒頭チェックボックス 6 種にマップ
  element_type TEXT NOT NULL CHECK (element_type IN (
    'new_delivery',        -- 新規納品 (active rental 0 → 1+)
    'additional_delivery', -- 追加納品 (既に active rental あり)
    'pickup',              -- 回収 (一部解約、同日 active 残 > 0)
    'plan_renewal',        -- プラン更新 (認定期間満了 → 更新)
    'plan_change',         -- プラン変更 (期間中の区分変更)
    'care_office_change'   -- その他 (居宅介護支援事業所変更)
  )),

  -- 発生事象の参照 (order_items.id or client_insurance_records.id)
  ref_table TEXT NOT NULL,
  ref_id UUID NOT NULL,

  -- detail: 用具名 / 前後の居宅名 / 前後の介護度 等 (UI 表示と自動文言用)
  -- 例: { "equipment_name": "車椅子", "product_code": "ABC123" }
  --     { "from_care_office": "○○居宅", "to_care_office": "△△居宅", "from_id": "...", "to_id": "..." }
  --     { "from_care_level": "要介護2", "to_care_level": "要介護3" }
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- 状態管理 (灰色化用途、cancelled は使わない仕様)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  linked_care_plan_id UUID REFERENCES client_documents(id) ON DELETE SET NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,

  -- 同じ発生事象から重複 INSERT を防ぐ (trigger の冪等性確保用)
  UNIQUE (element_type, ref_table, ref_id)
);

-- ── インデックス ─────────────────────────────────────────────────────
-- modal で client 単位の要素 list を occurred_at DESC で取る query 用
CREATE INDEX idx_care_plan_elements_client_occurred
  ON care_plan_elements (client_id, occurred_at DESC);

-- pending 行検索 (count 表示等)
CREATE INDEX idx_care_plan_elements_office_status
  ON care_plan_elements (office_id, status)
  WHERE status = 'pending';

-- linked_care_plan_id 逆引き (計画書削除時の追跡)
CREATE INDEX idx_care_plan_elements_linked
  ON care_plan_elements (linked_care_plan_id)
  WHERE linked_care_plan_id IS NOT NULL;

-- ── RLS (office-scoped、doc_tasks v2 と同パターン) ─────────────────
ALTER TABLE care_plan_elements ENABLE ROW LEVEL SECURITY;

CREATE POLICY care_plan_elements_authenticated ON care_plan_elements
  FOR ALL TO authenticated
  USING (office_id IN (SELECT auth_visible_office_ids()))
  WITH CHECK (office_id IN (SELECT auth_visible_office_ids()));

COMMIT;
