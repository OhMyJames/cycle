/**
 * `items` mapped by `each`, at most `limit` at a time, the results in the items' order. The first failure is the
 * whole call's: nothing more is started after it, and what is already running is not stopped, its result dropped.
 */
export const mapBounded = async <T, R>(
  items: readonly T[],
  limit: number,
  each: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await each(items[index] as T, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
};
