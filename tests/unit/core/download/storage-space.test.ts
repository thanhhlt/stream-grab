import { describe, expect, it } from 'vitest';
import { DiskFullError, StorageWriteError } from '@/core/download/retry-policy';
import { diskFullMessage, freeBytesOf, SpaceGuard, storageFailure } from '@/core/download/storage-space';

const MB = 1024 * 1024;

/** An estimate whose free space the test sets; counts how often the browser is asked. */
function disk(freeMb: number) {
  const state = { free: freeMb * MB, calls: 0, fail: false };
  const estimate = () => {
    state.calls += 1;
    if (state.fail) return Promise.reject(new Error('unavailable'));
    return Promise.resolve({ usage: 500 * MB, quota: 500 * MB + state.free });
  };
  return { state, estimate };
}

describe('storage space', () => {
  it('reads free space from an estimate, or nothing when the browser does not say', () => {
    expect(freeBytesOf({ usage: 10, quota: 110 })).toBe(100);
    expect(freeBytesOf({ usage: 200, quota: 100 })).toBe(0);
    expect(freeBytesOf({ usage: 10 })).toBeUndefined();
    expect(freeBytesOf({})).toBeUndefined();
  });

  it('turns quota errors into a disk-full error and other write errors into storage errors', () => {
    const full = storageFailure(new DOMException('full', 'QuotaExceededError'));
    expect(full).toBeInstanceOf(DiskFullError);
    expect(full.message).toBe(diskFullMessage());
    const other = storageFailure(new DOMException('broken', 'UnknownError'));
    expect(other).toBeInstanceOf(StorageWriteError);
    expect(other).not.toBeInstanceOf(DiskFullError);
    expect(other.message).toBe('Could not store a segment: broken');
    expect(diskFullMessage(90 * MB)).toBe(
      'Not enough disk space to continue (90.0 MB free). Free up disk space, then press Retry: the download continues where it stopped.',
    );
  });

  it('stops while the reserve is still free', async () => {
    const { state, estimate } = disk(300);
    const guard = new SpaceGuard(estimate, { reserveBytes: 256 * MB, recheckBytes: 1000 * MB, maxAgeMs: 60_000 });
    await expect(guard.check(true)).resolves.toBeUndefined();
    // Written locally since the estimate: 300 − 50 = 250 MB < 256 MB, without asking the browser again.
    guard.written(50 * MB);
    await expect(guard.check()).rejects.toThrow(new DiskFullError(diskFullMessage(250 * MB)));
    expect(state.calls).toBe(1);
  });

  it('asks the browser again after enough writes or time, sharing one request', async () => {
    let now = 0;
    const { state, estimate } = disk(10_000);
    const guard = new SpaceGuard(estimate, { reserveBytes: MB, recheckBytes: 64 * MB, maxAgeMs: 15_000, now: () => now });
    await Promise.all([guard.check(), guard.check(), guard.check()]);
    expect(state.calls).toBe(1);
    guard.written(10 * MB);
    await guard.check();
    expect(state.calls).toBe(1);
    guard.written(60 * MB);
    await guard.check();
    expect(state.calls).toBe(2);
    now += 15_000;
    await guard.check();
    expect(state.calls).toBe(3);
    // Something else filled the disk meanwhile.
    state.free = 0;
    expect(await guard.isLow()).toBe(true);
  });

  it('never blocks downloads when free space is unknown', async () => {
    const { state, estimate } = disk(0);
    state.fail = true;
    const guard = new SpaceGuard(estimate);
    await expect(guard.check(true)).resolves.toBeUndefined();
    expect(await guard.isLow()).toBe(false);
    await expect(new SpaceGuard(undefined).check(true)).resolves.toBeUndefined();
  });
});
