import { describe, expect, it } from 'vitest';
import {
  defaultBaseName,
  extensionFor,
  inDownloadFolder,
  MAX_BASE_NAME_LENGTH,
  MAX_FOLDER_LENGTH,
  parseDownloadFolder,
  sanitizeBaseName,
  uniqueBaseName,
} from '@/core/download/file-name';

describe('parseDownloadFolder (0.4.0)', () => {
  const folder = (input: string) => {
    const result = parseDownloadFolder(input);
    return result.ok ? result.folder : `refused: ${result.reason}`;
  };

  it('turns what the user typed into a path chrome.downloads accepts', () => {
    expect(folder('')).toBe('');
    expect(folder('   ')).toBe('');
    expect(folder('StreamGrab')).toBe('StreamGrab');
    expect(folder(' Videos\\StreamGrab\\ ')).toBe('Videos/StreamGrab');
    expect(folder('/Videos//./Phim Việt/')).toBe('Videos/Phim Việt');
    // Reserved characters, trailing dots/spaces and device names, as in file names (Chrome throws "Invalid filename" for them).
    expect(folder('Movies: 2026 / CON / old. ')).toBe('Movies 2026/CON_/old');
    expect(folder('.../***')).toBe('');
  });

  it('refuses paths that leave Downloads or are too long for Windows', () => {
    expect(folder('../Desktop')).toMatch(/^refused: ".." is not allowed/);
    expect(folder('Videos/ .. /x')).toMatch(/^refused: ".." is not allowed/);
    expect(folder('C:\\Users\\me\\Videos')).toMatch(/^refused: Enter a folder inside Downloads/);
    expect(folder('d:videos')).toMatch(/^refused: Enter a folder inside Downloads/);
    expect(folder('\\\\server\\share')).toMatch(/^refused: Enter a folder inside Downloads/);
    expect(folder('a'.repeat(50) + '/' + 'b'.repeat(50))).toMatch(/^refused: Use at most 80 characters/);
    expect(folder('a'.repeat(39) + '/' + 'b'.repeat(40))).toHaveLength(MAX_FOLDER_LENGTH);
  });

  it('puts a file name in the folder', () => {
    expect(inDownloadFolder('', 'Movie.mp4')).toBe('Movie.mp4');
    expect(inDownloadFolder('Videos/StreamGrab', 'Movie.mp4')).toBe('Videos/StreamGrab/Movie.mp4');
  });
});

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
