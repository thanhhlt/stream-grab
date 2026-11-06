import { containerExtension } from '@/core/media/containers';
import type { DetectedStream, RequestContext } from '@/core/models/detected-stream';
import {
  CANCELLABLE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  type DownloadTask,
  type EngineReport,
  type EngineTaskSpec,
  type EngineWork,
  type MediaReport,
  type MediaTaskSpec,
  type SaveRequest,
  type TaskProgress,
  type TaskStatus,
} from '@/core/models/download-task';
import type { Settings } from '@/shared/settings/settings';
import { errorMessage } from '@/shared/utils/errors';
import type { Logger } from '@/shared/utils/logger';
import { dedupeKey } from '@/shared/utils/url';
import type { SegmentStorage } from './download-storage';
import { percentOf } from './progress';
import type { TaskStore } from './task-store';

/** How the service worker reaches the engine in the offscreen document. */
export interface EngineChannel {
  exists(): Promise<boolean>;
  /** Creates the offscreen document if needed. */
  ensure(): Promise<void>;
  close(): Promise<void>;
  /** Run exactly this work; answers once whatever it stops has cleaned up. Returns the running task IDs. */
  sync(work: EngineWork): Promise<string[]>;
  cancel(taskIds: string[]): Promise<void>;
  reacquireContexts(): Promise<void>;
}

export type ReleaseContext = () => Promise<void>;

/** A file Chrome is saving or saved (chrome.downloads.DownloadItem, reduced). */
export interface SaveState {
  state: 'in_progress' | 'interrupted' | 'complete';
  /** Full path; final once complete. */
  path: string;
  bytes: number;
  /** chrome.downloads.InterruptReason when interrupted. */
  error?: string;
}

/** chrome.downloads, as the coordinator uses it. */
export interface FileSaver {
  /** Starts saving `url` as `fileName` in the Downloads folder (renamed if taken); resolves to the download ID. */
  save(options: { url: string; fileName: string }): Promise<number>;
  find(downloadId: number): Promise<SaveState | undefined>;
  cancel(downloadId: number): Promise<void>;
}

/** Desktop notifications at the end of a task. */
export interface Notifier {
  completed(task: DownloadTask): void;
  failed(task: DownloadTask): void;
}

export interface CoordinatorDeps {
  store: TaskStore;
  /** Segment storage: what a task has stored, deleting data of cancelled, removed and orphaned tasks. */
  storage: SegmentStorage;
  engine: EngineChannel;
  /** Header rules for the extension's requests (RequestContextRules). */
  acquireContext(url: string, context: RequestContext): Promise<ReleaseContext>;
  getSettings(): Promise<Settings>;
  getStream(tabId: number, streamId: string): Promise<DetectedStream | undefined>;
  /** The stream with this ID in every open tab (stream IDs derive from the URL, so a video has the same ID in any tab). */
  findStreams?(streamId: string): Promise<DetectedStream[]>;
  /** Saves merged files (chrome.downloads). */
  files?: FileSaver;
  notifier?: Notifier;
  now?: () => number;
  newLeaseId?: () => string;
  logger?: Logger;
}

export const DOWNLOADED_MESSAGE = 'Downloaded. Waiting for FFmpeg to merge the tracks into one file.';

/** Downloaded tasks are processed one at a time: FFmpeg's heap can take up to 2 GB. */
export const MEDIA_SLOTS = 1;

const KEPT = 'The downloaded segments are kept: press Retry to merge and save again.';

/** Why Chrome stopped saving a file (chrome.downloads.InterruptReason), for the Queue tab. */
export function saveFailureMessage(reason: string | undefined): string {
  switch (reason ?? '') {
    case 'FILE_NO_SPACE':
      return `Not enough disk space to save the file. Free up space, then press Retry. ${KEPT}`;
    case 'FILE_TOO_LARGE':
      return `The file is too large for the Downloads drive (FAT32 drives hold at most 4 GB per file). ${KEPT}`;
    case 'FILE_NAME_TOO_LONG':
      return `The file name is too long for the Downloads folder. ${KEPT}`;
    case 'FILE_ACCESS_DENIED':
      return `Chrome may not write to the Downloads folder. ${KEPT}`;
    case 'FILE_BLOCKED':
    case 'FILE_SECURITY_CHECK_FAILED':
    case 'FILE_VIRUS_INFECTED':
      return `Chrome or the system blocked the file (${reason}). ${KEPT}`;
    case 'USER_CANCELED':
      return `Saving was cancelled in Chrome's downloads. ${KEPT}`;
    case 'USER_SHUTDOWN':
    case 'CRASH':
      return `Chrome closed while saving the file. ${KEPT}`;
    default:
      return `Chrome could not save the file${reason ? ` (${reason})` : ''}. ${KEPT}`;
  }
}

