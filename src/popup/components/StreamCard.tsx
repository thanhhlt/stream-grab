import type { DetectedStream } from '@/core/models/detected-stream';
import { fileNameOf, hostnameOf } from '@/shared/utils/url';
import { formatDuration, mediaFacts, statusView, streamLabel, streamTags, variantLabel } from '../format';
import type { Availability, StreamChoice } from '../selection';
import { Badge } from './Badge';
import { StreamOptions } from './StreamOptions';

interface StreamCardProps {
  stream: DetectedStream;
  availability: Availability;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  choice: StreamChoice | undefined;
  onChoiceChange: (choice: StreamChoice) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  extension: string;
  onDownload: () => void;
  busy: boolean;
  /** Why the last attempt to queue this video failed. */
  error: string | undefined;
  onRemove: (stream: DetectedStream) => void;
}

/** "1080p · English" — what Download would fetch right now. */
function choiceSummary(stream: DetectedStream, choice: StreamChoice): string {
  const variant = stream.media?.variants.find((candidate) => candidate.id === choice.variantId);
  const tracks = (stream.media?.audioTracks ?? []).filter((track) => choice.audioTrackIds.includes(track.id));
  return [variant ? variantLabel(variant) : undefined, ...tracks.map((track) => track.name)].filter(Boolean).join(' · ');
}

export function StreamCard(props: StreamCardProps) {
  const { stream, availability, selected, choice, expanded, error } = props;
  const status = statusView(stream);
  const label = streamLabel(stream);
  const site = hostnameOf(stream.pageUrl) || hostnameOf(stream.url);
  const file = fileNameOf(stream.url);
  const facts = mediaFacts(stream);
  const details = [site, file !== label ? file : '', facts.durationSec ? formatDuration(facts.durationSec) : '']
    .filter(Boolean)
    .join(' · ');
  const technical = [facts.codecs, facts.audio].filter(Boolean).join(' · ');
  const reason = availability.ok ? undefined : availability.reason;
  const checkboxId = `select-${stream.id}`;

  return (
    <li className={`flex gap-2.5 px-4 py-3 ${selected ? 'bg-indigo-50/60 dark:bg-indigo-950/30' : ''}`}>
      <input
        id={checkboxId}
        type="checkbox"
        checked={selected}
        disabled={!availability.ok}
        title={reason ?? 'Select for download'}
        aria-label={`Select ${label}`}
        onChange={(event) => {
          props.onSelect(event.currentTarget.checked);
        }}
        className="mt-1 size-4 shrink-0 accent-indigo-600 disabled:opacity-40"
      />
      <span
        className="mt-0.5 w-11 shrink-0 self-start rounded bg-indigo-50 py-0.5 text-center text-[11px] font-semibold tracking-wide text-indigo-700 uppercase dark:bg-indigo-950 dark:text-indigo-300"
        title={stream.protocol === 'hls' ? 'HTTP Live Streaming' : 'MPEG-DASH'}
      >
        {stream.protocol}
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor={checkboxId} className="line-clamp-2 font-medium break-words" title={label}>
          {label}
        </label>
        {details && <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{details}</p>}
        {facts.qualities && (
          <p className="mt-1 text-xs font-medium text-slate-700 dark:text-slate-300" title="Available qualities">
            {facts.qualities}
          </p>
        )}
        {technical && (
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400" title={technical}>
            {technical}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <Badge tone={status.tone}>{status.label}</Badge>
          {streamTags(stream).map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
          {availability.ok && choice && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={props.onToggleExpanded}
              className="ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300 dark:hover:bg-indigo-950"
            >
              {choiceSummary(stream, choice)} {expanded ? '▴' : '▾'}
            </button>
          )}
        </div>
        {stream.statusMessage && (
          <p className="mt-1 text-xs leading-snug text-slate-600 dark:text-slate-400">{stream.statusMessage}</p>
        )}
        {stream.status === 'ready' && stream.manifest?.live && (
          <p className="mt-1 text-xs leading-snug text-slate-600 dark:text-slate-400">
            Live stream: downloading live streams is not supported yet.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs leading-snug text-red-700 dark:text-red-300">
            {error}
          </p>
        )}
        {expanded && availability.ok && choice && (
          <StreamOptions
            stream={stream}
            choice={choice}
            onChange={props.onChoiceChange}
            extension={props.extension}
            onDownload={props.onDownload}
            busy={props.busy}
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => {
          props.onRemove(stream);
        }}
        aria-label={`Remove ${label}`}
        title="Remove from list"
        className="size-6 shrink-0 rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        ×
      </button>
    </li>
  );
}
