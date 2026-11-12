import { defaultBaseName } from '@/core/download/file-name';
import { variantLabel } from '@/core/download/labels';
import { chooseVariant, defaultAudioTracks } from '@/core/download/variant-choice';
import { languageKey } from '@/core/media/languages';
import type { DetectedStream, SubtitleTrackSummary, VariantSummary } from '@/core/models/detected-stream';
import type { DownloadRequest } from '@/core/models/download-task';
import type { ResolutionPreference } from '@/shared/settings/settings';
import { fileNameOf } from '@/shared/utils/url';

/** Pure selection logic of the Detected tab. */

export type Availability = { ok: true } | { ok: false; reason: string };

/** Whether a stream can be queued, and why not. */
export function downloadAvailability(stream: DetectedStream): Availability {
  switch (stream.status) {
    case 'pending':
      return { ok: false, reason: 'Still inspecting this stream…' };
    case 'drm':
      return { ok: false, reason: 'DRM-protected streams cannot be downloaded.' };
    case 'error':
      return { ok: false, reason: stream.statusMessage ?? 'This stream is not available.' };
    case 'ready':
      break;
  }
  if (stream.manifest?.live) return { ok: false, reason: 'Live streams cannot be downloaded yet.' };
  if (!stream.media || stream.media.variants.length === 0) {
    return { ok: false, reason: 'No details for this stream. Reload the page and play it again.' };
  }
  return { ok: true };
}

/** What the user picked for one stream. */
export interface StreamChoice {
  variantId: string;
  audioTrackIds: string[];
  /** WebVTT subtitle tracks saved with the video (0.7.0). */
  subtitleTrackIds: string[];
  fileName: string;
  /** Once edited by the user, the name no longer follows quality changes. */
  fileNameEdited: boolean;
}

function titleOf(stream: DetectedStream): string {
  return stream.title ?? (fileNameOf(stream.url) || 'video');
}

/** The subtitle tracks a quality offers, in the stream's order. */
export function offeredSubtitles(stream: DetectedStream, variant: VariantSummary | undefined): SubtitleTrackSummary[] {
  const ids = variant?.subtitleTrackIds ?? [];
  return (stream.media?.subtitleTracks ?? []).filter((track) => ids.includes(track.id));
}

/** Primary subtags that name no language. */
const NO_LANGUAGE = new Set(['', 'und', 'mul', 'zxx']);

/**
 * Whether a track's language is one of Settings → subtitle languages: the same
 * language ("en" = "en-US" = "eng"; a code languageKey does not know, such as
 * "mt", by its primary subtag); a wanted tag with a region or script ("pt-BR",
 * "zh-Hant") also takes a track without one ("pt") or with more ("zh-Hant-TW"),
 * not another region.
 */
function languageMatches(wanted: string, language: string | undefined): boolean {
  if (language === undefined) return false;
  const want = wanted.trim().toLowerCase().replace(/_/g, '-');
  const have = language.trim().toLowerCase().replace(/_/g, '-');
  const primary = (tag: string) => tag.split('-')[0] ?? '';
  if (NO_LANGUAGE.has(primary(have)) || NO_LANGUAGE.has(primary(want))) return false;
  const key = (tag: string) => languageKey(tag) ?? primary(tag);
  if (key(want) !== key(have)) return false;
  if (!want.includes('-') || !have.includes('-')) return true;
  return have === want || have.startsWith(`${want}-`);
}

/**
 * Subtitles preselected for a quality: per language of Settings, in that
 * order, one track, the default among them or else the first. Forced tracks
 * (only foreign-language lines) are never preselected.
 */
export function defaultSubtitleTracks(offered: readonly SubtitleTrackSummary[], languages: readonly string[]): string[] {
  const chosen: string[] = [];
  for (const wanted of languages) {
    const matching = offered.filter((track) => track.forced !== true && !chosen.includes(track.id) && languageMatches(wanted, track.language));
    const pick = matching.find((track) => track.isDefault) ?? matching[0];
    if (pick) chosen.push(pick.id);
  }
  return chosen;
}

