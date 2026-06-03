-- =====================================================================
-- clients dedup (2026-06-02) — 758 ペア merge + 削除
-- =====================================================================
-- 背景:
--   R8_4kaigo (国保連請求 CSV) 取込 (2026-05-09 Stage A) で既存 clients と
--   被保険者番号未一致のため 重複 client が大量に作成された。
--
--   症状:
--     - 同一人物が 2 行 clients に存在
--     - 1 行は古い (insured_number NULL)
--     - 1 行は R8_4kaigo 由来 (insured_number 有、orders/billing 紐付き)
--
-- 前提作業:
--   - Phase 1 (address update): 661 件の姉崎323番地を CSV 値で更新
--   - Phase 1.5: 怪しい office phone 5 種を NULL 化
--   - Phase 2: CSV マスター同期 (先頭ゼロ正規化で +402 件)
--   - 2 件 手動 fix (被保番変更ケース: 相川なか 含まず、佐久間政枝・山本圭子)
--
-- このスクリプト:
--   - 同名・同フリガナ・同住所 の 758 ペア を merge
--   - keep_id = insured_number 持ち side
--   - delete_id = NULL 側 (両方 NULL なら id 順)
--   - keep 側 の NULL 列を delete 側 の値で COALESCE 補完
--   - 4 つの FK table で client_id 移行 (3108 件)
--     care_plan_elements, client_memos, events, shared_documents
--   - 他 32 FK table は delete 側に refs 無し (R8_4kaigo 取込が keep 側に
--     orders/billing/kaigo_* を全部つけたため)
--   - DELETE 758 件 (= delete 側の clients 行)
--
-- 実績: remaining_dups = 0
--
-- ロールバック:
--   _backup_clients_dedup_20260602 (1516 行) から復元可能
-- =====================================================================

BEGIN;

CREATE TEMP TABLE merge_map AS
SELECT
  CASE WHEN ca.insured_number IS NULL THEN ca.id ELSE cb.id END AS delete_id,
  CASE WHEN ca.insured_number IS NULL THEN cb.id ELSE ca.id END AS keep_id
FROM clients ca
JOIN clients cb
  ON ca.name = cb.name
  AND ca.furigana = cb.furigana
  AND ca.address = cb.address
  AND ca.id < cb.id
WHERE ca.tenant_id = 'kt-group' AND cb.tenant_id = 'kt-group';

-- 属性補完: keep 側の NULL 列を delete 側の値で埋める
UPDATE clients kc
SET
  birth_date  = COALESCE(kc.birth_date,  dc.birth_date),
  gender      = COALESCE(kc.gender,      dc.gender),
  furigana    = COALESCE(kc.furigana,    dc.furigana),
  phone       = COALESCE(kc.phone,       dc.phone),
  postal_code = COALESCE(kc.postal_code, dc.postal_code),
  address     = COALESCE(kc.address,     dc.address)
FROM merge_map m
JOIN clients dc ON dc.id = m.delete_id
WHERE kc.id = m.keep_id;

-- FK 移行 (delete_id → keep_id) — 4 table 計 3108 件
UPDATE care_plan_elements SET client_id = m.keep_id
FROM merge_map m WHERE care_plan_elements.client_id = m.delete_id;  -- 2311 件

UPDATE client_memos SET client_id = m.keep_id
FROM merge_map m WHERE client_memos.client_id = m.delete_id;         -- 725 件

UPDATE events SET client_id = m.keep_id
FROM merge_map m WHERE events.client_id = m.delete_id;               -- 70 件

UPDATE shared_documents SET client_id = m.keep_id
FROM merge_map m WHERE shared_documents.client_id = m.delete_id;     -- 2 件

-- 重複 client 削除
DELETE FROM clients
WHERE id IN (SELECT delete_id FROM merge_map);                       -- 758 件

COMMIT;

-- 検証 (適用後): 0 になること
-- SELECT COUNT(*) FROM (
--   SELECT name, furigana, address FROM clients
--   WHERE tenant_id = 'kt-group'
--   GROUP BY name, furigana, address HAVING COUNT(*) >= 2
-- ) d;
