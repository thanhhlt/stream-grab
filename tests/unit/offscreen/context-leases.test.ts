import { describe, expect, it, vi } from 'vitest';
import { ContextLeases } from '@/offscreen/context-leases';

describe('ContextLeases', () => {
  it('acquires once per (task, host), releases at task end and re-acquires after a worker restart', async () => {
    let n = 0;
    const acquire = vi.fn((_taskId: string, _url: string) => Promise.resolve(`lease-${++n}`));
    const release = vi.fn((_leaseId: string) => Promise.resolve());
    const leases = new ContextLeases(acquire, release);

    await Promise.all([
      leases.ensure('t1', 'https://cdn.example.com/a.ts'),
      leases.ensure('t1', 'https://cdn.example.com/b.ts'),
      leases.ensure('t1', 'https://cdn2.example.com/c.ts'),
      leases.ensure('t2', 'https://cdn.example.com/a.ts'),
    ]);
    expect(acquire.mock.calls.map(([task, url]) => `${task} ${new URL(url).host}`)).toEqual([
      't1 cdn.example.com',
      't1 cdn2.example.com',
      't2 cdn.example.com',
    ]);

    await leases.reacquireAll();
    expect(acquire).toHaveBeenCalledTimes(6);

    await leases.releaseTask('t1');
    expect(release.mock.calls.map(([id]) => id).sort()).toEqual(['lease-4', 'lease-5']);
    expect(leases.taskCount).toBe(1);
  });

  it('lets a cancelled task stop waiting for a busy host and releases that lease once granted', async () => {
    let grant: (leaseId: string) => void = () => undefined;
    const acquire = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          grant = resolve;
        }),
    );
    const release = vi.fn((_leaseId: string) => Promise.resolve());
    const leases = new ContextLeases(acquire, release);

    const controller = new AbortController();
    const waiting = leases.ensure('t1', 'https://cdn.example.com/a.ts', controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    // The task ends while its lease is still queued: releasing does not wait for the grant…
    await leases.releaseTask('t1');
    expect(release).not.toHaveBeenCalled();
    // …and the lease is handed back as soon as it arrives.
    grant('late-lease');
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledWith('late-lease');
    });
  });

  it('does not fail requests when no rule is needed or acquisition fails', async () => {
    const leases = new ContextLeases(
      (_taskId, url) => (url.includes('fail') ? Promise.reject(new Error('worker gone')) : Promise.resolve(null)),
      () => Promise.reject(new Error('should not be called')),
    );
    await leases.ensure('t', 'https://cdn.example.com/a.ts');
    await leases.ensure('t', 'https://fail.example.com/a.ts');
    await leases.ensure('t', 'not a url');
    await expect(leases.releaseTask('t')).resolves.toBeUndefined();
  });
});
