import { extensionFor } from '@/core/download/file-name';
import { formatBitrate, variantLabel } from '@/core/download/labels';
import { freeBytesOf, type StorageEstimateLike } from '@/core/download/storage-space';
import { codecLabel, containerExtension } from '@/core/media/containers';
import type { DetectedStream, EncryptionKind } from '@/core/models/detected-stream';
import type { DownloadTask, MediaProgress } from '@/core/models/download-task';
import type { MediaAnalysis, MediaStreamInfo } from '@/core/models/media-info';
import { codecDisplayName } from '@/core/protocols/codecs';
import { formatBytes } from '@/shared/utils/bytes';
import { fileNameOf, hostnameOf } from '@/shared/utils/url';

export { formatBitrate, formatBytes, variantLabel };

/** Title, or the manifest file name, or its host: some identifier is always shown. */
export function streamLabel(stream: DetectedStream): string {
  return stream.title ?? (fileNameOf(stream.url) || hostnameOf(stream.url) || 'Untitled stream');
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * The line under a queue entry: what it waits for, or how far it got. Stored
 * segments are reported as they are: a retried or interrupted download shows
 * what it keeps before it resumes, and segments reused from an earlier run
 * count as done but not as speed.
 */
export function taskProgressLine(task: DownloadTask): string | undefined {
  if (task.status === 'processing') return processingLine(task.processing);
  if (task.status === 'completed') return task.output.saved ? `Saved · ${formatBytes(task.output.saved.bytes)}` : 'Saved';
  const progress = task.progress;
  const kept =
    progress && progress.segmentsDone > 0 ? `${progress.segmentsDone} / ${progress.segmentsTotal} segments already downloaded` : undefined;
  if (task.status === 'queued') return ['Waiting for a free download slot', kept].filter(Boolean).join(' · ');
  if (task.status === 'downloading') {
    // Carried over from an earlier run: the engine has not confirmed it yet.
    if (progress?.stale) return kept ? `Resuming · ${kept}` : 'Preparing: reading the segment list…';
    // Started, but the segment list is still being read.
    if (!progress?.segmentsTotal) return 'Preparing: reading the segment list…';
  }
  if (!progress) return undefined;
  let segments = `${progress.segmentsDone} / ${progress.segmentsTotal} segments`;
  if (task.status === 'failed' && progress.segmentsDone > 0) segments += ' kept';
  else if (progress.resumedSegments) segments += ` (${progress.resumedSegments} reused)`;
  const parts = [`${progress.percent.toFixed(1)}%`, segments, formatBytes(progress.bytes)];
  if (task.status === 'downloading') parts.push(formatSpeed(progress.bytesPerSecond));
  if (progress.retries > 0) parts.push(`${progress.retries} ${progress.retries === 1 ? 'retry' : 'retries'}`);
  return parts.join(' · ');
}

/** What FFmpeg is doing for a `processing` task. */
export function processingLine(processing: MediaProgress | undefined): string {
  switch (processing?.stage) {
    case undefined:
    case 'waiting':
      return 'Waiting for FFmpeg…';
    case 'preparing':
      return 'Reading the downloaded segments…';
    case 'loading':
      return 'Loading FFmpeg…';
    case 'analysing': {
      const of = processing.steps > 1 ? ` (${processing.step} of ${processing.steps})` : '';
      const what = processing.detail ? `"${processing.detail}"` : processing.step === 1 ? 'the video' : 'the audio';
      return `FFmpeg is checking ${what}${of}…`;
    }
    case 'merging':
      return `Merging the tracks into one file · ${processing.percent}%`;
    case 'verifying':
      return 'Checking the merged file…';
    case 'saving':
      return 'Saving to the Downloads folder…';
  }
}

/** "C:\Users\me\Downloads\Movie (1).mp4" → "Movie (1).mp4". */
export function pathFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** The output file name: as saved once completed, else as planned. */
export function outputFileName(task: DownloadTask): string {
  return task.output.saved ? pathFileName(task.output.saved.path) : `${task.output.baseName}${outputExtension(task)}`;
}

/** "6 Nov, 14:05" in the user's locale. */
export function formatSavedAt(epochMs: number, locale?: string): string {
  return new Date(epochMs).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Completed tasks, most recently saved first. */
export function completedTasks(tasks: readonly DownloadTask[]): DownloadTask[] {
  return tasks
    .filter((task) => task.status === 'completed')
    .sort((a, b) => (b.output.saved?.savedAt ?? b.updatedAt) - (a.output.saved?.savedAt ?? a.updatedAt));
}

const CHANNEL_LAYOUTS: Record<number, string> = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };

function mediaStreamLabel(stream: MediaStreamInfo): string {
  const codec = codecLabel(stream.codec);
  if (stream.kind === 'video') {
    return stream.width !== undefined && stream.height !== undefined ? `${codec} ${stream.width}×${stream.height}` : codec;
  }
  if (stream.channels === undefined) return codec;
  return `${codec} ${CHANNEL_LAYOUTS[stream.channels] ?? `${stream.channels} ch`}`;
}

/**
 * One line of what FFmpeg found and what the merge will write:
 * "H.264 1280×720 · AAC stereo · English: AAC 5.1 → MP4".
 */
export function mediaSummary(media: MediaAnalysis): string {
  const parts: string[] = [];
  for (const track of media.tracks) {
    const streams = track.streams.filter((stream) => stream.kind === 'video' || stream.kind === 'audio').map(mediaStreamLabel);
    if (streams.length === 0) continue;
    const label = streams.join(' · ');
    parts.push(track.trackType === 'audio' && track.name ? `${track.name}: ${label}` : label);
  }
  return `${parts.join(' · ')} → ${media.container.toUpperCase()}`;
}

/** Extension of the file the task will produce: the analysed container once known, else the one its format implies. */
export function outputExtension(task: DownloadTask): string {
  return task.media ? containerExtension(task.media.container) : extensionFor(task.output.format);
}

export interface StorageLine {
  text: string;
  /** Less than twice the reserve is free: downloads will stop soon. */
  low: boolean;
}

/** Disk use of the downloaded segments and the space left, from navigator.storage.estimate(). */
export function storageLine(estimate: StorageEstimateLike, reserveBytes: number): StorageLine | undefined {
  const free = freeBytesOf(estimate);
  if (free === undefined) return undefined;
  if (free < reserveBytes * 2) {
    return {
      text: `Low disk space: ${formatBytes(free)} free. Downloads stop while less than ${formatBytes(reserveBytes)} is left.`,
      low: true,
    };
  }
  return { text: `Downloaded data: ${formatBytes(estimate.usage ?? 0)} · ${formatBytes(free)} free`, low: false };
}

export interface OverallProgress {
  running: number;
  /** Undefined while no running download knows its segment count yet. */
  percent: number | undefined;
  bytesPerSecond: number;
}

/** Combined progress of the running downloads, weighted by segment count. */
export function overallProgress(tasks: readonly DownloadTask[]): OverallProgress {
  let running = 0;
  let done = 0;
  let total = 0;
  let bytesPerSecond = 0;
  for (const task of tasks) {
    if (task.status !== 'downloading') continue;
    running += 1;
    done += task.progress?.segmentsDone ?? 0;
    total += task.progress?.segmentsTotal ?? 0;
    bytesPerSecond += task.progress?.bytesPerSecond ?? 0;
  }
  // Floored like each task's own percentage, so 100% only shows once everything is in.
  const percent = total === 0 ? undefined : Math.floor((done / total) * 1000) / 10;
  return { running, percent, bytesPerSecond };
}

export type Tone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface StatusView {
  label: string;
  tone: Tone;
}

export function statusView(stream: DetectedStream): StatusView {
  switch (stream.status) {
    case 'pending':
      return { label: 'Inspecting…', tone: 'progress' };
    case 'ready':
      return { label: 'Ready', tone: 'success' };
    case 'drm':
      return { label: 'DRM · not supported', tone: 'danger' };
    case 'error':
      return { label: 'Unavailable', tone: 'warning' };
  }
}

const ENCRYPTION_LABELS: Record<Exclude<EncryptionKind, 'none'>, string> = {
  'aes-128': 'AES-128',
  'sample-aes': 'SAMPLE-AES',
  cenc: 'Encrypted',
};

export interface MediaFacts {
  qualities?: string;
  codecs?: string;
  audio?: string;
  durationSec?: number;
}

const MAX_QUALITY_LABELS = 6;

function unique(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== undefined))];
}

