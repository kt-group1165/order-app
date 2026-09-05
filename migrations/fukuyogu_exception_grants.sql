-- ============================================================
-- 福祉用具貸与 軽度者 例外給付 記録テーブル (B-6d・2026-09-05)
-- ============================================================
-- 背景:
--   order-app の請求計算 (BillingTab.tsx / kokuho-densou/build.ts) は
--   client.care_level を 7131 の印字にしか使っておらず、「軽度者(要支援1・2/
--   要介護1)は原則対象外」の品目制限を判定していない。2026-06 実データで
--   軽度者406名中120件が原則対象外品目を借りている状態を確認したが、
--   これは「例外給付が認められている」のか「見落とし」なのかをシステム上
--   区別する材料がそもそも無かった (scripts/fukuyogu-keido-exception-check.mts)。
--   → 現場が把握している例外給付の実態を記録する場所を作り、以後は
--     「記録なし」を警告できるようにする (user 判断: 案A採用)。
--
-- ⚠⚠⚠ 告示の条件は未確認 (2026-09-05 時点) ⚠⚠⚠
--   このテーブル設計・アプリ側の対象6区分は、G が一般的な福祉用具貸与の
--   軽度者原則対象外ルールから整理したものであり、★ 告示・通知の条文原文までは
--   確認していない。特に自動排泄処理装置は要介護4・5のみ対象という別ロジックが
--   あり、かつ「尿のみ吸引」型は要介護度を問わない (=区別する列が無いので今回は
--   判定を保留する。app/[tenant]/order-item-helpers.ts のコメント参照)。
--   ★ user が告示原文で restriction_group / 対象範囲を確認したら、この注記と
--   コード側の同趣旨コメントを消すこと。
--
-- 設計:
--   - order_items は契約単位 (継続レンタルは1行のまま月ごとに作り直さない。
--     2026-09-05 実測: サンプル1,000件中1,000件が1ヶ月超に継続、rental_end_date
--     が入っているのは全order_items 4,669件中1件のみ) なので、例外給付も
--     order_items の列ではなく「利用者×品目区分グループ×有効期間」の
--     専用テーブルで持つ。同じ例外が続く限り、レンタルを組み替えても
--     再入力は不要になる。
--   - restriction_group は equipment_master.category そのものではなく、
--     例外給付が下りる単位でグルーピングする (車いすと車いす付属品は通常
--     セットで例外が下りるため同じ区分に含める)。
--   - judgment_route: 例外給付には主に「医師の医学的所見に基づく判断」と
--     「サービス担当者会議等での適切なケアマネジメントによる判断」の
--     2経路があるとされる (★ 未確認)。両方の日付を持たせ、どちらか一方
--     (または両方) が埋まっていれば記録ありとする。
--   - RLS は他の order-app テーブルと同じ「authenticated 全許可」パターン
--     (tenant scoping はアプリ層の .eq("tenant_id", ...) で行う既存方式に揃える)。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS fukuyogu_exception_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  client_id UUID NOT NULL REFERENCES clients(id),
  -- ⚠ 告示原文で正式な区分名を確認するまでの仮の値。app 側の定数と必ず揃えること
  --   (app/[tenant]/order-item-helpers.ts の RESTRICTION_GROUPS 相当)。
  restriction_group TEXT NOT NULL CHECK (restriction_group IN (
    '車いす系',       -- 車いす・車椅子付属品
    '特殊寝台系',      -- 特殊寝台・特殊寝台付属品
    '床ずれ防止用具',
    '体位変換器',
    '徘徊感知機器',
    '移動用リフト',
    '自動排泄処理装置'  -- ⚠ 要介護4・5のみ対象の別ロジック。判定は保留中 (上記コメント参照)
  )),
  judgment_route TEXT CHECK (judgment_route IN ('医師意見書', 'サービス担当者会議等', 'その他', NULL)),
  doctor_opinion_date DATE,       -- 医師意見書取得日 (judgment_route='医師意見書' のとき)
  meeting_confirmed_date DATE,    -- サービス担当者会議等での確認日
  insurer_confirmed_date DATE,    -- 保険者への確認・届出日 (自治体により運用差あり。任意)
  valid_from DATE NOT NULL,
  valid_end DATE,                 -- NULL = 期限なし (更新不要 or 未確認)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_fukuyogu_exception_grants_client
  ON fukuyogu_exception_grants(client_id);

CREATE INDEX IF NOT EXISTS idx_fukuyogu_exception_grants_tenant
  ON fukuyogu_exception_grants(tenant_id);

-- 同一利用者×同一区分×同一開始日の重複登録を防ぐ (更新は上書きでなく新規行 + 旧行の valid_end 設定を想定)
CREATE UNIQUE INDEX IF NOT EXISTS uq_fukuyogu_exception_grants_client_group_from
  ON fukuyogu_exception_grants(client_id, restriction_group, valid_from);

COMMENT ON TABLE fukuyogu_exception_grants IS
  '福祉用具貸与 軽度者(要支援1・2/要介護1)への原則対象外品目の例外給付記録。'
  '記録が無い = 例外給付を取っていない、を意味しない (現場入力が追いついていないだけの可能性が高い)。'
  '告示の対象範囲は 2026-09-05 時点で未確認 (fukuyogu-keido-exception-check.mts 参照)。';

-- RLS: 他の order-app テーブルと同じ「authenticated 全許可」パターン
ALTER TABLE fukuyogu_exception_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fukuyogu_exception_grants_auth
  ON fukuyogu_exception_grants;
CREATE POLICY fukuyogu_exception_grants_auth
  ON fukuyogu_exception_grants FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION trg_fukuyogu_exception_grants_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fukuyogu_exception_grants_updated_at
  ON fukuyogu_exception_grants;
CREATE TRIGGER fukuyogu_exception_grants_updated_at
  BEFORE UPDATE ON fukuyogu_exception_grants
  FOR EACH ROW
  EXECUTE FUNCTION trg_fukuyogu_exception_grants_updated_at();

COMMIT;
