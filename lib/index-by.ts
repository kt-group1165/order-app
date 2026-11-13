/**
 * 配列の引き当て用の索引 (2026-11-13 高速化: 画面の描画のたびに arr.find / arr.filter を
 * 何千回も回していたのを Map 1 回にする)。
 *
 * firstBy … arr.find(x => key(x) === k) と同じ (同じキーが複数あれば 最初の 1 件)
 * groupBy … arr.filter(x => key(x) === k) と同じ (元の並び順のまま)
 */
export function firstBy<T, K>(arr: readonly T[], key: (x: T) => K): Map<K, T> {
  const m = new Map<K, T>();
  for (const x of arr) {
    const k = key(x);
    if (!m.has(k)) m.set(k, x);
  }
  return m;
}

export function groupBy<T, K>(arr: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of arr) {
    const k = key(x);
    const a = m.get(k);
    if (a) a.push(x);
    else m.set(k, [x]);
  }
  return m;
}
