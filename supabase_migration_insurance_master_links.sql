-- 介護保険履歴（client_insurance_records）に居宅マスタ／ケアマネマスタの参照を追加
-- 認定期間ごとの担当ケアマネをマスタID付きで履歴管理する。
-- マスタが設定されていない（テキストのみ）の履歴行は care_office_id / care_manager_id が NULL のまま。

ALTER TABLE client_insurance_records
  ADD COLUMN IF NOT EXISTS care_office_id  UUID REFERENCES care_offices(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS care_manager_id UUID REFERENCES care_managers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_client_insurance_care_office_id
  ON client_insurance_records(care_office_id);

CREATE INDEX IF NOT EXISTS idx_client_insurance_care_manager_id
  ON client_insurance_records(care_manager_id);
