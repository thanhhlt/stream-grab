import type { OutputFormat } from '@/shared/settings/settings';

/**
 * Output file names. They end up in chrome.downloads, which rejects names
 * Windows cannot store, so everything is sanitised for the strictest
 * platform: no reserved characters or device names, no trailing dots or
 * spaces, bounded length. Letters of any script are kept (Vietnamese,
 * Japanese… titles stay readable).
 */

export const MAX_BASE_NAME_LENGTH = 120;
const FALLBACK_NAME = 'video';

// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;
const RESERVED = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** A safe base name (no extension); empty input yields "video". */
export function sanitizeBaseName(input: string, maxLength: number = MAX_BASE_NAME_LENGTH): string {
  return sanitizeName(input, maxLength) || FALLBACK_NAME;
}

/** The same rules as `sanitizeBaseName`, but nothing left is '' (a folder name that is only dots or reserved characters). */
function sanitizeName(input: string, maxLength: number): string {
  let name = input
    .normalize('NFC')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading dot hides the file on Unix; trailing dots/spaces are dropped by Windows.
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (name.length > maxLength) {
    name = [...name].slice(0, maxLength).join('').replace(/[.\s]+$/g, '');
  }
  if (name === '') return '';
  // "CON", "nul.txt" etc. are device names on Windows, even with an extension.
  if (RESERVED.test(name.split('.')[0] ?? '')) name = `${name}_`;
  return name;
}

/** Longest subfolder of Downloads, so that folder + name (≤ 120) + Downloads' own path stay under Windows' 260 characters. */
export const MAX_FOLDER_LENGTH = 80;
const MAX_FOLDER_SEGMENT_LENGTH = 60;

export type FolderResult = { ok: true; folder: string } | { ok: false; reason: string };

/**
 * The "Save in a subfolder of Downloads" setting as chrome.downloads accepts
 * it ('' = Downloads itself): segments joined by '/', each a safe name
 * (same rules as file names), empty and '.' segments dropped. A path that
 * leaves Downloads ('..', 'C:\\…') is refused: Chrome rejects it ("Invalid
 * filename"), and a folder elsewhere cannot be chosen by an extension.
 */
export function parseDownloadFolder(input: string): FolderResult {
  const path = input.normalize('NFC').trim().replaceAll('\\', '/');
  if (/^[a-z]:/i.test(path) || path.startsWith('//')) {
    return { ok: false, reason: 'Enter a folder inside Downloads, such as StreamGrab or Videos/StreamGrab, not a full path.' };
  }
  const segments = path.split('/').map((segment) => segment.trim());
  if (segments.includes('..')) return { ok: false, reason: '".." is not allowed: the folder must be inside Downloads.' };
  const folder = segments
    .filter((segment) => segment !== '' && segment !== '.')
    .map((segment) => sanitizeName(segment, MAX_FOLDER_SEGMENT_LENGTH))
    .filter((segment) => segment !== '')
    .join('/');
  if (folder.length > MAX_FOLDER_LENGTH) return { ok: false, reason: `Use at most ${MAX_FOLDER_LENGTH} characters: longer paths fail on Windows.` };
  return { ok: true, folder };
}

/** `fileName` inside the Downloads subfolder `folder` ('' = Downloads itself), as chrome.downloads takes it. */
export function inDownloadFolder(folder: string, fileName: string): string {
  return folder === '' ? fileName : `${folder}/${fileName}`;
}

/**
 * Default name in the documented style: words joined by underscores plus the
 * quality, e.g. "Movie Title" + "1080p" → "Movie_Title_1080p".
 */
export function defaultBaseName(title: string | undefined, qualityLabel?: string): string {
  const words = sanitizeBaseName(title ?? '', 100)
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const stem = words.length > 0 ? words.join('_') : FALLBACK_NAME;
  const suffix = qualityLabel ? sanitizeBaseName(qualityLabel, 20).replace(/[^\p{L}\p{N}]+/gu, '') : '';
  return sanitizeBaseName(suffix && !stem.endsWith(`_${suffix}`) ? `${stem}_${suffix}` : stem);
}

/** Appends _2, _3, … until the name differs (case-insensitively) from every name in `taken`. */
export function uniqueBaseName(baseName: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  if (!used.has(baseName.toLowerCase())) return baseName;
  for (let n = 2; ; n++) {
    const candidate = `${baseName.slice(0, MAX_BASE_NAME_LENGTH - String(n).length - 1)}_${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Extension implied by the output format alone. `auto` starts as MP4; once
 * FFmpeg has analysed the download it may become MKV (MediaAnalysis.container).
 */
export function extensionFor(format: OutputFormat): string {
  return format === 'mkv' ? '.mkv' : '.mp4';
}
