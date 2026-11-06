/**
 * Generates the extension icons (public/icons/icon-{16,32,48,128}.png).
 *
 * Chrome requires PNG icons for the toolbar action, so the artwork is drawn
 * procedurally (supersampled vector shapes) and encoded with a minimal PNG
 * writer. No image tooling is needed; re-run with `npm run icons`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { publicDir } from '../build/paths.ts';

const SIZES = [16, 32, 48, 128] as const;
const SUPERSAMPLE = 6;

type Rgb = readonly [number, number, number];
const GRADIENT_FROM: Rgb = [79, 70, 229]; // indigo-600
const GRADIENT_TO: Rgb = [124, 58, 237]; // violet-600
const GLYPH: Rgb = [255, 255, 255];

function roundedRectContains(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function triangleContains(x: number, y: number, a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): boolean {
  const sign = (p: readonly [number, number], q: readonly [number, number]): number =>
    (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = sign(a, b);
  const d2 = sign(b, c);
  const d3 = sign(c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Download arrow over three "segment" bars that merge into a tray. Coordinates are normalised to [0, 1]. */
function glyphContains(x: number, y: number): boolean {
  const shaft = roundedRectContains(x, y, 0.425, 0.17, 0.575, 0.5, 0.04);
  const head = triangleContains(x, y, [0.25, 0.44], [0.75, 0.44], [0.5, 0.69]);
  const tray = roundedRectContains(x, y, 0.22, 0.75, 0.78, 0.85, 0.045);
  return shaft || head || tray;
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
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!roundedRectContains(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) continue;
          const t = Math.min(1, Math.max(0, (x + y) / 2));
          const color: Rgb = glyphContains(x, y)
            ? GLYPH
            : [
                GRADIENT_FROM[0] + (GRADIENT_TO[0] - GRADIENT_FROM[0]) * t,
                GRADIENT_FROM[1] + (GRADIENT_TO[1] - GRADIENT_FROM[1]) * t,
                GRADIENT_FROM[2] + (GRADIENT_TO[2] - GRADIENT_FROM[2]) * t,
              ];
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
