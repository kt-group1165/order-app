-- 用具の価格を 事業所ごとに 履歴付きで持つ (2026-11-13 user 決定 a)
--   equipment_price_history に office_id (NULL = 全事業所共通 = 今までの行) を足す。
--   価格の決め方 (lib/equipment.ts getPriceForMonth): その事業所の行 → 共通の行 (office_id IS NULL) → equipment_master.rental_price
--   ★ 今ある行は全部 office_id = NULL (共通) のまま → この SQL だけでは 請求額は 1 円も変わらない。
--
-- 一意制約: 今までは無かった (主キーと検索用の index だけ)。同じ日に 2 つの価格があると どちらを使うか決まらないので足す。
--   共通の行      : (tenant_id, product_code, valid_from)            WHERE office_id IS NULL
--   事業所の行    : (tenant_id, product_code, office_id, valid_from) WHERE office_id IS NOT NULL
--   2026-11-13 の控え (688 行) で (product_code, valid_from) の重複は 0 件。重複があれば CREATE UNIQUE INDEX が失敗し、全体が ROLLBACK される。
--   先に確かめるなら (BEGIN の前に 単独で):
--     SELECT tenant_id, product_code, valid_from, count(*) FROM public.equipment_price_history
--     GROUP BY 1, 2, 3 HAVING count(*) > 1;
--
-- 実行: Supabase SQL Editor に 全部を貼って Run (BEGIN〜COMMIT が 1 ブロック)。済んだら migrations/applied_archive/ へ移す。
-- 戻す (必要なら): DROP INDEX の 2 本 → 元の index を作り直す → ALTER TABLE ... DROP COLUMN office_id

BEGIN;

ALTER TABLE public.equipment_price_history
  ADD COLUMN IF NOT EXISTS office_id uuid NULL REFERENCES public.offices(id);

COMMENT ON COLUMN public.equipment_price_history.office_id IS
  '価格を持つ事業所。NULL = 全事業所共通。価格は その事業所の行 → 共通の行 → equipment_master.rental_price の順に引く (order-app lib/equipment.ts getPriceForMonth)';

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_history_common
  ON public.equipment_price_history (tenant_id, product_code, valid_from)
  WHERE office_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_price_history_office
  ON public.equipment_price_history (tenant_id, product_code, office_id, valid_from)
  WHERE office_id IS NOT NULL;

-- 検索用 (事業所の行を引く)。今の idx_price_history_lookup (tenant_id, product_code, valid_from DESC) はそのまま
CREATE INDEX IF NOT EXISTS idx_price_history_office_lookup
  ON public.equipment_price_history (tenant_id, office_id, product_code, valid_from DESC)
  WHERE office_id IS NOT NULL;

-- 確認 (同じ実行の中で): 列が足され、今の行は全部 共通 (NULL) のまま
SELECT count(*) AS rows_total, count(office_id) AS rows_with_office FROM public.equipment_price_history;

COMMIT;
