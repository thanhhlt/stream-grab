import { describe, expect, it } from 'vitest';
import { percentOf, ProgressTracker } from '@/core/download/progress';

describe('ProgressTracker', () => {
  it('counts reused segments as done and stored, but not as received (speed)', () => {
    let now = 10_000;
    const tracker = new ProgressTracker(0, () => now);
    tracker.setTotal(100);
    tracker.resume(40, 4000);
    expect(tracker.snapshot()).toMatchObject({ segmentsDone: 40, bytes: 4000, percent: 40, bytesPerSecond: 0, resumedSegments: 40 });

    now += 1000;
    tracker.received(500);
    tracker.segmentDone(500);
    expect(tracker.snapshot()).toMatchObject({ segmentsDone: 41, bytes: 4500, percent: 41, bytesPerSecond: 500, resumedSegments: 40 });
  });

  it('forgets stored data that was discarded', () => {
    const tracker = new ProgressTracker(10);
    tracker.resume(4, 400);
    tracker.segmentDone(100);
    tracker.reset();
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({ segmentsDone: 0, bytes: 0, percent: 0 });
    expect(snapshot.resumedSegments).toBeUndefined();
  });

  it('floors percentages so 100% means complete', () => {
    expect(percentOf(9999, 10000)).toBe(99.9);
    expect(percentOf(10, 10)).toBe(100);
    expect(percentOf(12, 10)).toBe(100);
    expect(percentOf(0, 0)).toBe(0);
  });
});
