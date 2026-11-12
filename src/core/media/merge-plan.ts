import type { OutputContainer, TrackAnalysis, TrackLayout } from '@/core/models/media-info';
import type { ContainerFormat } from '@/core/models/media-segment';
import { inputPath, outputPath, type FfmpegInput, type FfmpegJob } from './ffmpeg-job';
import { iso6392 } from './languages';

/**
 * How a download's tracks become one file: pure planning, no FFmpeg.
 *
 * A track's stored segments are not always one valid stream when joined
 * byte for byte. They are, within a "run":
 * - MPEG-TS and packed audio: segments between two discontinuities (where
 *   timestamps may restart or the encoding change);
 * - fragmented MP4 and WebM: an initialization segment followed by the
 *   fragments that use it, again cut at discontinuities (a run that starts
 *   without its own init segment gets the current one prepended).
 * One run is one input as is; several runs are joined by FFmpeg's concat
 * demuxer, which places each run after the previous one in time, so
 * timestamp resets do not fold the video back on itself.
 */

/** Segment positions of each run of a track (init segments included where a run needs one). */
export function trackRuns(layout: TrackLayout): number[][] {
  const inits = new Set(layout.initIndexes);
  const splits = new Set([...layout.initIndexes, ...layout.discontinuityIndexes].filter((position) => position > 0));
  const runs: number[][] = [];
  let run: number[] = [];
  let init: number | undefined;
  for (let position = 0; position < layout.segments; position++) {
    if (splits.has(position) && run.length > 0) {
      runs.push(run);
      run = [];
    }
    if (inits.has(position)) init = position;
    else if (run.length === 0 && init !== undefined) run.push(init);
    run.push(position);
  }
  if (run.length > 0) runs.push(run);
  // A run of nothing but an init segment carries no media.
  return runs.filter((positions) => positions.some((position) => !inits.has(position)));
}

export interface MergeTrack {
  layout: TrackLayout;
  analysis: TrackAnalysis;
  /** The track's runs (trackRuns), each one Blob of its segments in order. */
  runs: Blob[];
}

/** A subtitle track to embed (0.7.0): WebVTT on the merged file's timeline, cut at its end (subtitle-files.ts). */
export interface MergeSubtitle {
  data: Blob;
  language?: string;
  name?: string;
}

export interface MergeOptions {
  container: OutputContainer;
  /** Written as the file's title. */
  title?: string;
  /** Embedded after the audio, in order. */
  subtitles?: readonly MergeSubtitle[];
}

export interface MergePlan {
  job: FfmpegJob;
  outputName: string;
  /** Longest track, offsets included; undefined when no track knows its duration. */
  expectedSeconds: number | undefined;
  /** Streams the merged file must contain. */
  expectedStreams: { video: number; audio: number; subtitle: number };
}

/** Where each track starts in the merged file (its -itsoffset): after the earliest track's start. */
function trackOffsets(tracks: readonly MergeTrack[]): number[] {
  const starts = tracks.map((track) => track.analysis.startSec).filter((start) => start !== undefined);
  const earliest = starts.length > 0 ? Math.min(...starts) : 0;
  return tracks.map((track) => (track.analysis.startSec ?? earliest) - earliest);
}

/** Longest track, offsets included (the merged file's expected length); undefined when no track knows its duration. */
export function mergedSeconds(tracks: readonly MergeTrack[]): number | undefined {
  const offsets = trackOffsets(tracks);
  let expected: number | undefined;
  tracks.forEach((track, index) => {
    // Joined runs: the manifest's sum is the better figure (the probe saw the first run's timing only).
    const duration = track.runs.length > 1 && track.layout.durationSec > 0 ? track.layout.durationSec : (track.analysis.durationSec ?? track.layout.durationSec);
    if (duration > 0) expected = Math.max(expected ?? 0, (offsets[index] ?? 0) + duration);
  });
  return expected;
}

const EXTENSIONS: Record<ContainerFormat, string> = {
  'mpeg-ts': '.ts',
  fmp4: '.mp4',
  webm: '.webm',
  'packed-audio': '.aac',
  webvtt: '.vtt',
  unknown: '.bin',
};

/** Metadata values are passed as arguments (no shell), but control characters do not belong in a title. */
const metadataText = (value: string): string =>
  value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/**
 * The FFmpeg command that merges the tracks by stream copy:
 *
 * - inputs: the main track first (its video, and its audio when muxed), then
 *   each alternative audio track; several runs go through the concat demuxer;
 * - timing: FFmpeg starts every input at 0, so each input is offset by how
 *   much later than the earliest track it started (`-itsoffset`), keeping
 *   separately delivered audio in sync with the video;
 * - streams: video (not cover art) and audio only; data streams (timed ID3,
 *   SCTE-35) and subtitles of the segments are dropped; chosen WebVTT
 *   subtitles (0.7.0) are added as inputs of their own, copied into MKV,
 *   converted to mov_text in MP4, with language and name, none default
 *   (MP4: FFmpeg enables the first one);
 * - metadata: the title, each audio track's language (ISO 639-2) and name
 *   (in MP4 as the handler name, which players show as the track's name),
 *   the first audio track as default; the inputs' own tags are not copied;
 * - MP4: HEVC is tagged `hvc1` (what Apple players require). No "faststart":
 *   moving the index to the front would mean rewriting the whole file.
 */
