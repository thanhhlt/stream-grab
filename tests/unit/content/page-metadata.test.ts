// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { collectFrameMetadata, structuredVideoTitle } from '@/content/page-metadata';
import { parseFrameMetadata } from '@/shared/types/page-metadata';

describe('collectFrameMetadata', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.title = '';
  });

  it('collects document, Open Graph and JSON-LD titles and the video elements', () => {
    document.head.innerHTML = `
      <meta property="og:title" content="Episode 4: The Return">
      <script type="application/ld+json">
        {"@context":"https://schema.org","@graph":[{"@type":"WebPage"},{"@type":"VideoObject","name":"Episode 4 (structured)"}]}
      </script>`;
    document.title = '  Episode 4 —\n  My Show  ';
    document.body.innerHTML = `
      <figure><video id="a"></video><figcaption>Main feature</figcaption></figure>
      <span id="lbl">Behind the scenes</span><video aria-labelledby="lbl"></video>
      <video title="Trailer"></video>`;

    const metadata = collectFrameMetadata(document, window);
    expect(metadata).toMatchObject({
      isTopFrame: true,
      documentTitle: 'Episode 4 — My Show',
      socialTitle: 'Episode 4: The Return',
      structuredTitle: 'Episode 4 (structured)',
    });
    expect(metadata.videos.map((video) => video.title)).toEqual(['Main feature', 'Behind the scenes', 'Trailer']);
    expect(parseFrameMetadata(JSON.parse(JSON.stringify(metadata)))).toEqual(metadata);
  });

  it('ignores malformed or irrelevant JSON-LD', () => {
    document.head.innerHTML = `
      <script type="application/ld+json">{not json</script>
      <script type="application/ld+json">{"@type":"Article","name":"Not a video"}</script>
      <script type="application/ld+json">[{"@type":["VideoObject","CreativeWork"],"name":"Clip"}]</script>`;
    expect(structuredVideoTitle(document)).toBe('Clip');
  });

  it('omits empty fields', () => {
    const metadata = collectFrameMetadata(document, window);
    expect(metadata.documentTitle).toBeUndefined();
    expect(metadata.socialTitle).toBeUndefined();
    expect(metadata.videos).toEqual([]);
  });
});

describe('parseFrameMetadata', () => {
  it('bounds and sanitises untrusted input', () => {
    const parsed = parseFrameMetadata({
      url: 'https://site.example/',
      isTopFrame: 'yes',
      documentTitle: `a\u0007b ${'x'.repeat(1000)}`,
      videos: [{ title: 5, duration: Number.POSITIVE_INFINITY, width: -1 }, 'nope', { duration: 12 }],
    });
    expect(parsed?.isTopFrame).toBe(false);
    expect(parsed?.documentTitle?.length).toBe(300);
    expect(parsed?.documentTitle?.startsWith('a b')).toBe(true);
    expect(parsed?.videos).toEqual([{}, { duration: 12 }]);
  });
});
