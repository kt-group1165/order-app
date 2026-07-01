-- =====================================================================
-- 福祉用具マスタ拡張: セット構成 (BOM) + 卸別 offering 履歴化 + 粗利 view
-- =====================================================================
-- 目的:
--   層1) equipment_master に kind ('single' / 'set') を追加してセット親を識別
--   層2) equipment_prices を「卸別 offering (同一商品×複数卸×時期別)」として
--        履歴化 (valid_from + is_active + supplier_product_code)
--   層3) セット構成を表す BOM テーブル equipment_set_items を新規作成
--        (RLS 有効化 + order-app 既存 tenant-scoped policy を複製)
--   発注) order_items に請求単位フラグ tokka_bill_product_code を追加
--   粗利) v_order_margin (security_invoker) を明細粒度で作成
--
-- 適用方法:
--   Supabase ダッシュボードの SQL Editor に「この 1 ファイル全体」を貼り付けて
--   Run すること。全体が BEGIN; ... COMMIT; で 1 トランザクションになっている。
--   ※ BEGIN; だけで COMMIT; を忘れると実行終了時に auto-rollback されるので注意。
--
-- 冪等性: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS /
--   CREATE INDEX IF NOT EXISTS / 制約は pg_constraint 存在チェック後に追加。
--   再実行しても壊れない。
-- =====================================================================

BEGIN;

-- ── 0. バックアップ snapshot ───────────────────────────────────────
-- 層2 で equipment_prices に列追加 + valid_from backfill を行うため、
-- 適用前の equipment_prices を丸ごと退避しておく。
-- 完了・検証後、不要になれば後日:  DROP TABLE _backup_equipment_prices_20260701;
CREATE TABLE IF NOT EXISTS _backup_equipment_prices_20260701 AS
SELECT * FROM equipment_prices;

-- ── 層1. equipment_master に kind 列 ──────────────────────────────
-- 'single' = 通常の単品、'set' = セット親 (構成は equipment_set_items が持つ)
ALTER TABLE equipment_master
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'single';

-- kind の許可値 CHECK 制約 (存在しなければ追加)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipment_master_kind_check'
  ) THEN
    ALTER TABLE equipment_master
      ADD CONSTRAINT equipment_master_kind_check
      CHECK (kind IN ('single', 'set'));
  END IF;
END $$;

-- ── 層2. equipment_prices を卸別 offering として履歴化 ─────────────
-- supplier_product_code: 卸側の実型番 (発注書に載る型番)
-- valid_from           : 仕入価格の有効開始日 (履歴化のキー)
-- is_active            : 現在有効な offering か (論理削除・切替用)
ALTER TABLE equipment_prices
  ADD COLUMN IF NOT EXISTS supplier_product_code TEXT DEFAULT NULL;
ALTER TABLE equipment_prices
  ADD COLUMN IF NOT EXISTS valid_from DATE;
ALTER TABLE equipment_prices
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

-- 既存行の valid_from を price_history と同じ基準日 (2020-01-01) で backfill
UPDATE equipment_prices
   SET valid_from = '2020-01-01'::DATE
 WHERE valid_from IS NULL;

-- backfill 後に NOT NULL 化 + 以後の新規行は当日を既定に
ALTER TABLE equipment_prices
  ALTER COLUMN valid_from SET NOT NULL;
ALTER TABLE equipment_prices
  ALTER COLUMN valid_from SET DEFAULT CURRENT_DATE;

-- 一意インデックス: 同一卸の同一商品×同一有効日の重複を防ぐ
-- (卸別 offering の履歴は valid_from で世代管理する前提)
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_prices_offering
  ON equipment_prices (tenant_id, product_code, supplier_id, valid_from);

-- 検索用 index: 「この商品×この卸の最新有効価格」を引くための降順キー
CREATE INDEX IF NOT EXISTS idx_equipment_prices_lookup
  ON equipment_prices (tenant_id, product_code, supplier_id, valid_from DESC);

-- ── 層3. セット構成 BOM テーブル equipment_set_items (新規) ─────────
-- 親 (set_product_code = equipment_master.kind='set') と
-- 子 (component_product_code) の多対多 + 数量を保持する BOM。
CREATE TABLE IF NOT EXISTS equipment_set_items (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  set_product_code      TEXT NOT NULL,       -- 親 (セット)
  component_product_code TEXT NOT NULL,      -- 子 (構成品)
  quantity              INTEGER NOT NULL DEFAULT 1,
  sort_order            INTEGER,
  created_at            TIMESTAMPTZ DEFAULT now()
);

