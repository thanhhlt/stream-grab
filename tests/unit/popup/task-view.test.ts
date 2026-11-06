import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, type DownloadTask, type TaskProgress } from '@/core/models/download-task';
import type { MediaAnalysis } from '@/core/models/media-info';
import {
  completedFacts,
  completedSummary,
  downloadStats,
  fileNameAddsInfo,
  formatEstimatedBytes,
  formatEta,
  PHASE_VIEW,
  processingStageLabel,
  qualityOptions,
  taskMeta,
  taskPhase,
} from '@/popup/format';
import { ANALYSED_MEDIA, makeTask } from '@tests/fakes/tasks';

/** v0.2.0: các con số và trạng thái của Queue và Completed (hàm thuần, không render). */

const MB = 1024 ** 2;
const running = (overrides: Partial<TaskProgress> = {}): TaskProgress => ({
  segmentsTotal: 368,
  segmentsDone: 74,
  bytes: 36.4 * MB,
  bytesPerSecond: 7.4 * MB,
  averageBytesPerSecond: 7.4 * MB,
  percent: 20.1,
  retries: 0,
  startedAt: 0,
  ...overrides,
});
const at = { now: 30_000, reportedAt: 29_800 };

describe('ETA and size formatting', () => {
  it('formats remaining time compactly, always as an estimate', () => {
    expect(formatEta(0.4)).toBe('~1 second');
    expect(formatEta(19.4)).toBe('~19 seconds');
    expect(formatEta(59.4)).toBe('~59 seconds');
    expect(formatEta(61)).toBe('~2 min');
    expect(formatEta(3600)).toBe('~1 h');
    expect(formatEta(4000)).toBe('~1 h 7 min');
    expect(formatEta(Number.NaN)).toBe('');
  });

  it('marks estimated sizes with "~" and lower bounds with "+"', () => {
    expect(formatEstimatedBytes(181 * MB, { exact: true, partial: false })).toBe('181 MB');
    expect(formatEstimatedBytes(181 * MB, { exact: false, partial: false })).toBe('~181 MB');
    expect(formatEstimatedBytes(181 * MB, { exact: false, partial: true })).toBe('~181 MB+');
  });
});

describe('downloadStats', () => {
  it('shows percentage, segments, size, remaining, speed and ETA (the spec example)', () => {
    expect(downloadStats(running(), at)).toEqual({
      percent: 20.1,
      segments: '74 / 368 segments',
      size: '36.4 MB / ~181 MB',
      remaining: '~145 MB',
      speed: '7.4 MB/s',
      eta: '~20 seconds',
      stalled: false,
    });
  });

  it('shows exact sizes without "~" when the manifest declares them', () => {
    const stats = downloadStats(running({ tracks: [{ trackId: 'main', segmentsTotal: 368, segmentsDone: 74, bytes: 36.4 * MB, declaredBytes: 181 * MB }] }), at);
    expect(stats.size).toBe('36.4 MB / 181 MB');
    expect(stats.remaining).toBe('145 MB');
  });

  it('explains a lower bound while the audio track has not started', () => {
    const stats = downloadStats(
      running({
        segmentsTotal: 200,
        segmentsDone: 50,
        bytes: 50 * MB,
        tracks: [
          { trackId: 'main', segmentsTotal: 100, segmentsDone: 50, bytes: 50 * MB },
          { trackId: 'audio-0', segmentsTotal: 100, segmentsDone: 0, bytes: 0 },
        ],
      }),
      at,
    );
    expect(stats.size).toBe('50.0 MB / ~100 MB+');
    expect(stats.eta).toMatch(/\+$/);
    expect(stats.note).toContain('not included');
  });

  it('omits what it cannot know: no ETA at zero speed or without samples, no estimate for live streams', () => {
    expect(downloadStats(running({ bytesPerSecond: 0, averageBytesPerSecond: 0 }), at)).toMatchObject({ speed: 'Stalled', stalled: true });
    expect(downloadStats(running({ bytesPerSecond: 0 }), at).eta).toBeUndefined();
    const early = downloadStats(running({ segmentsDone: 2, bytes: 2 * MB, percent: 0.5 }), at);
    expect(early).toMatchObject({ size: '2.0 MB', speed: '7.4 MB/s' });
    expect(early.eta).toBeUndefined();
    expect(early.remaining).toBeUndefined();
    const live = downloadStats(running({ segmentsTotal: 0, segmentsDone: 0, bytes: 0, percent: 0 }), at);
    expect(live).toMatchObject({ size: '0 B', segments: '0 / 0 segments' });
    expect(live.eta).toBeUndefined();
  });

  it('counts retries and segments reused from an earlier run', () => {
    expect(downloadStats(running({ retries: 2, resumedSegments: 40 }), at)).toMatchObject({ retries: '2 retries', reused: '40 reused' });
  });
});

