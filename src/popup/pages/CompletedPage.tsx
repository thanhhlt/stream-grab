import { useRef, useState } from 'react';
import type { DownloadTask } from '@/core/models/download-task';
import { sendToBackground } from '@/shared/messaging/client';
import { errorMessage } from '@/shared/utils/errors';
import { hostnameOf } from '@/shared/utils/url';
import { Badge, ProtocolBadge } from '../components/Badge';
import { BUTTON } from '../components/buttons';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { Menu } from '../components/Menu';
import { PosterTile } from '../components/PosterTile';
import { completedFacts, completedSummary, completedTasks, formatBytes, formatCompletedDate, formatSavedAt, outputFileName } from '../format';
import { useSavedFiles } from '../hooks/useSavedFiles';
import { showSavedFile } from './QueuePage';

function CompletedRow({ task, exists, onRemove }: { task: DownloadTask; exists: boolean | undefined; onRemove: (task: DownloadTask) => void }) {
  const saved = task.output.saved;
  const facts = completedFacts(task);
  const fileName = outputFileName(task);
  const missing = exists === false;
  const savedAt = saved?.savedAt ?? task.updatedAt;
  const host = hostnameOf(task.source.pageUrl) || hostnameOf(task.source.manifestUrl);
  return (
    <li className="flex gap-2.5 px-4 pt-2.5 pb-3">
      {/* File đã mất thì không có dấu tích "đã lưu"; chip "File missing" nói rõ. */}
      <PosterTile host={host} state={missing ? 'play' : 'done'} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-title text-ink" title={`${task.source.title}\n${saved?.path ?? fileName}`}>
          {task.source.title}
        </p>
        {facts.fileName && (
          <p className="mt-0.5 truncate text-meta text-muted" title={saved?.path}>
            Saved as {facts.fileName}
          </p>
        )}
        <p className="mt-1 truncate text-control text-ink tabular-nums">
          <ProtocolBadge protocol={task.source.protocol} container={task.progressive?.container} />
          {facts.primary.length > 0 && ` · ${facts.primary.join(' · ')}`}
        </p>
        {facts.secondary.length > 0 && (
          <p className="truncate text-tech text-muted" title={task.media?.containerReason}>
            {facts.secondary.join(' · ')}
          </p>
        )}
        <div className="mt-1 flex items-center gap-2">
          <p className="flex min-w-0 flex-1 items-center gap-1.5 text-tech text-muted">
            <span className="truncate" title={formatSavedAt(savedAt)}>
              {formatCompletedDate(savedAt)}
            </span>
            {missing && (
              <Badge tone="warning" title="The file is no longer where Chrome saved it (moved, renamed or deleted).">
                File missing
              </Badge>
            )}
          </p>
          <span className="flex shrink-0 items-center gap-1">
            {!missing && task.output.downloadId !== undefined && (
              <button
                type="button"
                onClick={() => {
                  showSavedFile(task);
                }}
                aria-label={`Show ${fileName} in its folder`}
                className={BUTTON.download}
              >
                <Icon name="download" />
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
      <div className="flex items-center gap-1.5 py-[9px] pr-2 pl-4 text-muted tabular-nums">
        <span className="font-bold text-ink">
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
              className={BUTTON.ghost}
            >
              <span className="text-warning">Remove missing ({missingIds.length})</span>
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
        <p role="alert" className="mx-3 mb-1 rounded-field bg-danger-surface px-3 py-2 text-meta text-danger">
          {error}
        </p>
      )}
      <ul className="min-h-0 flex-1 overflow-y-auto pb-1">
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
