-- care_offices.plan_kubun — 伝送 7131/7132 基本 (01) 項19「居宅サービス計画作成区分コード」を事業所ごとに持つ  2026-11-09 ★ 未適用
--
-- 背景:
--   lib/kokuho-densou/build.ts は項19 を「居宅事業所番号があれば "1"、無ければ "2"」で決めている。
--   ほのぼの福祉用具の実伝送 (KK261004 / 提供 2026-09) では 区分 3 (介護予防支援事業所・地域包括支援センター作成) が
--   46 レセプトあり、事業所は次の 5 つだけ (全部 tenant kt-group の care_offices に実在。2026-11-09 DRY RUN で確認):
--     1201100029 木更津市南部地域包括支援センター      8 名
--     1201100011 予防中郷記念館介護相談センター        4 名
--     1201100078 木更津市富来田地域包括支援センター     1 名
--     1202400014 予防ムツミ居宅介護支援事業所         30 名
--     1203400013 予防サニーヒル居宅介護支援センター     3 名
--   この 5 つを区別する列を足す (build.ts 側の切替は別作業。この SQL は列と値だけ)。
--
-- 値:  '1' = 居宅介護支援事業所 (既定) / '3' = 介護予防支援事業所・地域包括支援センター
--      ('2' 自己作成 は事業所の属性ではないので持たない)
--
-- 影響: 列追加 (DEFAULT '1' NOT NULL) と 5 行の UPDATE だけ。既存の列・行は変えない。
--       care_offices に updated_at 以外の trigger は無い (_dump_schema.sql 時点。適用前に pg_trigger で再確認)
-- ⚠ Supabase SQL Editor は COMMIT が無いと終了時に rollback されるので、このまま 1 ブロックで流す。
-- 適用後は migrations/applied_archive/ (ルート) へ移すこと。
-- ============================================================

BEGIN;

ALTER TABLE care_offices ADD COLUMN IF NOT EXISTS plan_kubun TEXT NOT NULL DEFAULT '1';

ALTER TABLE care_offices DROP CONSTRAINT IF EXISTS care_offices_plan_kubun_check;
ALTER TABLE care_offices ADD CONSTRAINT care_offices_plan_kubun_check CHECK (plan_kubun IN ('1', '3'));

COMMENT ON COLUMN care_offices.plan_kubun IS
  '伝送 7131/7132 項19 居宅サービス計画作成区分コード。1=居宅介護支援事業所 / 3=介護予防支援事業所・地域包括支援センター (2026-11-09 ほのぼの福祉用具の実伝送から)';

UPDATE care_offices
   SET plan_kubun = '3'
 WHERE tenant_id = 'kt-group'
   AND office_number IN ('1201100029', '1201100011', '1201100078', '1202400014', '1203400013');

-- 確認: 5 行が '3' になっていること (5 でなければ ROLLBACK; して原因を見る)
SELECT office_number, name, plan_kubun
  FROM care_offices
 WHERE tenant_id = 'kt-group' AND plan_kubun = '3'
 ORDER BY office_number;

COMMIT;
