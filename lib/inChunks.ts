import { mapWithConcurrency } from "./concurrency";

/**
 * `.in(列, ids)` を ids の数に関係なく安全に使うための分割読み込み。
 *
 * 2026-10-19 実測: client_id 1,057 件を 1 回の `.in()` に渡すと URL が約 39,000 文字になり
 * PostgREST が 400 Bad Request を返した (請求画面で事業所全員の公費・例外給付を読むと止まっていた)。
 * また 350 件前後を超えると Postgres が index を使わず全件走査に落ちる (memory feedback_postgrest_in_query_plan_cliff)。
 * → 150 件ずつに分けて読み、結果をつなぐ。1 回の結果が 1000 行を超えうる場合は呼出側で order + range すること。
 */
export const IN_CHUNK = 150;
/** 同時本数の上限 (並行セッション・他画面で大量チャンクになっても DB を詰まらせない。memory feedback_db_load_parallel_sessions) */
export const IN_CHUNK_MAX_CONCURRENCY = 8;

export async function selectInChunks<T>(
  ids: readonly string[],
  run: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
  chunkSize = IN_CHUNK,
  /** 同時に投げる本数 (既定 4)。HTTP/2 で 1 本の接続に多重化されるので、往復の待ちを減らしたい読込は増やしてよい */
  concurrency = 4,
): Promise<T[]> {
  // 空の id が混ざると .in() に "null" が渡って uuid の型エラー (22P02) で全体が落ちるので除く
  const unique = [...new Set(ids)].filter((id): id is string => typeof id === "string" && id !== "");
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += chunkSize) chunks.push(unique.slice(i, i + chunkSize));
  // 2026-11-13: 直列 → 同時 4 本まで。結果は チャンクの順につなぐ (従来と同じ並び)。
  //   worker 内では throw せず集めてから、いちばん前のチャンクのエラーを 包み直さずにそのまま投げる
  //   (呼出側が error.code で「表が無い」等を見分けている。lib/concurrency.ts の注意書き)
  const results = await mapWithConcurrency(chunks, async (chunk) => {
    const { data, error } = await run(chunk);
    return { rows: (data ?? []) as T[], error };
  }, Math.max(1, Math.min(concurrency, IN_CHUNK_MAX_CONCURRENCY)));
  const firstErr = results.find((r) => r.error)?.error;
  if (firstErr) throw firstErr;
  return results.flatMap((r) => r.rows);
}