/** An expired link of a task whose request context was lost with the browser session. */
export const CONTEXT_LOST_MESSAGE =
  'The browser (or the extension) restarted since this download began, and the video now needs its page again: play the video on its page, then press Retry. The download continues where it stopped.';

/** Tasks whose stored segments are still needed; data of any other task (or of none) is an orphan. */
const KEEPS_DATA: readonly TaskStatus[] = ['queued', 'downloading', 'downloaded', 'processing', 'failed'];

function withoutRunData(task: DownloadTask): DownloadTask {
  const { statusMessage: _message, progress: _progress, processing: _processing, media: _media, dismissed: _dismissed, ...rest } = task;
  const { downloadId: _downloadId, saved: _saved, ...output } = task.output;
  return { ...rest, output };
}

const awaitsProcessing = (task: DownloadTask): boolean => task.status === 'downloaded';

/**
 * Service-worker side of downloading. Owns task state; the engine (offscreen
 * document) only executes.
 *
 * - `pump` starts queued tasks while fewer than Settings → simultaneous
 *   downloads are running, creates the offscreen document when there is work
 *   and closes it when there is none, and tells the engine exactly which tasks
 *   to run (so a restarted worker or engine converges to the stored state).
 * - Engine reports become task progress and outcomes in the task store, which
 *   the popup follows; the popup's lifetime plays no part.
 * - Header rules for the engine's requests are leased per (task, host).
 * - Recovery (Phase 7): tasks interrupted by a browser restart resume from
 *   their stored segments; a task whose request context was lost with the
 *   session takes it from a current detection of the same video; stored data
 *   that no task needs any more is deleted.
 * - Media processing (Phases 8–9): downloaded tasks go to the engine's
 *   FFmpeg, one at a time (`processing`), alongside downloads. The engine
 *   analyses and merges the segments and hands the file over (`startSave`);
 *   Chrome saves it (chrome.downloads), and once it reports the file
 *   complete the task is `completed`, its segments are deleted and a
 *   notification says so. The offscreen document stays open meanwhile: the
 *   file is a blob: URL that lives in it.
 */
