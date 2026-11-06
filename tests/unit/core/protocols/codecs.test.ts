import { describe, expect, it } from 'vitest';
import { codecDisplayName, codecKind, splitCodecs } from '@/core/protocols/codecs';

describe('codecs', () => {
  it('splits CODECS attributes', () => {
    expect(splitCodecs('avc1.640028, mp4a.40.2')).toEqual(['avc1.640028', 'mp4a.40.2']);
    expect(splitCodecs(undefined)).toEqual([]);
    expect(splitCodecs(',,')).toEqual([]);
  });

  it('classifies codecs', () => {
    expect(['avc1.640028', 'hvc1.2.4.L153.B0', 'av01.0.08M.08', 'vp09.00.10.08'].map(codecKind)).toEqual([
      'video',
      'video',
      'video',
      'video',
    ]);
    expect(['mp4a.40.2', 'ec-3', 'opus', 'fLaC'].map(codecKind)).toEqual(['audio', 'audio', 'audio', 'audio']);
    expect(codecKind('wvtt')).toBe('text');
    expect(codecKind('xyz1')).toBe('unknown');
  });

  it('names codecs for display', () => {
    expect(codecDisplayName('avc1.640028')).toBe('H.264');
    expect(codecDisplayName('hev1.1.6.L93.B0')).toBe('HEVC');
    expect(codecDisplayName('av01.0.08M.08')).toBe('AV1');
    expect(codecDisplayName('mp4a.40.2')).toBe('AAC');
    expect(codecDisplayName('mp4a.40.5')).toBe('HE-AAC');
    expect(codecDisplayName('mp4a.40.29')).toBe('HE-AACv2');
    expect(codecDisplayName('mp4a.40.34')).toBe('MP3');
    expect(codecDisplayName('ec-3')).toBe('E-AC-3');
    expect(codecDisplayName('dtsc')).toBe('DTS');
    expect(codecDisplayName('xyz1.2')).toBe('xyz1');
  });
});
