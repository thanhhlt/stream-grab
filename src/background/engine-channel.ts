import type { EngineChannel } from '@/core/download/download-coordinator';
import { sendToOffscreen } from '@/shared/messaging/client';
import { closeOffscreenDocument, ensureOffscreenDocument, hasOffscreenDocument } from './offscreen-host';

/** The download engine in the offscreen document, as seen from the service worker. */
export const offscreenEngine: EngineChannel = {
  exists: () => hasOffscreenDocument(),
  ensure: () => ensureOffscreenDocument(),
  close: () => closeOffscreenDocument(),
  sync: async (work) => (await sendToOffscreen('engine/sync', work)).running,
  cancel: async (taskIds) => {
    await sendToOffscreen('engine/cancel', { taskIds });
  },
  reacquireContexts: async () => {
    await sendToOffscreen('engine/reacquireContexts');
  },
};
