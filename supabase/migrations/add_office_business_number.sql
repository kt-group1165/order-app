-- 事業所ごとの介護事業所番号（10桁）
ALTER TABLE offices ADD COLUMN IF NOT EXISTS business_number VARCHAR(10) DEFAULT NULL;
