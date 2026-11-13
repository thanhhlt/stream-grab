import { BLOCKED_SITE_MESSAGE, involvesBlockedSite } from '@/core/detection/blocked-sites';
import { containerExtension } from '@/core/media/containers';
import { taskIdOfMergeFile, type OutputFileStore } from '@/core/media/output-files';
import { taskIdOfPartialFile } from './partial-files';
import { isEmptyRequestContext, type DetectedStream, type RequestContext } from '@/core/models/detected-stream';
import {
  CANCELLABLE_TASK_STATUSES,
  RETRYABLE_TASK_STATUSES,
  type DownloadTask,
  type EngineReport,
  type EngineTaskSpec,
  type EngineWork,
  type MediaReport,
  type MediaTaskSpec,
  type PageSubtitleFile,
  type ProgressiveTaskInfo,
  type SaveRequest,
  type SubtitleOutput,
  type TaskProgress,
  type TaskStatus,
} from '@/core/models/download-task';
import type { Settings, SubtitleFormat } from '@/shared/settings/settings';
import { errorMessage } from '@/shared/utils/errors';
import type { Logger } from '@/shared/utils/logger';
import { dedupeKey } from '@/shared/utils/url';
import type { SegmentStorage } from './download-storage';
import { inDownloadFolder } from './file-name';
import {
  awaitsSave,
  convertTrackFile,
  isSaving,
  MAX_TRACK_FILE_BYTES,
  savedBaseName,
  subtitleDataUrl,
  subtitleFileName,
  subtitleSaveFailure,
} from './subtitle-saves';
import { fileProgress, percentOf, ProgressTracker } from './progress';
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
  /** Progressive files (0.3.0): bytes received so far, and the size when the server announced it. */
  received?: number;
  total?: number;
  /** Chrome can continue the interrupted download where it stopped. */
  canResume?: boolean;
  /** MIME type of the response. */
  mime?: string;
}

