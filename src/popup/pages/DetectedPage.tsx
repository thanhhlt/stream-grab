import { useLayoutEffect, useRef, useState } from 'react';
import { extensionFor } from '@/core/download/file-name';
import type { DetectedStream } from '@/core/models/detected-stream';
import { sendToBackground } from '@/shared/messaging/client';
import { errorMessage } from '@/shared/utils/errors';
import { parseHttpUrl } from '@/shared/utils/url';
import { EmptyState } from '../components/EmptyState';
import { SelectionBar } from '../components/SelectionBar';
import { StreamCard } from '../components/StreamCard';
import { useActiveTab } from '../hooks/useActiveTab';
import { useDetections } from '../hooks/useDetections';
import { useSettings } from '../hooks/useSettings';
import { streamLabel } from '../format';
import {
  defaultChoice,
  downloadAvailability,
  selectAllState,
  toRequest,
  type StreamChoice,
} from '../selection';

interface DetectedPageProps {
  onShowQueue: () => void;
  /**
   * Gọi sau khi các video đã vào hàng đợi, với ô poster (đang thấy được) của chúng: điểm xuất phát
   * của hiệu ứng gắp. Gọi sau khi React đã vẽ lại để vị trí các ô là vị trí thật.
   */
  onQueued?: (tiles: HTMLElement[]) => void;
}

interface Feedback {
  queued: number;
  failed: number;
}

