import { useEffect, useState } from 'react';
import { errorMessage } from '@/shared/utils/errors';

export type ActiveTabState =
  | { state: 'loading' }
  | { state: 'ready'; tabId: number; url: string | undefined }
  | { state: 'unavailable'; error: string };

/** The tab the popup was opened for. Needs no "tabs" permission: id is always available, url via host permissions. */
export function useActiveTab(): ActiveTabState {
  const [state, setState] = useState<ActiveTabState>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    chrome.tabs.query({ active: true, currentWindow: true }).then(
      ([tab]) => {
        if (!active) return;
        if (tab?.id === undefined) setState({ state: 'unavailable', error: 'No active tab' });
        else setState({ state: 'ready', tabId: tab.id, url: tab.url });
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
