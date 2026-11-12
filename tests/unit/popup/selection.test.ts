import { describe, expect, it } from 'vitest';
import type { DetectedStream } from '@/core/models/detected-stream';
import {
  defaultChoice,
  downloadAvailability,
  selectAllState,
  toRequest,
  defaultSubtitleTracks,
  withAudioTrack,
  withFileName,
  withSubtitleTrack,
  withVariant,
} from '@/popup/selection';

const stream = (overrides: Partial<DetectedStream> = {}): DetectedStream => ({
  id: 's1',
  tabId: 4,
  frameId: 0,
  protocol: 'hls',
  url: 'https://cdn.example.com/vod/master.m3u8',
  dedupeKey: 'https://cdn.example.com/vod/master.m3u8',
  evidence: ['extension'],
  status: 'ready',
  requestContext: {},
  firstSeen: 1,
  lastSeen: 1,
  title: 'Movie Title',
  manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' },
  media: {
    durationSec: 600,
    variants: [
      { id: 'video-0', height: 1080, audioOnly: false, audioTrackIds: ['audio-0', 'audio-1'] },
      { id: 'video-1', height: 720, audioOnly: false, audioTrackIds: ['audio-0', 'audio-1'] },
      { id: 'video-2', height: 360, audioOnly: false, audioTrackIds: [] },
    ],
    audioTracks: [
      { id: 'audio-0', name: 'English', isDefault: true },
      { id: 'audio-1', name: 'Français', isDefault: false },
    ],
  },
  ...overrides,
});

describe('downloadAvailability', () => {
  it('allows ready, non-live streams with parsed media', () => {
    expect(downloadAvailability(stream())).toEqual({ ok: true });
  });

  it('explains why other streams cannot be selected', () => {
    expect(downloadAvailability(stream({ status: 'pending' }))).toMatchObject({ ok: false });
    expect(downloadAvailability(stream({ status: 'drm' }))).toEqual({
      ok: false,
      reason: 'DRM-protected streams cannot be downloaded.',
    });
    expect(downloadAvailability(stream({ status: 'error', statusMessage: 'HTTP 403' }))).toEqual({ ok: false, reason: 'HTTP 403' });
    expect(
      downloadAvailability(stream({ manifest: { role: 'media', live: true, drmSystems: [], encryption: 'none' } })),
    ).toEqual({ ok: false, reason: 'Live streams cannot be downloaded yet.' });
    expect(downloadAvailability(stream({ media: { variants: [], audioTracks: [] } }))).toMatchObject({ ok: false });
  });

  it('offers progressive files like streams, with a name that names no quality (0.3.0)', () => {
    const { manifest: _manifest, ...base } = stream();
    const file: DetectedStream = {
      ...base,
      protocol: 'progressive',
      url: 'https://cdn.example.com/clip.mp4',
      progressive: { container: 'mp4', bytes: 1_000_000 },
      media: { variants: [{ id: 'file', audioOnly: false, audioTrackIds: [] }], audioTracks: [] },
    };
    expect(downloadAvailability(file)).toEqual({ ok: true });
    expect(downloadAvailability({ ...file, status: 'error', statusMessage: 'Access denied (HTTP 403).' })).toEqual({
      ok: false,
      reason: 'Access denied (HTTP 403).',
    });
    const choice = defaultChoice(file, 'highest');
    expect(choice).toEqual({ variantId: 'file', audioTrackIds: [], subtitleTrackIds: [], fileName: 'Movie_Title', fileNameEdited: false });
    expect(toRequest(file, choice ?? { variantId: '', audioTrackIds: [], subtitleTrackIds: [], fileName: '', fileNameEdited: false })).toEqual({
      tabId: 4,
      streamId: 's1',
      variantId: 'file',
      audioTrackIds: [],
      fileName: 'Movie_Title',
    });
  });
});

describe('choices', () => {
  it('defaults to the preferred resolution, its default audio track and a generated name', () => {
    expect(defaultChoice(stream(), '720')).toEqual({
      variantId: 'video-1',
      audioTrackIds: ['audio-0'],
      subtitleTrackIds: [],
      fileName: 'Movie_Title_720p',
      fileNameEdited: false,
    });
    expect(defaultChoice(stream({ media: { variants: [], audioTracks: [] } }), 'highest')).toBeUndefined();
  });

  it('resets audio and name when the quality changes, unless the name was edited', () => {
    const initial = defaultChoice(stream(), 'highest');
    if (!initial) throw new Error('no choice');
    const french = withAudioTrack(withAudioTrack(initial, 'audio-0', false), 'audio-1', true);
    expect(french.audioTrackIds).toEqual(['audio-1']);

    const sd = withVariant(stream(), french, 'video-2');
    expect(sd).toEqual({ variantId: 'video-2', audioTrackIds: [], subtitleTrackIds: [], fileName: 'Movie_Title_360p', fileNameEdited: false });

    const named = withFileName(initial, 'My copy');
    expect(withVariant(stream(), named, 'video-1')).toMatchObject({ fileName: 'My copy', fileNameEdited: true, variantId: 'video-1' });
    expect(withVariant(stream(), named, 'unknown')).toBe(named);
  });

  it('turns a choice into a download request', () => {
    const choice = defaultChoice(stream(), 'highest');
    if (!choice) throw new Error('no choice');
    expect(toRequest(stream(), choice)).toEqual({
      tabId: 4,
      streamId: 's1',
      variantId: 'video-0',
      audioTrackIds: ['audio-0'],
      fileName: 'Movie_Title_1080p',
    });
  });
});

