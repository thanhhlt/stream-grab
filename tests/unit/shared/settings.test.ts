import { describe, expect, it } from 'vitest';
import { ACTIVE_TASKS, SEGMENT_CONCURRENCY } from '@/shared/constants';
import { DEFAULT_SETTINGS, normalizeSettings, settingsEqual } from '@/shared/settings/settings';

describe('normalizeSettings', () => {
  it('returns defaults for missing or non-object input', () => {
    for (const raw of [undefined, null, 42, 'settings', [], true]) {
      expect(normalizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('defaults segment concurrency to 6 and active tasks to 2', () => {
    expect(DEFAULT_SETTINGS.segmentConcurrency).toBe(6);
    expect(SEGMENT_CONCURRENCY).toEqual({ min: 1, max: 16, default: 6 });
    expect(DEFAULT_SETTINGS.maxActiveTasks).toBe(ACTIVE_TASKS.default);
  });

  it('clamps segment concurrency to 1–16 and rounds fractions', () => {
    expect(normalizeSettings({ segmentConcurrency: 0 }).segmentConcurrency).toBe(1);
    expect(normalizeSettings({ segmentConcurrency: -5 }).segmentConcurrency).toBe(1);
    expect(normalizeSettings({ segmentConcurrency: 17 }).segmentConcurrency).toBe(16);
    expect(normalizeSettings({ segmentConcurrency: 1e9 }).segmentConcurrency).toBe(16);
    expect(normalizeSettings({ segmentConcurrency: 7.6 }).segmentConcurrency).toBe(8);
    expect(normalizeSettings({ segmentConcurrency: 12 }).segmentConcurrency).toBe(12);
  });

  it('rejects non-numeric and non-finite concurrency values', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '8', null, {}]) {
      expect(normalizeSettings({ segmentConcurrency: value }).segmentConcurrency).toBe(6);
    }
  });

  it('clamps simultaneous tasks to its range', () => {
    expect(normalizeSettings({ maxActiveTasks: 0 }).maxActiveTasks).toBe(ACTIVE_TASKS.min);
    expect(normalizeSettings({ maxActiveTasks: 99 }).maxActiveTasks).toBe(ACTIVE_TASKS.max);
  });

  it('accepts only known enum values', () => {
    expect(normalizeSettings({ preferredResolution: '720' }).preferredResolution).toBe('720');
    expect(normalizeSettings({ preferredResolution: 720 }).preferredResolution).toBe('highest');
    expect(normalizeSettings({ preferredResolution: '8k' }).preferredResolution).toBe('highest');
    expect(normalizeSettings({ outputFormat: 'mkv' }).outputFormat).toBe('mkv');
    expect(normalizeSettings({ outputFormat: 'avi' }).outputFormat).toBe('auto');
  });

  it('accepts only real booleans for toggles', () => {
    expect(normalizeSettings({ autoDetect: false }).autoDetect).toBe(false);
    expect(normalizeSettings({ autoDetect: 'false' }).autoDetect).toBe(true);
    expect(normalizeSettings({ autoRemoveCompleted: true }).autoRemoveCompleted).toBe(true);
    expect(normalizeSettings({ autoRemoveCompleted: 1 }).autoRemoveCompleted).toBe(false);
  });

  it('drops unknown keys', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, legacyOption: 1 })).toEqual(DEFAULT_SETTINGS);
  });

  it('falls back to the provided settings for invalid fields', () => {
    const current = { ...DEFAULT_SETTINGS, segmentConcurrency: 3, outputFormat: 'mkv' as const };
    const next = normalizeSettings({ ...current, segmentConcurrency: 'lots', outputFormat: 'avi' }, current);
    expect(next.segmentConcurrency).toBe(3);
    expect(next.outputFormat).toBe('mkv');
  });
});

describe('settingsEqual', () => {
  it('compares every field', () => {
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS })).toBe(true);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, autoDetect: false })).toBe(false);
  });
});
