import { isRecord } from '@/shared/utils/guards';

/**
 * Cues a page's player put into its <video>'s text tracks (0.7.2), as the
 * content script read them. Some players shift a subtitle file's cues when
 * they load it (an intro added after the subtitles were made): the cues they
 * show are the truth, the file's own times are not.
 */
export interface PageCue {
  /** Seconds on the player's timeline. */
  start: number;
  text: string;
}

export interface PageTextTrack {
  kind: string;
  label?: string;
  language?: string;
  /** The first cues of the track, in order. */
  cues: PageCue[];
}

export const TEXT_TRACK_LIMITS = {
  maxTracks: 16,
  maxCues: 60,
  maxCueText: 200,
  maxLabel: 100,
} as const;

/** Validates what a content script reported (page-controlled data). */
export function parseTextTracks(raw: unknown): PageTextTrack[] {
  if (!isRecord(raw) || !Array.isArray(raw['tracks'])) return [];
  const tracks: PageTextTrack[] = [];
  for (const item of raw['tracks'].slice(0, TEXT_TRACK_LIMITS.maxTracks)) {
    if (!isRecord(item) || typeof item['kind'] !== 'string' || !Array.isArray(item['cues'])) continue;
    const cues: PageCue[] = [];
    for (const cue of item['cues'].slice(0, TEXT_TRACK_LIMITS.maxCues)) {
      if (!isRecord(cue) || typeof cue['start'] !== 'number' || !Number.isFinite(cue['start']) || cue['start'] < 0) continue;
      if (typeof cue['text'] !== 'string' || cue['text'].trim() === '') continue;
      cues.push({ start: cue['start'], text: cue['text'].slice(0, TEXT_TRACK_LIMITS.maxCueText) });
    }
    if (cues.length === 0) continue;
    const track: PageTextTrack = { kind: item['kind'].slice(0, 20), cues };
    if (typeof item['label'] === 'string' && item['label'] !== '') track.label = item['label'].slice(0, TEXT_TRACK_LIMITS.maxLabel);
    if (typeof item['language'] === 'string' && item['language'] !== '') track.language = item['language'].slice(0, 35);
    tracks.push(track);
  }
  return tracks;
}
