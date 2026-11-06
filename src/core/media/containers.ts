import type { MediaStreamInfo, OutputContainer } from '@/core/models/media-info';
import type { OutputFormat } from '@/shared/settings/settings';

/**
 * Codecs FFmpeg's MP4 muxer writes by stream copy and that players expect in
 * MP4 (checked against the bundled FFmpeg 5.1: VP8 and Theora are refused,
 * FLAC is "experimental", Vorbis is written but most players ignore it).
 * MKV holds every codec FFmpeg can read.
 */
const MP4_CODECS = new Set([
  'h264',
  'hevc',
  'av1',
  'vp9',
  'mpeg4',
  'mpeg2video',
  'mpeg1video',
  'aac',
  'mp3',
  'mp2',
  'ac3',
  'eac3',
  'opus',
  'alac',
]);

const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp8: 'VP8',
  vp9: 'VP9',
  mpeg4: 'MPEG-4',
  mpeg2video: 'MPEG-2',
  mpeg1video: 'MPEG-1',
  theora: 'Theora',
  aac: 'AAC',
  mp3: 'MP3',
  mp2: 'MP2',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'ALAC',
  dts: 'DTS',
  truehd: 'TrueHD',
};

export function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

export type ContainerChoice = { container: OutputContainer; reason?: string } | { error: string };

function list(names: readonly string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * The container the merge writes, from the streams FFmpeg found (only audio
 * and video are kept; timed metadata and similar data streams are dropped).
 * `auto`: MP4 when every stream can be copied into it, otherwise MKV. `mp4`:
 * an error when one cannot, since re-encoding is not an option. `mkv`: always.
 */
export function chooseContainer(format: OutputFormat, streams: readonly MediaStreamInfo[]): ContainerChoice {
  if (format === 'mkv') return { container: 'mkv' };
  const misfits = [
    ...new Set(
      streams.filter((stream) => (stream.kind === 'video' || stream.kind === 'audio') && !MP4_CODECS.has(stream.codec)).map((stream) => codecLabel(stream.codec)),
    ),
  ];
  if (misfits.length === 0) return { container: 'mp4' };
  const what = `${list(misfits)} cannot be stored in MP4 without re-encoding`;
  if (format === 'mp4') {
    return { error: `${what}, and re-encoding is not supported. Remove this download, set Output format to Auto or MKV in Settings, then download the video again.` };
  }
  return { container: 'mkv', reason: `${what}.` };
}

/** File extension of a container. */
export function containerExtension(container: OutputContainer): string {
  return `.${container}`;
}

/**
 * MIME type of a container. Chrome names a download from its response's type:
 * a blob without one is sniffed (as text/plain for a merged video), and an
 * extension that does not belong to the type is replaced, so "Movie.mp4"
 * would be saved as "Movie.txt".
 */
export function containerMimeType(container: OutputContainer): string {
  return container === 'mp4' ? 'video/mp4' : 'video/x-matroska';
}
