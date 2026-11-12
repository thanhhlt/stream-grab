import { MEDIA_PROTOCOLS, PROGRESSIVE_CONTAINERS, type RequestContext } from '@/core/models/detected-stream';
import {
  FAILURE_REASONS,
  MEDIA_FAILURE_REASONS,
  MEDIA_STAGES,
  type EngineReport,
  type EngineTaskSpec,
  type EngineWork,
  type FailureReason,
  type MediaFailureReason,
  type MediaProgress,
  type MediaReport,
  type MediaTaskSpec,
  type SaveRequest,
  type SubtitleFileRequest,
  type TaskProgress,
  type TrackProgress,
} from '@/core/models/download-task';
import {
  OUTPUT_CONTAINERS,
  STREAM_KINDS,
  type MediaAnalysis,
  type MediaStreamInfo,
  type TrackAnalysis,
} from '@/core/models/media-info';
import { TRACK_TYPES } from '@/core/models/media-segment';
import { SEGMENT_CONCURRENCY } from '@/shared/constants';
import { clampInt, OUTPUT_FORMATS, SUBTITLE_FORMATS, SUBTITLE_MODES } from '@/shared/settings/settings';
import { isOneOf, isRecord } from '@/shared/utils/guards';

/**
 * Runtime validation of engine messages. Both ends are extension code, but
 * messages cross a process boundary and the types are compile-time only, so
 * shapes are checked and bounded like any other input.
 */

const MAX_IDS = 500;

const str = (value: unknown, max = 4096): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;

const nonNegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function parseTaskIds(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw['taskIds'])) return [];
  return raw['taskIds'].filter((id): id is string => str(id, 64) !== undefined).slice(0, MAX_IDS);
}

function parseContext(raw: unknown): RequestContext {
  const context: RequestContext = {};
  if (!isRecord(raw)) return context;
  const referer = str(raw['referer']);
  const origin = str(raw['origin']);
  if (referer !== undefined) context.referer = referer;
  if (origin !== undefined) context.origin = origin;
  return context;
}

export function parseEngineTaskSpec(raw: unknown): EngineTaskSpec | null {
  if (!isRecord(raw) || !isRecord(raw['variant'])) return null;
  const taskId = str(raw['taskId'], 64);
  const manifestUrl = str(raw['manifestUrl']);
  const protocol = raw['protocol'];
  const variantId = str(raw['variant']['id'], 64);
  if (taskId === undefined || manifestUrl === undefined || variantId === undefined || !isOneOf(protocol, MEDIA_PROTOCOLS)) {
    return null;
  }
  // A progressive file fetched by the engine (0.3.0) comes with its container, and only then.
  const file = isRecord(raw['file']) ? raw['file'] : undefined;
  const container = file?.['container'];
  if ((protocol === 'progressive') !== isOneOf(container, PROGRESSIVE_CONTAINERS)) return null;
  const variant: EngineTaskSpec['variant'] = { id: variantId };
  const height = nonNegative(raw['variant']['height']);
  const bandwidth = nonNegative(raw['variant']['bandwidth']);
  if (height !== undefined) variant.height = height;
  if (bandwidth !== undefined) variant.bandwidth = bandwidth;
  const audioTrackIds = Array.isArray(raw['audioTrackIds'])
    ? raw['audioTrackIds'].filter((id): id is string => str(id, 64) !== undefined).slice(0, 20)
    : [];
  const spec: EngineTaskSpec = {
    taskId,
    protocol,
    manifestUrl,
    context: parseContext(raw['context']),
    variant,
    audioTrackIds,
    concurrency: clampInt(raw['concurrency'], SEGMENT_CONCURRENCY),
  };
  const subtitleTrackIds = Array.isArray(raw['subtitleTrackIds'])
    ? raw['subtitleTrackIds'].filter((id): id is string => str(id, 64) !== undefined).slice(0, 20)
    : [];
  if (subtitleTrackIds.length > 0) spec.subtitleTrackIds = subtitleTrackIds;
  if (isOneOf(container, PROGRESSIVE_CONTAINERS)) {
    const bytes = nonNegative(file?.['bytes']);
    spec.file = { container, ...(bytes !== undefined && bytes > 0 ? { bytes } : {}) };
  }
  return spec;
}