describe('subtitles (0.7.0)', () => {
  const subtitled = (): DetectedStream => {
    const base = stream();
    const media = base.media ?? { variants: [], audioTracks: [] };
    return {
      ...base,
      media: {
        ...media,
        variants: media.variants.map((variant) =>
          variant.id === 'video-2' ? { ...variant, subtitleTrackIds: ['sub-de'] } : { ...variant, subtitleTrackIds: ['sub-en', 'sub-en-forced', 'sub-vi', 'sub-pt'] },
        ),
        subtitleTracks: [
          { id: 'sub-en-forced', name: 'English (forced)', language: 'en', isDefault: false, forced: true },
          { id: 'sub-en', name: 'English', language: 'en-US', isDefault: false },
          { id: 'sub-vi', name: 'Tiếng Việt', language: 'vie', isDefault: false },
          { id: 'sub-pt', name: 'Português', language: 'pt-PT', isDefault: false },
          { id: 'sub-de', name: 'Deutsch', language: 'ger', isDefault: true },
        ],
      },
    };
  };
  const tracks = () => subtitled().media?.subtitleTracks ?? [];

  it('preselects one track per Settings language, in that order, never a forced one', () => {
    expect(defaultSubtitleTracks(tracks(), [])).toEqual([]);
    expect(defaultSubtitleTracks(tracks(), ['vi', 'en'])).toEqual(['sub-vi', 'sub-en']);
    // ISO 639-2/B "ger" is German; a region asks for that region or none, not another one.
    expect(defaultSubtitleTracks(tracks(), ['de', 'pt-BR', 'fr'])).toEqual(['sub-de']);
    expect(defaultSubtitleTracks(tracks(), ['pt'])).toEqual(['sub-pt']);
    expect(defaultSubtitleTracks(tracks(), ['en-us'])).toEqual(['sub-en']);
    // The default track of a language wins over the first one.
    const twoEnglish = [...tracks(), { id: 'sub-en-sdh', name: 'English SDH', language: 'en', isDefault: true }];
    expect(defaultSubtitleTracks(twoEnglish, ['en'])).toEqual(['sub-en-sdh']);
    // Codes outside the ISO 639 table, a script against a script + region, underscores, no language.
    const more = [
      { id: 'mt', name: 'Malti', language: 'mt', isDefault: false },
      { id: 'zh', name: '繁體中文', language: 'zh_Hant_TW', isDefault: false },
      { id: 'mi', name: 'Māori', language: 'mao', isDefault: false },
      { id: 'und', name: 'Unknown', language: 'und', isDefault: false },
    ];
    expect(defaultSubtitleTracks(more, ['MT', 'zh-Hant', 'mi', 'und'])).toEqual(['mt', 'zh', 'mi']);
    expect(defaultSubtitleTracks(more, ['zh-Hans'])).toEqual([]);
  });

  it('chooses only what the quality offers, keeps a pick when the quality offers the same tracks', () => {
    const choice = defaultChoice(subtitled(), 'highest', ['en', 'de']);
    expect(choice?.subtitleTrackIds).toEqual(['sub-en']);
    if (!choice) throw new Error('no choice');
    const picked = withSubtitleTrack(withSubtitleTrack(choice, 'sub-en', false), 'sub-vi', true);
    expect(picked.subtitleTrackIds).toEqual(['sub-vi']);
    expect(withVariant(subtitled(), picked, 'video-1', ['en', 'de']).subtitleTrackIds).toEqual(['sub-vi']);
    // Other tracks: that quality's defaults.
    expect(withVariant(subtitled(), picked, 'video-2', ['en', 'de']).subtitleTrackIds).toEqual(['sub-de']);
  });

  it('sends the chosen tracks the quality still offers', () => {
    const choice = defaultChoice(subtitled(), 'highest', ['vi', 'en']);
    if (!choice) throw new Error('no choice');
    expect(toRequest(subtitled(), choice)).toMatchObject({ variantId: 'video-0', subtitleTrackIds: ['sub-vi', 'sub-en'] });
    expect(toRequest(subtitled(), { ...choice, subtitleTrackIds: ['sub-gone', 'sub-de'] })).not.toHaveProperty('subtitleTrackIds');
  });
});

describe('selectAllState', () => {
  it('is none, some or all of the selectable streams', () => {
    expect(selectAllState(['a', 'b'], new Set())).toBe('none');
    expect(selectAllState(['a', 'b'], new Set(['a']))).toBe('some');
    expect(selectAllState(['a', 'b'], new Set(['a', 'b', 'gone']))).toBe('all');
  });
});
