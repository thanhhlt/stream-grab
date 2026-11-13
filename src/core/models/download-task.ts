import type { OutputFormat, SubtitleFormat, SubtitleMode } from '@/shared/settings/settings';
import type { MediaProtocol, ProgressiveContainer, RequestContext } from './detected-stream';
import type { MediaAnalysis, OutputContainer } from './media-info';

/**
 * How a progressive file (MP4/WebM, since 0.3.0) is fetched:
 * - `browser`: Chrome downloads the URL itself (chrome.downloads): the site's
 *   cookies, Chrome's own resume, but no Referer/Origin — declarativeNetRequest
 *   rules do not reach those requests (checked in Chrome 157).
 * - `extension`: the offscreen engine fetches the file with the page's
 *   Referer/Origin (the same DNR leases as segments) and hands it to Chrome as
 *   a blob: URL, like a merged video. Used when the server refused the
 *   browser's download and the task has a request context to replay.
 */
export const PROGRESSIVE_FETCHES = ['browser', 'extension'] as const;
export type ProgressiveFetch = (typeof PROGRESSIVE_FETCHES)[number];

export interface ProgressiveTaskInfo {
  container: ProgressiveContainer;
  fetch: ProgressiveFetch;
  /** Size the detection reported. Chrome receiving another size means another response (e.g. a hotlink placeholder). */
  bytes?: number;
  /** An interrupted Chrome download of this task that Chrome can resume (Retry continues it). */
  resumeId?: number;
}

/**
 * Lifecycle of a download task:
 *   queued → downloading → downloaded → processing → completed
 *                 ↘ failed / cancelled (from any non-final state)
 * `downloaded`: every segment is stored, waiting for FFmpeg. `processing`:
 * FFmpeg analyses and merges the stored segments, then Chrome saves the file
 * (stage `saving`). `completed`: the file is in the Downloads folder and the
 * segments are deleted.
 */
export const TASK_STATUSES = [
  'queued',
  'downloading',
  'downloaded',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Tasks in these states hold an output name and count as pending work. */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'downloading', 'downloaded', 'processing'];

/** Tasks the user can still cancel. */
export const CANCELLABLE_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'downloading', 'downloaded', 'processing'];

/** Tasks the user can retry. */
export const RETRYABLE_TASK_STATUSES: readonly TaskStatus[] = ['failed', 'cancelled'];

/** What the user asked for, from the popup. Validated by the service worker before a task is created. */
export interface DownloadRequest {
  tabId: number;
  streamId: string;
  /** VideoVariant.id from the stream's media summary. */
  variantId: string;
  /** Alternative audio tracks to include. */
  audioTrackIds: string[];
  /** WebVTT subtitle tracks to save with the video (0.7.0; absent from older popups). */
  subtitleTrackIds?: string[];
  /** Base file name without extension; empty → generated. */
  fileName: string;
}

/** A subtitle track chosen for a task (0.7.0). */
export interface TaskSubtitle {
  /** SubtitleTrack.id in the manifest; `track-N` for a progressive file's `<track>`; `page-N` for a page subtitle file (0.7.2). */
  id: string;
  name: string;
  language?: string;
  forced?: boolean;
  /**
   * The WebVTT file, when no manifest names it: a progressive file's `<track src>`, or a page
   * subtitle file (0.7.2, any protocol). Manifest renditions have none.
   */
  url?: string;
  /** Page subtitle files (0.7.2): seconds the page's player adds to the file's cue times. */
  offsetSec?: number;
}

/** Download progress of a task, reported by the engine. */
export interface TaskProgress {
  segmentsTotal: number;
  segmentsDone: number;
  /** Bytes stored so far. */
  bytes: number;
  /** Current speed over the last few seconds; 0 when idle. */
  bytesPerSecond: number;
  /** Tốc độ trung bình trượt (hàm mũ, ~10 s) để tính ETA ổn định (từ v0.2.0). */
  averageBytesPerSecond?: number;
  /** 0–100, by completed segments. */
  percent: number;
  /** Retried segment requests so far. */
  retries: number;
  startedAt: number;
  /** Segments an earlier run had stored, reused instead of downloaded again (counted in segmentsDone and bytes). */
  resumedSegments?: number;
  /**
   * Set by the service worker on progress carried over from an earlier run
   * (Retry, browser restart): what storage holds, not yet confirmed by the
   * engine. The engine's first report replaces it.
   */
  stale?: boolean;
  /**
   * Số liệu theo từng track (từ v0.2.0; progress lưu bởi v0.1.0 không có).
   * Dùng để ước lượng tổng dung lượng: plan tải hết track chính rồi mới tới
   * các track audio, nên trung bình bytes/segment của cả task bị lệch.
   */
  tracks?: TrackProgress[];
}

