import { describe, expect, it } from 'vitest';
import { inspectManifest, sniffManifest, type ManifestInfo } from '@/core/detection/manifest-inspector';
import dashDrm from '@tests/fixtures/manifests/dash/drm.mpd?raw';
import dashDynamic from '@tests/fixtures/manifests/dash/dynamic.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';
import hlsMasterFairplay from '@tests/fixtures/manifests/hls/master-fairplay.m3u8?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsAes128 from '@tests/fixtures/manifests/hls/media-aes128.m3u8?raw';
import hlsLive from '@tests/fixtures/manifests/hls/media-live.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';

const BASE = 'https://cdn.example.com/vod/movie/master.m3u8?token=abc';

function info(result: ReturnType<typeof inspectManifest>): ManifestInfo {
  if (!result.ok) throw new Error(`expected a manifest: ${result.reason}`);
  return result.info;
}

describe('sniffManifest', () => {
  it('recognises HLS and DASH by their first bytes', () => {
    expect(sniffManifest('#EXTM3U\n#EXT-X-VERSION:3')).toBe('hls');
    expect(sniffManifest(String.fromCharCode(0xfeff) + '  #EXTM3U')).toBe('hls');
    expect(sniffManifest('<?xml version="1.0"?>\n<!-- c --><MPD xmlns="x">')).toBe('dash');
    expect(sniffManifest('<mpd:MPD xmlns:mpd="urn:mpeg:dash:schema:mpd:2011">')).toBe('dash');
  });

  it('rejects HTML, JSON and binary data', () => {
    expect(sniffManifest('<!DOCTYPE html><html><body>Forbidden</body></html>')).toBeNull();
    expect(sniffManifest('{"manifest":"x.m3u8"}')).toBeNull();
    expect(sniffManifest('G@\u0000\u0010')).toBeNull();
    expect(sniffManifest('')).toBeNull();
  });
});

describe('inspectManifest (HLS, via the HLS parser)', () => {
  it('summarises a master playlist and lists every referenced playlist', () => {
    const master = info(inspectManifest(hlsMaster, BASE));
    expect(master).toMatchObject({ protocol: 'hls', role: 'master', live: false, drmSystems: [], encryption: 'none' });
    expect(master.childUrls).toEqual([
      'https://cdn.example.com/vod/movie/video/1080p/prog_index.m3u8',
      'https://cdn2.example.com/vod/movie/video/720p/prog_index.m3u8?token=abc123',
      'https://cdn.example.com/vod/shared/360p/prog_index.m3u8',
      'https://cdn.example.com/vod/movie/audio/en/prog_index.m3u8',
      'https://cdn.example.com/vod/movie/audio/fr/prog_index.m3u8',
      'https://cdn.example.com/vod/movie/video/1080p/iframe_index.m3u8',
    ]);
    expect(master.media?.variants.map((variant) => variant.height)).toEqual([1080, 720, 360]);
    expect(master.media?.audioTracks).toEqual([
      { id: 'audio-0', name: 'English', language: 'en', isDefault: true },
      { id: 'audio-1', name: 'Français, stéréo', language: 'fr', isDefault: false },
    ]);
  });

  it('summarises media playlists: duration, live state, encryption, DRM', () => {
    expect(info(inspectManifest(hlsTs, BASE))).toMatchObject({ role: 'media', live: false, media: { durationSec: 34.5 } });
    expect(info(inspectManifest(hlsLive, BASE))).toMatchObject({ role: 'media', live: true });
    expect(info(inspectManifest(hlsLive, BASE)).media?.durationSec).toBeUndefined();
    expect(info(inspectManifest(hlsAes128, BASE))).toMatchObject({ encryption: 'aes-128', drmSystems: [] });
    expect(info(inspectManifest(hlsMasterFairplay, BASE)).drmSystems).toEqual(['fairplay']);
  });

  it('rejects plain M3U and malformed playlists', () => {
    expect(inspectManifest('#EXTM3U\n#EXTINF:123,Artist - Song\nsong.mp3', BASE).ok).toBe(false);
    expect(inspectManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', BASE).ok).toBe(false);
  });
});

describe('inspectManifest (DASH, via the DASH parser)', () => {
  const MPD_URL = 'https://cdn.example.com/vod/movie/manifest.mpd';

  it('summarises a static presentation with separate audio', () => {
    const result = info(inspectManifest(dashStatic, MPD_URL));
    expect(result).toMatchObject({ protocol: 'dash', role: 'presentation', live: false, drmSystems: [], encryption: 'none', childUrls: [] });
    expect(result.media?.durationSec).toBeCloseTo(634.567, 3);
    expect(result.media?.variants.map((variant) => variant.height)).toEqual([1080, 720, 360]);
    expect(result.media?.audioTracks).toEqual([{ id: 'audio-0', name: 'en', language: 'en', isDefault: true, codec: 'mp4a.40.2' }]);
  });

  it('flags dynamic presentations and DRM', () => {
    expect(info(inspectManifest(dashDynamic, MPD_URL, Date.parse('2026-11-05T10:00:10Z'))).live).toBe(true);
    expect(info(inspectManifest(dashDrm, MPD_URL))).toMatchObject({ drmSystems: ['widevine', 'playready'], encryption: 'cenc' });
  });

  it('rejects non-MPD XML', () => {
    expect(inspectManifest('<?xml version="1.0"?><SmoothStreamingMedia/>', MPD_URL).ok).toBe(false);
  });
});

describe('inspectManifest', () => {
  it('chooses the protocol from the content, not the URL', () => {
    expect(info(inspectManifest(dashStatic, 'https://a.example/looks-like.m3u8')).protocol).toBe('dash');
    expect(inspectManifest('<html></html>', 'https://a.example/x.mpd').ok).toBe(false);
  });
});