/** One-line facts about a parsed stream: qualities, codecs, audio tracks, duration. */
export function mediaFacts(stream: DetectedStream): MediaFacts {
  const facts: MediaFacts = {};
  const duration = stream.media?.durationSec ?? stream.durationHint;
  if (duration !== undefined && duration > 0) facts.durationSec = duration;
  const media = stream.media;
  if (!media) return facts;

  const labels = unique(media.variants.map(variantLabel));
  if (labels.length > 0 && !(labels.length === 1 && labels[0] === 'Single quality')) {
    const shown = labels.slice(0, MAX_QUALITY_LABELS);
    const more = labels.length - shown.length;
    facts.qualities = shown.join(' · ') + (more > 0 ? ` +${more}` : '');
  }
  const codecs = unique([
    ...media.variants.map((variant) => (variant.videoCodec ? codecDisplayName(variant.videoCodec) : undefined)),
    ...media.variants.map((variant) => (variant.audioCodec ? codecDisplayName(variant.audioCodec) : undefined)),
    // DASH declares audio codecs per audio track rather than per variant.
    ...media.audioTracks.map((track) => (track.codec ? codecDisplayName(track.codec) : undefined)),
  ]);
  if (codecs.length > 0) facts.codecs = codecs.join(' · ');
  if (media.audioTracks.length > 0) {
    // The same rendition is often listed once per bitrate group; show each name once.
    const names = unique(media.audioTracks.map((track) => track.name));
    // Names may contain commas ("Français, stéréo"), so separate them with slashes.
    facts.audio = `${names.length} audio ${names.length === 1 ? 'track' : 'tracks'}: ${names.join(' / ')}`;
  }
  return facts;
}

/** Secondary facts shown as small badges. */
export function streamTags(stream: DetectedStream): string[] {
  const tags: string[] = [];
  const manifest = stream.manifest;
  // Once qualities are listed, "Multi-quality" says nothing new.
  if (manifest?.role === 'master' && !stream.media) tags.push('Multi-quality');
  if (manifest?.live) tags.push('Live');
  if (manifest && manifest.encryption !== 'none' && stream.status !== 'drm') {
    tags.push(ENCRYPTION_LABELS[manifest.encryption]);
  }
  return tags;
}
