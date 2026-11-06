import type { SegmentStorage } from '@/core/download/download-storage';
import { isAbortError } from '@/core/download/retry-policy';
import { DEFAULT_RESERVE_BYTES, freeBytesOf, type EstimateStorage } from '@/core/download/storage-space';
import type { MediaAnalysis } from '@/core/models/media-info';
import { formatBytes } from '@/shared/utils/bytes';
import type { MediaProgress, MediaReport, MediaStage, MediaTaskSpec, SaveRequest } from '@/core/models/download-task';
import { errorMessage } from '@/shared/utils/errors';
import { FfmpegError, type FfmpegRunner } from './ffmpeg-job';
import { analyseTask, MediaFailure } from './media-analysis';
import { mergeTask } from './media-merge';

export interface MediaManagerDeps {
  storage: SegmentStorage;
  ffmpeg: FfmpegRunner;
  report(report: MediaReport): void;
  /**
   * Hands the merged file to the service worker, which has Chrome save it.
   * Resolves to whether it took it (false: the task is no longer processing).
   */
  save(request: SaveRequest): Promise<boolean>;
  /** URL.createObjectURL / revokeObjectURL (injectable for tests). */
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  now?: () => number;
  /** Progress is reported at most this often (stage changes and the outcome always). */
  reportIntervalMs?: number;
  /** How long cancel()/syncSettled() wait for stopped jobs to clean up. */
  settleTimeoutMs?: number;
  /** Per ffprobe command. */
  commandTimeoutMs?: number;
  /** A merge is stopped when FFmpeg makes no progress for this long. */
  stallTimeoutMs?: number;
  /** `navigator.storage.estimate`; without it free disk space is not checked before merging. */
  estimateStorage?: EstimateStorage;
  /** Merging stops short of leaving less than this free. */
  reserveBytes?: number;
}

/**
 * Disk space a merge needs on top of the stored segments: the merged file
 * (about their size; Chrome keeps large Blobs on disk) and the copy Chrome
 * saves in the Downloads folder (the same size, and most often on the same
 * disk).
 */
export function mergeSpaceNeeded(media: MediaAnalysis): number {
  return 2 * media.tracks.reduce((sum, track) => sum + track.bytes, 0);
}

interface Job {
  spec: MediaTaskSpec;
  controller: AbortController;
  progress: MediaProgress;
  lastReport: number;
  finished: Promise<void>;
}

/** FFmpeg's own failures in the user's words. */
export function describeFfmpegFailure(error: FfmpegError): string {
  switch (error.kind) {
    case 'load':
      return `${error.message} Press Retry to try again.`;
    case 'memory':
      return `${error.message} Press Retry to try again after closing other tabs; the downloaded segments are kept.`;
    case 'timeout':
    case 'crashed':
    case 'invalid-job':
      return `${error.message} Press Retry to try again; the downloaded segments are kept.`;
  }
}

/** Overall percentage of a job: analysis 0–10, merge 10–95, check 95, saving 97. */
function percentAt(stage: MediaStage, fraction = 0): number {
  switch (stage) {
    case 'waiting':
    case 'preparing':
    case 'loading':
      return 0;
    case 'analysing':
      return 10 * fraction;
    case 'merging':
      return 10 + 85 * fraction;
    case 'verifying':
      return 95;
    case 'saving':
      return 97;
  }
}

/**
 * Runs media jobs inside the offscreen document, next to the download
 * manager, with the same convergence contract: `sync()` runs exactly the
 * listed jobs, cancelled jobs delete their task's data and say so once.
 *
 * A job analyses the stored data (analyseTask), merges it (mergeTask), and
 * hands the file to the service worker as a blob: URL (`save`). From then on
 * the job only holds that URL alive, because Chrome reads the file from it
 * while saving; the service worker follows the save and drops the task from
 * its work list when it is over, which releases the URL. Stored segments are
 * the service worker's to delete after a save; the engine deletes them only
 * on cancel, or when they turned out to be unusable.
 *
 * FFmpeg commands run through one FfmpegRunner, which serialises them; the
 * service worker hands over one task at a time anyway (FFmpeg's heap is large).
 */
