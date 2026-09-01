/**
 * 上限付き並列実行ヘルパー。CSV 取込などの「1件ずつ直列 await」を
 * まとめて速くしつつ、DB への同時接続数を抑える (無制限 Promise.all は避ける)。
 *
 * kaigo-app の `lib/chunk-parallel.ts` (`mapChunksParallel`) と同じ設計思想:
 * items を worker に渡し、`concurrency` 本のランナーが早い者勝ちで次の item を取る。
 * 戻り値は **入力順** に並べて返すので、呼び出し側の順序前提を壊さない。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency = 6,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
