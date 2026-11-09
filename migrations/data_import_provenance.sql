-- ============================================================
-- 取込データの出どころ記録 (data_import_batches / data_import_rows)  2026-11-09 ★ 未適用
-- ============================================================
-- 目的:
--   ほのぼの等の外部データから新システムに 入れた / 書き換えた 全ての行について
--   「どの取込 (batch) で・どの元ファイルの・どの行から来たか」を DB に残し、
--   後から 一覧 / 取り消し / 入れ直し ができるようにする。
--   最初の利用者: apps/order-app/migrations/sync_fukuyogu_from_honobono.mjs
--     (--execute は最初に batch を作り、各 insert/update の直後に data_import_rows を書く。
--      書けなければその場で止める。--revert <batch_id> で取り消し)
--
-- 設計:
--   data_import_batches  1 回の --execute = 1 行
--     source_system  例 'honobono-fukuyogu' (ほのぼの福祉用具) / 'honobono-kaigo' 等
--     source_files   jsonb 配列 [{ "path": "apps/kaigo-app/伝送データ/ケアサポ/福祉用具/202609/ほのぼのから/KDS0031_….CSV",
--                                  "sha256": "…", "rows": 5319, "kind": "KDS0031 明細書明細付 R8/9" }, …]
--     status         dry_run   … 記録用 (現状 script は DRY RUN で DB に書かないので使わない)
--                    running   … 書込み中 (途中で落ちたらこのまま残る = 中途半端な取込の目印)
--                    executed  … 完了
--                    failed    … 途中で止まった (それまでの行は data_import_rows にある)
--                    reverted  … 取り消し済み (全行戻した)
--                    partially_reverted … 取り消したが、後から人が触った行など戻せない行が残った
--   data_import_rows     書いた 1 行 = 1 行
--     op          insert / update / delete (delete は before に消した行の全列を残す。取り消し = 同じ id で入れ直す)
--                 observe = 書かなかったが 元データの値を控えた行 (例: kaigo-app と共有の利用者は clients を上書きしない。
--                           source_ref に ほのぼのの値、before に今の値、after に「書いたら変わる列」を残す。取り消しでは何もしない)
--                 trigger が作った行 (doc_tasks / care_plan_elements) を同じ実行内で掃除したものは
--                 op=delete・source_key='cleanup:trigger'・source_ref.cleanup=true (取り消しでは入れ直さない)
--     source_key元データ上のキー。例 '122192|1000062522' (保険者|被保番) / 'TAIS:00175-000183' /
--                 'ほのぼの用具ID:28' / '122192|1000062522|TAIS:00523-000019'
--     source_ref  元 CSV の該当行の値 (jsonb)
--     before      update / delete の変更前の行 (全列。insert は null)
--     after       書いた列と値 (insert = 入れた行 / update = 変えた列だけ / delete は null)。
--                 取り消しは「現在値 = after」の行だけ戻す (後から人が触った行は戻さず一覧に出す)
--
-- RLS: 有効。書込みは service_role (script) のみ = INSERT/UPDATE/DELETE のポリシーは作らない。
--      閲覧だけ authenticated に tenant 単位で許す (将来 画面から一覧するため。
--      auth_visible_tenant_ids() は shared_documents_v1 等と同じ既存関数)。
--
-- 冪等: CREATE … IF NOT EXISTS / DROP POLICY IF EXISTS → CREATE POLICY。
-- ⚠ Supabase SQL Editor は COMMIT が無いと終了時に rollback されるので、このまま 1 ブロックで流す。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS data_import_batches (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  source_system TEXT NOT NULL,
  source_files  JSONB NOT NULL DEFAULT '[]'::jsonb,
  script        TEXT NOT NULL,
  args          TEXT,
  step          TEXT,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('dry_run', 'running', 'executed', 'failed', 'reverted', 'partially_reverted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  executed_at   TIMESTAMPTZ,
  reverted_at   TIMESTAMPTZ,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS data_import_rows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    UUID NOT NULL REFERENCES data_import_batches(id) ON DELETE CASCADE,
  tenant_id   TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  row_id      UUID NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete', 'observe')),
  source_key  TEXT,
  source_ref  JSONB,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 先に古い版 (op が insert/update だけ) を流していた場合も、ここで許可値を揃える (何度流しても同じ)
ALTER TABLE data_import_rows DROP CONSTRAINT IF EXISTS data_import_rows_op_check;
ALTER TABLE data_import_rows ADD CONSTRAINT data_import_rows_op_check CHECK (op IN ('insert', 'update', 'delete', 'observe'));

CREATE INDEX IF NOT EXISTS idx_data_import_rows_batch ON data_import_rows(batch_id);
CREATE INDEX IF NOT EXISTS idx_data_import_rows_table_row ON data_import_rows(table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_data_import_batches_tenant ON data_import_batches(tenant_id, created_at DESC);

ALTER TABLE data_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_import_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS data_import_batches_select ON data_import_batches;
CREATE POLICY data_import_batches_select ON data_import_batches
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT auth_visible_tenant_ids()));

DROP POLICY IF EXISTS data_import_rows_select ON data_import_rows;
CREATE POLICY data_import_rows_select ON data_import_rows
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT auth_visible_tenant_ids()));

COMMENT ON TABLE data_import_batches IS '外部データ取込の 1 回分 (出どころ記録)。status: dry_run/running/executed/failed/reverted/partially_reverted';
COMMENT ON TABLE data_import_rows IS '取込で insert/update した各行の出どころ・変更前後。取り消しは現在値=after の行だけ戻す';

COMMIT;

-- 確認:
--   SELECT table_name FROM information_schema.tables WHERE table_name IN ('data_import_batches','data_import_rows');
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('data_import_batches','data_import_rows');
