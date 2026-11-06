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
  if (name === '') return FALLBACK_NAME;
  // "CON", "nul.txt" etc. are device names on Windows, even with an extension.
  if (RESERVED.test(name.split('.')[0] ?? '')) name = `${name}_`;
  return name;
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
