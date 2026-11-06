import { describe, expect, it, vi } from 'vitest';
import { pickRequestContext, RequestContextRules, type SessionRulesApi } from '@/background/request-context';

type Rule = chrome.declarativeNetRequest.Rule;

class FakeRulesApi implements SessionRulesApi {
  rules = new Map<number, Rule>();
  log: string[] = [];

  getSessionRules(): Promise<Rule[]> {
    return Promise.resolve([...this.rules.values()]);
  }

  async updateSessionRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void> {
    await Promise.resolve();
    for (const id of options.removeRuleIds ?? []) {
      this.rules.delete(id);
      this.log.push(`remove ${id}`);
    }
    for (const rule of options.addRules ?? []) {
      if (this.rules.has(rule.id)) throw new Error(`Rule with id ${rule.id} already exists`);
      this.rules.set(rule.id, rule);
      this.log.push(`add ${rule.id}`);
    }
  }
}

const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const referer = { referer: 'https://site.example/watch?v=1' };

describe('pickRequestContext', () => {
  it('keeps only Referer and Origin, case-insensitively', () => {
    expect(
      pickRequestContext([
        { name: 'Referer', value: 'https://site.example/watch?v=1' },
        { name: 'ORIGIN', value: 'https://site.example' },
        { name: 'Cookie', value: 'session=secret' },
        { name: 'Authorization', value: 'Bearer secret' },
        { name: 'User-Agent', value: 'x' },
      ]),
    ).toEqual({ referer: 'https://site.example/watch?v=1', origin: 'https://site.example' });
  });

  it('skips opaque origins, non-http values and missing headers', () => {
    expect(pickRequestContext([{ name: 'Origin', value: 'null' }, { name: 'Referer', value: 'android-app://x' }])).toEqual({});
    expect(pickRequestContext(undefined)).toEqual({});
  });
});

describe('RequestContextRules', () => {
  it('removes rules left by a previous worker instance on initialisation', async () => {
    const api = new FakeRulesApi();
    api.rules.set(7, { id: 7, action: { type: 'block' }, condition: {} });
    await new RequestContextRules(api, EXTENSION_ID).initialize();
    expect(api.rules.size).toBe(0);
  });

  it('installs a rule scoped to the host and to requests made by the extension outside tabs', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const release = await rules.acquire('https://cdn.example.com/a.m3u8?token=1', {
      ...referer,
      origin: 'https://site.example',
    });
    expect([...api.rules.values()]).toEqual([
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: 'https://site.example/watch?v=1' },
            { header: 'origin', operation: 'set', value: 'https://site.example' },
          ],
        },
        condition: {
          requestDomains: ['cdn.example.com'],
          initiatorDomains: [EXTENSION_ID],
          tabIds: [-1],
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ]);
    await release();
    expect(api.rules.size).toBe(0);
    expect(rules.activeHosts).toBe(0);
  });

  it('installs nothing for an empty context', async () => {
    const api = new FakeRulesApi();
    const release = await new RequestContextRules(api, EXTENSION_ID).acquire('https://cdn.example.com/a', {});
    await release();
    expect(api.log).toEqual([]);
  });

  it('shares one rule between callers with the same context and removes it after the last release', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const [a, b] = await Promise.all([
      rules.acquire('https://cdn.example.com/a.m3u8', referer),
      rules.acquire('https://cdn.example.com/b.m3u8', referer),
    ]);
    expect(api.rules.size).toBe(1);
    await a();
    await a(); // releasing twice is harmless
    expect(api.rules.size).toBe(1);
    await b();
    expect(api.rules.size).toBe(0);
  });

  it('makes a different context on the same host wait until the current one is released', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    const first = await rules.acquire('https://cdn.example.com/a', referer);
    let secondAcquired = false;
    const second = rules.acquire('https://cdn.example.com/b', { referer: 'https://other.example/' }).then((release) => {
      secondAcquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondAcquired).toBe(false);

    await first();
    const releaseSecond = await second;
    expect([...api.rules.values()][0]?.action.requestHeaders?.[0]?.value).toBe('https://other.example/');
    await releaseSecond();
    expect(api.log).toEqual(['add 1', 'remove 1', 'add 2', 'remove 2']);
  });

  it('keeps different hosts independent', async () => {
    const api = new FakeRulesApi();
    const rules = new RequestContextRules(api, EXTENSION_ID);
    await rules.acquire('https://a.example/x', referer);
    await rules.acquire('https://b.example/x', { referer: 'https://other.example/' });
    expect(api.rules.size).toBe(2);
  });

  it('frees the host when installing the rule fails', async () => {
    const api = new FakeRulesApi();
    const update = vi.spyOn(api, 'updateSessionRules').mockRejectedValueOnce(new Error('quota'));
    const rules = new RequestContextRules(api, EXTENSION_ID);
    await rules.initialize();
    await expect(rules.acquire('https://a.example/x', referer)).rejects.toThrow('quota');
    update.mockRestore();
    const release = await rules.acquire('https://a.example/x', referer);
    expect(api.rules.size).toBe(1);
    await release();
  });
});
