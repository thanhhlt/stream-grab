import { describe, expect, it, vi } from 'vitest';
import { Aes128KeyCache, dataUriBytes, decryptAes128, hexToBytes } from '@/core/download/aes';
import { SegmentFatalError } from '@/core/download/retry-policy';

const KEY = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
const IV = '000102030405060708090a0b0c0d0e0f';

async function encrypt(plain: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', KEY, { name: 'AES-CBC' }, false, ['encrypt']);
  return crypto.subtle.encrypt({ name: 'AES-CBC', iv: hexToBytes(IV) }, key, plain);
}

describe('AES-128', () => {
  it('decrypts AES-CBC segments with a fetched key', async () => {
    const plain = new TextEncoder().encode('segment payload that is longer than one block');
    const fetchKey = vi.fn(() => Promise.resolve(KEY.buffer));
    const keys = new Aes128KeyCache(fetchKey);
    const key = await keys.get('https://keys.example.com/k1');
    const clear = await decryptAes128(await encrypt(plain), key, IV);
    expect(new TextDecoder().decode(clear)).toBe('segment payload that is longer than one block');
    await keys.get('https://keys.example.com/k1');
    expect(fetchKey).toHaveBeenCalledTimes(1);
  });

  it('accepts inline data: keys without fetching', async () => {
    const fetchKey = vi.fn<(url: string) => Promise<ArrayBuffer>>();
    const base64 = btoa(String.fromCharCode(...KEY));
    await expect(new Aes128KeyCache(fetchKey).get(`data:application/octet-stream;base64,${base64}`)).resolves.toBeDefined();
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it('rejects keys that are not 16 bytes, and wrong keys', async () => {
    const short = new Aes128KeyCache(() => Promise.resolve(new Uint8Array(8).buffer));
    await expect(short.get('https://keys.example.com/short')).rejects.toBeInstanceOf(SegmentFatalError);
    const wrong = await new Aes128KeyCache(() => Promise.resolve(new Uint8Array(16).buffer)).get('https://keys.example.com/zero');
    await expect(decryptAes128(await encrypt(new Uint8Array([1, 2, 3])), wrong, IV)).rejects.toBeInstanceOf(SegmentFatalError);
  });

  it('retries a key whose download failed', async () => {
    const fetchKey = vi.fn<(url: string) => Promise<ArrayBuffer>>().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce(KEY.buffer);
    const keys = new Aes128KeyCache(fetchKey);
    await expect(keys.get('https://keys.example.com/k')).rejects.toThrow('503');
    await expect(keys.get('https://keys.example.com/k')).resolves.toBeDefined();
  });

  it('parses hex and data URIs', () => {
    expect([...hexToBytes('0x0aff')]).toEqual([10, 255]);
    expect(() => hexToBytes('xyz')).toThrow(SegmentFatalError);
    expect([...(dataUriBytes('data:,AB') ?? [])]).toEqual([65, 66]);
    expect(dataUriBytes('https://x')).toBeNull();
  });
});
