function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Fast, non-cryptographic 64-bit hash (two seeded FNV-1a passes) as 16 hex characters. Used for stable IDs. */
export function stableHash(input: string): string {
  const high = fnv1a32(input, 0x811c9dc5);
  const low = fnv1a32(input, 0x01000193 ^ high);
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}
