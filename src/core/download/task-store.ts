import {
  STREAMING_PROTOCOLS,
  type RequestContext,
} from '@/core/models/detected-stream';
import { TASK_STATUSES, type DownloadTask, type MediaProgress, type TaskProgress } from '@/core/models/download-task';
import { STORAGE_KEYS } from '@/shared/constants';
import { OUTPUT_FORMATS } from '@/shared/settings/settings';
import type { RemovableKeyValueArea } from '@/shared/storage/storage-area';
import { isOneOf, isRecord } from '@/shared/utils/guards';
import { parseMediaAnalysis, parseMediaProgress, parseTrackProgress } from './engine-messages';

/**
 * Persistence of download tasks.
 *
 * Tasks live in chrome.storage.local so they survive popup closes, worker
 * restarts and browser restarts. The request context (Referer/Origin of the
 * page) is kept apart in chrome.storage.session, which is never written to
 * disk: it is sensitive and only valid for the current browsing session.
 * The service worker is the only writer; writes are serialised.
 *
 * Progress (`progress`, `processing`) changes several times a second while
 * tasks run, the rest of a task only when its status does. They are stored
 * under two keys: `taskProgress` (small) on every report, `tasks` (up to 500
 * tasks with their media details, hundreds of KB) only when something other
 * than progress changed. Each write of a key costs Chrome the whole value, on
 * disk and again in the onChanged event every extension context receives.
 * Readers merge the two (mergeStoredTasks); tasks stored with their progress
 * inline (before this split) are still read.
 */

export interface StoredTasks {
  version: 1;
  tasks: DownloadTask[];
}

/** The fast-changing part of each task that has any, with the time of its last change. */
export type StoredProgress = Record<string, ProgressEntry>;

interface ProgressEntry {
  progress?: TaskProgress;
  processing?: MediaProgress;
  updatedAt?: number;
}

export const MAX_STORED_TASKS = 500;

export class TaskStore {
  readonly #local: RemovableKeyValueArea;
  readonly #session: RemovableKeyValueArea;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(local: RemovableKeyValueArea, session: RemovableKeyValueArea) {
    this.#local = local;
    this.#session = session;
  }

  async list(): Promise<DownloadTask[]> {
    const [tasks, progress] = await Promise.all([this.#local.get(STORAGE_KEYS.tasks), this.#local.get(STORAGE_KEYS.taskProgress)]);
    return mergeStoredTasks(tasks[STORAGE_KEYS.tasks], progress[STORAGE_KEYS.taskProgress]);
  }

  /** Adds tasks (newest last) with their request contexts. Oldest finished tasks are dropped past the cap. */
  add(entries: readonly { task: DownloadTask; context: RequestContext }[]): Promise<void> {
    return this.#enqueue(async () => {
      const tasks = [...(await this.list()), ...entries.map((entry) => entry.task)];
      await this.#writeTasks(trimTasks(tasks));
      const contexts = await this.#contexts();
      for (const { task, context } of entries) contexts[task.id] = context;
      await this.#session.set({ [STORAGE_KEYS.taskContexts]: contexts });
    });
  }

  /** Applies `change` to one task; returns the updated task, or undefined when it does not exist. */
  update(id: string, change: (task: DownloadTask) => DownloadTask): Promise<DownloadTask | undefined> {
    return this.#enqueue(async () => {
      const tasks = await this.list();
      const index = tasks.findIndex((task) => task.id === id);
      const current = tasks[index];
      if (current === undefined) return undefined;
      const next = change(current);
      if (next === current) return next;
      tasks[index] = next;
      // A progress report changes nothing else (but the time): only the small progress key is written.
      await this.#writeTasks(tasks, JSON.stringify(listPart(current)) !== JSON.stringify(listPart(next)));
      return next;
    });
  }

  /** Removes tasks and their contexts; returns how many existed. */
  remove(ids: readonly string[]): Promise<number> {
    return this.#enqueue(async () => {
      const remove = new Set(ids);
      const tasks = await this.list();
      const kept = tasks.filter((task) => !remove.has(task.id));
      if (kept.length !== tasks.length) await this.#writeTasks(kept);
      const contexts = await this.#contexts();
      for (const id of ids) delete contexts[id];
      await this.#session.set({ [STORAGE_KEYS.taskContexts]: contexts });
      return tasks.length - kept.length;
    });
  }

  async getContext(id: string): Promise<RequestContext> {
    return (await this.findContext(id)) ?? {};
  }

  /**
   * The task's request context, or undefined when session storage has none
   * for it: every task gets one when created (possibly empty), so a missing
   * one means the browser session that held it ended (browser restart,
   * extension reload).
   */
  async findContext(id: string): Promise<RequestContext | undefined> {
    return (await this.#contexts())[id];
  }

  /** Replaces a task's request context (the page re-sent its manifest request with a new Referer). */
  setContext(id: string, context: RequestContext): Promise<void> {
    return this.#enqueue(async () => {
      const contexts = await this.#contexts();
      contexts[id] = context;
      await this.#session.set({ [STORAGE_KEYS.taskContexts]: contexts });
    });
  }

  async #contexts(): Promise<Record<string, RequestContext>> {
    const items = await this.#session.get(STORAGE_KEYS.taskContexts);
    const raw = items[STORAGE_KEYS.taskContexts];
    const contexts: Record<string, RequestContext> = {};
    if (!isRecord(raw)) return contexts;
    for (const [id, value] of Object.entries(raw)) {
      if (!isRecord(value)) continue;
      const context: RequestContext = {};
      if (typeof value['referer'] === 'string') context.referer = value['referer'];
      if (typeof value['origin'] === 'string') context.origin = value['origin'];
      contexts[id] = context;
    }
    return contexts;
  }

  /** Writes the progress key, and the task list unless only progress changed (one storage write either way). */
  #writeTasks(tasks: DownloadTask[], listChanged = true): Promise<void> {
    const progress: StoredProgress = {};
    for (const task of tasks) {
      if (task.progress === undefined && task.processing === undefined) continue;
      progress[task.id] = {
        ...(task.progress !== undefined ? { progress: task.progress } : {}),
        ...(task.processing !== undefined ? { processing: task.processing } : {}),
        updatedAt: task.updatedAt,
      };
    }
    const items: Record<string, unknown> = { [STORAGE_KEYS.taskProgress]: progress };
    if (listChanged) {
      const data: StoredTasks = { version: 1, tasks: tasks.map(withoutProgress) };
      items[STORAGE_KEYS.tasks] = data;
    }
    return this.#local.set(items);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result.catch(() => undefined);
    return result;
  }
}

