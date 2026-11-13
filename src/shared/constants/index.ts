export const EXTENSION_NAME = 'StreamGrab';

/** Links in the popup's About screen and support bar (and the README / .github/FUNDING.yml). */
export const PROJECT_LINKS = {
  source: 'https://github.com/thanhhlt/stream-grab',
  issues: 'https://github.com/thanhhlt/stream-grab/issues',
  changelog: 'https://github.com/thanhhlt/stream-grab/blob/main/CHANGELOG.md',
  license: 'https://github.com/thanhhlt/stream-grab/blob/main/LICENSE',
  donate: 'https://ko-fi.com/s1lent91505',
} as const;

/** Integer setting bounds. `default` is used when a stored value is missing or invalid. */
export interface IntRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** Simultaneous segment requests per download task. */
export const SEGMENT_CONCURRENCY: IntRange = { min: 1, max: 16, default: 6 };

/** Download tasks that may fetch segments at the same time. Media processing is always serialised. */
export const ACTIVE_TASKS: IntRange = { min: 1, max: 4, default: 2 };

/** Keys used in chrome.storage. */
export const STORAGE_KEYS = {
  /** chrome.storage.local */
  settings: 'settings',
  /** chrome.storage.local: download tasks (survive restarts). */
  tasks: 'tasks',
  /** chrome.storage.local: the fast-changing part of tasks (download and processing progress). */
  taskProgress: 'taskProgress',
  /** chrome.storage.session: request context per task (Referer/Origin; never written to disk). */
  taskContexts: 'taskContexts',
} as const;

/**
 * Extension-relative path of the offscreen document that hosts the download and
 * media engine. Must match `entryOutputs.offscreenHtml` in build/paths.ts.
 */
export const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';

/**
 * Extension-relative path of FFmpeg.wasm's core script (with ffmpeg-core.wasm
 * next to it), copied into the package at build time. Must match
 * `ffmpegCoreOutputs.js` in build/paths.ts.
 */
export const FFMPEG_CORE_PATH = 'ffmpeg/ffmpeg-core.js';
