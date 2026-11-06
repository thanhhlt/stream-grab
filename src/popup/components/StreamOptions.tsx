import type { DetectedStream } from '@/core/models/detected-stream';
import { withAudioTrack, withFileName, type StreamChoice } from '../selection';

interface StreamOptionsProps {
  id: string;
  stream: DetectedStream;
  choice: StreamChoice;
  onChange: (choice: StreamChoice) => void;
  /** ".mp4" or ".mkv", from Settings → Output format. */
  extension: string;
  /** "H.264 · AAC": thông tin kỹ thuật, chỉ hiện trong phần mở rộng. */
  codecs: string | undefined;
}

const fieldLabel = 'text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400';
const control =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-indigo-500 dark:border-slate-700 dark:bg-slate-900';

/** Audio tracks and file name of one video (quality and Download stay on the card). */
export function StreamOptions({ id, stream, choice, onChange, extension, codecs }: StreamOptionsProps) {
  const variant = stream.media?.variants.find((candidate) => candidate.id === choice.variantId);
  const tracks = (stream.media?.audioTracks ?? []).filter((track) => variant?.audioTrackIds.includes(track.id));

  return (
    <div id={id} className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2.5 dark:border-slate-800 dark:bg-slate-900/60">
      {tracks.length > 0 && (
        <fieldset className="flex gap-2">
          <legend className={`${fieldLabel} float-left w-12 shrink-0 pt-0.5`}>Audio</legend>
          <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1">
            {tracks.map((track) => (
              <label key={track.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={choice.audioTrackIds.includes(track.id)}
                  onChange={(event) => {
                    onChange(withAudioTrack(choice, track.id, event.currentTarget.checked));
                  }}
                  className="size-3.5 accent-indigo-600 dark:accent-indigo-400"
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
        <label htmlFor={`${id}-name`} className={`${fieldLabel} w-12 shrink-0`}>
          File
        </label>
        <div className="flex min-w-0 flex-1 items-center">
          <input
            id={`${id}-name`}
            type="text"
            value={choice.fileName}
            maxLength={150}
            spellCheck={false}
            onChange={(event) => {
              onChange(withFileName(choice, event.currentTarget.value));
            }}
            className={`${control} min-w-0 flex-1 rounded-r-none`}
          />
          <span className="rounded-r-md border border-l-0 border-slate-300 bg-slate-100 px-1.5 py-1 text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800">
            {extension}
          </span>
        </div>
      </div>

      {codecs && <p className="text-[11px] text-slate-500 dark:text-slate-400">Codecs: {codecs}</p>}
    </div>
  );
}
