import { useState, type ReactNode } from 'react';
import { DEFAULT_RESERVE_BYTES } from '@/core/download/storage-space';
import type { DownloadTask, TaskStatus } from '@/core/models/download-task';
import { sendToBackground } from '@/shared/messaging/client';
import { errorMessage } from '@/shared/utils/errors';
import { hostnameOf } from '@/shared/utils/url';
import { Badge, ProtocolBadge } from '../components/Badge';
import { BUTTON } from '../components/buttons';
import { EmptyState } from '../components/EmptyState';
import { Icon } from '../components/Icon';
import { PosterTile } from '../components/PosterTile';
import { ProgressBar } from '../components/ProgressBar';
import {
  downloadStats,
  type DownloadStats,
  formatBytes,
  formatSpeed,
  mediaSummary,
  outputFileName,
  overallProgress,
  PHASE_VIEW,
  processingLine,
  processingStageLabel,
  type StatusView,
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

/** Retry là hành động chính (nền cam); Show in folder là nút tải viền cam; còn lại là nút viền. */
function actionClass(action: Action): string {
  if (action === 'retry') return BUTTON.primary;
  if (action === 'show') return BUTTON.download;
  return BUTTON.secondary;
}

/** Opens the folder of a saved file, with the file selected (no permission beyond "downloads" needed). */
export function showSavedFile(task: DownloadTask): void {
  if (task.output.downloadId !== undefined) chrome.downloads.show(task.output.downloadId);
}

function Actions({ task, onAction }: { task: DownloadTask; onAction: (task: DownloadTask, action: Action) => void }) {
  return (
    <span className="ml-auto flex shrink-0 gap-1.5">
      {actionsFor(task.status).map((action) => (
        <button
          key={action}
          type="button"
          onClick={() => {
            onAction(task, action);
          }}
          aria-label={`${ACTION_LABELS[action]} ${task.source.title}`}
          className={actionClass(action)}
        >
          {action === 'show' && <Icon name="download" />}
          {ACTION_LABELS[action]}
        </button>
      ))}
    </span>
  );
}

/** Một ô số liệu: nhãn mờ + giá trị. */
function Stat({ label, children, title }: { label?: string; children: ReactNode; title?: string | undefined }) {
  return (
    <span title={title}>
      {label && <span className="text-muted">{label} </span>}
      <span className="text-ink">{children}</span>
    </span>
  );
}

/** Nối các phần của dòng kỹ thuật bằng " · " (bỏ phần trống); chỉ xuống dòng giữa các phần. */
function joined(parts: ReactNode[]): ReactNode[] {
  return parts.filter(Boolean).flatMap((part, index) => {
    const item = (
      // Thứ tự các phần cố định: chỉ số làm key được.
      <span key={index} className="whitespace-nowrap">
        {part}
      </span>
    );
    return index === 0 ? [item] : [' · ', item];
  });
}

/**
 * Tiến độ tải mạng: thanh, rồi phần trăm + ETA + tốc độ, rồi dòng kỹ thuật (segment, dung lượng).
 * Không có `stats`: đang đọc danh sách segment, hoặc tiến độ mang từ lần chạy trước chưa được xác nhận.
 */
function DownloadBody({ task, stats, actions }: { task: DownloadTask; stats: DownloadStats | undefined; actions: ReactNode }) {
  if (!stats) {
    return (
      <div className="mt-1.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-control text-muted">{taskProgressLine(task)}</p>
        {actions}
      </div>
    );
  }
  return (
    <>
      <div className="mt-2">
        <ProgressBar percent={stats.percent} kind={stats.stalled ? 'stalled' : 'download'} label={`Download progress of ${task.source.title}`} />
      </div>
      <div className="mt-1.5 flex items-center gap-2.5 text-control tabular-nums">
        <span className="text-percent text-ink">{stats.percent.toFixed(1)}%</span>
        <span className="min-w-0 flex-1 truncate" title={stats.note}>
          <Stat label="ETA">{stats.eta ?? '—'}</Stat>
          <span className="text-muted"> · </span>
          {/* Đơn vị (MB/s) đã nói đây là tốc độ; nhãn chỉ dành cho trình đọc màn hình, để chừa chỗ. */}
          <span className="sr-only">Speed </span>
          <span className="text-muted">{stats.speed}</span>
        </span>
        {actions}
      </div>
      <p className="mt-1 text-tech text-muted tabular-nums">
        {joined([
          // A progressive file (0.3.0) has no segments to count.
          task.progressive ? undefined : stats.segments,
          stats.reused && (
            <span key="reused" title={`${stats.reused} from an earlier run`}>
              {stats.reused}
            </span>
          ),
          <span key="size" title={stats.note}>
            {stats.size}
          </span>,
          stats.remaining && (
            <span key="remaining" title={stats.note}>
              Remaining {stats.remaining}
            </span>
          ),
          stats.retries && (
            <span key="retries" className="text-warning">
              {stats.retries}
            </span>
          ),
        ])}
      </p>
    </>
  );
}

/** Xử lý FFmpeg, tách khỏi tiến độ tải: thanh riêng của FFmpeg, bước đang chạy, rồi "đã tải xong". */
function ProcessingBody({ task, actions }: { task: DownloadTask; actions: ReactNode }) {
  const progress = task.progress;
  const waiting = task.status === 'downloaded';
  const percent = waiting ? 0 : (task.processing?.percent ?? 0);
  return (
    <>
      <div className="mt-2">
        <ProgressBar percent={percent} kind="processing" label={`Processing progress of ${task.source.title}`} />
      </div>
      <div className="mt-1.5 flex items-center gap-2.5 text-control">
        <span className="min-w-0 flex-1 truncate text-muted" title={processingLine(task.processing)}>
          {waiting ? 'Waiting for FFmpeg' : processingStageLabel(task.processing)}
        </span>
        {/* Đứng trước trên màn hình, sau tên bước trong DOM ("Merging tracks, 63%"). */}
        {!waiting && task.processing && <span className="order-first text-percent text-ink tabular-nums">{percent}%</span>}
        {actions}
      </div>
      {progress && progress.segmentsTotal > 0 && (
        <p className="mt-1 flex items-center gap-1 text-tech text-muted tabular-nums">
          <Icon name="tick" className="size-3.5 text-success" />
          Downloaded · {progress.segmentsTotal} segments · {formatBytes(progress.bytes)}
        </p>
      )}
      <p className="text-tech text-muted">
        {task.media ? <span title={task.media.containerReason}>{mediaSummary(task.media)}</span> : <span>{processingLine(task.processing)}</span>}
      </p>
    </>
  );
}

function TaskRow({ task, now, onAction }: { task: DownloadTask; now: number; onAction: (task: DownloadTask, action: Action) => void }) {
  const phase = taskPhase(task.status);
  const actions = <Actions task={task} onAction={onAction} />;
  const tooltip = `${task.source.title}\nFile: ${outputFileName(task)}`;
  const host = hostnameOf(task.source.pageUrl) || hostnameOf(task.source.manifestUrl);
  const meta = taskMeta(task);
  const progress = task.progress;
  const stats =
    phase === 'downloading' && progress?.segmentsTotal && !progress.stale ? downloadStats(progress, { now, reportedAt: task.updatedAt }) : undefined;
  // Trạng thái luôn có chữ (màu không bao giờ là tín hiệu duy nhất); đứng yên thì "Stalled".
  const view: StatusView = stats?.stalled ? { label: 'Stalled', tone: 'warning' } : PHASE_VIEW[phase];
  const attention = phase === 'failed' || phase === 'cancelled';

  let body: ReactNode;
  if (phase === 'downloading') body = <DownloadBody task={task} stats={stats} actions={actions} />;
  else if (phase === 'processing') body = <ProcessingBody task={task} actions={actions} />;
  else if (attention) body = <div className="mt-2 flex justify-end">{actions}</div>;
  else {
    body = (
      <div className="mt-1.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-control text-muted tabular-nums">{taskProgressLine(task)}</p>
        {actions}
      </div>
    );
  }

  return (
    <li className="flex gap-2.5 px-4 pt-2.5 pb-3">
      <PosterTile host={host} state={phase === 'failed' ? 'failed' : phase === 'completed' ? 'done' : 'play'} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-title text-ink" title={tooltip}>
          {task.source.title}
        </p>
        <p className="mt-0.5 flex min-w-0 items-center gap-2 text-meta text-muted">
          <span className="min-w-0 flex-1 truncate">
            <ProtocolBadge protocol={task.source.protocol} container={task.progressive?.container} />
            {meta && ` · ${meta}`}
          </span>
          <Badge tone={view.tone}>{view.label}</Badge>
        </p>
        {/* Lý do lỗi đứng ngay dưới dòng tên, trước Retry/Remove. */}
        {attention && task.statusMessage && (
          <p className={`mt-2 rounded-field px-2.5 py-[7px] text-meta ${phase === 'failed' ? 'bg-danger-surface text-danger' : 'bg-surface text-muted'}`}>
            {task.statusMessage}
          </p>
        )}
        {body}
        {!attention && task.statusMessage && phase !== 'processing' && <p className="mt-1.5 text-meta text-muted">{task.statusMessage}</p>}
      </div>
    </li>
  );
}

/** Overall progress across running downloads. */
function Summary({ tasks }: { tasks: DownloadTask[] }) {
  const { running, percent, bytesPerSecond } = overallProgress(tasks);
  if (running === 0) return null;
  return (
    <div className="mx-3 mt-2 mb-1.5 rounded-row bg-surface px-3.5 py-3">
      <p className="mb-2 flex justify-between gap-3 tabular-nums">
        <span className="min-w-0 truncate">
          <span className="font-bold text-ink">
            Downloading {running} {running === 1 ? 'video' : 'videos'}
          </span>
          <span className="text-muted"> · {percent === undefined ? 'preparing' : `${percent.toFixed(1)}%`}</span>
        </span>
        <span className="shrink-0 text-muted">{formatSpeed(bytesPerSecond)}</span>
      </p>
      <ProgressBar percent={percent ?? 0} label="Overall download progress" className="bg-bg" />
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
      className={`border-t border-line px-4 py-2 text-meta tabular-nums ${line.low ? 'bg-warning-surface text-warning' : 'text-muted'}`}
    >
      {line.text}
    </p>
  );
}

function SectionHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-[34px] items-center pt-2 pr-2 pl-4">
      <h2 className="font-bold text-muted">{title}</h2>
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
    <ul>
      {list.map((task) => (
        <TaskRow key={task.id} task={task} now={now} onAction={act} />
      ))}
    </ul>
  );

  return (
    <div className="flex h-full flex-col">
      <Summary tasks={tasks} />
      {error && (
        <p role="alert" className="mx-3 mt-2 flex items-start gap-2 rounded-field bg-danger-surface py-2 pr-1.5 pl-3 text-meta text-danger">
          <span className="flex-1 py-0.5">{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
            }}
            aria-label="Dismiss error"
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-full hover:bg-bg"
          >
            <Icon name="close" className="size-3.5" />
          </button>
        </p>
      )}
      {inQueue.length === 0 && attention.length === 0 && finished.length === 0 ? (
        <EmptyState title="No downloads" icon="queue">
          Select videos on the Detected tab and press Download.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-1">
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
