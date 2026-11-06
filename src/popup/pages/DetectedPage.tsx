import { useState } from 'react';
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
}

interface Feedback {
  queued: number;
  failed: number;
}

export function DetectedPage({ onShowQueue }: DetectedPageProps) {
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
        <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="flex-1">Automatic detection is off. New streams are not being detected.</span>
          <button
            type="button"
            onClick={() => {
              update({ autoDetect: true });
            }}
            className="font-semibold underline-offset-2 hover:underline"
          >
            Turn on
          </button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="bg-red-50 px-4 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {actionError}
        </p>
      )}
      {feedback && (
        <div
          role="status"
          className="flex items-center gap-3 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
        >
          <span className="flex-1">
            {feedback.queued > 0 && `${feedback.queued} ${feedback.queued === 1 ? 'download' : 'downloads'} queued.`}
            {feedback.failed > 0 && ` ${feedback.failed} could not be queued; see the reason below.`}
          </span>
          {feedback.queued > 0 && (
            <button type="button" onClick={onShowQueue} className="font-semibold underline-offset-2 hover:underline">
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
          <ul className="min-h-0 flex-1 divide-y divide-slate-200 overflow-y-auto dark:divide-slate-800">
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
                extension={extension}
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
