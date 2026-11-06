import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const srcDir = resolve(projectRoot, 'src');
export const distDir = resolve(projectRoot, 'dist');
export const publicDir = resolve(projectRoot, 'public');

/**
 * Extension entry points. Paths are relative to `dist/` and must match
 * src/manifest/manifest.json and the offscreen host in the service worker.
 */
export const entryOutputs = {
  serviceWorker: 'background/service-worker.js',
  contentScript: 'content/content-script.js',
  popupHtml: 'popup/index.html',
  offscreenHtml: 'offscreen/offscreen.html',
} as const;

/**
 * FFmpeg.wasm core, copied unchanged from @ffmpeg/core. The JS path must match
 * `FFMPEG_CORE_PATH` in src/shared/constants; the core expects its .wasm next to it.
 */
export const ffmpegCoreOutputs = {
  js: 'ffmpeg/ffmpeg-core.js',
  wasm: 'ffmpeg/ffmpeg-core.wasm',
} as const;

/** Web Worker bundles (the media worker hosting FFmpeg) land in this directory. */
export const workersDir = 'workers';

/**
 * Chrome refuses to load extensions containing files or directories whose name
 * starts with "_" (reserved for `_locales`, `_metadata`). Rolldown derives helper
 * chunk names from module ids, which can start with an underscore.
 */
export function safeChunkName(name: string): string {
  const cleaned = name.replace(/^_+/, '');
  return cleaned.length > 0 ? cleaned : 'chunk';
}
