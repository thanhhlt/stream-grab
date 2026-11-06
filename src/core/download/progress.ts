import type { TaskProgress } from '@/core/models/download-task';

/**
 * Progress of one task: completed segments (the percentage), stored bytes,
 * retries, and the current speed measured over a sliding window of received
 * bytes (so the figure reacts within seconds and drops to 0 when stalled).
 * Segments reused from an earlier run count as done and stored, but never as
 * received, so a resumed download shows its real position and real speed.
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

  /** Segments (and their bytes) already stored by an earlier run, reused instead of downloaded. */
  resume(segments: number, bytes: number): void {
    this.#done = segments;
    this.#bytes = bytes;
    this.#resumed = segments;
  }

  /** The stored data was discarded. */
  reset(): void {
    this.#done = 0;
    this.#bytes = 0;
    this.#resumed = 0;
  }

  received(bytes: number): void {
    if (bytes <= 0) return;
    this.#samples.push([this.#now(), bytes]);
    this.#prune();
  }

  segmentDone(storedBytes: number): void {
    this.#done += 1;
    this.#bytes += storedBytes;
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
    const progress: TaskProgress = {
      segmentsTotal: this.#total,
      segmentsDone: this.#done,
      bytes: this.#bytes,
      bytesPerSecond: Math.round((recent * 1000) / span),
      percent: percentOf(this.#done, this.#total),
      retries: this.#retries,
      startedAt: this.#startedAt,
    };
    if (this.#resumed > 0) progress.resumedSegments = this.#resumed;
    return progress;
  }

  #prune(): void {
    const cutoff = this.#now() - this.#windowMs;
    while (this.#samples.length > 0 && (this.#samples[0]?.[0] ?? 0) < cutoff) this.#samples.shift();
  }
}

/** Floored to 0.1 %, so 100 % appears only when everything is in. */
export function percentOf(done: number, total: number): number {
  return total === 0 ? 0 : Math.floor((Math.min(done, total) / total) * 1000) / 10;
}