function parseEngineTaskSpecs(raw: unknown): EngineTaskSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 50)
    .map(parseEngineTaskSpec)
    .filter((spec) => spec !== null);
}

export function parseMediaTaskSpec(raw: unknown): MediaTaskSpec | null {
  if (!isRecord(raw)) return null;
  const taskId = str(raw['taskId'], 64);
  if (taskId === undefined || raw['job'] !== 'process' || !isOneOf(raw['format'], OUTPUT_FORMATS)) return null;
  const spec: MediaTaskSpec = { taskId, job: 'process', format: raw['format'], title: typeof raw['title'] === 'string' ? raw['title'].slice(0, 500) : '' };
  const subtitles = raw['subtitles'];
  if (isRecord(subtitles) && (subtitles['protocol'] === 'hls' || subtitles['protocol'] === 'dash') && isOneOf(subtitles['format'], SUBTITLE_FORMATS)) {
    // A spec from before the mode existed saves files, as it did.
    spec.subtitles = { protocol: subtitles['protocol'], format: subtitles['format'], mode: isOneOf(subtitles['mode'], SUBTITLE_MODES) ? subtitles['mode'] : 'file' };
  }
  return spec;
}

/** `engine/sync` payload: everything the engine should run. */
export function parseEngineWork(raw: unknown): EngineWork {
  if (!isRecord(raw)) return { downloads: [], media: [] };
  const media = Array.isArray(raw['media'])
    ? raw['media']
        .slice(0, 10)
        .map(parseMediaTaskSpec)
        .filter((spec) => spec !== null)
    : [];
  return { downloads: parseEngineTaskSpecs(raw['downloads']), media };
}

function parseProgress(raw: unknown): TaskProgress | null {
  if (!isRecord(raw)) return null;
  const fields = ['segmentsTotal', 'segmentsDone', 'bytes', 'bytesPerSecond', 'percent', 'retries', 'startedAt'] as const;
  const progress: Partial<TaskProgress> = {};
  for (const field of fields) {
    const value = nonNegative(raw[field]);
    if (value === undefined) return null;
    progress[field] = value;
  }
  const resumed = nonNegative(raw['resumedSegments']);
  if (resumed !== undefined && resumed > 0) progress.resumedSegments = resumed;
  const average = nonNegative(raw['averageBytesPerSecond']);
  if (average !== undefined && average >= 0) progress.averageBytesPerSecond = average;
  const tracks = parseTrackProgress(raw['tracks']);
  if (tracks) progress.tracks = tracks;
  // `stale` is the service worker's own marker; the engine's reports are current by definition.
  return progress as TaskProgress;
}

const MAX_PROGRESS_TRACKS = 32;

/**
 * Số liệu theo track của một progress (từ v0.2.0). Thiếu hoặc sai dạng →
 * undefined: popup quay về ước lượng trên toàn task, như dữ liệu của v0.1.0.
 */
export function parseTrackProgress(raw: unknown): TrackProgress[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_PROGRESS_TRACKS) return undefined;
  const tracks: TrackProgress[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined;
    const trackId = str(entry['trackId'], 256);
    const segmentsTotal = nonNegative(entry['segmentsTotal']);
    const segmentsDone = nonNegative(entry['segmentsDone']);
    const bytes = nonNegative(entry['bytes']);
    if (trackId === undefined || segmentsTotal === undefined || segmentsDone === undefined || bytes === undefined) return undefined;
    const track: TrackProgress = { trackId, segmentsTotal, segmentsDone, bytes };
    const declared = nonNegative(entry['declaredBytes']);
    if (declared !== undefined) track.declaredBytes = declared;
    tracks.push(track);
  }
  return tracks;
}

