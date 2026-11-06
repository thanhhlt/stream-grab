import type { AudioTrackSummary, StreamingProtocol, VariantSummary } from '@/core/models/detected-stream';
import type { VideoVariant } from '@/core/models/video-variant';
import type { ResolutionPreference } from '@/shared/settings/settings';

export interface VariantRef {
  id: string;
  height?: number | undefined;
  bandwidth?: number | undefined;
}

/**
 * The chosen variant in a (re-)parsed manifest. Variant IDs are positions in
 * the manifest, so when the manifest changed, the variant with the same
 * resolution and bandwidth is used instead; undefined when neither matches.
 */
export function matchVariant(variants: readonly VideoVariant[], wanted: VariantRef): VideoVariant | undefined {
  const known = wanted.height !== undefined || wanted.bandwidth !== undefined;
  const same = (variant: VideoVariant): boolean => variant.height === wanted.height && variant.bandwidth === wanted.bandwidth;
  const byId = variants.find((variant) => variant.id === wanted.id);
  if (byId && (!known || same(byId))) return byId;
  return known ? variants.find(same) : undefined;
}

/**
 * Default selections in the popup. Pure, so the popup and tests share them.
 */

/**
 * Variant matching the preferred resolution: `highest`/`lowest`, or the
 * best variant at or below the preferred height ("falls back to the nearest
 * lower one"); if every variant is taller, the smallest one. Audio-only
 * variants are only chosen when nothing else exists. `variants` is best first.
 */
export function chooseVariant(
  variants: readonly VariantSummary[],
  preference: ResolutionPreference,
): VariantSummary | undefined {
  const video = variants.filter((variant) => !variant.audioOnly);
  const candidates = video.length > 0 ? video : [...variants];
  if (candidates.length === 0) return undefined;
  if (preference === 'highest') return candidates[0];
  if (preference === 'lowest') return candidates[candidates.length - 1];

  const target = Number(preference);
  const withHeight = candidates.filter((variant) => variant.height !== undefined);
  if (withHeight.length === 0) return candidates[0];
  const atOrBelow = withHeight.filter((variant) => (variant.height ?? 0) <= target);
  if (atOrBelow.length > 0) return atOrBelow[0];
  return withHeight[withHeight.length - 1];
}

/**
 * Audio tracks preselected for a variant: its default track (or first). None
 * when the variant has no alternative tracks, or for a DASH representation
 * that already carries audio.
 */
export function defaultAudioTracks(
  protocol: StreamingProtocol,
  variant: VariantSummary,
  tracks: readonly AudioTrackSummary[],
): string[] {
  if (variant.audioOnly || (protocol === 'dash' && variant.audioCodec !== undefined)) return [];
  const usable = tracks.filter((track) => variant.audioTrackIds.includes(track.id));
  const preferred = usable.find((track) => track.isDefault) ?? usable[0];
  return preferred ? [preferred.id] : [];
}
