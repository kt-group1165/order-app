-- 用具マスタを「品目 (TAIS ごとに 1 つ) + サイズ・型」の 2 段にする (2026-11-13 user 決定)
--
--   品目 (親)        parent_product_code IS NULL。TAIS・価格 (事業所 × 適用開始月)・請求はここ
--   サイズ・型 (子)  parent_product_code = 親の product_code。貸与・在庫・発注の単位。価格は持たない
--                    model_number (メーカー型番) / attributes (種類と値: 幅・長さ・色 …) / variant_label (選ぶときの表示)
--
--   価格・TAIS は 子を引いても 親のものを使う (order-app lib/equipment.ts getEquipment / getPriceHistory が親から写す)。
--   貸与・発注・仕入価格は今までどおり product_code で品目を指す (子の product_code をそのまま使う) → 既存データは作り直さない。
--
--   ★ この SQL は 列を足すだけ。今の行は全部 parent_product_code = NULL (= 親) のまま → 請求額は 1 円も変わらない。
--   ★ 「同じ TAIS の親は 1 つだけ」の一意制約は、重複をまとめてから 別の SQL で付ける (今付けると重複で失敗する)。
--
-- 実行: Supabase SQL Editor に 全部を貼って Run (BEGIN〜COMMIT が 1 ブロック)。済んだら migrations/applied_archive/ へ移す。
-- 戻す (必要なら): DROP INDEX idx_equipment_master_parent; ALTER TABLE ... DROP COLUMN の 5 本

BEGIN;

ALTER TABLE public.equipment_master
  ADD COLUMN IF NOT EXISTS parent_product_code text NULL,
  ADD COLUMN IF NOT EXISTS model_number        text NULL,
  ADD COLUMN IF NOT EXISTS attributes          jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS variant_label       text NULL,
  ADD COLUMN IF NOT EXISTS attribute_options   jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.equipment_master.attribute_options IS
  '品目 (親) で選べる属性と値 {種類: [値, …]} 例 {"幅":["83","91"],"長さ":["ミニ","レギュラー"]}。サイズ・型 (子) は組み合わせを全部作らず、実際に発注・在庫・貸与したものだけ作る';

COMMENT ON COLUMN public.equipment_master.parent_product_code IS
  'サイズ・型の行が属する品目 (親) の product_code。NULL = 品目 (親)。価格・TAIS・請求は親のものを使う (order-app lib/equipment.ts)';
COMMENT ON COLUMN public.equipment_master.model_number IS 'メーカー型番 (KQ-82330 など)。卸への発注にも使う';
COMMENT ON COLUMN public.equipment_master.attributes IS
  'サイズ・型の属性 {種類: 値}。種類の例: 幅 / 長さ / 手すりの長さ / 高さ / 本数 / 形 / 座幅 / 色 / モーター数 / 操作 / 左右 / サイズ / タイヤ / 硬さ';
COMMENT ON COLUMN public.equipment_master.variant_label IS '選ぶときの表示 (「91幅 レギュラー ブルー」など)';

CREATE INDEX IF NOT EXISTS idx_equipment_master_parent
  ON public.equipment_master (tenant_id, parent_product_code)
  WHERE parent_product_code IS NOT NULL;

-- 子が子を指さない (2 段まで) ・自分自身を指さない
ALTER TABLE public.equipment_master DROP CONSTRAINT IF EXISTS equipment_master_parent_not_self;
ALTER TABLE public.equipment_master
  ADD CONSTRAINT equipment_master_parent_not_self CHECK (parent_product_code IS NULL OR parent_product_code <> product_code);

-- 確認 (同じ実行の中で): 列が足され、今の行は全部 親 のまま
SELECT count(*) AS rows_total, count(parent_product_code) AS rows_with_parent FROM public.equipment_master;

COMMIT;
