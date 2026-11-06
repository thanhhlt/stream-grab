import type { DrmSystem, EncryptionKind } from '@/core/models/detected-stream';
import { resolveHttpUrl } from '@/shared/utils/url';

/**
 * HLS encryption: DRM detection, IVs and key URIs.
 *
 * DRM is detected from the raw tag lines rather than from the parser output:
 * m3u8-parser drops EXT-X-SESSION-KEY, which is where a multivariant playlist
 * declares FairPlay, and it handles only some key formats.
 */

const KEYFORMAT_SYSTEMS: Record<string, DrmSystem> = {
  'com.apple.streamingkeydelivery': 'fairplay',
  'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed': 'widevine',
  'com.widevine': 'widevine',
  'com.microsoft.playready': 'playready',
  'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95': 'playready',
  'urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e': 'clearkey',
  'org.w3.clearkey': 'clearkey',
};

/** Parses an HLS attribute list (`KEY=VALUE,KEY="quoted, value"`). Keys are upper-cased. */
export function parseAttributeList(input: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const match of input.matchAll(/([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    const key = match[1]?.toUpperCase();
    const raw = match[2] ?? '';
    if (key) attributes.set(key, raw.startsWith('"') ? raw.slice(1, -1) : raw.trim());
  }
  return attributes;
}

export interface KeyScan {
  drmSystems: DrmSystem[];
  encryption: EncryptionKind;
}

/** Scans EXT-X-KEY and EXT-X-SESSION-KEY tags of a playlist. */
export function scanHlsKeys(text: string): KeyScan {
  const drm = new Set<DrmSystem>();
  let encryption: EncryptionKind = 'none';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('#EXT-X-KEY:') && !line.startsWith('#EXT-X-SESSION-KEY:')) continue;
    const attributes = parseAttributeList(line.slice(line.indexOf(':') + 1));
    const method = (attributes.get('METHOD') ?? 'NONE').toUpperCase();
    if (method === 'NONE') continue;
    const keyFormat = (attributes.get('KEYFORMAT') ?? 'identity').toLowerCase();
    if (keyFormat !== 'identity') {
      drm.add(KEYFORMAT_SYSTEMS[keyFormat] ?? 'unknown');
    } else if (method === 'AES-128') {
      if (encryption === 'none') encryption = 'aes-128';
    } else {
      encryption = 'sample-aes';
    }
  }
  return { drmSystems: [...drm], encryption };
}

export function mergeKeyScans(a: KeyScan, b: KeyScan): KeyScan {
  return {
    drmSystems: [...new Set([...a.drmSystems, ...b.drmSystems])],
    encryption: a.encryption !== 'none' ? a.encryption : b.encryption,
  };
}

/** 128-bit IV as 32 hex characters from m3u8-parser's four 32-bit words; null when malformed. */
export function ivFromWords(words: ArrayLike<number> | undefined): string | null {
  if (words?.length !== 4) return null;
  let hex = '';
  for (let i = 0; i < 4; i++) {
    const word = words[i];
    if (word === undefined || !Number.isInteger(word) || word < 0 || word > 0xffffffff) return null;
    hex += word.toString(16).padStart(8, '0');
  }
  return hex;
}

/**
 * Default IV when EXT-X-KEY has none: the segment's media sequence number as a
 * 128-bit big-endian integer (RFC 8216 §5.2).
 */
export function ivFromMediaSequence(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new RangeError(`Invalid media sequence ${sequence}`);
  return BigInt(sequence).toString(16).padStart(32, '0');
}

/** Key URIs may be http(s) (resolved against the playlist) or inline `data:` URIs. Other schemes (skd:) are DRM. */
export function resolveKeyUrl(uri: string, playlistUrl: string): string | null {
  const trimmed = uri.trim();
  if (/^data:/i.test(trimmed)) return trimmed;
  return resolveHttpUrl(trimmed, playlistUrl);
}
