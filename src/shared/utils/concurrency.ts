export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Runs at most `maxConcurrent` tasks at a time; the rest wait in FIFO order.
 * A finishing task hands its slot directly to the next waiter, so a newcomer
 * can never slip in between and exceed the limit.
 */
export function createLimiter(maxConcurrent: number): Limiter {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('maxConcurrent must be ≥ 1');
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < maxConcurrent) {
      active += 1;
    } else {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}