function withoutProgress(task: DownloadTask): DownloadTask {
  const { progress: _progress, processing: _processing, ...rest } = task;
  return rest;
}

/** What only the `tasks` key holds: everything but progress and the time of the last change. */
function listPart(task: DownloadTask): Omit<DownloadTask, 'updatedAt'> {
  const { updatedAt: _updatedAt, ...rest } = withoutProgress(task);
  return rest;
}

/** Keeps at most MAX_STORED_TASKS, dropping the oldest finished tasks first. */
function trimTasks(tasks: DownloadTask[]): DownloadTask[] {
  let excess = tasks.length - MAX_STORED_TASKS;
  if (excess <= 0) return tasks;
  return tasks.filter((task) => {
    if (excess > 0 && (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled')) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

// ------------------------------------------------------------- validation

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

export function parseTask(raw: unknown): DownloadTask | null {
  if (!isRecord(raw)) return null;
  const { source, selection, output } = raw;
  if (!isRecord(source) || !isRecord(selection) || !isRecord(output)) return null;
  const id = str(raw['id']);
  const createdAt = num(raw['createdAt']);
  const updatedAt = num(raw['updatedAt']);
  const status = raw['status'];
  const protocol = source['protocol'];
  const manifestUrl = str(source['manifestUrl']);
  const title = str(source['title']);
  const tabId = num(source['tabId']);
  const streamId = str(source['streamId']);
  const variantId = str(selection['variantId']);
  const variantLabel = str(selection['variantLabel']);
  const baseName = str(output['baseName']);
  const format = output['format'];
  if (
    id === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    !isOneOf(status, TASK_STATUSES) ||
    !isOneOf(protocol, STREAMING_PROTOCOLS) ||
    manifestUrl === undefined ||
    title === undefined ||
    tabId === undefined ||
    streamId === undefined ||
    variantId === undefined ||
    variantLabel === undefined ||
    baseName === undefined ||
    !isOneOf(format, OUTPUT_FORMATS)
  ) {
    return null;
  }
  const task: DownloadTask = {
    id,
    createdAt,
    updatedAt,
    status,
    source: { protocol, manifestUrl, title, tabId, streamId },
    selection: {
      variantId,
      variantLabel,
      audioTrackIds: strings(selection['audioTrackIds']),
      audioTrackNames: strings(selection['audioTrackNames']),
    },
    output: { baseName, format },
  };
  const statusMessage = str(raw['statusMessage']);
  if (statusMessage !== undefined) task.statusMessage = statusMessage;
  const pageUrl = str(source['pageUrl']);
  if (pageUrl !== undefined) task.source.pageUrl = pageUrl;
  for (const key of ['width', 'height', 'bandwidth', 'durationSec'] as const) {
    const value = num(selection[key]);
    if (value !== undefined && value > 0) task.selection[key] = value;
  }
  const progress = parseProgress(raw['progress']);
  if (progress) task.progress = progress;
  const processing = parseMediaProgress(raw['processing']);
  if (processing) task.processing = processing;
  const media = parseMediaAnalysis(raw['media']);
  if (media) task.media = media;
  const downloadId = num(output['downloadId']);
  if (downloadId !== undefined && Number.isInteger(downloadId) && downloadId >= 0) task.output.downloadId = downloadId;
  const saved = output['saved'];
  if (isRecord(saved)) {
    const path = str(saved['path']);
    const bytes = num(saved['bytes']);
    const savedAt = num(saved['savedAt']);
    if (path !== undefined && bytes !== undefined && bytes >= 0 && savedAt !== undefined) task.output.saved = { path, bytes, savedAt };
  }
  if (raw['dismissed'] === true) task.dismissed = true;
  return task;
}

function parseProgress(raw: unknown): TaskProgress | undefined {
  if (!isRecord(raw)) return undefined;
  const fields = ['segmentsTotal', 'segmentsDone', 'bytes', 'bytesPerSecond', 'percent', 'retries', 'startedAt'] as const;
  const progress: Partial<TaskProgress> = {};
  for (const field of fields) {
    const value = num(raw[field]);
    if (value === undefined || value < 0) return undefined;
    progress[field] = value;
  }
  const resumed = num(raw['resumedSegments']);
  if (resumed !== undefined && resumed > 0) progress.resumedSegments = resumed;
  if (raw['stale'] === true) progress.stale = true;
  const average = num(raw['averageBytesPerSecond']);
  if (average !== undefined && average >= 0) progress.averageBytesPerSecond = average;
  const tracks = parseTrackProgress(raw['tracks']);
  if (tracks) progress.tracks = tracks;
  return progress as TaskProgress;
}

export function parseStoredTasks(raw: unknown): DownloadTask[] {
  if (!isRecord(raw) || raw['version'] !== 1 || !Array.isArray(raw['tasks'])) return [];
  return raw['tasks'].map(parseTask).filter((task) => task !== null);
}

function parseStoredProgress(raw: unknown): Map<string, ProgressEntry> {
  const entries = new Map<string, ProgressEntry>();
  if (!isRecord(raw)) return entries;
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const entry: ProgressEntry = {};
    const progress = parseProgress(value['progress']);
    const processing = parseMediaProgress(value['processing']);
    const updatedAt = num(value['updatedAt']);
    if (progress) entry.progress = progress;
    if (processing) entry.processing = processing;
    if (updatedAt !== undefined) entry.updatedAt = updatedAt;
    entries.set(id, entry);
  }
  return entries;
}

/**
 * Tasks as stored under `tasks` with their progress from `taskProgress`. A
 * task without an entry there keeps what it carries itself (stored before
 * the split) or has none.
 */
export function mergeStoredTasks(tasksRaw: unknown, progressRaw: unknown): DownloadTask[] {
  const progress = parseStoredProgress(progressRaw);
  return parseStoredTasks(tasksRaw).map((task) => {
    const entry = progress.get(task.id);
    if (!entry) return task;
    const merged = withoutProgress(task);
    if (entry.progress) merged.progress = entry.progress;
    if (entry.processing) merged.processing = entry.processing;
    if (entry.updatedAt !== undefined && entry.updatedAt > merged.updatedAt) merged.updatedAt = entry.updatedAt;
    return merged;
  });
}
