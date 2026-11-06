import { OFFSCREEN_DOCUMENT_PATH } from '@/shared/constants';

/**
 * Lifecycle of the offscreen document that will host the download and media
 * engine (Phase 6+).
 *
 * Why an offscreen document instead of the service worker:
 *  - The service worker is terminated after ~30 s without extension events, which
 *    would abort long segment downloads and FFmpeg runs.
 *  - Service workers cannot spawn dedicated Web Workers (FFmpeg.wasm needs one)
 *    and cannot call URL.createObjectURL (needed to hand the result to
 *    chrome.downloads).
 * Offscreen documents only get chrome.runtime, so all other chrome.* calls stay
 * in the service worker and the engine talks to it via messages.
 */

let creating: Promise<void> | undefined;

export async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

/** Creates the offscreen document unless it already exists. Safe to call concurrently. */
export async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
      justification: 'Downloads stream segments and merges them with FFmpeg.wasm in a Web Worker, then saves the result.',
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

/** Closes the offscreen document when no work is left, freeing its memory. */
export async function closeOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
}
