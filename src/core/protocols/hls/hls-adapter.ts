import { classifyMimeType, protocolFromUrl } from '@/core/detection/manifest-detector';
import type { DrmSystem, RequestContext } from '@/core/models/detected-stream';
import type { MediaSegment } from '@/core/models/media-segment';
import type { StreamingManifest } from '@/core/models/streaming-manifest';
import type { VideoVariant } from '@/core/models/video-variant';
import { fetchFailureError, type ManifestFetcher } from '@/core/network/manifest-fetcher';
import { describeDrm } from '@/core/protocols/drm';
import { isAbortError, ManifestCache, raceAbort } from '@/core/protocols/manifest-cache';
import {
  compareVariants,
  type ParseOptions,
  type SegmentOptions,
  type StreamingProtocolAdapter,
} from '@/core/protocols/protocol-adapter';
import { StreamGrabError } from '@/shared/utils/errors';
import { parseHttpUrl } from '@/shared/utils/url';
import { mergeKeyScans } from './hls-keys';
import { parseHlsPlaylist, toMediaSegments, type ParsedMediaPlaylist, type ParsedPlaylist } from './hls-playlist';

export interface HlsAdapterOptions {
  fetcher: ManifestFetcher;
  now?: () => number;
  /** How long VOD and multivariant playlists are reused. */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}

/**
 * Builds the protocol-independent manifest from a parsed top-level playlist
 * and, for a multivariant playlist, its first variant (live state, duration
 * and segment keys are only declared in media playlists).
 */
export function buildHlsManifest(
  top: ParsedPlaylist,
  firstVariant: ParsedMediaPlaylist | undefined,
  requestedUrl: string,
  requestContext: RequestContext,
): StreamingManifest {
  if (top.kind === 'media') {
    const manifest: StreamingManifest = {
      protocol: 'hls',
      requestedUrl,
      url: top.url,
      requestContext,
      isLive: top.isLive,
      drmSystems: top.keys.drmSystems,
      encryption: top.keys.encryption,
      variants: [
        { id: 'video-0', protocol: 'hls', codecs: [], audioOnly: false, audioTrackIds: [], hls: { playlistUrl: top.url } },
      ],
      audioTracks: [],
      childUrls: [],
      hls: { kind: 'media' },
    };
    if (!top.isLive) manifest.durationSec = top.durationSec;
    return manifest;
  }

  const keys = firstVariant ? mergeKeyScans(top.keys, firstVariant.keys) : top.keys;
  const childUrls = [
    ...top.variants.map((variant) => variant.hls?.playlistUrl),
    ...top.audioTracks.map((track) => track.hls?.playlistUrl),
    ...top.iFrameUrls,
  ].filter((url): url is string => url !== undefined);
  const manifest: StreamingManifest = {
    protocol: 'hls',
    requestedUrl,
    url: top.url,
    requestContext,
    isLive: firstVariant?.isLive ?? false,
    drmSystems: keys.drmSystems,
    encryption: keys.encryption,
    variants: top.variants,
    audioTracks: top.audioTracks,
    childUrls: [...new Set(childUrls)],
    hls: { kind: 'master' },
  };
  if (firstVariant && !firstVariant.isLive) manifest.durationSec = firstVariant.durationSec;
  return manifest;
}

/**
 * HTTP Live Streaming (RFC 8216).
 *
 * Playlists are fetched through the shared ManifestFetcher (request context,
 * size cap, timeout) and cached: identical requests during detection, the
 * popup and task start parse each playlist once. Live media playlists are
 * cached only for half a target duration.
 */
export class HlsAdapter implements StreamingProtocolAdapter {
  readonly protocol = 'hls' as const;
  readonly #fetcher: ManifestFetcher;
  readonly #cache: ManifestCache<ParsedPlaylist>;

