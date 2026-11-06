import { describe, expect, it } from 'vitest';
import type { DetectedStream } from '@/core/models/detected-stream';
import {
  defaultChoice,
  downloadAvailability,
  selectAllState,
  toRequest,
  withAudioTrack,
  withFileName,
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
    expect(choice).toEqual({ variantId: 'file', audioTrackIds: [], fileName: 'Movie_Title', fileNameEdited: false });
    expect(toRequest(file, choice ?? { variantId: '', audioTrackIds: [], fileName: '', fileNameEdited: false })).toEqual({
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
    expect(sd).toEqual({ variantId: 'video-2', audioTrackIds: [], fileName: 'Movie_Title_360p', fileNameEdited: false });

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

describe('selectAllState', () => {
  it('is none, some or all of the selectable streams', () => {
    expect(selectAllState(['a', 'b'], new Set())).toBe('none');
    expect(selectAllState(['a', 'b'], new Set(['a']))).toBe('some');
    expect(selectAllState(['a', 'b'], new Set(['a', 'b', 'gone']))).toBe('all');
  });
});
