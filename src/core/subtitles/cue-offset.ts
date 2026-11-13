import type { PageCue, PageTextTrack } from '@/shared/types/text-tracks';

/**
 * How far a page's player moved a subtitle file's cues (0.7.2): the seconds
 * to add to the file's times so they match the cues the player shows. Cues
 * are paired by their text (markup and spacing ignored); at least two pairs
 * must agree (within 50 ms) on the shift, or one when the file has a single
 * cue. Undefined when no track holds the file's cues.
 */

/** Cues to remember from a subtitle file to recognise it in a player's tracks. */
export const SAMPLE_CUES = 40;

const AGREE_SEC = 0.05;
const MAX_SHIFT_SEC = 3600;

/** A stored offset read back: a finite, non-zero number of seconds within an hour; undefined otherwise. */
export function parseOffsetSec(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0 && Math.abs(value) <= MAX_SHIFT_SEC ? value : undefined;
}

export function cueKey(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function cueOffsetSec(fileCues: readonly PageCue[], tracks: readonly PageTextTrack[]): number | undefined {
  const byText = new Map<string, number[]>();
  for (const cue of fileCues) {
    const key = cueKey(cue.text);
    if (key !== '') byText.set(key, [...(byText.get(key) ?? []), cue.start]);
  }
  for (const track of tracks) {
    const shifts: number[] = [];
    for (const cue of track.cues) {
      const starts = byText.get(cueKey(cue.text));
      // Repeated lines ("啊") pair ambiguously: only lines the file has once count.
      if (starts?.length === 1) shifts.push(cue.start - starts[0]!);
    }
    if (shifts.length === 0) continue;
    shifts.sort((a, b) => a - b);
    const median = shifts[Math.floor(shifts.length / 2)]!;
    const agreeing = shifts.filter((shift) => Math.abs(shift - median) <= AGREE_SEC).length;
    if (agreeing < Math.min(2, fileCues.length) || Math.abs(median) > MAX_SHIFT_SEC) continue;
    return Math.round(median * 1000) / 1000;
  }
  return undefined;
}
