/**
 * Bounded worker pool. A fixed number of workers pull items in list order from
 * a shared cursor, so at most `concurrency` items are in flight however long
 * the list is (thousands of segments never become thousands of promises at
 * once, unlike Promise.all), and earlier segments are fetched first.
 *
 * The first worker error stops the pool: no new items start, the error is
 * rethrown once every worker has stopped. Aborting `signal` stops it too.
 */
export async function runWorkerPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be ≥ 1');
  const stop = new AbortController();
  const forward = (): void => {
    stop.abort(signal.reason);
  };
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted) stop.abort(signal.reason);

  let cursor = 0;
  let failure: { error: unknown } | undefined;

  const loop = async (): Promise<void> => {
    while (!stop.signal.aborted && cursor < items.length) {
      const item = items[cursor++] as T;
      try {
        await worker(item, stop.signal);
      } catch (error) {
        failure ??= { error };
        stop.abort(error);
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, loop));
  } finally {
    signal.removeEventListener('abort', forward);
  }
  if (failure) throw failure.error;
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
}
