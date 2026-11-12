import type { SegmentStorage } from '@/core/download/download-storage';
import { isAbortError } from '@/core/download/retry-policy';
import type { MediaAnalysis, TrackLayout } from '@/core/models/media-info';
import { SUBTITLE_MIME_TYPES } from '@/core/download/subtitle-saves';
import { formatSrt, formatWebVtt, hlsCueOffsetSec, joinCues, parseWebVtt, type ParsedVtt, type VttCue } from '@/core/subtitles/webvtt';
import type { SubtitleFormat } from '@/shared/settings/settings';
import { errorMessage } from '@/shared/utils/errors';
import type { FfmpegRunner } from './ffmpeg-job';
import { trackRuns } from './merge-plan';
import { parseProbeOutput, probeJob } from './probe';
import { prepareTrack } from './track-data';

/** A subtitle track's cues on the merged file's timeline (not cut at its end yet), or why it could not be read. */
export type TimedSubtitle = { trackId: string; cues: VttCue[] } | { trackId: string; error: string };

export interface SubtitleCuesOptions {
  storage: SegmentStorage;
  ffmpeg: FfmpegRunner;
  signal: AbortSignal;
  /** The analysis and stored layout the video is merged from (analyseTask). */
  media: MediaAnalysis;
  layout: readonly TrackLayout[];
  /** HLS cues are timed by X-TIMESTAMP-MAP, DASH cues from the start of their period. */
  protocol: 'hls' | 'dash';
  /** Per ffprobe command. */
  timeoutMs?: number;
}

/** Where a run of the video starts in the merged file, its own first timestamp, and its length when probed. */
export interface RunTiming {
  firstPtsSec: number;
  runStartSec: number;
  durationSec?: number;
}

/** More joined runs than this are not probed one by one (the first run's timing is used). */
const MAX_PROBED_RUNS = 100;

/** More than any real subtitle track (a two-hour film is about 100 KB): something else was stored. */
const MAX_TRACK_BYTES = 32 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = { 'mpeg-ts': '.ts', fmp4: '.mp4', webm: '.webm', 'packed-audio': '.aac' };

const NOTHING_WITHIN = 'The subtitle track has no subtitles within the video.';

/** Cues cut at the video's end (undefined: not cut); throws when none is left. */
export function cuesWithin(cues: readonly VttCue[], durationSec: number | undefined): VttCue[] {
  const within = durationSec === undefined ? [...cues] : joinCues([{ cues, offsetSec: 0 }], durationSec);
  if (within.length === 0) throw new Error(NOTHING_WITHIN);
  return within;
}

/** A subtitle file of timed cues, cut at the video's end, as SubRip or WebVTT. */
export function subtitleFileData(cues: readonly VttCue[], format: SubtitleFormat, durationSec?: number): Blob {
  const within = cuesWithin(cues, durationSec);
  const text = format === 'srt' ? formatSrt(within) : formatWebVtt(within);
  return new Blob([text], { type: SUBTITLE_MIME_TYPES[format] });
}

/**
 * The cues of each subtitle track of a merged task: each track's stored
 * WebVTT segments are parsed one by one (each is a whole WebVTT file), their
 * cues moved onto the merged file's timeline and joined (repeats dropped,
 * split cues joined). They are cut at the video's end when written
 * (subtitleFileData) or embedded (mergeTask).
 *
 * Timeline (as buildMergeJob places the video): the main track starts at
 * its offset from the earliest track; joined runs follow each other, each
 * starting where the previous one ended (the concat demuxer). An HLS cue lands
 * at `runStart + MPEGTS/90000 − LOCAL − first PTS of the run + cue`; a DASH
 * cue at `runStart + cue`. The subtitle playlist's discontinuities are matched
 * with the video's in order; when they do not match, the first run's timing
 * is used for all (right whenever the video's timestamps do not restart).
 * Where the video's timestamps go back inside one run, an HLS segment goes to
 * the part its timestamps fit, nearest to where it falls in time.
 */
