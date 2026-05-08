-- order-app doc_tasks v4: rental_started を per-item から per-order に集約
--
-- 背景 (user 2026-05-09):
--   「初期は発注に合わせるのがいい。3 つの用具を 1 つの発注でやってるなら、この画面でも 1 行にする」
--   → 1 order × N items rental_started → 4 doc_tasks (4 種 × 1 order) のみ
--
-- 変更点:
--   1. fn_doc_tasks_from_order_items() の rental_started 部分を per-order に
--      - trigger_ref_id := NEW.order_id
--      - trigger_ref_table := 'orders'
--      - ON CONFLICT (trigger_type, trigger_ref_id, expected_doc_type) で同 order 重複防止
--   2. partial_termination は **per-item のまま無変更**
--      (都度書類が基本という user 仕様)
--   3. 既存 rental_started doc_tasks (per-item) を per-order に集約
--      - 各 (order_id, expected_doc_type) で 1 件だけ残し他を DELETE
--      - 残った 1 件の trigger_ref_id を order_id に書き換え、trigger_ref_table='orders' に
--
-- 適用方法:
--   Supabase SQL Editor で 1 ファイルとして実行 (BEGIN/COMMIT 1 ブロック)。

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1) trigger 関数を CREATE OR REPLACE
--    rental_started 部分のみ per-order 化、partial_termination は無変更
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_doc_tasks_from_order_items()
RETURNS TRIGGER AS $$
DECLARE
  v_office_id UUID;
  v_client_id UUID;
  v_tenant_id TEXT;
  v_trigger_date DATE;
  v_target_id UUID;
  v_target_status TEXT;
  v_remaining_rental INT;
  v_doc_type TEXT;
BEGIN
  -- DELETE は OLD を使う、INSERT/UPDATE は NEW を使う
  IF TG_OP = 'DELETE' THEN
    v_target_id := OLD.id;
    v_target_status := OLD.status;
  ELSE
    v_target_id := NEW.id;
    v_target_status := NEW.status;
  END IF;

  -- order 情報取得 (order_items に office_id / client_id 列が無いため)
  SELECT o.tenant_id, o.office_id, o.client_id
    INTO v_tenant_id, v_office_id, v_client_id
    FROM orders o
   WHERE o.id = COALESCE(NEW.order_id, OLD.order_id);

  IF v_office_id IS NULL OR v_client_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── (a) rental_started 化を観測 (v4: per-order に集約) ──────────
  IF (TG_OP = 'INSERT' AND NEW.status = 'rental_started')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'rental_started'
         AND OLD.status IS DISTINCT FROM 'rental_started') THEN
    v_trigger_date := COALESCE(NEW.rental_start_date, CURRENT_DATE);

    -- 4 種の expected_doc_type を **order 単位** で 1 件ずつ INSERT
    -- ON CONFLICT で同 order 内の他 item からの重複 INSERT を吸収
    FOREACH v_doc_type IN ARRAY ARRAY['rental_contract', 'change_contract', 'care_plan', 'proposal']
    LOOP
      INSERT INTO doc_tasks (
        tenant_id, office_id, client_id,
        trigger_type, trigger_ref_id, trigger_ref_table,
        trigger_label, trigger_date, expected_doc_type
      ) VALUES (
        v_tenant_id, v_office_id, v_client_id,
        'rental_started', NEW.order_id, 'orders',
        'レンタル開始 ' || v_trigger_date::text,
        v_trigger_date, v_doc_type
      )
      ON CONFLICT (trigger_type, trigger_ref_id, expected_doc_type) DO NOTHING;
    END LOOP;
  END IF;

  -- ── (b) 一部解約検出 (per-item のまま無変更) ─────────────────
  IF (TG_OP = 'UPDATE' AND OLD.status = 'rental_started'
      AND NEW.status IS DISTINCT FROM 'rental_started')
     OR (TG_OP = 'DELETE' AND OLD.status = 'rental_started') THEN
    -- client 内にまだ rental_started item が残っていれば「一部解約」
    SELECT COUNT(*)
      INTO v_remaining_rental
      FROM order_items oi
      JOIN orders o2 ON o2.id = oi.order_id
     WHERE o2.client_id = v_client_id
       AND oi.status = 'rental_started'
       AND oi.id <> v_target_id;

    IF v_remaining_rental > 0 THEN
      v_trigger_date := COALESCE(
        OLD.rental_end_date,
        OLD.cancelled_at::date,
        CURRENT_DATE
      );

      -- 2 種 INSERT (change_contract / care_plan) — per-item のまま
      FOREACH v_doc_type IN ARRAY ARRAY['change_contract', 'care_plan']
      LOOP
        INSERT INTO doc_tasks (
          tenant_id, office_id, client_id,
          trigger_type, trigger_ref_id, trigger_ref_table,
          trigger_label, trigger_date, expected_doc_type
        ) VALUES (
          v_tenant_id, v_office_id, v_client_id,
          'partial_termination', OLD.id, 'order_items',
          '一部解約 ' || v_trigger_date::text,
          v_trigger_date, v_doc_type
        )
        ON CONFLICT (trigger_type, trigger_ref_id, expected_doc_type) DO NOTHING;
      END LOOP;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────
