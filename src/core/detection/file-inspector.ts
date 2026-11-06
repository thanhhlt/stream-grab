import { documentKind } from '@/core/download/segment-fetcher';
import type { ProgressiveContainer, ProgressiveInfo, RequestContext } from '@/core/models/detected-stream';
import { describeFetchFailure, type AcquireRequestContext, type FetchFunction } from '@/core/network/manifest-fetcher';
import { errorMessage } from '@/shared/utils/errors';
import { redactText } from '@/shared/utils/redact';
import { fileNameOf } from '@/shared/utils/url';
import { mimeEssence } from './manifest-detector';
import type { InspectionOutcome } from './stream-inspector';

/**
 * Inspection of a progressive file candidate (MP4/WebM, since 0.3.0).
 *
 * A media element's request for a .mp4 or video/webm resource is usually a
 * whole file, but not always: native HLS playback and some players fetch
 * fMP4/WebM segments through the media element too. One ranged request for
 * the file's first bytes tells them apart, the way manifest inspection
 * confirms a manifest from its body:
 *
 * - MP4 (ISO BMFF): a file starts with `ftyp` (or `moov`/`mdat`/`free`…); a
 *   media segment starts with `styp`/`moof`/`sidx`/`emsg`/`prft`; an
 *   initialisation segment is `ftyp` + `moov` alone, without media data.
 * - WebM: an EBML header with DocType "webm"; a segment starts with a Cluster;
 *   an initialisation segment is a header without any Cluster.
 *
 * The same request reports the size (Content-Range total, or Content-Length
 * of a 200), whether the server serves byte ranges (206), the server's file
 * name and the URL after redirects: what downloading needs later. The page's
 * Referer/Origin are applied like for manifests (DNR session rule); cookies
 * are the browser's own. At most FILE_SNIFF_BYTES are read; the rest of the
 * body is never transferred (the reader is cancelled).
 */

/** Bytes of a file read to recognise it. */
export const FILE_SNIFF_BYTES = 64 * 1024;

export type FileSniff =
  | { kind: 'file'; container: ProgressiveContainer }
  /** Part of a stream (or its initialisation segment), not a video on its own: not listed. */
  | { kind: 'segment'; reason: string }
  /** A web page or JSON error instead of media: listed as unavailable with the reason. */
  | { kind: 'document'; reason: string }
  /** Neither MP4 nor WebM: not listed. */
  | { kind: 'unknown'; reason: string };

/** ISO BMFF boxes that open a file (QuickTime-style files may start without `ftyp`). */
const FILE_START_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pdin', 'uuid']);
/** ISO BMFF boxes that open a media segment (CMAF, DASH, HLS fMP4). */
const SEGMENT_START_BOXES = new Set(['styp', 'moof', 'sidx', 'ssix', 'emsg', 'prft']);
const MAX_BOXES = 64;

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const DOCTYPE_ID = [0x42, 0x82];

const INIT_SEGMENT = 'An initialization segment of a stream, not a video file.';
const MEDIA_SEGMENT = 'A segment of a stream, not a whole video file.';

function startsWith(bytes: Uint8Array, magic: readonly number[], at = 0): boolean {
  return magic.every((value, index) => bytes[at + index] === value);
}

function indexOf(bytes: Uint8Array, pattern: readonly number[], from = 0, to = bytes.length): number {
  for (let at = from; at + pattern.length <= to; at++) if (startsWith(bytes, pattern, at)) return at;
  return -1;
}

function boxType(bytes: Uint8Array, at: number): string | undefined {
  if (at + 8 > bytes.length) return undefined;
  let type = '';
  for (let index = at + 4; index < at + 8; index++) {
    const code = bytes[index] ?? 0;
    if (code < 0x20 || code > 0x7e) return undefined;
    type += String.fromCharCode(code);
  }
  return type;
}

/** Types of the top-level ISO BMFF boxes that start within `bytes`, in order. */
export function topLevelBoxes(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  let at = 0;
  while (types.length < MAX_BOXES) {
    const type = boxType(bytes, at);
    if (type === undefined) break;
    types.push(type);
    let size = view.getUint32(at);
    if (size === 0) break; // the box runs to the end of the file
    if (size === 1) {
      if (at + 16 > bytes.length) break;
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
    }
    if (size < 8) break; // malformed: stop rather than loop
    at += size;
  }
  return types;
}

/** The EBML header's DocType ("webm", "matroska"), if it is within the first bytes. */
function ebmlDocType(bytes: Uint8Array): string | undefined {
  const at = indexOf(bytes, DOCTYPE_ID, 4, Math.min(bytes.length, 64));
  if (at < 0) return undefined;
  const sizeByte = bytes[at + 2] ?? 0;
  if ((sizeByte & 0x80) === 0) return undefined; // only the 1-byte size form is used for short strings
  const length = sizeByte & 0x7f;
  const start = at + 3;
  if (length === 0 || start + length > bytes.length) return undefined;
  return String.fromCharCode(...bytes.subarray(start, start + length)).replace(/\0+$/, '');
}

/**
 * Recognises a progressive file from its first bytes. `complete`: `prefix` is
 * the whole file (an initialisation segment is only recognisable as such
 * when nothing follows it).
 */
