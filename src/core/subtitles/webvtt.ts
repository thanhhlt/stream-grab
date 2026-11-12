/**
 * WebVTT text subtitles (since 0.7.0): parsing, joining segmented files on
 * the output timeline, and writing WebVTT or SubRip (SRT).
 *
 * Subtitle files are untrusted input. Parsing is tolerant (BOM, CRLF, cue
 * ids, NOTE/STYLE/REGION blocks, a comma as decimal separator) and never
 * throws: a body without the `WEBVTT` signature is not a subtitle file
 * (`null`), anything else that does not parse is skipped.
 *
 * `STYLE` and `REGION` blocks are never written back: FFmpeg's WebVTT
 * demuxer drops every cue of a file with a `STYLE` block (FFmpeg 5.1.4,
 * checked in v0.7.0 Phase 1).
 */

export interface VttCue {
  /** Seconds. */
  start: number;
  /** Seconds; greater than `start`. */
  end: number;
  /** Cue payload, lines joined with "\n" (WebVTT markup kept). */
  text: string;
  /** Cue settings ("line:0 align:start"), kept for WebVTT output. */
  settings?: string;
}

/** `X-TIMESTAMP-MAP` of an HLS WebVTT segment (RFC 8216 §3.5). */
export interface TimestampMap {
  /** LOCAL, seconds. */
  localSec: number;
  /** MPEGTS, 90 kHz ticks. */
  mpegts: number;
}

export interface ParsedVtt {
  cues: VttCue[];
  timestampMap?: TimestampMap;
}

export const VTT_LIMITS = {
  maxCues: 200_000,
  maxCueTextLength: 4096,
} as const;

/** MPEG-2 timestamps are 33 bits of a 90 kHz clock. */
const MPEGTS_CLOCK = 90_000;
const MPEGTS_WRAP_SEC = 2 ** 33 / MPEGTS_CLOCK;

const BOM = new RegExp('^\\uFEFF');
const SIGNATURE = /^WEBVTT(?:[ \t].*)?$/;
const TIMING = /^(\S+?)[ \t]*-->[ \t]*(\S+)(?:[ \t]+(.*))?$/;
const TIMESTAMP = /^(?:(\d{1,7}):)?(\d{2}):(\d{2})[.,](\d{3})$/;

/** "01:02:03.456", "02:03.456" (or with a comma) → seconds; null when malformed. */
export function parseVttTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, millis] = match;
  const m = Number(minutes);
  const s = Number(seconds);
  if (m > 59 || s > 59) return null;
  return Number(hours ?? 0) * 3600 + m * 60 + s + Number(millis) / 1000;
}

function parseTimestampMap(line: string): TimestampMap | undefined {
  const value = line.slice('X-TIMESTAMP-MAP='.length);
  let localSec: number | null = null;
  let mpegts: number | null = null;
  for (const part of value.split(',')) {
    const [key, raw] = part.split(/:(.*)/s, 2).map((piece) => piece.trim());
    if (key === 'LOCAL' && raw !== undefined) localSec = parseVttTimestamp(raw);
    if (key === 'MPEGTS' && raw !== undefined && /^\d+$/.test(raw)) mpegts = Number(raw);
  }
  return localSec === null || mpegts === null || !Number.isSafeInteger(mpegts) ? undefined : { localSec, mpegts };
}

function isBlockKeyword(line: string, keyword: string): boolean {
  return line === keyword || line.startsWith(`${keyword} `) || line.startsWith(`${keyword}\t`);
}

/** Parses one WebVTT file (or HLS segment). Null when the body is not WebVTT. */
export function parseWebVtt(text: string): ParsedVtt | null {
  const lines = text.replace(BOM, '').replace(/\r\n?/g, '\n').replace(/\0/g, '�').split('\n');
  if (!SIGNATURE.test(lines[0] ?? '')) return null;

  const parsed: ParsedVtt = { cues: [] };
  let i = 1;
  // Header: up to the first blank line (or the first timing line of a file without one).
  for (; i < lines.length && lines[i] !== '' && !lines[i]!.includes('-->'); i++) {
    const line = lines[i]!;
    if (line.startsWith('X-TIMESTAMP-MAP=')) {
      const map = parseTimestampMap(line);
      if (map) parsed.timestampMap = map;
    }
  }

  while (i < lines.length && parsed.cues.length < VTT_LIMITS.maxCues) {
    while (i < lines.length && lines[i]!.trim() === '') i++;
    const block: string[] = [];
    for (; i < lines.length && lines[i]!.trim() !== ''; i++) block.push(lines[i]!);
    if (block.length === 0) break;
    const first = block[0]!;
    if (isBlockKeyword(first, 'NOTE') || isBlockKeyword(first, 'STYLE') || isBlockKeyword(first, 'REGION')) continue;
    readCues(block, parsed.cues);
  }
  return parsed;
}

/**
 * The cues of one block, in a single pass. Every timing line starts a cue (a
 * file may forget the blank line between cues); a line before the first
 * timing line is the cue identifier; text after a malformed timing line is
 * dropped with it.
 */
