import type { Notifier } from '@/core/download/download-coordinator';
import type { DownloadTask } from '@/core/models/download-task';
import { formatBytes } from '@/shared/utils/bytes';

const PREFIX = 'streamgrab-task:';

export const notificationIdOf = (taskId: string): string => `${PREFIX}${taskId}`;

export function taskIdOfNotification(notificationId: string): string | undefined {
  return notificationId.startsWith(PREFIX) ? notificationId.slice(PREFIX.length) : undefined;
}

/** "C:\Users\me\Downloads\Movie_1080p (1).mp4" → "Movie_1080p (1).mp4". */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export interface NotificationContent {
  title: string;
  message: string;
  contextMessage?: string;
}

/** What a notification says when a task ends. */
export function notificationContent(kind: 'completed' | 'failed', task: DownloadTask): NotificationContent {
  if (kind === 'completed') {
    const saved = task.output.saved;
    return {
      title: 'Video saved',
      message: saved ? `${fileNameOf(saved.path)} · ${formatBytes(saved.bytes)}` : task.source.title,
      contextMessage: 'Click to show it in its folder',
    };
  }
  const reason = task.statusMessage ?? 'The download failed.';
  return {
    title: 'Download failed',
    message: task.source.title,
    contextMessage: reason.length > 140 ? `${reason.slice(0, 139)}…` : reason,
  };
}

function show(kind: 'completed' | 'failed', task: DownloadTask): void {
  chrome.notifications
    .create(notificationIdOf(task.id), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      priority: 0,
      ...notificationContent(kind, task),
    })
    .catch(() => undefined);
}

/** chrome.notifications at the end of a task (the popup is usually closed by then). */
export const chromeNotifier: Notifier = {
  completed: (task) => {
    show('completed', task);
  },
  failed: (task) => {
    show('failed', task);
  },
};
