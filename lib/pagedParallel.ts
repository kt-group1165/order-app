import { mapWithConcurrency } from "./concurrency";

/**
 * 1000 行ずつのページングを「件数を先に聞いて、ページを並列に読む」形にする (読み取り専用)。
 *
 * 2026-10-21 実測: 請求画面が client_insurance_records (約 25,000 行) を 1000 行ずつ **25 回直列**に読み、
 * それだけで約 5 秒かかっていた (他の読み込みは 1 秒以内に並列で終わっていた)。
 *
 * - build(from, to) は同じ絞り込み・同じ order で .range(from, to) を付けたクエリを返すこと (order 必須)
 * - count(): 同じ絞り込みで { count: "exact", head: true } の件数を返す
 * - 件数を聞いた後に行が増えていても取りこぼさないよう、最後のページが満杯なら続きを直列で読み足す
 * - worker 内で throw せずエラーを集めてからまとめて投げる (lib/concurrency.ts の注意書き参照)
 */
export async function selectAllPagedParallel<T>(
  count: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  opts: { page?: number; concurrency?: number } = {},
): Promise<T[]> {
  const PAGE = opts.page ?? 1000;
  const { count: total, error: countErr } = await count();
  if (countErr) throw new Error(countErr.message);
  const pages = Math.max(1, Math.ceil((total ?? 0) / PAGE));
  const errors: string[] = [];
  const chunks = await mapWithConcurrency(
    Array.from({ length: pages }, (_, i) => i),
    async (i) => {
      const { data, error } = await build(i * PAGE, i * PAGE + PAGE - 1);
      if (error) { errors.push(error.message); return [] as T[]; }
      return (data ?? []) as T[];
    },
    opts.concurrency ?? 6,
  );
  if (errors.length > 0) throw new Error(errors[0]);
  const all = chunks.flat();
  // 数えた後に増えた分 (最後のページが満杯だった場合だけ続きがありうる)
  let from = pages * PAGE;
  while (chunks[pages - 1]?.length === PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return all;
}
