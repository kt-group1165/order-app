-- ============================================================
-- attendance_url_settings
-- 出勤簿 自己入力 URL の個別制御 (無効化 / 再発行)
-- ============================================================
-- 背景:
--   自己入力 URL は HMAC 署名 (DB 保存なし) で発行しているため、
--   secret ローテーション = 全員一斉失効しかできなかった。
--   本テーブルで職員ごとの disabled flag と token_version を持ち、
--   個別の無効化・再発行を可能にする。
--
-- 検証フロー (/api/attendance-self):
--   token の署名検証 → 本テーブルを引く →
--     disabled = true            → 403
--     token の version ≠ 現 version → 403 (再発行で旧 URL を殺す)
--   row が無い職員は「有効 / version 1」扱い (= 既存配布分は影響なし)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS attendance_url_settings (
  employee_id   UUID PRIMARY KEY REFERENCES payroll_employees(id) ON DELETE CASCADE,
  disabled      BOOLEAN NOT NULL DEFAULT false,
  token_version INT NOT NULL DEFAULT 1 CHECK (token_version >= 1),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE attendance_url_settings ENABLE ROW LEVEL SECURITY;

-- 管理 UI (authenticated) は読み書き可。自己入力 API は service_role なので RLS 対象外。
DROP POLICY IF EXISTS attendance_url_settings_authenticated ON attendance_url_settings;
CREATE POLICY attendance_url_settings_authenticated
  ON attendance_url_settings
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

COMMENT ON TABLE attendance_url_settings IS
  '出勤簿 自己入力 URL の個別制御。row 無し = 有効/version 1。disabled=true で 403、token_version+1 で旧 URL 失効';

COMMIT;
