import type { FetchFunction } from '@/core/network/manifest-fetcher';

/**
 * In-memory web server for download tests: serves text and binary bodies,
 * honours Range requests (206 + Content-Range, 416 past the end) and If-Range
 * against a route's validators, streams bodies in chunks, injects failures
 * (or a connection cut mid-body) per URL, and records requests and peak
 * concurrency.
 */

const encoder = new TextEncoder();

/** Deterministic, URL-specific bytes, so stored order can be verified. */
export function bodyFor(url: string, size = 1000): Uint8Array<ArrayBuffer> {
  // Starts like MPEG-TS (sync byte "G"): bodies starting with "<" are refused as web pages.
  const pattern = encoder.encode(`G${new URL(url).pathname}|`);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = pattern[i % pattern.length] ?? 0;
  return out;
}

export interface Route {
  body: string | Uint8Array<ArrayBuffer>;
  contentType?: string;
  /** Validators sent with the body; If-Range is honoured against them. */
  etag?: string;
  lastModified?: string;
  /** Further response headers. */
  headers?: Record<string, string>;
}

export interface Failure {
  status: number;
  headers?: Record<string, string>;
  /** Body of the failure (default "error"), e.g. an error page sent with 200. */
  body?: string;
}

export class FakeMediaSite {
  readonly routes = new Map<string, Route>();
  /** Responses to return (in order) before the real one, per URL. */
  readonly failures = new Map<string, Failure[]>();
  readonly requests: { url: string; range: string | undefined; ifRange?: string | undefined }[] = [];
  /** Per URL: the next responses' bodies break off (a dropped connection) after this many bytes. */
  readonly cuts = new Map<string, number[]>();
  supportsRanges = true;
  /** Open-ended ranges (bytes=N-) are answered with at most this many bytes, as some CDNs cap them. */
  maxOpenRangeBytes: number | undefined;
  /** Body chunk size when streaming. */
  chunkSize = 64 * 1024;
  /** Per-request latency (ms); requests overlap during it. */
  latencyMs = 0;
  /** Overrides `latencyMs` per URL (e.g. to make later segments finish first). */
  latencyFor: ((url: string) => number) | undefined;
  inFlight = 0;
  maxInFlight = 0;
  /** URL prefixes answered with `bodyFor(url, size)` when no explicit route exists. */
  readonly #catchAll: { prefix: string; size: number }[] = [];

  serve(url: string, body: string | Uint8Array<ArrayBuffer>, contentType?: string, extra: Omit<Route, 'body' | 'contentType'> = {}): this {
    this.routes.set(url, { body, ...(contentType === undefined ? {} : { contentType }), ...extra });
    return this;
  }

  /** The next response of `url` with a body breaks off after `bytes` bytes of it (one entry per response). */
  cutNext(url: string, ...bytes: number[]): this {
    this.cuts.set(url, [...(this.cuts.get(url) ?? []), ...bytes]);
    return this;
  }

  serveAll(prefix: string, size: number): this {
    this.#catchAll.push({ prefix, size });
    return this;
  }

  failNext(url: string, ...failures: Failure[]): this {
    this.failures.set(url, [...(this.failures.get(url) ?? []), ...failures]);
    return this;
  }

  count(url: string): number {
    return this.requests.filter((request) => request.url === url).length;
  }

  readonly fetch: FetchFunction = async (url, init) => {
    const headers = new Headers(init.headers);
    const range = headers.get('range') ?? undefined;
    const ifRange = headers.get('if-range') ?? undefined;
    this.requests.push(ifRange === undefined ? { url, range } : { url, range, ifRange });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await this.#wait(url, init.signal ?? undefined);
      const failure = this.failures.get(url)?.shift();
      if (failure) return new Response(failure.body ?? 'error', { status: failure.status, headers: failure.headers ?? {} });
      const fallback = this.#catchAll.find((entry) => url.startsWith(entry.prefix));
      const route = this.routes.get(url) ?? (fallback ? { body: bodyFor(url, fallback.size) } : undefined);
      if (!route) return new Response('not found', { status: 404 });
      const bytes = typeof route.body === 'string' ? encoder.encode(route.body) : route.body;
      const responseHeaders: Record<string, string> = {
        'content-type': route.contentType ?? 'application/octet-stream',
        ...(route.etag !== undefined ? { etag: route.etag } : {}),
        ...(route.lastModified !== undefined ? { 'last-modified': route.lastModified } : {}),
        ...route.headers,
      };
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range ?? '');
      // If-Range: the range only while the validator still matches, else the whole (changed) resource.
      const rangeValid = ifRange === undefined || ifRange === route.etag || (ifRange === route.lastModified && route.lastModified !== undefined);
      if (match && this.supportsRanges && rangeValid) {
        const start = Number(match[1]);
        if (start >= bytes.length) {
          return new Response('', { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
        }
        const cap = match[2] === undefined && this.maxOpenRangeBytes !== undefined ? start + this.maxOpenRangeBytes - 1 : Number.POSITIVE_INFINITY;
        const end = Math.min(match[2] === undefined ? bytes.length - 1 : Number(match[2]), bytes.length - 1, cap);
        const slice = bytes.subarray(start, end + 1);
        return new Response(this.#stream(slice, init.signal ?? undefined, this.cuts.get(url)?.shift()), {
          status: 206,
          headers: {
            ...responseHeaders,
            'content-range': `bytes ${start}-${end}/${bytes.length}`,
            'content-length': String(slice.length),
          },
        });
      }
      return new Response(this.#stream(bytes, init.signal ?? undefined, this.cuts.get(url)?.shift()), {
        status: 200,
        headers: { ...responseHeaders, 'content-length': String(bytes.length) },
      });
    } finally {
      this.inFlight -= 1;
    }
  };

  #stream(bytes: Uint8Array, signal: AbortSignal | undefined, cutAfter?: number): ReadableStream<Uint8Array> {
    let offset = 0;
    const size = this.chunkSize;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (cutAfter !== undefined && offset >= cutAfter) {
          controller.error(new TypeError('network error'));
          return;
        }
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + size, cutAfter ?? Number.POSITIVE_INFINITY);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    });
  }

  async #wait(url: string, signal: AbortSignal | undefined): Promise<void> {
    const latency = this.latencyFor?.(url) ?? this.latencyMs;
    if (latency <= 0) {
      await Promise.resolve();
    } else {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  }
}
