import { describe, expect, it, vi } from 'vitest';
import { createPageInfoResolver } from '@/background/page-info';
import type { FrameMetadata } from '@/shared/types/page-metadata';

const top: FrameMetadata = {
  url: 'https://site.example/watch',
  isTopFrame: true,
  documentTitle: 'Watch: Big Buck Bunny - Site',
  videos: [],
};

describe('createPageInfoResolver', () => {
  it('retries until the content script of the frame answers', async () => {
    const getFrameMetadata = vi
      .fn<(tabId: number, frameId: number) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('Receiving end does not exist'))
      .mockResolvedValueOnce(top);
    const delay = vi.fn(() => Promise.resolve());
    const resolve = createPageInfoResolver({
      getTab: () => Promise.resolve({ url: 'https://site.example/watch', title: 'Tab title' }),
      getFrameMetadata,
      delay,
      retryDelaysMs: [0, 10, 20],
    });
    await expect(resolve(3, 0)).resolves.toEqual({
      title: 'Watch: Big Buck Bunny - Site',
      pageTitle: 'Watch: Big Buck Bunny - Site',
      pageUrl: 'https://site.example/watch',
    });
    expect(delay).toHaveBeenCalledWith(10);
  });

  it('falls back to the tab title when no content script answers', async () => {
    const resolve = createPageInfoResolver({
      getTab: () => Promise.resolve({ url: 'https://site.example/', title: 'Tab title' }),
      getFrameMetadata: () => Promise.reject(new Error('no receiver')),
      delay: () => Promise.resolve(),
      retryDelaysMs: [0],
    });
    await expect(resolve(3, 2)).resolves.toEqual({
      title: 'Tab title',
      pageTitle: 'Tab title',
      pageUrl: 'https://site.example/',
    });
  });

  it('validates untrusted metadata', async () => {
    const resolve = createPageInfoResolver({
      getTab: () => Promise.resolve(null),
      getFrameMetadata: () => Promise.resolve({ url: 42, documentTitle: '<script>' }),
      delay: () => Promise.resolve(),
      retryDelaysMs: [0],
    });
    await expect(resolve(3, 0)).resolves.toEqual({});
  });

  it('shares one lookup between streams of the same frame', async () => {
    const getFrameMetadata = vi.fn(() => Promise.resolve(top));
    const resolve = createPageInfoResolver({
      getTab: () => Promise.resolve(null),
      getFrameMetadata,
      delay: () => Promise.resolve(),
      now: () => 0,
    });
    await Promise.all([resolve(3, 0), resolve(3, 0), resolve(3, 0)]);
    expect(getFrameMetadata).toHaveBeenCalledTimes(1);
  });
});
