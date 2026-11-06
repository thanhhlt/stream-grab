import { describe, expect, it } from 'vitest';
import { chooseVariant, defaultAudioTracks } from '@/core/download/variant-choice';
import type { AudioTrackSummary, VariantSummary } from '@/core/models/detected-stream';

const v = (id: string, height: number | undefined, extra: Partial<VariantSummary> = {}): VariantSummary => ({
  id,
  audioOnly: false,
  audioTrackIds: [],
  ...(height === undefined ? {} : { height }),
  ...extra,
});

// Best first, as the media summary stores them.
const LADDER = [v('2160', 2160), v('1080', 1080), v('720', 720), v('480', 480), v('audio', undefined, { audioOnly: true })];

describe('chooseVariant', () => {
  it('picks the highest or lowest video quality', () => {
    expect(chooseVariant(LADDER, 'highest')?.id).toBe('2160');
    expect(chooseVariant(LADDER, 'lowest')?.id).toBe('480');
  });

  it('picks the preferred resolution, or the nearest lower one', () => {
    expect(chooseVariant(LADDER, '1080')?.id).toBe('1080');
    expect(chooseVariant(LADDER, '1440')?.id).toBe('1080');
    expect(chooseVariant(LADDER, '360')?.id).toBe('480'); // nothing lower: the smallest
  });

  it('falls back to the best variant when no resolution is declared', () => {
    expect(chooseVariant([v('a', undefined, { bandwidth: 3 }), v('b', undefined, { bandwidth: 1 })], '720')?.id).toBe('a');
  });

  it('uses audio-only variants only when nothing else exists', () => {
    expect(chooseVariant([v('audio', undefined, { audioOnly: true })], 'highest')?.id).toBe('audio');
    expect(chooseVariant([], 'highest')).toBeUndefined();
  });
});

describe('defaultAudioTracks', () => {
  const tracks: AudioTrackSummary[] = [
    { id: 'a0', name: 'English', isDefault: false },
    { id: 'a1', name: 'Français', isDefault: true },
    { id: 'a2', name: 'Other group', isDefault: true },
  ];

  it("preselects the variant's default track, or its first one", () => {
    expect(defaultAudioTracks('hls', v('x', 720, { audioTrackIds: ['a0', 'a1'] }), tracks)).toEqual(['a1']);
    expect(defaultAudioTracks('hls', v('x', 720, { audioTrackIds: ['a0'] }), tracks)).toEqual(['a0']);
    expect(defaultAudioTracks('hls', v('x', 720), tracks)).toEqual([]);
  });

  it('adds nothing to a DASH representation that already carries audio, or to audio-only variants', () => {
    expect(defaultAudioTracks('dash', v('x', 720, { audioCodec: 'mp4a.40.2', audioTrackIds: ['a1'] }), tracks)).toEqual([]);
    expect(defaultAudioTracks('hls', v('x', undefined, { audioOnly: true, audioTrackIds: ['a1'] }), tracks)).toEqual([]);
    // HLS lists the audio group's codec in CODECS; the separate rendition is still needed.
    expect(defaultAudioTracks('hls', v('x', 720, { audioCodec: 'mp4a.40.2', audioTrackIds: ['a1'] }), tracks)).toEqual(['a1']);
  });
});
