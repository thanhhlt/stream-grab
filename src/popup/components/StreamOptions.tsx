import type { DetectedStream } from '@/core/models/detected-stream';
import type { SubtitleFormat, SubtitleMode } from '@/shared/settings/settings';
import { subtitleDestination } from '../format';
import { offeredSubtitles, withAudioTrack, withFileName, withSubtitleTrack, type StreamChoice } from '../selection';
import { ProtocolBadge } from './Badge';

interface StreamOptionsProps {
  id: string;
  stream: DetectedStream;
  choice: StreamChoice;
  onChange: (choice: StreamChoice) => void;
  /** ".mp4" or ".mkv", from Settings → Output format. */
  extension: string;
  /** Settings → subtitles (0.7.0): where the chosen tracks go. */
  subtitles: { mode: SubtitleMode; format: SubtitleFormat };
  /** "H.264 · AAC": thông tin kỹ thuật, chỉ hiện trong phần mở rộng. */
  codecs: string | undefined;
  /** Vị trí trong lưới của dòng. */
  className?: string;
}

/** Cột nhãn 56 px: "Audio", "Subtitles", "File", "Details". */
const fieldLabel = 'w-14 shrink-0 text-muted';

/** Audio tracks, subtitles and file name of one video (quality and Download stay on the card). */
export function StreamOptions({ id, stream, choice, onChange, extension, subtitles, codecs, className = '' }: StreamOptionsProps) {
  const variant = stream.media?.variants.find((candidate) => candidate.id === choice.variantId);
  const tracks = (stream.media?.audioTracks ?? []).filter((track) => variant?.audioTrackIds.includes(track.id));
  const subtitleTracks = offeredSubtitles(stream, variant);

  return (
    <div id={id} className={`mt-2 space-y-2 rounded-tile border border-line bg-bg px-3 py-2.5 text-control ${className}`}>
      {tracks.length > 0 && (
        <fieldset className="flex items-start gap-2">
          <legend className={`${fieldLabel} float-left pt-px`}>Audio</legend>
          <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1.5">
            {tracks.map((track) => (
              <label key={track.id} className="flex cursor-pointer items-center gap-1.5 text-ink">
                <input
                  type="checkbox"
                  checked={choice.audioTrackIds.includes(track.id)}
                  onChange={(event) => {
                    onChange(withAudioTrack(choice, track.id, event.currentTarget.checked));
                  }}
                  className="size-4 cursor-pointer"
                />
                <span>
                  {track.name}
                  {track.isDefault ? <span className="text-muted"> (default)</span> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {subtitleTracks.length > 0 && (
        <fieldset className="flex items-start gap-2">
          <legend className={`${fieldLabel} float-left pt-px`}>Subtitles</legend>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {subtitleTracks.map((track) => (
                <label key={track.id} className="flex cursor-pointer items-center gap-1.5 text-ink">
                  <input
                    type="checkbox"
                    checked={choice.subtitleTrackIds.includes(track.id)}
                    onChange={(event) => {
                      onChange(withSubtitleTrack(choice, track.id, event.currentTarget.checked));
                    }}
                    className="size-4 cursor-pointer"
                  />
                  <span>
                    {track.name}
                    {track.forced === true && !/forced/i.test(track.name) ? <span className="text-muted"> (forced)</span> : null}
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-tech text-muted">{subtitleDestination(stream.protocol, subtitles.mode, subtitles.format)}</p>
          </div>
        </fieldset>
      )}

      <div className="flex items-center gap-2">
        <label htmlFor={`${id}-name`} className={fieldLabel}>
          File
        </label>
        {/* Ô nhập 10 px bo góc; viền focus nằm trên cả ô (gồm phần đuôi file). */}
        <div className="flex h-[30px] min-w-0 flex-1 items-center overflow-hidden rounded-field bg-surface outline-primary-text focus-within:outline-2 focus-within:outline-offset-2">
          <input
            id={`${id}-name`}
            type="text"
            value={choice.fileName}
            maxLength={150}
            spellCheck={false}
            onChange={(event) => {
              onChange(withFileName(choice, event.currentTarget.value));
            }}
            className="h-full min-w-0 flex-1 bg-transparent pl-2.5 text-ink outline-none"
          />
          <span className="shrink-0 pr-2.5 pl-1 text-muted">{extension}</span>
        </div>
      </div>

      <p className="flex items-baseline gap-2">
        <span className={fieldLabel}>Details</span>
        <span className="min-w-0 text-muted">
          <ProtocolBadge protocol={stream.protocol} container={stream.progressive?.container} />
          {codecs && ` · ${codecs}`}
        </span>
      </p>
    </div>
  );
}
