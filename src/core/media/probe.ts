import { STREAM_KINDS, type MediaStreamInfo, type StreamKind } from '@/core/models/media-info';
import { isOneOf, isRecord } from '@/shared/utils/guards';
import { inputPath, lastErrorLine, type FfmpegJob } from './ffmpeg-job';

/** What ffprobe reports about one input. */
export interface ProbeResult {
  /** Demuxer name(s): "mpegts", "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm"… */
  format: string;
  durationSec?: number;
  /**
   * Earliest start time of its audio and video streams, seconds. Separate
   * tracks keep their relative timing when merged by being offset by the
   * differences of these.
   */
  startSec?: number;
  streams: MediaStreamInfo[];
}

const MAX_STREAMS = 64;

/** ffprobe on one mounted input: container and streams as JSON, errors only on stderr. */
export function probeJob(name: string, data: Blob): FfmpegJob {
  return {
    tool: 'ffprobe',
    args: ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', inputPath(name)],
    inputs: [{ name, data }],
    outputs: [],
  };
}

const text = (value: unknown, max = 64): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

const positive = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
};

const finite = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
};

/** "30000/1001" → 29.97; "0/0" → undefined. */
function rate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const [num, den] = value.split('/').map(Number);
  if (num === undefined || den === undefined || !Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return undefined;
  const fps = num / den;
  return fps > 0 && fps <= 1000 ? Math.round(fps * 1000) / 1000 : undefined;
}

function parseStream(raw: unknown): MediaStreamInfo | null {
  if (!isRecord(raw)) return null;
  const type = raw['codec_type'] === 'attachment' ? 'data' : raw['codec_type'];
  if (!isOneOf(type, STREAM_KINDS)) return null;
  const disposition = isRecord(raw['disposition']) ? raw['disposition'] : {};
  // Cover art of an audio file is a "video" stream of one picture: not video for our purposes.
  const kind: StreamKind = type === 'video' && disposition['attached_pic'] === 1 ? 'data' : type;
  const codec = text(raw['codec_name'], 32);
  const stream: MediaStreamInfo = { kind, codec: codec !== undefined && /^[\w-]+$/.test(codec) ? codec : 'unknown' };
  const profile = text(raw['profile']);
  if (profile !== undefined) stream.profile = profile;
  if (kind === 'video') {
    const width = positive(raw['width']);
    const height = positive(raw['height']);
    if (width !== undefined && height !== undefined) {
      stream.width = Math.round(width);
      stream.height = Math.round(height);
    }
    const fps = rate(raw['avg_frame_rate']) ?? rate(raw['r_frame_rate']);
    if (fps !== undefined) stream.frameRate = fps;
  }
  if (kind === 'audio') {
    const channels = positive(raw['channels']);
    const sampleRate = positive(raw['sample_rate']);
    if (channels !== undefined) stream.channels = Math.round(channels);
    if (sampleRate !== undefined) stream.sampleRate = Math.round(sampleRate);
  }
  const tags = isRecord(raw['tags']) ? raw['tags'] : {};
  const language = text(tags['language'], 35);
  if (language !== undefined && language !== 'und') stream.language = language;
  return stream;
}

/**
 * Parses `ffprobe -show_format -show_streams -of json`. Null when the output
 * names no format (the input is not something FFmpeg can read).
 */
export function parseProbeOutput(stdout: string): ProbeResult | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw['format'])) return null;
  const format = text(raw['format']['format_name'], 128);
  if (format === undefined) return null;
  const streams = Array.isArray(raw['streams'])
    ? raw['streams']
        .slice(0, MAX_STREAMS)
        .map(parseStream)
        .filter((stream) => stream !== null)
    : [];
  const result: ProbeResult = { format, streams };
  const duration = positive(raw['format']['duration']);
  if (duration !== undefined) result.durationSec = Math.round(duration * 1000) / 1000;
  const starts = (Array.isArray(raw['streams']) ? raw['streams'] : [])
    .slice(0, MAX_STREAMS)
    .filter((stream) => {
      const kind = parseStream(stream)?.kind;
      return kind === 'video' || kind === 'audio';
    })
    .map((stream) => (isRecord(stream) ? finite(stream['start_time']) : undefined))
    .filter((start) => start !== undefined);
  const start = starts.length > 0 ? Math.min(...starts) : finite(raw['format']['start_time']);
  if (start !== undefined) result.startSec = Math.round(start * 1_000_000) / 1_000_000;
  return result;
}

/** ffprobe's complaint about an input, without the internal path: "Invalid data found when processing input". */
export function probeError(stderr: readonly string[]): string | undefined {
  const line = lastErrorLine(stderr);
  return line?.replace(/^\/in\/[^:]+:\s*/, '');
}
