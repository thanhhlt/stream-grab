import type { DownloadManager } from '@/core/download/download-manager';
import type { MediaManager } from '@/core/media/media-manager';
import type { EngineWork } from '@/core/models/download-task';

/**
 * The offscreen engine as the service worker drives it: downloads and media
 * jobs, converging on the work list it is given. Kept free of chrome.* so the
 * coordinator can drive the same object in tests.
 */
export class Engine {
  readonly #downloads: DownloadManager;
  readonly #media: MediaManager;

  constructor(downloads: DownloadManager, media: MediaManager) {
    this.#downloads = downloads;
    this.#media = media;
  }

  /** Runs exactly this work; answers once whatever it stopped has cleaned up. Returns the running task IDs. */
  async sync(work: EngineWork): Promise<string[]> {
    const [downloads, media] = await Promise.all([this.#downloads.syncSettled(work.downloads), this.#media.syncSettled(work.media)]);
    return [...downloads, ...media];
  }

  /** Cancels these tasks whatever they are doing; their data is deleted. */
  async cancel(taskIds: readonly string[]): Promise<void> {
    await Promise.all([this.#downloads.cancel(taskIds), this.#media.cancel(taskIds)]);
  }

  get running(): string[] {
    return [...this.#downloads.running, ...this.#media.running];
  }
}
