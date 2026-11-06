/**
 * Cache of parsed manifests/playlists shared by the protocol adapters, so the
 * same manifest is fetched and parsed once across detection, the popup and
 * task start.
 *
 * - Entries are promises: concurrent callers share one request.
 * - The expiry is decided once the value is known (live content is short-lived).
 * - A failed request is not cached.
 * - A value may also be reachable under alias URLs (its post-redirect URL).
 */

interface Entry<T> {
  expiresAt: number;
  value: Promise<T>;
}

export interface ManifestCacheOptions<T> {
  now: () => number;
  maxEntries: number;
  /** Lifetime of a resolved value, in ms. */
  ttlFor: (value: T) => number;
  /** Other URLs the value can be found under (e.g. after redirects). */
  aliasesFor?: (value: T) => string[];
}

export class ManifestCache<T> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #options: ManifestCacheOptions<T>;

  constructor(options: ManifestCacheOptions<T>) {
    this.#options = options;
  }

  /** Cached value, or a new one from `load` (shared by every caller until it settles). */
  get(url: string, load: () => Promise<T>): Promise<T> {
    const cached = this.#entries.get(url);
    if (cached && cached.expiresAt > this.#options.now()) return cached.value;
    const value = load();
    const entry: Entry<T> = { expiresAt: Number.POSITIVE_INFINITY, value };
    this.#remember(url, entry);
    value.then(
      (resolved) => {
        entry.expiresAt = this.#options.now() + this.#options.ttlFor(resolved);
        for (const alias of this.#options.aliasesFor?.(resolved) ?? []) {
          if (alias !== url) this.#remember(alias, entry);
        }
      },
      () => {
        for (const [key, candidate] of this.#entries) {
          if (candidate === entry) this.#entries.delete(key);
        }
      },
    );
    return value;
  }

  /** Stores an already available value (e.g. a body detection downloaded). */
  put(url: string, value: T): T {
    return this.#putEntry(url, value);
  }

  #putEntry(url: string, value: T): T {
    const entry: Entry<T> = { expiresAt: this.#options.now() + this.#options.ttlFor(value), value: Promise.resolve(value) };
    this.#remember(url, entry);
    for (const alias of this.#options.aliasesFor?.(value) ?? []) {
      if (alias !== url) this.#remember(alias, entry);
    }
    return value;
  }

  #remember(url: string, entry: Entry<T>): void {
    this.#entries.delete(url);
    this.#entries.set(url, entry);
    while (this.#entries.size > this.#options.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}

/** Resolves with `promise`, or rejects as soon as `signal` aborts (the shared work keeps running for others). */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
