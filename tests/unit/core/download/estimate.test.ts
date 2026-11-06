import { describe, expect, it } from 'vitest';
import {
  averageSpeed,
  estimateDownload,
  estimateEtaSeconds,
  estimateSize,
  MIN_SEGMENT_SAMPLES,
  MIN_SPEED_ELAPSED_MS,
  STALL_AFTER_MS,
  type SpeedAverage,
} from '@/core/download/estimate';
import type { TaskProgress, TrackProgress } from '@/core/models/download-task';

const MB = 1024 ** 2;

const progress = (overrides: Partial<TaskProgress> = {}): TaskProgress => ({
  segmentsTotal: 368,
  segmentsDone: 74,
  bytes: 36.4 * MB,
  bytesPerSecond: 7.4 * MB,
  percent: 20.1,
  retries: 0,
  startedAt: 0,
  ...overrides,
});

const track = (trackId: string, segmentsTotal: number, segmentsDone: number, bytes: number, declaredBytes?: number): TrackProgress => ({
  trackId,
  segmentsTotal,
  segmentsDone,
  bytes,
  ...(declaredBytes !== undefined ? { declaredBytes } : {}),
});

describe('estimateSize', () => {
  it('uses the declared size when the manifest gives every segment a byte range (known total)', () => {
    const size = estimateSize(progress({ segmentsTotal: 101, segmentsDone: 21, bytes: 20 * MB, tracks: [track('main', 100, 20, 20 * MB, 100 * MB)] }));
    expect(size).toEqual({ downloaded: 20 * MB, total: 100 * MB, remaining: 80 * MB, exact: true, partial: false });
  });

  it('extrapolates from downloaded bytes, completed segments and the segment count when the size is unknown', () => {
    // 36.4 MB in 74 of 368 segments → ~181 MB in all, ~144.6 MB to go (the example of the spec).
    const size = estimateSize(progress());
    expect(size?.exact).toBe(false);
    expect(size?.partial).toBe(false);
    expect((size?.total ?? 0) / MB).toBeCloseTo(181, 0);
    expect((size?.remaining ?? 0) / MB).toBeCloseTo(144.6, 1);
  });

  it('extrapolates each track on its own: video segments are far larger than audio ones', () => {
    // Video downloads first. Per task the average would be (100 MB + 2 MB) / 150 → ~136 MB in all;
    // per track it is 100 + 0 + 50 × 0.04 = 102 MB.
    const size = estimateSize(
      progress({
        segmentsTotal: 202,
        segmentsDone: 152,
        bytes: 102 * MB + 2048,
        tracks: [track('main', 100, 100, 100 * MB), track('audio-0', 100, 50, 2 * MB)],
      }),
    );
    expect((size?.total ?? 0) / MB).toBeCloseTo(104, 0);
    expect((size?.remaining ?? 0) / MB).toBeCloseTo(2, 1);
    expect(size?.partial).toBe(false);
  });

  it('flags a lower bound while a track has no samples yet, and gives up when no track has any', () => {
    const videoOnly = estimateSize(
      progress({ segmentsTotal: 200, segmentsDone: 10, bytes: 10 * MB, tracks: [track('main', 100, 10, 10 * MB), track('audio-0', 100, 0, 0)] }),
    );
    expect(videoOnly).toMatchObject({ total: 100 * MB, remaining: 90 * MB, partial: true, exact: false });

    const tooFew = MIN_SEGMENT_SAMPLES - 1;
    expect(estimateSize(progress({ segmentsDone: tooFew, bytes: tooFew * MB, tracks: [track('main', 368, tooFew, tooFew * MB)] }))).toBeUndefined();
    expect(estimateSize(progress({ segmentsDone: 0, bytes: 0 }))).toBeUndefined();
  });

  it('has nothing to estimate for live streams or before the segment list is known', () => {
    expect(estimateSize(progress({ segmentsTotal: 0, segmentsDone: 0, bytes: 0 }))).toBeUndefined();
  });

  it('reports the stored size, exactly, once every segment is in', () => {
    expect(estimateSize(progress({ segmentsDone: 368, bytes: 181 * MB }))).toEqual({
      downloaded: 181 * MB,
      total: 181 * MB,
      remaining: 0,
      exact: true,
      partial: false,
    });
  });

  it('reads progress stored by v0.1.0 (no per-track figures) as one track', () => {
    const size = estimateSize(progress());
    expect((size?.total ?? 0) / MB).toBeCloseTo(181, 0);
  });
});

