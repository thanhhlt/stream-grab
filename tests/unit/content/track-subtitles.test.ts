// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findDomSources, watchDomSources } from '@/content/video-detector';
import { parseDomSources, type DomSource } from '@/shared/types/page-metadata';

const BASE = 'https://site.example/watch/page.html';

function fragment(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

describe('<track> subtitles of progressive files (0.7.0)', () => {
  it('lists subtitles and captions tracks with a src, in document order', () => {
    const root = fragment(`
      <video src="clip.mp4">
        <track src="subs/en.vtt" srclang="en" label="English" default>
        <track kind="captions" src="https://cdn.example/fr.vtt" srclang="fr">
        <track kind="chapters" src="chapters.vtt">
        <track kind="metadata" src="meta.vtt">
        <track kind="subtitles" label="No source">
        <track src="javascript:alert(1)">
      </video>`);
    expect(findDomSources(root, BASE)).toEqual([
      {
        url: 'https://site.example/watch/clip.mp4',
        protocol: 'progressive',
        container: 'mp4',
        subtitles: [
          { url: 'https://site.example/watch/subs/en.vtt', language: 'en', label: 'English', isDefault: true },
          { url: 'https://cdn.example/fr.vtt', language: 'fr', isDefault: false },
        ],
      },
    ]);
  });

  it('gives every <source> of a video the same tracks, and manifests none', () => {
    const root = fragment(`
      <video><source src="a.webm"><source src="a.mp4"><track src="a.vtt"></video>
      <video src="b.m3u8"><track src="b.vtt"></video>`);
    const sources = findDomSources(root, BASE);
    expect(sources.map((source) => source.subtitles?.length)).toEqual([1, 1, undefined]);
  });

  describe('watchDomSources', () => {
    afterEach(() => {
      vi.useRealTimers();
      document.body.innerHTML = '';
    });

    it('reports a file again when the player adds tracks later', async () => {
      vi.useFakeTimers();
      document.body.innerHTML = '<video src="clip.mp4"></video>';
      const reports: DomSource[][] = [];
      const watcher = watchDomSources(document, (sources) => reports.push(sources), 100);
      expect(reports).toEqual([[{ url: 'http://localhost:3000/clip.mp4', protocol: 'progressive', container: 'mp4', subtitles: [] }]]);

      const track = document.createElement('track');
      track.src = 'en.vtt';
      track.srclang = 'en';
      document.querySelector('video')!.append(track);
      await vi.advanceTimersByTimeAsync(150);
      expect(reports).toHaveLength(2);
      expect(reports[1]?.[0]?.subtitles).toEqual([{ url: 'http://localhost:3000/en.vtt', language: 'en', isDefault: false }]);

      // Nothing new: no report.
      document.body.append(document.createElement('p'));
      await vi.advanceTimersByTimeAsync(150);
      expect(reports).toHaveLength(2);

      // The player removes the track: reported again with an empty list.
      track.remove();
      await vi.advanceTimersByTimeAsync(150);
      expect(reports[2]?.[0]?.subtitles).toEqual([]);
      watcher.stop();
    });
  });

  it('validates reported tracks', () => {
    const tracks = [
      { url: 'https://cdn.example/en.vtt', language: 'en', label: 'English', isDefault: true },
      { url: 'file:///etc/passwd', isDefault: false },
      { url: 42 },
      'junk',
      { url: 'https://cdn.example/x.vtt', language: 'x'.repeat(50), isDefault: 'yes' },
    ];
    const sources = parseDomSources({
      sources: [
        { url: 'https://site.example/a.mp4', protocol: 'progressive', container: 'mp4', subtitles: tracks },
        { url: 'https://site.example/b.m3u8', protocol: 'hls', subtitles: tracks },
      ],
    });
    expect(sources[0]?.subtitles).toEqual([
      { url: 'https://cdn.example/en.vtt', language: 'en', label: 'English', isDefault: true },
      { url: 'https://cdn.example/x.vtt', isDefault: false },
    ]);
    expect(sources[1]?.subtitles).toBeUndefined();
  });
});
