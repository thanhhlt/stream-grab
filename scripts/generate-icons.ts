/**
 * Generates the extension icons (public/icons/icon-{16,32,48,128}.png) and the
 * Chrome Web Store icon (docs/store/icon-128.png).
 *
 * Artwork (docs/DESIGN.md, "Identity"): a flat tangerine rounded square with the
 * ink claw of the popup header holding a small white play triangle. At 16 px the
 * string is dropped and the prongs are thicker so the claw still reads.
 *
 * Chrome requires PNG icons for the toolbar action, so the artwork is drawn
 * procedurally (supersampled vector shapes) and encoded with a minimal PNG
 * writer. No image tooling is needed; re-run with `npm run icons`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { projectRoot, publicDir } from '../build/paths.ts';

const SIZES = [16, 32, 48, 128] as const;
const SUPERSAMPLE = 6;

type Rgb = readonly [number, number, number];
type Point = readonly [number, number];
const BACKGROUND: Rgb = [255, 122, 26]; // primary #FF7A1A
const INK: Rgb = [27, 32, 48]; // ink #1B2030
const PLAY: Rgb = [255, 255, 255];

function roundedRectContains(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function triangleContains(x: number, y: number, a: Point, b: Point, c: Point): boolean {
  const sign = (p: Point, q: Point): number => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = sign(a, b);
  const d2 = sign(b, c);
  const d3 = sign(c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, steps: number): Point[] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = i / steps;
    const u = 1 - t;
    return [
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ] as const;
  });
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const t = Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** A round-capped stroke along a polyline. */
function strokeContains(x: number, y: number, line: readonly Point[], halfWidth: number): boolean {
  for (let i = 1; i < line.length; i++) {
    if (distanceToSegment(x, y, line[i - 1] as Point, line[i] as Point) <= halfWidth) return true;
  }
  return false;
}

/** Left prong: out from under the cap, down, then a hook back inward. The right prong mirrors it. */
const LEFT_PRONG: readonly Point[] = [...cubic([0.41, 0.34], [0.24, 0.44], [0.19, 0.62], [0.29, 0.78], 32), [0.37, 0.745]];
const RIGHT_PRONG: readonly Point[] = LEFT_PRONG.map(([x, y]) => [1 - x, y] as const);
const PLAY_TRIANGLE: readonly [Point, Point, Point] = [
  [0.44, 0.48],
  [0.44, 0.68],
  [0.615, 0.58],
];
/** At 16 px the triangle is larger and a little higher, clear of the thicker hooks. */
const PLAY_TRIANGLE_SMALL: readonly [Point, Point, Point] = [
  [0.45, 0.43],
  [0.45, 0.69],
  [0.67, 0.56],
];

/** Colour of the artwork at (x, y), normalised to [0, 1]; null outside the rounded square. */
function colorAt(x: number, y: number, size: number): Rgb | null {
  if (!roundedRectContains(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return null;
  const small = size <= 16;
  const string = !small && Math.abs(x - 0.5) <= 0.024 && y <= 0.2;
  const cap = roundedRectContains(x, y, 0.33, 0.18, 0.67, 0.36, 0.07);
  const halfWidth = small ? 0.06 : 0.0425;
  const prongs = strokeContains(x, y, LEFT_PRONG, halfWidth) || strokeContains(x, y, RIGHT_PRONG, halfWidth);
  if (string || cap || prongs) return INK;
  if (triangleContains(x, y, ...(small ? PLAY_TRIANGLE_SMALL : PLAY_TRIANGLE))) return PLAY;
  return BACKGROUND;
}

function renderIcon(size: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let alpha = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const color = colorAt((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size, size);
          if (!color) continue;
          alpha += 1;
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const offset = (py * size + px) * 4;
      if (alpha > 0) {
        pixels[offset] = Math.round(r / alpha);
        pixels[offset + 1] = Math.round(g / alpha);
        pixels[offset + 2] = Math.round(b / alpha);
        pixels[offset + 3] = Math.round((alpha / samples) * 255);
      }
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

const outDir = join(publicDir, 'icons');
mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, renderIcon(size)));
  console.log(`wrote ${file}`);
}

// Chrome Web Store icon: 96x96 artwork centred in a transparent 128x128 square (the store's guideline).
const STORE_SIZE = 128;
const STORE_ART = 96;
const art = renderIcon(STORE_ART);
const store = new Uint8Array(STORE_SIZE * STORE_SIZE * 4);
const inset = (STORE_SIZE - STORE_ART) / 2;
for (let y = 0; y < STORE_ART; y++) {
  store.set(art.subarray(y * STORE_ART * 4, (y + 1) * STORE_ART * 4), ((y + inset) * STORE_SIZE + inset) * 4);
}
const storeDir = join(projectRoot, 'docs', 'store');
mkdirSync(storeDir, { recursive: true });
const storeFile = join(storeDir, 'icon-128.png');
writeFileSync(storeFile, encodePng(STORE_SIZE, store));
console.log(`wrote ${storeFile}`);
