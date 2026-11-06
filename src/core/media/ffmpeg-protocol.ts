import { isOneOf, isRecord } from '@/shared/utils/guards';
import { FFMPEG_ERROR_KINDS, type FfmpegErrorKind, type FfmpegJob, type FfmpegOutput, type FfmpegRunResult } from './ffmpeg-job';

/**
 * Messages between the offscreen document (FfmpegService) and the media
 * worker (MediaWorkerHost). Both ends are extension code; shapes are still
 * checked, since types do not cross the thread boundary.
 */

/** Offscreen document → worker. `coreUrl` is ffmpeg-core.js inside the extension package. */
export interface RunRequest {
  type: 'run';
  id: number;
  coreUrl: string;
  job: FfmpegJob;
  timeoutMs?: number;
}

export interface SerializedFfmpegError {
  kind: FfmpegErrorKind;
  message: string;
}

/** Worker → offscreen document. */
export type WorkerEvent =
  | { type: 'started'; id: number; loadMs: number }
  | { type: 'progress'; id: number; seconds: number }
  | { type: 'done'; id: number; result: FfmpegRunResult }
  | { type: 'failed'; id: number; error: SerializedFfmpegError };

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function parseFiles(raw: unknown): FfmpegOutput[] | null {
  if (!Array.isArray(raw)) return null;
  const files: FfmpegOutput[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item['name'] !== 'string' || !(item['data'] instanceof Blob)) return null;
    files.push({ name: item['name'], data: item['data'] });
  }
  return files;
}

export function parseRunRequest(raw: unknown): RunRequest | null {
  if (!isRecord(raw) || raw['type'] !== 'run' || !isId(raw['id']) || typeof raw['coreUrl'] !== 'string') return null;
  const job = raw['job'];
  if (!isRecord(job) || (job['tool'] !== 'ffmpeg' && job['tool'] !== 'ffprobe')) return null;
  const inputs = parseFiles(job['inputs']);
  if (!inputs || !isStringArray(job['args']) || !isStringArray(job['outputs'])) return null;
  const request: RunRequest = {
    type: 'run',
    id: raw['id'],
    coreUrl: raw['coreUrl'],
    job: { tool: job['tool'], args: job['args'], inputs, outputs: job['outputs'] },
  };
  if (isNumber(raw['timeoutMs']) && raw['timeoutMs'] > 0) request.timeoutMs = raw['timeoutMs'];
  return request;
}

function parseResult(raw: unknown): FfmpegRunResult | null {
  if (!isRecord(raw)) return null;
  const outputs = parseFiles(raw['outputs']);
  const exitCode = raw['exitCode'];
  if (!outputs || typeof raw['stdout'] !== 'string' || !isStringArray(raw['stderrTail']) || !isNumber(raw['runMs'])) return null;
  if (exitCode !== undefined && !isNumber(exitCode)) return null;
  return { exitCode, stdout: raw['stdout'], stderrTail: raw['stderrTail'], outputs, runMs: raw['runMs'] };
}

export function parseWorkerEvent(raw: unknown): WorkerEvent | null {
  if (!isRecord(raw) || !isId(raw['id'])) return null;
  const id = raw['id'];
  switch (raw['type']) {
    case 'started':
      return isNumber(raw['loadMs']) ? { type: 'started', id, loadMs: raw['loadMs'] } : null;
    case 'progress':
      return isNumber(raw['seconds']) ? { type: 'progress', id, seconds: raw['seconds'] } : null;
    case 'done': {
      const result = parseResult(raw['result']);
      return result ? { type: 'done', id, result } : null;
    }
    case 'failed': {
      const error = raw['error'];
      if (!isRecord(error) || typeof error['message'] !== 'string' || !isOneOf(error['kind'], FFMPEG_ERROR_KINDS)) return null;
      return { type: 'failed', id, error: { kind: error['kind'], message: error['message'] } };
    }
    default:
      return null;
  }
}
