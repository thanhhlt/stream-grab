import { estimateDownload, type SizeEstimate } from '@/core/download/estimate';
import { extensionFor } from '@/core/download/file-name';
import { formatBitrate, variantLabel } from '@/core/download/labels';
import { freeBytesOf, type StorageEstimateLike } from '@/core/download/storage-space';
import { codecLabel, containerExtension } from '@/core/media/containers';
import type { DetectedStream, EncryptionKind, VariantSummary } from '@/core/models/detected-stream';
import type { DownloadTask, MediaProgress, TaskProgress, TaskStatus } from '@/core/models/download-task';
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
  // A progressive file (0.3.0) is one file: its progress is in bytes, never in segments.
  const file = task.progressive !== undefined;
  const kept =
    !file && progress && progress.segmentsDone > 0 ? `${progress.segmentsDone} / ${progress.segmentsTotal} segments already downloaded` : undefined;
  if (task.status === 'queued') return ['Waiting for a free download slot', kept].filter(Boolean).join(' · ');
  if (task.status === 'downloading') {
    if (file && !progress) return 'Starting the download…';
    // Carried over from an earlier run: the engine has not confirmed it yet.
    if (progress?.stale) return kept ? `Resuming · ${kept}` : 'Preparing: reading the segment list…';
    // Started, but the segment list is still being read.
    if (!progress?.segmentsTotal) return 'Preparing: reading the segment list…';
  }
  if (!progress) return undefined;
  let segments = `${progress.segmentsDone} / ${progress.segmentsTotal} segments`;
  if (task.status === 'failed' && progress.segmentsDone > 0) segments += ' kept';
  else if (progress.resumedSegments) segments += ` (${progress.resumedSegments} reused)`;
  const parts = [`${progress.percent.toFixed(1)}%`, ...(file ? [] : [segments]), formatBytes(progress.bytes)];
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

/**
 * Extension of the file the task will produce: a progressive file keeps its own container; otherwise the
 * analysed container once known, else the one its format implies.
 */
