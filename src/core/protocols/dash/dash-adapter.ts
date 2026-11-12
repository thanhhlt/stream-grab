import { classifyMimeType, protocolFromUrl } from '@/core/detection/manifest-detector';
import type { DrmSystem, RequestContext } from '@/core/models/detected-stream';
import type { MediaSegment } from '@/core/models/media-segment';
import type { StreamingManifest } from '@/core/models/streaming-manifest';
import type { VideoVariant } from '@/core/models/video-variant';
import { fetchFailureError, type ManifestFetcher } from '@/core/network/manifest-fetcher';
import { describeDrm } from '@/core/protocols/drm';
import { ManifestCache, raceAbort } from '@/core/protocols/manifest-cache';
import {
  compareVariants,
  type ParseOptions,
  type SegmentOptions,
  type StreamingProtocolAdapter,
} from '@/core/protocols/protocol-adapter';
import { StreamGrabError } from '@/shared/utils/errors';
import { parseHttpUrl } from '@/shared/utils/url';
import { dashSegments, parseMpd, type ParsedMpd } from './dash-mpd';

export interface DashAdapterOptions {
  fetcher: ManifestFetcher;
  /** Wall clock: cache expiry and the segment window of dynamic MPDs. */
  now?: () => number;
  /** How long static MPDs are reused. */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

export function buildDashManifest(parsed: ParsedMpd, requestedUrl: string, requestContext: RequestContext): StreamingManifest {
  const manifest: StreamingManifest = {
    protocol: 'dash',
    requestedUrl,
    url: parsed.url,
    requestContext,
    isLive: parsed.isLive,
    drmSystems: parsed.scan.drmSystems,
    encryption: parsed.scan.encryption,
    variants: parsed.variants,
    audioTracks: parsed.audioTracks,
    childUrls: [],
  };
  if (parsed.subtitleTracks.length > 0) manifest.subtitleTracks = parsed.subtitleTracks;
  if (parsed.durationSec !== undefined) manifest.durationSec = parsed.durationSec;
  return manifest;
}

/**
 * MPEG-DASH (ISO/IEC 23009-1).
 *
 * The whole MPD is parsed once (all representations), cached, and segments
 * are taken from that parse. Static MPDs are cached for minutes; dynamic ones
 * only until their next update, because their segment window moves with time.
 */
export class DashAdapter implements StreamingProtocolAdapter {
  readonly protocol = 'dash' as const;
  readonly #fetcher: ManifestFetcher;
  readonly #now: () => number;
  readonly #cache: ManifestCache<ParsedMpd>;