export class MediaManager {
  readonly #deps: MediaManagerDeps;
  readonly #now: () => number;
  readonly #createUrl: (blob: Blob) => string;
  readonly #revokeUrl: (url: string) => void;
  readonly #jobs = new Map<string, Job>();
  /** Merged files Chrome is saving: task → blob: URL. */
  readonly #held = new Map<string, string>();

  constructor(deps: MediaManagerDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#createUrl = deps.createUrl ?? ((blob) => URL.createObjectURL(blob));
    this.#revokeUrl = deps.revokeUrl ?? ((url) => URL.revokeObjectURL(url));
  }

  /** Tasks with a running job or a file being saved. */
  get running(): string[] {
    return [...this.#jobs.keys(), ...this.#held.keys()];
  }

  sync(specs: readonly MediaTaskSpec[]): string[] {
    const wanted = new Set(specs.map((spec) => spec.taskId));
    for (const [taskId, job] of this.#jobs) {
      if (!wanted.has(taskId)) job.controller.abort();
    }
    // Saved (or given up): the URL is no longer needed. The segments are the service worker's business.
    for (const taskId of [...this.#held.keys()]) {
      if (!wanted.has(taskId)) this.#release(taskId);
    }
    for (const spec of specs) {
      if (!this.#jobs.has(spec.taskId) && !this.#held.has(spec.taskId)) this.#start(spec);
    }
    return specs.map((spec) => spec.taskId).filter((id) => this.#jobs.has(id) || this.#held.has(id));
  }

  /** Like sync(), resolving once the jobs it stopped have cleaned up (the document may be closed next). */
  async syncSettled(specs: readonly MediaTaskSpec[]): Promise<string[]> {
    const wanted = new Set(specs.map((spec) => spec.taskId));
    const stopping = [...this.#jobs.keys()].filter((taskId) => !wanted.has(taskId));
    const running = this.sync(specs);
    await this.#settle(stopping);
    return running;
  }

  /** Stops these tasks' jobs (FFmpeg included) and deletes their data, also while Chrome saves the file. */
  async cancel(taskIds: readonly string[]): Promise<void> {
    for (const taskId of taskIds) this.#jobs.get(taskId)?.controller.abort();
    for (const taskId of taskIds) {
      if (!this.#held.has(taskId)) continue;
      this.#release(taskId);
      await this.#deps.storage.deleteTask(taskId).catch(() => undefined);
      this.#deps.report({ taskId, progress: this.#progress('saving'), outcome: { status: 'cancelled' } });
    }
    await this.#settle(taskIds);
  }

  async idle(): Promise<void> {
    while (this.#jobs.size > 0) await Promise.allSettled([...this.#jobs.values()].map((job) => job.finished));
  }

  #release(taskId: string): void {
    const url = this.#held.get(taskId);
    this.#held.delete(taskId);
    if (url !== undefined) this.#revokeUrl(url);
  }

  async #settle(taskIds: readonly string[]): Promise<void> {
    const pending = taskIds.flatMap((taskId) => {
      const job = this.#jobs.get(taskId);
      return job ? [job.finished] : [];
    });
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#deps.settleTimeoutMs ?? 15_000);
    });
    await Promise.race([Promise.allSettled(pending), timeout]);
    clearTimeout(timer);
  }

  #progress(stage: MediaStage, fraction = 0, extra: Partial<MediaProgress> = {}): MediaProgress {
    return { stage, step: 1, steps: 1, percent: Math.floor(percentAt(stage, fraction)), startedAt: this.#now(), ...extra };
  }

  /** Fails before merging when the merged file and its saved copy would not fit. */
  async #checkSpace(media: MediaAnalysis): Promise<void> {
    const estimate = await this.#deps.estimateStorage?.().catch(() => undefined);
    const free = estimate ? freeBytesOf(estimate) : undefined;
    if (free === undefined) return;
    const needed = mergeSpaceNeeded(media) + (this.#deps.reserveBytes ?? DEFAULT_RESERVE_BYTES);
    if (free >= needed) return;
    throw new MediaFailure(
      `Not enough disk space to merge this video: about ${formatBytes(needed)} is needed for the merged file and its saved copy, ${formatBytes(free)} is free. Free up disk space, then press Retry; the downloaded segments are kept.`,
    );
  }

  #start(spec: MediaTaskSpec): void {
    const job: Job = {
      spec,
      controller: new AbortController(),
      progress: this.#progress('preparing'),
      lastReport: 0,
      finished: Promise.resolve(),
    };
    this.#jobs.set(spec.taskId, job);
    job.finished = this.#run(job).finally(() => {
      if (this.#jobs.get(spec.taskId) === job) this.#jobs.delete(spec.taskId);
    });
  }

  /** Records progress; a new stage or step is always reported, finer updates at most every reportIntervalMs. */
  #update(job: Job, stage: MediaStage, fraction: number, extra: { step?: number; steps?: number; detail?: string } = {}): void {
    const previous = job.progress;
    const { detail, ...counts } = extra;
    job.progress = {
      stage,
      step: counts.step ?? 1,
      steps: counts.steps ?? 1,
      percent: Math.floor(percentAt(stage, fraction)),
      startedAt: previous.startedAt,
      ...(detail !== undefined ? { detail } : {}),
    };
    const changed = previous.stage !== stage || previous.step !== job.progress.step;
    const now = this.#now();
    if (!changed && now - job.lastReport < (this.#deps.reportIntervalMs ?? 250)) return;
    job.lastReport = now;
    this.#deps.report({ taskId: job.spec.taskId, progress: job.progress });
  }

  async #run(job: Job): Promise<void> {
    const { spec, controller } = job;
    const { storage, ffmpeg } = this.#deps;
    const signal = controller.signal;
    let url: string | undefined;
    try {
      const { media, layout } = await analyseTask(spec.taskId, {
        storage,
        ffmpeg,
        format: spec.format,
        signal,
        now: this.#now,
        ...(this.#deps.commandTimeoutMs !== undefined ? { timeoutMs: this.#deps.commandTimeoutMs } : {}),
        progress: (update) => {
          const steps = update.steps;
          const fraction = update.stage === 'analysing' ? (update.step - 1) / Math.max(1, steps) : 0;
          this.#update(job, update.stage, fraction, { step: update.step, steps, ...(update.detail !== undefined ? { detail: update.detail } : {}) });
        },
      });
      await this.#checkSpace(media);
      const merged = await mergeTask(spec.taskId, {
        storage,
        ffmpeg,
        signal,
        media,
        layout,
        ...(spec.title !== '' ? { title: spec.title } : {}),
        ...(this.#deps.stallTimeoutMs !== undefined ? { stallTimeoutMs: this.#deps.stallTimeoutMs } : {}),
        progress: (update) => {
          if (update.stage === 'merging') this.#update(job, 'merging', update.fraction);
          else this.#update(job, 'verifying', 1);
        },
      });
      signal.throwIfAborted();
      url = this.#createUrl(merged.data);
      this.#update(job, 'saving', 1);
      const accepted = await this.#deps.save({ taskId: spec.taskId, url, container: merged.container, size: merged.data.size, media });
      signal.throwIfAborted();
      if (!accepted) {
        // Cancelled or removed while merging: the service worker no longer wants it.
        this.#revokeUrl(url);
        this.#deps.report({ taskId: spec.taskId, progress: job.progress, outcome: { status: 'cancelled' } });
        return;
      }
      this.#held.set(spec.taskId, url);
    } catch (error) {
      if (url !== undefined) this.#revokeUrl(url);
      if (signal.aborted || isAbortError(error)) {
        // Cancelled or removed: nobody wants this data any more.
        await storage.deleteTask(spec.taskId).catch(() => undefined);
        this.#deps.report({ taskId: spec.taskId, progress: job.progress, outcome: { status: 'cancelled' } });
        return;
      }
      const discard = error instanceof MediaFailure && error.discardData;
      if (discard) await storage.deleteTask(spec.taskId).catch(() => undefined);
      const message =
        error instanceof MediaFailure
          ? error.message
          : error instanceof FfmpegError
            ? describeFfmpegFailure(error)
            : `Media processing failed: ${errorMessage(error)}`;
      this.#deps.report({ taskId: spec.taskId, progress: job.progress, outcome: { status: 'failed', message, ...(discard ? { discardedData: true } : {}) } });
    }
  }
}
