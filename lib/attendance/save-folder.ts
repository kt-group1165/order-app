"use client";

// 出勤簿 PDF の保存先フォルダを端末ごとに覚えて、以降は無操作で書き込むための helper。
//
// File System Access API (Chrome / Edge の PC のみ)。
//   - 最初に 1 回 showDirectoryPicker() でフォルダを選ぶ
//   - フォルダのハンドルを IndexedDB に保存 (パス文字列ではないので、
//     端末ごとに Box の実パスが違っても問題にならない)
//   - 次回以降は保存済みハンドルの権限を確認して直接書き込む
//
// 非対応ブラウザ (Safari / iOS) では isFolderSaveSupported() が false を返すので、
// 呼出側は従来どおりダウンロードにフォールバックする。

const DB_NAME = "kt-attendance";
const STORE = "handles";
const KEY = "pdf-folder";

type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: "readwrite" }) => Promise<PermissionState>;
};

export function isFolderSaveSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けません"));
  });
}

async function idbGet(): Promise<DirHandle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve((req.result as DirHandle) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(handle: DirHandle | null): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (handle) store.put(handle, KEY);
    else store.delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 保存済みフォルダの表示名 (未設定なら null) */
export async function getSavedFolderName(): Promise<string | null> {
  if (!isFolderSaveSupported()) return null;
  try {
    const h = await idbGet();
    return h?.name ?? null;
  } catch {
    return null;
  }
}

/** フォルダを選び直す (初回設定・変更) */
export async function pickFolder(): Promise<string | null> {
  if (!isFolderSaveSupported()) return null;
  const picker = (
    window as unknown as {
      showDirectoryPicker: (o?: { mode?: string }) => Promise<DirHandle>;
    }
  ).showDirectoryPicker;
  const handle = await picker({ mode: "readwrite" });
  await idbSet(handle);
  return handle.name;
}

export async function clearFolder(): Promise<void> {
  await idbSet(null);
}

/** 保存済みハンドルを使える状態にして返す。権限が無ければ null */
async function ensurePermission(): Promise<DirHandle | null> {
  const handle = await idbGet();
  if (!handle) return null;
  const q = await handle.queryPermission?.({ mode: "readwrite" });
  if (q === "granted") return handle;
  const r = await handle.requestPermission?.({ mode: "readwrite" });
  return r === "granted" ? handle : null;
}

export type SaveResult =
  | { ok: true; folder: string; fileName: string }
  | { ok: false; reason: "unsupported" | "no-folder" | "denied"; error?: string };

/**
 * 保存済みフォルダに書き込む。フォルダ未設定・権限拒否・非対応ならその理由を返すので、
 * 呼出側でフォルダ選択を促すかダウンロードにフォールバックする。
 */
export async function saveToFolder(fileName: string, data: Blob): Promise<SaveResult> {
  if (!isFolderSaveSupported()) return { ok: false, reason: "unsupported" };
  let handle: DirHandle | null;
  try {
    handle = await ensurePermission();
  } catch (e) {
    return { ok: false, reason: "denied", error: e instanceof Error ? e.message : String(e) };
  }
  if (!handle) return { ok: false, reason: "no-folder" };
  try {
    const file = await handle.getFileHandle(fileName, { create: true });
    const w = await file.createWritable();
    await w.write(data);
    await w.close();
    return { ok: true, folder: handle.name, fileName };
  } catch (e) {
    return { ok: false, reason: "denied", error: e instanceof Error ? e.message : String(e) };
  }
}

/** 非対応ブラウザ用のフォールバック (通常のダウンロード) */
export function downloadBlob(fileName: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