/** Tiến độ của một track: chỉ tính media segment (init segment rất nhỏ, không tính). */
export interface TrackProgress {
  trackId: string;
  segmentsTotal: number;
  segmentsDone: number;
  /** Bytes đã lưu của các media segment đã xong. */
  bytes: number;
  /**
   * Tổng dung lượng media segment của track khi manifest khai báo kích thước
   * của từng segment (byte range, không mã hoá) — kích thước biết chính xác.
   */
  declaredBytes?: number;
}

/**
 * A download, persisted in chrome.storage.local so it survives popup closes,
 * service-worker restarts and browser restarts. The page's request context
 * (Referer/Origin) is not stored here: it stays in session storage, so after
 * a browser restart it is gone and must be recovered from a new detection.
 */
export interface DownloadTask {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  statusMessage?: string;
  /** Set with a failed task whose failure has a one-click fix (media processing only). */
  failureReason?: MediaFailureReason;
  source: {
    protocol: MediaProtocol;
    /** Manifest URL (a progressive file: the file's URL) when the task was created (may carry a signed token). */
    manifestUrl: string;
    title: string;
    pageUrl?: string;
    tabId: number;
    streamId: string;
  };
  selection: {
    variantId: string;
    /** "1080p", "Audio only", "2.8 Mbps"… */
    variantLabel: string;
    width?: number;
    height?: number;
    bandwidth?: number;
    audioTrackIds: string[];
    audioTrackNames: string[];
    /** WebVTT subtitles saved with the video (0.7.0). */
    subtitles?: TaskSubtitle[];
    durationSec?: number;
  };
  output: {
    /** Sanitised base name without extension, unique among active tasks. */
    baseName: string;
    format: OutputFormat;
    /** Format of the subtitle files (0.7.0), from Settings when the task was created; set only with subtitles. */
    subtitleFormat?: SubtitleFormat;
    /** Where the subtitles go (0.7.0), from Settings when the task was created; HLS/DASH with subtitles only (progressive: files). */
    subtitleMode?: SubtitleMode;
    /** chrome.downloads ID of the merged file, from the moment Chrome starts saving it. */
    downloadId?: number;
    /** The saved file, once completed: full path as Chrome reports it, and size. */
    saved?: SavedFile;
    /** Subtitle files saved next to the video (0.7.0), one per chosen track, once the video is handed to Chrome. */
    subtitles?: SubtitleOutput[];
  };
  progress?: TaskProgress;
  /** Media processing progress, while `processing`. */
  processing?: MediaProgress;
  /** What FFmpeg found in the downloaded data (set when the merged file is handed to Chrome). */
  media?: MediaAnalysis;
  /** Completed task the user cleared from the Queue tab (it stays under Completed). */
  dismissed?: boolean;
  /** Progressive files only (0.3.0): no segments, no FFmpeg; the original file is saved as it is. */
  progressive?: ProgressiveTaskInfo;
}

export interface SavedFile {
  path: string;
  bytes: number;
  savedAt: number;
}

/**
 * A subtitle file of a task (0.7.0). It is saved after the video, named after
 * the video's final name: `url` waits for that (a blob: URL the engine holds,
 * merged videos only), `downloadId` follows Chrome's save, then `saved` or
 * `error` tell how it ended. A track that could not be made has only `error`.
 * `embedded`: the track is in the merged video; such an entry without `url`
 * has no file to save (Settings → subtitles in the video only).
 */
export interface SubtitleOutput {
  trackId: string;
  embedded?: true;
  url?: string;
  downloadId?: number;
  saved?: SavedFile;
  error?: string;
}

/**
 * A WebVTT file the page loaded on its own (0.7.2), saved with an HLS/DASH
 * video. Its cues are on the player's timeline: 0 is where the video starts.
 */
export interface PageSubtitleFile {
  /** TaskSubtitle.id (`page-N`). */
  id: string;
  url: string;
  name: string;
  language?: string;
  /** Seconds the page's player adds to the file's cue times. */
  offsetSec?: number;
}

