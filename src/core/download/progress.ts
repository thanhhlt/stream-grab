import type { TaskProgress, TrackProgress } from '@/core/models/download-task';
import type { MediaSegment } from '@/core/models/media-segment';
import { averageSpeed, type SpeedAverage } from './estimate';

/** Những gì tracker cần biết về một segment của plan. */
export type PlannedSegment = Pick<MediaSegment, 'trackId' | 'kind' | 'byteRange' | 'encryption'>;

interface TrackTally {
  segmentsTotal: number;
  segmentsDone: number;
  bytes: number;
  /** Tổng byte range khai báo; chỉ có nghĩa khi `allDeclared`. */
  declared: number;
  allDeclared: boolean;
}

/**
 * Progress of one task: completed segments (the percentage), stored bytes,
 * retries, and the current speed measured over a sliding window of received
 * bytes (so the figure reacts within seconds and drops to 0 when stalled).
 * Segments reused from an earlier run count as done and stored, but never as
 * received, so a resumed download shows its real position and real speed.
 * Khi biết plan (setPlan), tracker đếm thêm theo từng track để popup ước
 * lượng tổng dung lượng chính xác hơn (xem core/download/estimate.ts).
 */
export class ProgressTracker {
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #startedAt: number;
  #total: number;
  #done = 0;
  #bytes = 0;
  #retries = 0;
  #resumed = 0;
  #tracks = new Map<string, TrackTally>();
  #average: SpeedAverage | undefined;
  /** [time, bytes] samples of received data within the window. */
  readonly #samples: [number, number][] = [];

  constructor(total: number, now: () => number = Date.now, windowMs = 5000) {
    this.#total = total;
    this.#now = now;
    this.#windowMs = windowMs;
    this.#startedAt = now();
  }

  /** The segment list can change size once (single-file representations split into ranges). */
  setTotal(total: number): void {
    this.#total = total;
  }

  /** Plan của lần chạy: tổng số segment và, theo từng track, số media segment cùng kích thước khai báo. */
  setPlan(segments: readonly PlannedSegment[]): void {
    this.#total = segments.length;
    this.#tracks = new Map();
    for (const segment of segments) {
      if (segment.kind !== 'media') continue;
      const tally = this.#tally(segment.trackId);
      tally.segmentsTotal += 1;
      if (segment.byteRange && !segment.encryption) tally.declared += segment.byteRange.length;
      else tally.allDeclared = false;
    }
  }

  /** Segments (and their bytes) already stored by an earlier run, reused instead of downloaded. */
  resume(reused: readonly { segment?: PlannedSegment; bytes: number }[]): void {
    this.reset();
    for (const { segment, bytes } of reused) this.#count(bytes, segment);
    this.#resumed = reused.length;
  }

  /** The stored data was discarded. */
  reset(): void {
    this.#done = 0;
    this.#bytes = 0;
    this.#resumed = 0;
    for (const tally of this.#tracks.values()) {
      tally.segmentsDone = 0;
      tally.bytes = 0;
    }
  }

  received(bytes: number): void {
    if (bytes <= 0) return;
    this.#samples.push([this.#now(), bytes]);
    this.#prune();
  }

  segmentDone(storedBytes: number, segment?: PlannedSegment): void {
    this.#count(storedBytes, segment);
  }

  retried(): void {
    this.#retries += 1;
  }

  get done(): number {
    return this.#done;
  }

  snapshot(): TaskProgress {
    this.#prune();
    const now = this.#now();
    const windowStart = Math.max(this.#startedAt, now - this.#windowMs);
    const span = Math.max(1000, now - windowStart);
    const recent = this.#samples.reduce((sum, [, bytes]) => sum + bytes, 0);
    const bytesPerSecond = Math.round((recent * 1000) / span);
    this.#average = averageSpeed(this.#average, bytesPerSecond, now);
    const progress: TaskProgress = {
      segmentsTotal: this.#total,
      segmentsDone: this.#done,
      bytes: this.#bytes,
      bytesPerSecond,
      averageBytesPerSecond: Math.round(this.#average.bytesPerSecond),
      percent: percentOf(this.#done, this.#total),
      retries: this.#retries,
      startedAt: this.#startedAt,
    };
    if (this.#resumed > 0) progress.resumedSegments = this.#resumed;
    if (this.#tracks.size > 0) {
      progress.tracks = [...this.#tracks].map(([trackId, tally]): TrackProgress => ({
        trackId,
        segmentsTotal: tally.segmentsTotal,
        segmentsDone: tally.segmentsDone,
        bytes: tally.bytes,
        ...(tally.allDeclared ? { declaredBytes: tally.declared } : {}),
      }));
    }
    return progress;
  }

  #count(bytes: number, segment: PlannedSegment | undefined): void {
    this.#done += 1;
    this.#bytes += bytes;
    if (segment?.kind !== 'media') return;
    const tally = this.#tracks.get(segment.trackId);
    if (!tally) return;
    tally.segmentsDone += 1;
    tally.bytes += bytes;
  }

  #tally(trackId: string): TrackTally {
    let tally = this.#tracks.get(trackId);
    if (!tally) {
      tally = { segmentsTotal: 0, segmentsDone: 0, bytes: 0, declared: 0, allDeclared: true };
      this.#tracks.set(trackId, tally);
    }
    return tally;
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowMs;
    while (this.#samples.length > 0 && (this.#samples[0]?.[0] ?? 0) < cutoff) this.#samples.shift();
  }
}

/**
 * Progress of a progressive file (0.3.0) in the same model as segments, so
 * storage, estimates (estimate.ts) and the Queue tab work unchanged: one
 * "segment" (done when the whole file is in), the bytes received so far, and
 * the file size as the track's declared bytes when the server announced it.
 * Without a size there is no percentage, no estimate and no ETA. Speed and
 * retries come from `base` (a ProgressTracker fed with received bytes).
 */
export function fileProgress(base: TaskProgress, received: number, total: number | undefined, done: boolean): TaskProgress {
  const size = total !== undefined && total > 0 ? total : undefined;
  const { resumedSegments: _resumed, stale: _stale, ...rest } = base;
  let percent = 0;
  if (done) percent = 100;
  else if (size !== undefined) percent = Math.min(99.9, Math.floor((received / size) * 1000) / 10);
  return {
    ...rest,
    segmentsTotal: 1,
    segmentsDone: done ? 1 : 0,
    bytes: received,
    percent,
    tracks: [{ trackId: 'file', segmentsTotal: 1, segmentsDone: done ? 1 : 0, bytes: received, ...(size !== undefined ? { declaredBytes: size } : {}) }],
  };
}

/** Floored to 0.1 %, so 100 % appears only when everything is in. */
export function percentOf(done: number, total: number): number {
  return total === 0 ? 0 : Math.floor((Math.min(done, total) / total) * 1000) / 10;
}
