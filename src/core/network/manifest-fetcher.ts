import { MAX_MANIFEST_BYTES } from '@/core/detection/manifest-detector';
import type { RequestContext, StreamingProtocol } from '@/core/models/detected-stream';
import { sniffManifest } from '@/core/protocols/sniff';
import { errorMessage, StreamGrabError } from '@/shared/utils/errors';
import { redactText } from '@/shared/utils/redact';

/**
 * Applies the page's request context (Referer/Origin) to the extension's own
 * requests to `url` until the returned release function is called.
 */
export type AcquireRequestContext = (url: string, context: RequestContext) => Promise<() => Promise<void>>;

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

export interface ManifestFetcherOptions {
  fetch: FetchFunction;
  acquireContext?: AcquireRequestContext;
  timeoutMs?: number;
  maxBytes?: number;
  /** Bytes read before deciding whether the body can be a manifest at all. */
  sniffChars?: number;
}

export type ManifestFetchResult =
  | { kind: 'ok'; text: string; finalUrl: string; protocol: StreamingProtocol }
  | { kind: 'not-manifest'; reason: string }
  | { kind: 'http-error'; status: number }
  | { kind: 'network-error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'too-large' };

export type ManifestFetchFailure = Exclude<ManifestFetchResult, { kind: 'ok' }>;

/** User-facing explanation of a failed manifest request. */
export function describeFetchFailure(result: ManifestFetchFailure): string {
  switch (result.kind) {
    case 'http-error':
      if (result.status === 401 || result.status === 403) {
        return `Access denied (HTTP ${result.status}). The link may have expired, or the server needs the page's session.`;
      }
      if (result.status === 404 || result.status === 410) {
        return `Not found (HTTP ${result.status}). The link may have expired.`;
      }
      if (result.status >= 500) return `Server error (HTTP ${result.status}).`;
      return `Request failed (HTTP ${result.status}).`;
    case 'timeout':
      return 'The server did not respond in time.';
    case 'network-error':
      return `Network error: ${result.message}`;
    case 'not-manifest':
      return result.reason;
    case 'too-large':
      return 'The response is too large to be a manifest.';
  }
}

/** The failure as an error: unreachable/expired → MANIFEST_UNAVAILABLE, wrong content → MANIFEST_INVALID. */
export function fetchFailureError(result: ManifestFetchFailure): StreamGrabError {
  const code = result.kind === 'not-manifest' || result.kind === 'too-large' ? 'MANIFEST_INVALID' : 'MANIFEST_UNAVAILABLE';
  return new StreamGrabError(describeFetchFailure(result), code);
}

const noRelease = (): Promise<void> => Promise.resolve();

/**
 * Downloads manifest text from the extension (exempt from CORS through host
 * permissions; the browser attaches the site's cookies). The body is streamed:
 * reading stops as soon as the first few KB show it is not a manifest, or
 * when it exceeds the size cap.
 */
export class ManifestFetcher {
  readonly #fetch: FetchFunction;
  readonly #acquire: AcquireRequestContext;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #sniffChars: number;

  constructor(options: ManifestFetcherOptions) {
    this.#fetch = options.fetch;
    this.#acquire = options.acquireContext ?? (() => Promise.resolve(noRelease));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxBytes = options.maxBytes ?? MAX_MANIFEST_BYTES;
    this.#sniffChars = options.sniffChars ?? 4096;
  }

  async fetchManifest(url: string, context: RequestContext, signal?: AbortSignal): Promise<ManifestFetchResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    const forwardAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let release = noRelease;
    try {
      release = await this.#acquire(url, context);
      const response = await this.#fetch(url, {
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'http-error', status: response.status };
      }
      const declaredLength = Number(response.headers.get('content-length') ?? Number.NaN);
      if (declaredLength > this.#maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return { kind: 'too-large' };
      }
      return await this.#readBody(response, url);
    } catch (error) {
      if (timedOut) return { kind: 'timeout' };
      return { kind: 'network-error', message: redactText(errorMessage(error)) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
      await release().catch(() => undefined);
    }
  }

  async #readBody(response: Response, requestedUrl: string): Promise<ManifestFetchResult> {
    const finalUrl = response.url || requestedUrl;
    const notManifest: ManifestFetchResult = {
      kind: 'not-manifest',
      reason: 'Body is neither an HLS playlist nor a DASH MPD',
    };
    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      const protocol = sniffManifest(text);
      return protocol ? { kind: 'ok', text, finalUrl, protocol } : notManifest;
    }

    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let decided: StreamingProtocol | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > this.#maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too-large' };
      }
      text += decoder.decode(value, { stream: true });
      if (decided === undefined && text.length >= this.#sniffChars) {
        const protocol = sniffManifest(text);
        if (!protocol) {
          await reader.cancel().catch(() => undefined);
          return notManifest;
        }
        decided = protocol;
      }
    }
    text += decoder.decode();
    const protocol = decided ?? sniffManifest(text);
    return protocol ? { kind: 'ok', text, finalUrl, protocol } : notManifest;
  }
}
