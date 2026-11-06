import { describe, expect, it } from 'vitest';
import {
  ivFromMediaSequence,
  ivFromWords,
  mergeKeyScans,
  parseAttributeList,
  resolveKeyUrl,
  scanHlsKeys,
} from '@/core/protocols/hls/hls-keys';
import hlsMasterFairplay from '@tests/fixtures/manifests/hls/master-fairplay.m3u8?raw';
import hlsAes128 from '@tests/fixtures/manifests/hls/media-aes128.m3u8?raw';
import hlsSampleAes from '@tests/fixtures/manifests/hls/media-sample-aes.m3u8?raw';
import hlsWidevine from '@tests/fixtures/manifests/hls/media-widevine.m3u8?raw';

describe('parseAttributeList', () => {
  it('handles quoted values containing commas and lower-case keys', () => {
    const attributes = parseAttributeList('TYPE=AUDIO,NAME="Français, stéréo",uri="a.m3u8",DEFAULT=YES');
    expect(attributes.get('NAME')).toBe('Français, stéréo');
    expect(attributes.get('URI')).toBe('a.m3u8');
    expect(attributes.get('DEFAULT')).toBe('YES');
  });
});

describe('scanHlsKeys', () => {
  it('detects DRM key formats, including EXT-X-SESSION-KEY that the parser drops', () => {
    expect(scanHlsKeys(hlsMasterFairplay).drmSystems).toEqual(['fairplay']);
    expect(scanHlsKeys(hlsWidevine).drmSystems).toEqual(['widevine']);
    expect(scanHlsKeys('#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.example.drm",URI="x"').drmSystems).toEqual(['unknown']);
  });

  it('treats identity keys as encryption the extension can handle, not DRM', () => {
    expect(scanHlsKeys(hlsAes128)).toEqual({ drmSystems: [], encryption: 'aes-128' });
    expect(scanHlsKeys(hlsSampleAes)).toEqual({ drmSystems: [], encryption: 'sample-aes' });
    expect(scanHlsKeys('#EXTM3U\n#EXT-X-KEY:METHOD=NONE')).toEqual({ drmSystems: [], encryption: 'none' });
  });

  it('merges scans of a master and its variant', () => {
    expect(mergeKeyScans({ drmSystems: [], encryption: 'none' }, { drmSystems: ['widevine'], encryption: 'aes-128' })).toEqual({
      drmSystems: ['widevine'],
      encryption: 'aes-128',
    });
  });
});

describe('IVs', () => {
  it('derives the default IV from the media sequence number (RFC 8216 §5.2)', () => {
    expect(ivFromMediaSequence(0)).toBe('00000000000000000000000000000000');
    expect(ivFromMediaSequence(100)).toBe('00000000000000000000000000000064');
    expect(ivFromMediaSequence(Number.MAX_SAFE_INTEGER)).toBe('0000000000000000001fffffffffffff');
    expect(() => ivFromMediaSequence(-1)).toThrow(RangeError);
  });

  it('formats explicit IVs from 32-bit words', () => {
    expect(ivFromWords(new Uint32Array([0x01234567, 0x89abcdef, 0, 0xabcd]))).toBe('0123456789abcdef000000000000abcd');
    expect(ivFromWords(new Uint32Array([1, 2]))).toBeNull();
    expect(ivFromWords(undefined)).toBeNull();
  });
});

describe('resolveKeyUrl', () => {
  it('resolves http(s) and keeps inline data: keys, rejects other schemes', () => {
    const playlist = 'https://cdn.example.com/hls/v/index.m3u8';
    expect(resolveKeyUrl('../keys/k.bin', playlist)).toBe('https://cdn.example.com/hls/keys/k.bin');
    expect(resolveKeyUrl('data:application/octet-stream;base64,AAAA', playlist)).toBe('data:application/octet-stream;base64,AAAA');
    expect(resolveKeyUrl('skd://drm.example/asset', playlist)).toBeNull();
  });
});
