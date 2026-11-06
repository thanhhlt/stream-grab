import { useState, type ReactNode } from 'react';
import { DEFAULT_RESERVE_BYTES } from '@/core/download/storage-space';
import type { DownloadTask, TaskStatus } from '@/core/models/download-task';
import { sendToBackground } from '@/shared/messaging/client';
import { errorMessage } from '@/shared/utils/errors';
import { Badge, ProtocolBadge } from '../components/Badge';
import { BUTTON } from '../components/buttons';
import { EmptyState } from '../components/EmptyState';
import { ProgressBar } from '../components/ProgressBar';
import {
  downloadStats,
  formatBytes,
  formatSpeed,
  mediaSummary,
  outputFileName,
  overallProgress,
  PHASE_VIEW,
  processingLine,
  processingStageLabel,
  storageLine,
  taskMeta,
  taskPhase,
  taskProgressLine,
} from '../format';
import { useNow } from '../hooks/useNow';
import { useSettings } from '../hooks/useSettings';
import { useStorageEstimate } from '../hooks/useStorageEstimate';

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
const PRIMARY_ACTIONS: readonly Action[] = ['retry', 'show'];

/** Opens the folder of a saved file, with the file selected (no permission beyond "downloads" needed). */
export function showSavedFile(task: DownloadTask): void {
  if (task.output.downloadId !== undefined) chrome.downloads.show(task.output.downloadId);
}

function Actions({ task, onAction }: { task: DownloadTask; onAction: (task: DownloadTask, action: Action) => void }) {
  return (
    <span className="ml-auto flex shrink-0 gap-1.5 self-end">
      {actionsFor(task.status).map((action) => (
        <button
          key={action}
          type="button"
          onClick={() => {
            onAction(task, action);
          }}
          aria-label={`${ACTION_LABELS[action]} ${task.source.title}`}
          className={PRIMARY_ACTIONS.includes(action) ? BUTTON.primary : BUTTON.secondary}
        >
          {ACTION_LABELS[action]}
        </button>
      ))}
    </span>
  );
}

/** Một ô số liệu: nhãn mờ + giá trị. */
function Stat({ label, children, title }: { label?: string; children: ReactNode; title?: string | undefined }) {
  return (
    <span className="truncate" title={title}>
      {label && <span className="text-slate-500 dark:text-slate-400">{label} </span>}
      <span className="text-slate-700 dark:text-slate-200">{children}</span>
    </span>
  );
}

/** Tiến độ tải mạng: phần trăm, segment, dung lượng, tốc độ, ETA. */
function DownloadBody({ task, now, actions }: { task: DownloadTask; now: number; actions: ReactNode }) {
  const progress = task.progress;
  const line = taskProgressLine(task);
  // Đang đọc danh sách segment, hoặc tiến độ mang từ lần chạy trước chưa được engine xác nhận.
  if (!progress?.segmentsTotal || progress.stale) {
    return (
      <div className="mt-1.5 flex items-end gap-2">
        <p className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-300">
          <Badge tone="progress">Downloading</Badge> <span className="align-middle">{line}</span>
        </p>
        {actions}
      </div>
    );
  }
  const stats = downloadStats(progress, { now, reportedAt: task.updatedAt });
  return (
    <>
      <div className="mt-2 mb-1 flex items-center justify-between text-xs">
        <Badge tone={stats.stalled ? 'warning' : 'progress'}>{stats.stalled ? 'Stalled' : 'Downloading'}</Badge>
        <span className="font-semibold text-slate-800 tabular-nums dark:text-slate-100">{stats.percent.toFixed(1)}%</span>
      </div>
      <ProgressBar percent={stats.percent} label={`Download progress of ${task.source.title}`} />
      <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px] leading-4 tabular-nums">
        {/* A progressive file (0.3.0) has no segments to count: the cell stays empty. */}
        <Stat title={stats.reused ? `${stats.reused} from an earlier run` : undefined}>
          {task.progressive ? '' : stats.segments}
          {stats.reused && <span className="text-slate-500 dark:text-slate-400"> · {stats.reused}</span>}
        </Stat>
        <span className="truncate text-right" title={stats.note}>
          <Stat>{stats.size}</Stat>
        </span>
        <Stat label="Speed">{stats.speed}</Stat>
        <span className="truncate text-right" title={stats.note}>
          {stats.remaining && <Stat label="Remaining">{stats.remaining}</Stat>}
        </span>
        <span className="col-span-2 flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            {stats.eta ? <Stat label="ETA">{stats.eta}</Stat> : <Stat label="ETA">—</Stat>}
            {stats.retries && <span className="text-amber-700 dark:text-amber-300"> · {stats.retries}</span>}
          </span>
          {actions}
        </span>
      </div>
    </>
  );
}