export async function buildSubtitleCues(taskId: string, options: SubtitleCuesOptions): Promise<TimedSubtitle[]> {
  const subtitles = options.layout.filter((track) => track.trackType === 'subtitle');
  if (subtitles.length === 0) return [];
  let timings: RunTiming[][];
  try {
    timings = await videoTimeline(taskId, options, subtitles.map((track) => trackRuns(track).length));
  } catch (error) {
    if (options.signal.aborted || isAbortError(error)) throw error;
    // Subtitles timed by the video's first run beat none.
    timings = [[firstTiming(options)]];
  }
  const timed: TimedSubtitle[] = [];
  for (const track of subtitles) {
    try {
      timed.push({ trackId: track.trackId, cues: await trackCues(taskId, track, timings, options) });
    } catch (error) {
      if (options.signal.aborted || isAbortError(error)) throw error;
      timed.push({ trackId: track.trackId, error: errorMessage(error) });
    }
  }
  return timed;
}

async function trackCues(taskId: string, track: TrackLayout, timings: RunTiming[][], options: SubtitleCuesOptions): Promise<VttCue[]> {
  const parts = await options.storage.trackData(taskId, track.trackId);
  options.signal.throwIfAborted();
  const bytes = parts.reduce((sum, part) => sum + part.data.size, 0);
  if (bytes > MAX_TRACK_BYTES) throw new Error('The subtitle track is too large to be text subtitles.');
  const { bySegment } = await prepareTrack(track, parts, options.signal);
  const groups = trackRuns(track);
  const lists: { cues: VttCue[]; offsetSec: number }[] = [];
  let unreadable = 0;
  // Where a segment falls in its run (its middle), roughly: segments of one playlist are about the same length.
  const segmentSec = track.durationSec / Math.max(1, track.segments);
  for (const [group, positions] of groups.entries()) {
    const runs = groupRuns(timings, groups.length, group);
    for (const [index, position] of positions.entries()) {
      const parsed = parseWebVtt(await new Blob(bySegment.get(position) ?? []).text());
      if (!parsed) {
        unreadable += 1;
        continue;
      }
      if (options.protocol !== 'hls') {
        lists.push({ cues: parsed.cues, offsetSec: runs[0]?.runStartSec ?? 0 });
        continue;
      }
      const timing = runs.length > 1 ? pickRun(runs, parsed, (runs[0]?.runStartSec ?? 0) + (index + 0.5) * segmentSec) : runs[0];
      const offsetSec = hlsCueOffsetSec(parsed.timestampMap, timing ?? { firstPtsSec: 0, runStartSec: 0 });
      lists.push({ cues: parsed.cues, offsetSec });
    }
  }
  if (lists.length === 0 && unreadable > 0) throw new Error('The subtitle track is not WebVTT.');
  const cues = joinCues(lists);
  if (cues.length === 0) throw new Error(NOTHING_WITHIN);
  return cues;
}

/** The video's merged runs for subtitle run `group` of `groups`: the video run in the same place, else the first one. */
function groupRuns(timings: RunTiming[][], groups: number, group: number): RunTiming[] {
  const byGroup = timings.length === groups ? timings[group] : undefined;
  if (byGroup && byGroup.length > 0) return byGroup;
  return timings[0]?.length ? timings[0] : [{ firstPtsSec: 0, runStartSec: 0 }];
}

/**
 * The merged run an HLS segment belongs to, among parts of one manifest run
 * (timestamps went back inside it): those its first cue fits in, by its
 * X-TIMESTAMP-MAP, and of these the nearest to `estimateSec`.
 */
function pickRun(runs: readonly RunTiming[], parsed: ParsedVtt, estimateSec: number): RunTiming | undefined {
  const cue = parsed.cues[0];
  const fits = cue
    ? runs.filter((run) => {
        const at = hlsCueOffsetSec(parsed.timestampMap, run) + cue.start;
        return at >= run.runStartSec - 1 && at <= run.runStartSec + (run.durationSec ?? Infinity) + 1;
      })
    : [];
  const distance = (run: RunTiming) => {
    const end = run.runStartSec + (run.durationSec ?? 0);
    return estimateSec < run.runStartSec ? run.runStartSec - estimateSec : Math.max(0, estimateSec - end);
  };
  return [...(fits.length > 0 ? fits : runs)].sort((a, b) => distance(a) - distance(b))[0];
}

