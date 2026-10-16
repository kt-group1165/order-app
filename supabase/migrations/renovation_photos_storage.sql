-- 住宅改修の写真 (写真添付用紙の 工事前 / 工事後) を置く Storage バケット
--
-- 旧 Excel「<利用者>様住改見積.xlsx」の 手すり①〜⑧ / 段差①〜③ / 引き戸① / 便器交換① / 床材①② シートの置換。
-- 写真は利用者宅の中が写るので **非公開 (public=false)** にし、読み書きを authenticated に絞る。
--   2026-08-31 に event-images バケットが policy の書き方で anon に開いていた事故があったので、
--   最初から anon を入れない (fix_event_images_storage_policy.sql 参照)。
--
-- パス: <renovation_projects.id>/<uuid>.jpg
--   先頭フォルダの案件が「呼び出したユーザーから見える」ときだけ読み書きできる。
--   renovation_projects 側の RLS (事業所の可視範囲) がそのまま写真にも効く。
--   storage.objects → renovation_projects の片方向の参照なので RLS の循環は起きない。
--
-- 画面 (RenovationDocsModal) はブラウザで長辺 1600px の JPEG に縮めてから置く。上限 5MB。
--
-- ロールバック:
--   DROP POLICY IF EXISTS renovation_photos_select ON storage.objects;
--   DROP POLICY IF EXISTS renovation_photos_insert ON storage.objects;
--   DROP POLICY IF EXISTS renovation_photos_delete ON storage.objects;
--   (バケットは中身を消してから) DELETE FROM storage.buckets WHERE id = 'renovation-photos';

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('renovation-photos', 'renovation-photos', false, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS renovation_photos_select ON storage.objects;
CREATE POLICY renovation_photos_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'renovation-photos'
    AND EXISTS (SELECT 1 FROM renovation_projects p WHERE p.id::text = (storage.foldername(name))[1])
  );

DROP POLICY IF EXISTS renovation_photos_insert ON storage.objects;
CREATE POLICY renovation_photos_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'renovation-photos'
    AND EXISTS (SELECT 1 FROM renovation_projects p WHERE p.id::text = (storage.foldername(name))[1])
  );

DROP POLICY IF EXISTS renovation_photos_delete ON storage.objects;
CREATE POLICY renovation_photos_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'renovation-photos'
    AND EXISTS (SELECT 1 FROM renovation_projects p WHERE p.id::text = (storage.foldername(name))[1])
  );

COMMIT;

-- 確認 (バケット 1 行 public=false / policy 3 行 roles={authenticated} が返れば OK)
SELECT id, public, file_size_limit FROM storage.buckets WHERE id = 'renovation-photos';
SELECT policyname, cmd, roles::text FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname LIKE 'renovation_photos_%'
ORDER BY policyname;
