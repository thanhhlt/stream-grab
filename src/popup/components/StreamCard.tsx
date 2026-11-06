import type { DetectedStream } from '@/core/models/detected-stream';
import { fileNameOf, hostnameOf } from '@/shared/utils/url';
import { formatDuration, mediaFacts, qualityOptions, statusView, streamLabel, streamTags } from '../format';
import { withVariant, type Availability, type StreamChoice } from '../selection';
import { Badge, ProtocolBadge } from './Badge';
import { BUTTON } from './buttons';
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
  /** Hiện tên file manifest: chỉ khi một stream khác trong danh sách có cùng tiêu đề (để phân biệt). */
  showSource: boolean;
}

/** "English", "English, Français" hoặc "No audio track": audio sẽ tải theo lựa chọn hiện tại. */
function audioSummary(stream: DetectedStream, choice: StreamChoice): string {
  const names = (stream.media?.audioTracks ?? []).filter((track) => choice.audioTrackIds.includes(track.id)).map((track) => track.name);
  return names.length > 0 ? [...new Set(names)].join(', ') : 'No audio track';
}

export function StreamCard(props: StreamCardProps) {
  const { stream, availability, selected, choice, expanded, error } = props;
  const status = statusView(stream);
  const label = streamLabel(stream);
  const site = hostnameOf(stream.pageUrl) || hostnameOf(stream.url);
  const file = fileNameOf(stream.url);
  const facts = mediaFacts(stream);
  const meta = [site, props.showSource && file !== label ? file : '', facts.durationSec ? formatDuration(facts.durationSec) : '']
    .filter(Boolean)
    .join(' · ');
  const reason = availability.ok ? undefined : availability.reason;
  const checkboxId = `select-${stream.id}`;
  const variants = stream.media?.variants ?? [];
  const variant = variants.find((candidate) => candidate.id === choice?.variantId);
  const audioTracks = (stream.media?.audioTracks ?? []).filter((track) => variant?.audioTrackIds.includes(track.id));
  const optionsId = `opt-${stream.id}`;
  const ready = availability.ok && choice !== undefined;

  return (
    <li
      className={`relative flex gap-2.5 py-3 pr-3 pl-4 transition-colors ${
        selected
          ? 'bg-indigo-50/70 shadow-[inset_3px_0_0_var(--color-indigo-500)] dark:bg-indigo-500/10'
          : 'hover:bg-slate-50 dark:hover:bg-slate-900/50'
      }`}
    >
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
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-40 dark:accent-indigo-400"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-1">
          <label
            htmlFor={checkboxId}
            className="line-clamp-2 min-w-0 flex-1 cursor-pointer text-[13px] leading-5 font-semibold break-words text-slate-900 dark:text-slate-50"
            title={label}
          >
            {label}
          </label>
          <button
            type="button"
            onClick={() => {
              props.onRemove(stream);
            }}
            aria-label={`Remove ${label}`}
            title="Remove from list"
            className={`${BUTTON.icon} -mt-0.5 text-base`}
          >
            ×
          </button>
        </div>
        <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <ProtocolBadge protocol={stream.protocol} container={stream.progressive?.container} />
          {meta && <span className="truncate">{meta}</span>}
          {stream.status !== 'ready' && <Badge tone={status.tone}>{status.label}</Badge>}
          {streamTags(stream).map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
        </p>

        {ready && (
          <div className="mt-2 flex items-center gap-1.5">
            <select
              aria-label={`Quality of ${label}`}
              title={facts.qualities ? `Available: ${facts.qualities}` : undefined}
              value={choice.variantId}
              onChange={(event) => {
                props.onChoiceChange(withVariant(stream, choice, event.currentTarget.value));
              }}
              className="h-7 max-w-36 shrink-0 cursor-pointer rounded-md border border-slate-300 bg-white px-1.5 text-xs font-medium text-slate-800 hover:border-slate-400 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:hover:border-slate-500"
            >
              {qualityOptions(variants).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={optionsId}
              onClick={props.onToggleExpanded}
              title={audioTracks.length > 0 ? 'Audio tracks and file name' : 'File name'}
              className={`inline-flex h-7 min-w-0 items-center gap-1 rounded-md border px-2 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-indigo-500 ${
                expanded
                  ? 'border-indigo-400 bg-indigo-50 text-indigo-800 dark:border-indigo-500/60 dark:bg-indigo-500/10 dark:text-indigo-200'
                  : 'border-slate-300 text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500'
              }`}
            >
              <span className="truncate">{audioTracks.length > 0 ? `Audio: ${audioSummary(stream, choice)}` : 'Options'}</span>
              <span aria-hidden className="text-[10px] text-slate-400">
                {expanded ? '▴' : '▾'}
              </span>
            </button>
            <button
              type="button"
              disabled={props.busy}
              onClick={props.onDownload}
              aria-label={`Download ${label}`}
              className={`${BUTTON.primary} ml-auto h-7`}
            >
              Download
            </button>
          </div>
        )}

        {stream.statusMessage && <p className="mt-1.5 text-xs leading-snug text-slate-600 dark:text-slate-400">{stream.statusMessage}</p>}
        {stream.status === 'ready' && stream.manifest?.live && (
          <p className="mt-1.5 text-xs leading-snug text-slate-600 dark:text-slate-400">Live stream: downloading live streams is not supported yet.</p>
        )}
        {error && (
          <p role="alert" className="mt-1.5 rounded bg-red-50 px-2 py-1 text-xs leading-snug text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </p>
        )}
        {expanded && ready && (
          <StreamOptions
            id={optionsId}
            stream={stream}
            choice={choice}
            onChange={props.onChoiceChange}
            extension={props.extension}
            codecs={facts.codecs}
          />
        )}
      </div>
    </li>
  );
}
