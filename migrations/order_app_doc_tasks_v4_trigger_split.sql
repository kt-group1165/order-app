-- migrations/order_app_doc_tasks_v4_trigger_split.sql
-- Phase: order-app doc_tasks v4 — rental_started 時の 1 回目/2 回目分岐
-- 作成: 2026-05-13
--
-- 背景 (user 仕様 2026-05-13 確定):
--   v2 では rental_started 時に rental_contract / change_contract / care_plan
--   / proposal の 4 種一律 INSERT していたが、user 仕様で:
--     - 利用者初の契約 (= new_delivery, active rental 他に 0 件) → 契約書
--     - 既存契約の追加 (= additional_delivery, active rental 他に 1+ 件) → 契約書別紙
--   と明確に分岐するため、対応する doc_tasks も 3 種に絞る:
--
--   1 回目 (new_delivery):
--     rental_contract / care_plan / proposal
--   2 回目以降 (additional_delivery):
--     change_contract / care_plan / proposal
--
--   partial_termination (一部解約) は change_contract / care_plan のまま (変更なし)。
--   cert_renewal (UI on-the-fly) も変更なし。
--
-- 既存 doc_tasks 行への影響:
--   - 既に v2 backfill (2026-05-09) で INSERT 済の rental_started doc_tasks は
--     4 種すべてが入っている。新仕様で「本来不要」な row (例: 1 回目で change_contract、
--     2 回目で rental_contract) は残るが、運用しながら user 判断で cancel する。
--   - 新規 rental_started 由来の INSERT は本 trigger 適用後から新仕様で発火する。
--
-- 適用方法:
--   Supabase SQL Editor で 1 ファイルとして実行 (BEGIN/COMMIT 入り)。

BEGIN;

CREATE OR REPLACE FUNCTION fn_doc_tasks_from_order_items()
RETURNS TRIGGER AS $$
DECLARE
  v_office_id UUID;
  v_client_id UUID;
  v_tenant_id TEXT;
  v_trigger_date DATE;
  v_target_id UUID;
  v_remaining_rental INT;
  v_other_active INT;
  v_doc_type TEXT;
  v_doc_types_new TEXT[];
BEGIN
  -- DELETE は OLD、INSERT/UPDATE は NEW
  IF TG_OP = 'DELETE' THEN
    v_target_id := OLD.id;
  ELSE
    v_target_id := NEW.id;
  END IF;

  -- order 情報取得
  SELECT o.tenant_id, o.office_id, o.client_id
    INTO v_tenant_id, v_office_id, v_client_id
    FROM orders o
   WHERE o.id = COALESCE(NEW.order_id, OLD.order_id);

  IF v_office_id IS NULL OR v_client_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- ── (a) rental_started 化 → 1 回目/2 回目で分岐 ────────────────────
  IF (TG_OP = 'INSERT' AND NEW.status = 'rental_started')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'rental_started'
         AND OLD.status IS DISTINCT FROM 'rental_started') THEN
    v_trigger_date := COALESCE(NEW.rental_start_date, CURRENT_DATE);

    -- 同 client 内の他 active rental_started 数 (NEW.id を除く)
    SELECT COUNT(*)
      INTO v_other_active
      FROM order_items oi
      JOIN orders o2 ON o2.id = oi.order_id
     WHERE o2.client_id = v_client_id
       AND oi.status = 'rental_started'
       AND oi.id <> NEW.id;

    IF v_other_active = 0 THEN
      -- new_delivery (利用者初の契約): 契約書 / 個別援助計画書 / 選定提案書
      v_doc_types_new := ARRAY['rental_contract', 'care_plan', 'proposal'];
    ELSE
      -- additional_delivery (既存契約の追加): 契約書別紙 / 個別援助計画書 / 選定提案書
      v_doc_types_new := ARRAY['change_contract', 'care_plan', 'proposal'];
    END IF;

    FOREACH v_doc_type IN ARRAY v_doc_types_new
    LOOP
      INSERT INTO doc_tasks (
        tenant_id, office_id, client_id,
        trigger_type, trigger_ref_id, trigger_ref_table,
        trigger_label, trigger_date, expected_doc_type
      ) VALUES (
        v_tenant_id, v_office_id, v_client_id,
        'rental_started', NEW.id, 'order_items',
        'レンタル開始 ' || v_trigger_date::text,
        v_trigger_date, v_doc_type
      )
      ON CONFLICT (trigger_type, trigger_ref_id, expected_doc_type) DO NOTHING;
    END LOOP;
  END IF;

  -- ── (b) 一部解約 (rental_started → 非 rental_started、active 残 > 0) ──
  IF (TG_OP = 'UPDATE' AND OLD.status = 'rental_started'
      AND NEW.status IS DISTINCT FROM 'rental_started')
     OR (TG_OP = 'DELETE' AND OLD.status = 'rental_started') THEN
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

      -- 契約書別紙 / 個別援助計画書 (変更なし、proposal は対象外)
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

-- trigger 自体は既存と同じ (関数の中身を CREATE OR REPLACE で上書きするだけ)

COMMIT;
