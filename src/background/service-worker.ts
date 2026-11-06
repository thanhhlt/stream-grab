/**
 * Service-worker entry point.
 *
 * MV3 rules this file follows:
 *  - Every event listener is registered synchronously on the first turn of the
 *    event loop. Chrome only re-dispatches events that woke a suspended worker
 *    to listeners registered at that point.
 *  - No state lives only in module globals: the worker can be terminated at any
 *    time, so anything that must survive goes to chrome.storage (settings,
 *    detections, task metadata) or IndexedDB (segment data).
 *  - Long-running work (downloads) runs in the offscreen document; this worker
 *    coordinates and is restarted by Chrome whenever a message arrives.
 */
import { DownloadCoordinator } from '@/core/download/download-coordinator';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { TaskService } from '@/core/download/task-service';
import { TaskStore } from '@/core/download/task-store';
import { getSettingsStore } from '@/shared/settings/settings-store';
import { errorMessage } from '@/shared/utils/errors';
import { createLogger } from '@/shared/utils/logger';
import { startDetectionService } from './detection-service';
import { offscreenEngine } from './engine-channel';
import { chromeFileSaver } from './file-saver';
import { registerMessageRouter } from './message-router';
import { chromeNotifier, taskIdOfNotification } from './notifier';

const log = createLogger('background');
const startedAt = Date.now();

// A promise nobody awaited failed: log it (redacted) instead of losing it.
self.addEventListener('unhandledrejection', (event) => {
  log.error('Unhandled error', { error: errorMessage(event.reason) });
});

const detection = startDetectionService();
const taskStore = new TaskStore(chrome.storage.local, chrome.storage.session);
const getStream = (tabId: number, streamId: string) => detection.manager.getStream(tabId, streamId);
/** The same video in any open tab (tab IDs change after a browser restart; stream IDs do not). */
const findStreams = async (streamId: string) => {
  const tabs = await chrome.tabs.query({});
  const found = await Promise.all(tabs.map((tab) => (tab.id === undefined ? Promise.resolve(undefined) : getStream(tab.id, streamId))));
  return found.filter((stream) => stream !== undefined);
};
const tasks = new TaskService({
  store: taskStore,
  getStream,
  protocols: detection.protocols,
  getSettings: () => getSettingsStore().load(),
});
const downloads = new DownloadCoordinator({
  store: taskStore,
  storage: new IndexedDbSegmentStorage(),
  engine: offscreenEngine,
  acquireContext: (url, context) => detection.rules.acquire(url, context),
  getSettings: () => getSettingsStore().load(),
  getStream,
  findStreams,
  files: chromeFileSaver,
  notifier: chromeNotifier,
  logger: log,
});
registerMessageRouter({ startedAt, detection, tasks, downloads });

// Chrome finished (or gave up) saving a merged file: complete the task. Also wakes a suspended worker.
chrome.downloads.onChanged.addListener((delta) => {
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') {
    downloads.handleFileChange(delta.id).catch((error: unknown) => {
      log.warn('Could not finish a saved file', { error: errorMessage(error) });
    });
  }
});

// A click on "Video saved" shows the file in its folder.
chrome.notifications.onClicked.addListener((notificationId) => {
  const taskId = taskIdOfNotification(notificationId);
  if (taskId === undefined) return;
  void chrome.notifications.clear(notificationId);
  taskStore
    .list()
    .then((list) => {
      const downloadId = list.find((task) => task.id === taskId && task.status === 'completed')?.output.downloadId;
      if (downloadId !== undefined) chrome.downloads.show(downloadId);
    })
    .catch(() => undefined);
});

// A change of "simultaneous downloads" may let queued tasks start.
getSettingsStore().subscribe(() => {
  void downloads.pump();
});

// Resume: tasks that were downloading when the worker (or the browser) stopped are handed to the engine
// again and continue from their stored segments; data no task needs any more is deleted.
downloads.onStartup().catch((error: unknown) => {
  log.error('Could not resume downloads', { error: errorMessage(error) });
});

chrome.runtime.onInstalled.addListener((details) => {
  getSettingsStore()
    .initialize()
    .then(
      () => {
        log.info('Extension installed or updated', { reason: details.reason });
      },
      (error: unknown) => {
        log.error('Could not initialise settings', { error });
      },
    );
});

log.debug('Service worker started');
