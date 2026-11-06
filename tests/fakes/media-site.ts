import type { FetchFunction } from '@/core/network/manifest-fetcher';

/**
 * In-memory web server for download tests: serves text and binary bodies,
 * honours Range requests (206 + Content-Range), streams bodies in chunks,
 * injects failures per URL, and records requests and peak concurrency.
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
  readonly requests: { url: string; range: string | undefined }[] = [];
  supportsRanges = true;
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

  serve(url: string, body: string | Uint8Array<ArrayBuffer>, contentType?: string): this {
    this.routes.set(url, contentType === undefined ? { body } : { body, contentType });
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
    this.requests.push({ url, range });
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
      const responseHeaders: Record<string, string> = { 'content-type': route.contentType ?? 'application/octet-stream' };
      const match = /^bytes=(\d+)-(\d+)?$/.exec(range ?? '');
      if (match && this.supportsRanges) {
        const start = Number(match[1]);
        const end = Math.min(match[2] === undefined ? bytes.length - 1 : Number(match[2]), bytes.length - 1);
        const slice = bytes.subarray(start, end + 1);
        return new Response(this.#stream(slice, init.signal ?? undefined), {
          status: 206,
          headers: {
            ...responseHeaders,
            'content-range': `bytes ${start}-${end}/${bytes.length}`,
            'content-length': String(slice.length),
          },
        });
      }
      return new Response(this.#stream(bytes, init.signal ?? undefined), {
        status: 200,
        headers: { ...responseHeaders, 'content-length': String(bytes.length) },
      });
    } finally {
      this.inFlight -= 1;
    }
  };

  #stream(bytes: Uint8Array, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
    let offset = 0;
    const size = this.chunkSize;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(new DOMException('Aborted', 'AbortError'));
          return;
        }
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
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
