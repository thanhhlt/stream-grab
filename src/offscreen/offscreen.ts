/**
 * Offscreen document: host of the engine, downloads and media processing.
 *
 * Only chrome.runtime is available here. It has a DOM, can spawn Web Workers,
 * shares the extension origin's IndexedDB, can create blob: URLs, and is not
 * subject to the service worker's idle termination, so downloads keep running
 * whether the popup is open or not. Everything else (task store, header rules,
 * chrome.downloads) is the service worker's; the engine talks to it by message.
 *
 * FFmpeg runs one level further down, in a dedicated module worker started
 * only when media processing needs it (see FfmpegService).
 */
import { DownloadManager } from '@/core/download/download-manager';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { parseEngineWork, parseTaskIds } from '@/core/download/engine-messages';
import { FfmpegService } from '@/core/media/ffmpeg-service';
import { MediaManager } from '@/core/media/media-manager';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { FFMPEG_CORE_PATH } from '@/shared/constants';
import { sendToBackground } from '@/shared/messaging/client';
import { createMessageRouter } from '@/shared/messaging/router';
import { errorMessage } from '@/shared/utils/errors';
import { createLogger } from '@/shared/utils/logger';
import { ContextLeases } from './context-leases';
import { Engine } from './engine';

const log = createLogger('offscreen');

// Errors nobody handled: log them (redacted) so a failing engine leaves a trace in its console.
window.addEventListener('unhandledrejection', (event) => {
  log.error('Unhandled error', { error: errorMessage(event.reason) });
});
window.addEventListener('error', (event) => {
  log.error('Uncaught error', { error: event.message });
});

const leases = new ContextLeases(
  async (taskId, url) => (await sendToBackground('engine/acquireContext', { taskId, url })).leaseId,
  async (leaseId) => {
    await sendToBackground('engine/releaseContext', { leaseId });
  },
);

/** `fetch` whose requests carry the task's Referer/Origin (via the service worker's rules). */
const fetchFor =
  (taskId: string): FetchFunction =>
  async (url, init) => {
    await leases.ensure(taskId, url, init.signal ?? undefined);
    return fetch(url, init);
  };

const storage = new IndexedDbSegmentStorage();

const downloads = new DownloadManager({
  storage,
  protocols: (taskId) => {
    const fetcher = new ManifestFetcher({ fetch: fetchFor(taskId) });
    return new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
  },
  fetchFor,
  freshSource: (taskId) => sendToBackground('engine/freshSource', { taskId }),
  releaseContexts: (taskId) => leases.releaseTask(taskId),
  report: (report) => {
    sendToBackground('engine/report', report).catch((error: unknown) => {
      log.warn('Could not report progress', { taskId: report.taskId, error: errorMessage(error) });
    });
  },
  // Free disk space: checked before each run and while segments are written.
  estimateStorage: () => navigator.storage.estimate(),
});

const ffmpeg = new FfmpegService({
  // Vite bundles the worker from this exact expression (dist/workers/media-worker.js).
  createWorker: () => new Worker(new URL('../workers/media-worker.ts', import.meta.url), { type: 'module', name: 'StreamGrab media' }),
  coreUrl: chrome.runtime.getURL(FFMPEG_CORE_PATH),
  logger: createLogger('ffmpeg'),
});

const media = new MediaManager({
  storage,
  ffmpeg,
  // The merged file goes to the service worker as a blob: URL of this document; Chrome reads it from here.
  save: async (request) => (await sendToBackground('engine/save', request)).accepted,
  // The merged file and the copy Chrome saves need room too: checked before merging.
  estimateStorage: () => navigator.storage.estimate(),
  report: (report) => {
    sendToBackground('engine/mediaReport', report).catch((error: unknown) => {
      log.warn('Could not report media progress', { taskId: report.taskId, error: errorMessage(error) });
    });
  },
});

const engine = new Engine(downloads, media);

chrome.runtime.onMessage.addListener(
  createMessageRouter('offscreen', {
    'offscreen/ping': () => ({ ready: true as const }),
    // Both answer only once the work they stop has deleted its data: the service worker may close this document next.
    'engine/sync': async (payload) => ({ running: await engine.sync(parseEngineWork(payload)) }),
    'engine/cancel': async (payload) => {
      await engine.cancel(parseTaskIds(payload));
      return undefined;
    },
    'engine/reacquireContexts': async () => {
      await leases.reacquireAll();
      return undefined;
    },
  }),
);

log.debug('Engine ready');
