import { parseDownloadFolder } from '@/core/download/file-name';
import { ACTIVE_TASKS, SEGMENT_CONCURRENCY, type IntRange } from '@/shared/constants';
import { isOneOf, isRecord } from '@/shared/utils/guards';

export const RESOLUTION_PREFERENCES = ['highest', '2160', '1440', '1080', '720', '480', '360', 'lowest'] as const;
export type ResolutionPreference = (typeof RESOLUTION_PREFERENCES)[number];

/**
 * `auto`: MP4 when every stream can be stream-copied into MP4, otherwise MKV.
 * `mp4` / `mkv`: forced container (a task fails with a clear error if the
 * streams cannot be copied into MP4 without transcoding).
 */
export const OUTPUT_FORMATS = ['auto', 'mp4', 'mkv'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface Settings {
  /** Simultaneous segment requests per task (1–16). */
  segmentConcurrency: number;
  /** Tasks allowed to download segments at the same time (1–4). */
  maxActiveTasks: number;
  /** Variant picked by default when a stream offers several resolutions. */
  preferredResolution: ResolutionPreference;
  outputFormat: OutputFormat;
  /** Observe network traffic for supported media streams (every registered protocol). */
  autoDetect: boolean;
  /** Drop finished tasks from the queue view automatically (they stay in Completed). */
  autoRemoveCompleted: boolean;
  /** Subfolder of Chrome's download folder files are saved in, e.g. "StreamGrab/Movies"; '' saves in the folder itself. */
  downloadFolder: string;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  segmentConcurrency: SEGMENT_CONCURRENCY.default,
  maxActiveTasks: ACTIVE_TASKS.default,
  preferredResolution: 'highest',
  outputFormat: 'auto',
  autoDetect: true,
  autoRemoveCompleted: false,
  downloadFolder: '',
});

export function clampInt(value: unknown, range: IntRange, fallback: number = range.default): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/**
 * Turns anything read from storage (missing, stale schema, hand-edited, or
 * corrupted) into a valid Settings object. Invalid fields fall back to the
 * matching field of `fallback`; unknown fields are dropped.
 */
export function normalizeSettings(raw: unknown, fallback: Readonly<Settings> = DEFAULT_SETTINGS): Settings {
  const input = isRecord(raw) ? raw : {};
  const bool = (key: 'autoDetect' | 'autoRemoveCompleted'): boolean => {
    const value = input[key];
    return typeof value === 'boolean' ? value : fallback[key];
  };
  return {
    segmentConcurrency: clampInt(input['segmentConcurrency'], SEGMENT_CONCURRENCY, fallback.segmentConcurrency),
    maxActiveTasks: clampInt(input['maxActiveTasks'], ACTIVE_TASKS, fallback.maxActiveTasks),
    preferredResolution: isOneOf(input['preferredResolution'], RESOLUTION_PREFERENCES)
      ? input['preferredResolution']
      : fallback.preferredResolution,
    outputFormat: isOneOf(input['outputFormat'], OUTPUT_FORMATS) ? input['outputFormat'] : fallback.outputFormat,
    autoDetect: bool('autoDetect'),
    autoRemoveCompleted: bool('autoRemoveCompleted'),
    downloadFolder: folder(input['downloadFolder'], fallback.downloadFolder),
  };
}

function folder(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = parseDownloadFolder(value);
  return parsed.ok ? parsed.folder : fallback;
}

export function settingsEqual(a: Readonly<Settings>, b: Readonly<Settings>): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).every((key) => a[key] === b[key]);
}
