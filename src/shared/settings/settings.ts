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

/** Format of subtitle files saved next to a video (0.7.0): SubRip by default (most players read it), or WebVTT as served. */
export const SUBTITLE_FORMATS = ['srt', 'vtt'] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];

/**
 * Where chosen subtitles of an HLS/DASH video go (0.7.0): `file` saves each as
 * a file next to the video, `embed` puts them into the merged MKV/MP4 (a track
 * that cannot be embedded is saved as a file instead), `both` does both.
 * Progressive files are never merged: their subtitles are always files.
 */
export const SUBTITLE_MODES = ['file', 'embed', 'both'] as const;
export type SubtitleMode = (typeof SUBTITLE_MODES)[number];

/** Most languages kept in Settings → default subtitle languages. */
export const MAX_SUBTITLE_LANGUAGES = 8;

/** Popup color theme: `system` follows Chrome's appearance setting (prefers-color-scheme). */
export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export interface Settings {
  /** Simultaneous segment requests per task (1–16). */
  segmentConcurrency: number;
  /** Tasks allowed to download segments at the same time (1–4). */
  maxActiveTasks: number;
  /** Variant picked by default when a stream offers several resolutions. */
  preferredResolution: ResolutionPreference;
  outputFormat: OutputFormat;
  /** Subtitle files saved next to a video (0.7.0). */
  subtitleFormat: SubtitleFormat;
  /** Where chosen subtitles go (0.7.0). */
  subtitleMode: SubtitleMode;
  /**
   * Subtitle languages preselected in the Detected tab (0.7.0), as language
   * tags in order, "en, vi" (normalizeSubtitleLanguages); '' preselects none.
   */
  subtitleLanguages: string;
  /** Observe network traffic for supported media streams (every registered protocol). */
  autoDetect: boolean;
  /** Drop finished tasks from the queue view automatically (they stay in Completed). */
  autoRemoveCompleted: boolean;
  /** Subfolder of Chrome's download folder files are saved in, e.g. "StreamGrab/Movies"; '' saves in the folder itself. */
  downloadFolder: string;
  /** Popup color theme. Presentation only; the background ignores it. */
  theme: Theme;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  segmentConcurrency: SEGMENT_CONCURRENCY.default,
  maxActiveTasks: ACTIVE_TASKS.default,
  preferredResolution: 'highest',
  outputFormat: 'auto',
  subtitleFormat: 'srt',
  subtitleMode: 'file',
  subtitleLanguages: '',
  autoDetect: true,
  autoRemoveCompleted: false,
  downloadFolder: '',
  theme: 'system',
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
    subtitleFormat: isOneOf(input['subtitleFormat'], SUBTITLE_FORMATS) ? input['subtitleFormat'] : fallback.subtitleFormat,
    subtitleMode: isOneOf(input['subtitleMode'], SUBTITLE_MODES) ? input['subtitleMode'] : fallback.subtitleMode,
    subtitleLanguages:
      typeof input['subtitleLanguages'] === 'string' ? normalizeSubtitleLanguages(input['subtitleLanguages']) : fallback.subtitleLanguages,
    autoDetect: bool('autoDetect'),
    autoRemoveCompleted: bool('autoRemoveCompleted'),
    downloadFolder: folder(input['downloadFolder'], fallback.downloadFolder),
    theme: isOneOf(input['theme'], THEMES) ? input['theme'] : fallback.theme,
  };
}

/**
 * Language tags typed by the user ("EN; pt-br, vi") as Settings keeps them:
 * "en, pt-BR, vi". Separators are commas, semicolons or spaces; what is not a
 * language tag is dropped, and so are repeats; at most MAX_SUBTITLE_LANGUAGES.
 */
export function normalizeSubtitleLanguages(value: string): string {
  return parseSubtitleLanguages(value).join(', ');
}

/** The tags of a languages setting, in order (normalizeSubtitleLanguages). */
export function parseSubtitleLanguages(value: string): string[] {
  const tags: string[] = [];
  for (const raw of value.slice(0, 500).split(/[\s,;]+/)) {
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(raw)) continue;
    const [primary = '', ...rest] = raw.split('-');
    // BCP 47 casing: language lowercase, region uppercase, script title case.
    const tag = [
      primary.toLowerCase(),
      ...rest.map((part) => (part.length === 2 ? part.toUpperCase() : part.length === 4 ? (part[0] ?? '').toUpperCase() + part.slice(1).toLowerCase() : part.toLowerCase())),
    ].join('-');
    if (!tags.some((known) => known.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    if (tags.length === MAX_SUBTITLE_LANGUAGES) break;
  }
  return tags;
}

function folder(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = parseDownloadFolder(value);
  return parsed.ok ? parsed.folder : fallback;
}

export function settingsEqual(a: Readonly<Settings>, b: Readonly<Settings>): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).every((key) => a[key] === b[key]);
}
