import { describe, expect, it } from 'vitest';
import type { MediaSegment } from '@/core/models/media-segment';
import { dashSegments, parseMpd, type ParsedMpd } from '@/core/protocols/dash/dash-mpd';
import { StreamGrabError } from '@/shared/utils/errors';
import dashDynamic from '@tests/fixtures/manifests/dash/dynamic.mpd?raw';
import dashMultiAudio from '@tests/fixtures/manifests/dash/multi-audio.mpd?raw';
import dashMultiPeriod from '@tests/fixtures/manifests/dash/multi-period.mpd?raw';
import dashSegmentBase from '@tests/fixtures/manifests/dash/segment-base.mpd?raw';
import dashSegmentList from '@tests/fixtures/manifests/dash/segment-list.mpd?raw';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';

const MPD_URL = 'https://cdn.example.com/vod/movie/manifest.mpd';
const NOW = Date.parse('2026-11-05T10:00:10Z');
const MAIN = { id: 'main', type: 'main' } as const;

function parse(text: string, url = MPD_URL): ParsedMpd {
  return parseMpd(text, url, NOW);
}

function mainSegments(parsed: ParsedMpd, representationId: string): MediaSegment[] {
  const playlist = parsed.mainRepresentations.get(representationId);
  if (!playlist) throw new Error(`no representation ${representationId}`);
  return dashSegments(playlist, parsed.url, MAIN);
}

function audioSegments(parsed: ParsedMpd, trackIndex = 0): MediaSegment[] {
  const track = parsed.audioTracks[trackIndex];
  const playlist = track?.dash ? parsed.audioRepresentations.get(track.dash.representationId) : undefined;
  if (!track || !playlist) throw new Error('no audio track');
  return dashSegments(playlist, parsed.url, { id: track.id, type: 'audio' });
}

function expectInvalid(run: () => unknown): void {
  expect(run).toThrow(StreamGrabError);
  try {
    run();
  } catch (error) {
    expect((error as StreamGrabError).code).toBe('MANIFEST_INVALID');
  }
}

const tail = (url: string) => url.replace('https://cdn.example.com/vod/movie/', '');

describe('parseMpd', () => {
  it('lists multiple representations and a separate audio adaptation set (static presentation)', () => {
    const parsed = parse(dashStatic);
    expect(parsed).toMatchObject({ isLive: false, url: MPD_URL });
    expect(parsed.durationSec).toBeCloseTo(634.567, 3);
    expect(parsed.variants).toEqual([
      {
        id: 'video-0',
        protocol: 'dash',
        codecs: ['avc1.640028'],
        videoCodec: 'avc1.640028',
        audioOnly: false,
        audioTrackIds: ['audio-0'],
        bandwidth: 5000000,
        width: 1920,
        height: 1080,
        frameRate: 30,
        dash: { representationId: '1080p' },
      },
      expect.objectContaining({ id: 'video-1', height: 720, dash: { representationId: '720p' } }),
      expect.objectContaining({ id: 'video-2', height: 360, dash: { representationId: '360p' } }),
    ]);
    expect(parsed.audioTracks).toEqual([
      { id: 'audio-0', name: 'en', language: 'en', isDefault: true, codec: 'mp4a.40.2', dash: { representationId: 'audio-en' } },
    ]);
  });

  it('names audio tracks by Label or language and role, using the best bitrate of each adaptation set', () => {
    const parsed = parse(dashMultiAudio);
    expect(parsed.audioTracks.map((t) => [t.name, t.language, t.isDefault, t.codec, t.dash?.representationId])).toEqual([
      ['fr (dub)', 'fr', false, 'mp4a.40.2', 'fr-128'],
      ['English (original)', 'en', true, 'ec-3', 'en-128'],
    ]);
    expect(parsed.variants.map((v) => [v.height, v.frameRate, v.videoCodec])).toEqual([
      [1080, 25, 'hvc1.1.6.L120.90'],
      [540, 25, 'hvc1.1.6.L93.90'],
    ]);
  });

  it('detects dynamic presentations, without a duration', () => {
    const parsed = parse(dashDynamic);
    expect(parsed.isLive).toBe(true);
    expect(parsed.durationSec).toBeUndefined();
    expect(parsed.minimumUpdatePeriodMs).toBe(2000);
    expect(mainSegments(parsed, 'v720').filter((s) => s.kind === 'media').length).toBeGreaterThan(0);
  });

  it('keeps one copy of a representation repeated for several BaseURLs', () => {
    const text = dashSegmentList.replace(
      '<BaseURL>https://media.example.org/content/</BaseURL>',
      '<BaseURL>https://media.example.org/content/</BaseURL><BaseURL>https://backup.example.org/content/</BaseURL>',
    );
    expect(parse(text).variants.map((v) => v.dash?.representationId)).toEqual(['v1']);
  });

  it('turns an audio-only presentation into audio-only variants', () => {
    const text = dashSegmentBase.replace(/<AdaptationSet contentType="video"[\s\S]*?<\/AdaptationSet>/, '');
    const parsed = parse(text);
    expect(parsed.variants).toEqual([expect.objectContaining({ audioOnly: true, dash: { representationId: 'audio-en' } })]);
    expect(parsed.audioTracks).toEqual([]);
  });

  it('rejects documents that are not usable MPDs', () => {
    expectInvalid(() => parse('<?xml version="1.0"?><SmoothStreamingMedia/>'));
    expectInvalid(() => parse('<MPD type="static"><Period>'));
    expectInvalid(() => parse('<MPD type="static" mediaPresentationDuration="PT1S"><Period/></MPD>'));
    expectInvalid(() =>
      parse('<?xml version="1.0"?><!DOCTYPE MPD [<!ENTITY a "aaaaaaaa">]><MPD type="static"><Period/></MPD>'),
    );
  });
});

