import { supabase } from "./supabase";

// 住宅改修の写真 (写真添付用紙の 工事前 / 工事後)。
// バケット: renovation-photos (非公開)。パス: <renovation_projects.id>/<uuid>.jpg
// 読み書きの権限は supabase/migrations/renovation_photos_storage.sql の policy
// (先頭フォルダの案件が見えるユーザーだけ)。表示は署名付き URL。

export const RENOVATION_PHOTO_BUCKET = "renovation-photos";

/** 長辺 1600px の JPEG に縮める。スマホ写真 (数 MB) をそのまま置くと印刷画面が重くなるため */
export async function resizeToJpeg(file: File, maxSide = 1600, quality = 0.85): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error(`画像ファイルではありません (${file.type || "種類不明"})`);
  let bitmap: ImageBitmap;
  try {
    // 縦向きで撮った写真が横倒しにならないよう、EXIF の向きを反映して読む
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("この画像は読み込めません。iPhone の HEIC 形式などは JPEG で保存し直してから選んでください");
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("画像の縮小に失敗しました (canvas が使えません)");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (!blob) throw new Error("画像の縮小に失敗しました");
  return blob;
}

/** 写真を置いてパスを返す */
export async function uploadRenovationPhoto(projectId: string, blob: Blob): Promise<string> {
  const path = `${projectId}/${crypto.randomUUID()}.jpg`;
  const { error } = await supabase.storage
    .from(RENOVATION_PHOTO_BUCKET)
    .upload(path, blob, { contentType: "image/jpeg", upsert: false });
  if (error) throw new Error(`写真の保存に失敗しました: ${error.message}`);
  return path;
}

export async function removeRenovationPhoto(path: string): Promise<void> {
  const { data, error } = await supabase.storage.from(RENOVATION_PHOTO_BUCKET).remove([path]);
  if (error) throw new Error(`写真の削除に失敗しました: ${error.message}`);
  // policy で弾かれると error 無しで 0 件になる
  if (!data || data.length === 0) console.warn("写真が削除されませんでした (既に無いか、権限がありません):", path);
}

/** 表示用の署名付き URL (1 時間)。取れなかったパスは結果に入れない */
export async function signRenovationPhotos(paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(RENOVATION_PHOTO_BUCKET).createSignedUrls(paths, 3600);
  if (error) throw new Error(`写真の読み込みに失敗しました: ${error.message}`);
  const out: Record<string, string> = {};
  for (const d of data ?? []) {
    if (d.path && d.signedUrl && !d.error) out[d.path] = d.signedUrl;
  }
  return out;
}
