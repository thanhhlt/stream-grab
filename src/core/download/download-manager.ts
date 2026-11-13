import { isPageSubtitleId, type RequestContext } from '@/core/models/detected-stream';
import type { ProgressiveContainer } from '@/core/models/detected-stream';
import type { EngineReport, EngineTaskSpec, FailureReason, SaveRequest } from '@/core/models/download-task';
import type { TrackLayout } from '@/core/models/media-info';
import type { MediaSegment } from '@/core/models/media-segment';
import type { FetchFunction } from '@/core/network/manifest-fetcher';
import { describeDrm } from '@/core/protocols/drm';
import type { StreamingManifest, SubtitleTrack } from '@/core/models/streaming-manifest';
import type { VideoVariant } from '@/core/models/video-variant';
import type { ProtocolRegistry, StreamingProtocolAdapter } from '@/core/protocols/protocol-adapter';
import { errorMessage, StreamGrabError } from '@/shared/utils/errors';
import { stableHash } from '@/shared/utils/hash';
import { Aes128KeyCache } from './aes';
import { runWorkerPool } from './download-queue';
import { samplesFirst } from './estimate';
import type { SegmentStorage } from './download-storage';
import {
  DiskTarget,
  ifRangeValue,
  MemoryTarget,
  parseContentRange,
  responseRecord,
  resumePoint,
  unsatisfiedTotal,
  type FileRecord,
  type FileTarget,
} from './file-target';
import type { PartialFileStore } from './partial-files';
import { fileProgress, ProgressTracker } from './progress';
import {
  backoffDelay,
  classifyFailure,
  DEFAULT_RETRY_POLICY,
  DiskFullError,
  isAbortError,
  parseRetryAfter,
  SegmentContentError,
  SegmentFatalError,
  SegmentHttpError,
  SegmentTransferError,
  sleep,
  StorageWriteError,
  type RetryPolicy,
} from './retry-policy';
import { SegmentFetcher } from './segment-fetcher';
import { diskFullMessage, SpaceGuard, storageFailure, type EstimateStorage } from './storage-space';
import { buildLayout, sameLayout } from './track-layout';
import { matchVariant } from './variant-choice';

export interface DownloadManagerDeps {
  storage: SegmentStorage;
  /** Protocol adapters whose requests carry the task's request context. A fresh registry (empty caches) per call. */
  protocols(taskId: string): ProtocolRegistry;
  /** `fetch` for the task's segment and key requests (applies its request context). */
  fetchFor(taskId: string): FetchFunction;
  /** Latest manifest URL and context for the task (the page may have re-signed its link); null if unknown. */
  freshSource(taskId: string): Promise<{ manifestUrl: string; context: RequestContext } | null>;
  /** Drops the task's request-context rules (task finished, or its context changed). */
  releaseContexts(taskId: string): Promise<void>;
  report(report: EngineReport): void;
  now?: () => number;
  retryPolicy?: RetryPolicy;
  /** Parts written to storage while a segment streams in. */
  partSize?: number;
  /** Single-file representations larger than this are split into ranged chunks. */
  chunkSize?: number;
  reportIntervalMs?: number;
  stallTimeoutMs?: number;
  /** Manifest refreshes after expired-link errors, per task. */
  maxRefreshes?: number;
  /** How long cancel()/syncSettled() wait for stopped tasks to clean up. */
  settleTimeoutMs?: number;
  random?: () => number;
  /** `navigator.storage.estimate`; without it free disk space is not checked. */
  estimateStorage?: EstimateStorage;
  /**
   * Progressive files fetched by the engine (0.3.0): hands the file to the
   * service worker (engine/save), which has Chrome save it. True when taken.
   */
  saveFile?: (request: SaveRequest) => Promise<boolean>;
  /**
   * Disk files for progressive files the engine fetches (0.6.0): a later run
   * continues them. Without it they stream into Blob parts and every run
   * starts over.
   */
  partialFiles?: PartialFileStore;
  /** URL.createObjectURL / revokeObjectURL (injectable for tests). */
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  /** Downloads stop while this much disk space is still free. */
  reserveBytes?: number;
  /** Free space is re-measured after this many bytes were written. */
  spaceRecheckBytes?: number;
}

/** A failure with a message meant for the user. */
export class TaskFailure extends Error {
  readonly reason: FailureReason | undefined;
  /** The stored segments cannot be used by a later run: delete them. */
  readonly discardData: boolean;

  constructor(message: string, options: ErrorOptions & { reason?: FailureReason; discardData?: boolean } = {}) {
    super(message, options);
    this.name = 'TaskFailure';
    this.reason = options.reason;
    this.discardData = options.discardData ?? false;
  }
}

export const EXPIRED_LINK_MESSAGE =
  'The video link expired or access was denied. Play the video again on its page, then press Retry.';

export const VIDEO_CHANGED_MESSAGE = 'The video changed on the server since the download started. Remove it and download it again.';

/** A continuation the server answered for other bytes than asked: the file starts over. */
class ResumeMismatch extends Error {
  constructor() {
    super('The server sent other bytes than the rest of the file');
    this.name = 'ResumeMismatch';
  }
}

