import { useState } from 'react';
import { DEFAULT_RESERVE_BYTES } from '@/core/download/storage-space';
import type { DownloadTask, TaskStatus } from '@/core/models/download-task';
import { sendToBackground } from '@/shared/messaging/client';
import { errorMessage } from '@/shared/utils/errors';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import {
  formatDuration,
  formatSpeed,
  mediaSummary,
  outputFileName,
  overallProgress,
  storageLine,
  taskProgressLine,
  type Tone,
} from '../format';
import { useSettings } from '../hooks/useSettings';
import { useStorageEstimate } from '../hooks/useStorageEstimate';

const STATUS_VIEW: Record<TaskStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  downloading: { label: 'Downloading', tone: 'progress' },
  downloaded: { label: 'Downloaded', tone: 'success' },
  processing: { label: 'Processing', tone: 'progress' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
};

export type Action = 'cancel' | 'retry' | 'remove' | 'show' | 'dismiss';

/** Which buttons a task offers. */
function actionsFor(status: TaskStatus): Action[] {
  switch (status) {
    case 'queued':
    case 'downloaded':
      return ['remove'];
    case 'downloading':
    case 'processing':
      return ['cancel'];
    case 'completed':
      return ['show', 'dismiss'];
    case 'failed':
    case 'cancelled':
      return ['retry', 'remove'];
  }
}

const ACTION_LABELS: Record<Action, string> = { cancel: 'Cancel', retry: 'Retry', remove: 'Remove', show: 'Show in folder', dismiss: 'Clear' };

/** Opens the folder of a saved file, with the file selected (no permission beyond "downloads" needed). */
export function showSavedFile(task: DownloadTask): void {
  if (task.output.downloadId !== undefined) chrome.downloads.show(task.output.downloadId);
}

function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
    >
      <div className="h-full rounded-full bg-indigo-600 transition-[width] dark:bg-indigo-400" style={{ width: `${percent}%` }} />
    </div>
  );
}

