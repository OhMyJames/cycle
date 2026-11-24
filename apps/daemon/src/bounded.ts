/**
 * `items` mapped by `each`, at most `limit` at a time, the results in the items' order. The first failure is the
 * whole call's; what is already running is not stopped, and its result is dropped.
 */
export const mapBounded = async <T, R>(
  items: readonly T[],
  limit: number,
  each: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await each(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
};
