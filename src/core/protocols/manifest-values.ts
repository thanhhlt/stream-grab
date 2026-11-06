import type { ByteRange, ContainerFormat } from '@/core/models/media-segment';
import { StreamGrabError } from '@/shared/utils/errors';
import { pathExtension } from '@/shared/utils/url';

/**
 * Validators for values taken from parser output. Manifests are untrusted, and
 * the parser libraries pass some attributes through as strings, so nothing is
 * used without checking its type and range.
 */

export const invalidManifest = (message: string): StreamGrabError => new StreamGrabError(message, 'MANIFEST_INVALID');

export function nonNegativeInt(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
}

export function nonEmptyString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : undefined;
}

/** Validated byte range; `what` names the item in the error message. */
export function toByteRange(range: unknown, what: string): ByteRange | undefined {
  if (range === undefined || range === null) return undefined;
  const { length: rawLength, offset: rawOffset } = range as { length?: unknown; offset?: unknown };
  const length = nonNegativeInt(rawLength);
  const offset = rawOffset === undefined ? 0 : nonNegativeInt(rawOffset);
  if (length === undefined || length === 0 || offset === undefined) throw invalidManifest(`${what} has an invalid byte range`);
  return { offset, length };
}

const CONTAINER_BY_EXTENSION: Record<string, ContainerFormat> = {
  ts: 'mpeg-ts',
  m2ts: 'mpeg-ts',
  mts: 'mpeg-ts',
  aac: 'packed-audio',
  ac3: 'packed-audio',
  ec3: 'packed-audio',
  eac3: 'packed-audio',
  mp3: 'packed-audio',
  m4s: 'fmp4',
  mp4: 'fmp4',
  m4v: 'fmp4',
  m4a: 'fmp4',
  cmfv: 'fmp4',
  cmfa: 'fmp4',
  webm: 'webm',
  weba: 'webm',
};

/** Container declared by a segment URL's extension, or `fallback`. */
export function containerFromUrl(url: string, fallback: ContainerFormat): ContainerFormat {
  return CONTAINER_BY_EXTENSION[pathExtension(new URL(url))] ?? fallback;
}
