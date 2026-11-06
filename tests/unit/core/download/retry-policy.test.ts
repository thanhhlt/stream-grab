import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  classifyFailure,
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  SegmentFatalError,
  SegmentHttpError,
  SegmentTransferError,
  sleep,
} from '@/core/download/retry-policy';

describe('classifyFailure', () => {
  it('retries network errors, stalls, timeouts, rate limits and server errors', () => {
    for (const error of [
      new TypeError('Failed to fetch'),
      new SegmentTransferError('No data received for too long'),
      new SegmentHttpError(408),
      new SegmentHttpError(429),
      new SegmentHttpError(500),
      new SegmentHttpError(503),
    ]) {
      expect(classifyFailure(error)).toBe('retryable');
    }
  });

  it('treats 401/403/404/410 as an expired link', () => {
    for (const status of [401, 403, 404, 410]) expect(classifyFailure(new SegmentHttpError(status))).toBe('expired');
  });

  it('gives up on other client errors, decryption and storage failures', () => {
    expect(classifyFailure(new SegmentHttpError(400))).toBe('fatal');
    expect(classifyFailure(new SegmentHttpError(416))).toBe('fatal');
    expect(classifyFailure(new SegmentFatalError('wrong key'))).toBe('fatal');
    expect(classifyFailure(new DOMException('full', 'QuotaExceededError'))).toBe('fatal');
  });

  it('recognises cancellation', () => {
    expect(classifyFailure(new DOMException('Aborted', 'AbortError'))).toBe('aborted');
  });
});

describe('backoffDelay', () => {
  it('grows exponentially with jitter between half and the full step, up to the cap', () => {
    const low = (retry: number) => backoffDelay(retry, DEFAULT_RETRY_POLICY, undefined, () => 0);
    const high = (retry: number) => backoffDelay(retry, DEFAULT_RETRY_POLICY, undefined, () => 1);
    expect([low(1), high(1)]).toEqual([500, 1000]);
    expect([low(2), high(2)]).toEqual([1000, 2000]);
    expect([low(3), high(3)]).toEqual([2000, 4000]);
    expect(high(10)).toBe(30_000);
  });

  it("honours the server's Retry-After, capped", () => {
    expect(backoffDelay(1, DEFAULT_RETRY_POLICY, 7000)).toBe(7000);
    expect(backoffDelay(1, DEFAULT_RETRY_POLICY, 600_000)).toBe(60_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    expect(parseRetryAfter('Wed, 05 Nov 2026 10:00:30 GMT', Date.parse('2026-11-05T10:00:00Z'))).toBe(30_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('sleep', () => {
  it('can be aborted', async () => {
    const controller = new AbortController();
    const waiting = sleep(10_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });
});