-- 2) 既存 rental_started doc_tasks の集約 (per-item → per-order)
--
--    現在: 1 item × 4 種 = 4 doc_tasks / item
--    既存例: 3 items が同じ order で rental_started → 3 × 4 = 12 doc_tasks
--    目標: 同じ (order_id, expected_doc_type) で 1 件だけ残す → 4 doc_tasks
--
--    対象: trigger_type='rental_started' AND trigger_ref_table='order_items'
--    cancelled / merged 済の row も touch しない (UI で見えなくなる影響を抑える)
-- ─────────────────────────────────────────────────────────────────────

-- (2a) 同一 (order_id, expected_doc_type) 内で重複している rental_started doc_task を DELETE
--      ROW_NUMBER で created_at 昇順に並べ、2 件目以降を削除
WITH item_to_order AS (
  SELECT id AS item_id, order_id
    FROM order_items
), grouped AS (
  SELECT dt.id,
         ROW_NUMBER() OVER (
           PARTITION BY ito.order_id, dt.expected_doc_type
           ORDER BY dt.created_at, dt.id
         ) AS rn
    FROM doc_tasks dt
    JOIN item_to_order ito ON ito.item_id = dt.trigger_ref_id
   WHERE dt.trigger_type = 'rental_started'
     AND dt.trigger_ref_table = 'order_items'
     AND dt.status <> 'cancelled'
     AND dt.merged_into_task_id IS NULL
)
DELETE FROM doc_tasks
 WHERE id IN (SELECT id FROM grouped WHERE rn > 1);

-- (2b) 残った 1 件を per-order 形に書き換え
--      trigger_ref_id を order_id に、trigger_ref_table を 'orders' に
UPDATE doc_tasks dt
   SET trigger_ref_id    = oi.order_id,
       trigger_ref_table = 'orders',
       updated_at        = NOW()
  FROM order_items oi
 WHERE oi.id = dt.trigger_ref_id
   AND dt.trigger_type = 'rental_started'
   AND dt.trigger_ref_table = 'order_items';

-- (2c) cancelled / merged 済の per-item rental_started はそのまま放置 (履歴保持)
--      → 必要なら別途 cleanup migration で対応

COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- 検証 SQL (実行不要、確認用):
--
-- -- per-item の rental_started doc_tasks が 0 件になっているか
-- SELECT COUNT(*) FROM doc_tasks
--  WHERE trigger_type = 'rental_started'
--    AND trigger_ref_table = 'order_items'
--    AND status <> 'cancelled';
--
-- -- per-order の rental_started doc_tasks 件数 (= active orders の rental_started 化数 × 4)
-- SELECT COUNT(*) FROM doc_tasks
--  WHERE trigger_type = 'rental_started'
--    AND trigger_ref_table = 'orders'
--    AND status <> 'cancelled';
--
-- -- 同 (order_id, expected_doc_type) で 1 件だけになっているか
-- SELECT trigger_ref_id, expected_doc_type, COUNT(*)
--   FROM doc_tasks
--  WHERE trigger_type = 'rental_started'
--    AND trigger_ref_table = 'orders'
--    AND status <> 'cancelled'
--  GROUP BY trigger_ref_id, expected_doc_type
-- HAVING COUNT(*) > 1;
-- ─────────────────────────────────────────────────────────────────────
