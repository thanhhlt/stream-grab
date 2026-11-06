import { useState } from 'react';
import type { DownloadTask } from '@/core/models/download-task';
import { sendToBackground } from '@/shared/messaging/client';
import { errorMessage } from '@/shared/utils/errors';
import { EmptyState } from '../components/EmptyState';
import { completedTasks, formatBytes, formatSavedAt, mediaSummary, outputFileName } from '../format';
import { useSavedFiles } from '../hooks/useSavedFiles';
import { showSavedFile } from './QueuePage';

function CompletedRow({ task, exists, onRemove }: { task: DownloadTask; exists: boolean | undefined; onRemove: (task: DownloadTask) => void }) {
  const saved = task.output.saved;
  const facts = [saved ? formatBytes(saved.bytes) : undefined, saved ? formatSavedAt(saved.savedAt) : undefined, task.selection.variantLabel]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className="px-4 py-3">
      <p className="line-clamp-2 font-medium break-words" title={task.source.title}>
        {task.source.title}
      </p>
      <p className="mt-0.5 truncate font-mono text-[11px] text-slate-600 dark:text-slate-300" title={saved?.path}>
        {outputFileName(task)}
      </p>
      <p className="mt-0.5 text-xs text-slate-500 tabular-nums dark:text-slate-400">{facts}</p>
      {task.media && (
        <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400" title={task.media.containerReason}>
          {mediaSummary(task.media)}
        </p>
      )}
      <div className="mt-1.5 flex items-center gap-1">
        {exists === false && <span className="text-xs text-amber-700 dark:text-amber-300">File moved or deleted</span>}
        <span className="ml-auto flex gap-1">
          {exists !== false && task.output.downloadId !== undefined && (
            <button
              type="button"
              onClick={() => {
                showSavedFile(task);
              }}
              aria-label={`Show ${outputFileName(task)} in its folder`}
              className="rounded bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-indigo-500"
            >
              Show in folder
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onRemove(task);
            }}
            aria-label={`Remove ${task.source.title} from the list`}
            title="Removes the entry; the file stays where it is"
            className="rounded px-2 py-0.5 text-xs font-medium text-slate-600 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Remove
          </button>
        </span>
      </div>
    </li>
  );
}

/** Saved videos: file name and size, and a way to find the file. Removing an entry never deletes the file. */
export function CompletedPage({ tasks }: { tasks: DownloadTask[] | null }) {
  const [error, setError] = useState<string | null>(null);
  const completed = completedTasks(tasks ?? []);
  const exists = useSavedFiles(completed.flatMap((task) => (task.output.downloadId !== undefined ? [task.output.downloadId] : [])));
  if (tasks === null) return null;
  if (completed.length === 0) {
    return <EmptyState title="No completed downloads">Videos appear here once they are merged and saved to your Downloads folder.</EmptyState>;
  }
  const total = completed.reduce((sum, task) => sum + (task.output.saved?.bytes ?? 0), 0);
  const remove = (task: DownloadTask) => {
    setError(null);
    sendToBackground('downloads/remove', { taskIds: [task.id] }).catch((cause: unknown) => {
      setError(errorMessage(cause));
    });
  };
  return (
    <div className="flex h-full flex-col">
      <p className="border-b border-slate-200 px-4 py-2 text-xs text-slate-600 tabular-nums dark:border-slate-800 dark:text-slate-300">
        {completed.length} {completed.length === 1 ? 'video' : 'videos'} · {formatBytes(total)}
      </p>
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}
      <ul className="min-h-0 flex-1 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
        {completed.map((task) => (
          <CompletedRow
            key={task.id}
            task={task}
            exists={task.output.downloadId !== undefined ? exists.get(task.output.downloadId) : undefined}
            onRemove={remove}
          />
        ))}
      </ul>
    </div>
  );
}
