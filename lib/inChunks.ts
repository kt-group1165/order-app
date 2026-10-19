/**
 * `.in(列, ids)` を ids の数に関係なく安全に使うための分割読み込み。
 *
 * 2026-10-19 実測: client_id 1,057 件を 1 回の `.in()` に渡すと URL が約 39,000 文字になり
 * PostgREST が 400 Bad Request を返した (請求画面で事業所全員の公費・例外給付を読むと止まっていた)。
 * また 350 件前後を超えると Postgres が index を使わず全件走査に落ちる (memory feedback_postgrest_in_query_plan_cliff)。
 * → 150 件ずつに分けて読み、結果をつなぐ。1 回の結果が 1000 行を超えうる場合は呼出側で order + range すること。
 */
export const IN_CHUNK = 150;

export async function selectInChunks<T>(
  ids: readonly string[],
  run: (chunk: string[]) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>,
  chunkSize = IN_CHUNK,
): Promise<T[]> {
  // 空の id が混ざると .in() に "null" が渡って uuid の型エラー (22P02) で全体が落ちるので除く
  const unique = [...new Set(ids)].filter((id): id is string => typeof id === "string" && id !== "");
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const { data, error } = await run(unique.slice(i, i + chunkSize));
    // 包み直さずにそのまま投げる (呼出側が error.code で「表が無い」等を見分けている)
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
  }
  return out;
}
