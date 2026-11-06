import type { DetectedStream } from '@/core/models/detected-stream';
import { formatBitrate, variantLabel } from '../format';
import { withAudioTrack, withFileName, withVariant, type StreamChoice } from '../selection';

interface StreamOptionsProps {
  stream: DetectedStream;
  choice: StreamChoice;
  onChange: (choice: StreamChoice) => void;
  /** ".mp4" or ".mkv", from Settings → Output format. */
  extension: string;
  onDownload: () => void;
  busy: boolean;
}

const fieldLabel = 'text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400';
const control =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-[13px] focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900';

/** Quality, audio tracks and file name for one video, plus its own Download button. */
export function StreamOptions({ stream, choice, onChange, extension, onDownload, busy }: StreamOptionsProps) {
  const variants = stream.media?.variants ?? [];
  const variant = variants.find((candidate) => candidate.id === choice.variantId);
  const tracks = (stream.media?.audioTracks ?? []).filter((track) => variant?.audioTrackIds.includes(track.id));
  const base = `opt-${stream.id}`;

  return (
    <div className="mt-2 space-y-2.5 rounded-md border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-800 dark:bg-slate-900/60">
      <div className="flex items-center gap-2">
        <label htmlFor={`${base}-quality`} className={`${fieldLabel} w-14 shrink-0`}>
          Quality
        </label>
        <select
          id={`${base}-quality`}
          value={choice.variantId}
          onChange={(event) => {
            onChange(withVariant(stream, choice, event.currentTarget.value));
          }}
          className={`${control} min-w-0 flex-1`}
        >
          {variants.map((option) => (
            <option key={option.id} value={option.id}>
              {variantLabel(option)}
              {option.bandwidth !== undefined && option.height !== undefined ? ` · ${formatBitrate(option.bandwidth)}` : ''}
            </option>
          ))}
        </select>
      </div>

      {tracks.length > 0 && (
        <fieldset className="flex gap-2">
          <legend className={`${fieldLabel} float-left w-14 shrink-0 pt-0.5`}>Audio</legend>
          <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
            {tracks.map((track) => (
              <label key={track.id} className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={choice.audioTrackIds.includes(track.id)}
                  onChange={(event) => {
                    onChange(withAudioTrack(choice, track.id, event.currentTarget.checked));
                  }}
                  className="size-3.5 accent-indigo-600"
                />
                <span>
                  {track.name}
                  {track.isDefault ? <span className="text-slate-400"> (default)</span> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <label htmlFor={`${base}-name`} className={`${fieldLabel} w-14 shrink-0`}>
          File
        </label>
        <div className="flex min-w-0 flex-1 items-center">
          <input
            id={`${base}-name`}
            type="text"
            value={choice.fileName}
            maxLength={150}
            spellCheck={false}
            onChange={(event) => {
              onChange(withFileName(choice, event.currentTarget.value));
            }}
            className={`${control} min-w-0 flex-1 rounded-r-none`}
          />
          <span className="rounded-r-md border border-l-0 border-slate-300 bg-slate-100 px-1.5 py-1 text-[13px] text-slate-500 dark:border-slate-700 dark:bg-slate-800">
            {extension}
          </span>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          disabled={busy}
          onClick={onDownload}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-50"
        >
          Download this video
        </button>
      </div>
    </div>
  );
}
