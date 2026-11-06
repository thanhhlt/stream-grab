import type { SegmentStorage } from '@/core/download/download-storage';
import type { FetchFunction } from '@/core/network/manifest-fetcher';

const never = (): Promise<never> => new Promise<never>(() => undefined);

/**
 * Stands in for an engine that dies mid-download (browser closed, offscreen
 * document gone): after `crash()` its storage calls and requests never
 * complete, so it neither writes nor cleans up any more. Writes already handed
 * to IndexedDB still land, as they would in Chrome.
 */
export function crashable(storage: SegmentStorage, fetch: FetchFunction) {
  let crashed = false;
  const dyingStorage = new Proxy(storage, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => (crashed ? never() : (value as (...a: unknown[]) => unknown).apply(target, args));
    },
  });
  const dyingFetch: FetchFunction = (url, init) => (crashed ? never() : fetch(url, init));
  return {
    storage: dyingStorage,
    fetch: dyingFetch,
    crash: (): void => {
      crashed = true;
    },
    isCrashed: (): boolean => crashed,
  };
}

/** Polls until `condition` holds (or fails the test after `timeoutMs`). */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
