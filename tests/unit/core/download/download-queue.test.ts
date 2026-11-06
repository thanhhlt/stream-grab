import { describe, expect, it } from 'vitest';
import { runWorkerPool } from '@/core/download/download-queue';
import { ProgressTracker } from '@/core/download/progress';

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runWorkerPool', () => {
  it('never runs more than `concurrency` items and starts them in list order', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    await runWorkerPool(
      items,
      6,
      async (item) => {
        started.push(item);
        active += 1;
        peak = Math.max(peak, active);
        await tick(item % 3);
        active -= 1;
      },
      new AbortController().signal,
    );
    expect(peak).toBe(6);
    expect(started).toEqual(items);
  });

  it('handles thousands of items without creating a promise per item up front', async () => {
    let created = 0;
    await runWorkerPool(
      Array.from({ length: 5000 }, (_, i) => i),
      4,
      () => {
        created += 1;
        return Promise.resolve();
      },
      new AbortController().signal,
    );
    expect(created).toBe(5000);
  });

  it('stops starting items after the first failure and rethrows it', async () => {
    const started: number[] = [];
    const run = runWorkerPool(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      async (item) => {
        started.push(item);
        await tick();
        if (item === 3) throw new Error('segment 3 failed');
      },
      new AbortController().signal,
    );
    await expect(run).rejects.toThrow('segment 3 failed');
    expect(started.length).toBeLessThan(8);
  });

  it('passes an abort signal to workers and stops on cancellation', async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const run = runWorkerPool(
      Array.from({ length: 100 }, (_, i) => i),
      3,
      async (_item, signal) => {
        seen.push(signal);
        await tick(5);
      },
      controller.signal,
    );
    await tick(2);
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen.length).toBeLessThan(10);
    expect(seen.every((signal) => signal.aborted)).toBe(true);
  });

  it('rejects a concurrency below 1', async () => {
    await expect(runWorkerPool([1], 0, () => Promise.resolve(), new AbortController().signal)).rejects.toThrow(RangeError);
  });
});

describe('ProgressTracker', () => {
  it('computes percent by completed segments, bytes and retries', () => {
    let now = 0;
    const tracker = new ProgressTracker(8, () => now);
    tracker.segmentDone(1000);
    tracker.segmentDone(500);
    tracker.retried();
    expect(tracker.snapshot()).toMatchObject({ segmentsTotal: 8, segmentsDone: 2, bytes: 1500, percent: 25, retries: 1 });
    now = 10;
    tracker.setTotal(3);
    expect(tracker.snapshot().percent).toBe(66.6);
  });

  it('measures speed over a sliding window and drops to zero when idle', () => {
    let now = 0;
    const tracker = new ProgressTracker(1, () => now, 5000);
    now = 1000;
    tracker.received(1_000_000);
    now = 2000;
    tracker.received(1_000_000);
    expect(tracker.snapshot().bytesPerSecond).toBe(1_000_000); // 2 MB over the 2 s since start
    now = 10_000;
    expect(tracker.snapshot().bytesPerSecond).toBe(0);
  });
});