/** The main track's place in the merge (its -itsoffset, as buildMergeJob) and first timestamp. */
function firstTiming({ media, layout }: Pick<SubtitleCuesOptions, 'media' | 'layout'>): RunTiming {
  const main = mainTrack(layout);
  const starts = media.tracks.map((track) => track.startSec).filter((start) => start !== undefined);
  const earliest = starts.length > 0 ? Math.min(...starts) : 0;
  const mainStart = media.tracks.find((track) => track.trackId === main?.trackId)?.startSec ?? earliest;
  return { firstPtsSec: mainStart, runStartSec: mainStart - earliest };
}

const mainTrack = (layout: readonly TrackLayout[]) =>
  layout.find((track) => track.trackType === 'main') ?? layout.find((track) => track.trackType !== 'subtitle');

/**
 * The timing of each of the video's manifest runs (discontinuities and
 * initialization segments), as one list per run whose first entry is the
 * run's first part in the merge (a run is split further where timestamps go
 * back, track-data.ts). Several merged runs are each probed: the concat
 * demuxer places a run after the previous one by the duration FFmpeg finds,
 * and only FFmpeg knows it. Runs are probed only when a subtitle track can
 * use them (its runs match the video's, or timestamps go back inside a run),
 * and at most MAX_PROBED_RUNS; otherwise, or when probing fails, the first
 * run's timing is used for all.
 */
export async function videoTimeline(
  taskId: string,
  options: Pick<SubtitleCuesOptions, 'storage' | 'ffmpeg' | 'signal' | 'media' | 'layout' | 'timeoutMs'>,
  subtitleRuns: readonly number[],
): Promise<RunTiming[][]> {
  const { signal } = options;
  const main = mainTrack(options.layout);
  const start = firstTiming(options);
  const offset = start.runStartSec;
  const first: RunTiming[][] = [[start]];
  if (!main) return first;

  const parts = await options.storage.trackData(taskId, main.trackId);
  signal.throwIfAborted();
  const { bySegment, resets } = await prepareTrack(main, parts, signal);
  const split = resets.length > 0 ? { ...main, discontinuityIndexes: [...main.discontinuityIndexes, ...resets] } : main;
  const merged = trackRuns(split);
  const groups = trackRuns(main);
  const useful = merged.length > groups.length || subtitleRuns.some((runs) => runs === groups.length);
  if (merged.length <= 1 || !useful || merged.length > MAX_PROBED_RUNS) return groups.map(() => first[0] ?? []);

  const timed: RunTiming[] = [];
  let runStartSec = offset;
  for (const [index, positions] of merged.entries()) {
    const name = `run-${index + 1}${EXTENSIONS[main.container] ?? '.bin'}`;
    try {
      const result = await options.ffmpeg.run(probeJob(name, new Blob(positions.flatMap((position) => bySegment.get(position) ?? []))), {
        signal,
        timeoutMs: options.timeoutMs ?? 120_000,
      });
      const probe = parseProbeOutput(result.stdout);
      if (probe?.startSec === undefined || probe.durationSec === undefined) return groups.map(() => first[0] ?? []);
      timed.push({ firstPtsSec: probe.startSec, runStartSec, durationSec: probe.durationSec });
      runStartSec += probe.durationSec;
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error;
      return groups.map(() => first[0] ?? []);
    }
  }
  // A manifest run's merged parts: those starting at or after its first position, before the next run's.
  const firstPosition = (positions: readonly number[]) => positions.find((position) => !main.initIndexes.includes(position)) ?? positions[0] ?? 0;
  const mergedStarts = merged.map(firstPosition);
  const groupStarts = groups.map(firstPosition);
  return groupStarts.map((start, group) => {
    const end = groupStarts[group + 1] ?? Infinity;
    return timed.filter((_, index) => (mergedStarts[index] ?? -1) >= start && (mergedStarts[index] ?? Infinity) < end);
  });
}
