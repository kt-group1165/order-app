-- ============================================================
-- members.gender (性別)
-- ============================================================
-- 2026-07-29 福祉用具部門の名簿 (氏名/フリガナ/性別/職種) を取込むにあたり、
-- members に不足していた性別を追加する。
--   氏名     → members.name (既存)
--   フリガナ → members.furigana (既存)
--   職種     → members.role (既存。所長/事務/外回り/選定/営業 等)
--   性別     → members.gender (本 migration で追加)
--
-- 出勤簿の事務員フラグ (payroll_employees.is_office_worker) は職種「事務」から設定する。
-- ============================================================

BEGIN;

ALTER TABLE members
  ADD COLUMN IF NOT EXISTS gender TEXT
    CHECK (gender IS NULL OR gender IN ('男性', '女性'));

COMMENT ON COLUMN members.gender IS '性別 (男性 / 女性)。未設定は NULL';

COMMIT;
