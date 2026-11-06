import { SegmentFatalError } from './retry-policy';

/**
 * HLS AES-128 (full-segment AES-CBC with PKCS#7 padding, RFC 8216 §5.2) via
 * WebCrypto. Keys are fetched with the same request context as the segments
 * (the page's session authorises them) and cached per key URL. Only content
 * the page itself can play is decrypted; DRM never reaches this code.
 */

export type FetchKeyBytes = (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/^0x/i, '');
  if (!/^(?:[0-9a-f]{2})*$/i.test(clean)) throw new SegmentFatalError('Malformed hexadecimal value');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Bytes of a `data:` URI (base64 or percent-encoded); null when it is not one. */
export function dataUriBytes(uri: string): Uint8Array<ArrayBuffer> | null {
  const match = /^data:([^,]*),(.*)$/is.exec(uri.trim());
  if (!match) return null;
  const meta = match[1] ?? '';
  const payload = match[2] ?? '';
  if (/;base64$/i.test(meta)) {
    const binary = atob(payload);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  return new TextEncoder().encode(decodeURIComponent(payload));
}

export class Aes128KeyCache {
  readonly #fetchBytes: FetchKeyBytes;
  readonly #keys = new Map<string, Promise<CryptoKey>>();

  constructor(fetchBytes: FetchKeyBytes) {
    this.#fetchBytes = fetchBytes;
  }

  get(keyUrl: string, signal?: AbortSignal): Promise<CryptoKey> {
    let key = this.#keys.get(keyUrl);
    if (!key) {
      key = this.#load(keyUrl, signal);
      this.#keys.set(keyUrl, key);
      key.catch(() => this.#keys.delete(keyUrl));
    }
    return key;
  }

  async #load(keyUrl: string, signal?: AbortSignal): Promise<CryptoKey> {
    const bytes = dataUriBytes(keyUrl) ?? new Uint8Array(await this.#fetchBytes(keyUrl, signal));
    if (bytes.byteLength !== 16) {
      throw new SegmentFatalError(`The AES-128 key is ${bytes.byteLength} bytes long instead of 16`);
    }
    return crypto.subtle.importKey('raw', bytes, { name: 'AES-CBC' }, false, ['decrypt']);
  }
}

export async function decryptAes128(data: ArrayBuffer, key: CryptoKey, ivHex: string): Promise<ArrayBuffer> {
  const iv = hexToBytes(ivHex);
  if (iv.byteLength !== 16) throw new SegmentFatalError('The AES-128 IV must be 16 bytes long');
  try {
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
  } catch (error) {
    throw new SegmentFatalError('Could not decrypt a segment (wrong key or corrupted data)', { cause: error });
  }
}