const expiredLink = (cause: unknown): TaskFailure => new TaskFailure(EXPIRED_LINK_MESSAGE, { cause, reason: 'expired' });

/** A segment list and its per-track layout (what media processing reads back). */
interface Planned {
  segments: MediaSegment[];
  layout: TrackLayout[];
}

interface Run {
  spec: EngineTaskSpec;
  controller: AbortController;
  tracker: ProgressTracker;
  plan: MediaSegment[];
  layout: TrackLayout[];
  /** Incremented when the plan's URLs are refreshed. */
  generation: number;
  refreshes: number;
  refreshing: Promise<void> | undefined;
  lastReport: number;
  finished: Promise<void>;
}

const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024;

function describeSegmentError(error: unknown): string {
  if (error instanceof SegmentContentError) {
    return `${error.message} (HTTP 200). The link may have expired, or the site may want you signed in: play the video again on its page, then press Retry`;
  }
  if (error instanceof SegmentHttpError) {
    if (error.status >= 500) return `Server error (HTTP ${error.status})`;
    if (error.status === 429) return 'The server is rate-limiting requests (HTTP 429)';
    return `Request failed (HTTP ${error.status})`;
  }
  return errorMessage(error);
}

/**
 * Identity of a segment list, independent of its URLs (signed links change,
 * the video does not): tracks, positions, kinds, byte ranges and durations.
 * Stored data is reused only by a run whose list has the same signature.
 */
export function planSignature(plan: readonly MediaSegment[]): string {
  const shape = plan
    .map((s) => [s.trackId, s.index, s.kind, s.byteRange?.offset ?? '', s.byteRange?.length ?? '', Math.round(s.duration * 1000)].join(','))
    .join(';');
  return `${plan.length}-${stableHash(shape)}`;
}

const segmentKey = (trackId: string, index: number): string => `${index}:${trackId}`;

/**
 * Runs download tasks inside the offscreen document.
 *
 * Per task: parse the manifest through the protocol adapter, resolve the
 * chosen variant and audio tracks into an ordered segment list, then fetch
 * segments with a bounded worker pool (`concurrency`), each written to
 * storage under its track and position (so completion order never matters)
 * and marked complete once all its parts are in. Failed requests are retried
 * with exponential backoff; expired links trigger a manifest refresh
 * (preferring the URL the page used most recently). Progress is reported at
 * most every `reportIntervalMs`, the outcome once.
 *
 * Resume: a run whose segment list matches what storage holds (same plan
 * signature) fetches only the segments without a valid completion marker, so
 * Retry, a service-worker restart and a browser restart continue where the
 * previous run stopped. A failed run keeps its segments; a cancelled one
 * deletes them.
 */
export class DownloadManager {
  readonly #deps: DownloadManagerDeps;
  readonly #now: () => number;
  readonly #policy: RetryPolicy;
  readonly #space: SpaceGuard;
  readonly #runs = new Map<string, Run>();
  readonly #createUrl: (blob: Blob) => string;
  readonly #revokeUrl: (url: string) => void;

