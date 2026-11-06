import type { OutputFormat } from '@/shared/settings/settings';
import type { RequestContext, StreamingProtocol } from './detected-stream';
import type { MediaAnalysis, OutputContainer } from './media-info';

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
  /** Base file name without extension; empty → generated. */
  fileName: string;
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
  source: {
    protocol: StreamingProtocol;
    /** Manifest URL when the task was created (may carry a signed token). */
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
    durationSec?: number;
  };
  output: {
    /** Sanitised base name without extension, unique among active tasks. */
    baseName: string;
    format: OutputFormat;
    /** chrome.downloads ID of the merged file, from the moment Chrome starts saving it. */
    downloadId?: number;
    /** The saved file, once completed: full path as Chrome reports it, and size. */
    saved?: SavedFile;
  };
  progress?: TaskProgress;
  /** Media processing progress, while `processing`. */
  processing?: MediaProgress;
  /** What FFmpeg found in the downloaded data (set when the merged file is handed to Chrome). */
  media?: MediaAnalysis;
  /** Completed task the user cleared from the Queue tab (it stays under Completed). */
  dismissed?: boolean;
}

export interface SavedFile {
  path: string;
  bytes: number;
  savedAt: number;
}

/** What the engine needs to run one task; built by the service worker. */
export interface EngineTaskSpec {
  taskId: string;
  protocol: StreamingProtocol;
  manifestUrl: string;
  context: RequestContext;
  variant: { id: string; height?: number; bandwidth?: number };
  audioTrackIds: string[];
  /** Simultaneous segment requests (Settings, 1–16). */
  concurrency: number;
}

/** Why a run failed, when the service worker may act on it (wording, recovery). */
export const FAILURE_REASONS = ['expired', 'disk-full'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

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
    | { status: 'failed'; message: string; discardedData?: boolean }
    | { status: 'cancelled' };
}

/**
 * Engine → service worker: the merged file is ready at `url` (a blob: URL of
 * the offscreen document, valid until the engine is told to let go of it).
 */
export interface SaveRequest {
  taskId: string;
  url: string;
  container: OutputContainer;
  /** Bytes. */
  size: number;
  media: MediaAnalysis;
}

/** Everything the engine should be running: downloads and media jobs. */
export interface EngineWork {
  downloads: EngineTaskSpec[];
  media: MediaTaskSpec[];
}