describe('averageSpeed', () => {
  it('smooths fluctuating speeds by time, not by the number of samples', () => {
    let average: SpeedAverage | undefined;
    const samples = [8, 2, 9, 1, 8, 2, 9, 1].map((value) => value * MB);
    const seen: number[] = [];
    samples.forEach((sample, index) => {
      average = averageSpeed(average, sample, index * 500);
      seen.push(average.bytesPerSecond);
    });
    // The raw samples swing between 1 and 9 MB/s; the average stays within a narrow band.
    const later = seen.slice(2);
    expect(Math.max(...later) - Math.min(...later)).toBeLessThan(2 * MB);
    expect(average?.bytesPerSecond).toBeGreaterThan(4 * MB);
    expect(average?.bytesPerSecond).toBeLessThan(8 * MB);

    // Same samples twice as often barely changes the outcome (time-based weights).
    let dense: SpeedAverage | undefined;
    for (let t = 0; t <= 10_000; t += 250) dense = averageSpeed(dense, 5 * MB, t);
    let sparse: SpeedAverage | undefined;
    for (let t = 0; t <= 10_000; t += 1000) sparse = averageSpeed(sparse, 5 * MB, t);
    expect(dense?.bytesPerSecond).toBeCloseTo(sparse?.bytesPerSecond ?? 0, -3);
  });

  it('drops to 0 when stalled and starts over afterwards; ignores repeated or out-of-order samples', () => {
    let average = averageSpeed(undefined, 4 * MB, 0);
    average = averageSpeed(average, 0, 1000);
    expect(average.bytesPerSecond).toBe(0);
    average = averageSpeed(average, 2 * MB, 2000);
    expect(average.bytesPerSecond).toBe(2 * MB);
    expect(averageSpeed(average, 9 * MB, 2000)).toBe(average);
    expect(averageSpeed(average, 9 * MB, 1500)).toBe(average);
    expect(averageSpeed(undefined, Number.NaN, 0).bytesPerSecond).toBe(0);
  });
});

describe('estimateEtaSeconds', () => {
  it('divides the remaining bytes by the speed, and has no answer at zero speed', () => {
    expect(estimateEtaSeconds(144.6 * MB, 7.4 * MB)).toBeCloseTo(19.5, 1);
    expect(estimateEtaSeconds(10 * MB, 0)).toBeUndefined();
    expect(estimateEtaSeconds(10 * MB, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(estimateEtaSeconds(Number.NaN, MB)).toBeUndefined();
    expect(estimateEtaSeconds(0, MB)).toBe(0);
  });
});

describe('estimateDownload', () => {
  const at = { now: 20_000, reportedAt: 19_800 };

  it('gives an ETA from the moving-average speed once enough data is in', () => {
    const estimate = estimateDownload(progress({ bytesPerSecond: 9 * MB, averageBytesPerSecond: 7.4 * MB }), at);
    expect(estimate.bytesPerSecond).toBe(9 * MB); // shown as the current speed
    expect(estimate.etaSec).toBeCloseTo(144.6 / 7.4, 0); // from the steadier average
    expect(estimate.stalled).toBe(false);
  });

  it('withholds the ETA when the run is too young, the speed is 0, or the size cannot be estimated', () => {
    expect(estimateDownload(progress({ startedAt: 0 }), { now: MIN_SPEED_ELAPSED_MS - 1, reportedAt: MIN_SPEED_ELAPSED_MS - 1 }).etaSec).toBeUndefined();
    expect(estimateDownload(progress({ bytesPerSecond: 0, averageBytesPerSecond: 0 }), at)).toMatchObject({ stalled: true, bytesPerSecond: 0 });
    expect(estimateDownload(progress({ bytesPerSecond: 0, averageBytesPerSecond: 0 }), at).etaSec).toBeUndefined();
    expect(estimateDownload(progress({ segmentsDone: 1, bytes: MB }), at).etaSec).toBeUndefined();
    // Live stream / segment list not read yet: no size, no ETA, no stall.
    expect(estimateDownload(progress({ segmentsTotal: 0, segmentsDone: 0, bytes: 0, bytesPerSecond: 0 }), at)).toEqual({ bytesPerSecond: 0, stalled: false });
  });

  it('notices a download that stopped reporting', () => {
    const estimate = estimateDownload(progress(), { now: 30_000, reportedAt: 30_000 - STALL_AFTER_MS - 1 });
    expect(estimate).toMatchObject({ stalled: true, bytesPerSecond: 0 });
    expect(estimate.etaSec).toBeUndefined();
  });

  it('shows no speed or ETA for progress carried over from an earlier run', () => {
    const estimate = estimateDownload(progress({ stale: true }), at);
    expect(estimate).toMatchObject({ stalled: false, bytesPerSecond: 0 });
    expect(estimate.etaSec).toBeUndefined();
  });

  it('is done when every segment is in: no ETA, nothing remaining', () => {
    const estimate = estimateDownload(progress({ segmentsDone: 368, bytes: 181 * MB, bytesPerSecond: 0 }), at);
    expect(estimate.size?.remaining).toBe(0);
    expect(estimate.etaSec).toBeUndefined();
    expect(estimate.stalled).toBe(false);
  });

  it('does not take the moment a resumed run starts for a stall', () => {
    const estimate = estimateDownload(progress({ segmentsDone: 40, resumedSegments: 40, bytesPerSecond: 0 }), at);
    expect(estimate.stalled).toBe(false);
  });
});
