import { isPageSubtitleId, PROGRESSIVE_VARIANT_ID, type DetectedStream } from '@/core/models/detected-stream';
import {
  ACTIVE_TASK_STATUSES,
  type DownloadRequest,
  type DownloadTask,
  type TaskSubtitle,
} from '@/core/models/download-task';
import type { StreamingManifest } from '@/core/models/streaming-manifest';
import type { VideoVariant } from '@/core/models/video-variant';
import { describeDrm } from '@/core/protocols/drm';
import type { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import type { Settings } from '@/shared/settings/settings';
import { errorMessage } from '@/shared/utils/errors';
import { isRecord } from '@/shared/utils/guards';
import { dedupeKey, fileNameOf } from '@/shared/utils/url';
import { defaultBaseName, sanitizeBaseName, uniqueBaseName } from './file-name';
import { variantLabel } from './labels';
import type { TaskStore } from './task-store';
import { matchVariant } from './variant-choice';

export interface StartDownloadsResult {
  created: { taskId: string; streamId: string; baseName: string }[];
  failed: { streamId: string; message: string }[];
}

export interface TaskServiceDeps {
  store: TaskStore;
  getStream(tabId: number, streamId: string): Promise<DetectedStream | undefined>;
  protocols: ProtocolRegistry;
  getSettings(): Promise<Settings>;
  now?: () => number;
  newId?: () => string;
}

export const MAX_REQUESTS_PER_CALL = 50;

/** Validates a `downloads/start` payload from the popup; anything malformed is dropped. */
export function parseDownloadRequests(raw: unknown): DownloadRequest[] {
  if (!isRecord(raw) || !Array.isArray(raw['requests'])) return [];
  const requests: DownloadRequest[] = [];
  for (const item of raw['requests'].slice(0, MAX_REQUESTS_PER_CALL)) {
    if (!isRecord(item)) continue;
    const { tabId, streamId, variantId, audioTrackIds, subtitleTrackIds, fileName } = item;
    if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 0) continue;
    if (typeof streamId !== 'string' || streamId.length === 0 || streamId.length > 64) continue;
    if (typeof variantId !== 'string' || variantId.length === 0 || variantId.length > 64) continue;
    if (!Array.isArray(audioTrackIds) || audioTrackIds.length > 20) continue;
    if (!audioTrackIds.every((id): id is string => typeof id === 'string' && id.length <= 64)) continue;
    if (typeof fileName !== 'string' || fileName.length > 500) continue;
    if (subtitleTrackIds !== undefined && !isIdList(subtitleTrackIds)) continue;
    const request: DownloadRequest = { tabId, streamId, variantId, audioTrackIds, fileName };
    if (subtitleTrackIds !== undefined && subtitleTrackIds.length > 0) request.subtitleTrackIds = [...new Set(subtitleTrackIds)];
    requests.push(request);
  }
  return requests;
}

class RequestError extends Error {}

function isIdList(raw: unknown): raw is string[] {
  return Array.isArray(raw) && raw.length <= 20 && raw.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64);
}

/** The requested subtitle tracks, in request order; each must be offered for the chosen quality. */
function chosenSubtitles(ids: readonly string[] | undefined, offered: readonly TaskSubtitle[], variantIds: readonly string[]): TaskSubtitle[] {
  return (ids ?? []).map((id) => {
    const track = offered.find((candidate) => candidate.id === id);
    if (!track || !variantIds.includes(id)) throw new RequestError('The selected subtitles are no longer offered for this quality.');
    return track;
  });
}


/**
 * Turns the popup's download requests into queued tasks.
 *
 * Every request is checked against the stream's current manifest (parsed by
 * its protocol adapter, normally from cache): the quality and audio tracks
 * must still exist, and DRM-protected or live streams are refused with a
 * reason. Each request succeeds or fails on its own. Execution of queued
 * tasks is the download manager's job (Phase 6).
 */
