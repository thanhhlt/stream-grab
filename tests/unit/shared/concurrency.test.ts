import { describe, expect, it } from 'vitest';
import { createLimiter } from '@/shared/utils/concurrency';

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('createLimiter', () => {
  it('never runs more than the limit, even when new tasks arrive as others finish', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, deferred);
    const tasks = gates.map((gate) =>
      limit(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gate.promise;
        running -= 1;
      }),
    );
    for (const gate of gates) {
      gate.resolve();
      // A newcomer arriving right after a release must not bypass the queue.
      void limit(() => Promise.resolve());
      await Promise.resolve();
    }
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it('runs waiting tasks in FIFO order and propagates errors without leaking slots', async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    const failing = limit(() => Promise.reject(new Error('x')));
    const later = [1, 2, 3].map((n) =>
      limit(() => {
        order.push(n);
        return Promise.resolve();
      }),
    );
    await expect(failing).rejects.toThrow('x');
    await Promise.all(later);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects invalid limits', () => {
    expect(() => createLimiter(0)).toThrow(RangeError);
  });
});
