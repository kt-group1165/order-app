-- =====================================================================
-- 利用請求書 番号採番 (billing_user_invoices に発行番号列を追加)
-- =====================================================================
--   請求書/領収書 発行時に tenant 内で連番を採番して DB に保存する。
--   採番方式: tenant 内 max(invoice_no)+1、invoice_year は発行年(西暦)。
--   表示形式: {invoice_year}-{invoice_no を4桁ゼロ埋め}  (例: 2026-0001)
--   (page.tsx 側の invoices テーブル InvoiceReceiptModal とは別系統。
--    UserBillingTab の請求書/領収書は billing_user_invoices が正)
--
-- 適用方法: Supabase SQL Editor にこのファイル全体を貼り付けて Run。
--           BEGIN; ... COMMIT; の 1 トランザクション。再実行しても壊れない(冪等)。
-- =====================================================================

BEGIN;

ALTER TABLE billing_user_invoices
  ADD COLUMN IF NOT EXISTS invoice_no   INTEGER;
ALTER TABLE billing_user_invoices
  ADD COLUMN IF NOT EXISTS invoice_year INTEGER;

-- 採番済番号の重複防止 (tenant × year × no は一意)。
-- 部分 index: 採番済 (invoice_no NOT NULL) のみ対象。
CREATE UNIQUE INDEX IF NOT EXISTS billing_user_invoices_no_unique
  ON billing_user_invoices (tenant_id, invoice_year, invoice_no)
  WHERE invoice_no IS NOT NULL;

COMMIT;

-- 検証 (適用後):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'billing_user_invoices'
--     AND column_name IN ('invoice_no','invoice_year');
