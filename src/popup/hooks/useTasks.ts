import { useEffect, useState } from 'react';
import { mergeStoredTasks } from '@/core/download/task-store';
import type { DownloadTask } from '@/core/models/download-task';
import { STORAGE_KEYS } from '@/shared/constants';
import type { StorageChangeListener } from '@/shared/storage/storage-area';

/**
 * Live list of download tasks from chrome.storage.local. The service worker is
 * the only writer; the popup follows its change events, so the list stays
 * current while the popup is open and is complete when it reopens. Tasks and
 * their progress are stored under two keys (see TaskStore); a change of
 * either is merged with the last value of the other.
 */
export function useTasks(): DownloadTask[] | null {
  const [tasks, setTasks] = useState<DownloadTask[] | null>(null);

  useEffect(() => {
    let active = true;
    let stored: { tasks: unknown; progress: unknown } | undefined;
    const show = (): void => {
      if (active && stored) setTasks(mergeStoredTasks(stored.tasks, stored.progress));
    };
    chrome.storage.local.get([STORAGE_KEYS.tasks, STORAGE_KEYS.taskProgress]).then(
      (items) => {
        stored = { tasks: items[STORAGE_KEYS.tasks], progress: items[STORAGE_KEYS.taskProgress] };
        show();
      },
      () => {
        if (active) setTasks([]);
      },
    );
    const onChanged: StorageChangeListener = (changes, areaName) => {
      if (areaName !== 'local' || !stored) return;
      const list = changes[STORAGE_KEYS.tasks];
      const progress = changes[STORAGE_KEYS.taskProgress];
      if (list === undefined && progress === undefined) return;
      if (list !== undefined) stored.tasks = list.newValue;
      if (progress !== undefined) stored.progress = progress.newValue;
      show();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return tasks;
}