export function parseEngineReport(raw: unknown): EngineReport | null {
  if (!isRecord(raw)) return null;
  const taskId = str(raw['taskId'], 64);
  const progress = parseProgress(raw['progress']);
  if (taskId === undefined || progress === null) return null;
  const report: EngineReport = { taskId, progress };
  const outcome = raw['outcome'];
  if (isRecord(outcome)) {
    if (outcome['status'] === 'downloaded') report.outcome = { status: 'downloaded' };
    else if (outcome['status'] === 'cancelled') report.outcome = { status: 'cancelled' };
    else if (outcome['status'] === 'failed') {
      const failed: { status: 'failed'; message: string; reason?: FailureReason } = {
        status: 'failed',
        message: str(outcome['message'], 1000) ?? 'The download failed.',
      };
      if (isOneOf(outcome['reason'], FAILURE_REASONS)) failed.reason = outcome['reason'];
      report.outcome = failed;
    }
  }
  return report;
}

const MAX_STREAMS = 64;
const MAX_TRACKS = 32;

function parseStreamInfo(raw: unknown): MediaStreamInfo | null {
  if (!isRecord(raw) || !isOneOf(raw['kind'], STREAM_KINDS)) return null;
  const codec = str(raw['codec'], 32);
  if (codec === undefined) return null;
  const stream: MediaStreamInfo = { kind: raw['kind'], codec };
  const profile = str(raw['profile'], 64);
  const language = str(raw['language'], 35);
  if (profile !== undefined) stream.profile = profile;
  if (language !== undefined) stream.language = language;
  for (const key of ['width', 'height', 'frameRate', 'channels', 'sampleRate'] as const) {
    const value = nonNegative(raw[key]);
    if (value !== undefined && value > 0) stream[key] = value;
  }
  return stream;
}

function parseTrackAnalysis(raw: unknown): TrackAnalysis | null {
  if (!isRecord(raw) || !Array.isArray(raw['streams'])) return null;
  const trackId = str(raw['trackId'], 64);
  const format = str(raw['format'], 128);
  const bytes = nonNegative(raw['bytes']);
  const segments = nonNegative(raw['segments']);
  if (trackId === undefined || format === undefined || bytes === undefined || segments === undefined) return null;
  if (!isOneOf(raw['trackType'], TRACK_TYPES)) return null;
  const streams = raw['streams']
    .slice(0, MAX_STREAMS)
    .map(parseStreamInfo)
    .filter((stream) => stream !== null);
  const track: TrackAnalysis = { trackId, trackType: raw['trackType'], format, bytes, segments, streams };
  const name = str(raw['name'], 200);
  const durationSec = nonNegative(raw['durationSec']);
  const startSec = raw['startSec'];
  if (name !== undefined) track.name = name;
  if (durationSec !== undefined && durationSec > 0) track.durationSec = durationSec;
  if (typeof startSec === 'number' && Number.isFinite(startSec) && Math.abs(startSec) < 1e7) track.startSec = startSec;
  return track;
}

/** Validates an analysis from the engine, or read back from the task store. */
export function parseMediaAnalysis(raw: unknown): MediaAnalysis | null {
  if (!isRecord(raw) || !Array.isArray(raw['tracks']) || raw['tracks'].length > MAX_TRACKS) return null;
  const analysedAt = nonNegative(raw['analysedAt']);
  if (analysedAt === undefined || !isOneOf(raw['container'], OUTPUT_CONTAINERS)) return null;
  const tracks: TrackAnalysis[] = [];
  for (const item of raw['tracks']) {
    const track = parseTrackAnalysis(item);
    if (!track) return null;
    tracks.push(track);
  }
  const media: MediaAnalysis = { analysedAt, tracks, container: raw['container'] };
  const reason = str(raw['containerReason'], 500);
  if (reason !== undefined) media.containerReason = reason;
  return media;
}

