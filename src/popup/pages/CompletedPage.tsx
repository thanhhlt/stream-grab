import { useRef, useState } from 'react';
import type { DownloadTask } from '@/core/models/download-task';
import { sendToBackground } from '@/shared/messaging/client';
import { errorMessage } from '@/shared/utils/errors';
import { Badge, ProtocolBadge } from '../components/Badge';
import { BUTTON } from '../components/buttons';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Menu } from '../components/Menu';
import { completedFacts, completedSummary, completedTasks, formatBytes, formatCompletedDate, formatSavedAt, outputFileName } from '../format';
import { useSavedFiles } from '../hooks/useSavedFiles';
import { showSavedFile } from './QueuePage';

function CompletedRow({ task, exists, onRemove }: { task: DownloadTask; exists: boolean | undefined; onRemove: (task: DownloadTask) => void }) {
  const saved = task.output.saved;
  const facts = completedFacts(task);
  const fileName = outputFileName(task);
  const missing = exists === false;
  const savedAt = saved?.savedAt ?? task.updatedAt;
  return (
    <li className="px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/50">
      <p className="truncate text-[13px] leading-5 font-semibold text-slate-900 dark:text-slate-50" title={`${task.source.title}\n${saved?.path ?? fileName}`}>
        {task.source.title}
      </p>
      {facts.fileName && (
        <p className="truncate text-[11px] text-slate-500 dark:text-slate-400" title={saved?.path}>
          Saved as {facts.fileName}
        </p>
      )}
      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-slate-700 tabular-nums dark:text-slate-200">
        <ProtocolBadge protocol={task.source.protocol} container={task.progressive?.container} />
        <span className="truncate">{facts.primary.join(' · ')}</span>
      </p>
      <div className="mt-1 flex items-end gap-2">
        <div className="min-w-0 flex-1 text-[11px] leading-4 text-slate-500 dark:text-slate-400">
          <p className="truncate" title={task.media?.containerReason}>
            {facts.secondary.join(' · ')}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5">
            <span title={formatSavedAt(savedAt)}>{formatCompletedDate(savedAt)}</span>
            {missing && (
              <Badge tone="warning" title="The file is no longer where Chrome saved it (moved, renamed or deleted).">
                File missing
              </Badge>
            )}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          {!missing && task.output.downloadId !== undefined && (
            <button
              type="button"
              onClick={() => {
                showSavedFile(task);
              }}
              aria-label={`Show ${fileName} in its folder`}
              className={BUTTON.primary}
            >
              Show in folder
            </button>
          )}
          <Menu
            label={`More actions for ${task.source.title}`}
            items={[
              {
                label: 'Remove from list',
                title: 'Removes the entry; the file stays where it is',
                onSelect: () => {
                  onRemove(task);
                },
              },
            ]}
          />
        </span>
      </div>
    </li>
  );
}

/**
 * Saved videos: what each file is, its real size, and a way to find it.
 * Removing entries (one, those whose file is missing, or all after a
 * confirmation) never deletes a file.
 */
export function CompletedPage({ tasks }: { tasks: DownloadTask[] | null }) {
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const removeAllButton = useRef<HTMLButtonElement>(null);
  const completed = completedTasks(tasks ?? []);
  const exists = useSavedFiles(completed.flatMap((task) => (task.output.downloadId !== undefined ? [task.output.downloadId] : [])));
  if (tasks === null) return null;
  if (completed.length === 0) {
    return (
      <EmptyState title="No completed downloads" icon="done">
        Videos appear here once they are merged and saved to your Downloads folder.
      </EmptyState>
    );
  }
  const summary = completedSummary(completed, exists);
  const remove = (taskIds: string[]) => {
    setError(null);
    sendToBackground('downloads/remove', { taskIds }).catch((cause: unknown) => {
      setError(errorMessage(cause));
    });
  };
  const missingIds = completed.flatMap((task) =>
    task.output.downloadId !== undefined && exists.get(task.output.downloadId) === false ? [task.id] : [],
  );
  const closeDialog = () => {
    setConfirming(false);
    removeAllButton.current?.focus();
  };
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-slate-200 py-1.5 pr-2 pl-4 text-xs text-slate-600 tabular-nums dark:border-slate-800 dark:text-slate-300">
        <span className="font-semibold text-slate-800 dark:text-slate-100">
          {summary.count} {summary.count === 1 ? 'video' : 'videos'}
        </span>
        <span aria-hidden>·</span>
        <span title="Total size of the saved files">{formatBytes(summary.bytes)}</span>
        <span className="ml-auto flex items-center gap-1">
          {missingIds.length > 0 && (
            <button
              type="button"
              onClick={() => {
                remove(missingIds);
              }}
              title="Removes the entries whose file was moved, renamed or deleted"
              className={`${BUTTON.ghost} text-amber-700 dark:text-amber-300`}
            >
              Remove missing ({missingIds.length})
            </button>
          )}
          <button
            ref={removeAllButton}
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
            title="Removes every entry from this list; the files stay where they are"
            className={BUTTON.ghost}
          >
            Remove all
          </button>
        </span>
      </div>
      {error && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </p>
      )}
      <ul className="min-h-0 flex-1 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
        {completed.map((task) => (
          <CompletedRow
            key={task.id}
            task={task}
            exists={task.output.downloadId !== undefined ? exists.get(task.output.downloadId) : undefined}
            onRemove={(entry) => {
              remove([entry.id]);
            }}
          />
        ))}
      </ul>
      {confirming && (
        <ConfirmDialog
          title="Remove all completed downloads?"
          confirmLabel="Remove all"
          onCancel={closeDialog}
          onConfirm={() => {
            setConfirming(false);
            remove(completed.map((task) => task.id));
          }}
        >
          {summary.count === 1 ? 'The entry is' : `All ${summary.count} entries are`} removed from this list. The saved files stay in
          your Downloads folder.
        </ConfirmDialog>
      )}
    </div>
  );
}