  constructor(options: HlsAdapterOptions) {
    this.#fetcher = options.fetcher;
    const ttlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.#cache = new ManifestCache<ParsedPlaylist>({
      now: options.now ?? Date.now,
      maxEntries: options.maxCacheEntries ?? 64,
      ttlFor: (parsed) =>
        parsed.kind === 'media' && parsed.isLive ? Math.max(1000, (parsed.targetDuration ?? 2) * 500) : ttlMs,
      // Also reachable under its post-redirect URL (variants of a media-only manifest point there).
      aliasesFor: (parsed) => [parsed.url],
    });
  }

  canHandle(url: string, contentType?: string): boolean {
    const mime = classifyMimeType(contentType);
    if (mime === 'hls') return true;
    if (mime === 'dash') return false;
    const parsed = parseHttpUrl(url);
    return parsed !== null && protocolFromUrl(parsed)?.protocol === 'hls';
  }

  async parseManifest(url: string, options: ParseOptions = {}): Promise<StreamingManifest> {
    const context = options.context ?? {};
    const top = options.prefetched
      ? this.#cache.put(url, parseHlsPlaylist(options.prefetched.text, options.prefetched.finalUrl))
      : await this.#load(url, context, options.signal);

    let firstVariant: ParsedMediaPlaylist | undefined;
    if (top.kind === 'master' && top.keys.drmSystems.length === 0) {
      const first = top.variants.find((variant) => !variant.audioOnly) ?? top.variants[0];
      if (first?.hls) {
        try {
          const playlist = await this.#load(first.hls.playlistUrl, context, options.signal);
          if (playlist.kind === 'media') firstVariant = playlist;
        } catch (error) {
          if (isAbortError(error)) throw error;
          // The variant may need a context we do not have; the multivariant playlist alone is still useful.
        }
      }
    }
    return buildHlsManifest(top, firstVariant, url, context);
  }

  getAvailableVariants(manifest: StreamingManifest): Promise<VideoVariant[]> {
    return Promise.resolve([...manifest.variants].sort(compareVariants));
  }

  async getSegments(
    manifest: StreamingManifest,
    variant: VideoVariant,
    options: SegmentOptions = {},
  ): Promise<MediaSegment[]> {
    if (manifest.protocol !== 'hls') throw new StreamGrabError('Not an HLS manifest', 'UNSUPPORTED');
    this.#refuseDrm(manifest.drmSystems);
    const playlistUrl = variant.hls?.playlistUrl;
    if (playlistUrl === undefined || !manifest.variants.some((candidate) => candidate.id === variant.id)) {
      throw new StreamGrabError('Unknown variant for this manifest', 'UNSUPPORTED');
    }

    const context = manifest.requestContext;
    const main = await this.#loadMedia(playlistUrl, context, options.signal);
    const segments = toMediaSegments(main, { id: 'main', type: 'main' });
    if (!segments.some((segment) => segment.kind === 'media')) throw new StreamGrabError('Playlist has no segments', 'MANIFEST_INVALID');

    for (const trackId of options.audioTrackIds ?? this.#defaultAudioTracks(manifest, variant)) {
      const track = manifest.audioTracks.find((candidate) => candidate.id === trackId);
      if (!track || !variant.audioTrackIds.includes(trackId)) {
        throw new StreamGrabError(`Audio track ${trackId} does not belong to this variant`, 'UNSUPPORTED');
      }
      // No playlist: this audio is muxed into the variant's own segments.
      if (track.hls?.playlistUrl === undefined) continue;
      const audio = await this.#loadMedia(track.hls.playlistUrl, context, options.signal);
      segments.push(...toMediaSegments(audio, { id: track.id, type: 'audio' }));
    }
    return segments;
  }

  #defaultAudioTracks(manifest: StreamingManifest, variant: VideoVariant): string[] {
    const tracks = manifest.audioTracks.filter((track) => variant.audioTrackIds.includes(track.id));
    const preferred = tracks.find((track) => track.isDefault) ?? tracks[0];
    return preferred ? [preferred.id] : [];
  }

  /** Never hand out segments of DRM-protected content. */
  #refuseDrm(systems: readonly DrmSystem[]): void {
    if (systems.length > 0) throw new StreamGrabError(describeDrm(systems), 'DRM_PROTECTED');
  }

  async #loadMedia(url: string, context: RequestContext, signal: AbortSignal | undefined): Promise<ParsedMediaPlaylist> {
    const playlist = await this.#load(url, context, signal);
    if (playlist.kind !== 'media') throw new StreamGrabError('Expected a media playlist', 'MANIFEST_INVALID');
    this.#refuseDrm(playlist.keys.drmSystems);
    return playlist;
  }

  /** The shared request is not tied to one caller's signal; each caller can still stop waiting. */
  #load(url: string, context: RequestContext, signal: AbortSignal | undefined): Promise<ParsedPlaylist> {
    const playlist = this.#cache.get(url, async () => {
      const result = await this.#fetcher.fetchManifest(url, context);
      if (result.kind !== 'ok') throw fetchFailureError(result);
      if (result.protocol !== 'hls') throw new StreamGrabError('Expected an HLS playlist', 'MANIFEST_INVALID');
      return parseHlsPlaylist(result.text, result.finalUrl);
    });
    return raceAbort(playlist, signal);
  }
}
