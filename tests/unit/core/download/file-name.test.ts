import { describe, expect, it } from 'vitest';
import {
  defaultBaseName,
  extensionFor,
  MAX_BASE_NAME_LENGTH,
  sanitizeBaseName,
  uniqueBaseName,
} from '@/core/download/file-name';

describe('defaultBaseName', () => {
  it('follows the documented style: words joined by underscores plus the quality', () => {
    expect(defaultBaseName('Movie Title', '1080p')).toBe('Movie_Title_1080p');
    expect(defaultBaseName('  Big   Buck: Bunny! (2008) ', '720p60')).toBe('Big_Buck_Bunny_2008_720p60');
  });

  it('keeps letters of any script', () => {
    expect(defaultBaseName('Phim hay nhất – Tập 1', '1080p')).toBe('Phim_hay_nhất_Tập_1_1080p');
    expect(defaultBaseName('進撃の巨人 第1話', '720p')).toBe('進撃の巨人_第1話_720p');
  });

  it('handles missing titles and labels', () => {
    expect(defaultBaseName(undefined, '1080p')).toBe('video_1080p');
    expect(defaultBaseName('!!!')).toBe('video');
    expect(defaultBaseName('Clip', 'Audio only')).toBe('Clip_Audioonly');
    expect(defaultBaseName('Clip 1080p', '1080p')).toBe('Clip_1080p');
  });
});

describe('sanitizeBaseName', () => {
  it('removes characters Windows and Chrome reject', () => {
    expect(sanitizeBaseName('a<b>c:d"e/f\\g|h?i*j')).toBe('a b c d e f g h i j');
    expect(sanitizeBaseName('tab\there\u0007bell')).toBe('tab here bell');
  });

  it('strips leading and trailing dots and spaces', () => {
    expect(sanitizeBaseName('  ..hidden name.. ')).toBe('hidden name');
  });

  it('renames reserved device names', () => {
    expect(sanitizeBaseName('CON')).toBe('CON_');
    expect(sanitizeBaseName('nul.backup')).toBe('nul.backup_');
    expect(sanitizeBaseName('console')).toBe('console');
  });

  it('caps the length without splitting characters', () => {
    const long = '😀'.repeat(200);
    const result = sanitizeBaseName(long);
    expect([...result]).toHaveLength(MAX_BASE_NAME_LENGTH);
    expect(result).toBe('😀'.repeat(MAX_BASE_NAME_LENGTH));
  });

  it('never returns an empty name', () => {
    expect(sanitizeBaseName('')).toBe('video');
    expect(sanitizeBaseName('???')).toBe('video');
  });
});

describe('uniqueBaseName', () => {
  it('appends a counter when the name is taken, ignoring case', () => {
    expect(uniqueBaseName('Movie_1080p', [])).toBe('Movie_1080p');
    expect(uniqueBaseName('Movie_1080p', ['movie_1080p'])).toBe('Movie_1080p_2');
    expect(uniqueBaseName('Movie_1080p', ['Movie_1080p', 'Movie_1080p_2'])).toBe('Movie_1080p_3');
  });

  it('stays within the length limit', () => {
    const long = 'x'.repeat(MAX_BASE_NAME_LENGTH);
    expect(uniqueBaseName(long, [long]).length).toBeLessThanOrEqual(MAX_BASE_NAME_LENGTH);
  });
});

describe('extensionFor', () => {
  it('maps output formats to the extension shown before merging', () => {
    expect(extensionFor('mp4')).toBe('.mp4');
    expect(extensionFor('auto')).toBe('.mp4');
    expect(extensionFor('mkv')).toBe('.mkv');
  });
});