/** chrome.downloads, as the coordinator uses it. */
export interface FileSaver {
  /** Starts saving `url` as `fileName` in the Downloads folder (renamed if taken); resolves to the download ID. */
  save(options: { url: string; fileName: string }): Promise<number>;
  find(downloadId: number): Promise<SaveState | undefined>;
  /** Stops a download; Chrome deletes its partial file. */
  cancel(downloadId: number): Promise<void>;
  /** Continues an interrupted download Chrome can resume (progressive files). */
  resume?(downloadId: number): Promise<void>;
  /** Deletes a completed download's file (a web page saved instead of a video). */
  removeFile?(downloadId: number): Promise<void>;
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
  /** Merged files on disk (OPFS): those no running merge needs are deleted with orphaned segments. */
  mergeFiles?: Pick<OutputFileStore, 'names' | 'remove'>;
  /**
   * Progressive files the engine fetches, kept on disk for the next run (0.6.0): deleted with the
   * task's other data, and when no task needs them any more.
   */
  partialFiles?: Pick<OutputFileStore, 'names' | 'remove'>;
  notifier?: Notifier;
  now?: () => number;
  newLeaseId?: () => string;
  /** Timer of the progress poll of progressive downloads (setTimeout; injectable for tests). */
  schedule?: (callback: () => void, delayMs: number) => void;
  /** Fetches a progressive file's `<track>` subtitle files (0.7.0); `fetch` by default. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  logger?: Logger;
}

/** A subtitle file a merged video was handed over without (the engine did not make it). */
export const SUBTITLE_MISSING_MESSAGE = 'The subtitle track was not among the downloaded data.';
/** Subtitle files of a merged video that were waiting when the engine (and its blob: URLs) went away. */
export const SUBTITLE_LOST_MESSAGE = 'The subtitle file was lost when the browser or the extension restarted. Download the video again to get it.';

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

/**
 * A save that failed because of the "Save in a subfolder of Downloads"
 * setting (checked in Chrome 157 on Windows): the folder cannot be created
 * (a file has its name) → FILE_FAILED; the full path is too long → cancelled
 * before Chrome chose the file's path. Undefined for any other failure.
 */
export function folderFailureMessage(state: Pick<SaveState, 'error' | 'path'>, folder: string, then: string): string | undefined {
  if (folder === '') return undefined;
  if (state.error === 'FILE_FAILED') {
    return `Chrome could not save the file in the folder "${folder}" of Downloads (a file with that name may be in the way). Change the folder in Settings. ${then}`;
  }
  if (state.error === 'USER_CANCELED' && state.path === '') {
    return `The file's full path in the folder "${folder}" of Downloads is too long. Choose a shorter folder in Settings. ${then}`;
  }
  return undefined;
}

/** An expired link of a task whose request context was lost with the browser session. */
export const CONTEXT_LOST_MESSAGE =
  'The browser (or the extension) restarted since this download began, and the video now needs its page again: play the video on its page, then press Retry. The download continues where it stopped.';

/** Tasks whose stored segments are still needed; data of any other task (or of none) is an orphan. */
const KEEPS_DATA: readonly TaskStatus[] = ['queued', 'downloading', 'downloaded', 'processing', 'failed'];

/** How often the progress of progressive files Chrome downloads is read (chrome.downloads reports no progress events). */
export const FILE_POLL_MS = 1000;

/** Chrome's interrupt reasons for a server that refused the request: 401, 403, 404 (checked in Chrome 157). */
const REFUSALS = new Set(['SERVER_UNAUTHORIZED', 'SERVER_FORBIDDEN', 'SERVER_BAD_CONTENT']);
/** Interruptions Chrome may continue after a restart (the browser closed, the connection dropped). */
const RESUMABLE_ON_STARTUP = new Set(['USER_SHUTDOWN', 'CRASH', 'NETWORK_FAILED', 'NETWORK_TIMEOUT', 'NETWORK_DISCONNECTED', 'NETWORK_SERVER_DOWN']);

export const FILE_REMOVED_MESSAGE = "The download was removed from Chrome's downloads. Press Retry to download the video again.";

/** Why Chrome's download of a progressive file stopped (chrome.downloads.InterruptReason), for the Queue tab. */
export function fileFailureMessage(reason: string | undefined, canResume: boolean): string {
  const again = canResume ? 'Press Retry: Chrome continues where it stopped.' : 'Press Retry to download it again.';
  switch (reason ?? '') {
    case 'NETWORK_FAILED':
    case 'NETWORK_TIMEOUT':
    case 'NETWORK_DISCONNECTED':
    case 'NETWORK_SERVER_DOWN':
      return `The connection to the server was lost (${reason}). ${again}`;
    case 'SERVER_FAILED':
      return `The server could not send the file (${reason}). ${again}`;
    case 'SERVER_NO_RANGE':
    case 'SERVER_CONTENT_LENGTH_MISMATCH':
      return `The server could not continue the download (${reason}). Press Retry to download it again.`;
    case 'FILE_NO_SPACE':
      return `Not enough disk space to save the file. Free up space, then press Retry.`;
    case 'FILE_TOO_LARGE':
      return 'The file is too large for the Downloads drive (FAT32 drives hold at most 4 GB per file).';
    case 'FILE_NAME_TOO_LONG':
      return 'The file name is too long for the Downloads folder.';
    case 'FILE_ACCESS_DENIED':
      return 'Chrome may not write to the Downloads folder.';
    case 'FILE_BLOCKED':
    case 'FILE_SECURITY_CHECK_FAILED':
    case 'FILE_VIRUS_INFECTED':
      return `Chrome or the system blocked the file (${reason}).`;
    case 'USER_CANCELED':
      // Also what Chrome does to running downloads when it is quit normally (checked in Chrome 157).
      return `The download was cancelled in Chrome: in its downloads list, or because Chrome was closed during the download. ${again}`;
    case 'USER_SHUTDOWN':
    case 'CRASH':
      return `Chrome closed during the download. ${again}`;
    default:
      return `Chrome could not download the file${reason ? ` (${reason})` : ''}. ${again}`;
  }
}

/** A refusal the browser's download got; the label says what the server did. */
function refusalLabel(state: SaveState): string {
  switch (state.error ?? '') {
    case 'SERVER_UNAUTHORIZED':
      return 'HTTP 401';
    case 'SERVER_FORBIDDEN':
      return 'HTTP 403';
    case 'SERVER_BAD_CONTENT':
      return 'HTTP 404';
    default:
      return 'it sent a web page instead of the video';
  }
}

/** Progressive files Chrome downloads itself (0.3.0): a download slot, no engine. */
const fetchedByBrowser = (task: DownloadTask): boolean => task.progressive?.fetch === 'browser';

/** The response is a page or a JSON error, not the video. */
const isDocument = (state: SaveState): boolean => /^(text\/|application\/(json|xml|xhtml))/i.test(state.mime ?? '');

function withoutRunData(task: DownloadTask): DownloadTask {
  const {
    statusMessage: _message,
    failureReason: _reason,
    progress: _progress,
    processing: _processing,
    media: _media,
    dismissed: _dismissed,
    ...rest
  } = task;
  const { downloadId: _downloadId, saved: _saved, subtitles: _subtitles, ...output } = task.output;
  return { ...rest, output };
}

/** Done subtitle entries need no blob: URL any more; unfinished ones end with `error` (an embedded-only one is done). */
function settledSubtitles(files: readonly SubtitleOutput[], error: string): SubtitleOutput[] {
  return files.map((entry) => {
    const { url: _url, ...file } = entry;
    return file.saved || file.error !== undefined || !(awaitsSave(entry) || isSaving(entry)) ? file : { ...file, error };
  });
}

const awaitsProcessing = (task: DownloadTask): boolean => task.status === 'downloaded';

/**
 * What an engine-fetched progressive file had received, marked stale: its next run continues the
 * file on disk (0.6.0) and confirms the bytes (or starts over when the file cannot be continued).
 */
function fileOnDisk(task: DownloadTask): TaskProgress | undefined {
  if (task.progressive?.fetch !== 'extension' || !task.progress || task.progress.bytes === 0) return undefined;
  return { ...task.progress, bytesPerSecond: 0, stale: true };
}

function withoutResume(info: ProgressiveTaskInfo): ProgressiveTaskInfo {
  const { resumeId: _resumeId, ...rest } = info;
  return rest;
}

function emptyProgress(now: number): TaskProgress {
  return { segmentsTotal: 1, segmentsDone: 0, bytes: 0, bytesPerSecond: 0, percent: 0, retries: 0, startedAt: now };
}

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
  readonly #schedule: (callback: () => void, delayMs: number) => void;
  /** Speed of each progressive file Chrome downloads, from the bytes it reports (memory only; rebuilt after a restart). */
  readonly #fileSpeeds = new Map<string, { tracker: ProgressTracker; received: number }>();
  #pollScheduled = false;
  #chain: Promise<unknown> = Promise.resolve();
  /** Subtitle saves of one task run one after another, so a file is never handed to Chrome twice. */
  readonly #subtitleChains = new Map<string, Promise<unknown>>();

