-- migrations/order_app_care_plan_elements_triggers.sql
-- Phase: order-app 個別援助計画書 要素ベース化 — DB trigger
-- 作成: 2026-05-12
--
-- 適用前提:
--   - migrations/order_app_care_plan_elements.sql 適用済 (table 存在)
--
-- trigger 設計:
--   1) order_items → new_delivery / additional_delivery / pickup
--      - rental_started 化:
--          同 client 内に他の active rental_started item が既にある → additional_delivery
--          無い → new_delivery
--      - rental_started → 非 rental_started (一部解約):
--          同 client 内に他の active rental_started が残っている → pickup
--          残っていない (= 全解約) → 何もしない (要素発生させない)
--
--   2) client_insurance_records → plan_renewal / plan_change / care_office_change
--      INSERT 時に同 client の直前 record (effective_date DESC) と比較:
--      - 前回が無い、または前回 care_level が NULL/'申請中'/'apply' → 初回認定なので
--        plan_renewal / plan_change は発火しない (新規納品とセットで扱う)
--      - new.cert_start = prev.cert_end + 1 → plan_renewal
--      - 上記以外で new.cert_start < prev.cert_end (期間中の差し込み) → plan_change
--      - new.care_office_id ≠ prev.care_office_id → care_office_change (独立 OR)
--
--   ON CONFLICT DO NOTHING で UNIQUE(element_type, ref_table, ref_id) による
--   重複 INSERT を防ぐ。
--
-- 適用方法:
--   Supabase SQL Editor で 1 ファイルとして実行。

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- 1) order_items → new_delivery / additional_delivery / pickup
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_care_plan_elements_from_order_items()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id     TEXT;
  v_office_id     UUID;
  v_client_id     UUID;
  v_target_id     UUID;
  v_other_active  INT;
  v_equipment_name TEXT;
  v_occurred_at   DATE;
  v_element_type  TEXT;
BEGIN
  -- DELETE は OLD を使う
  IF TG_OP = 'DELETE' THEN
    v_target_id := OLD.id;
  ELSE
    v_target_id := NEW.id;
  END IF;

  -- orders から tenant/office/client を取る (order_items 単体には無い)
  SELECT o.tenant_id, o.office_id, o.client_id
    INTO v_tenant_id, v_office_id, v_client_id
    FROM orders o
   WHERE o.id = COALESCE(NEW.order_id, OLD.order_id);

  IF v_office_id IS NULL OR v_client_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- 用具名 (detail JSONB 用)
  SELECT name INTO v_equipment_name
    FROM equipment_master
   WHERE product_code = COALESCE(NEW.product_code, OLD.product_code)
   LIMIT 1;

  -- ── (a) rental_started 化 → new_delivery / additional_delivery ──
  IF (TG_OP = 'INSERT' AND NEW.status = 'rental_started')
     OR (TG_OP = 'UPDATE' AND NEW.status = 'rental_started'
         AND OLD.status IS DISTINCT FROM 'rental_started') THEN

    v_occurred_at := COALESCE(NEW.rental_start_date, CURRENT_DATE);

    -- 同 client 内に「この item 以外」の active rental_started が既にあるか
    SELECT COUNT(*)
      INTO v_other_active
      FROM order_items oi
      JOIN orders o2 ON o2.id = oi.order_id
     WHERE o2.client_id = v_client_id
       AND oi.status = 'rental_started'
       AND oi.id <> NEW.id;

    IF v_other_active > 0 THEN
      v_element_type := 'additional_delivery';
    ELSE
      v_element_type := 'new_delivery';
    END IF;

    INSERT INTO care_plan_elements (
      tenant_id, office_id, client_id, occurred_at,
      element_type, ref_table, ref_id, detail
    ) VALUES (
      v_tenant_id, v_office_id, v_client_id, v_occurred_at,
      v_element_type, 'order_items', NEW.id,
      jsonb_build_object(
        'equipment_name', v_equipment_name,
        'product_code',   NEW.product_code
      )
    )
    ON CONFLICT (element_type, ref_table, ref_id) DO NOTHING;
  END IF;

  -- ── (b) rental_started → 非 rental_started (一部解約) ──
  IF (TG_OP = 'UPDATE' AND OLD.status = 'rental_started'
      AND NEW.status IS DISTINCT FROM 'rental_started')
     OR (TG_OP = 'DELETE' AND OLD.status = 'rental_started') THEN

    -- 残りの active rental_started 数 (この item を除く)
    SELECT COUNT(*)
      INTO v_other_active
      FROM order_items oi
      JOIN orders o2 ON o2.id = oi.order_id
     WHERE o2.client_id = v_client_id
       AND oi.status = 'rental_started'
       AND oi.id <> v_target_id;

    -- 残 > 0 のみ pickup (= 一部解約)。0 件は全解約なので発火しない
    IF v_other_active > 0 THEN
      v_occurred_at := COALESCE(
        OLD.rental_end_date,
        OLD.cancelled_at::date,
        CURRENT_DATE
      );

      INSERT INTO care_plan_elements (
        tenant_id, office_id, client_id, occurred_at,
        element_type, ref_table, ref_id, detail
      ) VALUES (
        v_tenant_id, v_office_id, v_client_id, v_occurred_at,
        'pickup', 'order_items', OLD.id,
        jsonb_build_object(
          'equipment_name', v_equipment_name,
          'product_code',   OLD.product_code
        )
      )
      ON CONFLICT (element_type, ref_table, ref_id) DO NOTHING;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_care_plan_elements_order_items ON order_items;