export function parseMediaProgress(raw: unknown): MediaProgress | null {
  if (!isRecord(raw) || !isOneOf(raw['stage'], MEDIA_STAGES)) return null;
  const step = nonNegative(raw['step']);
  const steps = nonNegative(raw['steps']);
  const percent = nonNegative(raw['percent']);
  const startedAt = nonNegative(raw['startedAt']);
  if (step === undefined || steps === undefined || percent === undefined || startedAt === undefined) return null;
  const progress: MediaProgress = { stage: raw['stage'], step, steps, percent: Math.min(100, percent), startedAt };
  const detail = str(raw['detail'], 200);
  if (detail !== undefined) progress.detail = detail;
  return progress;
}

export function parseMediaReport(raw: unknown): MediaReport | null {
  if (!isRecord(raw)) return null;
  const taskId = str(raw['taskId'], 64);
  const progress = parseMediaProgress(raw['progress']);
  if (taskId === undefined || progress === null) return null;
  const report: MediaReport = { taskId, progress };
  const outcome = raw['outcome'];
  if (isRecord(outcome)) {
    if (outcome['status'] === 'cancelled') {
      report.outcome = { status: 'cancelled' };
    } else if (outcome['status'] === 'failed') {
      const failed: { status: 'failed'; message: string; discardedData?: boolean; reason?: MediaFailureReason } = {
        status: 'failed',
        message: str(outcome['message'], 1000) ?? 'Media processing failed.',
      };
      if (outcome['discardedData'] === true) failed.discardedData = true;
      if (isOneOf(outcome['reason'], MEDIA_FAILURE_REASONS)) failed.reason = outcome['reason'];
      report.outcome = failed;
    }
  }
  return report;
}

/**
 * `engine/save`: the URL must be a blob: URL of this extension (the offscreen
 * document's), so a message can never make Chrome download anything else.
 */
export function parseSaveRequest(raw: unknown, extensionOrigin: string): SaveRequest | null {
  if (!isRecord(raw)) return null;
  const taskId = str(raw['taskId'], 64);
  const url = str(raw['url'], 200);
  const size = nonNegative(raw['size']);
  if (taskId === undefined || url === undefined || size === undefined) return null;
  if (!url.startsWith(`blob:${extensionOrigin.replace(/\/$/, '')}/`)) return null;
  const request: SaveRequest = { taskId, url, size };
  // A merged video names its container and FFmpeg's analysis; a progressive file (0.3.0) has neither.
  if (raw['container'] !== undefined || raw['media'] !== undefined) {
    const media = parseMediaAnalysis(raw['media']);
    if (!media || !isOneOf(raw['container'], OUTPUT_CONTAINERS)) return null;
    request.container = raw['container'];
    request.media = media;
    // Subtitle files (0.7.0) come with a merged video only, as blob: URLs of the same document.
    if (Array.isArray(raw['subtitles'])) {
      const subtitles = raw['subtitles']
        .slice(0, 20)
        .map((item) => parseSubtitleFileRequest(item, extensionOrigin))
        .filter((item) => item !== null);
      if (subtitles.length > 0) request.subtitles = subtitles;
    }
  }
  return request;
}

function parseSubtitleFileRequest(raw: unknown, extensionOrigin: string): SubtitleFileRequest | null {
  if (!isRecord(raw)) return null;
  const trackId = str(raw['trackId'], 64);
  if (trackId === undefined) return null;
  const embedded = raw['embedded'] === true;
  const error = str(raw['error'], 500);
  if (error !== undefined && !embedded) return { trackId, error };
  const url = str(raw['url'], 200);
  const size = nonNegative(raw['size']);
  if (url === undefined || size === undefined || !url.startsWith(`blob:${extensionOrigin.replace(/\/$/, '')}/`)) {
    return embedded ? { trackId, embedded: true } : null;
  }
  return { trackId, ...(embedded ? { embedded: true as const } : {}), url, size };
}
