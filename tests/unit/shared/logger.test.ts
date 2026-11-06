import { describe, expect, it, vi } from 'vitest';
import { createLogger, sanitizeLogValue, type LogSink } from '@/shared/utils/logger';

function createSink() {
  return {
    debug: vi.fn<LogSink['debug']>(),
    info: vi.fn<LogSink['info']>(),
    warn: vi.fn<LogSink['warn']>(),
    error: vi.fn<LogSink['error']>(),
  } satisfies LogSink;
}

describe('createLogger', () => {
  it('prefixes messages with the scope and respects the minimum level', () => {
    const sink = createSink();
    const log = createLogger('test', { minLevel: 'info', sink });
    log.debug('hidden');
    log.info('shown');
    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).toHaveBeenCalledWith('[StreamGrab:test]', 'shown');
  });

  it('redacts URLs in messages and context', () => {
    const sink = createSink();
    const log = createLogger('test', { minLevel: 'debug', sink });
    log.warn('fetch https://cdn.example/a.m3u8?token=secret failed', {
      url: 'https://cdn.example/b.m3u8?sig=secret',
      attempt: 2,
    });
    expect(sink.warn).toHaveBeenCalledWith('[StreamGrab:test]', 'fetch https://cdn.example/a.m3u8?token=*** failed', {
      url: 'https://cdn.example/b.m3u8?sig=***',
      attempt: 2,
    });
  });
});

describe('sanitizeLogValue', () => {
  it('masks values under credential-like keys at any depth', () => {
    expect(
      sanitizeLogValue({ request: { headers: { cookie: 'a=b', Authorization: 'Bearer x', accept: '*/*' } } }),
    ).toEqual({ request: { headers: { cookie: '***', Authorization: '***', accept: '*/*' } } });
  });

  it('turns errors into plain objects with redacted messages', () => {
    expect(sanitizeLogValue(new TypeError('Failed to fetch https://x.example/y?t=1'))).toEqual({
      name: 'TypeError',
      message: 'Failed to fetch https://x.example/y?t=***',
    });
  });

  it('limits nesting depth', () => {
    expect(sanitizeLogValue({ a: { b: { c: { d: { e: 1 } } } } })).toEqual({ a: { b: { c: { d: '[…]' } } } });
  });
});
