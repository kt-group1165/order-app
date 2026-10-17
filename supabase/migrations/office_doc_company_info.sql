-- 帳票の会社欄を事業所ごとに持つ (order-app 設定 → 会社情報)
--
-- 2026-10-17 まで帳票 (重要事項説明書・契約書・個別援助計画書・選定提案書・貸与報告書 等) の会社欄は
-- テナント (グループ) で 1 つ (tenants.company_name 等) で、しかも未入力のため「○○福祉用具」「0000000000」が出ていた。
-- kt-group にはケア・サポート千葉 (ケイ・ティ・サービス)・リンクス福祉用具 (儀八) など法人も指定番号も違う事業所があるため、
-- 事業所ごとに持つ。値の優先順は lib/officeCompanyInfo.ts:
--   offices.doc_company_info (ここ) > 事業所・法人マスタ (offices.name / business_number / address / phone / fax / manager_name, companies.name) > tenants.*
-- 中身は tenants と同じキー (company_name / business_number / company_address / company_tel / staff_name / legal_name /
-- service_area / business_days / business_hours / staff_*_full / staff_*_part)。マスタと同じ値は保存しない。
--
-- 影響範囲: offices に NULL 可の列を 1 つ足すだけ。kaigo-app / calendar-app / payroll-app は読まない。
--
-- ロールバック:
--   ALTER TABLE offices DROP COLUMN IF EXISTS doc_company_info;

BEGIN;

ALTER TABLE offices
  ADD COLUMN IF NOT EXISTS doc_company_info JSONB;

COMMENT ON COLUMN offices.doc_company_info IS
  'order-app の帳票の会社欄 (事業所ごとの上書き)。lib/officeCompanyInfo.ts';

COMMIT;

-- 確認 (1 行・jsonb が返れば OK)
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'offices' AND column_name = 'doc_company_info';
