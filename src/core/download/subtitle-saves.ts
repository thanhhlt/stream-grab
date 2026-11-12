import type { SubtitleOutput, TaskSubtitle } from '@/core/models/download-task';
import { formatSrt, formatWebVtt, joinCues, parseWebVtt } from '@/core/subtitles/webvtt';
import type { SubtitleFormat } from '@/shared/settings/settings';
import { sanitizeBaseName } from './file-name';

/**
 * Saving a task's subtitle files (0.7.0), service-worker side. A subtitle is
 * saved after its video, because Chrome renames a file whose name is taken
 * (`uniquify`) and the subtitle must follow the video's final name:
 * `<video>.<language>.srt` next to `<video>.mp4` is what players pick up.
 */

/** Chrome keeps these extensions for these types (checked in Chrome 157); an untyped file becomes `.txt`. */
export const SUBTITLE_MIME_TYPES: Record<SubtitleFormat, string> = { srt: 'application/x-subrip', vtt: 'text/vtt' };

/** A `<track>` file larger than this is not subtitles. */
export const MAX_TRACK_FILE_BYTES = 16 * 1024 * 1024;

/** Chrome refuses URLs over 2 MiB (kMaxURLChars): the base64 of a data: URL must stay below that. */
export const MAX_DATA_URL_TEXT_BYTES = 1_500_000;

/**
 * An entry that has not been handed to Chrome yet and has not failed. An
 * embedded track without a file URL has nothing to save (embedded only).
 */
export const awaitsSave = (file: SubtitleOutput): boolean =>
  file.downloadId === undefined && !file.saved && file.error === undefined && !(file.embedded === true && file.url === undefined);

/** An entry Chrome is saving, as far as the task knows. */
export const isSaving = (file: SubtitleOutput): boolean => file.downloadId !== undefined && !file.saved && file.error === undefined;

/** The video's file name without folder and extension, from the full path Chrome reports. */
export function savedBaseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

const tagPart = (value: string): string => sanitizeBaseName(value, 40).replace(/\./g, ' ').trim();

function languageTag(subtitle: TaskSubtitle): string {
  const language = subtitle.language ? tagPart(subtitle.language) : '';
  const tag = language !== '' && language !== 'video' ? language : 'und';
  return subtitle.forced ? `${tag}.forced` : tag;
}

/**
 * `<video base>.<language>[.forced][.<name>].<srt|vtt>`: the track's name is
 * added only when another chosen track has the same language tag.
 */
export function subtitleFileName(videoBase: string, subtitle: TaskSubtitle, chosen: readonly TaskSubtitle[], format: SubtitleFormat): string {
  let tag = languageTag(subtitle);
  if (chosen.filter((other) => languageTag(other) === tag).length > 1) {
    const name = tagPart(subtitle.name);
    tag = `${tag}.${name !== '' && name !== 'video' ? name : String(chosen.indexOf(subtitle) + 1)}`;
  }
  return `${videoBase}.${tag}.${format}`;
}

/** A progressive file's `<track>` WebVTT file → the subtitle file's text; throws when it is not usable. */
export function convertTrackFile(text: string, format: SubtitleFormat): string {
  const parsed = parseWebVtt(text);
  if (!parsed) throw new Error('The subtitle file is not WebVTT');
  const cues = joinCues([{ cues: parsed.cues, offsetSec: 0 }]);
  if (cues.length === 0) throw new Error('The subtitle file has no subtitles');
  return format === 'srt' ? formatSrt(cues) : formatWebVtt(cues);
}

/** A data: URL of the text (UTF-8), typed so Chrome keeps the extension. A service worker has no blob: URLs. */
export function subtitleDataUrl(text: string, format: SubtitleFormat): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_DATA_URL_TEXT_BYTES) throw new Error('the file is too large to save (over 1.5 MB)');
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${SUBTITLE_MIME_TYPES[format]};base64,${btoa(binary)}`;
}

/** Why Chrome did not save a subtitle file (chrome.downloads.InterruptReason). */
export function subtitleSaveFailure(reason: string | undefined): string {
  switch (reason ?? '') {
    case 'USER_CANCELED':
      return "Saving the subtitle file was cancelled in Chrome's downloads.";
    case 'FILE_NO_SPACE':
      return 'Not enough disk space to save the subtitle file.';
    case 'USER_SHUTDOWN':
    case 'CRASH':
      return 'Chrome closed while saving the subtitle file.';
    default:
      return `Chrome could not save the subtitle file${reason ? ` (${reason})` : ''}.`;
  }
}
