/** RFC 6381 codec strings ("avc1.640028", "mp4a.40.2") → kind and display names. */

export type CodecKind = 'video' | 'audio' | 'text' | 'unknown';

const VIDEO_PREFIXES = ['avc1', 'avc3', 'hvc1', 'hev1', 'dvh1', 'dvhe', 'dva1', 'dvav', 'av01', 'vp09', 'vp08', 'vp8', 'vp9', 'mp4v'];
const AUDIO_PREFIXES = ['mp4a', 'ac-3', 'ec-3', 'ac-4', 'opus', 'flac', 'fla', 'mp3', 'dtsc', 'dtse', 'dtsh', 'dtsl', 'alac', 'vorbis'];
const TEXT_PREFIXES = ['stpp', 'wvtt', 'tx3g', 'c608'];

/** Splits a CODECS attribute into individual codec strings. */
export function splitCodecs(attribute: string | undefined): string[] {
  if (!attribute) return [];
  return attribute
    .split(',')
    .map((codec) => codec.trim())
    .filter((codec) => codec.length > 0 && codec.length <= 64);
}

function prefixOf(codec: string): string {
  return (codec.split('.')[0] ?? '').toLowerCase();
}

export function codecKind(codec: string): CodecKind {
  const prefix = prefixOf(codec);
  if (VIDEO_PREFIXES.includes(prefix)) return 'video';
  if (AUDIO_PREFIXES.includes(prefix)) return 'audio';
  if (TEXT_PREFIXES.includes(prefix)) return 'text';
  return 'unknown';
}

const VIDEO_NAMES: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'HEVC',
  hev1: 'HEVC',
  dvh1: 'Dolby Vision',
  dvhe: 'Dolby Vision',
  dva1: 'Dolby Vision',
  dvav: 'Dolby Vision',
  av01: 'AV1',
  vp09: 'VP9',
  vp9: 'VP9',
  vp08: 'VP8',
  vp8: 'VP8',
  mp4v: 'MPEG-4 Visual',
};

const AUDIO_NAMES: Record<string, string> = {
  'ac-3': 'AC-3',
  'ec-3': 'E-AC-3',
  'ac-4': 'AC-4',
  opus: 'Opus',
  flac: 'FLAC',
  fla: 'FLAC',
  mp3: 'MP3',
  alac: 'ALAC',
  vorbis: 'Vorbis',
};

/** mp4a object types: 40.2 AAC-LC, 40.5 HE-AAC, 40.29 HE-AACv2, 40.34 / 6B / 69 MP3. */
function mp4aName(codec: string): string {
  const [, objectType = '', audioObjectType = ''] = codec.toLowerCase().split('.');
  if (objectType === '6b' || objectType === '69' || audioObjectType === '34') return 'MP3';
  if (audioObjectType === '5') return 'HE-AAC';
  if (audioObjectType === '29') return 'HE-AACv2';
  return 'AAC';
}

/** Human-readable codec name; unknown codecs are returned as their four-character code. */
export function codecDisplayName(codec: string): string {
  const prefix = prefixOf(codec);
  if (prefix === 'mp4a') return mp4aName(codec);
  if (prefix.startsWith('dts')) return 'DTS';
  return VIDEO_NAMES[prefix] ?? AUDIO_NAMES[prefix] ?? (prefix || codec);
}
