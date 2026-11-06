import { describe, expect, it } from 'vitest';
import { parseRunRequest, parseWorkerEvent } from '@/core/media/ffmpeg-protocol';

const data = new Blob(['abc']);
const job = { tool: 'ffprobe', args: ['-i', '/in/a.ts'], inputs: [{ name: 'a.ts', data }], outputs: [] };

describe('parseRunRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseRunRequest({ type: 'run', id: 3, coreUrl: 'chrome-extension://x/ffmpeg/ffmpeg-core.js', job, timeoutMs: 1000 })).toEqual({
      type: 'run',
      id: 3,
      coreUrl: 'chrome-extension://x/ffmpeg/ffmpeg-core.js',
      job,
      timeoutMs: 1000,
    });
  });

  it('rejects malformed requests', () => {
    expect(parseRunRequest(null)).toBeNull();
    expect(parseRunRequest({ type: 'run', id: -1, coreUrl: 'x', job })).toBeNull();
    expect(parseRunRequest({ type: 'run', id: 1, coreUrl: 'x', job: { ...job, tool: 'sh' } })).toBeNull();
    expect(parseRunRequest({ type: 'run', id: 1, coreUrl: 'x', job: { ...job, inputs: [{ name: 'a.ts', data: 'bytes' }] } })).toBeNull();
    expect(parseRunRequest({ type: 'run', id: 1, coreUrl: 'x', job: { ...job, args: [1, 2] } })).toBeNull();
  });
});

describe('parseWorkerEvent', () => {
  it('accepts every event type', () => {
    const result = { exitCode: 0, stdout: '', stderrTail: ['x'], outputs: [{ name: 'out.mp4', data }], runMs: 5 };
    expect(parseWorkerEvent({ type: 'started', id: 1, loadMs: 900 })).toEqual({ type: 'started', id: 1, loadMs: 900 });
    expect(parseWorkerEvent({ type: 'progress', id: 1, seconds: 2.5 })).toEqual({ type: 'progress', id: 1, seconds: 2.5 });
    expect(parseWorkerEvent({ type: 'done', id: 1, result })).toEqual({ type: 'done', id: 1, result });
    expect(parseWorkerEvent({ type: 'done', id: 1, result: { ...result, exitCode: undefined } })).toMatchObject({ result: { exitCode: undefined } });
    expect(parseWorkerEvent({ type: 'failed', id: 1, error: { kind: 'memory', message: 'm' } })).toEqual({
      type: 'failed',
      id: 1,
      error: { kind: 'memory', message: 'm' },
    });
  });

  it('rejects malformed events', () => {
    expect(parseWorkerEvent({ type: 'started', id: 1 })).toBeNull();
    expect(parseWorkerEvent({ type: 'done', id: 1, result: { stdout: 1 } })).toBeNull();
    expect(parseWorkerEvent({ type: 'failed', id: 1, error: { kind: 'oops', message: 'm' } })).toBeNull();
    expect(parseWorkerEvent({ type: 'log', id: 1 })).toBeNull();
  });
});
