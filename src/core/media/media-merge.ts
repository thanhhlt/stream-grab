import type { SegmentStorage } from '@/core/download/download-storage';
import type { MediaAnalysis, OutputContainer, TrackLayout } from '@/core/models/media-info';
import { containerMimeType } from './containers';
import { lastErrorLine, type FfmpegRunner } from './ffmpeg-job';
import { MediaFailure } from './media-analysis';
import { buildMergeJob, trackRuns, type MergeTrack } from './merge-plan';
import { parseProbeOutput, probeJob } from './probe';
import { prepareTrack } from './track-data';

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
  /** The file on disk to merge into (mergeFileName); without it the output streams into Blob parts. */
  outputFile?: string;
}

export interface MergedFile {
  data: Blob;
  container: OutputContainer;
  durationSec?: number;
  /** The file on disk `data` is (outputFile). */
  file?: string;
  /** Why `outputFile` could not be used. */
  fileError?: string;
}

const KEPT = 'Press Retry to try again; the downloaded segments are kept.';

/** The last line of FFmpeg's log that looks like a problem (for a failure message), if any. */
function notableLine(stderr: readonly string[]): string | undefined {
  for (let i = stderr.length - 1; i >= 0; i--) {
    const line = stderr[i]?.trim() ?? '';
    if (/error|invalid|impossible|could not|unable|non[- ]?monoton|discontinuity|corrupt|not found/i.test(line)) return line.replace(/^\/in\/[^:]+:\s*/, '');
  }
  return undefined;
}

/**
 * Merges a downloaded task into one file with FFmpeg (stream copy, see
 * buildMergeJob), then checks the result with ffprobe: it must contain the
 * planned audio and video streams, and not be grossly shorter than the video.
 * The file is never held in memory whole: FFmpeg writes it to `outputFile` on
 * disk, or streams it into Blob parts (SinkFs). The caller deletes the file
 * on disk, also when the merge fails.
 */
export async function mergeTask(taskId: string, options: MergeTaskOptions): Promise<MergedFile> {
  const { storage, signal, media } = options;
  const tracks: MergeTrack[] = [];
  for (const layout of options.layout) {
    const analysis = media.tracks.find((track) => track.trackId === layout.trackId);
    if (!analysis) throw new MediaFailure(`Internal error: no analysis for track ${layout.trackId}. ${KEPT}`);
    const parts = await storage.trackData(taskId, layout.trackId);
    signal.throwIfAborted();
    // Disguising picture headers dropped; timestamps that go back start a run of their own (track-data.ts).
    const { bySegment, resets } = await prepareTrack(layout, parts, signal);
    const split = resets.length > 0 ? { ...layout, discontinuityIndexes: [...layout.discontinuityIndexes, ...resets] } : layout;
    const runs = trackRuns(split).map((positions) => new Blob(positions.flatMap((position) => bySegment.get(position) ?? [])));
    tracks.push({ layout: split, analysis, runs });
  }

  const plan = buildMergeJob(tracks, { container: media.container, ...(options.title !== undefined ? { title: options.title } : {}) });
  const expected = plan.expectedSeconds;
  const job = options.outputFile !== undefined ? { ...plan.job, outputFiles: { [plan.outputName]: options.outputFile } } : plan.job;
  options.progress({ stage: 'merging', fraction: 0 });
  const result = await options.ffmpeg.run(job, {
    signal,
    stallTimeoutMs: options.stallTimeoutMs ?? 120_000,
    onProgress: (seconds) => {
      options.progress({ stage: 'merging', fraction: expected ? Math.min(1, seconds / expected) : 0 });
    },
  });
  const output = result.outputs.find((candidate) => candidate.name === plan.outputName);
  const data = output?.data;
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
    // What FFmpeg said about it helps tell why (a part it could not read, timestamps it had to fix).
    const said = notableLine(result.stderrTail);
    throw new MediaFailure(
      `The merged file is much shorter than the video (${Math.round(probe.durationSec)} of ${Math.round(expected)} seconds${said ? `; FFmpeg: ${said}` : ''}). ${KEPT}`,
    );
  }
  // Chrome needs a type to keep the file's extension: Blob parts have none, a file's comes from its name. Slicing copies nothing.
  const type = containerMimeType(media.container);
  const typed = data.type === type ? data : data.slice(0, data.size, type);
  return {
    data: typed,
    container: media.container,
    ...(probe.durationSec !== undefined ? { durationSec: probe.durationSec } : {}),
    ...(output?.file !== undefined ? { file: output.file } : {}),
    ...(output?.fileError !== undefined ? { fileError: output.fileError } : {}),
  };
}
