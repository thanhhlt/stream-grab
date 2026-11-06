/**
 * Failure classification and backoff for segment requests.
 *
 * - retryable: network errors, stalls, 408/425/429/5xx → back off and retry
 * - expired:   401/403/404/410 → the signed link probably expired: refresh the
 *              manifest (fresh tokens) instead of hammering the same URL
 * - fatal:     other 4xx, decryption or storage errors → fail the task
 * - aborted:   the task was cancelled
 */

export interface RetryPolicy {
  /** Attempts per segment, including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Upper bound for a server's Retry-After. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
};

export type FailureKind = 'retryable' | 'expired' | 'fatal' | 'aborted';

export class SegmentHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfterMs?: number) {
    super(`HTTP ${status}`);
    this.name = 'SegmentHttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Connection reset, truncated body, no data for too long… */
export class SegmentTransferError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SegmentTransferError';
  }
}

/**
 * The server answered with success but sent a web page or an API error
 * (HTML, XML, JSON) instead of media: an error or login page, an "access
 * denied" document. Retried like a network error (it may be a transient
 * overload page); worded for the user if it persists.
 */
export class SegmentContentError extends SegmentTransferError {
  readonly kind: 'web page' | 'JSON document';

  constructor(kind: 'web page' | 'JSON document') {
    super(`The server sent a ${kind} instead of video data`);
    this.name = 'SegmentContentError';
    this.kind = kind;
  }
}

/** Not worth retrying: decryption failed, storage full, malformed response. */
export class SegmentFatalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SegmentFatalError';
  }
}

/** Writing downloaded data to IndexedDB failed: a local problem, retrying the request would not help. */
export class StorageWriteError extends SegmentFatalError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageWriteError';
  }
}

/** The disk (or the extension's storage quota) is full, or would be after the next writes. */
export class DiskFullError extends StorageWriteError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DiskFullError';
  }
}

export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === 'AbortError';
}

const EXPIRED_STATUSES = new Set([401, 403, 404, 410]);
const RETRYABLE_STATUSES = new Set([408, 425, 429]);

export function classifyFailure(error: unknown): FailureKind {
  if (isAbortError(error)) return 'aborted';
  if (error instanceof SegmentHttpError) {
    if (EXPIRED_STATUSES.has(error.status)) return 'expired';
    if (RETRYABLE_STATUSES.has(error.status) || error.status >= 500) return 'retryable';
    return 'fatal';
  }
  if (error instanceof SegmentFatalError) return 'fatal';
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'fatal';
  // TypeError ("Failed to fetch"), transfer errors and anything unexpected from the network stack.
  return 'retryable';
}

/** Parses Retry-After (seconds or HTTP date) into ms from now. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Delay before retry number `retry` (1 = first retry): exponential with
 * "equal jitter" (half fixed, half random), so clients do not retry in lockstep,
 * or the server's Retry-After when given (capped).
 */
export function backoffDelay(
  retry: number,
  policy: Readonly<RetryPolicy> = DEFAULT_RETRY_POLICY,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxRetryAfterMs);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Resolves after `ms`, or rejects with AbortError when `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