  constructor(deps: CoordinatorDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#newLeaseId = deps.newLeaseId ?? (() => crypto.randomUUID());
    this.#schedule =
      deps.schedule ??
      ((callback, delayMs) => {
        setTimeout(callback, delayMs);
      });
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
      const downloadId = task.output.downloadId;
      if (downloadId === undefined) continue;
      if (task.status === 'processing') await this.#settleSave(downloadId);
      // Progressive files Chrome downloads: finished, interrupted (the browser closed) or still running.
      else if (task.status === 'downloading' && task.progressive) await this.#recoverFile(task, downloadId);
      // A progressive file's subtitle files that were not saved yet, or whose saves ended meanwhile.
      else if (task.status === 'completed' && task.output.subtitles?.some((file) => awaitsSave(file) || isSaving(file))) {
        // Not awaited: fetching `<track>` files from the site must not hold up the queue.
        void this.#continueSubtitles(task.id);
      }
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
      // Tasks of a blocked site (0.8.0) made by an earlier version never start.
      for (const task of tasks.filter((task) => task.status === 'queued' && involvesBlockedSite(task.source.manifestUrl, task.source.pageUrl))) {
        await this.#deps.store.update(task.id, (current) =>
          current.status === 'queued' ? { ...withoutRunData(current), status: 'failed', statusMessage: BLOCKED_SITE_MESSAGE, updatedAt: this.#now() } : current,
        );
      }
      const queued = tasks
        .filter((task) => task.status === 'queued' && !involvesBlockedSite(task.source.manifestUrl, task.source.pageUrl))
        .sort((a, b) => a.createdAt - b.createdAt);
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
      // Progressive files Chrome downloads itself take a download slot, not the engine (0.3.0).
      const browserFiles = active.filter(fetchedByBrowser);
      let failedToStart = false;
      for (const task of browserFiles) failedToStart = !(await this.#startBrowserFile(task)) || failedToStart;
      if (browserFiles.length > 0) this.#watchFiles();
      // A slot freed by a file Chrome refused to start: the next queued task may take it (after this pump).
      if (failedToStart) void this.pump();
      const engineTasks = active.filter((task) => !fetchedByBrowser(task));
      const processing = await this.#startProcessing(tasks);
      if (engineTasks.length === 0 && processing.length === 0) {
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
      for (const task of engineTasks) downloads.push(await this.#spec(task, settings));
      const media = processing.map((task): MediaTaskSpec => {
        const spec: MediaTaskSpec = { taskId: task.id, job: 'process', format: task.output.format, title: task.source.title };
        const protocol = task.source.protocol;
        if ((task.selection.subtitles?.length ?? 0) > 0 && (protocol === 'hls' || protocol === 'dash')) {
          spec.subtitles = { protocol, format: task.output.subtitleFormat ?? 'srt', mode: task.output.subtitleMode ?? 'file' };
        }
        return spec;
      });
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
          failed = {
            ...(outcome.discardedData ? withoutProgress : rest),
            status: 'failed',
            statusMessage: outcome.message,
            ...(outcome.reason ? { failureReason: outcome.reason } : {}),
            updatedAt,
          };
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
    // A merged video, or a progressive file the engine fetched (0.3.0): it keeps its own container and stays `downloading`.
    const file = task?.status === 'downloading' && task.progressive?.fetch === 'extension' ? task.progressive : undefined;
    const { container, media } = request;
    if (!task || (!file && (task.status !== 'processing' || !container || !media))) return false;
    const wanted: TaskStatus = file ? 'downloading' : 'processing';
    const files = this.#deps.files;
    // An earlier attempt (an engine that restarted while saving) is abandoned.
    if (files && task.output.downloadId !== undefined) await files.cancel(task.output.downloadId).catch(() => undefined);
    const fileName = `${task.output.baseName}${file ? `.${file.container}` : containerExtension(container ?? 'mp4')}`;
    let downloadId: number;
    try {
      if (!files) throw new Error('downloads are not available');
      downloadId = await files.save({ url: request.url, fileName: await this.#inFolder(fileName) });
    } catch (error) {
      const failed = await this.#deps.store.update(task.id, (current) => {
        if (current.status !== wanted) return current;
        const { processing: _processing, ...rest } = current;
        const kept = file ? 'Press Retry to download it again.' : KEPT;
        return { ...rest, status: 'failed', statusMessage: `Chrome could not save the file: ${errorMessage(error)}. ${kept}`, updatedAt: this.#now() };
      });
      if (failed?.status === 'failed') this.#deps.notifier?.failed(failed);
      return false;
    }
    // Subtitle files wait for the video (subtitle-saves.ts); one per chosen track.
    const chosen = file ? [] : (task.selection.subtitles ?? []);
    const subtitles = chosen.map((subtitle): SubtitleOutput => {
      const made = request.subtitles?.find((candidate) => candidate.trackId === subtitle.id);
      const embedded = made?.embedded === true ? { embedded: true as const } : {};
      if (made?.url !== undefined) return { trackId: subtitle.id, ...embedded, url: made.url };
      if (made?.embedded === true) return { trackId: subtitle.id, embedded: true };
      return { trackId: subtitle.id, error: made?.error ?? SUBTITLE_MISSING_MESSAGE };
    });
    const saving = await this.#deps.store.update(task.id, (current) => {
      if (current.status !== wanted) return current;
      if (file) return { ...current, output: { ...current.output, downloadId }, updatedAt: this.#now() };
      const { subtitles: _previous, ...output } = current.output;
      return {
        ...current,
        ...(media ? { media } : {}),
        output: { ...output, downloadId, ...(subtitles.length > 0 ? { subtitles } : {}) },
        processing: { stage: 'saving', step: 1, steps: 1, percent: 97, startedAt: current.processing?.startedAt ?? this.#now() },
        updatedAt: this.#now(),
      };
    });
    if (saving?.status !== wanted) {
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

  /** A file name in the Downloads subfolder the settings name, read when Chrome starts saving the file. */
  async #inFolder(fileName: string): Promise<string> {
    return inDownloadFolder((await this.#deps.getSettings()).downloadFolder, fileName);
  }

  /** The message of a save the subfolder setting made fail, if it did (the setting rarely changes during one save). */
  async #folderFailure(state: SaveState, then: string): Promise<string | undefined> {
    const folder = await this.#deps.getSettings().then(
      (settings) => settings.downloadFolder,
      () => '',
    );
    return folderFailureMessage(state, folder, then);
  }

  /**
   * Finishes a task whose file Chrome completed or gave up on. Idempotent:
   * only the call that moves the task out of `processing` acts.
   */
  async #settleSave(downloadId: number): Promise<void> {
    const state = await this.#deps.files?.find(downloadId).catch(() => undefined);
    const tasks = await this.#deps.store.list();
    const task = tasks.find(
      (candidate) =>
        candidate.output.downloadId === downloadId &&
        (candidate.status === 'processing' || (candidate.status === 'downloading' && candidate.progressive !== undefined)),
    );
    if (!task) {
      // A subtitle file (0.7.0): a merged video completes once its subtitle files are saved.
      const owner = tasks.find((candidate) => candidate.output.subtitles?.some((file) => file.downloadId === downloadId));
      const videoId = owner?.output.downloadId;
      if (owner?.status === 'processing' && videoId !== undefined) {
        if (await this.#deps.files?.find(videoId).catch(() => undefined)) await this.#settleSave(videoId);
        // The video was removed from Chrome's downloads while its subtitles were saved: nothing else would end the task.
        else await this.#finishMerged(owner.id, videoId, { state: 'interrupted', path: '', bytes: 0, error: 'FILE_REMOVED' }, subtitleSaveFailure(undefined));
      } else if (owner?.status === 'completed') {
        await this.#continueSubtitles(owner.id);
      }
      return;
    }
    if (!state || state.state === 'in_progress') return;
    if (task.progressive) {
      await this.#settleFile(task, downloadId, state);
      return;
    }
    if (state.state === 'complete' && task.output.subtitles?.some((file) => awaitsSave(file) || isSaving(file))) {
      if (!(await this.#deps.engine.exists())) {
        // The engine's blob: URLs went with it: the video stays saved, subtitle files not saved yet are lost.
        await this.#checkSubtitles(task.id);
        await this.#cancelSubtitleSaves(await this.#task(task.id));
        await this.#finishMerged(task.id, downloadId, state, SUBTITLE_LOST_MESSAGE);
        return;
      }
      // The video is saved: its subtitle files follow, named after it; the task completes once they are done.
      await this.#saveSubtitles(task.id, state.path);
      if (await this.#checkSubtitles(task.id)) return;
    }
    await this.#finishMerged(task.id, downloadId, state);
  }

  async #task(taskId: string): Promise<DownloadTask | undefined> {
    return (await this.#deps.store.list()).find((task) => task.id === taskId);
  }

  /**
   * Hands a task's waiting subtitle files to Chrome, named after the saved
   * video (`videoPath`, Chrome's final path). Merged videos' files are the
   * engine's blob: URLs; a progressive file's `<track>` files are fetched now.
   * One at a time per task (a file is never started twice).
   */
  #saveSubtitles(taskId: string, videoPath: string): Promise<void> {
    const run = () => this.#startSubtitleSaves(taskId, videoPath);
    const next = (this.#subtitleChains.get(taskId) ?? Promise.resolve())
      .then(run, run)
      .catch((error: unknown) => {
        this.#deps.logger?.warn('Could not save subtitle files', { taskId, error: errorMessage(error) });
      });
    this.#subtitleChains.set(taskId, next);
    void next.finally(() => {
      if (this.#subtitleChains.get(taskId) === next) this.#subtitleChains.delete(taskId);
    });
    return next;
  }

  async #startSubtitleSaves(taskId: string, videoPath: string): Promise<void> {
    const files = this.#deps.files;
    const task = await this.#task(taskId);
    if (!task || !files || (task.status !== 'processing' && task.status !== 'completed')) return;
    const chosen = task.selection.subtitles ?? [];
    const format = task.output.subtitleFormat ?? 'srt';
    const videoBase = savedBaseName(videoPath) || task.output.baseName;
    for (const entry of task.output.subtitles ?? []) {
      if (!awaitsSave(entry)) continue;
      const subtitle = chosen.find((candidate) => candidate.id === entry.trackId);
      let result: Pick<SubtitleOutput, 'downloadId' | 'error'>;
      try {
        if (!subtitle) throw new Error('the track is no longer part of the task');
        const url = entry.url ?? (task.progressive ? await this.#trackFileUrl(task.id, subtitle.url, format, subtitle.offsetSec) : undefined);
        if (url === undefined) throw new Error('the file is gone');
        const fileName = await this.#inFolder(subtitleFileName(videoBase, subtitle, chosen, format));
        result = { downloadId: await files.save({ url, fileName }) };
      } catch (error) {
        result = { error: `The subtitle file could not be saved: ${errorMessage(error)}.` };
      }
      let recorded = false as boolean;
      await this.#deps.store.update(taskId, (current) => {
        const list = current.output.subtitles;
        const at = list?.findIndex((file) => file.trackId === entry.trackId) ?? -1;
        const waiting = list?.[at];
        if (current.status !== task.status || !list || !waiting || !awaitsSave(waiting)) return current;
        recorded = true;
        const subtitles = list.map((file, index) => (index === at ? { ...file, ...result } : file));
        return { ...current, output: { ...current.output, subtitles }, updatedAt: this.#now() };
      });
      // Cancelled or removed meanwhile: nobody follows this save.
      if (!recorded && result.downloadId !== undefined) await files.cancel(result.downloadId).catch(() => undefined);
    }
  }

  /** A progressive file's `<track>` file, fetched with the page's Referer/Origin and converted, as a data: URL. */
  async #trackFileUrl(taskId: string, url: string | undefined, format: SubtitleFormat, offsetSec?: number): Promise<string> {
    if (url === undefined) throw new Error('the page gave no address for it');
    const context = await this.#deps.store.findContext(taskId);
    const release = context !== undefined && !isEmptyRequestContext(context) ? await this.#deps.acquireContext(url, context) : undefined;
    let text: string;
    try {
      const fetchFile = this.#deps.fetch ?? ((input: string, init: RequestInit) => fetch(input, init));
      const response = await fetchFile(url, { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (Number(response.headers.get('content-length') ?? 0) > MAX_TRACK_FILE_BYTES) throw new Error('the file is too large');
      text = await response.text();
      if (text.length > MAX_TRACK_FILE_BYTES) throw new Error('the file is too large');
    } finally {
      await release?.().catch(() => undefined);
    }
    return subtitleDataUrl(convertTrackFile(text, format, offsetSec), format);
  }

  /**
   * Records how Chrome's saves of a task's subtitle files ended. True while
   * one is still running.
   */
  async #checkSubtitles(taskId: string): Promise<boolean> {
    const task = await this.#task(taskId);
    const saving = task?.output.subtitles?.filter(isSaving) ?? [];
    if (saving.length === 0) return false;
    const outcomes = new Map<number, Pick<SubtitleOutput, 'saved' | 'error'>>();
    let running = false;
    for (const { downloadId } of saving) {
      if (downloadId === undefined) continue;
      const state = await this.#deps.files?.find(downloadId).catch(() => undefined);
      if (!state) outcomes.set(downloadId, { error: "The subtitle file was removed from Chrome's downloads." });
      else if (state.state === 'in_progress') running = true;
      else if (state.state === 'complete') outcomes.set(downloadId, { saved: { path: state.path, bytes: state.bytes, savedAt: this.#now() } });
      else outcomes.set(downloadId, { error: subtitleSaveFailure(state.error) });
    }
    if (outcomes.size > 0) {
      await this.#deps.store.update(taskId, (current) => {
        const list = current.output.subtitles;
        if (!list) return current;
        const subtitles = list.map((file) => {
          const outcome = file.downloadId !== undefined && isSaving(file) ? outcomes.get(file.downloadId) : undefined;
          return outcome ? { ...file, ...outcome } : file;
        });
        return { ...current, output: { ...current.output, subtitles }, updatedAt: this.#now() };
      });
    }
    return running;
  }

  /** A completed progressive file's subtitle files: saves not started yet (a restart came first), then how they ended. */
  async #continueSubtitles(taskId: string): Promise<void> {
    const task = await this.#task(taskId);
    if (task?.status !== 'completed' || !task.output.saved) return;
    if (task.output.subtitles?.some(awaitsSave)) await this.#saveSubtitles(taskId, task.output.saved.path);
    await this.#checkSubtitles(taskId);
  }

  async #cancelSubtitleSaves(task: DownloadTask | undefined): Promise<void> {
    for (const file of task?.output.subtitles ?? []) {
      if (isSaving(file) && file.downloadId !== undefined) await this.#deps.files?.cancel(file.downloadId).catch(() => undefined);
    }
  }

  /**
   * A merged video Chrome completed or gave up on: the task completes or
   * fails. Its subtitle files are settled by now; any that is not ends with
   * `unsaved`.
   */
  async #finishMerged(taskId: string, downloadId: number, state: SaveState, unsaved = subtitleSaveFailure(undefined)): Promise<void> {
    const failure = state.state === 'complete' ? '' : ((await this.#folderFailure(state, KEPT)) ?? saveFailureMessage(state.error));
    let settled: DownloadTask | undefined;
    await this.#deps.store.update(taskId, (current) => {
      if (current.status !== 'processing' || current.output.downloadId !== downloadId) return current;
      const { processing: _processing, statusMessage: _message, ...rest } = current;
      const now = this.#now();
      if (state.state === 'complete') {
        const subtitles = current.output.subtitles ? settledSubtitles(current.output.subtitles, unsaved) : undefined;
        const output = { ...current.output, saved: { path: state.path, bytes: state.bytes, savedAt: now }, ...(subtitles ? { subtitles } : {}) };
        settled = { ...rest, status: 'completed', updatedAt: now, output };
      } else {
        settled = { ...rest, status: 'failed', statusMessage: failure, updatedAt: now };
      }
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
    // Subtitle files Chrome is saving, as the tasks stood when they were cancelled (a save may start meanwhile).
    const subtitleSaves = new Map<string, DownloadTask>();
    for (const task of targets) {
      // Cancelling deletes the data, so no progress is left to show.
      await this.#deps.store.update(task.id, (current) => {
        subtitleSaves.set(task.id, current);
        const cancelled: DownloadTask = { ...withoutRunData(current), status: 'cancelled', updatedAt: this.#now() };
        if (current.progressive) cancelled.progressive = withoutResume(current.progressive);
        return cancelled;
      });
      this.#fileSpeeds.delete(task.id);
    }
    const inEngine = (task: DownloadTask): boolean => (task.status === 'downloading' && !fetchedByBrowser(task)) || task.status === 'processing';
    // A file Chrome is saving or downloading (progressive files): stop that too (it removes the partial file),
    // and the partial file of an interrupted download that was waiting for Retry.
    for (const task of targets) {
      if ((task.status === 'processing' || task.status === 'downloading') && task.output.downloadId !== undefined) {
        await this.#deps.files?.cancel(task.output.downloadId).catch(() => undefined);
      }
      await this.#cancelSubtitleSaves(subtitleSaves.get(task.id) ?? task);
      if (task.progressive?.resumeId !== undefined) await this.#deps.files?.cancel(task.progressive.resumeId).catch(() => undefined);
    }
    const running = targets.filter(inEngine).map((task) => task.id);
    if (running.length > 0 && (await this.#deps.engine.exists())) await this.#deps.engine.cancel(running);
    // The engine deletes a running task's segments itself; the others' data is deleted here, and so are the
    // files on disk of stopped engine-fetched files (an engine that had already handed one to Chrome keeps it).
    for (const task of targets) {
      if (!inEngine(task)) await this.#deleteData(task.id);
      else if (task.progressive?.fetch === 'extension') await this.#deletePartialFiles(task.id);
    }
    if (targets.length > 0) await this.pump();
    return targets.length;
  }

  /** Re-queues failed and cancelled tasks; a failed one continues from the segments it stored. */
  async retry(taskIds: readonly string[]): Promise<number> {
    const tasks = await this.#deps.store.list();
    const targets = tasks.filter((task) => taskIds.includes(task.id) && RETRYABLE_TASK_STATUSES.includes(task.status));
    for (const task of targets) {
      const stored = (await this.#storedProgress(task.id)) ?? fileOnDisk(task);
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

  /**
   * "Save as MKV": a task that failed because its tracks cannot be stored in
   * MP4 switches to MKV (the stored segments are kept) and is retried. Other
   * tasks are left alone.
   */
  async saveAsMkv(taskIds: readonly string[]): Promise<number> {
    const tasks = await this.#deps.store.list();
    const targets = tasks.filter((task) => taskIds.includes(task.id) && task.status === 'failed' && task.failureReason === 'mp4-unsupported');
    for (const task of targets) {
      await this.#deps.store.update(task.id, (current) =>
        current.status === 'failed' && current.failureReason === 'mp4-unsupported' ? { ...current, output: { ...current.output, format: 'mkv' } } : current,
      );
    }
    return targets.length > 0 ? this.retry(targets.map((task) => task.id)) : 0;
  }

  /**
   * Tasks are about to be removed: the partial file Chrome keeps for an
   * interrupted progressive download goes with them (a saved file never does).
   */
  async beforeRemove(taskIds: readonly string[]): Promise<void> {
    for (const task of await this.#deps.store.list()) {
      const resumeId = task.progressive?.resumeId;
      if (taskIds.includes(task.id) && resumeId !== undefined && task.status !== 'downloading') {
        await this.#deps.files?.cancel(resumeId).catch(() => undefined);
      }
    }
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

  // ------------------------------------------------------- progressive files (0.3.0)

  /**
   * Has Chrome download a progressive file (in pump): the freshest link the
   * page uses (a current detection of the video), saved under the task's
   * name with the file's own extension. An interrupted earlier download that
   * Chrome can resume continues instead (Retry). Chrome sends the site's
   * cookies with it, no Referer/Origin. False when Chrome refused to start
   * (the task failed and its slot is free).
   */
  async #startBrowserFile(snapshot: DownloadTask): Promise<boolean> {
    const files = this.#deps.files;
    const task = (await this.#deps.store.list()).find((candidate) => candidate.id === snapshot.id);
    if (task?.status !== 'downloading' || !task.progressive || task.output.downloadId !== undefined) return true;
    try {
      if (!files) throw new Error('downloads are not available');
      const resumeId = task.progressive.resumeId;
      if (resumeId !== undefined) {
        const previous = await files.find(resumeId).catch(() => undefined);
        if (previous?.state === 'interrupted' && previous.canResume && files.resume) {
          const resumed = await files.resume(resumeId).then(
            () => true,
            () => false,
          );
          if (resumed) return await this.#fileStarted(task.id, resumeId);
        }
        // Not resumable (any more): its partial file goes, the download starts over.
        if (previous && previous.state !== 'complete') await files.cancel(resumeId).catch(() => undefined);
      }
      let url = task.source.manifestUrl;
      const stream = await this.#currentStream(task);
      if (stream?.protocol === 'progressive') ({ manifestUrl: url } = await this.#adopt(task.id, stream));
      const downloadId = await files.save({ url, fileName: await this.#inFolder(`${task.output.baseName}.${task.progressive.container}`) });
      return await this.#fileStarted(task.id, downloadId);
    } catch (error) {
      const failed = await this.#deps.store.update(task.id, (current) => {
        if (current.status !== 'downloading') return current;
        const progressive = current.progressive ? withoutResume(current.progressive) : undefined;
        return {
          ...current,
          ...(progressive ? { progressive } : {}),
          status: 'failed',
          statusMessage: `Chrome could not start the download: ${errorMessage(error)}. Press Retry to try again.`,
          updatedAt: this.#now(),
        };
      });
      if (failed?.status === 'failed') this.#deps.notifier?.failed(failed);
      return false;
    }
  }

  /** Records Chrome's download of a task (a task cancelled meanwhile stops it again). */
  async #fileStarted(taskId: string, downloadId: number): Promise<boolean> {
    this.#fileSpeeds.delete(taskId);
    const started = await this.#deps.store.update(taskId, (current) => {
      if (current.status !== 'downloading' || !current.progressive) return current;
      return { ...current, progressive: withoutResume(current.progressive), output: { ...current.output, downloadId }, updatedAt: this.#now() };
    });
    if (started?.output.downloadId !== downloadId) await this.#deps.files?.cancel(downloadId).catch(() => undefined);
    return true;
  }

  /** Reads the progress of Chrome's progressive downloads about once a second while there are any. */
  #watchFiles(): void {
    if (this.#pollScheduled) return;
    this.#pollScheduled = true;
    this.#schedule(() => {
      this.#pollScheduled = false;
      this.#pollFiles().catch((error: unknown) => {
        this.#deps.logger?.warn('Could not read the progress of a download', { error: errorMessage(error) });
      });
    }, FILE_POLL_MS);
  }

  async #pollFiles(): Promise<void> {
    const watched = (await this.#deps.store.list()).filter((task) => task.status === 'downloading' && fetchedByBrowser(task));
    for (const task of watched) {
      const downloadId = task.output.downloadId;
      if (downloadId === undefined) continue;
      const state = await this.#deps.files?.find(downloadId).catch(() => undefined);
      if (!state) await this.#fileGone(task.id, downloadId);
      else if (state.state !== 'in_progress') await this.#settleSave(downloadId);
      // Stop at once what is not the video: a page, or (with a context to replay) a response of another size.
      else if (await this.#refusesContent(task, state)) await this.#refused(task, downloadId, state);
      else await this.#reportFile(task.id, downloadId, state);
    }
    if (watched.length > 0) this.#watchFiles();
  }

  async #reportFile(taskId: string, downloadId: number, state: SaveState): Promise<void> {
    const received = state.received ?? 0;
    let speed = this.#fileSpeeds.get(taskId);
    if (!speed) {
      // Bytes received before this worker started watching (a restart) are not speed.
      speed = { tracker: new ProgressTracker(1, this.#now), received };
      this.#fileSpeeds.set(taskId, speed);
    }
    speed.tracker.received(received - speed.received);
    speed.received = received;
    const progress = fileProgress(speed.tracker.snapshot(), received, state.total, false);
    await this.#deps.store.update(taskId, (current) =>
      current.status === 'downloading' && current.output.downloadId === downloadId ? { ...current, progress, updatedAt: this.#now() } : current,
    );
  }

  /** A web page instead of the video, or (when the page's context could make a difference) a response of another size. */
  async #refusesContent(task: DownloadTask, state: SaveState): Promise<boolean> {
    if (task.progressive?.fetch !== 'browser') return false;
    if (isDocument(state)) return true;
    const expected = task.progressive.bytes;
    if (expected === undefined || state.total === undefined || state.total <= 0 || state.total === expected) return false;
    const context = await this.#deps.store.findContext(task.id);
    return context !== undefined && !isEmptyRequestContext(context);
  }

  /** Chrome finished or gave up a progressive file: completed, refused (another route or a failure), or failed. */
  async #settleFile(task: DownloadTask, downloadId: number, state: SaveState): Promise<void> {
    const refused = (state.state === 'interrupted' && REFUSALS.has(state.error ?? '')) || (await this.#refusesContent(task, state));
    if (refused && task.progressive?.fetch === 'browser') {
      await this.#refused(task, downloadId, state);
      return;
    }
    const folderFailure = state.state === 'complete' ? undefined : await this.#folderFailure(state, 'Press Retry to download it again.');
    let settled: DownloadTask | undefined;
    await this.#deps.store.update(task.id, (current) => {
      if (current.status !== 'downloading' || current.output.downloadId !== downloadId || !current.progressive) return current;
      const { statusMessage: _message, ...rest } = current;
      const now = this.#now();
      if (state.state === 'complete') {
        const bytes = state.bytes;
        const progress = fileProgress(current.progress ?? fileProgress(emptyProgress(now), 0, undefined, false), bytes, bytes, true);
        // The page's `<track>` files are saved next (0.7.0), named after the saved file.
        const subtitles = (current.selection.subtitles ?? []).map((subtitle): SubtitleOutput => ({ trackId: subtitle.id }));
        const output = { ...current.output, saved: { path: state.path, bytes, savedAt: now }, ...(subtitles.length > 0 ? { subtitles } : {}) };
        settled = { ...rest, status: 'completed', progress, updatedAt: now, output };
      } else {
        // Chrome keeps the partial file of a download it can resume: Retry continues it.
        const resumable = current.progressive.fetch === 'browser' && state.canResume === true;
        const { downloadId: _id, ...output } = current.output;
        const progressive = resumable ? { ...current.progressive, resumeId: downloadId } : withoutResume(current.progressive);
        const statusMessage = folderFailure ?? fileFailureMessage(state.error, resumable);
        settled = { ...rest, output, progressive, status: 'failed', statusMessage, updatedAt: now };
      }
      return settled;
    });
    if (!settled) return;
    this.#fileSpeeds.delete(task.id);
    if (settled.status === 'completed') {
      // Chrome has its copy: the engine's file on disk goes (a failed save keeps it for Retry).
      await this.#deletePartialFiles(task.id);
      this.#deps.notifier?.completed(settled);
      // Not awaited: the subtitle files are fetched from the site, and startSave may be on the stack.
      if (settled.output.subtitles) void this.#continueSubtitles(task.id);
    } else {
      this.#deps.notifier?.failed(settled);
    }
    // Not awaited: startSave may be on the stack (engine-fetched files), with the engine waiting for its answer.
    void this.pump();
  }

  /**
   * The server refused Chrome's own download of a progressive file (401, 403,
   * 404, a web page instead of the video). Chrome's downloads cannot carry
   * the page's Referer/Origin: when the task has them, the engine fetches the
   * file with them instead (ProgressiveFetch `extension`). Otherwise the link
   * expired or needs the page again.
   */
  async #refused(task: DownloadTask, downloadId: number, state: SaveState): Promise<void> {
    const files = this.#deps.files;
    if (state.state === 'complete') await files?.removeFile?.(downloadId).catch(() => undefined);
    else if (state.state === 'in_progress') await files?.cancel(downloadId).catch(() => undefined);
    this.#fileSpeeds.delete(task.id);
    const context = await this.#deps.store.findContext(task.id);
    const withContext = context !== undefined && !isEmptyRequestContext(context);
    let failed: DownloadTask | undefined;
    await this.#deps.store.update(task.id, (current) => {
      if (current.status !== 'downloading' || current.output.downloadId !== downloadId || !current.progressive) return current;
      const { downloadId: _id, ...output } = current.output;
      const { progress: _progress, statusMessage: _message, ...rest } = current;
      if (withContext && current.progressive.fetch === 'browser') {
        return { ...rest, output, progressive: { ...withoutResume(current.progressive), fetch: 'extension' }, updatedAt: this.#now() };
      }
      const message =
        context === undefined
          ? CONTEXT_LOST_MESSAGE
          : `The server refused the download (${refusalLabel(state)}). The link may have expired, or the site may want the video's page: play the video again on its page, then press Retry.`;
      failed = { ...rest, output, progressive: withoutResume(current.progressive), status: 'failed', statusMessage: message, updatedAt: this.#now() };
      return failed;
    });
    if (failed) this.#deps.notifier?.failed(failed);
    void this.pump();
  }

  /** The download vanished from Chrome's list while running (the user removed it there). */
  async #fileGone(taskId: string, downloadId: number): Promise<void> {
    this.#fileSpeeds.delete(taskId);
    const failed = await this.#deps.store.update(taskId, (current) => {
      if (current.status !== 'downloading' || current.output.downloadId !== downloadId || !current.progressive) return current;
      const { downloadId: _id, ...output } = current.output;
      return { ...current, output, progressive: withoutResume(current.progressive), status: 'failed', statusMessage: FILE_REMOVED_MESSAGE, updatedAt: this.#now() };
    });
    if (failed?.status === 'failed') this.#deps.notifier?.failed(failed);
    void this.pump();
  }

  /**
   * Service-worker start: a progressive download Chrome finished or gave up
   * meanwhile is settled; one the browser interrupted by closing (or a lost
   * connection) is resumed once if Chrome can; a running one is left to the
   * progress poll. Chrome decides whether a resume works (the server must
   * support ranges and still accept the link).
   */
  async #recoverFile(task: DownloadTask, downloadId: number): Promise<void> {
    const files = this.#deps.files;
    const state = await files?.find(downloadId).catch(() => undefined);
    if (!state) {
      if (fetchedByBrowser(task)) await this.#fileGone(task.id, downloadId);
      return;
    }
    if (state.state === 'in_progress') return;
    const resumable =
      state.state === 'interrupted' && fetchedByBrowser(task) && state.canResume === true && RESUMABLE_ON_STARTUP.has(state.error ?? '');
    if (resumable && files?.resume && (await files.resume(downloadId).then(() => true, () => false))) return;
    await this.#settleFile(task, downloadId, state);
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
    const spec: EngineTaskSpec = {
      taskId: task.id,
      protocol: task.source.protocol,
      manifestUrl,
      context: context ?? {},
      variant,
      audioTrackIds: task.selection.audioTrackIds,
      concurrency: settings.segmentConcurrency,
    };
    // Subtitles of a stream come with its segments: manifest renditions by id, the page's own WebVTT files
    // (0.7.2) by URL. A progressive file's subtitle files are fetched when it is saved.
    const subtitles = task.progressive ? [] : (task.selection.subtitles ?? []);
    const renditions = subtitles.filter((subtitle) => subtitle.url === undefined);
    if (renditions.length > 0) spec.subtitleTrackIds = renditions.map((subtitle) => subtitle.id);
    const pageFiles = subtitles.flatMap((subtitle): PageSubtitleFile[] => {
      if (subtitle.url === undefined) return [];
      const file: PageSubtitleFile = { id: subtitle.id, url: subtitle.url, name: subtitle.name };
      if (subtitle.language !== undefined) file.language = subtitle.language;
      if (subtitle.offsetSec !== undefined) file.offsetSec = subtitle.offsetSec;
      return [file];
    });
    if (pageFiles.length > 0) spec.pageSubtitles = pageFiles;
    // A progressive file the engine fetches with the page's Referer/Origin (0.3.0).
    const file = task.progressive;
    if (file) spec.file = { container: file.container, ...(file.bytes !== undefined ? { bytes: file.bytes } : {}) };
    return spec;
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
    // Progressive files Chrome downloads were not in the engine: Chrome keeps (or resumes) them (onStartup).
    const interrupted = tasks.filter((task) => task.status === 'downloading' && !fetchedByBrowser(task));
    for (const task of interrupted) {
      const stored = (await this.#storedProgress(task.id)) ?? fileOnDisk(task);
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
    await this.#removeOrphanFiles().catch((error: unknown) => {
      this.#deps.logger?.warn('Could not clean up merged files', { error: errorMessage(error) });
    });
    await this.#removeOrphanPartialFiles().catch((error: unknown) => {
      this.#deps.logger?.warn('Could not clean up downloaded files', { error: errorMessage(error) });
    });
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

  /**
   * Merged files on disk that no merge or save needs: left by a merge cut short (the browser
   * closed, the engine crashed) or a deletion that failed. Only a `processing` task has one in
   * use; its engine deletes it. A file still open (being written) is skipped.
   */
  async #removeOrphanFiles(): Promise<void> {
    const mergeFiles = this.#deps.mergeFiles;
    if (!mergeFiles) return;
    // Files first, tasks second, like segments: a merge starts only for a task already processing.
    const names = await mergeFiles.names();
    if (names.length === 0) return;
    const processing = new Set((await this.#deps.store.list()).filter((task) => task.status === 'processing').map((task) => task.id));
    let removed = 0;
    for (const name of names) {
      const taskId = taskIdOfMergeFile(name);
      if (taskId !== undefined && processing.has(taskId)) continue;
      const outcome = await mergeFiles.remove(name).catch(() => 'failed' as const);
      if (outcome === 'removed') removed += 1;
    }
    if (removed > 0) this.#deps.logger?.info('Deleted merged files no task needs', { files: removed });
  }

  /**
   * Progressive files on disk that no task will continue or save: left by a cancellation or a
   * save the engine could not clean up after (it closed first). Tasks that keep their data
   * (queued, downloading, failed…) keep them; a file still open (being written) is skipped.
   */
  async #removeOrphanPartialFiles(): Promise<void> {
    const partialFiles = this.#deps.partialFiles;
    if (!partialFiles) return;
    // Files first, tasks second: a file is only written for a task already in the store.
    const names = await partialFiles.names();
    if (names.length === 0) return;
    const needed = new Set((await this.#deps.store.list()).filter((task) => KEEPS_DATA.includes(task.status)).map((task) => task.id));
    let removed = 0;
    for (const name of names) {
      const taskId = taskIdOfPartialFile(name);
      if (taskId !== undefined && needed.has(taskId)) continue;
      const outcome = await partialFiles.remove(name).catch(() => 'failed' as const);
      if (outcome === 'removed') removed += 1;
    }
    if (removed > 0) this.#deps.logger?.info('Deleted downloaded files no task needs', { files: removed });
  }

  async #deleteData(taskId: string): Promise<void> {
    await this.#deps.storage.deleteTask(taskId).catch((error: unknown) => {
      this.#deps.logger?.warn('Could not delete stored segments', { taskId, error: errorMessage(error) });
    });
    await this.#deletePartialFiles(taskId);
  }

  /** The task's progressive file on disk and its record (0.6.0); one still open is left to the orphan sweep. */
  async #deletePartialFiles(taskId: string): Promise<void> {
    const partialFiles = this.#deps.partialFiles;
    if (!partialFiles) return;
    try {
      for (const name of await partialFiles.names()) {
        if (taskIdOfPartialFile(name) === taskId) await partialFiles.remove(name);
      }
    } catch (error) {
      this.#deps.logger?.warn('Could not delete a downloaded file', { taskId, error: errorMessage(error) });
    }
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.catch((error: unknown) => {
      this.#deps.logger?.error('Download coordination failed', { error: errorMessage(error) });
    });
    return result;
  }
}
