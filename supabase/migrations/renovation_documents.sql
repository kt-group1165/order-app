-- 住宅改修の書類データ (見積書・理由書・承諾書・支給申請書・領収書・送付状) を案件に持たせる
--
-- 旧 Excel「<利用者>様住改見積.xlsx」の置換。請求はシステム外 (2026-10-15 user 回答) なので、
-- 書類の印字に使う入力 (見積の明細・理由書の文章とチェック・所有者・領収額など) だけを保存する。
-- 中身の形は apps/order-app/lib/renovationDocs.ts の RenovationDocs 型。
-- 1 案件 = 1 セットなので別表にせず jsonb 1 列にする (書類の項目は様式の改定で増減するため)。
--
-- 影響範囲: renovation_projects に NULL 可の列を 1 つ足すだけ。既存 787 行は NULL のまま
--   (画面側で既定値に補完する)。RLS は既存の renovation_projects_* policy がそのまま効く。
--
-- ロールバック:
--   ALTER TABLE renovation_projects DROP COLUMN IF EXISTS documents;

BEGIN;

ALTER TABLE renovation_projects
  ADD COLUMN IF NOT EXISTS documents JSONB;

COMMENT ON COLUMN renovation_projects.documents IS
  '住宅改修の書類の入力データ (lib/renovationDocs.ts RenovationDocs)。NULL = 未作成';

COMMIT;

-- 確認 (1 行・data_type = jsonb が返れば OK)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'renovation_projects' AND column_name = 'documents';
