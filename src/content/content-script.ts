/**
 * Content script, injected into every http(s) frame at document_idle.
 *
 * It runs in an isolated world: page scripts cannot see its variables, but the
 * DOM it reads is page-controlled, so the service worker validates everything
 * it reports. It never executes page-provided code.
 *
 * Responsibilities:
 *  - answer metadata requests (titles, <video> elements) for detected streams,
 *  - report manifests referenced directly by <video>/<source> elements.
 */
import { sendToBackground } from '@/shared/messaging/client';
import { createMessageRouter } from '@/shared/messaging/router';
import { collectFrameMetadata } from './page-metadata';
import { watchDomSources } from './video-detector';

chrome.runtime.onMessage.addListener(
  createMessageRouter('content', {
    'content/ping': () => ({ isTopFrame: window.top === window }),
    'content/getMetadata': () => collectFrameMetadata(document, window),
  }),
);

const watcher = watchDomSources(document, (sources) => {
  sendToBackground('content/domSources', { sources }).catch(() => {
    // The extension was reloaded or updated: this script is orphaned and can no longer talk to it.
    if (!chrome.runtime.id) watcher.stop();
  });
});
