import { useEffect, useState } from 'react';
import type { StorageEstimateLike } from '@/core/download/storage-space';

/**
 * navigator.storage.estimate() of the extension origin (the popup shares it
 * with the offscreen document that stores the segments). Measured again
 * whenever `refreshKey` changes, so callers decide how often that is.
 */
export function useStorageEstimate(refreshKey: string): StorageEstimateLike | null {
  const [estimate, setEstimate] = useState<StorageEstimateLike | null>(null);

  useEffect(() => {
    let active = true;
    navigator.storage.estimate().then(
      ({ usage, quota }) => {
        if (active) setEstimate({ usage, quota });
      },
      () => {
        if (active) setEstimate(null);
      },
    );
    return () => {
      active = false;
    };
  }, [refreshKey]);

  return estimate;
}
