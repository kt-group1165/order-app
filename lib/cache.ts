// 軽量なメモリキャッシュ層
// - TTL付き（デフォルト60秒）
// - 同じキーへの並行リクエストは1回にまとめる（重複クエリデデュープ）
// - 書き込み後は呼出側で invalidateCache() を呼んで明示的に古い値を捨てる

type CacheEntry<T> = { data: T; timestamp: number };

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export const DEFAULT_TTL = 60_000; // 60秒

/**
 * キーで取得を試行し、無ければ fetcher を実行して結果をキャッシュする。
 * 同時に同じキーへ複数の呼び出しがあった場合、1回のリクエストに集約する。
 */
export async function cached<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = DEFAULT_TTL
): Promise<T> {
  // 1. ヒット（TTL内）→ そのまま返す
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (entry && Date.now() - entry.timestamp < ttl) {
    return entry.data;
  }

  // 2. 同じキーで処理中のリクエストがあれば、それを待つ（重複クエリ排除）
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  // 3. 新規取得
  const promise = fetcher()
    .then((data) => {
      cache.set(key, { data, timestamp: Date.now() });
      inFlight.delete(key);
      return data;
    })
    .catch((err) => {
      inFlight.delete(key);
      throw err;
    });
  inFlight.set(key, promise);
  return promise;
}

/**
 * 特定の prefix にマッチするキャッシュを無効化する。
 * 例: invalidateCache("clients:") で全テナントの利用者キャッシュを破棄。
 */
export function invalidateCache(keyPrefix: string): void {
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(keyPrefix)) cache.delete(k);
  }
}

/** キャッシュを完全クリア（ログアウトやデバッグ時に使用） */
export function clearCache(): void {
  cache.clear();
  inFlight.clear();
}

/** デバッグ用：現在のキャッシュ統計 */
export function getCacheStats(): { keys: string[]; size: number } {
  return {
    keys: Array.from(cache.keys()),
    size: cache.size,
  };
}