/** What the engine needs to run one task; built by the service worker. */
export interface EngineTaskSpec {
  taskId: string;
  /** `progressive`: a file fetched by the engine (ProgressiveFetch `extension`); `file` is set and `manifestUrl` is the file's URL. */
  protocol: MediaProtocol;
  manifestUrl: string;
  context: RequestContext;
  variant: { id: string; height?: number; bandwidth?: number };
  audioTrackIds: string[];
  /** WebVTT subtitle tracks downloaded with the segments (0.7.0); absent when none. */
  subtitleTrackIds?: string[];
  /** HLS/DASH (0.7.2): the page's own WebVTT files, downloaded as one-file subtitle tracks. */
  pageSubtitles?: PageSubtitleFile[];
  /** Simultaneous segment requests (Settings, 1–16). */
  concurrency: number;
  file?: { container: ProgressiveContainer; bytes?: number };
}

/** Why a run failed, when the service worker may act on it (wording, recovery). */
export const FAILURE_REASONS = ['expired', 'disk-full'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * Why media processing failed, when the user has a one-click way out:
 * `mp4-unsupported`: Output format is MP4 and a track cannot be stored in it (Save as MKV).
 */
export const MEDIA_FAILURE_REASONS = ['mp4-unsupported'] as const;
export type MediaFailureReason = (typeof MEDIA_FAILURE_REASONS)[number];

/** Engine → service worker report. `progress` comes with every report; `outcome` once, at the end. */
export interface EngineReport {
  taskId: string;
  progress: TaskProgress;
  outcome?:
    | { status: 'downloaded' }
    | { status: 'failed'; message: string; reason?: FailureReason }
    | { status: 'cancelled' };
}

/**
 * Media processing stages: `waiting` (the service worker handed the task over,
 * the engine has not started it), `preparing` (reading the stored segments),
 * `loading` (FFmpeg is being loaded), `analysing` (FFmpeg reads each track),
 * `merging` (FFmpeg writes the file), `verifying` (FFmpeg reads the result),
 * `saving` (Chrome writes it to the Downloads folder).
 */
export const MEDIA_STAGES = ['waiting', 'preparing', 'loading', 'analysing', 'merging', 'verifying', 'saving'] as const;
export type MediaStage = (typeof MEDIA_STAGES)[number];

export interface MediaProgress {
  stage: MediaStage;
  /** Current step (1-based) and number of steps of the stage, e.g. track 2 of 3. */
  step: number;
  steps: number;
  /** 0–100 over the whole job. */
  percent: number;
  startedAt: number;
  /** What the step works on, e.g. an audio track's name. */
  detail?: string;
}

/** Media processing the engine runs for one downloaded task: analyse, merge, hand the file over for saving. */
export interface MediaTaskSpec {
  taskId: string;
  job: 'process';
  /** The task's output format, which decides the container. */
  format: OutputFormat;
  /** Written into the file's metadata. */
  title: string;
  /** Subtitle tracks were downloaded with the segments (0.7.0): how to time them, and the file format to write. */
  subtitles?: { protocol: 'hls' | 'dash'; format: SubtitleFormat; mode: SubtitleMode };
}

/**
 * Engine → service worker report on a media job. Success is not reported
 * here: the engine hands the merged file over with `engine/save`, and the
 * service worker follows Chrome's download of it.
 */
export interface MediaReport {
  taskId: string;
  progress: MediaProgress;
  outcome?:
    /** `discardedData`: the stored segments were unusable and are deleted (Retry downloads again). */
    | { status: 'failed'; message: string; discardedData?: boolean; reason?: MediaFailureReason }
    | { status: 'cancelled' };
}

/**
 * Engine → service worker: the merged file is ready at `url` (a blob: URL of
 * the offscreen document, valid until the engine is told to let go of it).
 * A progressive file fetched by the engine comes without `container` and
 * `media` (its task knows its container; FFmpeg never looked at it).
 */
export interface SaveRequest {
  taskId: string;
  url: string;
  container?: OutputContainer;
  /** Bytes. */
  size: number;
  media?: MediaAnalysis;
  /**
   * Merged videos with subtitles (0.7.0): each track's file as a blob: URL held
   * like the video's, or why it could not be made.
   */
  subtitles?: SubtitleFileRequest[];
}

/**
 * One chosen subtitle track of a merged video: `embedded` when it is in the
 * merged file, `url` (and `size`) for its separate file, or `error` when it is
 * neither.
 */
export interface SubtitleFileRequest {
  trackId: string;
  embedded?: true;
  url?: string;
  size?: number;
  error?: string;
}

/** Everything the engine should be running: downloads and media jobs. */
export interface EngineWork {
  downloads: EngineTaskSpec[];
  media: MediaTaskSpec[];
}
