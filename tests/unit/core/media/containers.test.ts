import { describe, expect, it } from 'vitest';
import { chooseContainer, codecLabel, containerExtension, containerMimeType } from '@/core/media/containers';
import type { MediaStreamInfo } from '@/core/models/media-info';

const video = (codec: string): MediaStreamInfo => ({ kind: 'video', codec });
const audio = (codec: string): MediaStreamInfo => ({ kind: 'audio', codec });

describe('chooseContainer', () => {
  it('writes MP4 for codecs MP4 holds by stream copy', () => {
    for (const streams of [
      [video('h264'), audio('aac')],
      [video('hevc'), audio('eac3'), audio('ac3')],
      [video('av1'), audio('opus')],
      [video('vp9'), audio('mp3')],
      [audio('aac')],
    ]) {
      expect(chooseContainer('auto', streams)).toEqual({ container: 'mp4' });
      expect(chooseContainer('mp4', streams)).toEqual({ container: 'mp4' });
    }
  });

  it('falls back to MKV in auto mode and says why', () => {
    expect(chooseContainer('auto', [video('vp8'), audio('vorbis')])).toEqual({
      container: 'mkv',
      reason: 'VP8 and Vorbis cannot be stored in MP4 without re-encoding.',
    });
    expect(chooseContainer('auto', [video('h264'), audio('flac'), audio('flac')])).toEqual({
      container: 'mkv',
      reason: 'FLAC cannot be stored in MP4 without re-encoding.',
    });
  });

  it('refuses a forced MP4 that would need re-encoding', () => {
    const choice = chooseContainer('mp4', [video('theora'), audio('aac')]);
    expect(choice).toEqual({ error: expect.stringContaining('Theora cannot be stored in MP4 without re-encoding') as string });
  });

  it('always honours MKV, and ignores data and subtitle streams', () => {
    expect(chooseContainer('mkv', [video('h264'), audio('aac')])).toEqual({ container: 'mkv' });
    expect(chooseContainer('auto', [video('h264'), { kind: 'data', codec: 'timed_id3' }, { kind: 'subtitle', codec: 'webvtt' }])).toEqual({
      container: 'mp4',
    });
  });
});

describe('codecLabel / containerExtension', () => {
  it('names codecs the way players do', () => {
    expect(codecLabel('h264')).toBe('H.264');
    expect(codecLabel('eac3')).toBe('E-AC-3');
    expect(codecLabel('prores')).toBe('PRORES');
    expect(containerExtension('mkv')).toBe('.mkv');
    expect(containerMimeType('mp4')).toBe('video/mp4');
    expect(containerMimeType('mkv')).toBe('video/x-matroska');
  });
});
