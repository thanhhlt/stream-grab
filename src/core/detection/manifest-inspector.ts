import type {
  AudioTrackSummary,
  SubtitleTrackSummary,
  ManifestSummary,
  MediaSummary,
  StreamingProtocol,
  VariantSummary,
} from '@/core/models/detected-stream';
import type { StreamingManifest } from '@/core/models/streaming-manifest';
import { buildDashManifest } from '@/core/protocols/dash/dash-adapter';
import { parseMpd } from '@/core/protocols/dash/dash-mpd';
import { buildHlsManifest } from '@/core/protocols/hls/hls-adapter';
import { parseHlsPlaylist } from '@/core/protocols/hls/hls-playlist';
import { compareVariants } from '@/core/protocols/protocol-adapter';
import { sniffManifest } from '@/core/protocols/sniff';
import { errorMessage } from '@/shared/utils/errors';

export { sniffManifest };

/**
 * What detection needs to know about a manifest: confirmed protocol, the
 * playlists it references (folded under it in the list), live/DRM flags and a
 * small media summary for display. Built from the protocol adapters' parse.
 */
export interface ManifestInfo extends ManifestSummary {
  protocol: StreamingProtocol;
  /** Absolute URLs of playlists referenced by an HLS master (variants, renditions, I-frame playlists). */
  childUrls: string[];
  media?: MediaSummary;
}

export type InspectResult = { ok: true; info: ManifestInfo } | { ok: false; reason: string };

const MAX_SUMMARY_ITEMS = 20;

/**
 * Small, persisted view of a parsed manifest for the popup: qualities (best
 * first) and audio tracks with the IDs the user's choice is sent back with.
 * Tracks are not merged by name: an HLS quality may only be combined with the
 * tracks of its own audio group.
 */
export function summarizeManifest(manifest: StreamingManifest): MediaSummary {
  const audioTracks: AudioTrackSummary[] = manifest.audioTracks.slice(0, MAX_SUMMARY_ITEMS).map((track) => {
    const summary: AudioTrackSummary = { id: track.id, name: track.name, isDefault: track.isDefault };
    if (track.language !== undefined) summary.language = track.language;
    if (track.codec !== undefined) summary.codec = track.codec;
    return summary;
  });
  const listed = new Set(audioTracks.map((track) => track.id));
  const subtitleTracks: SubtitleTrackSummary[] = (manifest.subtitleTracks ?? []).slice(0, MAX_SUMMARY_ITEMS).map((track) => {
    const summary: SubtitleTrackSummary = { id: track.id, name: track.name, isDefault: track.isDefault };
    if (track.language !== undefined) summary.language = track.language;
    if (track.forced) summary.forced = true;
    return summary;
  });
  const listedSubtitles = new Set(subtitleTracks.map((track) => track.id));
  const variants: VariantSummary[] = [...manifest.variants]
    .sort(compareVariants)
    .slice(0, MAX_SUMMARY_ITEMS)
    .map((variant) => {
      const summary: VariantSummary = {
        id: variant.id,
        audioOnly: variant.audioOnly,
        audioTrackIds: variant.audioTrackIds.filter((id) => listed.has(id)),
      };
      const subtitleTrackIds = (variant.subtitleTrackIds ?? []).filter((id) => listedSubtitles.has(id));
      if (subtitleTrackIds.length > 0) summary.subtitleTrackIds = subtitleTrackIds;
      if (variant.width !== undefined) summary.width = variant.width;
      if (variant.height !== undefined) summary.height = variant.height;
      if (variant.bandwidth !== undefined) summary.bandwidth = variant.bandwidth;
      if (variant.frameRate !== undefined) summary.frameRate = variant.frameRate;
      if (variant.videoCodec !== undefined) summary.videoCodec = variant.videoCodec;
      if (variant.audioCodec !== undefined) summary.audioCodec = variant.audioCodec;
      return summary;
    });
  const media: MediaSummary = { variants, audioTracks };
  if (subtitleTracks.length > 0) media.subtitleTracks = subtitleTracks;
  if (manifest.durationSec !== undefined) media.durationSec = manifest.durationSec;
  return media;
}

/** Detection's view of a parsed manifest. */
export function manifestInfoFrom(manifest: StreamingManifest): ManifestInfo {
  return {
    protocol: manifest.protocol,
    role: manifest.hls?.kind ?? 'presentation',
    live: manifest.isLive,
    drmSystems: manifest.drmSystems,
    encryption: manifest.encryption,
    childUrls: manifest.childUrls,
    media: summarizeManifest(manifest),
  };
}

/**
 * Inspects a manifest body without further requests; the protocol comes from
 * the content, not from the URL or headers. For an HLS master this sees only
 * the master itself (the adapter also reads the first variant).
 */
export function inspectManifest(text: string, baseUrl: string, now: number = Date.now()): InspectResult {
  try {
    const protocol = sniffManifest(text.slice(0, 4096));
    if (protocol === 'hls') {
      return { ok: true, info: manifestInfoFrom(buildHlsManifest(parseHlsPlaylist(text, baseUrl), undefined, baseUrl, {})) };
    }
    if (protocol === 'dash') {
      return { ok: true, info: manifestInfoFrom(buildDashManifest(parseMpd(text, baseUrl, now), baseUrl, {})) };
    }
    return { ok: false, reason: 'Body is neither an HLS playlist nor a DASH MPD' };
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }
}