describe('dashSegments', () => {
  it('expands SegmentTemplate with SegmentTimeline ($Time$) and the number-based audio template', () => {
    const parsed = parse(dashStatic);
    const video = mainSegments(parsed, '1080p');
    expect(video).toHaveLength(160);
    expect(video[0]).toEqual({
      id: 'main:0',
      trackId: 'main',
      trackType: 'main',
      index: 0,
      kind: 'init',
      url: 'https://cdn.example.com/vod/movie/video/1080p/init.mp4',
      duration: 0,
      discontinuity: 0,
      container: 'fmp4',
    });
    expect([tail(video[1]?.url ?? ''), video[1]?.duration, video[1]?.initSegmentId]).toEqual(['video/1080p/seg-0.m4s', 4, 'main:0']);
    expect([tail(video[159]?.url ?? ''), video[159]?.duration]).toEqual(['video/1080p/seg-56880000.m4s', 2.0567]);
    expect(video.every((s) => s.container === 'fmp4' && s.discontinuity === 0)).toBe(true);

    const audio = audioSegments(parsed);
    expect(audio.map((s) => s.trackId)).toEqual(Array(160).fill('audio-0'));
    expect([tail(audio[1]?.url ?? ''), tail(audio[159]?.url ?? '')]).toEqual(['audio/en/seg-1.m4s', 'audio/en/seg-159.m4s']);
  });

  it('formats $Number%05d$, $RepresentationID$ and $Bandwidth$', () => {
    const parsed = parse(dashMultiAudio);
    expect(mainSegments(parsed, 'hd').map((s) => tail(s.url))).toEqual(['v/hd/3000000/init.mp4', 'v/hd/001.m4s', 'v/hd/002.m4s']);
  });

  it('handles SegmentList with media URLs, and with byte ranges into one file', () => {
    const parsed = parse(dashSegmentList);
    expect(mainSegments(parsed, 'v1').map((s) => [s.kind, s.url, s.byteRange])).toEqual([
      ['init', 'https://media.example.org/content/video/init.mp4', undefined],
      ['media', 'https://media.example.org/content/video/seg1.m4s', undefined],
      ['media', 'https://media.example.org/content/video/seg2.m4s', undefined],
      ['media', 'https://media.example.org/content/video/seg3.m4s', undefined],
    ]);
    expect(audioSegments(parsed).map((s) => [s.kind, s.url, s.byteRange])).toEqual([
      ['init', 'https://audio.example.org/de/track.mp4', { offset: 0, length: 600 }],
      ['media', 'https://audio.example.org/de/track.mp4', { offset: 600, length: 49400 }],
      ['media', 'https://audio.example.org/de/track.mp4', { offset: 50000, length: 50000 }],
      ['media', 'https://audio.example.org/de/track.mp4', { offset: 100000, length: 40000 }],
    ]);
  });

  it('joins periods, marks the boundary as a discontinuity and switches the initialization', () => {
    const segments = mainSegments(parse(dashMultiPeriod), 'v');
    expect(segments.map((s) => [s.kind, tail(s.url), s.discontinuity])).toEqual([
      ['init', 'intro/v/init.mp4', 0],
      ['media', 'intro/v/00001.m4s', 0],
      ['media', 'intro/v/00002.m4s', 0],
      ['media', 'intro/v/00003.m4s', 0],
      ['init', 'feature/v/init.mp4', 1],
      ['media', 'feature/v/00001.m4s', 1],
      ['media', 'feature/v/00002.m4s', 1],
      ['media', 'feature/v/00003.m4s', 1],
      ['media', 'feature/v/00004.m4s', 1],
      ['media', 'feature/v/00005.m4s', 1],
    ]);
    expect(segments[5]?.initSegmentId).toBe('main:4');
  });

  it('returns a SegmentBase representation as one complete file', () => {
    const parsed = parse(dashSegmentBase);
    expect(mainSegments(parsed, 'video-720')).toEqual([
      {
        id: 'main:0',
        trackId: 'main',
        trackType: 'main',
        index: 0,
        kind: 'media',
        url: 'https://cdn.example.com/vod/movie/video_720.mp4',
        duration: 120,
        discontinuity: 0,
        container: 'fmp4',
      },
    ]);
    expect(audioSegments(parsed).map((s) => tail(s.url))).toEqual(['audio_en.mp4']);
  });

  it('resolves references against the final MPD URL', () => {
    const parsed = parse(dashMultiAudio, 'https://edge.cdn.example.net/path/manifest.mpd');
    expect(mainSegments(parsed, 'sd')[1]?.url).toBe('https://edge.cdn.example.net/path/v/sd/001.m4s');
  });
});