export class DownloadCoordinator {
  readonly #deps: CoordinatorDeps;
  readonly #now: () => number;
  readonly #newLeaseId: () => string;
  readonly #leases = new Map<string, ReleaseContext>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(deps: CoordinatorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#newLeaseId = deps.newLeaseId ?? (() => crypto.randomUUID());
  }

  /**
   * Service-worker start. A running engine only lost its header rules (the
   * worker drops them) and re-acquires them. Without an engine, `downloading`
   * tasks were interrupted (browser restart, extension reload, crash): their
   * progress becomes what storage holds until the engine resumes them, and
   * `processing` tasks go back to `downloaded` to be processed again. Then
   * orphaned data is deleted and the queue resumes.
   */
  async onStartup(): Promise<void> {
    // Saves Chrome finished while this worker was not running.
    for (const task of await this.#deps.store.list()) {
      if (task.status === 'processing' && task.output.downloadId !== undefined) await this.#settleSave(task.output.downloadId);
    }
    if (await this.#deps.engine.exists()) await this.#deps.engine.reacquireContexts().catch(() => undefined);
    else await this.#serial(() => this.#markInterrupted());
    await this.cleanup().catch((error: unknown) => {
      this.#deps.logger?.warn('Could not clean up stored segments', { error: errorMessage(error) });
    });
    await this.pump();
  }

  pump(): Promise<void> {
    return this.#serial(async () => {
      const settings = await this.#deps.getSettings();
      const tasks = await this.#deps.store.list();
      const running = tasks.filter((task) => task.status === 'downloading');
      const queued = tasks.filter((task) => task.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
      const toStart = queued.slice(0, Math.max(0, settings.maxActiveTasks - running.length));
      for (const task of toStart) {
        await this.#deps.store.update(task.id, (current) =>
          current.status === 'queued'
            ? {
                ...withoutRunData(current),
                status: 'downloading',
                updatedAt: this.#now(),
                // What earlier runs stored stays visible until the engine confirms it.
                ...(current.progress?.stale ? { progress: current.progress } : {}),
              }
            : current,
        );
      }
      const active = [...running, ...toStart];
      const processing = await this.#startProcessing(tasks);
      if (active.length === 0 && processing.length === 0) {
        if (await this.#deps.engine.exists()) {
          // Answers once stopped tasks have cleaned up, so closing does not cut that short.
          await this.#deps.engine.sync({ downloads: [], media: [] });
          await this.#deps.engine.close();
        }
        // Without an engine nothing can release them any more.
        await this.#releaseAllLeases();
        // Nothing writes now: a good moment to drop data left by a cleanup that timed out.
        await this.#removeOrphans().catch((error: unknown) => {
          this.#deps.logger?.warn('Could not clean up stored segments', { error: errorMessage(error) });
        });
        return;
      }
      await this.#deps.engine.ensure();
      const downloads: EngineTaskSpec[] = [];
      for (const task of active) downloads.push(await this.#spec(task, settings));
      const media = processing.map((task): MediaTaskSpec => ({ taskId: task.id, job: 'process', format: task.output.format, title: task.source.title }));
      await this.#deps.engine.sync({ downloads, media });
    });
  }

  /** Tasks to process: those already processing, plus the oldest downloaded ones waiting while a slot is free. */
  async #startProcessing(tasks: readonly DownloadTask[]): Promise<DownloadTask[]> {
    const processing = tasks.filter((task) => task.status === 'processing');
    const waiting = tasks.filter(awaitsProcessing).sort((a, b) => a.createdAt - b.createdAt);
    for (const task of waiting.slice(0, Math.max(0, MEDIA_SLOTS - processing.length))) {
      const started = await this.#deps.store.update(task.id, (current) => {
        if (!awaitsProcessing(current)) return current;
        const { statusMessage: _message, ...rest } = current;
        const now = this.#now();
        return { ...rest, status: 'processing', updatedAt: now, processing: { stage: 'waiting', step: 1, steps: 1, percent: 0, startedAt: now } };
      });
      if (started?.status === 'processing') processing.push(started);
    }
    return processing;
  }

  async handleReport(report: EngineReport): Promise<void> {
    const outcome = report.outcome;
    // An expired link without a stored context: the context died with the previous browser session.
    const contextLost =
      outcome?.status === 'failed' &&
      outcome.reason === 'expired' &&
      (await this.#deps.store.findContext(report.taskId)) === undefined;
    let failed: DownloadTask | undefined;
    await this.#deps.store.update(report.taskId, (task) => {
      // A report for a task that is no longer running (cancelled meanwhile) only cleans up on the engine side.
      if (task.status !== 'downloading') return task;
      // A run that failed before it read the segment list knows nothing about storage: keep showing what
      // the task had stored (the segments are kept for Retry) rather than "0 of 0".
      const progress = outcome !== undefined && report.progress.segmentsTotal === 0 && task.progress ? task.progress : report.progress;
      const next: DownloadTask = { ...task, progress, updatedAt: this.#now() };
      switch (outcome?.status) {
        case undefined:
          return next;
        case 'downloaded':
          return { ...next, status: 'downloaded', statusMessage: DOWNLOADED_MESSAGE };
        case 'failed':
          failed = { ...next, status: 'failed', statusMessage: contextLost ? CONTEXT_LOST_MESSAGE : outcome.message };
          return failed;
        case 'cancelled': {
          const { statusMessage: _message, ...rest } = next;
          return { ...rest, status: 'cancelled' };
        }
      }
    });
    if (failed) this.#deps.notifier?.failed(failed);
    if (outcome) await this.pump();
  }

  /**
   * Media progress and failures from the engine. A failure keeps the
   * segments unless the engine discarded them as unusable. (Success arrives
   * as startSave.)
   */
  async handleMediaReport(report: MediaReport): Promise<void> {
    const outcome = report.outcome;
    let failed: DownloadTask | undefined;
    await this.#deps.store.update(report.taskId, (task) => {
      // Cancelled, removed, or already saving meanwhile: the engine only cleans up.
      if (task.status !== 'processing') return task;
      if (outcome === undefined && task.processing?.stage === 'saving') return task;
      const { processing: _processing, statusMessage: _message, ...rest } = task;
      const updatedAt = this.#now();
      switch (outcome?.status) {
        case undefined:
          return { ...task, processing: report.progress, updatedAt };
        case 'failed': {
          const { progress: _progress, ...withoutProgress } = rest;
          failed = { ...(outcome.discardedData ? withoutProgress : rest), status: 'failed', statusMessage: outcome.message, updatedAt };
          return failed;
        }
        case 'cancelled':
          return { ...rest, status: 'cancelled', updatedAt };
      }
    });
    if (failed) this.#deps.notifier?.failed(failed);
    if (outcome) await this.pump();
  }

  /**
   * The engine merged a task's file (`engine/save`): Chrome saves it now.
   * Resolves to whether the file was taken; false tells the engine to let go
   * of it (the task was cancelled meanwhile, or Chrome refused the download,
   * which fails the task). Never pumps itself: the engine is waiting for this
   * answer and would not settle a sync in the meantime.
   */
  async startSave(request: SaveRequest): Promise<boolean> {
    const task = (await this.#deps.store.list()).find((candidate) => candidate.id === request.taskId);
    if (task?.status !== 'processing') return false;
    const files = this.#deps.files;
    // An earlier attempt (an engine that restarted while saving) is abandoned.
    if (files && task.output.downloadId !== undefined) await files.cancel(task.output.downloadId).catch(() => undefined);
    const fileName = `${task.output.baseName}${containerExtension(request.container)}`;
    let downloadId: number;
    try {
      if (!files) throw new Error('downloads are not available');
      downloadId = await files.save({ url: request.url, fileName });
    } catch (error) {
      const failed = await this.#deps.store.update(task.id, (current) => {
        if (current.status !== 'processing') return current;
        const { processing: _processing, ...rest } = current;
        return { ...rest, status: 'failed', statusMessage: `Chrome could not save the file: ${errorMessage(error)}. ${KEPT}`, updatedAt: this.#now() };
      });
      if (failed?.status === 'failed') this.#deps.notifier?.failed(failed);
      return false;
    }
    const saving = await this.#deps.store.update(task.id, (current) =>
      current.status === 'processing'
        ? {
            ...current,
            media: request.media,
            output: { ...current.output, downloadId },
            processing: { stage: 'saving', step: 1, steps: 1, percent: 97, startedAt: current.processing?.startedAt ?? this.#now() },
            updatedAt: this.#now(),
          }
        : current,
    );
    if (saving?.status !== 'processing') {
      // Cancelled while Chrome started: stop it again.
      await files.cancel(downloadId).catch(() => undefined);
      return false;
    }
    // A local file is saved in moments: Chrome may already be done.
    await this.#settleSave(downloadId);
    return true;
  }

  /** chrome.downloads.onChanged: a save may have finished. */
  async handleFileChange(downloadId: number): Promise<void> {
    await this.#settleSave(downloadId);
  }

  /** Hides completed tasks from the Queue tab (they stay under Completed). */
  async dismiss(taskIds: readonly string[]): Promise<number> {
    let dismissed = 0;
    for (const id of taskIds) {
      const task = await this.#deps.store.update(id, (current) =>
        current.status === 'completed' && !current.dismissed ? { ...current, dismissed: true } : current,
      );
      if (task?.dismissed) dismissed += 1;
    }
    return dismissed;
  }

  /**
   * Finishes a task whose file Chrome completed or gave up on. Idempotent:
   * only the call that moves the task out of `processing` acts.
   */
  async #settleSave(downloadId: number): Promise<void> {
    const state = await this.#deps.files?.find(downloadId).catch(() => undefined);
    if (!state || state.state === 'in_progress') return;
    const task = (await this.#deps.store.list()).find((candidate) => candidate.status === 'processing' && candidate.output.downloadId === downloadId);
    if (!task) return;
    let settled: DownloadTask | undefined;
    await this.#deps.store.update(task.id, (current) => {
      if (current.status !== 'processing' || current.output.downloadId !== downloadId) return current;
      const { processing: _processing, statusMessage: _message, ...rest } = current;
      const now = this.#now();
      settled =
        state.state === 'complete'
          ? { ...rest, status: 'completed', updatedAt: now, output: { ...current.output, saved: { path: state.path, bytes: state.bytes, savedAt: now } } }
          : { ...rest, status: 'failed', statusMessage: saveFailureMessage(state.error), updatedAt: now };
      return settled;
    });
    if (!settled) return;
    if (settled.status === 'completed') {
      // The file is saved: the temporary segments go.
      await this.#deleteData(settled.id);
      this.#deps.notifier?.completed(settled);
    } else {
      this.#deps.notifier?.failed(settled);
    }
    // Not awaited: startSave may be on the stack, with the engine waiting for its answer.
    void this.pump();
  }

  async cancel(taskIds: readonly string[]): Promise<number> {
    const tasks = await this.#deps.store.list();
    const targets = tasks.filter((task) => taskIds.includes(task.id) && CANCELLABLE_TASK_STATUSES.includes(task.status));
    for (const task of targets) {
      // Cancelling deletes the data, so no progress is left to show.
      await this.#deps.store.update(task.id, (current) => ({ ...withoutRunData(current), status: 'cancelled', updatedAt: this.#now() }));
    }
    const inEngine = (task: DownloadTask): boolean => task.status === 'downloading' || task.status === 'processing';
    // A file Chrome is saving: stop that too (it removes the partial file).
    for (const task of targets) {
      if (task.status === 'processing' && task.output.downloadId !== undefined) {
        await this.#deps.files?.cancel(task.output.downloadId).catch(() => undefined);
      }
    }
    const running = targets.filter(inEngine).map((task) => task.id);
    if (running.length > 0 && (await this.#deps.engine.exists())) await this.#deps.engine.cancel(running);
    // The engine deletes a running task's data itself; the others' data is deleted here.
    for (const task of targets.filter((candidate) => !inEngine(candidate))) await this.#deleteData(task.id);
    if (targets.length > 0) await this.pump();
    return targets.length;
  }

  /** Re-queues failed and cancelled tasks; a failed one continues from the segments it stored. */
  async retry(taskIds: readonly string[]): Promise<number> {
    const tasks = await this.#deps.store.list();
    const targets = tasks.filter((task) => taskIds.includes(task.id) && RETRYABLE_TASK_STATUSES.includes(task.status));
    for (const task of targets) {
      const stored = await this.#storedProgress(task.id);
      await this.#deps.store.update(task.id, (current) => ({
        ...withoutRunData(current),
        status: 'queued',
        updatedAt: this.#now(),
        ...(stored ? { progress: stored } : {}),
      }));
    }
    if (targets.length > 0) await this.pump();
    return targets.length;
  }

  /** Tasks were removed from the store: drop their stored segments. */
  async afterRemove(taskIds: readonly string[]): Promise<void> {
    for (const id of taskIds) await this.#deleteData(id);
  }

  /**
   * Deletes stored data no task needs: tasks that were removed, cancelled or
   * completed, whose own cleanup did not finish (it timed out, or the browser
   * closed first). Returns the task IDs whose data was deleted.
   */
  cleanup(): Promise<string[]> {
    return this.#serial(() => this.#removeOrphans());
  }

  async acquireContext(taskId: string, url: string): Promise<string | null> {
    const context = await this.#deps.store.getContext(taskId);
    if (context.referer === undefined && context.origin === undefined) return null;
    // May wait while another context holds this host's rule.
    const release = await this.#deps.acquireContext(url, context);
    const task = (await this.#deps.store.list()).find((candidate) => candidate.id === taskId);
    if (task?.status !== 'downloading') {
      // Cancelled or removed while waiting: nobody would release this rule.
      await release();
      return null;
    }
    const leaseId = this.#newLeaseId();
    this.#leases.set(leaseId, release);
    return leaseId;
  }

  async releaseContext(leaseId: string): Promise<void> {
    const release = this.#leases.get(leaseId);
    this.#leases.delete(leaseId);
    await release?.();
  }

  async #releaseAllLeases(): Promise<void> {
    const releases = [...this.#leases.values()];
    this.#leases.clear();
    await Promise.all(releases.map((release) => release().catch(() => undefined)));
  }

  /**
   * The freshest source for a task whose links expired: the stream the page
   * currently lists under the same manifest (it may carry a re-signed URL and
   * a new Referer), in the task's own tab or, failing that, in any open tab
   * (after a browser restart the task's tab is gone). Null when the video is
   * not listed anywhere.
   */
  async freshSource(taskId: string): Promise<{ manifestUrl: string; context: RequestContext } | null> {
    const task = (await this.#deps.store.list()).find((candidate) => candidate.id === taskId);
    if (!task) return null;
    const stream = await this.#currentStream(task);
    return stream ? this.#adopt(task.id, stream) : null;
  }

  async #spec(task: DownloadTask, settings: Settings): Promise<EngineTaskSpec> {
    let manifestUrl = task.source.manifestUrl;
    let context = await this.#deps.store.findContext(task.id);
    if (context === undefined) {
      // Lost with the previous browser session. A detection of the same video carries a fresh one;
      // without it the engine tries the stored link as it is (many servers do not check the Referer).
      const stream = await this.#currentStream(task);
      if (stream) ({ manifestUrl, context } = await this.#adopt(task.id, stream));
    }
    const variant: EngineTaskSpec['variant'] = { id: task.selection.variantId };
    if (task.selection.height !== undefined) variant.height = task.selection.height;
    if (task.selection.bandwidth !== undefined) variant.bandwidth = task.selection.bandwidth;
    return {
      taskId: task.id,
      protocol: task.source.protocol,
      manifestUrl,
      context: context ?? {},
      variant,
      audioTrackIds: task.selection.audioTrackIds,
      concurrency: settings.segmentConcurrency,
    };
  }

  /** The detected stream of the task's video: in its own tab first, else the most recently seen in any tab. */
  async #currentStream(task: DownloadTask): Promise<DetectedStream | undefined> {
    const video = dedupeKey(task.source.manifestUrl);
    const own = await this.#deps.getStream(task.source.tabId, task.source.streamId).catch(() => undefined);
    if (own && dedupeKey(own.url) === video) return own;
    const elsewhere = (await this.#deps.findStreams?.(task.source.streamId).catch(() => [])) ?? [];
    return elsewhere.filter((stream) => dedupeKey(stream.url) === video).sort((a, b) => b.lastSeen - a.lastSeen)[0];
  }

  /** Makes the stream the task's source: its URL, tab and request context. */
  async #adopt(taskId: string, stream: DetectedStream): Promise<{ manifestUrl: string; context: RequestContext }> {
    await this.#deps.store.setContext(taskId, stream.requestContext);
    await this.#deps.store.update(taskId, (current) => ({
      ...current,
      source: { ...current.source, manifestUrl: stream.url, tabId: stream.tabId, streamId: stream.id },
    }));
    return { manifestUrl: stream.url, context: stream.requestContext };
  }

  /** Interrupted runs: show what storage holds (the engine confirms it when it resumes them); processing starts over. */
  async #markInterrupted(): Promise<void> {
    const tasks = await this.#deps.store.list();
    for (const task of tasks.filter((candidate) => candidate.status === 'processing')) {
      await this.#deps.store.update(task.id, (current) => {
        if (current.status !== 'processing') return current;
        const { processing: _processing, ...rest } = current;
        return { ...rest, status: 'downloaded', statusMessage: DOWNLOADED_MESSAGE, updatedAt: this.#now() };
      });
    }
    const interrupted = tasks.filter((task) => task.status === 'downloading');
    for (const task of interrupted) {
      const stored = await this.#storedProgress(task.id);
      await this.#deps.store.update(task.id, (current) => {
        if (current.status !== 'downloading') return current;
        const { progress: _progress, ...rest } = current;
        return { ...rest, updatedAt: this.#now(), ...(stored ? { progress: stored } : {}) };
      });
    }
  }

  /** What storage holds for a task, as progress marked stale; undefined when nothing is stored. */
  async #storedProgress(taskId: string): Promise<TaskProgress | undefined> {
    const stored = await this.#deps.storage.summary(taskId).catch(() => undefined);
    if (!stored || stored.segmentsDone === 0) return undefined;
    return {
      segmentsTotal: stored.segmentsTotal,
      segmentsDone: stored.segmentsDone,
      bytes: stored.bytes,
      bytesPerSecond: 0,
      percent: percentOf(stored.segmentsDone, stored.segmentsTotal),
      retries: 0,
      startedAt: this.#now(),
      stale: true,
    };
  }

  async #removeOrphans(): Promise<string[]> {
    // Storage first, tasks second: data is only written for tasks already in the store, so a task
    // created in between is never taken for an orphan. Callers are serialised with pump(), so no
    // task starts (and writes) between the two reads and the deletes.
    const stored = await this.#deps.storage.taskIds();
    if (stored.length === 0) return [];
    const tasks = await this.#deps.store.list();
    const needed = new Set(tasks.filter((task) => KEEPS_DATA.includes(task.status)).map((task) => task.id));
    const orphans = stored.filter((id) => !needed.has(id));
    for (const id of orphans) await this.#deleteData(id);
    if (orphans.length > 0) this.#deps.logger?.info('Deleted stored segments no task needs', { tasks: orphans.length });
    return orphans;
  }

  async #deleteData(taskId: string): Promise<void> {
    await this.#deps.storage.deleteTask(taskId).catch((error: unknown) => {
      this.#deps.logger?.warn('Could not delete stored segments', { taskId, error: errorMessage(error) });
    });
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.catch((error: unknown) => {
      this.#deps.logger?.error('Download coordination failed', { error: errorMessage(error) });
    });
    return result;
  }
}