export function sniffMediaFile(prefix: Uint8Array, complete: boolean, contentType?: string | null): FileSniff {
  const page = documentKind(prefix.subarray(0, 64), contentType ?? null, false);
  if (page !== undefined) {
    return {
      kind: 'document',
      reason: `The server sent a ${page} instead of the video. The link may have expired, or the site may want you signed in: play the video again on its page.`,
    };
  }
  if (startsWith(prefix, EBML_MAGIC)) {
    const docType = ebmlDocType(prefix);
    if (docType !== 'webm') return { kind: 'unknown', reason: `A Matroska file (DocType ${docType ?? 'unknown'}), not WebM.` };
    if (complete && indexOf(prefix, CLUSTER_ID) < 0) return { kind: 'segment', reason: INIT_SEGMENT };
    return { kind: 'file', container: 'webm' };
  }
  if (startsWith(prefix, CLUSTER_ID)) return { kind: 'segment', reason: MEDIA_SEGMENT };
  const boxes = topLevelBoxes(prefix);
  const first = boxes[0];
  if (first !== undefined && SEGMENT_START_BOXES.has(first)) return { kind: 'segment', reason: MEDIA_SEGMENT };
  if (first !== undefined && FILE_START_BOXES.has(first)) {
    // A whole file always holds media data; one that ends after its header is an initialisation segment.
    if (complete && !boxes.includes('mdat')) return { kind: 'segment', reason: INIT_SEGMENT };
    return { kind: 'file', container: 'mp4' };
  }
  return { kind: 'unknown', reason: 'Neither an MP4 nor a WebM file.' };
}

/** The file name a Content-Disposition header suggests (RFC 6266: `filename*` wins), without any path. */
export function contentDispositionFileName(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  let name: string | undefined;
  const extended = /filename\*\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim();
  const encoded = extended === undefined ? undefined : /^[\w!#$%&+^`{}~-]+'[^']*'(.+)$/.exec(extended)?.[1];
  if (encoded !== undefined) {
    try {
      name = decodeURIComponent(encoded);
    } catch {
      name = undefined;
    }
  }
  if (name === undefined) {
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(header);
    name = plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim();
  }
  return cleanFileName(name);
}

function cleanFileName(name: string | undefined): string | undefined {
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const base = name?.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!base) return undefined;
  return base.length > 255 ? base.slice(0, 255) : base;
}

/** Total size from `Content-Range: bytes 0-65535/1234567`; undefined when unknown (`*`) or malformed. */
export function contentRangeTotal(header: string | null): number | undefined {
  const total = /^\s*bytes\s+\d+-\d+\/(\d+)\s*$/i.exec(header ?? '')?.[1];
  return total === undefined ? undefined : Number(total);
}

function declaredLength(response: Response): number | undefined {
  const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase();
  if (encoding !== '' && encoding !== 'identity') return undefined; // the length of the compressed body
  const value = (response.headers.get('content-length') ?? '').trim();
  return /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Reads at most `max` bytes, then cancels the body. `ended`: the body had no more. */
async function readPrefix(response: Response, max: number): Promise<{ prefix: Uint8Array; ended: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await response.arrayBuffer());
    return { prefix: all.subarray(0, max), ended: all.byteLength <= max };
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    if (length >= max) {
      await reader.cancel().catch(() => undefined);
      return { prefix: concat(chunks, max), ended: false };
    }
  }
  return { prefix: concat(chunks, length), ended: true };
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, length - offset);
    out.set(part, offset);
    offset += part.byteLength;
    if (offset >= length) break;
  }
  return out;
}

export interface FileInspectorDeps {
  fetch: FetchFunction;
  /** Applies the page's Referer/Origin to the request (RequestContextRules). */
  acquireContext?: AcquireRequestContext;
  timeoutMs?: number;
}

/** Fetches the first bytes of a candidate file and describes it (see the top of this file). */
export async function inspectProgressiveFile(
  deps: FileInspectorDeps,
  url: string,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<InspectionOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.timeoutMs ?? 15_000);
  const forwardAbort = (): void => {
    controller.abort();
  };
  signal?.addEventListener('abort', forwardAbort, { once: true });

  let release: () => Promise<void> = () => Promise.resolve();
  try {
    if (deps.acquireContext) release = await deps.acquireContext(url, context);
    const response = await deps.fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      headers: { Range: `bytes=0-${FILE_SNIFF_BYTES - 1}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: 'failed', reason: describeFetchFailure({ kind: 'http-error', status: response.status }) };
    }
    const { prefix, ended } = await readPrefix(response, FILE_SNIFF_BYTES);
    const ranged = response.status === 206;
    const declared = ranged ? contentRangeTotal(response.headers.get('content-range')) : declaredLength(response);
    // A 200 read to its end is the whole file, whatever its headers say.
    const bytes = !ranged && ended ? prefix.byteLength : declared;
    const complete = ended && (!ranged || (bytes !== undefined && bytes <= prefix.byteLength));
    const contentType = response.headers.get('content-type');
    const sniff = sniffMediaFile(prefix, complete, contentType);
    switch (sniff.kind) {
      case 'document':
        return { kind: 'failed', reason: sniff.reason };
      case 'segment':
      case 'unknown':
        return { kind: 'not-manifest', reason: sniff.reason };
      case 'file':
        break;
    }
    const finalUrl = response.url || url;
    const info: ProgressiveInfo = { container: sniff.container, acceptsRanges: ranged };
    const mimeType = mimeEssence(contentType ?? undefined);
    if (mimeType !== '' && mimeType.length <= 255) info.mimeType = mimeType;
    if (bytes !== undefined && bytes > 0) info.bytes = bytes;
    const fileName =
      contentDispositionFileName(response.headers.get('content-disposition')) ?? cleanFileName(fileNameOf(finalUrl) || fileNameOf(url));
    if (fileName !== undefined) info.fileName = fileName;
    return { kind: 'progressive', info, finalUrl };
  } catch (error) {
    if (timedOut) return { kind: 'failed', reason: describeFetchFailure({ kind: 'timeout' }) };
    return { kind: 'failed', reason: describeFetchFailure({ kind: 'network-error', message: redactText(errorMessage(error)) }) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
    await release().catch(() => undefined);
  }
}
