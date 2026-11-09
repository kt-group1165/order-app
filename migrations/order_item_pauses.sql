-- ============================================================
-- 福祉用具 貸与の休止期間 order_item_pauses (2026-11-09 FY-PZ)
-- ============================================================
-- 背景:
--   貸与 (order_items) を ほのぼのの提供票 (日ごとの実績の印) から組み直したとき
--   (migrations/rebuild_rentals_from_teikyohyo.mjs、batch 8583d46b)、月の途中に使わない日がある台
--   (入院等の休止。2026-11-09 実測 147 明細 / 179 期間) は 1 明細のまま notes に "[休止 YYYY-MM-DD〜YYYY-MM-DD]" を書いた。
--   ほのぼのは伝送の明細 (7131/7132-02) 項10 日数を「実績の印の数」= 休止日を除いた日数で出す
--   (KK261004 で確認。例 山口 裕 17 日 / 江藤 久美 12 日 / 小川 幸江 18 日。当方は 30 日で出していた)。
--   半月按分 (前半・後半の両方に貸与日 → 満額) も休止日を除いた貸与日で判定する
--   (提供票の休止のある実績行 279 行中 277 行で 日割区分 と一致)。
--
-- 1 行 = 1 明細の 1 つの休止期間 (両端含む)。1 明細に休止が何回あってもよい (行を分ける)。
--   pause_from〜pause_to は「貸与しなかった日」。貸与期間 (rental_start_date〜rental_end_date) の外は意味を持たない。
--
-- ── notes 文字列で持つ案との比較 ──────────────────────────────────────────
--   notes の "[休止 …]" のままにすると、① 請求画面・伝送・突合 script がそれぞれ文字列を解析することになり
--   (書式ゆれ・全角チルダ・手で書き換えた notes を黙って読み落とす = silent failure)、② 日付として検査できない
--   (pause_to >= pause_from・貸与期間との整合)、③ 誰がいつ入れたか / 取込由来か手入力かが残らない。
--   表なら CHECK で壊れた値を入れられず、order_items を消せば一緒に消える (ON DELETE CASCADE)。
--   notes は人が読むメモとして残す。初期投入 script は notes の期間を読み、★ 提供票の休止 (利用者名 × 日) と
--   一致したものだけを入れる (notes を鵜呑みにしない。2026-11-09 DRY RUN: 147 明細 / 179 期間すべて一致)。
--   以後の正はこの表 (notes を書き換えても計算は変わらない)。
--
-- 使う所: apps/order-app/lib/fukuyoguPauses.ts (読込) → lib/half-month-units.ts (halfMonthFlags / rentalDayMask) /
--         lib/kokuho-densou/build.ts (fukuyoguRentalDaysInMonth) / lib/kokuho-densou/fukuyogu-amounts.ts (公費の日割・半月)。
--         請求画面 BillingTab (伝送の作成 通常・返戻過誤 / 金額)、scripts/fukuyogu-densou-honobono-diff.mts。
--   表が未適用でも請求画面と伝送は壊れない (読めなければ「休止なし」で計算し、画面とコンソールに未適用と出す)。
-- 投入: migrations/seed_order_item_pauses_from_teikyohyo.mjs (DRY RUN 既定 / --execute / --revert <batch>)
--
-- RLS: order-app の tenant-scoped 表 (fukuyogu_cm_units / equipment_price_ceilings 等) と同じ
--   tenant_id IN (SELECT auth_visible_tenant_ids())。auth_visible_tenant_ids は SECURITY DEFINER の helper で、
--   この表を参照し返す policy は無いので循環参照 (CLAUDE.md 3.5) にはならない。
-- ⚠ Supabase SQL Editor は COMMIT が無いと終了時に rollback されるので、このまま 1 ブロックで流す。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS order_item_pauses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      TEXT NOT NULL,
  order_item_id  UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  -- 休止の初日・最終日 (両端含む)
  pause_from     DATE NOT NULL,
  pause_to       DATE NOT NULL,
  -- 理由 (入院 / ショートステイ / 不明 等。自由記述)
  reason         TEXT,
  -- どこから入れたか: 'teikyohyo' (ほのぼの提供票の取込) / 'manual' (画面・手入力)
  source         TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('teikyohyo', 'manual')),
  notes          TEXT,
  created_by     UUID DEFAULT auth.uid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT order_item_pauses_range_chk CHECK (pause_to >= pause_from),
  -- 同じ明細に同じ期間を 2 回入れない (取込の再実行で重複させない)
  CONSTRAINT uq_order_item_pauses UNIQUE (order_item_id, pause_from, pause_to)
);

CREATE INDEX IF NOT EXISTS idx_order_item_pauses_tenant_item
  ON order_item_pauses (tenant_id, order_item_id);

COMMENT ON TABLE order_item_pauses IS
  '福祉用具 貸与の休止期間 (貸与しなかった日。両端含む)。休止日は 伝送の明細 項10 日数 と 半月按分の判定 から除く。'
  '1 明細に複数可。2026-11-09 新設 (FY-PZ)';

ALTER TABLE order_item_pauses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_item_pauses_authenticated ON order_item_pauses;
CREATE POLICY order_item_pauses_authenticated ON order_item_pauses
  FOR ALL TO authenticated
  USING      (tenant_id IN (SELECT auth_visible_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMIT;

-- 確認 (適用後に流す):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'order_item_pauses'::regclass;
--   SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'order_item_pauses';
--   SELECT count(*) FROM order_item_pauses;   -- 投入前は 0
