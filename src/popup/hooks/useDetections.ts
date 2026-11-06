import { useEffect, useState } from 'react';
import { detectionStorageKey, parseStoredTabDetections } from '@/core/detection/detection-store';
import type { DetectedStream } from '@/core/models/detected-stream';
import type { StorageChangeListener } from '@/shared/storage/storage-area';
import { errorMessage } from '@/shared/utils/errors';

export type DetectionsState =
  | { state: 'loading' }
  | { state: 'ready'; streams: DetectedStream[] }
  | { state: 'error'; error: string };

function toStreams(raw: unknown): DetectedStream[] {
  return parseStoredTabDetections(raw)?.streams ?? [];
}

/**
 * Live view of a tab's detected streams. Reads chrome.storage.session directly
 * (extension pages may) and follows its change events, so new detections show
 * up while the popup is open, without reloading anything.
 */
export function useDetections(tabId: number | undefined): DetectionsState {
  const [state, setState] = useState<DetectionsState>({ state: 'loading' });

  useEffect(() => {
    if (tabId === undefined) return;
    const key = detectionStorageKey(tabId);
    let active = true;

    chrome.storage.session.get(key).then(
      (items) => {
        if (active) setState({ state: 'ready', streams: toStreams(items[key]) });
      },
      (error: unknown) => {
        if (active) setState({ state: 'error', error: errorMessage(error) });
      },
    );

    const onChanged: StorageChangeListener = (changes, areaName) => {
      const change = changes[key];
      if (areaName !== 'session' || change === undefined || !active) return;
      setState({ state: 'ready', streams: toStreams(change.newValue) });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [tabId]);

  return state;
}
