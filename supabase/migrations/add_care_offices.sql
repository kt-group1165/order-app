-- 居宅事業所マスタ
CREATE TABLE IF NOT EXISTS care_offices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,           -- 事業所名
  fax_number TEXT,              -- FAX番号
  phone_number TEXT,            -- 電話番号
  address TEXT,                 -- 住所
  email TEXT,                   -- メールアドレス
  notes TEXT,                   -- 備考
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

-- 既存利用者データからケアマネ事務所を自動移行（重複なし）
-- ※ care_manager_org が NULL でない利用者の事務所名を取得
-- 実行後、個別にFAX番号等を追加登録してください
INSERT INTO care_offices (tenant_id, name)
SELECT DISTINCT tenant_id, care_manager_org
FROM clients
WHERE care_manager_org IS NOT NULL AND care_manager_org != ''
ON CONFLICT (tenant_id, name) DO NOTHING;
