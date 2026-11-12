import { describe, expect, it } from 'vitest';
import {
  formatSrt,
  formatWebVtt,
  hlsCueOffsetSec,
  joinCues,
  parseVttTimestamp,
  parseWebVtt,
  srtCueText,
  type VttCue,
} from '@/core/subtitles/webvtt';

describe('parseVttTimestamp', () => {
  it('reads hours, minutes-only and comma forms', () => {
    expect(parseVttTimestamp('01:02:03.456')).toBeCloseTo(3723.456);
    expect(parseVttTimestamp('02:03.456')).toBeCloseTo(123.456);
    expect(parseVttTimestamp('00:00:01,500')).toBeCloseTo(1.5);
    expect(parseVttTimestamp('123:00:00.000')).toBe(442_800);
  });

  it('rejects malformed values', () => {
    for (const value of ['1:2.3', '00:60:00.000', '00:00:61.000', '00:00:01.5', 'abc', '']) {
      expect(parseVttTimestamp(value)).toBeNull();
    }
  });
});

describe('parseWebVtt', () => {
  it('returns null without the WEBVTT signature', () => {
    expect(parseWebVtt('')).toBeNull();
    expect(parseWebVtt('1\n00:00:01,000 --> 00:00:02,000\nHi\n')).toBeNull();
    expect(parseWebVtt('WEBVTTX\n')).toBeNull();
  });

  it('parses cues with ids, settings, BOM, CRLF and skips NOTE/STYLE/REGION', () => {
    const text = [
      '﻿WEBVTT - title',
      'X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000',
      '',
      'STYLE',
      '::cue { color: red }',
      '',
      'REGION',
      'id:r1',
      '',
      'NOTE a comment',
      'spanning lines',
      '',
      'cue-1',
      '00:01.000 --> 00:02.500 line:0 align:start',
      '<v Bob>Hello</v>',
      'world',
      '',
      '',
      '00:00:03.000 --> 00:00:04.000',
      '&amp; more',
      '',
    ].join('\r\n');
    const parsed = parseWebVtt(text);
    expect(parsed?.timestampMap).toEqual({ localSec: 0, mpegts: 900_000 });
    expect(parsed?.cues).toEqual([
      { start: 1, end: 2.5, text: '<v Bob>Hello</v>\nworld', settings: 'line:0 align:start' },
      { start: 3, end: 4, text: '&amp; more' },
    ]);
  });

  it('skips cues with bad timings or no text and splits blocks missing a blank line', () => {
    const text = [
      'WEBVTT',
      '',
      '00:00:05.000 --> 00:00:04.000',
      'backwards',
      '',
      '00:00:01.000 --> 00:00:02.000',
      '',
      'garbage block',
      'no timing',
      '',
      '00:00:06.000 --> 00:00:07.000',
      'first',
      '00:00:08.000 --> 00:00:09.000',
      'second',
    ].join('\n');
    expect(parseWebVtt(text)?.cues).toEqual([
      { start: 6, end: 7, text: 'first' },
      { start: 8, end: 9, text: 'second' },
    ]);
  });

  it('accepts a header followed directly by cues and a missing timestamp map', () => {
    const parsed = parseWebVtt('WEBVTT\n00:00:01.000 --> 00:00:02.000\nHi');
    expect(parsed).toEqual({ cues: [{ start: 1, end: 2, text: 'Hi' }] });
  });

  it('ignores a malformed timestamp map', () => {
    expect(parseWebVtt('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:abc,LOCAL:00:00:00.000\n')?.timestampMap).toBeUndefined();
  });
});

describe('hlsCueOffsetSec', () => {
  it('maps MPEGTS and LOCAL onto the output timeline', () => {
    // Segment cues start at LOCAL 0 ↔ PTS 10 s; the video run starts at PTS 10 s, at 0 in the output.
    expect(hlsCueOffsetSec({ localSec: 0, mpegts: 900_000 }, { firstPtsSec: 10, runStartSec: 0 })).toBeCloseTo(0);
    expect(hlsCueOffsetSec({ localSec: 5, mpegts: 900_000 }, { firstPtsSec: 10, runStartSec: 0 })).toBeCloseTo(-5);
    // A later run starts at 30 s in the output and at PTS 100 s.
    expect(hlsCueOffsetSec({ localSec: 0, mpegts: 9_000_000 }, { firstPtsSec: 100, runStartSec: 30 })).toBeCloseTo(30);
  });

  it('uses MPEGTS 0 without a map', () => {
    expect(hlsCueOffsetSec(undefined, { firstPtsSec: 1.4, runStartSec: 0 })).toBeCloseTo(-1.4);
  });

  it('unwraps MPEGTS across the 33-bit rollover', () => {
    const wrap = 2 ** 33 / 90_000;
    // The video already wrapped past 2^33; the map still carries the small value.
    expect(hlsCueOffsetSec({ localSec: 0, mpegts: 90_000 }, { firstPtsSec: wrap + 1, runStartSec: 0 })).toBeCloseTo(0);
    // The map carries a value just below the wrap, the video's run starts just after 0.
    expect(hlsCueOffsetSec({ localSec: 0, mpegts: 2 ** 33 - 90_000 }, { firstPtsSec: wrap - 1, runStartSec: 0 })).toBeCloseTo(0);
  });
});