function choiceFor(stream: DetectedStream, variant: VariantSummary, languages: readonly string[]): StreamChoice {
  return {
    variantId: variant.id,
    audioTrackIds: defaultAudioTracks(stream.protocol, variant, stream.media?.audioTracks ?? []),
    subtitleTrackIds: defaultSubtitleTracks(offeredSubtitles(stream, variant), languages),
    // A progressive file has one quality, the file itself: its name says nothing about it.
    fileName: defaultBaseName(titleOf(stream), stream.protocol === 'progressive' ? undefined : variantLabel(variant)),
    fileNameEdited: false,
  };
}

/**
 * Defaults: the preferred resolution from Settings, its default audio track, the subtitles in
 * Settings' languages (parseSubtitleLanguages), a generated name.
 */
export function defaultChoice(
  stream: DetectedStream,
  preference: ResolutionPreference,
  languages: readonly string[] = [],
): StreamChoice | undefined {
  const variant = chooseVariant(stream.media?.variants ?? [], preference);
  return variant ? choiceFor(stream, variant, languages) : undefined;
}

/**
 * Switching quality resets the audio tracks to that quality's defaults and, unless edited, the name.
 * The subtitles stay as picked when the new quality offers the same tracks (an HLS subtitle group
 * is usually shared by every quality); otherwise they are that quality's defaults.
 */
export function withVariant(
  stream: DetectedStream,
  choice: StreamChoice,
  variantId: string,
  languages: readonly string[] = [],
): StreamChoice {
  const variants = stream.media?.variants ?? [];
  const variant = variants.find((candidate) => candidate.id === variantId);
  if (!variant) return choice;
  const next = choiceFor(stream, variant, languages);
  const offered = (summary: VariantSummary | undefined) => [...(summary?.subtitleTrackIds ?? [])].sort().join('\n');
  if (offered(variants.find((candidate) => candidate.id === choice.variantId)) === offered(variant)) {
    next.subtitleTrackIds = choice.subtitleTrackIds;
  }
  return choice.fileNameEdited ? { ...next, fileName: choice.fileName, fileNameEdited: true } : next;
}

export function withAudioTrack(choice: StreamChoice, trackId: string, included: boolean): StreamChoice {
  const others = choice.audioTrackIds.filter((id) => id !== trackId);
  return { ...choice, audioTrackIds: included ? [...others, trackId] : others };
}

export function withSubtitleTrack(choice: StreamChoice, trackId: string, included: boolean): StreamChoice {
  const others = choice.subtitleTrackIds.filter((id) => id !== trackId);
  return { ...choice, subtitleTrackIds: included ? [...others, trackId] : others };
}

export function withFileName(choice: StreamChoice, fileName: string): StreamChoice {
  return { ...choice, fileName, fileNameEdited: true };
}

export type SelectAllState = 'none' | 'some' | 'all';

export function selectAllState(selectableIds: readonly string[], selected: ReadonlySet<string>): SelectAllState {
  const count = selectableIds.filter((id) => selected.has(id)).length;
  if (count === 0) return 'none';
  return count === selectableIds.length ? 'all' : 'some';
}

/**
 * The request for the background. Subtitles the quality no longer offers (a progressive file's
 * `<track>` removed since they were picked) are left out instead of failing the request.
 */
export function toRequest(stream: DetectedStream, choice: StreamChoice): DownloadRequest {
  const request: DownloadRequest = {
    tabId: stream.tabId,
    streamId: stream.id,
    variantId: choice.variantId,
    audioTrackIds: choice.audioTrackIds,
    fileName: choice.fileName,
  };
  const variant = stream.media?.variants.find((candidate) => candidate.id === choice.variantId);
  const offered = new Set(offeredSubtitles(stream, variant).map((track) => track.id));
  const subtitleTrackIds = choice.subtitleTrackIds.filter((id) => offered.has(id));
  if (subtitleTrackIds.length > 0) request.subtitleTrackIds = subtitleTrackIds;
  return request;
}
