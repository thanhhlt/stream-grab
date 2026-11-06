import type { SegmentStorage } from '@/core/download/download-storage';
import type { MediaProgress } from '@/core/models/download-task';
import type { MediaAnalysis, TrackAnalysis, TrackLayout } from '@/core/models/media-info';
import type { ContainerFormat } from '@/core/models/media-segment';
import type { OutputFormat } from '@/shared/settings/settings';
import { chooseContainer } from './containers';
import type { FfmpegRunner } from './ffmpeg-job';
import { parseProbeOutput, probeError, probeJob } from './probe';

/** A media job failed for a reason the user can act on. */
export class MediaFailure extends Error {
  /** The stored data cannot be used by any later run: delete it (Retry downloads again). */
  readonly discardData: boolean;

  constructor(message: string, options: ErrorOptions & { discardData?: boolean } = {}) {
    super(message, options);
    this.name = 'MediaFailure';
    this.discardData = options.discardData ?? false;
  }
}

export const NO_DATA_MESSAGE = 'The downloaded data is gone. Press Retry to download the video again.';
export const OLD_LAYOUT_MESSAGE =
  'This video was downloaded by an earlier version of StreamGrab. Press Retry: the segments already downloaded are reused, then the media is checked.';

/** What FFmpeg found, and the stored layout it was found in (the merge needs both). */
export interface Analysed {
  media: MediaAnalysis;
  layout: TrackLayout[];
}

export interface AnalyseOptions {
  storage: SegmentStorage;
  ffmpeg: FfmpegRunner;
  format: OutputFormat;
  signal: AbortSignal;
  progress(update: Omit<MediaProgress, 'startedAt' | 'percent'> & { percent?: number }): void;
  now?: () => number;
  /** Per ffprobe command. */
  timeoutMs?: number;
}

const EXTENSIONS: Record<ContainerFormat, string> = {
  'mpeg-ts': '.ts',
  fmp4: '.mp4',
  webm: '.webm',
  'packed-audio': '.aac',
  unknown: '.bin',
};

function trackLabel(track: TrackLayout): string {
  if (track.trackType === 'main') return 'the video track';
  return track.name ? `the audio track "${track.name}"` : 'an audio track';
}

/**
 * Checks a downloaded task's data with FFmpeg before anything is merged:
 *
 * 1. Storage holds every segment of the stored plan (markers and parts) and
 *    the plan's track layout.
 * 2. Each track's segments, concatenated in order as one Blob (references to
 *    the stored Blobs, not copies), are mounted into FFmpeg and probed:
 *    container, codecs, resolution, channels, duration.
 * 3. Data FFmpeg cannot read as media (an error page saved instead of
 *    segments, a different format) fails the task and is discarded, so Retry
 *    downloads it again. A track without the streams it should carry fails
 *    the same way.
 * 4. The output container follows from the streams and the task's format.
 *
 * Probing reads the first megabytes of each track (and, for MPEG-TS, its end
 * to estimate the duration), so it takes seconds even for long videos;
 * FFmpeg loading dominates the first job.
 */
export async function analyseTask(taskId: string, options: AnalyseOptions): Promise<Analysed> {
  const { storage, signal } = options;
  options.progress({ stage: 'preparing', step: 1, steps: 1 });
  const plan = await storage.getPlan(taskId);
  if (!plan) throw new MediaFailure(NO_DATA_MESSAGE);
  const layout = plan.layout;
  if (!layout) throw new MediaFailure(OLD_LAYOUT_MESSAGE);

  const { complete } = await storage.inspectTask(taskId);
  signal.throwIfAborted();
  const stored = new Map<string, { segments: number; bytes: number }>();
  for (const segment of complete) {
    const entry = stored.get(segment.trackId) ?? { segments: 0, bytes: 0 };
    entry.segments += 1;
    entry.bytes += segment.bytes;
    stored.set(segment.trackId, entry);
  }
  const expected = layout.reduce((sum, track) => sum + track.segments, 0);
  const found = layout.reduce((sum, track) => sum + Math.min(track.segments, stored.get(track.trackId)?.segments ?? 0), 0);
  if (found < expected) {
    throw new MediaFailure(`${expected - found} of ${expected} segments are missing from storage. Press Retry to download them again.`);
  }

  const tracks: TrackAnalysis[] = [];
  let loaded = false;
  for (const [position, track] of layout.entries()) {
    const step = { step: position + 1, steps: layout.length, ...(track.name !== undefined ? { detail: track.name } : {}) };
    const done = (position / layout.length) * 100;
    const parts = await storage.trackData(taskId, track.trackId);
    signal.throwIfAborted();
    const data = new Blob(parts.map((part) => part.data));
    const bytes = stored.get(track.trackId)?.bytes ?? 0;
    if (data.size !== bytes) {
      throw new MediaFailure(`The stored data of ${trackLabel(track)} is damaged. Press Retry to download the video again.`, {
        discardData: true,
      });
    }
    const name = `track-${position + 1}${EXTENSIONS[track.container]}`;
    // The first command loads FFmpeg (fetching and compiling its WebAssembly).
    options.progress(loaded ? { stage: 'analysing', ...step, percent: done } : { stage: 'loading', step: 1, steps: 1, percent: done });
    const result = await options.ffmpeg.run(probeJob(name, data), {
      signal,
      timeoutMs: options.timeoutMs ?? 120_000,
      onStarted: () => {
        loaded = true;
        options.progress({ stage: 'analysing', ...step, percent: done });
      },
    });
    const probe = parseProbeOutput(result.stdout);
    const playable = probe?.streams.filter((stream) => stream.kind === 'video' || stream.kind === 'audio') ?? [];
    if (!probe || playable.length === 0) {
      const reason = probeError(result.stderrTail) ?? 'no audio or video found';
      throw new MediaFailure(
        `FFmpeg cannot read ${trackLabel(track)} as media (${reason}). The server may have sent something other than video segments; press Retry to download it again.`,
        { discardData: true },
      );
    }
    if (track.trackType === 'audio' && !playable.some((stream) => stream.kind === 'audio')) {
      throw new MediaFailure(`${capitalise(trackLabel(track))} contains no audio. Press Retry to download it again.`, { discardData: true });
    }
    const analysis: TrackAnalysis = {
      trackId: track.trackId,
      trackType: track.trackType,
      format: probe.format,
      bytes,
      segments: track.segments,
      streams: probe.streams,
    };
    if (track.name !== undefined) analysis.name = track.name;
    if (probe.durationSec !== undefined) analysis.durationSec = probe.durationSec;
    if (probe.startSec !== undefined) analysis.startSec = probe.startSec;
    tracks.push(analysis);
  }

  const choice = chooseContainer(
    options.format,
    tracks.flatMap((track) => track.streams),
  );
  if ('error' in choice) throw new MediaFailure(choice.error);
  const media: MediaAnalysis = { analysedAt: (options.now ?? Date.now)(), tracks, container: choice.container };
  if (choice.reason !== undefined) media.containerReason = choice.reason;
  return { media, layout };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
