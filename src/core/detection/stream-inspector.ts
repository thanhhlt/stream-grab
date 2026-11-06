import type { ProgressiveInfo, RequestContext } from '@/core/models/detected-stream';
import { describeFetchFailure, type ManifestFetcher } from '@/core/network/manifest-fetcher';
import type { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { errorMessage, StreamGrabError } from '@/shared/utils/errors';
import { manifestInfoFrom, type ManifestInfo } from './manifest-inspector';

/**
 * - `manifest`:     an HLS/DASH manifest, parsed
 * - `progressive`:  a whole MP4/WebM file (core/detection/file-inspector.ts)
 * - `not-manifest`: not what the URL looked like (not a manifest; for a media
 *                   file: a segment of a stream or not MP4/WebM): not listed
 * - `failed`:       could not be inspected (HTTP error, timeout, a web page instead of a video)
 */
export type InspectionOutcome =
  | { kind: 'manifest'; info: ManifestInfo; finalUrl: string }
  | { kind: 'progressive'; info: ProgressiveInfo; finalUrl: string }
  | { kind: 'not-manifest'; reason: string }
  | { kind: 'failed'; reason: string };

/** What an inspection checks: a manifest (protocol found from its body) or a progressive media file. */
export type InspectionKind = 'manifest' | 'progressive';

export interface InspectorDeps {
  fetcher: ManifestFetcher;
  protocols: ProtocolRegistry;
}

/**
 * Fetches a candidate once, confirms its protocol from the body, and parses it
 * with that protocol's adapter. The adapter reuses the downloaded body and
 * caches what it fetches, so starting a download later does not parse again.
 */
export async function inspectStream(
  deps: InspectorDeps,
  url: string,
  context: RequestContext,
  signal?: AbortSignal,
): Promise<InspectionOutcome> {
  const result = await deps.fetcher.fetchManifest(url, context, signal);
  if (result.kind === 'not-manifest' || result.kind === 'too-large') {
    return { kind: 'not-manifest', reason: describeFetchFailure(result) };
  }
  if (result.kind !== 'ok') return { kind: 'failed', reason: describeFetchFailure(result) };

  const adapter = deps.protocols.forProtocol(result.protocol);
  if (!adapter) return { kind: 'not-manifest', reason: `No adapter for ${result.protocol}` };
  try {
    const manifest = await adapter.parseManifest(url, {
      context,
      prefetched: { text: result.text, finalUrl: result.finalUrl },
      ...(signal ? { signal } : {}),
    });
    return { kind: 'manifest', info: manifestInfoFrom(manifest), finalUrl: result.finalUrl };
  } catch (error) {
    if (error instanceof StreamGrabError && error.code === 'MANIFEST_INVALID') {
      return { kind: 'not-manifest', reason: error.message };
    }
    return { kind: 'failed', reason: errorMessage(error) };
  }
}