export function buildMergeJob(tracks: readonly MergeTrack[], options: MergeOptions): MergePlan {
  const inputs: FfmpegInput[] = [];
  const args = ['-hide_banner', '-stats'];
  const offsets = trackOffsets(tracks);
  const subtitles = options.subtitles ?? [];

  tracks.forEach((track, index) => {
    const prefix = `t${index + 1}`;
    const ext = EXTENSIONS[track.layout.container];
    const offset = offsets[index] ?? 0;
    if (offset > 0.0005) args.push('-itsoffset', offset.toFixed(3));
    if (track.runs.length === 1 && track.runs[0]) {
      const name = `${prefix}${ext}`;
      inputs.push({ name, data: track.runs[0] });
      args.push('-i', inputPath(name));
    } else {
      const names = track.runs.map((_, run) => `${prefix}r${run + 1}${ext}`);
      track.runs.forEach((data, run) => inputs.push({ name: names[run] ?? '', data }));
      const list = ['ffconcat version 1.0', ...names.map((name) => `file '${inputPath(name)}'`)].join('\n');
      const listName = `${prefix}.ffconcat`;
      inputs.push({ name: listName, data: new Blob([`${list}\n`]) });
      args.push('-f', 'concat', '-safe', '0', '-i', inputPath(listName));
    }
  });
  // Subtitles are written on the merged file's timeline already: no -itsoffset (FFmpeg does not move them to 0).
  subtitles.forEach((subtitle, index) => {
    const name = `s${index + 1}.vtt`;
    inputs.push({ name, data: subtitle.data });
    args.push('-f', 'webvtt', '-i', inputPath(name));
  });

  // Streams: the main track's video and muxed audio, then each audio track, then the subtitles.
  args.push('-map', '0:V?', '-map', '0:a?');
  for (let index = 1; index < tracks.length; index++) args.push('-map', `${index}:a`);
  subtitles.forEach((_, index) => args.push('-map', `${tracks.length + index}:s`));
  args.push('-c', 'copy');
  // Matroska keeps WebVTT as it is; MP4 stores text subtitles as mov_text (3GPP timed text).
  if (subtitles.length > 0 && options.container === 'mp4') args.push('-c:s', 'mov_text');
  args.push('-map_metadata', '-1', '-max_muxing_queue_size', '4096');
  const title = options.title ? metadataText(options.title) : '';
  if (title !== '') args.push('-metadata', `title=${title}`);

  let audio = 0;
  tracks.forEach((track, index) => {
    const streams = track.analysis.streams.filter((stream) => stream.kind === 'audio');
    for (const stream of streams) {
      // The manifest knows an alternative track's language and name better than its segments do.
      const language = iso6392(index > 0 ? (track.layout.language ?? stream.language) : stream.language);
      if (language !== undefined) args.push(`-metadata:s:a:${audio}`, `language=${language}`);
      // A name that is only the language code ("en", what DASH gives unlabeled tracks) says nothing more.
      const layoutName = track.layout.name ?? '';
      const name = index > 0 && layoutName.toLowerCase() !== (track.layout.language ?? '').toLowerCase() ? metadataText(layoutName) : '';
      if (name !== '') {
        args.push(`-metadata:s:a:${audio}`, `title=${name}`);
        // MP4 has no track title: players show the handler name instead.
        if (options.container === 'mp4') args.push(`-metadata:s:a:${audio}`, `handler_name=${name}`);
      }
      args.push(`-disposition:a:${audio}`, audio === 0 ? 'default' : '0');
      audio += 1;
    }
  });
  subtitles.forEach((subtitle, index) => {
    const language = iso6392(subtitle.language);
    if (language !== undefined) args.push(`-metadata:s:s:${index}`, `language=${language}`);
    const name = subtitle.name !== undefined && subtitle.name.toLowerCase() !== (subtitle.language ?? '').toLowerCase() ? metadataText(subtitle.name) : '';
    if (name !== '') args.push(`-metadata:s:s:${index}`, options.container === 'mp4' ? `handler_name=${name}` : `title=${name}`);
    // None is default in MKV. FFmpeg's MP4 muxer enables the first track of each kind whatever is asked.
    args.push(`-disposition:s:${index}`, '0');
  });
  const main = tracks[0]?.analysis.streams ?? [];
  const video = main.filter((stream) => stream.kind === 'video').length;
  if (options.container === 'mp4' && main.some((stream) => stream.kind === 'video' && stream.codec === 'hevc')) args.push('-tag:v', 'hvc1');

  const outputName = `output.${options.container}`;
  args.push('-f', options.container === 'mp4' ? 'mp4' : 'matroska', outputPath(outputName));
  return {
    job: { tool: 'ffmpeg', args, inputs, outputs: [outputName] },
    outputName,
    expectedSeconds: mergedSeconds(tracks),
    expectedStreams: { video, audio, subtitle: subtitles.length },
  };
}
