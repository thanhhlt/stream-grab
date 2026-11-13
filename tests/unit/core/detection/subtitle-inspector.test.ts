import { describe, expect, it, vi } from 'vitest';
import {
  checkSubtitleFile,
  fileNameLanguage,
  headerLanguage,
  inspectSubtitleFile,
  MAX_SUBTITLE_FILE_BYTES,
} from '@/core/detection/subtitle-inspector';
import { pageSubtitleName } from '@/core/detection/detection-manager';

// The shape of a real site's file: extra header lines, minutes-only timestamps, a version suffix in the URL.
const SITE_FILE = ['WEBVTT', 'Kind: subtitles', 'Language: zh', 'Version: 1', 'PublishDate: 2024-05-03', '', '00:10.086 --> 00:12.086', 'line one', '', '01:00.746 --> 01:02.246', 'line two', ''].join('\n');
const SITE_URL = 'https://cdn.example.com/sub/captions.zh.vtt.r20240612';

describe('page subtitle files (0.7.2)', () => {
  it('accepts a whole WebVTT file and reads its language from the header', () => {
    expect(checkSubtitleFile(SITE_FILE, SITE_URL)).toEqual({ ok: true, language: 'zh', cues: [{ start: 10.086, text: 'line one' }, { start: 60.746, text: 'line two' }] });
    expect(headerLanguage('WEBVTT\nLanguage: pt_BR\n\n00:01.000 --> 00:02.000\nx')).toBe('pt-BR');
    expect(headerLanguage('WEBVTT\n\nLanguage: en\n')).toBeUndefined();
  });

  it('rejects segments of a rendition, other bodies and files without cues', () => {
    const segment = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:01.000 --> 00:02.000\nx\n';
    expect(checkSubtitleFile(segment, SITE_URL)).toMatchObject({ ok: false });
    expect(checkSubtitleFile('<html>nope</html>', SITE_URL)).toMatchObject({ ok: false });
    expect(checkSubtitleFile('WEBVTT\n\nNOTE nothing\n', SITE_URL)).toMatchObject({ ok: false });
    // A player's thumbnail track.
    const thumbs = 'WEBVTT\n\n00:00.000 --> 00:05.000\nsprite.jpg#xywh=0,0,160,90\n\n00:05.000 --> 00:10.000\nhttps://img.example/t/2.jpg\n';
    expect(checkSubtitleFile(thumbs, 'https://a.example/thumbs.vtt')).toEqual({ ok: false, reason: 'A thumbnail track, not subtitles' });
  });

  it('takes the language from the file name when the header has none', () => {
    expect(fileNameLanguage(SITE_URL)).toBe('zh');
    expect(fileNameLanguage('https://a.example/movie.eng.vtt')).toBe('en'); // canonical form
    expect(fileNameLanguage('https://a.example/subs/movie_pt-BR.vtt')).toBe('pt-BR');
    expect(fileNameLanguage('https://a.example/subs/captions.vtt')).toBeUndefined();
    expect(fileNameLanguage('https://a.example/subs/sub_01.vtt')).toBeUndefined();
    // Everyday words and codes that are not the last word are not languages.
    for (const name of ['my_video', 'video_id', 'it_crowd', 'no_subs', 'my_cat', 'en_episode']) {
      expect(fileNameLanguage(`https://a.example/subs/${name}.vtt`), name).toBeUndefined();
    }
    expect(checkSubtitleFile('WEBVTT\n\n00:01.000 --> 00:02.000\nx\n', 'https://a.example/x.fr.vtt')).toMatchObject({ ok: true, language: 'fr' });
  });

  it('names a file by its language, else by its file name, numbering repeats', () => {
    expect(pageSubtitleName([], SITE_URL, 'zh')).toBe('Chinese');
    expect(pageSubtitleName([{ id: 'page-0', name: 'Chinese', isDefault: false }], SITE_URL, 'zh')).toBe('Chinese 2');
    expect(pageSubtitleName([], SITE_URL, undefined)).toBe('captions.zh');
    expect(pageSubtitleName([], 'https://a.example/api/subs', undefined)).toBe('subs');
  });

  it('fetches with the page context, and gives up on errors and oversized bodies', async () => {
    const release = vi.fn(() => Promise.resolve());
    const acquireContext = vi.fn(() => Promise.resolve(release));
    const ok = vi.fn(() => Promise.resolve(new Response(SITE_FILE, { status: 200 })));
    await expect(inspectSubtitleFile({ fetch: ok, acquireContext }, SITE_URL, { referer: 'https://site.example/' })).resolves.toMatchObject({
      ok: true,
      language: 'zh',
    });
    expect(acquireContext).toHaveBeenCalledWith(SITE_URL, { referer: 'https://site.example/' });
    expect(release).toHaveBeenCalled();

    const missing = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    await expect(inspectSubtitleFile({ fetch: missing }, SITE_URL, {})).resolves.toMatchObject({ ok: false, transient: true });
    const huge = vi.fn(() => Promise.resolve(new Response(new Uint8Array(MAX_SUBTITLE_FILE_BYTES + 1), { status: 200 })));
    await expect(inspectSubtitleFile({ fetch: huge }, SITE_URL, {})).resolves.toEqual({ ok: false, reason: 'The file is too large to be subtitles' });
    const broken = vi.fn(() => Promise.reject(new Error('offline')));
    await expect(inspectSubtitleFile({ fetch: broken }, SITE_URL, {})).resolves.toMatchObject({ ok: false });
  });
});