export class TaskService {
  readonly #deps: TaskServiceDeps;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(deps: TaskServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#newId = deps.newId ?? (() => crypto.randomUUID());
  }

  async start(requests: readonly DownloadRequest[]): Promise<StartDownloadsResult> {
    const result: StartDownloadsResult = { created: [], failed: [] };
    if (requests.length === 0) return result;
    const settings = await this.#deps.getSettings();
    const existing = await this.#deps.store.list();
    // Active tasks plus those created in this batch: names stay unique, duplicates are refused.
    const active = existing.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status));
    const taken = new Set(active.map((task) => task.output.baseName));

    const entries: Parameters<TaskStore['add']>[0][number][] = [];
    for (const request of requests) {
      try {
        const { task, context } = await this.#prepare(request, settings, taken, active);
        taken.add(task.output.baseName);
        active.push(task);
        entries.push({ task, context });
        result.created.push({ taskId: task.id, streamId: request.streamId, baseName: task.output.baseName });
      } catch (error) {
        result.failed.push({ streamId: request.streamId, message: errorMessage(error) });
      }
    }
    if (entries.length > 0) await this.#deps.store.add(entries);
    return result;
  }

  /** Removes tasks that are not running; running ones must be cancelled first. Returns the removed IDs. */
  async remove(taskIds: readonly string[]): Promise<string[]> {
    const tasks = await this.#deps.store.list();
    const removable = tasks
      .filter((task) => taskIds.includes(task.id) && task.status !== 'downloading' && task.status !== 'processing')
      .map((task) => task.id);
    if (removable.length > 0) await this.#deps.store.remove(removable);
    return removable;
  }

  async #prepare(
    request: DownloadRequest,
    settings: Settings,
    taken: ReadonlySet<string>,
    active: readonly DownloadTask[],
  ) {
    const stream = await this.#deps.getStream(request.tabId, request.streamId);
    if (!stream) throw new RequestError('This video is no longer listed. Reload the page and play it again.');
    switch (stream.status) {
      case 'pending':
        throw new RequestError('This stream is still being inspected. Try again in a moment.');
      case 'drm':
        throw new RequestError(stream.statusMessage ?? 'DRM-protected streams are not supported.');
      case 'error':
        throw new RequestError(stream.statusMessage ?? 'This stream is not available.');
      case 'ready':
        break;
    }
    if (stream.manifest?.live) throw new RequestError('Live streams cannot be downloaded yet.');
    if (stream.protocol === 'progressive') return this.#prepareFile(request, stream, settings, taken, active);

    const adapter = this.#deps.protocols.forProtocol(stream.protocol);
    if (!adapter) throw new RequestError(`${stream.protocol.toUpperCase()} is not supported.`);
    const manifest = await adapter.parseManifest(stream.url, { context: stream.requestContext });
    if (manifest.drmSystems.length > 0) throw new RequestError(describeDrm(manifest.drmSystems));
    if (manifest.isLive) throw new RequestError('Live streams cannot be downloaded yet.');
    if (manifest.encryption === 'sample-aes') throw new RequestError('SAMPLE-AES encrypted streams are not supported yet.');

    const variant = this.#findVariant(manifest, stream, request.variantId);
    const audioTracks = request.audioTrackIds.map((id) => {
      const track = manifest.audioTracks.find((candidate) => candidate.id === id);
      if (!track || !variant.audioTrackIds.includes(id)) {
        throw new RequestError('The selected audio track is no longer offered for this quality.');
      }
      return track;
    });
    // The page's own WebVTT files (0.7.2) come from detection: the manifest does not name them.
    const pageSubtitles = (stream.media?.subtitleTracks ?? []).filter((track) => isPageSubtitleId(track.id) && track.url !== undefined);
    const subtitles = chosenSubtitles(
      request.subtitleTrackIds,
      [...(manifest.subtitleTracks ?? []), ...pageSubtitles].map((track) => taskSubtitle(track)),
      [...(variant.subtitleTrackIds ?? []), ...pageSubtitles.map((track) => track.id)],
    );

    const label = variantLabel(variant);
    const title = stream.title ?? (fileNameOf(stream.url) || 'video');
    const wanted = request.fileName.trim() === '' ? defaultBaseName(title, label) : sanitizeBaseName(request.fileName);
    const now = this.#now();
    const task: DownloadTask = {
      id: this.#newId(),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      source: {
        protocol: stream.protocol,
        manifestUrl: stream.url,
        title,
        tabId: stream.tabId,
        streamId: stream.id,
      },
      selection: {
        variantId: variant.id,
        variantLabel: label,
        audioTrackIds: audioTracks.map((track) => track.id),
        audioTrackNames: audioTracks.map((track) => track.name),
      },
      output: { baseName: uniqueBaseName(wanted, taken), format: settings.outputFormat },
    };
    if (stream.pageUrl !== undefined) task.source.pageUrl = stream.pageUrl;
    if (variant.width !== undefined) task.selection.width = variant.width;
    if (variant.height !== undefined) task.selection.height = variant.height;
    if (variant.bandwidth !== undefined) task.selection.bandwidth = variant.bandwidth;
    if (manifest.durationSec !== undefined) task.selection.durationSec = manifest.durationSec;
    if (subtitles.length > 0) {
      task.selection.subtitles = subtitles;
      task.output.subtitleFormat = settings.subtitleFormat;
      task.output.subtitleMode = settings.subtitleMode;
    }
    if (active.some((other) => isSameDownload(other, task))) {
      throw new RequestError('This video is already in the queue with the same quality and audio.');
    }
    return { task, context: stream.requestContext };
  }

  /**
   * A progressive file (MP4/WebM, 0.3.0): there is no manifest to read again,
   * the detection describes the file. One "quality" (the file itself), no
   * audio tracks; it is saved in its own container, whatever the output format.
   */
  #prepareFile(
    request: DownloadRequest,
    stream: DetectedStream,
    settings: Settings,
    taken: ReadonlySet<string>,
    active: readonly DownloadTask[],
  ): { task: DownloadTask; context: DetectedStream['requestContext'] } {
    const file = stream.progressive;
    if (!file) throw new RequestError('This video is not available.');
    if (request.variantId !== PROGRESSIVE_VARIANT_ID || request.audioTrackIds.length > 0) {
      throw new RequestError('The selected quality is no longer offered. Reopen the list and choose again.');
    }
    const subtitles = chosenSubtitles(
      request.subtitleTrackIds,
      (stream.media?.subtitleTracks ?? []).filter((track) => track.url !== undefined).map((track) => taskSubtitle(track)),
      stream.media?.variants.find((variant) => variant.id === PROGRESSIVE_VARIANT_ID)?.subtitleTrackIds ?? [],
    );
    const title = stream.title ?? (fileNameOf(stream.url) || 'video');
    const wanted = request.fileName.trim() === '' ? defaultBaseName(title) : sanitizeBaseName(request.fileName);
    const now = this.#now();
    const task: DownloadTask = {
      id: this.#newId(),
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      source: { protocol: 'progressive', manifestUrl: stream.url, title, tabId: stream.tabId, streamId: stream.id },
      selection: { variantId: PROGRESSIVE_VARIANT_ID, variantLabel: variantLabel({ audioOnly: false }), audioTrackIds: [], audioTrackNames: [] },
      output: { baseName: uniqueBaseName(wanted, taken), format: settings.outputFormat },
      progressive: { container: file.container, fetch: 'browser', ...(file.bytes !== undefined ? { bytes: file.bytes } : {}) },
    };
    if (stream.pageUrl !== undefined) task.source.pageUrl = stream.pageUrl;
    if (stream.durationHint !== undefined) task.selection.durationSec = stream.durationHint;
    if (subtitles.length > 0) {
      task.selection.subtitles = subtitles;
      task.output.subtitleFormat = settings.subtitleFormat;
    }
    if (active.some((other) => isSameDownload(other, task))) {
      throw new RequestError('This video is already in the queue with the same quality and audio.');
    }
    return { task, context: stream.requestContext };
  }

  /** The variant the popup listed under `variantId`, matched in the current manifest. */
  #findVariant(manifest: StreamingManifest, stream: DetectedStream, variantId: string): VideoVariant {
    const listed = stream.media?.variants.find((variant) => variant.id === variantId);
    const variant = matchVariant(manifest.variants, { id: variantId, height: listed?.height, bandwidth: listed?.bandwidth });
    if (!variant) throw new RequestError('The selected quality is no longer offered. Reopen the list and choose again.');
    return variant;
  }
}

function taskSubtitle(track: { id: string; name: string; language?: string; forced?: boolean; url?: string; offsetSec?: number }): TaskSubtitle {
  const subtitle: TaskSubtitle = { id: track.id, name: track.name };
  if (track.language !== undefined) subtitle.language = track.language;
  if (track.forced === true) subtitle.forced = true;
  if (track.url !== undefined) subtitle.url = track.url;
  if (track.url !== undefined && track.offsetSec !== undefined) subtitle.offsetSec = track.offsetSec;
  return subtitle;
}

/** Same video (manifest without tokens), same quality, same audio tracks; subtitles do not change the video file. */
function isSameDownload(a: DownloadTask, b: DownloadTask): boolean {
  const tracks = (task: DownloadTask) => [...task.selection.audioTrackIds].sort().join(',');
  return (
    dedupeKey(a.source.manifestUrl) === dedupeKey(b.source.manifestUrl) &&
    a.selection.variantId === b.selection.variantId &&
    tracks(a) === tracks(b)
  );
}
