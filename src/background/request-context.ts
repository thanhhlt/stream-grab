import {
  isEmptyRequestContext,
  requestContextKey,
  type RequestContext,
} from '@/core/models/detected-stream';
import { parseHttpUrl } from '@/shared/utils/url';

/**
 * Controlled reuse of the page's request context.
 *
 * Extension requests do not carry the page's Referer or Origin, and `fetch`
 * cannot set them (forbidden headers). Many CDNs check them (hotlink
 * protection, CORS allow-lists). We capture exactly these two headers from the
 * page's own manifest request and, while the extension fetches from that host,
 * install a declarativeNetRequest session rule that sets them, scoped to
 * requests initiated by this extension outside any tab.
 *
 * Deliberately not captured: Cookie (the browser attaches cookies to extension
 * requests itself), Authorization and other credentials.
 */

export interface HeaderLike {
  name: string;
  value?: string | undefined;
}

/** Extracts the allow-listed headers from a request's headers. */
export function pickRequestContext(headers: readonly HeaderLike[] | undefined): RequestContext {
  const context: RequestContext = {};
  for (const header of headers ?? []) {
    const name = header.name.toLowerCase();
    const value = header.value?.trim();
    if (!value || value.length > 4096) continue;
    if (name === 'referer' && parseHttpUrl(value)) context.referer = value;
    // Opaque origins ("null") cannot be replayed meaningfully.
    if (name === 'origin' && value !== 'null' && parseHttpUrl(value)) context.origin = value;
  }
  return context;
}

/** The subset of chrome.declarativeNetRequest used here (injectable for tests). */
export interface SessionRulesApi {
  getSessionRules(): Promise<chrome.declarativeNetRequest.Rule[]>;
  updateSessionRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void>;
}

export type ReleaseContext = () => Promise<void>;

interface HostRule {
  ruleId: number;
  key: string;
  refs: number;
  installed: Promise<void>;
  /** Resolves once the rule has been removed and the host is free for another context. */
  removed: Promise<void>;
  markRemoved: () => void;
}

const noRelease: ReleaseContext = () => Promise.resolve();
const TAB_ID_NONE = -1;

/**
 * Reference-counted DNR session rules, one per host. Callers that need the same
 * context on a host share a rule; a caller with a different context waits until
 * the current rule is released, so two contexts never apply to one host at once.
 */
export class RequestContextRules {
  readonly #api: SessionRulesApi;
  readonly #extensionId: string;
  readonly #hosts = new Map<string, HostRule>();
  #nextRuleId = 1;
  #ready: Promise<void> | undefined;

  constructor(api: SessionRulesApi, extensionId: string) {
    this.#api = api;
    this.#extensionId = extensionId;
  }

  /**
   * Removes session rules left over from a previous service-worker instance.
   * Rules are only held for the duration of a fetch, so none can still be in use.
   */
  initialize(): Promise<void> {
    this.#ready ??= (async () => {
      const existing = await this.#api.getSessionRules();
      if (existing.length > 0) {
        await this.#api.updateSessionRules({ removeRuleIds: existing.map((rule) => rule.id) });
      }
      this.#nextRuleId = 1;
    })();
    return this.#ready;
  }

  async acquire(url: string, context: RequestContext): Promise<ReleaseContext> {
    if (isEmptyRequestContext(context)) return noRelease;
    const host = parseHttpUrl(url)?.hostname;
    if (!host) return noRelease;
    await this.initialize();
    const key = requestContextKey(context);

    for (;;) {
      const current = this.#hosts.get(host);
      if (!current) return this.#install(host, key, context);
      if (current.key !== key) {
        await current.removed;
        continue;
      }
      try {
        await current.installed;
      } catch {
        continue; // the installing caller failed and cleared the entry; retry
      }
      if (this.#hosts.get(host) !== current) continue;
      current.refs += 1;
      return this.#releaser(host, current);
    }
  }

  /** Number of hosts with an active rule (diagnostics and tests). */
  get activeHosts(): number {
    return this.#hosts.size;
  }

  async #install(host: string, key: string, context: RequestContext): Promise<ReleaseContext> {
    let markRemoved: () => void = () => undefined;
    const removed = new Promise<void>((resolve) => {
      markRemoved = resolve;
    });
    const entry: HostRule = {
      ruleId: this.#nextRuleId++,
      key,
      refs: 1,
      installed: Promise.resolve(),
      removed,
      markRemoved,
    };
    entry.installed = this.#api.updateSessionRules({ addRules: [this.#rule(entry.ruleId, host, context)] });
    this.#hosts.set(host, entry);
    try {
      await entry.installed;
    } catch (error) {
      this.#hosts.delete(host);
      entry.markRemoved();
      throw error;
    }
    return this.#releaser(host, entry);
  }

  #releaser(host: string, entry: HostRule): ReleaseContext {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs > 0) return;
      this.#hosts.delete(host);
      try {
        await this.#api.updateSessionRules({ removeRuleIds: [entry.ruleId] });
      } finally {
        entry.markRemoved();
      }
    };
  }

  #rule(id: number, host: string, context: RequestContext): chrome.declarativeNetRequest.Rule {
    const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
    if (context.referer !== undefined) requestHeaders.push({ header: 'referer', operation: 'set', value: context.referer });
    if (context.origin !== undefined) requestHeaders.push({ header: 'origin', operation: 'set', value: context.origin });
    return {
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: {
        requestDomains: [host],
        initiatorDomains: [this.#extensionId],
        tabIds: [TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest'],
      },
    };
  }
}
