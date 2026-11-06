import { describe, expect, it } from 'vitest';
import { estimateDownload } from '@/core/download/estimate';
import { fileProgress, percentOf, ProgressTracker, type PlannedSegment } from '@/core/download/progress';

const media = (trackId: string, length?: number, encrypted = false): PlannedSegment => ({
  trackId,
  kind: 'media',
  ...(length !== undefined ? { byteRange: { offset: 0, length } } : {}),
  ...(encrypted ? { encryption: { method: 'AES-128', keyUrl: 'https://cdn.example.com/key', iv: '0'.repeat(32) } } : {}),
});
const init = (trackId: string): PlannedSegment => ({ trackId, kind: 'init' });

describe('fileProgress (progressive files, 0.3.0)', () => {
  const base = { segmentsTotal: 0, segmentsDone: 0, bytes: 0, bytesPerSecond: 500_000, averageBytesPerSecond: 400_000, percent: 0, retries: 2, startedAt: 1_000, resumedSegments: 3, stale: true };

  it('puts received bytes and the announced size into the segment model, so estimates work unchanged', () => {
    const progress = fileProgress(base, 2_000_000, 10_000_000, false);
    expect(progress).toEqual({
      segmentsTotal: 1,
      segmentsDone: 0,
      bytes: 2_000_000,
      bytesPerSecond: 500_000,
      averageBytesPerSecond: 400_000,
      percent: 20,
      retries: 2,
      startedAt: 1_000,
      tracks: [{ trackId: 'file', segmentsTotal: 1, segmentsDone: 0, bytes: 2_000_000, declaredBytes: 10_000_000 }],
    });
    const estimate = estimateDownload(progress, { now: 6_000, reportedAt: 6_000 });
    expect(estimate.size).toEqual({ downloaded: 2_000_000, total: 10_000_000, remaining: 8_000_000, exact: true, partial: false });
    expect(estimate.etaSec).toBe(20); // 8 MB at the average 400 kB/s
  });

  it('has no percentage, size or ETA when the server did not say the size, and 100 % only when done', () => {
    const unknown = fileProgress(base, 2_000_000, undefined, false);
    expect(unknown.percent).toBe(0);
    expect(unknown.tracks?.[0]?.declaredBytes).toBeUndefined();
    const estimate = estimateDownload(unknown, { now: 6_000, reportedAt: 6_000 });
    expect(estimate.size).toBeUndefined();
    expect(estimate.etaSec).toBeUndefined();
    expect(fileProgress(base, 9_999_999, 10_000_000, false).percent).toBe(99.9);
    expect(fileProgress(base, 10_000_000, 10_000_000, true)).toMatchObject({ percent: 100, segmentsDone: 1 });
  });
});

describe('ProgressTracker', () => {
  it('counts reused segments as done and stored, but not as received (speed)', () => {
    let now = 10_000;
    const tracker = new ProgressTracker(0, () => now);
    tracker.setTotal(100);
    tracker.resume(Array.from({ length: 40 }, () => ({ bytes: 100 })));
    expect(tracker.snapshot()).toMatchObject({ segmentsDone: 40, bytes: 4000, percent: 40, bytesPerSecond: 0, resumedSegments: 40 });

    now += 1000;
    tracker.received(500);
    tracker.segmentDone(500);
    expect(tracker.snapshot()).toMatchObject({ segmentsDone: 41, bytes: 4500, percent: 41, bytesPerSecond: 500, resumedSegments: 40 });
  });

  it('forgets stored data that was discarded', () => {
    const tracker = new ProgressTracker(10);
    tracker.setPlan([init('main'), media('main'), media('main')]);
    tracker.resume([{ segment: init('main'), bytes: 10 }, { segment: media('main'), bytes: 400 }]);
    tracker.segmentDone(100, media('main'));
    tracker.reset();
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({ segmentsDone: 0, bytes: 0, percent: 0, tracks: [{ trackId: 'main', segmentsDone: 0, bytes: 0 }] });
    expect(snapshot.resumedSegments).toBeUndefined();
  });

  it('reports media segments per track, without init segments, for size estimates', () => {
    const tracker = new ProgressTracker(0);
    tracker.setPlan([init('main'), media('main'), media('main'), media('main'), init('audio-0'), media('audio-0'), media('audio-0')]);
    tracker.resume([{ segment: init('main'), bytes: 900 }, { segment: media('main'), bytes: 1_000_000 }]);
    tracker.segmentDone(1_100_000, media('main'));
    tracker.segmentDone(40_000, media('audio-0'));
    const snapshot = tracker.snapshot();
    expect(snapshot).toMatchObject({ segmentsTotal: 7, segmentsDone: 4, bytes: 2_140_900, resumedSegments: 2 });
    expect(snapshot.tracks).toEqual([
      { trackId: 'main', segmentsTotal: 3, segmentsDone: 2, bytes: 2_100_000 },
      { trackId: 'audio-0', segmentsTotal: 2, segmentsDone: 1, bytes: 40_000 },
    ]);
  });

  it('knows the exact size of tracks whose segments all have byte ranges (not encrypted ones)', () => {
    const tracker = new ProgressTracker(0);
    tracker.setPlan([media('main', 600), media('main', 400), media('audio-0', 50), media('audio-0'), media('enc', 10, true)]);
    const tracks = tracker.snapshot().tracks;
    expect(tracks?.find((track) => track.trackId === 'main')?.declaredBytes).toBe(1000);
    expect(tracks?.find((track) => track.trackId === 'audio-0')?.declaredBytes).toBeUndefined();
    expect(tracks?.find((track) => track.trackId === 'enc')?.declaredBytes).toBeUndefined();
  });

  it('reports a moving-average speed next to the current one', () => {
    let now = 0;
    const tracker = new ProgressTracker(10, () => now, 1000);
    const speeds: number[] = [];
    const averages: number[] = [];
    for (const bytes of [8000, 1000, 9000, 1000, 8000, 2000]) {
      now += 1000;
      tracker.received(bytes);
      const snapshot = tracker.snapshot();
      speeds.push(snapshot.bytesPerSecond);
      averages.push(snapshot.averageBytesPerSecond ?? 0);
    }
    const spread = (values: number[]) => Math.max(...values.slice(2)) - Math.min(...values.slice(2));
    expect(spread(averages)).toBeLessThan(spread(speeds) / 2);
  });

  it('floors percentages so 100% means complete', () => {
    expect(percentOf(9999, 10000)).toBe(99.9);
    expect(percentOf(10, 10)).toBe(100);
    expect(percentOf(12, 10)).toBe(100);
    expect(percentOf(0, 0)).toBe(0);
  });
});
