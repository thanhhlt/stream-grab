import { describe, expect, it, vi } from 'vitest';
import { ManifestCache, raceAbort } from '@/core/protocols/manifest-cache';

interface Value {
  url: string;
  ttl: number;
}

function setup(maxEntries = 3) {
  let now = 0;
  const cache = new ManifestCache<Value>({
    now: () => now,
    maxEntries,
    ttlFor: (value) => value.ttl,
    aliasesFor: (value) => [value.url],
  });
  return {
    cache,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('ManifestCache', () => {
  it('shares one in-flight load between callers and reuses the value until it expires', async () => {
    const { cache, advance } = setup();
    const load = vi.fn(() => Promise.resolve({ url: 'a', ttl: 1000 }));
    await Promise.all([cache.get('a', load), cache.get('a', load)]);
    advance(999);
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(1);
    advance(1);
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures', async () => {
    const { cache } = setup();
    const load = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce({ url: 'a', ttl: 1000 });
    await expect(cache.get('a', load)).rejects.toThrow('503');
    await expect(cache.get('a', load)).resolves.toMatchObject({ url: 'a' });
  });

  it('finds values under their alias (post-redirect) URL', async () => {
    const { cache } = setup();
    await cache.get('requested', () => Promise.resolve({ url: 'final', ttl: 1000 }));
    const load = vi.fn(() => Promise.resolve({ url: 'final', ttl: 1000 }));
    await cache.get('final', load);
    expect(load).not.toHaveBeenCalled();
  });

  it('evicts the least recently stored entries beyond its size', async () => {
    const { cache } = setup(2);
    for (const url of ['a', 'b', 'c']) cache.put(url, { url, ttl: 1000 });
    const load = vi.fn((url: string) => Promise.resolve({ url, ttl: 1000 }));
    await cache.get('c', () => load('c'));
    await cache.get('a', () => load('a'));
    expect(load.mock.calls.map(([url]) => url)).toEqual(['a']);
  });
});

describe('raceAbort', () => {
  it('rejects for an aborted caller but leaves the shared promise alone', async () => {
    let resolve: (value: number) => void = () => undefined;
    const shared = new Promise<number>((r) => {
      resolve = r;
    });
    const controller = new AbortController();
    const waiting = raceAbort(shared, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    resolve(7);
    await expect(raceAbort(shared, undefined)).resolves.toBe(7);
  });
});