-- 自己参照禁止 (親と子が同一 product_code は不正)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipment_set_items_no_self'
  ) THEN
    ALTER TABLE equipment_set_items
      ADD CONSTRAINT equipment_set_items_no_self
      CHECK (set_product_code <> component_product_code);
  END IF;
END $$;

-- 一意: 同一セットに同一構成品を二重登録させない
CREATE UNIQUE INDEX IF NOT EXISTS uq_equipment_set_items
  ON equipment_set_items (tenant_id, set_product_code, component_product_code);

-- 検索用: セット親ごとに sort_order 順で構成品を引く
CREATE INDEX IF NOT EXISTS idx_equipment_set_items_set
  ON equipment_set_items (tenant_id, set_product_code, sort_order);

-- RLS: order-app の他 tenant-scoped 表 (equipment_master 等) と同じパターン。
-- 参考: migrations/tier5_payroll/014_phase_3_6_order_app_authenticated.sql の
--       equipment_master_authenticated ポリシー
--       (FOR ALL TO authenticated / tenant_id IN (SELECT auth_visible_tenant_ids()))
ALTER TABLE equipment_set_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS equipment_set_items_authenticated ON equipment_set_items;
CREATE POLICY equipment_set_items_authenticated ON equipment_set_items
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

-- ── 発注. order_items に請求単位フラグ ────────────────────────────
-- NULL              = 各明細を単体 TAIS (product_code) で請求
-- セット親 product_code = 複数明細を束ねて、その親の TAIS で請求
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS tokka_bill_product_code TEXT DEFAULT NULL;

COMMENT ON COLUMN order_items.tokka_bill_product_code IS
  'NULL=各明細を単体TAISで請求 / セット親product_code=束ねてそのTAISで請求';

-- ── 粗利. v_order_margin (明細粒度) ───────────────────────────────
-- security_invoker=true: view 参照時に呼出元 (authenticated) の RLS を効かせる。
--   これを付けないと view 定義者 (=owner) 権限で全 tenant が見えてしまう。
-- 粒度は order_items 明細単位。セット単位の粗利は tokka_group で GROUP BY する
-- (下部のコメント参照)。cancelled 明細は除外。
CREATE OR REPLACE VIEW v_order_margin
  WITH (security_invoker = true) AS
SELECT
  oi.id                                                       AS order_item_id,
  oi.order_id                                                 AS order_id,
  oi.tenant_id                                                AS tenant_id,
  oi.product_code                                             AS product_code,
  oi.supplier_id                                              AS supplier_id,
  oi.tokka_group                                              AS tokka_group,
  oi.tokka_bill_product_code                                  AS tokka_bill_product_code,
  oi.quantity                                                 AS quantity,
  oi.rental_price                                             AS rental_price,
  oi.purchase_price                                           AS purchase_price,
  COALESCE(oi.rental_price, 0) - COALESCE(oi.purchase_price, 0) AS unit_margin,
  o.ordered_at                                                AS ordered_at,
  o.office_id                                                 AS office_id,
  o.client_id                                                 AS client_id
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.status <> 'cancelled';

COMMIT;

-- =====================================================================
-- 完了。
--
-- セット単位の粗利集計はこの view を tokka_group で束ねて出す:
--   SELECT tokka_group,
--          SUM(unit_margin) AS set_margin,
--          SUM(rental_price) AS set_rental,
--          SUM(purchase_price) AS set_purchase
--   FROM v_order_margin
--   WHERE tenant_id = '<tenant>' AND tokka_group IS NOT NULL
--   GROUP BY tokka_group;
--
-- 検証クエリ (適用後に確認):
--   -- kind 列
--   SELECT kind, count(*) FROM equipment_master GROUP BY kind;
--   -- offering 履歴列の backfill
--   SELECT count(*) FILTER (WHERE valid_from IS NULL) AS null_valid_from
--   FROM equipment_prices;   -- 期待: 0
--   -- 新規表の RLS
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'equipment_set_items';
--   SELECT policyname, cmd, roles FROM pg_policies
--   WHERE tablename = 'equipment_set_items';
-- =====================================================================
