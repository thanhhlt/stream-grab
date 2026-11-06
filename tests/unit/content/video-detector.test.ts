// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findDomSources, watchDomSources } from '@/content/video-detector';
import { parseDomSources } from '@/shared/types/page-metadata';

const BASE = 'https://site.example/watch/page.html';

function fragment(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('findDomSources', () => {
  it('finds manifests referenced by video and source elements and resolves relative URLs', () => {
    const root = fragment(`
      <video src="/streams/a/master.m3u8?token=1"></video>
      <video><source src="https://cdn.example/dash/manifest" type="application/dash+xml"></video>
      <video><source src="../hls/live" type="application/x-mpegURL"></video>
      <video><source src="clip.mp4" type="video/mp4"></video>
      <video src="blob:https://site.example/5e1c"></video>
      <audio src="podcast.m3u8"></audio>`);
    expect(findDomSources(root, BASE)).toEqual([
      { url: 'https://site.example/streams/a/master.m3u8?token=1', protocol: 'hls' },
      { url: 'https://cdn.example/dash/manifest', protocol: 'dash' },
      { url: 'https://site.example/hls/live', protocol: 'hls' },
    ]);
  });

  it('attaches the title of the referencing video element', () => {
    const root = fragment(`
      <video title="Trailer" src="trailer.m3u8"></video>
      <figure><video><source src="feature.mpd"></video><figcaption>Feature</figcaption></figure>`);
    expect(findDomSources(root, BASE)).toEqual([
      { url: 'https://site.example/watch/trailer.m3u8', protocol: 'hls', title: 'Trailer' },
      { url: 'https://site.example/watch/feature.mpd', protocol: 'dash', title: 'Feature' },
    ]);
  });

  it('reports each URL once', () => {
    const root = fragment('<video src="a.m3u8"></video><video src="a.m3u8"></video>');
    expect(findDomSources(root, BASE)).toHaveLength(1);
  });
});

describe('watchDomSources', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('reports existing and later-added sources, each once, in debounced batches', async () => {
    document.body.innerHTML = '<video src="https://cdn.example/one.m3u8"></video>';
    const reports: string[][] = [];
    const watcher = watchDomSources(document, (sources) => reports.push(sources.map((source) => source.url)), 10);
    expect(reports).toEqual([['https://cdn.example/one.m3u8']]);

    const video = document.createElement('video');
    video.src = 'https://cdn.example/two.mpd';
    document.body.append(video);
    document.body.append(document.createElement('div'));
    await vi.waitFor(() => {
      expect(reports).toEqual([['https://cdn.example/one.m3u8'], ['https://cdn.example/two.mpd']]);
    });

    video.setAttribute('src', 'https://cdn.example/two.mpd');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(reports).toHaveLength(2);
    watcher.stop();
  });
});

describe('parseDomSources', () => {
  it('validates content-script reports', () => {
    expect(
      parseDomSources({
        sources: [
          { url: 'https://a.example/x.m3u8', protocol: 'hls' },
          { url: 'javascript:alert(1)', protocol: 'hls' },
          { url: 'https://a.example/y.mpd', protocol: 'smooth' },
          { url: 'https://a.example/z.mpd' },
          'nope',
        ],
      }),
    ).toEqual([{ url: 'https://a.example/x.m3u8', protocol: 'hls' }]);
    expect(parseDomSources(null)).toEqual([]);
    expect(parseDomSources({ sources: 'x' })).toEqual([]);
  });
});
