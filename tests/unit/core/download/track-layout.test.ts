import { describe, expect, it } from 'vitest';
import { buildLayout, parseLayout, sameLayout } from '@/core/download/track-layout';
import type { MediaSegment } from '@/core/models/media-segment';
import type { AudioTrack } from '@/core/models/streaming-manifest';

function segment(trackId: string, index: number, overrides: Partial<MediaSegment> = {}): MediaSegment {
  return {
    id: `${trackId}:${index}`,
    trackId,
    trackType: trackId === 'main' ? 'main' : 'audio',
    index,
    kind: 'media',
    url: `https://cdn.example.com/${trackId}/${index}?token=secret`,
    duration: 4,
    discontinuity: 0,
    container: 'mpeg-ts',
    ...overrides,
  };
}

const english: AudioTrack = { id: 'audio-0', name: 'English', language: 'en', isDefault: true };

describe('buildLayout', () => {
  it('describes MPEG-TS tracks with their discontinuities, without URLs', () => {
    const layout = buildLayout(
      [
        segment('main', 0),
        segment('main', 1),
        segment('main', 2, { discontinuity: 1 }),
        segment('main', 3, { discontinuity: 1, duration: 2.5 }),
        segment('audio-0', 0),
        segment('audio-0', 1),
      ],
      [english],
    );
    expect(layout).toEqual([
      { trackId: 'main', trackType: 'main', segments: 4, initIndexes: [], discontinuityIndexes: [2], container: 'mpeg-ts', durationSec: 14.5 },
      {
        trackId: 'audio-0',
        trackType: 'audio',
        segments: 2,
        initIndexes: [],
        discontinuityIndexes: [],
        container: 'mpeg-ts',
        durationSec: 8,
        name: 'English',
        language: 'en',
      },
    ]);
    expect(JSON.stringify(layout)).not.toContain('token');
  });

  it('records every initialization segment of fragmented MP4 tracks', () => {
    const layout = buildLayout([
      segment('main', 0, { kind: 'init', container: 'fmp4', duration: 0 }),
      segment('main', 1, { container: 'fmp4' }),
      segment('main', 2, { container: 'fmp4' }),
      segment('main', 3, { kind: 'init', container: 'fmp4', duration: 0, discontinuity: 1 }),
      segment('main', 4, { container: 'fmp4', discontinuity: 1 }),
    ]);
    expect(layout).toEqual([
      { trackId: 'main', trackType: 'main', segments: 5, initIndexes: [0, 3], discontinuityIndexes: [3], container: 'fmp4', durationSec: 12 },
    ]);
  });
});

describe('parseLayout', () => {
  const valid = buildLayout([segment('main', 0), segment('main', 1, { discontinuity: 1 })], [english]);

  it('accepts what buildLayout produces', () => {
    expect(parseLayout(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
    expect(sameLayout(valid, parseLayout(valid) ?? [])).toBe(true);
    expect(sameLayout(undefined, valid)).toBe(false);
  });

  it('rejects missing or damaged layouts', () => {
    expect(parseLayout(undefined)).toBeNull();
    expect(parseLayout([])).toBeNull();
    expect(parseLayout([{ ...valid[0], segments: 0 }])).toBeNull();
    expect(parseLayout([{ ...valid[0], trackType: 'video' }])).toBeNull();
    expect(parseLayout([{ ...valid[0], discontinuityIndexes: [5] }])).toBeNull(); // beyond the track
    expect(parseLayout([{ ...valid[0], container: 'avi' }])).toBeNull();
  });
});
