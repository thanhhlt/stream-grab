import { formatBytes } from '@/shared/utils/bytes';
import { DiskFullError, StorageWriteError } from './retry-policy';

/**
 * Disk space for downloaded segments.
 *
 * The extension holds `unlimitedStorage`, so IndexedDB is not capped by the
 * usual per-origin quota and its data is not evicted under storage pressure;
 * Chrome then reports a quota of roughly "usage + free disk space" (minus a
 * margin it keeps for itself). The free space can still run out, so the
 * engine checks `navigator.storage.estimate()` before a run and regularly
 * while it writes, and stops while a reserve is left, rather than letting
 * writes fail on a full disk. A task stopped this way keeps its segments, so
 * Retry continues once space has been freed.
 */

export interface StorageEstimateLike {
  usage?: number | undefined;
  quota?: number | undefined;
}

export type EstimateStorage = () => Promise<StorageEstimateLike>;

/** Downloads stop while at least this much space is left (writes in flight need room too). */
export const DEFAULT_RESERVE_BYTES = 256 * 1024 * 1024;

const RETRY_HINT = 'Free up disk space, then press Retry: the download continues where it stopped.';

export function diskFullMessage(freeBytes?: number): string {
  return freeBytes === undefined
    ? `Not enough disk space to store the download. ${RETRY_HINT}`
    : `Not enough disk space to continue (${formatBytes(freeBytes)} free). ${RETRY_HINT}`;
}

/** Free bytes from an estimate; undefined when the browser does not say. */
export function freeBytesOf(estimate: StorageEstimateLike): number | undefined {
  const { usage, quota } = estimate;
  if (typeof usage !== 'number' || typeof quota !== 'number' || !Number.isFinite(usage) || !Number.isFinite(quota)) return undefined;
  return Math.max(0, quota - usage);
}

/** A failed IndexedDB write as a fatal segment error; a full disk or quota gets the disk-space message. */
export function storageFailure(error: unknown): StorageWriteError {
  if (error instanceof StorageWriteError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new DiskFullError(diskFullMessage(), { cause: error });
  }
  return new StorageWriteError(`Could not store a segment: ${error instanceof Error ? error.message : String(error)}`, {
    cause: error,
  });
}

export interface SpaceGuardOptions {
  reserveBytes?: number;
  /** Ask the browser again after this many bytes were written (by all tasks together). */
  recheckBytes?: number;
  /** …or when the last answer is older than this. */
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Shared by every task of the engine: one estimate serves all of them, and
 * bytes written since that estimate are subtracted locally, so the browser is
 * asked every `recheckBytes` rather than once per segment.
 */
export class SpaceGuard {
  readonly #estimate: EstimateStorage | undefined;
  readonly #reserve: number;
  readonly #recheckBytes: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  #free: number | undefined;
  #measuredAt = Number.NEGATIVE_INFINITY;
  #writtenSince = 0;
  #refreshing: Promise<void> | undefined;

  constructor(estimate: EstimateStorage | undefined, options: SpaceGuardOptions = {}) {
    this.#estimate = estimate;
    this.#reserve = options.reserveBytes ?? DEFAULT_RESERVE_BYTES;
    this.#recheckBytes = options.recheckBytes ?? 64 * 1024 * 1024;
    this.#maxAgeMs = options.maxAgeMs ?? 15_000;
    this.#now = options.now ?? Date.now;
  }

  get reserveBytes(): number {
    return this.#reserve;
  }

  written(bytes: number): void {
    if (bytes > 0) this.#writtenSince += bytes;
  }

  /** Free bytes as far as known (estimate minus what was written since). */
  async free(fresh = false): Promise<number | undefined> {
    if (!this.#estimate) return undefined;
    const stale = fresh || this.#writtenSince >= this.#recheckBytes || this.#now() - this.#measuredAt >= this.#maxAgeMs;
    if (stale) await this.#refresh();
    return this.#free === undefined ? undefined : Math.max(0, this.#free - this.#writtenSince);
  }

  /** @throws DiskFullError when less than the reserve is left. */
  async check(fresh = false): Promise<void> {
    const free = await this.free(fresh);
    if (free !== undefined && free < this.#reserve) throw new DiskFullError(diskFullMessage(free));
  }

  /** True when the disk is (nearly) full right now: tells a full disk apart from other write errors. */
  async isLow(): Promise<boolean> {
    const free = await this.free(true);
    return free !== undefined && free < this.#reserve;
  }

  #refresh(): Promise<void> {
    const estimate = this.#estimate;
    if (!estimate) return Promise.resolve();
    this.#refreshing ??= (async () => {
      const writtenBefore = this.#writtenSince;
      try {
        this.#free = freeBytesOf(await estimate());
      } catch {
        this.#free = undefined; // unknown: never block a download on a failed estimate
      }
      this.#measuredAt = this.#now();
      // Writes that finished while the browser was asked may or may not be counted in its answer; assume not.
      this.#writtenSince = Math.max(0, this.#writtenSince - writtenBefore);
    })().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }
}