describe('joinCues', () => {
  const cue = (start: number, end: number, text: string): VttCue => ({ start, end, text });

  it('shifts, dedupes repeated cues, joins split cues and sorts', () => {
    const joined = joinCues([
      { cues: [cue(0, 4, 'a'), cue(8, 10, 'spans')], offsetSec: 0 },
      { cues: [cue(8, 10, 'spans'), cue(10, 12, 'spans'), cue(11, 13, 'b')], offsetSec: 0 },
      { cues: [cue(0, 1, 'c')], offsetSec: 20 },
    ]);
    expect(joined).toEqual([cue(0, 4, 'a'), cue(8, 12, 'spans'), cue(11, 13, 'b'), cue(20, 21, 'c')]);
  });

  it('cuts cues to [0, duration]', () => {
    const joined = joinCues(
      [{ cues: [cue(0, 2, 'early'), cue(4, 6, 'a'), cue(9, 12, 'tail'), cue(12, 13, 'after')], offsetSec: -1 }],
      10,
    );
    expect(joined).toEqual([cue(0, 1, 'early'), cue(3, 5, 'a'), cue(8, 10, 'tail')]);
  });

  it('keeps cues with the same text that do not touch', () => {
    expect(joinCues([{ cues: [cue(0, 1, '♪'), cue(2, 3, '♪')], offsetSec: 0 }])).toHaveLength(2);
  });
});

describe('formatting', () => {
  const cues: VttCue[] = [
    { start: 1, end: 2.5, text: '<v Bob>Hello</v> <c.yellow>there</c>\n<i.loud>world</i> &amp; <00:00:02.000>co', settings: 'line:0' },
    { start: 3661.001, end: 3662, text: 'second' },
  ];

  it('writes WebVTT without ids, styles or blank lines inside cues', () => {
    expect(formatWebVtt([...cues, { start: 4000, end: 4001, text: 'a\n\nb' }])).toBe(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.500 line:0',
        '<v Bob>Hello</v> <c.yellow>there</c>',
        '<i.loud>world</i> &amp; <00:00:02.000>co',
        '',
        '01:01:01.001 --> 01:01:02.000',
        'second',
        '',
        '01:06:40.000 --> 01:06:41.000',
        'a',
        'b',
        '',
      ].join('\n'),
    );
    expect(parseWebVtt(formatWebVtt(cues))?.cues).toEqual(cues);
  });

  it('writes numbered SubRip with plain styling', () => {
    expect(formatSrt(cues)).toBe(
      [
        '1',
        '00:00:01,000 --> 00:00:02,500',
        'Hello there',
        '<i>world</i> & co',
        '',
        '2',
        '01:01:01,001 --> 01:01:02,000',
        'second',
        '',
      ].join('\r\n'),
    );
    expect(formatSrt([])).toBe('');
  });

  it('converts cue markup and entities for SubRip', () => {
    expect(srtCueText('<b>bold</b> <u>u</u> <ruby>漢<rt>kan</rt></ruby> &lt;x&gt; &#39;q&#x27; &nbsp;')).toBe(
      "<b>bold</b> <u>u</u> 漢kan <x> 'q'  ",
    );
  });
});

describe('hostile and sloppy input (review fixes)', () => {
  it('parses a large file without blank lines between cues in linear time', () => {
    const lines = ['WEBVTT', ''];
    for (let i = 0; i < 40_000; i++) lines.push(`${i}`, `00:00:${String(i % 60).padStart(2, '0')}.000 --> 00:00:${String(i % 60).padStart(2, '0')}.500`, `cue ${i}`);
    const started = performance.now();
    const parsed = parseWebVtt(lines.join('\n'));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(parsed?.cues).toHaveLength(40_000);
  });

  it('keeps the cues after a malformed one in the same block and accepts timings without spaces', () => {
    const text = ['WEBVTT', '', '00:00:05.000 --> 00:00:04.000', 'bad', '00:01.000-->00:02.000', 'good'].join('\n');
    expect(parseWebVtt(text)?.cues).toEqual([{ start: 1, end: 2, text: 'good' }]);
  });

  it('rejects absurd hours instead of producing Infinity', () => {
    expect(parseVttTimestamp(`${'9'.repeat(400)}:00:00.000`)).toBeNull();
    expect(parseVttTimestamp('1234567:00:00.000')).toBe(1234567 * 3600);
  });

  it('never lets entities break a SubRip cue', () => {
    expect(srtCueText('a&#13;&#13;b&#10;c --&gt; d')).toBe('a  b c -> d');
  });
});
