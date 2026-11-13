import { describe, expect, it } from 'vitest';
import { convertTrackFile } from '@/core/download/subtitle-saves';
import { cueOffsetSec, parseOffsetSec } from '@/core/subtitles/cue-offset';
import { parseTextTracks } from '@/shared/types/text-tracks';

// A real site (0.7.2): its player put the file's cues 4.56 s later into a hidden metadata track.
const FILE = [
  { start: 10.086, text: '我會的' },
  { start: 27.266, text: '老公' },
  { start: 30.286, text: '幹嘛' },
  { start: 31.886, text: '今天這麼早下班' },
];
const PLAYER = { kind: 'metadata', label: 'Tiếng Trung (gốc)', language: 'zh', cues: FILE.map((cue) => ({ ...cue, start: cue.start + 4.56 })) };

describe('page subtitle file offsets (0.7.2)', () => {
  it('finds how far the player moved the file’s cues, by their text', () => {
    expect(cueOffsetSec(FILE, [PLAYER])).toBe(4.56);
    expect(cueOffsetSec(FILE, [{ kind: 'subtitles', cues: FILE }])).toBe(0);
    // Markup and spacing do not matter; another track without the file's cues is passed over.
    const marked = { kind: 'captions', cues: [{ start: 12.086, text: '<i>我會的</i> ' }, { start: 29.266, text: '老公' }] };
    expect(cueOffsetSec(FILE, [{ kind: 'chapters', cues: [{ start: 0, text: 'Intro' }] }, marked])).toBe(2);
  });

  it('needs two pairs that agree, and ignores lines the file repeats', () => {
    expect(cueOffsetSec(FILE, [{ kind: 'metadata', cues: [{ start: 14.646, text: '我會的' }] }])).toBeUndefined();
    expect(cueOffsetSec(FILE, [{ kind: 'metadata', cues: [{ start: 14.646, text: '我會的' }, { start: 40, text: '老公' }] }])).toBeUndefined();
    const repeated = [...FILE, { start: 50, text: '老公' }];
    expect(cueOffsetSec(repeated, [{ kind: 'metadata', cues: [{ start: 14.646, text: '我會的' }, { start: 99, text: '老公' }] }])).toBeUndefined();
    expect(cueOffsetSec([{ start: 1, text: 'Only' }], [{ kind: 'subtitles', cues: [{ start: 3, text: 'only' }] }])).toBe(2);
    expect(cueOffsetSec(FILE, [])).toBeUndefined();
  });

  it('validates what a content script reports and offsets read back from storage', () => {
    expect(
      parseTextTracks({
        tracks: [PLAYER, { kind: 'x', cues: [{ start: -1, text: 'a' }, { start: 'b', text: 'c' }] }, 'junk', { kind: 'y', cues: [{ start: 1, text: ' ' }] }],
      }),
    ).toEqual([PLAYER]);
    expect(parseTextTracks(null)).toEqual([]);
    expect([4.56, -2, 0, 7200, Number.NaN, '4'].map(parseOffsetSec)).toEqual([4.56, -2, undefined, undefined, undefined, undefined]);
  });

  it('moves a progressive file’s page subtitles by the offset when saving them', () => {
    const vtt = 'WEBVTT\n\n00:10.086 --> 00:12.086\n我會的\n\n00:27.266 --> 00:28.946\n老公\n';
    expect(convertTrackFile(vtt, 'srt', 4.56)).toBe('1\r\n00:00:14,646 --> 00:00:16,646\r\n我會的\r\n\r\n2\r\n00:00:31,826 --> 00:00:33,506\r\n老公\r\n');
  });
});