/** Xử lý FFmpeg, tách khỏi tiến độ tải: dòng "đã tải xong" + thanh tiến độ riêng của FFmpeg. */
function ProcessingBody({ task, actions }: { task: DownloadTask; actions: ReactNode }) {
  const progress = task.progress;
  const waiting = task.status === 'downloaded';
  const percent = waiting ? 0 : (task.processing?.percent ?? 0);
  return (
    <>
      {progress && progress.segmentsTotal > 0 && (
        <p className="mt-1.5 text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
          <span className="text-emerald-600 dark:text-emerald-400" aria-hidden>
            ✓{' '}
          </span>
          Downloaded · {progress.segmentsTotal} segments · {formatBytes(progress.bytes)}
        </p>
      )}
      <div className="mt-1.5 mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5">
          <Badge tone="accent">Processing</Badge>
          <span className="truncate text-slate-600 dark:text-slate-300" title={processingLine(task.processing)}>
            {waiting ? 'Waiting for FFmpeg' : processingStageLabel(task.processing)}
          </span>
        </span>
        {!waiting && task.processing && <span className="font-semibold text-slate-800 tabular-nums dark:text-slate-100">{percent}%</span>}
      </div>
      <ProgressBar percent={percent} kind="processing" label={`Processing progress of ${task.source.title}`} />
      <div className="mt-1.5 flex items-end gap-2">
        <p className="min-w-0 flex-1 text-[11px] text-slate-500 dark:text-slate-400">
          {task.media ? (
            <span title={task.media.containerReason}>{mediaSummary(task.media)}</span>
          ) : (
            <span>{processingLine(task.processing)}</span>
          )}
        </p>
        {actions}
      </div>
    </>
  );
}

function TaskRow({ task, now, onAction }: { task: DownloadTask; now: number; onAction: (task: DownloadTask, action: Action) => void }) {
  const phase = taskPhase(task.status);
  const view = PHASE_VIEW[phase];
  const actions = <Actions task={task} onAction={onAction} />;
  const tooltip = `${task.source.title}\nFile: ${outputFileName(task)}`;
  const line = taskProgressLine(task);

  let body: ReactNode;
  if (phase === 'downloading') body = <DownloadBody task={task} now={now} actions={actions} />;
  else if (phase === 'processing') body = <ProcessingBody task={task} actions={actions} />;
  else {
    body = (
      <div className="mt-1.5 flex items-end gap-2">
        <p className="min-w-0 flex-1 text-xs leading-5 text-slate-600 tabular-nums dark:text-slate-300">
          <Badge tone={view.tone}>{view.label}</Badge> {line && <span className="align-middle">{line}</span>}
        </p>
        {actions}
      </div>
    );
  }

  return (
    <li className="px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900/50">
      <p className="truncate text-[13px] leading-5 font-semibold text-slate-900 dark:text-slate-50" title={tooltip}>
        {task.source.title}
      </p>
      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
        <ProtocolBadge protocol={task.source.protocol} container={task.progressive?.container} />
        <span className="truncate">{taskMeta(task)}</span>
      </p>
      {body}
      {task.statusMessage && phase !== 'processing' && (
        <p
          className={`mt-1.5 rounded px-2 py-1 text-xs leading-snug ${
            task.status === 'failed'
              ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
              : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          {task.statusMessage}
        </p>
      )}
    </li>
  );
}

/** Overall progress across running downloads. */
function Summary({ tasks }: { tasks: DownloadTask[] }) {
  const { running, percent, bytesPerSecond } = overallProgress(tasks);
  if (running === 0) return null;
  return (
    <div className="border-b border-slate-200 px-4 py-2 text-xs dark:border-slate-800">
      <p className="mb-1 flex justify-between text-slate-600 tabular-nums dark:text-slate-300">
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
        line.low ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200' : 'text-slate-500 dark:text-slate-400'
      }`}
    >
      {line.text}
    </p>
  );
}

function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center border-y border-slate-200 bg-slate-50 px-4 py-1 dark:border-slate-800 dark:bg-slate-900/70">
      <h2 className="text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{title}</h2>
      {children}
    </div>
  );
}

const IN_QUEUE: readonly TaskStatus[] = ['processing', 'downloading', 'downloaded', 'queued'];
const ATTENTION: readonly TaskStatus[] = ['failed', 'cancelled'];

export function QueuePage({ tasks }: { tasks: DownloadTask[] | null }) {
  const [error, setError] = useState<string | null>(null);
  const { settings } = useSettings();
  // Mỗi giây khi có lượt tải đang chạy: nhận ra lượt tải đứng yên dù engine không báo gì.
  const now = useNow(1000, tasks?.some((task) => task.status === 'downloading') ?? false);
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
  const rows = (list: DownloadTask[]) => (
    <ul className="divide-y divide-slate-200 dark:divide-slate-800">
      {list.map((task) => (
        <TaskRow key={task.id} task={task} now={now} onAction={act} />
      ))}
    </ul>
  );

  return (
    <div className="flex h-full flex-col">
      <Summary tasks={tasks} />
      {error && (
        <p role="alert" className="flex items-start gap-2 bg-red-50 px-4 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
            }}
            aria-label="Dismiss error"
            className="font-semibold hover:underline"
          >
            ×
          </button>
        </p>
      )}
      {inQueue.length === 0 && attention.length === 0 && finished.length === 0 ? (
        <EmptyState title="No downloads" icon="queue">
          Select videos on the Detected tab and press Download.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {rows(inQueue)}
          {finished.length > 0 && (
            <>
              <SectionHeader title="Finished">
                <button
                  type="button"
                  onClick={() => {
                    send('dismiss', finished.map((task) => task.id));
                  }}
                  className={`${BUTTON.link} ml-auto`}
                >
                  Clear all
                </button>
              </SectionHeader>
              {rows(finished)}
            </>
          )}
          {attention.length > 0 && (
            <>
              <SectionHeader title="Failed or cancelled">
                {/* E.g. after freeing disk space: every failed download continues where it stopped. */}
                {failed.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      send('retry', failed.map((task) => task.id));
                    }}
                    className={`${BUTTON.link} ml-auto`}
                  >
                    Retry all failed ({failed.length})
                  </button>
                )}
              </SectionHeader>
              {rows(attention)}
            </>
          )}
        </div>
      )}
      <StorageFooter tasks={tasks} />
    </div>
  );
}
