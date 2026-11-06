import type { StartDownloadsResult } from '@/core/download/task-service';
import type { RequestContext } from '@/core/models/detected-stream';
import type { DownloadRequest, EngineReport, EngineWork, MediaReport, SaveRequest } from '@/core/models/download-task';
import type { DomSource, FrameMetadata } from '@/shared/types/page-metadata';
import { isRecord } from '@/shared/utils/guards';
import type { SerializedError } from '@/shared/utils/errors';

/**
 * Message protocol between extension contexts.
 *
 * chrome.runtime.sendMessage is delivered to *every* extension context (service
 * worker, popup, offscreen document), so each envelope names its receiving
 * context in `target`; routers ignore envelopes addressed to someone else and
 * leave them for the right listener to answer.
 *
 * Each receiver declares a contract (message type → request/response). The
 * router requires a handler for every type in its contract, and the client
 * helpers infer payload and response types from it.
 */
export const MESSAGE_CHANNEL = 'streamgrab/v1';

export type MessageTarget = 'background' | 'offscreen' | 'content';

export interface Exchange<Request, Response> {
  request: Request;
  response: Response;
}

export type Contract = Record<string, Exchange<unknown, unknown>>;

export interface BackgroundStatus {
  version: string;
  /** Epoch ms when the current service-worker instance started; changes after every suspension. */
  startedAt: number;
}

export interface ContentFrameInfo {
  isTopFrame: boolean;
}

// Contracts are type aliases (not interfaces) so they satisfy the `Contract` index signature.
export type BackgroundContract = {
  'runtime/ping': Exchange<undefined, BackgroundStatus>;
  /** Popup: remove one detected stream from a tab's list. */
  'detections/remove': Exchange<{ tabId: number; streamId: string }, { removed: boolean }>;
  /** Popup: clear a tab's list. */
  'detections/clear': Exchange<{ tabId: number }, undefined>;
  /** Content script: manifest URLs referenced by <video>/<source> elements (validated by the receiver). */
  'content/domSources': Exchange<{ sources: DomSource[] }, undefined>;
  /** Popup: queue downloads; each request succeeds or fails on its own. */
  'downloads/start': Exchange<{ requests: DownloadRequest[] }, StartDownloadsResult>;
  /** Popup: remove tasks that are not running. */
  'downloads/remove': Exchange<{ taskIds: string[] }, { removed: number }>;
  /** Popup: cancel queued or running tasks. */
  'downloads/cancel': Exchange<{ taskIds: string[] }, { cancelled: number }>;
  /** Popup: queue failed or cancelled tasks again. */
  'downloads/retry': Exchange<{ taskIds: string[] }, { retried: number }>;
  /** Popup: hide completed tasks from the Queue tab (they stay under Completed). */
  'downloads/dismiss': Exchange<{ taskIds: string[] }, { dismissed: number }>;

  /** Engine (offscreen): progress and outcome of a task's download. */
  'engine/report': Exchange<EngineReport, undefined>;
  /** Engine: progress and failures of a task's media processing (FFmpeg). */
  'engine/mediaReport': Exchange<MediaReport, undefined>;
  /** Engine: the merged file is ready at a blob: URL of the offscreen document; have Chrome save it. */
  'engine/save': Exchange<SaveRequest, { accepted: boolean }>;
  /** Engine: apply the task's Referer/Origin to the extension's requests to `url`'s host. */
  'engine/acquireContext': Exchange<{ taskId: string; url: string }, { leaseId: string | null }>;
  'engine/releaseContext': Exchange<{ leaseId: string }, undefined>;
  /** Engine: the freshest manifest URL and context for a task (the page may have re-signed its link). */
  'engine/freshSource': Exchange<{ taskId: string }, { manifestUrl: string; context: RequestContext } | null>;
};

export type OffscreenContract = {
  'offscreen/ping': Exchange<undefined, { ready: true }>;
  /** Run exactly this work (downloads and media jobs): start new ones, keep running ones, cancel the rest. */
  'engine/sync': Exchange<EngineWork, { running: string[] }>;
  /** Cancel tasks, downloading or processing (their stored segments are deleted). */
  'engine/cancel': Exchange<{ taskIds: string[] }, undefined>;
  /** The service worker restarted and dropped its header rules: acquire them again. */
  'engine/reacquireContexts': Exchange<undefined, undefined>;
};

export type ContentContract = {
  'content/ping': Exchange<undefined, ContentFrameInfo>;
  /** Title, structured data and <video> elements of the receiving frame. */
  'content/getMetadata': Exchange<undefined, FrameMetadata>;
};

export interface ContractsByTarget {
  background: BackgroundContract;
  offscreen: OffscreenContract;
  content: ContentContract;
}

export type RequestOf<C extends Contract, K extends keyof C> = C[K]['request'];
export type ResponseOf<C extends Contract, K extends keyof C> = C[K]['response'];

export interface MessageEnvelope {
  channel: typeof MESSAGE_CHANNEL;
  target: MessageTarget;
  type: string;
  payload: unknown;
}

export type MessageResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

const TARGETS: readonly MessageTarget[] = ['background', 'offscreen', 'content'];

export function isMessageEnvelope(value: unknown): value is MessageEnvelope {
  return (
    isRecord(value) &&
    value['channel'] === MESSAGE_CHANNEL &&
    typeof value['type'] === 'string' &&
    TARGETS.includes(value['target'] as MessageTarget)
  );
}

export function isMessageResult(value: unknown): value is MessageResult<unknown> {
  if (!isRecord(value)) return false;
  if (value['ok'] === true) return true;
  const error = value['error'];
  return value['ok'] === false && isRecord(error) && typeof error['message'] === 'string';
}
