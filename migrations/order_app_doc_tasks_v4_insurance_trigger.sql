-- migrations/order_app_doc_tasks_v4_insurance_trigger.sql
-- Phase: order-app doc_tasks v4 — insurance_records → plan_change / care_office_change cascade
-- 作成: 2026-05-13
--
-- 背景:
--   user 仕様で plan_change (期間中の区分変更) は「契約書別紙 + 個別援助計画書 +
--   提案書」、care_office_change (居宅変更) は「個別援助計画書」が必要書類。
--   これらを doc_tasks の書類タスクとして自動発火する trigger を追加。
--
--   既存 trigger_type CHECK ('order_placed', 'rental_started',
--   'partial_termination', 'cert_renewal') に 'plan_change' / 'care_office_change'
--   を追加する。
--
-- 適用方法:
--   Supabase SQL Editor で 1 ファイルとして実行。
--   (前提: order_app_doc_tasks_v2.sql + v4_trigger_split.sql 適用済)

BEGIN;

-- 1. trigger_type CHECK 制約を拡張
ALTER TABLE doc_tasks DROP CONSTRAINT IF EXISTS doc_tasks_trigger_type_check;
ALTER TABLE doc_tasks ADD CONSTRAINT doc_tasks_trigger_type_check
  CHECK (trigger_type IN (
    'order_placed',
    'rental_started',
    'partial_termination',
    'cert_renewal',
    'plan_change',
    'care_office_change'
  ));

-- 2. insurance_records 観測 trigger 関数
CREATE OR REPLACE FUNCTION fn_doc_tasks_from_insurance()
RETURNS TRIGGER AS $$
DECLARE
  v_tenant_id   TEXT;
  v_office_id   UUID;
  v_prev        client_insurance_records%ROWTYPE;
  v_trigger_date DATE;
  v_doc_type    TEXT;
BEGIN
  -- clients から tenant_id / office_id
  SELECT c.tenant_id, c.office_id
    INTO v_tenant_id, v_office_id
    FROM clients c
   WHERE c.id = NEW.client_id;
  IF v_office_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 直前の record (この行を除く)
  SELECT *
    INTO v_prev
    FROM client_insurance_records
   WHERE client_id = NEW.client_id
     AND id <> NEW.id
   ORDER BY
     COALESCE(effective_date, certification_start_date, created_at::date) DESC,
     created_at DESC
   LIMIT 1;

  v_trigger_date := COALESCE(
    NEW.effective_date,
    NEW.certification_start_date,
    NEW.created_at::date,
    CURRENT_DATE
  );

  -- 前回が無い or care_level が NULL/'申請中'/'apply' → 初回認定なので skip
  IF v_prev.id IS NULL
     OR v_prev.care_level IS NULL
     OR v_prev.care_level = ''
     OR v_prev.care_level IN ('申請中', 'apply') THEN
    RETURN NEW;
  END IF;

  -- (a) plan_change: 期間中差し込み (new start < prev end) + care_level 変化
  --     → 契約書別紙 / 個別援助計画書 / 選定提案書 の 3 種
  --     注意: 期間連続 (new start = prev end + 1 = plan_renewal) は対象外 (cert_renewal で扱う)
  IF NEW.certification_start_date IS NOT NULL
     AND v_prev.certification_end_date IS NOT NULL
     AND NEW.certification_start_date < v_prev.certification_end_date
     AND NEW.care_level IS DISTINCT FROM v_prev.care_level THEN
    FOREACH v_doc_type IN ARRAY ARRAY['change_contract', 'care_plan', 'proposal']
    LOOP
      INSERT INTO doc_tasks (
        tenant_id, office_id, client_id,
        trigger_type, trigger_ref_id, trigger_ref_table,
        trigger_label, trigger_date, expected_doc_type
      ) VALUES (
        v_tenant_id, v_office_id, NEW.client_id,
        'plan_change', NEW.id, 'client_insurance_records',
        'プラン変更 ' || v_trigger_date::text,
        v_trigger_date, v_doc_type
      )
      ON CONFLICT (trigger_type, trigger_ref_id, expected_doc_type) DO NOTHING;
    END LOOP;
  END IF;

  -- (b) care_office_change: 居宅事業所変更 → 個別援助計画書のみ
  IF NEW.care_office_id IS DISTINCT FROM v_prev.care_office_id THEN
    INSERT INTO doc_tasks (
      tenant_id, office_id, client_id,
      trigger_type, trigger_ref_id, trigger_ref_table,
      trigger_label, trigger_date, expected_doc_type
    ) VALUES (
      v_tenant_id, v_office_id, NEW.client_id,
      'care_office_change', NEW.id, 'client_insurance_records',
      '居宅変更 ' || v_trigger_date::text,
      v_trigger_date, 'care_plan'
    )
    ON CONFLICT (trigger_type, trigger_ref_id, expected_doc_type) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_doc_tasks_insurance ON client_insurance_records;
CREATE TRIGGER trg_doc_tasks_insurance
  AFTER INSERT ON client_insurance_records
  FOR EACH ROW EXECUTE FUNCTION fn_doc_tasks_from_insurance();

COMMIT;
