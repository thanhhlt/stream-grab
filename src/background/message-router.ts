import type { DownloadCoordinator } from '@/core/download/download-coordinator';
import { parseEngineReport, parseMediaReport, parseSaveRequest, parseTaskIds } from '@/core/download/engine-messages';
import { parseDownloadRequests, type TaskService } from '@/core/download/task-service';
import { OFFSCREEN_DOCUMENT_PATH } from '@/shared/constants';
import { createMessageRouter, type MessageSender } from '@/shared/messaging/router';
import { parseDomSources } from '@/shared/types/page-metadata';
import { StreamGrabError } from '@/shared/utils/errors';
import { isRecord } from '@/shared/utils/guards';
import type { DetectionService } from './detection-service';

export interface BackgroundContext {
  /** Epoch ms when this service-worker instance started. */
  startedAt: number;
  detection: DetectionService;
  tasks: TaskService;
  downloads: DownloadCoordinator;
}

/** True for messages from extension pages (popup, offscreen document), false for content scripts. */
function isExtensionPage(sender: MessageSender): boolean {
  return sender.url?.startsWith(chrome.runtime.getURL('')) === true;
}

function requireExtensionPage(sender: MessageSender): void {
  if (!isExtensionPage(sender)) throw new StreamGrabError('Only extension pages may send this message', 'INVALID_MESSAGE');
}

/** Engine messages come only from the offscreen document. */
function requireEngine(sender: MessageSender): void {
  if (sender.url?.split('#')[0] !== chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)) {
    throw new StreamGrabError('Only the download engine may send this message', 'INVALID_MESSAGE');
  }
}

function tabIdOf(payload: unknown): number {
  const tabId = isRecord(payload) ? payload['tabId'] : undefined;
  if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) {
    throw new StreamGrabError('Invalid tabId', 'INVALID_MESSAGE');
  }
  return tabId;
}

function stringField(payload: unknown, key: string, max = 4096): string {
  const value = isRecord(payload) ? payload[key] : undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new StreamGrabError(`Invalid ${key}`, 'INVALID_MESSAGE');
  }
  return value;
}

/**
 * Registers the service worker's request handlers. Must be called synchronously
 * at service-worker startup so Chrome can wake the worker for queued messages.
 * Payloads are validated at runtime: types are compile-time only, and content
 * scripts run next to untrusted page code.
 */
export function registerMessageRouter(context: BackgroundContext): void {
  const { downloads } = context;
  chrome.runtime.onMessage.addListener(
    createMessageRouter('background', {
      'runtime/ping': () => ({
        version: chrome.runtime.getManifest().version,
        startedAt: context.startedAt,
      }),

      'detections/remove': async (payload, sender) => {
        requireExtensionPage(sender);
        const tabId = tabIdOf(payload);
        const streamId = isRecord(payload) ? payload['streamId'] : undefined;
        if (typeof streamId !== 'string' || streamId.length > 64) {
          throw new StreamGrabError('Invalid streamId', 'INVALID_MESSAGE');
        }
        return { removed: await context.detection.manager.removeStream(tabId, streamId) };
      },

      'detections/clear': async (payload, sender) => {
        requireExtensionPage(sender);
        await context.detection.manager.clearTab(tabIdOf(payload));
        return undefined;
      },

      'content/domSources': (payload, sender) => {
        // Location comes from the browser (sender), never from the payload.
        const tabId = sender.tab?.id;
        if (tabId === undefined || isExtensionPage(sender)) return undefined;
        context.detection.handleDomSources(tabId, sender.frameId ?? 0, sender.url, parseDomSources(payload));
        return undefined;
      },

      'downloads/start': async (payload, sender) => {
        requireExtensionPage(sender);
        const result = await context.tasks.start(parseDownloadRequests(payload));
        if (result.created.length > 0) void downloads.pump();
        return result;
      },

      'downloads/remove': async (payload, sender) => {
        requireExtensionPage(sender);
        const removed = await context.tasks.remove(parseTaskIds(payload));
        await downloads.afterRemove(removed);
        return { removed: removed.length };
      },

      'downloads/cancel': async (payload, sender) => {
        requireExtensionPage(sender);
        return { cancelled: await downloads.cancel(parseTaskIds(payload)) };
      },

      'downloads/retry': async (payload, sender) => {
        requireExtensionPage(sender);
        return { retried: await downloads.retry(parseTaskIds(payload)) };
      },

      'downloads/dismiss': async (payload, sender) => {
        requireExtensionPage(sender);
        return { dismissed: await downloads.dismiss(parseTaskIds(payload)) };
      },

      'engine/report': async (payload, sender) => {
        requireEngine(sender);
        const report = parseEngineReport(payload);
        if (!report) throw new StreamGrabError('Invalid engine report', 'INVALID_MESSAGE');
        await downloads.handleReport(report);
        return undefined;
      },

      'engine/mediaReport': async (payload, sender) => {
        requireEngine(sender);
        const report = parseMediaReport(payload);
        if (!report) throw new StreamGrabError('Invalid media report', 'INVALID_MESSAGE');
        await downloads.handleMediaReport(report);
        return undefined;
      },

      'engine/save': async (payload, sender) => {
        requireEngine(sender);
        const request = parseSaveRequest(payload, chrome.runtime.getURL(''));
        if (!request) throw new StreamGrabError('Invalid save request', 'INVALID_MESSAGE');
        return { accepted: await downloads.startSave(request) };
      },

      'engine/acquireContext': async (payload, sender) => {
        requireEngine(sender);
        return { leaseId: await downloads.acquireContext(stringField(payload, 'taskId', 64), stringField(payload, 'url')) };
      },

      'engine/releaseContext': async (payload, sender) => {
        requireEngine(sender);
        await downloads.releaseContext(stringField(payload, 'leaseId', 64));
        return undefined;
      },

      'engine/freshSource': (payload, sender) => {
        requireEngine(sender);
        return downloads.freshSource(stringField(payload, 'taskId', 64));
      },
    }),
  );
}
