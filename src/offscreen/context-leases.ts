import { raceAbort } from '@/core/protocols/manifest-cache';
import { parseHttpUrl } from '@/shared/utils/url';

/**
 * The engine's side of the request-context rules. The offscreen document has
 * no chrome.declarativeNetRequest; the service worker installs the rules. The
 * engine holds one lease per (task, host), taken on the first request to that
 * host and released when the task ends, so a download costs a handful of
 * messages, not two per segment.
 *
 * If the service worker restarts it drops every rule; it then asks the engine
 * to re-acquire (`reacquireAll`).
 */
export class ContextLeases {
  readonly #acquire: (taskId: string, url: string) => Promise<string | null>;
  readonly #release: (leaseId: string) => Promise<void>;
  /** taskId → host → lease ID (null: no context needed or acquisition failed). */
  readonly #leases = new Map<string, Map<string, Promise<string | null>>>();
  /** A sample URL per (task, host), to re-acquire with. */
  readonly #urls = new Map<string, Map<string, string>>();
  /** Lease requests that have been answered. */
  readonly #granted = new WeakSet<Promise<string | null>>();

  constructor(acquire: (taskId: string, url: string) => Promise<string | null>, release: (leaseId: string) => Promise<void>) {
    this.#acquire = acquire;
    this.#release = release;
  }

  /**
   * Makes sure the task's context applies to requests to `url`'s host. The
   * lease may queue behind another context's rule for that host; `signal`
   * stops this caller from waiting (the request itself stays queued and is
   * released by releaseTask once granted).
   */
  async ensure(taskId: string, url: string, signal?: AbortSignal): Promise<void> {
    const host = parseHttpUrl(url)?.hostname;
    if (!host) return;
    let hosts = this.#leases.get(taskId);
    if (!hosts) {
      hosts = new Map();
      this.#leases.set(taskId, hosts);
      this.#urls.set(taskId, new Map());
    }
    let lease = hosts.get(host);
    if (!lease) {
      lease = this.#track(this.#acquire(taskId, url).catch(() => null));
      hosts.set(host, lease);
      this.#urls.get(taskId)?.set(host, url);
    }
    await raceAbort(lease, signal);
  }

  /**
   * Releases the task's leases. Granted ones are released before this
   * resolves; ones still queued are released whenever they are granted, so a
   * cancelled task is not held up by another task's rule.
   */
  async releaseTask(taskId: string): Promise<void> {
    const hosts = this.#leases.get(taskId);
    this.#leases.delete(taskId);
    this.#urls.delete(taskId);
    if (!hosts) return;
    const releasedNow: Promise<void>[] = [];
    for (const lease of hosts.values()) {
      const released = lease.then(async (leaseId) => {
        if (leaseId !== null) await this.#release(leaseId).catch(() => undefined);
      });
      if (this.#granted.has(lease)) releasedNow.push(released);
    }
    await Promise.all(releasedNow);
  }

  /** The service worker lost its rules: acquire every held lease again. */
  async reacquireAll(): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const [taskId, hosts] of this.#leases) {
      for (const host of hosts.keys()) {
        const url = this.#urls.get(taskId)?.get(host);
        if (url === undefined) continue;
        const lease = this.#track(this.#acquire(taskId, url).catch(() => null));
        hosts.set(host, lease);
        work.push(lease);
      }
    }
    await Promise.all(work);
  }

  #track(lease: Promise<string | null>): Promise<string | null> {
    void lease.then(() => this.#granted.add(lease));
    return lease;
  }

  get taskCount(): number {
    return this.#leases.size;
  }
}
