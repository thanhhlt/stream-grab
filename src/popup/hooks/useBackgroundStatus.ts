import { useEffect, useState } from 'react';
import { sendToBackground } from '@/shared/messaging/client';
import type { BackgroundStatus } from '@/shared/messaging/protocol';
import { errorMessage } from '@/shared/utils/errors';

export type BackgroundState =
  | { state: 'connecting' }
  | { state: 'ready'; status: BackgroundStatus }
  | { state: 'unavailable'; error: string };

/** Pings the service worker once when the popup opens (waking it if it was suspended). */
export function useBackgroundStatus(): BackgroundState {
  const [state, setState] = useState<BackgroundState>({ state: 'connecting' });

  useEffect(() => {
    let active = true;
    sendToBackground('runtime/ping').then(
      (status) => {
        if (active) setState({ state: 'ready', status });
      },
      (error: unknown) => {
        if (active) setState({ state: 'unavailable', error: errorMessage(error) });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return state;
}
