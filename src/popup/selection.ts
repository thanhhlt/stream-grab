import { defaultBaseName } from '@/core/download/file-name';
import { variantLabel } from '@/core/download/labels';
import { chooseVariant, defaultAudioTracks } from '@/core/download/variant-choice';
import type { DetectedStream, VariantSummary } from '@/core/models/detected-stream';
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
  fileName: string;
  /** Once edited by the user, the name no longer follows quality changes. */
  fileNameEdited: boolean;
}

function titleOf(stream: DetectedStream): string {
  return stream.title ?? (fileNameOf(stream.url) || 'video');
}

function choiceFor(stream: DetectedStream, variant: VariantSummary): StreamChoice {
  return {
    variantId: variant.id,
    audioTrackIds: defaultAudioTracks(stream.protocol, variant, stream.media?.audioTracks ?? []),
    fileName: defaultBaseName(titleOf(stream), variantLabel(variant)),
    fileNameEdited: false,
  };
}

/** Defaults: the preferred resolution from Settings, its default audio track, a generated name. */
export function defaultChoice(stream: DetectedStream, preference: ResolutionPreference): StreamChoice | undefined {
  const variant = chooseVariant(stream.media?.variants ?? [], preference);
  return variant ? choiceFor(stream, variant) : undefined;
}

/** Switching quality resets the audio tracks to that quality's defaults and, unless edited, the name. */
export function withVariant(stream: DetectedStream, choice: StreamChoice, variantId: string): StreamChoice {
  const variant = stream.media?.variants.find((candidate) => candidate.id === variantId);
  if (!variant) return choice;
  const next = choiceFor(stream, variant);
  return choice.fileNameEdited ? { ...next, fileName: choice.fileName, fileNameEdited: true } : next;
}

export function withAudioTrack(choice: StreamChoice, trackId: string, included: boolean): StreamChoice {
  const others = choice.audioTrackIds.filter((id) => id !== trackId);
  return { ...choice, audioTrackIds: included ? [...others, trackId] : others };
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

export function toRequest(stream: DetectedStream, choice: StreamChoice): DownloadRequest {
  return {
    tabId: stream.tabId,
    streamId: stream.id,
    variantId: choice.variantId,
    audioTrackIds: choice.audioTrackIds,
    fileName: choice.fileName,
  };
}