function TaskRow({ task, onAction }: { task: DownloadTask; onAction: (task: DownloadTask, action: Action) => void }) {
  const status = STATUS_VIEW[task.status];
  const details = [
    task.selection.variantLabel,
    ...task.selection.audioTrackNames,
    task.selection.durationSec ? formatDuration(task.selection.durationSec) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const line = taskProgressLine(task);
  return (
    <li className="px-4 py-3">
      <div className="flex gap-3">
        <span className="mt-0.5 w-11 shrink-0 self-start rounded bg-indigo-50 py-0.5 text-center text-[11px] font-semibold tracking-wide text-indigo-700 uppercase dark:bg-indigo-950 dark:text-indigo-300">
          {task.source.protocol}
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-medium break-words" title={task.source.title}>
            {task.source.title}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{details}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={task.output.saved?.path ?? 'Output file'}>
            {outputFileName(task)}
          </p>
          {task.status === 'downloading' && task.progress && (
            <ProgressBar percent={task.progress.percent} label={`Download progress of ${task.source.title}`} />
          )}
          {task.status === 'processing' && (
            <ProgressBar percent={task.processing?.percent ?? 0} label={`Processing progress of ${task.source.title}`} />
          )}
          {task.media && (task.status === 'processing' || task.status === 'completed') && (
            <p className="mt-1 text-xs text-slate-600 dark:text-slate-300" title={task.media.containerReason}>
              {mediaSummary(task.media)}
            </p>
          )}
          {line && <p className="mt-1 text-xs text-slate-600 tabular-nums dark:text-slate-300">{line}</p>}
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="ml-auto flex gap-1">
              {actionsFor(task.status).map((action) => (
                <button
                  key={action}
                  type="button"
                  onClick={() => {
                    onAction(task, action);
                  }}
                  aria-label={`${ACTION_LABELS[action]} ${task.source.title}`}
                  className={`rounded px-2 py-0.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-indigo-500 ${
                    action === 'retry'
                      ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                  }`}
                >
                  {ACTION_LABELS[action]}
                </button>
              ))}
            </span>
          </div>
          {task.statusMessage && (
            <p className={`mt-1 text-xs leading-snug ${task.status === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-slate-600 dark:text-slate-400'}`}>
              {task.statusMessage}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

/** Overall progress across running downloads. */
function Summary({ tasks }: { tasks: DownloadTask[] }) {
  const { running, percent, bytesPerSecond } = overallProgress(tasks);
  if (running === 0) return null;
  return (
    <div className="border-b border-slate-200 px-4 py-2 text-xs dark:border-slate-800">
      <p className="flex justify-between tabular-nums">
        <span>
          Downloading {running} {running === 1 ? 'video' : 'videos'} · {percent === undefined ? 'preparing' : `${percent.toFixed(1)}%`}
        </span>
        <span>{formatSpeed(bytesPerSecond)}</span>
      </p>
      <ProgressBar percent={percent ?? 0} label="Overall download progress" />
    </div>
  );
}

/** Disk use of the stored segments and the space left; warns before downloads stop for lack of space. */
function StorageFooter({ tasks }: { tasks: DownloadTask[] }) {
  // Measured again when a task changes status or stores another 32 MB, not on every progress report.
  const refreshKey = tasks.map((task) => `${task.status}:${Math.floor((task.progress?.bytes ?? 0) / 2 ** 25)}`).join(',');
  const estimate = useStorageEstimate(refreshKey);
  const line = estimate ? storageLine(estimate, DEFAULT_RESERVE_BYTES) : undefined;
  if (!line) return null;
  return (
    <p
      role={line.low ? 'alert' : undefined}
      className={`border-t border-slate-200 px-4 py-1.5 text-[11px] tabular-nums dark:border-slate-800 ${
        line.low ? 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200' : 'text-slate-500 dark:text-slate-400'
      }`}
    >
      {line.text}
    </p>
  );
}

const IN_QUEUE: readonly TaskStatus[] = ['processing', 'downloading', 'downloaded', 'queued'];
const ATTENTION: readonly TaskStatus[] = ['failed', 'cancelled'];

export function QueuePage({ tasks }: { tasks: DownloadTask[] | null }) {
  const [error, setError] = useState<string | null>(null);
  const { settings } = useSettings();
  if (tasks === null) return null;

  // Running first, then waiting; oldest first within each group (it is a queue).
  const inQueue = tasks
    .filter((task) => IN_QUEUE.includes(task.status))
    .sort((a, b) => IN_QUEUE.indexOf(a.status) - IN_QUEUE.indexOf(b.status) || a.createdAt - b.createdAt);
  const attention = tasks.filter((task) => ATTENTION.includes(task.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  // Settings → "Remove finished tasks from the queue": completed videos are listed only under Completed.
  const finished =
    settings?.autoRemoveCompleted === false
      ? tasks.filter((task) => task.status === 'completed' && !task.dismissed).sort((a, b) => b.updatedAt - a.updatedAt)
      : [];

  const failed = attention.filter((task) => task.status === 'failed');

  const send = (action: Exclude<Action, 'show'>, taskIds: string[]) => {
    setError(null);
    const request =
      action === 'cancel'
        ? sendToBackground('downloads/cancel', { taskIds })
        : action === 'retry'
          ? sendToBackground('downloads/retry', { taskIds })
          : action === 'dismiss'
            ? sendToBackground('downloads/dismiss', { taskIds })
            : sendToBackground('downloads/remove', { taskIds });
    request.catch((cause: unknown) => {
      setError(errorMessage(cause));
    });
  };
  const act = (task: DownloadTask, action: Action) => {
    if (action === 'show') showSavedFile(task);
    else send(action, [task.id]);
  };

  return (
    <div className="flex h-full flex-col">
      <Summary tasks={tasks} />
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      {inQueue.length === 0 && attention.length === 0 && finished.length === 0 ? (
        <EmptyState title="No downloads">Select videos on the Detected tab and press Download.</EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {inQueue.map((task) => (
              <TaskRow key={task.id} task={task} onAction={act} />
            ))}
          </ul>
          {finished.length > 0 && (
            <>
              <div className="flex items-center border-y border-slate-200 bg-slate-50 px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                <h2 className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">Finished</h2>
                <button
                  type="button"
                  onClick={() => {
                    send('dismiss', finished.map((task) => task.id));
                  }}
                  className="ml-auto rounded px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300 dark:hover:bg-indigo-950"
                >
                  Clear all
                </button>
              </div>
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {finished.map((task) => (
                  <TaskRow key={task.id} task={task} onAction={act} />
                ))}
              </ul>
            </>
          )}
          {attention.length > 0 && (
            <>
              <div className="flex items-center border-y border-slate-200 bg-slate-50 px-4 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                <h2 className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">Failed or cancelled</h2>
                {/* E.g. after freeing disk space: every failed download continues where it stopped. */}
                {failed.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      send('retry', failed.map((task) => task.id));
                    }}
                    className="ml-auto rounded px-2 py-0.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300 dark:hover:bg-indigo-950"
                  >
                    Retry all failed ({failed.length})
                  </button>
                )}
              </div>
              <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                {attention.map((task) => (
                  <TaskRow key={task.id} task={task} onAction={act} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <StorageFooter tasks={tasks} />
    </div>
  );
}
