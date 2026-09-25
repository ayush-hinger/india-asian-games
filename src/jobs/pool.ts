/**
 * Run tasks with bounded concurrency and a fixed gap between starts.
 *
 * The gap matters more than the concurrency: sweeping 37 sports is a burst of
 * requests against a CDN we do not own, so they are spaced rather than fired at once.
 */
export async function runPooled<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  opts: { concurrency?: number; gapMs?: number } = {},
): Promise<PromiseSettledResult<R>[]> {
  const { concurrency = 4, gapMs = 120 } = opts;
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
      try {
        results[index] = { status: "fulfilled", value: await fn(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
