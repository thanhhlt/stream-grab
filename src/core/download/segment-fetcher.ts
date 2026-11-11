import type { ByteRange, SegmentEncryption } from '@/core/models/media-segment';
import type { FetchFunction } from '@/core/network/manifest-fetcher';
import { decryptAes128, type Aes128KeyCache } from './aes';
import { parseRetryAfter, SegmentContentError, SegmentFatalError, SegmentHttpError, SegmentTransferError } from './retry-policy';
import { storageFailure } from './storage-space';

/**
 * Downloads one segment and hands its bytes to `sink` in parts.
 *
 * Memory: unencrypted bodies are never held whole; they are cut into parts of
 * at most `partSize` bytes and written as they arrive, so a 2 GB single-file
 * representation costs at most one part of RAM. AES-128 segments must be
 * decrypted whole (CBC + padding), which is fine for HLS segment sizes and is
 * capped by `maxEncryptedBytes`.
 *
 * Byte ranges: requested with a Range header; a server that ignores it (200)
 * is handled by skipping to the offset and stopping after the length.
 *
 * Content: a body that starts like a web page or a JSON document (an error or
 * login page served with 200) is refused before anything is stored, so it
 * never ends up inside the merged video. Checked for bodies that start a
 * resource; a range in the middle of a file may start with any byte.
 */

export interface SegmentFetcherOptions {
  fetch: FetchFunction;
  keys: Aes128KeyCache;
  partSize?: number;
  /** Abort when no data arrives for this long. */
  stallTimeoutMs?: number;
  maxEncryptedBytes?: number;
}

export interface SegmentRequest {
  url: string;
  byteRange?: ByteRange;
  encryption?: SegmentEncryption;
  /**
   * Resume a whole file from this byte (`Range: bytes=N-`, 0.6.0). Unlike
   * `byteRange`, a 200 answer is not skipped through: it is the whole file
   * again, which the caller sees in `onResponse` and starts over with.
   */
  from?: number;
  /** Further request headers (e.g. If-Range). */
  headers?: Record<string, string>;
}

export interface DownloadOptions {
  /** Called with every response before its status is checked or its body read; may throw to stop. */
  onResponse?: (response: Response) => void | Promise<void>;
}

export type PartSink = (part: number, data: Uint8Array<ArrayBuffer>) => Promise<void>;

export interface SegmentFetchResult {
  bytes: number;
  parts: number;
}

export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

async function write(sink: PartSink, part: number, data: Uint8Array<ArrayBuffer>): Promise<void> {
  try {
    await sink(part, data);
  } catch (error) {
    throw storageFailure(error);
  }
}

const MARKUP_TYPES = /^(text\/html|application\/xhtml\+xml|text\/xml|application\/xml)\b/i;
const JSON_TYPES = /^(application|text)\/(json|problem\+json)\b/i;

/**
 * Whether the start of a body is a document rather than media. No media
 * container starts with "<" or "{" (MPEG-TS starts with 0x47, MP4 with a box
 * size, WebM with 0x1A, ADTS/MP3 with 0xFF, ID3 with "I"), so an unencrypted
 * body that does, after optional whitespace or a BOM, is a web page or a JSON
 * error. Encrypted bodies are random bytes: only their Content-Type tells.
 */
