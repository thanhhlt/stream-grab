import type { DetectedStream } from '@/core/models/detected-stream';
import { fileNameOf, hostnameOf } from '@/shared/utils/url';
import { formatDuration, mediaFacts, qualityOptions, statusView, streamLabel, streamTags } from '../format';
import { withVariant, type Availability, type StreamChoice } from '../selection';
import { Badge, ProtocolBadge } from './Badge';
import { BUTTON } from './buttons';
import { Icon } from './Icon';
import { PosterTile } from './PosterTile';
import { Select } from './Select';
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

/** Các phần nằm dưới tiêu đề trải từ cột ô poster tới mép phải (docs/DESIGN.md, "Detected rows"). */
const WIDE = 'col-span-2 col-start-2';

export function StreamCard(props: StreamCardProps) {
  const { stream, availability, selected, choice, expanded, error } = props;
  const status = statusView(stream);
  const label = streamLabel(stream);
  const site = hostnameOf(stream.pageUrl) || hostnameOf(stream.url);
  const file = fileNameOf(stream.url);
  const facts = mediaFacts(stream);
  const duration = facts.durationSec ? formatDuration(facts.durationSec) : undefined;
  const meta = [site, props.showSource && file !== label ? file : ''].filter(Boolean).join(' · ');
  const reason = availability.ok ? undefined : availability.reason;
  const checkboxId = `select-${stream.id}`;
  const variants = stream.media?.variants ?? [];
  const variant = variants.find((candidate) => candidate.id === choice?.variantId);
  const audioTracks = (stream.media?.audioTracks ?? []).filter((track) => variant?.audioTrackIds.includes(track.id));
  const optionsId = `opt-${stream.id}`;
  const ready = availability.ok && choice !== undefined;
  const tags = streamTags(stream);
  // DRM, lỗi hoặc không tải được (vd. live): ô khóa. Đang kiểm tra thì vẫn là ô phát.
  const tile = availability.ok || stream.status === 'pending' ? 'play' : 'locked';

  return (
    <li
      data-stream-id={stream.id}
      data-selected={selected}
      className={`mx-1.5 grid grid-cols-[18px_52px_minmax(0,1fr)] items-start gap-x-2.5 rounded-row px-2.5 pt-2.5 pb-[11px] transition-colors duration-120 ease-out ${
        selected ? 'bg-selected' : 'hover:bg-surface/60'
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
        className="col-start-1 row-start-1 mt-[17px] size-[18px] cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
      />
      {/* Tiêu đề đứng trước ô poster trong DOM (đọc trước), lưới đặt ô poster vào cột 2. */}
      <div className="col-start-3 row-start-1 min-w-0">
        <div className="flex items-start gap-1">
          <label
            htmlFor={checkboxId}
            className={`line-clamp-2 min-w-0 flex-1 cursor-pointer text-title [overflow-wrap:anywhere] ${availability.ok ? 'text-ink' : 'text-muted'}`}
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
            className={`${BUTTON.icon} -mt-1 -mr-1.5`}
          >
            <Icon name="close" />
          </button>
        </div>
        <p className="mt-0.5 truncate text-meta text-muted">
          {meta && `${meta} · `}
          <ProtocolBadge protocol={stream.protocol} container={stream.progressive?.container} />
          {/* Thời lượng hiện trên ô poster (aria-hidden); trình đọc màn hình đọc ở đây. */}
          {duration && <span className="sr-only">, {duration}</span>}
        </p>
      </div>
      <span className="col-start-2 row-start-1 flex">
        <PosterTile host={site} state={tile} duration={duration} />
      </span>

      {(stream.status !== 'ready' || tags.length > 0) && (
        <p className={`${WIDE} mt-2 flex flex-wrap items-center gap-1.5`}>
          {stream.status !== 'ready' && <Badge tone={status.tone}>{status.label}</Badge>}
          {tags.map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
        </p>
      )}

      {ready && (
        <div className={`${WIDE} mt-2 flex min-w-0 items-center gap-1.5`}>
          <Select
            aria-label={`Quality of ${label}`}
            title={facts.qualities ? `Available: ${facts.qualities}` : undefined}
            value={choice.variantId}
            onChange={(event) => {
              props.onChoiceChange(withVariant(stream, choice, event.currentTarget.value));
            }}
            className="max-w-36"
          >
            {qualityOptions(variants).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={optionsId}
            onClick={props.onToggleExpanded}
            title={audioTracks.length > 0 ? 'Audio tracks and file name' : 'File name'}
            className="inline-flex h-[30px] min-w-0 cursor-pointer items-center gap-1 rounded-full bg-surface pr-[9px] pl-[11px] text-control text-ink transition-colors duration-120 ease-out hover:bg-line"
          >
            <span className="truncate">{audioTracks.length > 0 ? `Audio: ${audioSummary(stream, choice)}` : 'Options'}</span>
            <Icon
              name="chevron"
              className={`size-[13px] text-muted transition-transform duration-200 ease-out ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onDownload}
            aria-label={`Download ${label}`}
            className={`${BUTTON.download} ml-auto`}
          >
            <Icon name="download" />
            Download
          </button>
        </div>
      )}

      {stream.statusMessage && <p className={`${WIDE} mt-1.5 text-meta text-muted`}>{stream.statusMessage}</p>}
      {stream.status === 'ready' && stream.manifest?.live && (
        <p className={`${WIDE} mt-1.5 text-meta text-muted`}>Live stream: downloading live streams is not supported yet.</p>
      )}
      {error && (
        <p role="alert" className={`${WIDE} mt-2 rounded-field bg-danger-surface px-2.5 py-[7px] text-meta text-danger`}>
          {error}
        </p>
      )}
      {expanded && ready && (
        <StreamOptions
          id={optionsId}
          className={WIDE}
          stream={stream}
          choice={choice}
          onChange={props.onChoiceChange}
          extension={props.extension}
          codecs={facts.codecs}
        />
      )}
    </li>
  );
}