describe('task phases', () => {
  it('maps every stored status to one of the six phases the user sees', () => {
    const phases = TASK_STATUSES.map(taskPhase);
    expect(phases).toEqual(['pending', 'downloading', 'processing', 'processing', 'completed', 'failed', 'cancelled']);
    expect(new Set(phases.map((phase) => PHASE_VIEW[phase].label))).toEqual(
      new Set(['Pending', 'Downloading', 'Processing', 'Completed', 'Failed', 'Cancelled']),
    );
  });

  it('follows a task from download to FFmpeg processing to the saved file', () => {
    // queued → downloading → downloaded (waiting for FFmpeg) → processing (stages) → completed
    const steps: [DownloadTask['status'], string][] = [
      ['queued', 'Pending'],
      ['downloading', 'Downloading'],
      ['downloaded', 'Processing'],
      ['processing', 'Processing'],
      ['completed', 'Completed'],
    ];
    for (const [status, label] of steps) expect(PHASE_VIEW[taskPhase(status)].label).toBe(label);
    expect(processingStageLabel(undefined)).toBe('Waiting for FFmpeg');
    expect(processingStageLabel({ stage: 'analysing', step: 2, steps: 2, percent: 30, startedAt: 1 })).toBe('Analysing track 2 of 2');
    expect(processingStageLabel({ stage: 'merging', step: 1, steps: 1, percent: 60, startedAt: 1 })).toBe('Merging tracks');
    expect(processingStageLabel({ stage: 'saving', step: 1, steps: 1, percent: 98, startedAt: 1 })).toBe('Saving file');
  });

  it('keeps quality labels short, adding the bitrate only to tell equal labels apart', () => {
    expect(
      qualityOptions([
        { id: 'a', height: 1080, bandwidth: 5_000_000, audioOnly: false, audioTrackIds: [] },
        { id: 'b', height: 720, bandwidth: 3_000_000, audioOnly: false, audioTrackIds: [] },
        { id: 'c', height: 720, bandwidth: 1_500_000, audioOnly: false, audioTrackIds: [] },
        { id: 'd', bandwidth: 64_000, audioOnly: true, audioTrackIds: [] },
      ]).map((option) => option.label),
    ).toEqual(['1080p', '720p · 3.0 Mbps', '720p · 1.5 Mbps', 'Audio only']);
  });

  it('describes the selection of a task in one line', () => {
    expect(taskMeta(makeTask('m', { selection: { variantId: 'v', variantLabel: '1080p', audioTrackIds: ['a'], audioTrackNames: ['English'], durationSec: 734 } }))).toBe(
      '1080p · English · 12:14',
    );
  });
});

describe('completed items', () => {
  const MEDIA_1080: MediaAnalysis = {
    analysedAt: 1,
    container: 'mp4',
    tracks: [
      { trackId: 'main', trackType: 'main', format: 'mpegts', durationSec: 733.6, bytes: 120 * MB, segments: 368, streams: [{ kind: 'video', codec: 'h264', width: 1920, height: 1080 }] },
      { trackId: 'audio-0', trackType: 'audio', name: 'English', format: 'mpegts', durationSec: 734, bytes: 5 * MB, segments: 368, streams: [{ kind: 'audio', codec: 'aac', channels: 2 }] },
    ],
  };
  const saved = (overrides: Partial<DownloadTask> = {}, bytes = 110 * MB, path = '/home/me/Downloads/Test your own stream_1080p.mp4') =>
    makeTask('done', {
      status: 'completed',
      source: { protocol: 'hls', manifestUrl: 'https://cdn.example.com/x.m3u8', title: 'Test your own stream', tabId: 1, streamId: 's' },
      // Segments came to 125 MB; the merged file Chrome saved is 110 MB.
      progress: running({ segmentsDone: 368, bytes: 125 * MB, percent: 100 }),
      media: MEDIA_1080,
      output: { baseName: 'Test your own stream_1080p', format: 'auto', downloadId: 4, saved: { path, bytes, savedAt: 1 } },
      ...overrides,
    });

  it('puts resolution, duration and the real file size first, codecs and container second', () => {
    expect(completedFacts(saved())).toEqual({ primary: ['1080p', '12:14', '110 MB'], secondary: ['H.264', 'AAC Stereo', 'MP4'] });
  });

  it('uses the size of the saved file, never the downloaded segment bytes', () => {
    const facts = completedFacts(saved({}, 109_876_543));
    expect(facts.primary).toContain('105 MB');
    expect(facts.primary.join(' ')).not.toContain('125');
  });

  it('shows the file name only when it says more than the title', () => {
    expect(completedFacts(saved()).fileName).toBeUndefined(); // generated: title + quality
    expect(completedFacts(saved({}, MB, '/d/Test your own stream_1080p (1).mp4')).fileName).toBeUndefined();
    expect(completedFacts(saved({}, MB, '/d/Lecture 3.mkv')).fileName).toBe('Lecture 3.mkv');
    expect(fileNameAddsInfo('Movie', 'Movie.mp4')).toBe(false);
    expect(fileNameAddsInfo('Phim hay', 'phim_hay_720p.mp4')).toBe(false);
  });

  it('falls back to the selection when no analysis is stored, and handles audio-only files', () => {
    const { media: _media, ...unanalysed } = saved({ selection: { variantId: 'v', variantLabel: '720p', audioTrackIds: [], audioTrackNames: [], durationSec: 75 } });
    const plain = completedFacts(unanalysed);
    expect(plain).toMatchObject({ primary: ['720p', '1:15', '110 MB'], secondary: ['MP4'] });
    const audioOnly = { ...ANALYSED_MEDIA, tracks: ANALYSED_MEDIA.tracks.filter((track) => track.trackType === 'audio') };
    expect(completedFacts(saved({ media: audioOnly })).primary[0]).toBe('Audio only');
  });

  it('sums the saved files and counts the missing ones', () => {
    const tasks = [saved({ id: 'a' }, 100 * MB), saved({ id: 'b', output: { baseName: 'b', format: 'auto', downloadId: 9, saved: { path: '/b.mp4', bytes: 10 * MB, savedAt: 2 } } })];
    expect(completedSummary(tasks, new Map([[9, false]]))).toEqual({ count: 2, bytes: 110 * MB, missing: 1 });
    expect(completedSummary(tasks, new Map())).toEqual({ count: 2, bytes: 110 * MB, missing: 0 });
  });
});