function readCues(block: readonly string[], cues: VttCue[]): void {
  let current: VttCue | null = null;
  let text: string[] = [];
  const flush = () => {
    const cueText = text.join('\n').trimEnd().slice(0, VTT_LIMITS.maxCueTextLength);
    if (current && cueText.trim() !== '' && cues.length < VTT_LIMITS.maxCues) cues.push({ ...current, text: cueText });
    current = null;
    text = [];
  };
  for (const line of block) {
    if (!line.includes('-->')) {
      if (current) text.push(line);
      continue;
    }
    flush();
    const timing = TIMING.exec(line.trim());
    const start = timing ? parseVttTimestamp(timing[1]!) : null;
    const end = timing ? parseVttTimestamp(timing[2]!) : null;
    if (start === null || end === null || end <= start) continue;
    current = { start, end, text: '' };
    const settings = timing?.[3]?.trim();
    if (settings) current.settings = settings;
  }
  flush();
}

/**
 * Seconds to add to the cues of one HLS WebVTT segment so they land on the
 * output timeline (as hls.js does): `MPEGTS/90000 − LOCAL − firstPts + runStart`.
 * `firstPtsSec` is the first presentation time of the video's run the segment
 * belongs to, `runStartSec` where that run starts in the output. MPEGTS is
 * unwrapped (33-bit) to the value closest to `firstPtsSec`. Without a map,
 * MPEGTS and LOCAL are 0 (RFC 8216).
 */
export function hlsCueOffsetSec(map: TimestampMap | undefined, run: { firstPtsSec: number; runStartSec: number }): number {
  let mpegtsSec = (map?.mpegts ?? 0) / MPEGTS_CLOCK;
  mpegtsSec += Math.round((run.firstPtsSec - mpegtsSec) / MPEGTS_WRAP_SEC) * MPEGTS_WRAP_SEC;
  return run.runStartSec + mpegtsSec - (map?.localSec ?? 0) - run.firstPtsSec;
}

const MS = 1000;
const toMs = (seconds: number) => Math.round(seconds * MS);

/**
 * Joins cue lists on one timeline: shifts each list by its offset, drops
 * cues repeated across segments (same times and text), joins a cue a
 * packager split at a segment boundary, sorts, and cuts everything to
 * [0, durationSec] (a cue after the video's end would lengthen a merged file).
 */
export function joinCues(lists: readonly { cues: readonly VttCue[]; offsetSec: number }[], durationSec?: number): VttCue[] {
  const seen = new Set<string>();
  const shifted: VttCue[] = [];
  for (const { cues, offsetSec } of lists) {
    for (const cue of cues) {
      const start = toMs(cue.start + offsetSec);
      const end = toMs(cue.end + offsetSec);
      const key = `${start}|${end}|${cue.settings ?? ''}|${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      shifted.push({ ...cue, start, end });
    }
  }
  shifted.sort((a, b) => a.start - b.start || a.end - b.end);

  const limit = durationSec === undefined ? Infinity : toMs(durationSec);
  const joined: VttCue[] = [];
  for (const cue of shifted) {
    const start = Math.max(0, cue.start);
    const end = Math.min(limit, cue.end);
    if (end - start < 1) continue;
    const previous = joined.at(-1);
    if (previous && previous.text === cue.text && previous.settings === cue.settings && start - previous.end <= 1 && start >= previous.start) {
      previous.end = Math.max(previous.end, end);
      continue;
    }
    joined.push({ ...cue, start, end });
  }
  return joined.map((cue) => ({ ...cue, start: cue.start / MS, end: cue.end / MS }));
}

function formatTime(seconds: number, separator: '.' | ','): string {
  const total = Math.max(0, toMs(seconds));
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60_000) % 60;
  const h = Math.floor(total / 3_600_000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms, 3)}`;
}

/** A blank line ends a cue, so it never appears inside one. */
const cueLines = (text: string) => text.split('\n').filter((line) => line.trim() !== '');

export function formatWebVtt(cues: readonly VttCue[]): string {
  const blocks = cues.map((cue) => {
    const timing = `${formatTime(cue.start, '.')} --> ${formatTime(cue.end, '.')}${cue.settings ? ` ${cue.settings}` : ''}`;
    return [timing, ...cueLines(cue.text)].join('\n');
  });
  return ['WEBVTT', ...blocks].join('\n\n') + '\n';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      // Control characters (a CR or LF would end the cue in SubRip) become a space.
      if (Number.isInteger(code) && code < 0x20) return ' ';
      return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** WebVTT cue text → SubRip: keeps <i>, <b>, <u> (without classes), drops other tags, decodes entities. */
export function srtCueText(text: string): string {
  const plain = text.replace(/<(\/?)([a-z]+)?[^>]*>/gi, (_tag, close: string, name: string | undefined) => {
    const tag = name?.toLowerCase();
    return tag === 'i' || tag === 'b' || tag === 'u' ? `<${close}${tag}>` : '';
  });
  // A decoded "-->" would read as a timing line.
  return decodeEntities(plain).replace(/-->/g, '->');
}

export function formatSrt(cues: readonly VttCue[]): string {
  const blocks: string[] = [];
  for (const cue of cues) {
    const lines = cueLines(srtCueText(cue.text));
    if (lines.length === 0) continue;
    blocks.push([String(blocks.length + 1), `${formatTime(cue.start, ',')} --> ${formatTime(cue.end, ',')}`, ...lines].join('\r\n'));
  }
  return blocks.length === 0 ? '' : blocks.join('\r\n\r\n') + '\r\n';
}
