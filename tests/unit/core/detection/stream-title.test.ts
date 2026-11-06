import { describe, expect, it } from 'vitest';
import { buildPageInfo, isUsefulTitle } from '@/core/detection/stream-title';
import type { FrameMetadata } from '@/shared/types/page-metadata';

const frame = (overrides: Partial<FrameMetadata>): FrameMetadata => ({
  url: 'https://player.example/embed/1',
  isTopFrame: false,
  videos: [],
  ...overrides,
});

describe('buildPageInfo', () => {
  const top = frame({
    url: 'https://site.example/article',
    isTopFrame: true,
    documentTitle: 'News article - Site',
    socialTitle: 'News article',
  });

  it('prefers the title of the frame’s only video element', () => {
    const embed = frame({ videos: [{ title: 'Interview with the author', duration: 312.5 }], documentTitle: 'Player' });
    expect(buildPageInfo({ frame: embed, top, tab: { url: top.url, title: 'Tab' } })).toEqual({
      title: 'Interview with the author',
      pageTitle: 'News article',
      pageUrl: 'https://site.example/article',
      durationHint: 312.5,
    });
  });

  it('uses structured data and embed document titles before the page title', () => {
    expect(buildPageInfo({ frame: frame({ structuredTitle: 'Trailer (JSON-LD)' }), top, tab: null }).title).toBe(
      'Trailer (JSON-LD)',
    );
    expect(buildPageInfo({ frame: frame({ documentTitle: 'Trailer from Studio on Player' }), top, tab: null }).title).toBe(
      'Trailer from Studio on Player',
    );
  });

  it('skips generic widget titles and ambiguous multi-video frames', () => {
    const generic = frame({ documentTitle: 'Video Player', videos: [{ title: 'a' }, { title: 'b' }] });
    expect(buildPageInfo({ frame: generic, top, tab: null })).toMatchObject({ title: 'News article' });
    expect(buildPageInfo({ frame: generic, top, tab: null }).durationHint).toBeUndefined();
  });

  it('falls back to the tab title, then to nothing', () => {
    expect(buildPageInfo({ frame: null, top: null, tab: { title: 'Tab title', url: 'https://x.example/' } })).toEqual({
      title: 'Tab title',
      pageTitle: 'Tab title',
      pageUrl: 'https://x.example/',
    });
    expect(buildPageInfo({ frame: null, top: null, tab: null })).toEqual({});
  });
});

describe('isUsefulTitle', () => {
  it('rejects placeholders', () => {
    expect(isUsefulTitle('Player')).toBe(false);
    expect(isUsefulTitle('Loading...')).toBe(false);
    expect(isUsefulTitle(undefined)).toBe(false);
    expect(isUsefulTitle('Episode 4')).toBe(true);
  });
});