export function outputExtension(task: DownloadTask): string {
  if (task.progressive) return `.${task.progressive.container}`;
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

export type Tone = 'neutral' | 'progress' | 'accent' | 'success' | 'warning' | 'danger';

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

// ---------------------------------------------------------------------------
// v0.2.0: tiến độ chi tiết trong Queue, mục gọn trong Completed.
// ---------------------------------------------------------------------------

/** 19 → "~19 seconds", 290 → "~5 min", 4000 → "~1 h 7 min". */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1.5) return '~1 second';
  if (seconds < 59.5) return `~${Math.round(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `~${h} h` : `~${h} h ${m} min`;
}

/** Kích thước kèm dấu hiệu ước lượng: "181 MB", "~181 MB", "~181 MB+" (cận dưới). */
export function formatEstimatedBytes(bytes: number, estimate: Pick<SizeEstimate, 'exact' | 'partial'>): string {
  return `${estimate.exact ? '' : '~'}${formatBytes(bytes)}${estimate.partial ? '+' : ''}`;
}

/** Sáu trạng thái người dùng thấy; `downloaded` (chờ FFmpeg) thuộc giai đoạn xử lý. */
export type TaskPhase = 'pending' | 'downloading' | 'processing' | 'completed' | 'failed' | 'cancelled';

export function taskPhase(status: TaskStatus): TaskPhase {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'downloading':
      return 'downloading';
    case 'downloaded':
    case 'processing':
      return 'processing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

export const PHASE_VIEW: Record<TaskPhase, StatusView> = {
  pending: { label: 'Pending', tone: 'neutral' },
  downloading: { label: 'Downloading', tone: 'progress' },
  processing: { label: 'Processing', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
};

export const PARTIAL_ESTIMATE_NOTE = 'A track has not started downloading yet: its size is not included, so the total will be higher.';

/** Các con số hiển thị cho một lượt tải mạng. */
export interface DownloadStats {
  /** 0–100 theo số segment (như engine báo). */
  percent: number;
  /** "74 / 368 segments". */
  segments: string;
  /** "36.4 MB / ~181 MB" — hoặc chỉ "36.4 MB" khi chưa ước lượng được. */
  size: string;
  /** "~145 MB"; không có khi chưa ước lượng được hoặc đã xong. */
  remaining?: string;
  /** "7.4 MB/s"; "Stalled" khi không nhận được dữ liệu. */
  speed: string;
  /** "~19 seconds"; chỉ khi đủ dữ liệu. */
  eta?: string;
  retries?: string;
  /** "40 reused": segment của lần chạy trước được dùng lại. */
  reused?: string;
  /** Giải thích khi tổng là cận dưới. */
  note?: string;
  stalled: boolean;
}

/**
 * Thông số tải của một task đang chạy. `now`: thời điểm hiển thị (popup
 * cập nhật mỗi giây); `reportedAt`: thời điểm báo cáo cuối (task.updatedAt).
 */
export function downloadStats(progress: TaskProgress, timing: { now: number; reportedAt: number }): DownloadStats {
  const estimate = estimateDownload(progress, timing);
  const size = estimate.size;
  const stats: DownloadStats = {
    percent: progress.percent,
    segments: `${progress.segmentsDone} / ${progress.segmentsTotal} segments`,
    size: size && size.remaining > 0 ? `${formatBytes(progress.bytes)} / ${formatEstimatedBytes(size.total, size)}` : formatBytes(progress.bytes),
    speed: estimate.stalled ? 'Stalled' : formatSpeed(estimate.bytesPerSecond),
    stalled: estimate.stalled,
  };
  if (size && size.remaining > 0) stats.remaining = formatEstimatedBytes(size.remaining, size);
  if (size?.partial) stats.note = PARTIAL_ESTIMATE_NOTE;
  if (estimate.etaSec !== undefined) stats.eta = `${formatEta(estimate.etaSec)}${size?.partial ? '+' : ''}`;
  if (progress.retries > 0) stats.retries = `${progress.retries} ${progress.retries === 1 ? 'retry' : 'retries'}`;
  if (progress.resumedSegments) stats.reused = `${progress.resumedSegments} reused`;
  return stats;
}

/**
 * Nhãn gọn cho ô chọn chất lượng: "1080p", "720p60"; bitrate chỉ thêm khi
 * hai chất lượng trùng nhãn (vd. hai bản 720p) để vẫn phân biệt được.
 */
export function qualityOptions(variants: readonly VariantSummary[]): { id: string; label: string }[] {
  const labels = variants.map(variantLabel);
  return variants.map((variant, index) => {
    const label = labels[index] ?? '';
    const shared = labels.filter((other) => other === label).length > 1;
    return { id: variant.id, label: shared && variant.bandwidth !== undefined && !variant.audioOnly ? `${label} · ${formatBitrate(variant.bandwidth)}` : label };
  });
}

/** Tên bước FFmpeg, ngắn gọn, cho nhãn của thanh xử lý. */
export function processingStageLabel(processing: MediaProgress | undefined): string {
  switch (processing?.stage) {
    case undefined:
    case 'waiting':
      return 'Waiting for FFmpeg';
    case 'preparing':
      return 'Reading segments';
    case 'loading':
      return 'Loading FFmpeg';
    case 'analysing':
      return processing.steps > 1 ? `Analysing track ${processing.step} of ${processing.steps}` : 'Analysing';
    case 'merging':
      return 'Merging tracks';
    case 'verifying':
      return 'Verifying output';
    case 'saving':
      return 'Saving file';
  }
}

/** "1080p · English · 12:14" của một task (đi sau nhãn giao thức). */
export function taskMeta(task: DownloadTask): string {
  return [
    task.selection.variantLabel,
    ...task.selection.audioTrackNames,
    task.selection.durationSec ? formatDuration(task.selection.durationSec) : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** "Nov 6, 2026" theo locale của trình duyệt. */
export function formatCompletedDate(epochMs: number, locale?: string): string {
  return new Date(epochMs).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Chuẩn hoá để so sánh tiêu đề với tên file: bỏ phần mở rộng, hậu tố " (1)", ký tự không phải chữ/số. */
function comparable(text: string): string {
  return text
    .replace(/\.[a-z0-9]{2,4}$/i, '')
    .replace(/\s*\(\d+\)$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Tên file có nói thêm điều gì ngoài tiêu đề không (tên tự sinh = tiêu đề + chất lượng). */
export function fileNameAddsInfo(title: string, fileName: string): boolean {
  const name = comparable(fileName);
  const heading = comparable(title);
  return name.length > 0 && !(heading.length > 0 && name.startsWith(heading));
}

const CHANNEL_NAMES: Record<number, string> = { 1: 'Mono', 2: 'Stereo', 6: '5.1', 8: '7.1' };

export interface CompletedFacts {
  /** Dòng chính: độ phân giải · thời lượng · dung lượng file thật. */
  primary: string[];
  /** Dòng phụ: codec video · codec audio · container. */
  secondary: string[];
  /** Tên file khi nó khác tiêu đề (người dùng đặt tên riêng). */
  fileName?: string;
}

/**
 * Thông tin gọn của một video đã lưu. Độ phân giải, thời lượng và codec lấy
 * từ phân tích FFmpeg của chính dữ liệu đã tải; dung lượng là kích thước
 * file Chrome đã ghi (output.saved.bytes), không phải tổng byte segment.
 */
export function completedFacts(task: DownloadTask): CompletedFacts {
  const media = task.media;
  const streams = media?.tracks.flatMap((track) => track.streams) ?? [];
  const video = streams.find((stream) => stream.kind === 'video');
  const audioTracks = media?.tracks.filter((track) => track.streams.some((stream) => stream.kind === 'audio')) ?? [];
  const audio = audioTracks[0]?.streams.find((stream) => stream.kind === 'audio');

  let resolution = task.selection.variantLabel;
  if (video?.height !== undefined) resolution = variantLabel({ height: video.height, frameRate: video.frameRate, audioOnly: false });
  else if (media && !video && audio) resolution = 'Audio only';
  const durations = media?.tracks.map((track) => track.durationSec ?? 0).filter((value) => value > 0) ?? [];
  const duration = durations.length > 0 ? Math.max(...durations) : task.selection.durationSec;

  const primary = [resolution];
  if (duration !== undefined && duration > 0) primary.push(formatDuration(duration));
  if (task.output.saved) primary.push(formatBytes(task.output.saved.bytes));

  const secondary: string[] = [];
  if (video) secondary.push(codecLabel(video.codec));
  if (audio) {
    const layout = audio.channels !== undefined ? (CHANNEL_NAMES[audio.channels] ?? `${audio.channels} ch`) : undefined;
    secondary.push([codecLabel(audio.codec), layout].filter(Boolean).join(' '));
  }
  if (audioTracks.length > 1) secondary.push(`${audioTracks.length} audio tracks`);
  secondary.push(outputExtension(task).replace('.', '').toUpperCase());

  const facts: CompletedFacts = { primary, secondary };
  const fileName = outputFileName(task);
  if (fileNameAddsInfo(task.source.title, fileName)) facts.fileName = fileName;
  return facts;
}

export interface CompletedSummary {
  count: number;
  /** Tổng dung lượng các file đã lưu (kích thước thật). */
  bytes: number;
  /** File không còn ở chỗ Chrome đã lưu. */
  missing: number;
}

/** Tóm tắt tab Completed. `exists`: downloadId → file còn tồn tại (từ chrome.downloads.search). */
export function completedSummary(tasks: readonly DownloadTask[], exists: ReadonlyMap<number, boolean>): CompletedSummary {
  let bytes = 0;
  let missing = 0;
  for (const task of tasks) {
    bytes += task.output.saved?.bytes ?? 0;
    if (task.output.downloadId !== undefined && exists.get(task.output.downloadId) === false) missing += 1;
  }
  return { count: tasks.length, bytes, missing };
}
