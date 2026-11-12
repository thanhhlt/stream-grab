import { describe, expect, it } from 'vitest';
import { trackSubtitles } from '@/core/detection/dom-candidate';
import { parseDetectedStream, parseSubtitleTrackSummary } from '@/core/detection/detection-store';
import { summarizeManifest } from '@/core/detection/manifest-inspector';
import { buildHlsManifest } from '@/core/protocols/hls/hls-adapter';
import { parseHlsPlaylist } from '@/core/protocols/hls/hls-playlist';
import hlsMasterSubtitles from '@tests/fixtures/manifests/hls/master-subtitles.m3u8?raw';

describe('subtitle summaries (0.7.0)', () => {
  it('summarises manifest subtitle tracks and links them to their qualities', () => {
    const top = parseHlsPlaylist(hlsMasterSubtitles, 'https://cdn.example.com/show/master.m3u8');
    const media = summarizeManifest(buildHlsManifest(top, undefined, 'https://cdn.example.com/show/master.m3u8', {}));
    expect(media.subtitleTracks).toEqual([
      { id: 'subtitle-0', name: 'English', language: 'en', isDefault: true },
      { id: 'subtitle-1', name: 'Tiếng Việt', language: 'vi', isDefault: false },
      { id: 'subtitle-2', name: 'English (forced)', language: 'en', isDefault: false, forced: true },
    ]);
    expect(media.variants.map((variant) => variant.subtitleTrackIds)).toEqual([['subtitle-0', 'subtitle-1', 'subtitle-2'], undefined]);
  });

  it('turns <track> elements into tracks named by label, language or position', () => {
    expect(
      trackSubtitles([
        { url: 'https://a.example/en.vtt', language: 'en', label: 'English', isDefault: true },
        { url: 'https://a.example/fr.vtt', language: 'fr', isDefault: false },
        { url: 'https://a.example/x.vtt', isDefault: false },
      ]),
    ).toEqual([
      { id: 'track-0', name: 'English', language: 'en', isDefault: true, url: 'https://a.example/en.vtt' },
      { id: 'track-1', name: 'fr', language: 'fr', isDefault: false, url: 'https://a.example/fr.vtt' },
      { id: 'track-2', name: 'Subtitles 3', isDefault: false, url: 'https://a.example/x.vtt' },
    ]);
  });

  it('validates stored subtitle tracks', () => {
    expect(parseSubtitleTrackSummary({ id: 'track-0', name: 'English', isDefault: true, forced: true, url: 'https://a.example/en.vtt' })).toEqual({
      id: 'track-0',
      name: 'English',
      isDefault: true,
      forced: true,
      url: 'https://a.example/en.vtt',
    });
    expect(parseSubtitleTrackSummary({ id: 'track-0', name: 'x', url: 'javascript:alert(1)' })).toBeNull();
    expect(parseSubtitleTrackSummary({ id: 'track-0' })).toBeNull();
    expect(parseSubtitleTrackSummary({ id: 'x'.repeat(65), name: 'x' })).toBeNull();
  });

  it('reads subtitle fields back with a stored stream, and older streams without them', () => {
    const stored = {
      id: 's1',
      tabId: 1,
      frameId: 0,
      protocol: 'hls',
      url: 'https://cdn.example.com/show/master.m3u8',
      dedupeKey: 'cdn.example.com/show/master.m3u8',
      evidence: ['extension'],
      status: 'ready',
      requestContext: {},
      firstSeen: 1,
      lastSeen: 1,
      media: {
        variants: [{ id: 'video-0', audioOnly: false, audioTrackIds: [], subtitleTrackIds: ['subtitle-0', 7] }],
        audioTracks: [],
        subtitleTracks: [{ id: 'subtitle-0', name: 'English', language: 'en', isDefault: true }, 'junk'],
      },
    };
    const stream = parseDetectedStream(stored);
    expect(stream?.media?.subtitleTracks).toEqual([{ id: 'subtitle-0', name: 'English', language: 'en', isDefault: true }]);
    expect(stream?.media?.variants[0]?.subtitleTrackIds).toEqual(['subtitle-0']);

    const older = parseDetectedStream({ ...stored, media: { variants: [{ id: 'video-0', audioOnly: false, audioTrackIds: [] }], audioTracks: [] } });
    expect(older?.media).toEqual({ variants: [{ id: 'video-0', audioOnly: false, audioTrackIds: [] }], audioTracks: [] });
  });
});