  constructor(options: DashAdapterOptions) {
    this.#fetcher = options.fetcher;
    this.#now = options.now ?? Date.now;
    const ttlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.#cache = new ManifestCache<ParsedMpd>({
      now: this.#now,
      maxEntries: options.maxCacheEntries ?? 16,
      ttlFor: (parsed) => (parsed.isLive ? Math.min(Math.max(parsed.minimumUpdatePeriodMs ?? 2000, 1000), 5000) : ttlMs),
      aliasesFor: (parsed) => [parsed.url],
    });
  }

  canHandle(url: string, contentType?: string): boolean {
    const mime = classifyMimeType(contentType);
    if (mime === 'dash') return true;
    if (mime === 'hls') return false;
    const parsed = parseHttpUrl(url);
    return parsed !== null && protocolFromUrl(parsed)?.protocol === 'dash';
  }

  async parseManifest(url: string, options: ParseOptions = {}): Promise<StreamingManifest> {
    const context = options.context ?? {};
    const parsed = options.prefetched
      ? this.#cache.put(url, parseMpd(options.prefetched.text, options.prefetched.finalUrl, this.#now()))
      : await this.#load(url, context, options.signal);
    return buildDashManifest(parsed, url, context);
  }

  getAvailableVariants(manifest: StreamingManifest): Promise<VideoVariant[]> {
    return Promise.resolve([...manifest.variants].sort(compareVariants));
  }

  async getSegments(
    manifest: StreamingManifest,
    variant: VideoVariant,
    options: SegmentOptions = {},
  ): Promise<MediaSegment[]> {
    if (manifest.protocol !== 'dash') throw new StreamGrabError('Not a DASH manifest', 'UNSUPPORTED');
    this.#refuseDrm(manifest.drmSystems);
    const representationId = variant.dash?.representationId;
    if (representationId === undefined || !manifest.variants.some((candidate) => candidate.id === variant.id)) {
      throw new StreamGrabError('Unknown variant for this manifest', 'UNSUPPORTED');
    }

    const parsed = await this.#load(manifest.url, manifest.requestContext, options.signal);
    this.#refuseDrm(parsed.scan.drmSystems);
    const main = parsed.mainRepresentations.get(representationId);
    if (!main) throw new StreamGrabError('The representation is no longer in the MPD', 'MANIFEST_INVALID');
    const segments = dashSegments(main, parsed.url, { id: 'main', type: 'main' });

    for (const trackId of options.audioTrackIds ?? this.#defaultAudioTracks(manifest, variant)) {
      const track = manifest.audioTracks.find((candidate) => candidate.id === trackId);
      if (!track || !variant.audioTrackIds.includes(trackId)) {
        throw new StreamGrabError(`Audio track ${trackId} does not belong to this variant`, 'UNSUPPORTED');
      }
      const audioId = track.dash?.representationId;
      const audio = audioId === undefined ? undefined : parsed.audioRepresentations.get(audioId);
      if (!audio) throw new StreamGrabError(`Audio track ${track.name} is no longer in the MPD`, 'MANIFEST_INVALID');
      segments.push(...dashSegments(audio, parsed.url, { id: track.id, type: 'audio' }));
    }

    for (const trackId of options.subtitleTrackIds ?? []) {
      const track = manifest.subtitleTracks?.find((candidate) => candidate.id === trackId);
      if (!track || !variant.subtitleTrackIds?.includes(trackId)) {
        throw new StreamGrabError(`Subtitle track ${trackId} does not belong to this variant`, 'UNSUPPORTED');
      }
      const subtitleId = track.dash?.representationId;
      const subtitles = subtitleId === undefined ? undefined : parsed.subtitleRepresentations.get(subtitleId);
      if (!subtitles) throw new StreamGrabError(`Subtitle track ${track.name} is no longer in the MPD`, 'MANIFEST_INVALID');
      segments.push(...dashSegments(subtitles, parsed.url, { id: track.id, type: 'subtitle' }));
    }
    return segments;
  }

  /** Separate audio is added unless the representation already carries audio. */
  #defaultAudioTracks(manifest: StreamingManifest, variant: VideoVariant): string[] {
    if (variant.audioOnly || variant.audioCodec !== undefined) return [];
    const tracks = manifest.audioTracks.filter((track) => variant.audioTrackIds.includes(track.id));
    const preferred = tracks.find((track) => track.isDefault) ?? tracks[0];
    return preferred ? [preferred.id] : [];
  }

  /** Never hand out segments of DRM-protected content. */
  #refuseDrm(systems: readonly DrmSystem[]): void {
    if (systems.length > 0) throw new StreamGrabError(describeDrm(systems), 'DRM_PROTECTED');
  }

  #load(url: string, context: RequestContext, signal: AbortSignal | undefined): Promise<ParsedMpd> {
    const parsed = this.#cache.get(url, async () => {
      const result = await this.#fetcher.fetchManifest(url, context);
      if (result.kind !== 'ok') throw fetchFailureError(result);
      if (result.protocol !== 'dash') throw new StreamGrabError('Expected a DASH MPD', 'MANIFEST_INVALID');
      return parseMpd(result.text, result.finalUrl, this.#now());
    });
    return raceAbort(parsed, signal);
  }
}