export function documentKind(first: Uint8Array, contentType: string | null, encrypted: boolean): SegmentContentError['kind'] | undefined {
  const type = (contentType ?? '').trim();
  if (encrypted) {
    if (MARKUP_TYPES.test(type)) return 'web page';
    if (JSON_TYPES.test(type)) return 'JSON document';
    return undefined;
  }
  let at = 0;
  if (first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf) at = 3; // UTF-8 BOM
  while (at < first.length && (first[at] === 0x20 || first[at] === 0x09 || first[at] === 0x0a || first[at] === 0x0d)) at += 1;
  if (first[at] === 0x3c) return 'web page'; // "<"
  if (first[at] === 0x7b) return 'JSON document'; // "{"
  return undefined;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class SegmentFetcher {
  readonly #fetch: FetchFunction;
  readonly #keys: Aes128KeyCache;
  readonly #partSize: number;
  readonly #stallTimeoutMs: number;
  readonly #maxEncryptedBytes: number;

  constructor(options: SegmentFetcherOptions) {
    this.#fetch = options.fetch;
    this.#keys = options.keys;
    this.#partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.#stallTimeoutMs = options.stallTimeoutMs ?? 30_000;
    this.#maxEncryptedBytes = options.maxEncryptedBytes ?? 256 * 1024 * 1024;
  }

  /**
   * @param onBytes called for every received chunk (speed display)
   * @throws SegmentHttpError, SegmentTransferError, SegmentFatalError, AbortError
   */
  async download(
    segment: SegmentRequest,
    sink: PartSink,
    signal: AbortSignal,
    onBytes: (count: number) => void = () => undefined,
    options: DownloadOptions = {},
  ): Promise<SegmentFetchResult> {
    const controller = new AbortController();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, this.#stallTimeoutMs);
    };
    const forward = (): void => {
      controller.abort(signal.reason);
    };
    signal.addEventListener('abort', forward, { once: true });
    if (signal.aborted) controller.abort(signal.reason);

    try {
      arm();
      const range = segment.byteRange;
      const from = !range && segment.from !== undefined && segment.from > 0 ? segment.from : undefined;
      const headers: Record<string, string> = { ...segment.headers };
      if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      else if (from !== undefined) headers.Range = `bytes=${from}-`;
      let response: Response;
      try {
        response = await this.#fetch(segment.url, {
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          headers,
          signal: controller.signal,
        });
      } catch (error) {
        throw this.#translate(error, stalled, signal);
      }
      if (options.onResponse) {
        try {
          await options.onResponse(response);
        } catch (error) {
          await response.body?.cancel().catch(() => undefined);
          throw error;
        }
      }
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        throw new SegmentHttpError(response.status, parseRetryAfter(response.headers.get('retry-after')));
      }
      // A server that ignored the Range header sent the whole resource: skip to the range ourselves.
      const skip = range && response.status === 200 ? range.offset : 0;
      const limit = range ? range.length : Number.POSITIVE_INFINITY;
      const declared = Number(response.headers.get('content-length') ?? Number.NaN);
      const expected = range ? range.length : Number.isFinite(declared) && declared > 0 ? declared : undefined;

      const reader = response.body?.getReader();
      if (!reader) throw new SegmentTransferError('Empty response body');

      const encrypted = segment.encryption?.method === 'AES-128';
      if (segment.encryption && !encrypted) {
        throw new SegmentFatalError(`${segment.encryption.method} encrypted segments are not supported`);
      }
      const chunks: Uint8Array[] = [];
      let buffered = 0;
      let received = 0;
      let skipped = 0;
      let parts = 0;
      let total = 0;

      const flush = async (): Promise<void> => {
        if (buffered === 0) return;
        await write(sink, parts++, concat(chunks, buffered));
        total += buffered;
        chunks.length = 0;
        buffered = 0;
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          let chunk: Uint8Array = value;
          if (skipped < skip) {
            const drop = Math.min(skip - skipped, chunk.byteLength);
            skipped += drop;
            chunk = chunk.subarray(drop);
          }
          if (received + chunk.byteLength > limit) chunk = chunk.subarray(0, limit - received);
          // Only a body that starts the resource can be checked: a range in the middle may start with any byte.
          const startsResource = range ? range.offset === 0 : from === undefined || response.status === 200;
          if (chunk.byteLength > 0 && received === 0 && startsResource) {
            const kind = documentKind(chunk.subarray(0, 64), response.headers.get('content-type'), encrypted);
            if (kind) {
              await reader.cancel().catch(() => undefined);
              throw new SegmentContentError(kind);
            }
          }
          if (chunk.byteLength > 0) {
            received += chunk.byteLength;
            onBytes(chunk.byteLength);
            chunks.push(chunk);
            buffered += chunk.byteLength;
            if (encrypted && received > this.#maxEncryptedBytes) {
              throw new SegmentFatalError('Encrypted segment is too large to decrypt in memory');
            }
            if (!encrypted && buffered >= this.#partSize) await flush();
          }
          if (received >= limit) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      } catch (error) {
        throw this.#translate(error, stalled, signal);
      }

      if (received === 0) throw new SegmentTransferError('The server sent an empty segment');
      if (expected !== undefined && received < expected) {
        throw new SegmentTransferError(`Segment truncated: ${received} of ${expected} bytes`);
      }

      if (encrypted && segment.encryption) {
        const key = await this.#keys.get(segment.encryption.keyUrl, controller.signal);
        const clear = await decryptAes128(concat(chunks, buffered).buffer, key, segment.encryption.iv);
        await write(sink, 0, new Uint8Array(clear));
        return { bytes: clear.byteLength, parts: 1 };
      }
      await flush();
      return { bytes: total, parts };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', forward);
    }
  }

  #translate(error: unknown, stalled: boolean, signal: AbortSignal): unknown {
    if (signal.aborted) return new DOMException('Aborted', 'AbortError');
    if (stalled) return new SegmentTransferError('No data received for too long');
    if (error instanceof SegmentFatalError || error instanceof SegmentHttpError || error instanceof SegmentTransferError) {
      return error;
    }
    return new SegmentTransferError(error instanceof Error ? error.message : 'Network error', { cause: error });
  }
}