  constructor(deps: DownloadManagerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#createUrl = deps.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.#revokeUrl = deps.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
    this.#policy = deps.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.#space = new SpaceGuard(deps.estimateStorage, {
      ...(deps.reserveBytes !== undefined ? { reserveBytes: deps.reserveBytes } : {}),
      ...(deps.spaceRecheckBytes !== undefined ? { recheckBytes: deps.spaceRecheckBytes } : {}),
      now: this.#now,
    });
  }

  /** Runs exactly `specs`: starts new tasks, keeps running ones, cancels the others. Returns the running IDs. */
  sync(specs: readonly EngineTaskSpec[]): string[] {
    const wanted = new Set(specs.map((spec) => spec.taskId));
    for (const [taskId, run] of this.#runs) {
      if (!wanted.has(taskId)) run.controller.abort();
    }
    for (const spec of specs) {
      if (!this.#runs.has(spec.taskId)) this.#start(spec);
    }
    return specs.map((spec) => spec.taskId).filter((id) => this.#runs.has(id));
  }

  /**
   * Like sync(), but resolves only once the tasks it stopped have finished
   * cleaning up (deleting their data, releasing their rules), within
   * `settleTimeoutMs`. The service worker closes the offscreen document right
   * after an empty sync, which would otherwise cut that cleanup short.
   */
  async syncSettled(specs: readonly EngineTaskSpec[]): Promise<string[]> {
    const wanted = new Set(specs.map((spec) => spec.taskId));
    const stopping = this.running.filter((taskId) => !wanted.has(taskId));
    const running = this.sync(specs);
    await this.#settle(stopping);
    return running;
  }

  /** Aborts these tasks; resolves once they have stopped and deleted their data (within `settleTimeoutMs`). */
  async cancel(taskIds: readonly string[]): Promise<void> {
    for (const taskId of taskIds) this.#runs.get(taskId)?.controller.abort();
    await this.#settle(taskIds);
  }

  get running(): string[] {
    return [...this.#runs.keys()];
  }

  /** Resolves when every task has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.allSettled([...this.#runs.values()].map((run) => run.finished));
  }

  async #settle(taskIds: readonly string[]): Promise<void> {
    const pending = taskIds.flatMap((taskId) => {
      const run = this.#runs.get(taskId);
      return run ? [run.finished] : [];
    });
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#deps.settleTimeoutMs ?? 15_000);
    });
    await Promise.race([Promise.allSettled(pending), timeout]);
    clearTimeout(timer);
  }

  #start(spec: EngineTaskSpec): void {
    const run: Run = {
      spec,
      controller: new AbortController(),
      tracker: new ProgressTracker(0, this.#now),
      plan: [],
      layout: [],
      generation: 0,
      refreshes: 0,
      refreshing: undefined,
      lastReport: 0,
      finished: Promise.resolve(),
    };
    this.#runs.set(spec.taskId, run);
    run.finished = (spec.protocol === 'progressive' ? this.#runFile(run) : this.#run(run)).finally(() => {
      if (this.#runs.get(spec.taskId) === run) this.#runs.delete(spec.taskId);
    });
  }

  async #run(run: Run): Promise<void> {
    const { spec, controller } = run;
    const signal = controller.signal;
    const storage = this.#deps.storage;
    try {
      await this.#checkSpace(true); // a full disk fails at once, before any request
      ({ segments: run.plan, layout: run.layout } = await this.#initialPlan(run, signal));
      run.tracker.setPlan(run.plan);
      const plan = run.plan;
      const pending = samplesFirst(await this.#prepareStorage(run), (position) => plan[position]?.trackId ?? '');
      this.#report(run, true);

      const fetch = this.#deps.fetchFor(spec.taskId);
      const fetcher = new SegmentFetcher({
        fetch,
        keys: new Aes128KeyCache((url, keySignal) => this.#fetchKey(fetch, url, keySignal)),
        ...(this.#deps.partSize !== undefined ? { partSize: this.#deps.partSize } : {}),
        ...(this.#deps.stallTimeoutMs !== undefined ? { stallTimeoutMs: this.#deps.stallTimeoutMs } : {}),
      });
      await runWorkerPool(
        pending,
        spec.concurrency,
        (position, workerSignal) => this.#downloadSegment(run, fetcher, position, workerSignal),
        signal,
      );
      this.#finish(run, { status: 'downloaded' });
    } catch (error) {
      if (signal.aborted) {
        // Cancelled or removed: nobody wants this data any more.
        await storage.deleteTask(spec.taskId).catch(() => undefined);
        this.#finish(run, { status: 'cancelled' });
      } else {
        const failure = error instanceof TaskFailure ? error : new TaskFailure(errorMessage(error), { cause: error });
        if (failure.discardData) {
          await storage.deleteTask(spec.taskId).catch(() => undefined);
          run.tracker.reset();
        }
        // Otherwise the completed segments stay: Retry continues from them.
        this.#finish(run, {
          status: 'failed',
          message: failure.message,
          ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
        });
      }
    } finally {
      await this.#deps.releaseContexts(spec.taskId).catch(() => undefined);
    }
  }

  /**
   * The segment list at the start of a run. If the stored link expired (a
   * resumed or retried task), the newest detection of the video may carry a
   * fresh one: try it once before giving up.
   */
  async #initialPlan(run: Run, signal: AbortSignal): Promise<Planned> {
    const { spec } = run;
    try {
      return await this.#plan(spec, spec.manifestUrl, spec.context, signal);
    } catch (error) {
      if (!(error instanceof TaskFailure) || error.reason !== 'expired') throw error;
      const fresh = await this.#deps.freshSource(spec.taskId).catch(() => null);
      if (!fresh || (fresh.manifestUrl === spec.manifestUrl && sameContext(fresh.context, spec.context))) throw error;
      run.refreshes += 1;
      await this.#deps.releaseContexts(spec.taskId).catch(() => undefined); // the context may have changed
      return await this.#plan(spec, fresh.manifestUrl, fresh.context, signal);
    }
  }

  /**
   * Matches storage to the plan and returns the positions still to download.
   * Same plan as stored: complete segments are reused, interrupted ones
   * dropped. Different or no plan: the task's data is replaced by an empty
   * plan (fresh start). The plan record carries the tracks' layout; one
   * stored before it existed (Phase 7) gets it now.
   */
  async #prepareStorage(run: Run): Promise<number[]> {
    const { spec, plan, layout, tracker } = run;
    const storage = this.#deps.storage;
    const signature = planSignature(plan);
    try {
      const stored = await storage.getPlan(spec.taskId);
      if (stored?.signature !== signature) {
        await storage.resetTask({ taskId: spec.taskId, signature, segmentsTotal: plan.length, updatedAt: this.#now(), layout });
        return plan.map((_, position) => position);
      }
      if (!sameLayout(stored.layout, layout)) await storage.savePlan({ ...stored, layout, updatedAt: this.#now() });
      const { complete, incomplete } = await storage.inspectTask(spec.taskId);
      // Parts of interrupted writes go, so those segments are fetched whole again.
      await storage.deleteSegments(spec.taskId, incomplete);
      const reusable = new Map(complete.map((segment) => [segmentKey(segment.trackId, segment.index), segment.bytes]));
      const pending: number[] = [];
      const reused: { segment: MediaSegment; bytes: number }[] = [];
      plan.forEach((segment, position) => {
        const storedBytes = reusable.get(segmentKey(segment.trackId, segment.index));
        if (storedBytes === undefined) pending.push(position);
        else reused.push({ segment, bytes: storedBytes });
      });
      tracker.resume(reused);
      return pending;
    } catch (error) {
      throw await this.#storageFailure(storageFailure(error));
    }
  }

  async #downloadSegment(run: Run, fetcher: SegmentFetcher, position: number, signal: AbortSignal): Promise<void> {
    const { spec, tracker } = run;
    const storage = this.#deps.storage;
    /** Parts of a failed attempt are stored: delete them before the next one. */
    let dirty = false;
    for (let attempt = 1; ; attempt += 1) {
      const generation = run.generation;
      const segment = run.plan[position];
      if (!segment) throw new TaskFailure('Internal error: segment list changed unexpectedly');
      const key = { taskId: spec.taskId, trackId: segment.trackId, index: segment.index };
      try {
        if (dirty) {
          await storage.deleteSegment(key.taskId, key.trackId, key.index).catch((error: unknown) => {
            throw storageFailure(error);
          });
          dirty = false;
        }
        let stored = 0;
        const result = await fetcher.download(
          segment,
          async (part, data) => {
            dirty = true;
            await storage.put({ ...key, part }, new Blob([data]));
            stored += data.byteLength;
          },
          signal,
          (bytes) => {
            tracker.received(bytes);
            this.#report(run);
          },
        );
        // Only now is the segment complete: a run interrupted before this line fetches it again.
        await storage.completeSegment({ ...key, bytes: stored, parts: result.parts }).catch((error: unknown) => {
          throw storageFailure(error);
        });
        tracker.segmentDone(stored, segment);
        this.#space.written(stored);
        this.#report(run);
        break;
      } catch (error) {
        const kind = classifyFailure(error);
        if (kind === 'aborted') throw error;
        if (error instanceof StorageWriteError) throw await this.#storageFailure(error);
        const where = `Segment ${position + 1} of ${run.plan.length}`;
        const givingUp = kind === 'fatal' || attempt >= this.#policy.maxAttempts;
        // A page subtitle file (0.7.2) is not in the manifest: a refresh cannot renew its link, and must not
        // risk the video (re-reading an expired manifest would fail the task).
        if (kind === 'expired' && !isPageSubtitleId(segment.trackId)) {
          if (await this.#refresh(run, generation, signal)) {
            attempt -= 1; // a refresh is not a failed attempt; refreshes themselves are capped
            continue;
          }
          if (segment.trackType !== 'subtitle') throw expiredLink(error);
        }
        if (segment.trackType === 'subtitle' && (givingUp || kind === 'expired')) {
          // Subtitles never cost the video (0.7.0): the segment is stored empty, and its cues are missing from the file.
          await this.#skipSegment(run, key, segment, dirty);
          break;
        }
        if (kind === 'fatal') {
          throw new TaskFailure(error instanceof SegmentFatalError ? error.message : `${where}: ${describeSegmentError(error)}`, {
            cause: error,
          });
        }
        if (attempt >= this.#policy.maxAttempts) {
          throw new TaskFailure(`${where} failed after ${attempt} attempts: ${describeSegmentError(error)}`, { cause: error });
        }
        tracker.retried();
        this.#report(run);
        const retryAfter = error instanceof SegmentHttpError ? error.retryAfterMs : undefined;
        await sleep(backoffDelay(attempt, this.#policy, retryAfter, this.#deps.random), signal);
      }
    }
    await this.#checkSpace();
  }

  /** Stores a segment as complete without data (a subtitle segment the server would not give). */
  async #skipSegment(run: Run, key: { taskId: string; trackId: string; index: number }, segment: MediaSegment, dirty: boolean): Promise<void> {
    try {
      if (dirty) await this.#deps.storage.deleteSegment(key.taskId, key.trackId, key.index);
      await this.#deps.storage.completeSegment({ ...key, bytes: 0, parts: 0 });
    } catch (error) {
      throw await this.#storageFailure(storageFailure(error));
    }
    run.tracker.segmentDone(0, segment);
    this.#report(run);
  }

  /** @throws TaskFailure (disk full) when less than the reserve is free. */
  async #checkSpace(fresh = false): Promise<void> {
    try {
      await this.#space.check(fresh);
    } catch (error) {
      throw new TaskFailure(errorMessage(error), { cause: error, reason: 'disk-full' });
    }
  }

  /** A write error as the user's failure; a nearly full disk explains errors that do not say so themselves. */
  async #storageFailure(error: StorageWriteError): Promise<TaskFailure> {
    if (error instanceof DiskFullError) return new TaskFailure(error.message, { cause: error, reason: 'disk-full' });
    if (await this.#space.isLow().catch(() => false)) {
      return new TaskFailure(diskFullMessage(await this.#space.free()), { cause: error, reason: 'disk-full' });
    }
    return new TaskFailure(error.message, { cause: error });
  }

  /**
   * Re-reads the manifest after an expired-link error, once per wave of
   * failures: workers that failed on the old URLs share one refresh. Returns
   * whether the segments now have new URLs worth retrying.
   */
  async #refresh(run: Run, seenGeneration: number, signal: AbortSignal): Promise<boolean> {
    if (run.generation !== seenGeneration) return true;
    if (!run.refreshing) {
      if (run.refreshes >= (this.#deps.maxRefreshes ?? 2)) return false;
      run.refreshes += 1;
      run.refreshing = (async () => {
        const fresh = await this.#deps.freshSource(run.spec.taskId).catch(() => null);
        if (fresh) await this.#deps.releaseContexts(run.spec.taskId); // context may have changed; rules are re-acquired lazily
        const source = fresh ?? { manifestUrl: run.spec.manifestUrl, context: run.spec.context };
        const { segments } = await this.#plan(run.spec, source.manifestUrl, source.context, signal);
        if (planSignature(segments) !== planSignature(run.plan)) {
          // Stored segments belong to the old version: useless for any later run.
          throw new TaskFailure(VIDEO_CHANGED_MESSAGE, { discardData: true });
        }
        run.plan = segments;
        run.generation += 1;
      })().finally(() => {
        run.refreshing = undefined;
      });
    }
    try {
      await run.refreshing;
      return run.generation !== seenGeneration;
    } catch (error) {
      if (error instanceof TaskFailure || isAbortError(error)) throw error;
      return false;
    }
  }

  /**
   * A progressive file fetched by the engine (0.3.0, ProgressiveFetch
   * `extension`): its server wants the page's Referer/Origin, which only the
   * engine's requests carry (DNR leases; Chrome's own downloads get none).
   * The body streams to a file on disk (0.6.0, see file-target.ts; Blob parts
   * when that is not possible), then goes to the service worker as a blob:
   * URL that Chrome saves like a merged video; the URL is held until the
   * service worker drops the task, which deletes the file once Chrome has
   * saved it (a cancelled run deletes its own).
   *
   * Failures are retried like a segment's (retry policy, an expired link
   * refreshed from the newest detection). Every attempt, and every later run
   * (Retry, a restarted browser), continues the file with a Range request
   * when its first response carried a validator (If-Range): 206 continues
   * it, 200 (the file changed, or no range support) starts it over, 416 with
   * the size held means it was complete. Without a validator it starts over.
   */
  async #runFile(run: Run): Promise<void> {
    const { spec, controller } = run;
    const signal = controller.signal;
    let total = spec.file?.bytes;
    let received = 0;
    let url: string | undefined;
    let target: FileTarget | undefined;
    /** Delete the file when the run ends: the task was cancelled while it ran. */
    let discard = false;
    const report = (force: boolean, done = false): void => {
      const now = this.#now();
      if (!force && now - run.lastReport < (this.#deps.reportIntervalMs ?? 500)) return;
      run.lastReport = now;
      this.#deps.report({ taskId: spec.taskId, progress: fileProgress(run.tracker.snapshot(), received, total, done) });
    };
    try {
      const container = spec.file?.container;
      const saveFile = this.#deps.saveFile;
      if (!container || !saveFile) throw new TaskFailure('This engine cannot download single video files.');
      await this.#checkSpace(true);
      run.plan = [fileSegment(spec.manifestUrl, container)];
      run.tracker.setPlan(run.plan);
      target = await this.#fileTarget(spec.taskId, container);
      const file = target;
      total = file.record?.total ?? total;
      received = resumePoint(file);
      report(true);
      const fetcher = new SegmentFetcher({
        fetch: this.#deps.fetchFor(spec.taskId),
        keys: new Aes128KeyCache(() => Promise.reject(new Error('A video file has no keys'))),
        ...(this.#deps.partSize !== undefined ? { partSize: this.#deps.partSize } : {}),
        ...(this.#deps.stallTimeoutMs !== undefined ? { stallTimeoutMs: this.#deps.stallTimeoutMs } : {}),
      });
      /** A full disk found while the file streams in (the fetcher would report it as a write error). */
      let diskFull: TaskFailure | undefined;
      /** The server answered a continuation unexpectedly: the next request starts over. */
      let startOver = false;
      /** The file's size as its server announced it (never the detection's guess): what "complete" means. */
      let serverTotal = file.record?.total;
      for (let attempt = 1; ; attempt += 1) {
        const from = startOver ? 0 : resumePoint(file);
        startOver = false;
        if (from > 0 && from === file.record?.total) break; // complete already (e.g. the browser closed while saving)
        received = from;
        /** Set by a response that starts the file over; applied with its first bytes (a refused body keeps the file). */
        let fresh: FileRecord | undefined;
        /** The same, for the progress shown: applied once the body passed the content check. */
        let freshProgress: FileRecord | undefined;
        /** The total of a 416 answer. */
        let unsatisfied: number | undefined;
        try {
          const segment = run.plan[0] ?? fileSegment(spec.manifestUrl, container);
          const validator = ifRangeValue(file.record);
          await fetcher.download(
            from > 0 && validator !== undefined ? { url: segment.url, from, headers: { 'If-Range': validator } } : { url: segment.url },
            async (_part, data) => {
              if (fresh) {
                await file.restart(fresh);
                fresh = undefined;
              }
              const length = data.byteLength; // read first: append may transfer the buffer
              await file.append(data);
              this.#space.written(length);
              try {
                await this.#checkSpace();
              } catch (error) {
                diskFull = error instanceof TaskFailure ? error : undefined;
                throw error;
              }
            },
            signal,
            (bytes) => {
              if (freshProgress) {
                received = 0;
                total = freshProgress.total ?? total;
                serverTotal = freshProgress.total;
                freshProgress = undefined;
              }
              received += bytes;
              run.tracker.received(bytes);
              report(false);
            },
            {
              onResponse: (response) => {
                if (response.status === 416) {
                  unsatisfied = unsatisfiedTotal(response.headers.get('content-range'));
                } else if (response.status === 206 && from > 0) {
                  const range = parseContentRange(response.headers.get('content-range'));
                  const known = file.record?.total;
                  if (!range || range.start !== from || (range.total !== undefined && known !== undefined && range.total !== known)) {
                    throw new ResumeMismatch();
                  }
                  total = range.total ?? total;
                  serverTotal = range.total ?? serverTotal;
                } else if (response.status === 200 || response.status === 206) {
                  // The whole file: a first request, a file that changed (If-Range), or a server without ranges.
                  fresh = responseRecord(response);
                  freshProgress = fresh;
                }
              },
            },
          );
          // A server may answer an open range with only part of the rest (a capped 206): go on from there.
          // Every pass adds bytes (an empty body fails), so this ends.
          if (serverTotal !== undefined && file.size < serverTotal && resumePoint(file) > 0) {
            attempt -= 1;
            continue;
          }
          if (serverTotal !== undefined && file.size !== serverTotal) {
            throw new SegmentTransferError(`The video file has ${file.size} of ${serverTotal} bytes`);
          }
          break;
        } catch (error) {
          if (diskFull) throw diskFull;
          if (error instanceof ResumeMismatch) {
            startOver = true;
            attempt -= 1; // the next request has no range: this cannot repeat
            continue;
          }
          if (from > 0 && error instanceof SegmentHttpError && error.status === 416) {
            if (unsatisfied === from) break; // nothing left to fetch: the file is complete
            startOver = true;
            attempt -= 1;
            continue;
          }
          const kind = classifyFailure(error);
          if (kind === 'aborted' || error instanceof TaskFailure) throw error;
          if (error instanceof StorageWriteError) throw await this.#storageFailure(error);
          if (kind === 'expired') {
            if (await this.#refreshFile(run, container)) {
              attempt -= 1; // a fresh link is not a failed attempt; refreshes are capped
              continue;
            }
            throw expiredLink(error);
          }
          if (kind === 'fatal') throw new TaskFailure(`The video file could not be downloaded: ${describeSegmentError(error)}`, { cause: error });
          if (attempt >= this.#policy.maxAttempts) {
            throw new TaskFailure(`The video file could not be downloaded after ${attempt} attempts: ${describeSegmentError(error)}`, { cause: error });
          }
          run.tracker.retried();
          report(true);
          const retryAfter = error instanceof SegmentHttpError ? error.retryAfterMs : undefined;
          await sleep(backoffDelay(attempt, this.#policy, retryAfter, this.#deps.random), signal);
        }
      }
      await this.#deps.releaseContexts(spec.taskId).catch(() => undefined);
      const blob = await file.complete(container === 'webm' ? 'video/webm' : 'video/mp4');
      run.tracker.segmentDone(blob.size, run.plan[0]);
      received = blob.size;
      report(true, true);
      url = this.#createUrl(blob);
      // Not taken: cancelled meanwhile (the file goes), or Chrome refused it (the service worker failed the
      // task; the file stays for Retry, which saves it without fetching it again).
      const saved = await saveFile({ taskId: spec.taskId, url, size: blob.size });
      if (!saved) {
        discard = signal.aborted;
        return;
      }
      // Chrome reads the file from this URL while it saves it: hold it until the service worker lets go. The
      // file stays: the service worker deletes it once Chrome has saved it, or with a cancelled or removed task
      // (a save Chrome gave up on is retried from it).
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } catch (error) {
      if (signal.aborted) {
        discard = true;
        this.#finish(run, { status: 'cancelled' });
      } else {
        const failure = error instanceof TaskFailure ? error : new TaskFailure(errorMessage(error), { cause: error });
        this.#deps.report({
          taskId: spec.taskId,
          progress: fileProgress(run.tracker.snapshot(), received, total, false),
          outcome: { status: 'failed', message: failure.message, ...(failure.reason !== undefined ? { reason: failure.reason } : {}) },
        });
      }
    } finally {
      if (url !== undefined) this.#revokeUrl(url);
      if (target) await (discard ? target.discard() : target.release()).catch(() => undefined);
      await this.#deps.releaseContexts(spec.taskId).catch(() => undefined);
    }
  }

  /** The task's file on disk, as earlier runs left it; Blob parts for this run when disk files are not available. */
  async #fileTarget(taskId: string, container: ProgressiveContainer): Promise<FileTarget> {
    const store = this.#deps.partialFiles;
    if (store) {
      const disk = await DiskTarget.open(store, taskId, container).catch(() => undefined);
      if (disk) return disk;
    }
    return new MemoryTarget();
  }

  /** A newer link (or context) for a progressive file whose link expired; false when there is none. */
  async #refreshFile(run: Run, container: ProgressiveContainer): Promise<boolean> {
    if (run.refreshes >= (this.#deps.maxRefreshes ?? 2)) return false;
    run.refreshes += 1;
    const fresh = await this.#deps.freshSource(run.spec.taskId).catch(() => null);
    const current = run.plan[0]?.url ?? run.spec.manifestUrl;
    if (!fresh || (fresh.manifestUrl === current && sameContext(fresh.context, run.spec.context))) return false;
    await this.#deps.releaseContexts(run.spec.taskId).catch(() => undefined); // rules are re-acquired with the new context
    run.plan = [fileSegment(fresh.manifestUrl, container)];
    run.spec = { ...run.spec, manifestUrl: fresh.manifestUrl, context: fresh.context };
    return true;
  }

  /** Manifest → chosen variant and audio tracks → ordered segment list and its layout. */
  async #plan(spec: EngineTaskSpec, manifestUrl: string, context: RequestContext, signal: AbortSignal): Promise<Planned> {
    if (spec.protocol === 'progressive') throw new TaskFailure('Internal error: a video file has no manifest.');
    const adapter = this.#deps.protocols(spec.taskId).forProtocol(spec.protocol);
    if (!adapter) throw new TaskFailure(`${spec.protocol.toUpperCase()} is not supported.`);
    try {
      const manifest = await adapter.parseManifest(manifestUrl, { context, signal });
      if (manifest.drmSystems.length > 0) throw new TaskFailure(describeDrm(manifest.drmSystems));
      if (manifest.isLive) throw new TaskFailure('Live streams cannot be downloaded yet.');
      const variant = matchVariant(manifest.variants, spec.variant);
      if (!variant) throw new TaskFailure('The selected quality is no longer offered. Download the video again.');
      const segments = await this.#segments(adapter, manifest, variant, spec, signal);
      if (segments.some((segment) => segment.encryption?.method === 'SAMPLE-AES')) {
        throw new TaskFailure('SAMPLE-AES encrypted streams are not supported yet.');
      }
      const pageFiles = pageSubtitleTracks(spec, segments);
      const split = await this.#splitSingleFiles(spec.taskId, [...segments, ...pageFiles.segments], signal);
      return { segments: split, layout: buildLayout(split, manifest.audioTracks, [...(manifest.subtitleTracks ?? []), ...pageFiles.tracks]) };
    } catch (error) {
      if (error instanceof TaskFailure || isAbortError(error)) throw error;
      if (error instanceof StreamGrabError && error.code === 'MANIFEST_UNAVAILABLE' && /HTTP (401|403|404|410)/.test(error.message)) {
        throw expiredLink(error);
      }
      throw new TaskFailure(errorMessage(error), { cause: error });
    }
  }

  /**
   * The segments of the variant, its audio tracks and its subtitle tracks.
   * Subtitles never cost the video (0.7.0): when the list with them fails, it
   * is made without them, and each subtitle track is then added on its own if
   * it can be (a track whose playlist is gone is left out).
   */
  async #segments(
    adapter: StreamingProtocolAdapter,
    manifest: StreamingManifest,
    variant: VideoVariant,
    spec: EngineTaskSpec,
    signal: AbortSignal,
  ): Promise<MediaSegment[]> {
    const subtitleTrackIds = spec.subtitleTrackIds ?? [];
    const media = { audioTrackIds: spec.audioTrackIds, signal };
    if (subtitleTrackIds.length === 0) return adapter.getSegments(manifest, variant, media);
    try {
      return await adapter.getSegments(manifest, variant, { ...media, subtitleTrackIds });
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    const segments = await adapter.getSegments(manifest, variant, media);
    for (const trackId of subtitleTrackIds) {
      try {
        const withTrack = await adapter.getSegments(manifest, variant, { audioTrackIds: [], subtitleTrackIds: [trackId], signal });
        segments.push(...withTrack.filter((segment) => segment.trackType === 'subtitle'));
      } catch (error) {
        if (isAbortError(error)) throw error;
      }
    }
    return segments;
  }

  /**
   * A track that is one whole file (DASH SegmentBase, plain MP4) would be one
   * request: when the server reports its size, cut it into ranged chunks so it
   * downloads in parallel and resumes in pieces. Subtitle files stay whole.
   */
  async #splitSingleFiles(taskId: string, segments: MediaSegment[], signal: AbortSignal): Promise<MediaSegment[]> {
    const chunkSize = this.#deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const byTrack = new Map<string, MediaSegment[]>();
    for (const segment of segments) byTrack.set(segment.trackId, [...(byTrack.get(segment.trackId) ?? []), segment]);
    const result: MediaSegment[] = [];
    for (const track of byTrack.values()) {
      const only = track.length === 1 ? track[0] : undefined;
      // A subtitle file is small, and each request of it must be a whole WebVTT file.
      const size = only && only.kind === 'media' && only.trackType !== 'subtitle' && !only.byteRange && !only.encryption
        ? await this.#probeSize(taskId, only.url, signal)
        : undefined;
      if (!only || size === undefined || size <= chunkSize) {
        result.push(...track);
        continue;
      }
      const count = Math.ceil(size / chunkSize);
      for (let index = 0; index < count; index++) {
        const offset = index * chunkSize;
        result.push({
          ...only,
          id: `${only.trackId}:${index}`,
          index,
          byteRange: { offset, length: Math.min(chunkSize, size - offset) },
          duration: only.duration / count,
        });
      }
    }
    return result;
  }

  /**
   * Total size from a one-byte range request; undefined when the server does
   * not support ranges. Transient errors are retried rather than taken for
   * "no range support": the split decides the segment list, and a different
   * list on resume would discard the stored chunks.
   */
  async #probeSize(taskId: string, url: string, signal: AbortSignal): Promise<number | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      let failure: unknown;
      try {
        const response = await this.#deps.fetchFor(taskId)(url, {
          credentials: 'include',
          cache: 'no-store',
          headers: { Range: 'bytes=0-0' },
          signal,
        });
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 206) {
          const total = /\/(\d+)\s*$/.exec(response.headers.get('content-range') ?? '')?.[1];
          return total === undefined ? undefined : Number(total);
        }
        if (response.ok) return undefined; // 200: the whole file, no range support
        failure = new SegmentHttpError(response.status, parseRetryAfter(response.headers.get('retry-after')));
      } catch (error) {
        if (isAbortError(error)) throw error;
        failure = error;
      }
      const kind = classifyFailure(failure);
      if (kind === 'expired') throw expiredLink(failure);
      if (kind !== 'retryable') return undefined; // e.g. 416: no ranges for this file
      if (attempt >= this.#policy.maxAttempts) {
        throw new TaskFailure(`Could not read the size of the video file: ${describeSegmentError(failure)}`, { cause: failure });
      }
      const retryAfter = failure instanceof SegmentHttpError ? failure.retryAfterMs : undefined;
      await sleep(backoffDelay(attempt, this.#policy, retryAfter, this.#deps.random), signal);
    }
  }

  async #fetchKey(fetch: FetchFunction, url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...(signal ? { signal } : {}) });
    if (!response.ok) throw new SegmentHttpError(response.status);
    return response.arrayBuffer();
  }

  #report(run: Run, force = false): void {
    const now = this.#now();
    if (!force && now - run.lastReport < (this.#deps.reportIntervalMs ?? 500)) return;
    run.lastReport = now;
    this.#deps.report({ taskId: run.spec.taskId, progress: run.tracker.snapshot() });
  }

  #finish(run: Run, outcome: NonNullable<EngineReport['outcome']>): void {
    this.#deps.report({ taskId: run.spec.taskId, progress: run.tracker.snapshot(), outcome });
  }
}

/** A whole progressive file as one "segment" of one track, so the segment fetcher downloads it. */
function fileSegment(url: string, container: ProgressiveContainer): MediaSegment {
  return {
    id: 'file:0',
    trackId: 'file',
    trackType: 'main',
    index: 0,
    kind: 'media',
    url,
    duration: 0,
    discontinuity: 0,
    container: container === 'webm' ? 'webm' : 'unknown',
  };
}

/**
 * The page's own WebVTT files (0.7.2) as one-segment subtitle tracks after the
 * stream's own, each lasting as long as the video (it covers all of it).
 */
function pageSubtitleTracks(spec: EngineTaskSpec, segments: readonly MediaSegment[]): { segments: MediaSegment[]; tracks: SubtitleTrack[] } {
  const files = (spec.pageSubtitles ?? []).filter((file) => !segments.some((segment) => segment.trackId === file.id));
  const duration = segments.reduce((sum, segment) => (segment.trackType === 'main' && segment.kind === 'media' ? sum + segment.duration : sum), 0);
  return {
    segments: files.map((file) => ({
      id: `${file.id}:0`,
      trackId: file.id,
      trackType: 'subtitle',
      index: 0,
      kind: 'media',
      url: file.url,
      duration,
      discontinuity: 0,
      container: 'webvtt',
    })),
    tracks: files.map((file) => {
      const track: SubtitleTrack = { id: file.id, name: file.name, isDefault: false, forced: false, pageFile: true };
      if (file.language !== undefined) track.language = file.language;
      if (file.offsetSec !== undefined) track.offsetSec = file.offsetSec;
      return track;
    }),
  };
}

function sameContext(a: RequestContext, b: RequestContext): boolean {
  return a.referer === b.referer && a.origin === b.origin;
}
