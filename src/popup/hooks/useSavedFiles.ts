import { useEffect, useState } from 'react';

/**
 * Whether saved files are still where Chrome put them, by download ID
 * (chrome.downloads.search; Chrome re-checks the disk at most every 10 s, so
 * a file deleted moments ago may still count as present). IDs Chrome no
 * longer knows (download history cleared) are absent from the map.
 */
export function useSavedFiles(downloadIds: readonly number[]): ReadonlyMap<number, boolean> {
  const [exists, setExists] = useState<ReadonlyMap<number, boolean>>(new Map());
  const key = downloadIds.join(',');

  useEffect(() => {
    let active = true;
    const ids = key === '' ? [] : key.split(',').map(Number);
    Promise.all(ids.map(async (id) => [id, (await chrome.downloads.search({ id }))[0]?.exists] as const))
      .then((entries) => {
        if (!active) return;
        setExists(new Map(entries.filter((entry): entry is readonly [number, boolean] => entry[1] !== undefined)));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [key]);

  return exists;
}
