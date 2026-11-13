import { TEXT_TRACK_LIMITS, type PageCue, type PageTextTrack } from '@/shared/types/text-tracks';

/**
 * The first cues of every text track of the frame's <video> elements (0.7.2),
 * whatever their kind or mode: players that draw subtitles themselves often
 * keep them in a hidden `metadata` track. Only start times and text are read.
 */
export function collectTextTracks(root: ParentNode): { tracks: PageTextTrack[] } {
  const tracks: PageTextTrack[] = [];
  for (const video of root.querySelectorAll('video')) {
    for (const track of video.textTracks) {
      if (tracks.length >= TEXT_TRACK_LIMITS.maxTracks) return { tracks };
      const cues: PageCue[] = [];
      for (const cue of track.cues ?? []) {
        if (cues.length >= TEXT_TRACK_LIMITS.maxCues) break;
        const text = 'text' in cue && typeof cue.text === 'string' ? cue.text : '';
        if (text.trim() !== '') cues.push({ start: cue.startTime, text: text.slice(0, TEXT_TRACK_LIMITS.maxCueText) });
      }
      if (cues.length === 0) continue;
      const entry: PageTextTrack = { kind: track.kind, cues };
      if (track.label) entry.label = track.label.slice(0, TEXT_TRACK_LIMITS.maxLabel);
      if (track.language) entry.language = track.language.slice(0, 35);
      tracks.push(entry);
    }
  }
  return { tracks };
}
