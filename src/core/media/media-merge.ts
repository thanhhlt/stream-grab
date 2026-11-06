import type { SegmentStorage } from '@/core/download/download-storage';
import type { MediaAnalysis, OutputContainer, TrackLayout } from '@/core/models/media-info';
import { containerMimeType } from './containers';
import { lastErrorLine, type FfmpegRunner } from './ffmpeg-job';
import { MediaFailure } from './media-analysis';
import { buildMergeJob, trackRuns, type MergeTrack } from './merge-plan';
import { parseProbeOutput, probeJob } from './probe';

export interface MergeTaskOptions {
  storage: SegmentStorage;
  ffmpeg: FfmpegRunner;
  signal: AbortSignal;
  /** The analysis of the same stored data (analyseTask). */
  media: MediaAnalysis;
  layout: readonly TrackLayout[];
  title?: string;
  /** Merging progress, 0–1 (by output time), and the start of the check of the result. */
  progress(update: { stage: 'merging'; fraction: number } | { stage: 'verifying' }): void;
  /** The merge is stopped when FFmpeg reports no progress for this long. */
  stallTimeoutMs?: number;
}

export interface MergedFile {
  data: Blob;
  container: OutputContainer;
  durationSec?: number;
}

const KEPT = 'Press Retry to try again; the downloaded segments are kept.';

/**
 * Merges a downloaded task into one file with FFmpeg (stream copy, see
 * buildMergeJob), then checks the result with ffprobe: it must contain the
 * planned audio and video streams, and not be grossly shorter than the video.
 * The file is a Blob streamed out of FFmpeg (SinkFs), never held in memory
 * whole.
 */
export async function mergeTask(taskId: string, options: MergeTaskOptions): Promise<MergedFile> {
  const { storage, signal, media } = options;
  const tracks: MergeTrack[] = [];
  for (const layout of options.layout) {
    const analysis = media.tracks.find((track) => track.trackId === layout.trackId);
    if (!analysis) throw new MediaFailure(`Internal error: no analysis for track ${layout.trackId}. ${KEPT}`);
    const bySegment = new Map<number, Blob[]>();
    for (const part of await storage.trackData(taskId, layout.trackId)) {
      const parts = bySegment.get(part.index) ?? [];
      parts.push(part.data);
      bySegment.set(part.index, parts);
    }
    signal.throwIfAborted();
    const runs = trackRuns(layout).map((positions) => new Blob(positions.flatMap((position) => bySegment.get(position) ?? [])));
    tracks.push({ layout, analysis, runs });
  }

  const plan = buildMergeJob(tracks, { container: media.container, ...(options.title !== undefined ? { title: options.title } : {}) });
  const expected = plan.expectedSeconds;
  options.progress({ stage: 'merging', fraction: 0 });
  const result = await options.ffmpeg.run(plan.job, {
    signal,
    stallTimeoutMs: options.stallTimeoutMs ?? 120_000,
    onProgress: (seconds) => {
      options.progress({ stage: 'merging', fraction: expected ? Math.min(1, seconds / expected) : 0 });
    },
  });
  const data = result.outputs.find((output) => output.name === plan.outputName)?.data;
  if (result.exitCode !== 0 || !data || data.size === 0) {
    const reason = lastErrorLine(result.stderrTail) ?? `exit code ${String(result.exitCode)}`;
    throw new MediaFailure(`FFmpeg could not merge the tracks (${reason}). ${KEPT}`);
  }

  options.progress({ stage: 'verifying' });
  const check = await options.ffmpeg.run(probeJob(plan.outputName, data), { signal, timeoutMs: 120_000 });
  const probe = parseProbeOutput(check.stdout);
  const count = (kind: 'video' | 'audio') => probe?.streams.filter((stream) => stream.kind === kind).length ?? 0;
  if (!probe || count('video') !== plan.expectedStreams.video || count('audio') !== plan.expectedStreams.audio) {
    throw new MediaFailure(
      `The merged file does not contain the expected ${plan.expectedStreams.video} video and ${plan.expectedStreams.audio} audio streams. ${KEPT}`,
    );
  }
  if (expected !== undefined && expected >= 10 && probe.durationSec !== undefined && probe.durationSec < expected / 2) {
    throw new MediaFailure(
      `The merged file is much shorter than the video (${Math.round(probe.durationSec)} of ${Math.round(expected)} seconds). ${KEPT}`,
    );
  }
  // FFmpeg's output carries no type; Chrome needs one to keep the file's extension (wrapping copies nothing).
  const typed = new Blob([data], { type: containerMimeType(media.container) });
  return { data: typed, container: media.container, ...(probe.durationSec !== undefined ? { durationSec: probe.durationSec } : {}) };
}