export function DetectedPage({ onShowQueue, onQueued }: DetectedPageProps) {
  const tab = useActiveTab();
  const tabId = tab.state === 'ready' ? tab.tabId : undefined;
  const detections = useDetections(tabId);
  const { settings, update } = useSettings();

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [choices, setChoices] = useState<Readonly<Record<string, StreamChoice>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  /** Stream vừa vào hàng đợi, chờ lần vẽ tiếp theo để bay (thông báo phía trên làm các dòng dịch xuống). */
  const pendingGrab = useRef<readonly string[] | null>(null);
  useLayoutEffect(() => {
    const ids = pendingGrab.current;
    pendingGrab.current = null;
    const view = list.current;
    if (!ids || !view) return;
    const bounds = view.getBoundingClientRect();
    const tiles = [...view.querySelectorAll<HTMLElement>('[data-stream-id]')]
      .filter((row) => ids.includes(row.dataset.streamId ?? ''))
      .flatMap((row) => {
        const tile = row.querySelector<HTMLElement>('[data-poster]');
        return tile ? [tile] : [];
      })
      // Ô đã cuộn khỏi khung nhìn thì không bay; số đếm vẫn cập nhật.
      .filter((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.bottom > bounds.top && rect.top < bounds.bottom;
      });
    onQueued?.(tiles);
  });

  if (tab.state === 'unavailable') {
    return (
      <EmptyState title="No active tab" icon="off">
        {tab.error}
      </EmptyState>
    );
  }
  if (tab.state === 'loading' || detections.state === 'loading') return null;
  if (detections.state === 'error') {
    return (
      <EmptyState title="Could not read detections" icon="error">
        {detections.error}
      </EmptyState>
    );
  }

  const streams = detections.streams;
  const preference = settings?.preferredResolution ?? 'highest';
  const extension = extensionFor(settings?.outputFormat ?? 'auto');
  const availability = new Map(streams.map((stream) => [stream.id, downloadAvailability(stream)]));
  const selectableIds = streams.filter((stream) => availability.get(stream.id)?.ok).map((stream) => stream.id);
  // Streams that disappeared or became unavailable drop out of the selection by themselves.
  const effectiveSelection = new Set(selectableIds.filter((id) => selected.has(id)));
  // Tiêu đề trùng nhau (vd. nhiều stream của cùng một trang): hiện tên file manifest để phân biệt.
  const labelCounts = new Map<string, number>();
  for (const stream of streams) labelCounts.set(streamLabel(stream), (labelCounts.get(streamLabel(stream)) ?? 0) + 1);
  const choiceOf = (stream: DetectedStream): StreamChoice | undefined =>
    choices[stream.id] ?? defaultChoice(stream, preference);

  const toggle = <T,>(set: ReadonlySet<T>, value: T, include: boolean): Set<T> => {
    const next = new Set(set);
    if (include) next.add(value);
    else next.delete(value);
    return next;
  };

  const startDownloads = (ids: readonly string[]) => {
    const requests = ids.flatMap((id) => {
      const stream = streams.find((candidate) => candidate.id === id);
      const choice = stream ? choiceOf(stream) : undefined;
      return stream && choice ? [toRequest(stream, choice)] : [];
    });
    if (requests.length === 0) return;
    setBusy(true);
    setFeedback(null);
    setActionError(null);
    sendToBackground('downloads/start', { requests })
      .then(
        (result) => {
          const queuedIds = new Set(result.created.map((entry) => entry.streamId));
          setFailures((previous) => {
            const next = { ...previous };
            for (const id of ids) delete next[id];
            for (const failure of result.failed) next[failure.streamId] = failure.message;
            return next;
          });
          setSelected((previous) => new Set([...previous].filter((id) => !queuedIds.has(id))));
          setExpanded((previous) => new Set([...previous].filter((id) => !queuedIds.has(id))));
          setFeedback({ queued: result.created.length, failed: result.failed.length });
          if (result.created.length > 0) pendingGrab.current = result.created.map((entry) => entry.streamId);
        },
        (error: unknown) => {
          setActionError(errorMessage(error));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  const run = (action: Promise<unknown>) => {
    setActionError(null);
    action.catch((error: unknown) => {
      setActionError(errorMessage(error));
    });
  };
  const remove = (stream: DetectedStream) => {
    run(sendToBackground('detections/remove', { tabId: tab.tabId, streamId: stream.id }));
  };
  const clear = () => {
    setSelected(new Set());
    run(sendToBackground('detections/clear', { tabId: tab.tabId }));
  };

  const detectionOff = settings?.autoDetect === false;
  const httpPage = tab.url === undefined || parseHttpUrl(tab.url) !== null;

  return (
    <div className="flex h-full flex-col">
      {detectionOff && (
        <div className="mx-3 mt-2 flex items-center gap-3 rounded-field bg-warning-surface px-3 py-2 text-meta text-warning">
          <span className="flex-1">Automatic detection is off. New streams are not being detected.</span>
          <button
            type="button"
            onClick={() => {
              update({ autoDetect: true });
            }}
            className="cursor-pointer font-semibold underline-offset-2 hover:underline"
          >
            Turn on
          </button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="mx-3 mt-2 rounded-field bg-danger-surface px-3 py-2 text-meta text-danger">
          {actionError}
        </p>
      )}
      {feedback && (
        <div
          role="status"
          className="mx-3 mt-2 flex items-center gap-3 rounded-field bg-success-surface px-3 py-2 text-meta text-success"
        >
          <span className="flex-1">
            {feedback.queued > 0 && `${feedback.queued} ${feedback.queued === 1 ? 'download' : 'downloads'} queued.`}
            {feedback.failed > 0 && ` ${feedback.failed} could not be queued; see the reason below.`}
          </span>
          {feedback.queued > 0 && (
            <button type="button" onClick={onShowQueue} className="cursor-pointer font-semibold underline-offset-2 hover:underline">
              View queue
            </button>
          )}
        </div>
      )}

      {streams.length === 0 ? (
        httpPage ? (
          <EmptyState title="No streams detected on this page yet" icon="search">
            Start playing a video. Supported streams appear here as soon as the page loads them.
          </EmptyState>
        ) : (
          <EmptyState title="Nothing to detect here" icon="off">Streams can only be detected on http and https pages.</EmptyState>
        )
      ) : (
        <>
          <SelectionBar
            total={streams.length}
            selectable={selectableIds.length}
            selected={effectiveSelection.size}
            state={selectAllState(selectableIds, effectiveSelection)}
            onSelectAll={(select) => {
              setSelected(select ? new Set(selectableIds) : new Set());
            }}
            onDownload={() => {
              startDownloads([...effectiveSelection]);
            }}
            onClear={clear}
            busy={busy}
          />
          <ul ref={list} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-2">
            {streams.map((stream) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                availability={availability.get(stream.id) ?? { ok: false, reason: '' }}
                selected={effectiveSelection.has(stream.id)}
                onSelect={(include) => {
                  setSelected((previous) => toggle(previous, stream.id, include));
                }}
                choice={choiceOf(stream)}
                onChoiceChange={(choice) => {
                  setChoices((previous) => ({ ...previous, [stream.id]: choice }));
                }}
                expanded={expanded.has(stream.id)}
                onToggleExpanded={() => {
                  setExpanded((previous) => toggle(previous, stream.id, !previous.has(stream.id)));
                }}
                extension={stream.progressive ? `.${stream.progressive.container}` : extension}
                onDownload={() => {
                  startDownloads([stream.id]);
                }}
                busy={busy}
                error={failures[stream.id]}
                onRemove={remove}
                showSource={(labelCounts.get(streamLabel(stream)) ?? 0) > 1}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
