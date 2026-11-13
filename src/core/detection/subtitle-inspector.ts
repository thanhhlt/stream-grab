import type { RequestContext } from '@/core/models/detected-stream';
import { isKnownLanguage } from '@/core/media/languages';
import { describeFetchFailure, type AcquireRequestContext, type FetchFunction } from '@/core/network/manifest-fetcher';
import { SAMPLE_CUES } from '@/core/subtitles/cue-offset';
import { parseWebVtt } from '@/core/subtitles/webvtt';
import type { PageCue } from '@/shared/types/text-tracks';
import { errorMessage } from '@/shared/utils/errors';
import { redactText } from '@/shared/utils/redact';
import { fileNameOf, parseHttpUrl } from '@/shared/utils/url';

/**
 * Page subtitle files (0.7.2): a WebVTT file a player loads on its own, next
 * to an HLS/DASH stream or a video file, instead of declaring it in the
 * manifest or as a `<track>`. It is fetched once to check that it is a whole
 * subtitle file, not one segment of a segmented rendition (those carry
 * `X-TIMESTAMP-MAP`, and come with the manifest anyway), and to read its
 * language.
 */

/** A whole film's subtitles are about 100 KB; anything much bigger is not a subtitle file. */
export const MAX_SUBTITLE_FILE_BYTES = 4 * 1024 * 1024;

/** `transient`: the file could not be fetched (network, timeout, HTTP error): worth checking again when the page loads it again. */
export type SubtitleFileInspection =
  /** `cues`: the file's first cues, to find it in the player's text tracks (cue-offset.ts). */
  | { ok: true; language?: string; cues?: PageCue[] }
  | { ok: false; reason: string; transient?: true };

export interface SubtitleInspectorDeps {
  fetch: FetchFunction;
  acquireContext?: AcquireRequestContext;
  timeoutMs?: number;
}

const BOM = new RegExp('^\\uFEFF');
const HEADER_LANGUAGE = /^language\s*[:=]\s*([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)\s*$/i;

function normalizeTag(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag.replace(/_/g, '-'))[0];
  } catch {
    return undefined;
  }
}

/** The `Language:` line some sites put in the WebVTT header (not standard, but common). */
export function headerLanguage(text: string): string | undefined {
  const lines = text.replace(BOM, '').split(/\r\n?|\n/);
  for (let i = 1; i < lines.length && i < 32; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line.includes('-->')) return undefined;
    const match = HEADER_LANGUAGE.exec(line);
    if (match) return normalizeTag(match[1]!);
  }
  return undefined;
}

/** Codes that are also everyday words or abbreviations in file names ("my_video", "video_id", "my_cat"). */
const AMBIGUOUS_CODES = new Set([
  'am', 'be', 'he', 'hi', 'id', 'is', 'it', 'ka', 'mr', 'ms', 'my', 'ne', 'no', 'pa',
  'arm', 'cat', 'fin', 'ice', 'ind', 'mac', 'mal', 'may', 'nor', 'pan', 'per', 'tam', 'tel',
]); // prettier-ignore

/**
 * A language code in the file name: its last word that is not a number ("movie.en.vtt",
 * "captions.zh.vtt.r2024…" → "zh"), when that is a known code and not an everyday word.
 */
export function fileNameLanguage(url: string): string | undefined {
  const name = fileNameOf(url);
  const base = name.replace(/\.(?:web)?vtt(?:\.[^.]*)?$/i, '');
  const token = base
    .split(/[_.\s]+/)
    .filter((part) => part !== '' && !/^\d+$/.test(part))
    .at(-1);
  if (token === undefined || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/.test(token)) return undefined;
  if (AMBIGUOUS_CODES.has(token.toLowerCase()) || !isKnownLanguage(token)) return undefined;
  return normalizeTag(token);
}

/** Cue text that is an image or a link: a player's thumbnail track (`sprite.jpg#xywh=…`), not subtitles. */
const NOT_TEXT = /#xywh=|^\S+\.(?:jpe?g|png|webp|gif|avif)(?:[?#]\S*)?$|^(?:https?:)?\/\/\S+$/i;

/** Checks the body: a WebVTT file with cues of text, without `X-TIMESTAMP-MAP`. */
export function checkSubtitleFile(text: string, url: string): SubtitleFileInspection {
  const parsed = parseWebVtt(text);
  if (!parsed) return { ok: false, reason: 'Not a WebVTT file' };
  if (parsed.timestampMap) return { ok: false, reason: 'A segment of a subtitle rendition, not a whole file' };
  if (parsed.cues.length === 0) return { ok: false, reason: 'The file has no subtitles' };
  const images = parsed.cues.filter((cue) => NOT_TEXT.test(cue.text.trim())).length;
  if (images * 2 > parsed.cues.length) return { ok: false, reason: 'A thumbnail track, not subtitles' };
  const language = headerLanguage(text) ?? fileNameLanguage(url);
  const cues = parsed.cues.slice(0, SAMPLE_CUES).map((cue) => ({ start: cue.start, text: cue.text }));
  return language === undefined ? { ok: true, cues } : { ok: true, language, cues };
}

async function readText(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > MAX_SUBTITLE_FILE_BYTES ? null : text;
  }
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_SUBTITLE_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Fetches a candidate page subtitle file with the page's request context and checks it. */
export async function inspectSubtitleFile(
  deps: SubtitleInspectorDeps,
  url: string,
  context: RequestContext,
): Promise<SubtitleFileInspection> {
  if (!parseHttpUrl(url)) return { ok: false, reason: 'Not an HTTP URL' };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs ?? 15_000);
  let release: () => Promise<void> = () => Promise.resolve();
  try {
    if (deps.acquireContext) release = await deps.acquireContext(url, context);
    const response = await deps.fetch(url, { credentials: 'include', redirect: 'follow', signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: describeFetchFailure({ kind: 'http-error', status: response.status }), transient: true };
    }
    const text = await readText(response);
    if (text === null) return { ok: false, reason: 'The file is too large to be subtitles' };
    return checkSubtitleFile(text, response.url || url);
  } catch (error) {
    if (timedOut) return { ok: false, reason: describeFetchFailure({ kind: 'timeout' }), transient: true };
    return { ok: false, reason: describeFetchFailure({ kind: 'network-error', message: redactText(errorMessage(error)) }), transient: true };
  } finally {
    clearTimeout(timer);
    await release().catch(() => undefined);
  }
}