CREATE TRIGGER trg_care_plan_elements_order_items
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION fn_care_plan_elements_from_order_items();

-- ─────────────────────────────────────────────────────────────────────
-- 2) client_insurance_records → plan_renewal / plan_change / care_office_change
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_care_plan_elements_from_insurance()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id   TEXT;
  v_office_id   UUID;
  v_prev        client_insurance_records%ROWTYPE;
  v_from_office TEXT;
  v_to_office   TEXT;
  v_occurred_at DATE;
BEGIN
  -- clients から tenant_id / office_id を取る
  SELECT c.tenant_id, c.office_id
    INTO v_tenant_id, v_office_id
    FROM clients c
   WHERE c.id = NEW.client_id;

  IF v_office_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 直前の record (この行を除く、effective_date DESC で 1 行) を取得
  SELECT *
    INTO v_prev
    FROM client_insurance_records
   WHERE client_id = NEW.client_id
     AND id <> NEW.id
   ORDER BY
     COALESCE(effective_date, certification_start_date, created_at::date) DESC,
     created_at DESC
   LIMIT 1;

  v_occurred_at := COALESCE(
    NEW.effective_date,
    NEW.certification_start_date,
    NEW.created_at::date,
    CURRENT_DATE
  );

  -- 前回が無い OR 前回 care_level が NULL/'申請中'/'apply' → 初回認定 → 発火しない
  IF v_prev.id IS NOT NULL
     AND v_prev.care_level IS NOT NULL
     AND v_prev.care_level <> ''
     AND v_prev.care_level NOT IN ('申請中', 'apply') THEN

    -- (a) plan_renewal: 期間連続 (new start = prev end + 1)
    IF NEW.certification_start_date IS NOT NULL
       AND v_prev.certification_end_date IS NOT NULL
       AND NEW.certification_start_date = v_prev.certification_end_date + INTERVAL '1 day' THEN

      INSERT INTO care_plan_elements (
        tenant_id, office_id, client_id, occurred_at,
        element_type, ref_table, ref_id, detail
      ) VALUES (
        v_tenant_id, v_office_id, NEW.client_id, v_occurred_at,
        'plan_renewal', 'client_insurance_records', NEW.id,
        jsonb_build_object(
          'from_care_level', v_prev.care_level,
          'to_care_level',   NEW.care_level,
          'cert_start',      NEW.certification_start_date,
          'cert_end',        NEW.certification_end_date
        )
      )
      ON CONFLICT (element_type, ref_table, ref_id) DO NOTHING;

    -- (b) plan_change: 期間中の差し込み (new start < prev end) AND care_level 変化
    ELSIF NEW.certification_start_date IS NOT NULL
          AND v_prev.certification_end_date IS NOT NULL
          AND NEW.certification_start_date < v_prev.certification_end_date
          AND NEW.care_level IS DISTINCT FROM v_prev.care_level THEN

      INSERT INTO care_plan_elements (
        tenant_id, office_id, client_id, occurred_at,
        element_type, ref_table, ref_id, detail
      ) VALUES (
        v_tenant_id, v_office_id, NEW.client_id, v_occurred_at,
        'plan_change', 'client_insurance_records', NEW.id,
        jsonb_build_object(
          'from_care_level', v_prev.care_level,
          'to_care_level',   NEW.care_level,
          'cert_start',      NEW.certification_start_date,
          'cert_end',        NEW.certification_end_date
        )
      )
      ON CONFLICT (element_type, ref_table, ref_id) DO NOTHING;
    END IF;

    -- (c) care_office_change: 独立判定 (期間更新/区分変更とは並列)
    IF NEW.care_office_id IS DISTINCT FROM v_prev.care_office_id THEN
      SELECT name INTO v_from_office FROM care_offices WHERE id = v_prev.care_office_id;
      SELECT name INTO v_to_office   FROM care_offices WHERE id = NEW.care_office_id;

      INSERT INTO care_plan_elements (
        tenant_id, office_id, client_id, occurred_at,
        element_type, ref_table, ref_id, detail
      ) VALUES (
        v_tenant_id, v_office_id, NEW.client_id, v_occurred_at,
        'care_office_change', 'client_insurance_records', NEW.id,
        jsonb_build_object(
          'from_care_office_id',   v_prev.care_office_id,
          'to_care_office_id',     NEW.care_office_id,
          'from_care_office_name', v_from_office,
          'to_care_office_name',   v_to_office
        )
      )
      ON CONFLICT (element_type, ref_table, ref_id) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_care_plan_elements_insurance ON client_insurance_records;
CREATE TRIGGER trg_care_plan_elements_insurance
  AFTER INSERT ON client_insurance_records
  FOR EACH ROW EXECUTE FUNCTION fn_care_plan_elements_from_insurance();

COMMIT;
