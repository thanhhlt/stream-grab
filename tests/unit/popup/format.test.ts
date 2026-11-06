import { describe, expect, it } from 'vitest';
import type { DetectedStream } from '@/core/models/detected-stream';
import {
  formatBitrate,
  formatBytes,
  formatDuration,
  formatSpeed,
  mediaFacts,
  completedTasks,
  mediaSummary,
  outputExtension,
  outputFileName,
  pathFileName,
  overallProgress,
  processingLine,
  statusView,
  storageLine,
  streamLabel,
  streamTags,
  taskProgressLine,
  variantLabel,
} from '@/popup/format';
import { ANALYSED_MEDIA, makeTask } from '@tests/fakes/tasks';

const stream = (overrides: Partial<DetectedStream> = {}): DetectedStream => ({
  id: 's1',
  tabId: 1,
  frameId: 0,
  protocol: 'hls',
  url: 'https://cdn.example.com/vod/master.m3u8?token=1',
  dedupeKey: 'https://cdn.example.com/vod/master.m3u8',
  evidence: ['extension'],
  status: 'ready',
  requestContext: {},
  firstSeen: 1,
  lastSeen: 1,
  ...overrides,
});

describe('popup formatting', () => {
  it('labels streams by title, then file name', () => {
    expect(streamLabel(stream({ title: 'My video' }))).toBe('My video');
    expect(streamLabel(stream())).toBe('master.m3u8');
    expect(streamLabel(stream({ url: 'https://cdn.example.com/' }))).toBe('cdn.example.com');
  });

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
  });

  it('maps statuses and tags', () => {
    expect(statusView(stream({ status: 'pending' })).tone).toBe('progress');
    expect(statusView(stream({ status: 'drm' })).label).toBe('DRM · not supported');
    expect(
      streamTags(stream({ manifest: { role: 'master', live: true, drmSystems: [], encryption: 'aes-128' } })),
    ).toEqual(['Multi-quality', 'Live', 'AES-128']);
    expect(
      streamTags(stream({ status: 'drm', manifest: { role: 'presentation', live: false, drmSystems: ['widevine'], encryption: 'cenc' } })),
    ).toEqual([]);
  });

  it('labels variants by resolution, high frame rate, bitrate or audio-only', () => {
    expect(variantLabel({ height: 1080, audioOnly: false })).toBe('1080p');
    expect(variantLabel({ height: 720, frameRate: 59.94, audioOnly: false })).toBe('720p60');
    expect(variantLabel({ bandwidth: 900_000, audioOnly: false })).toBe('900 kbps');
    expect(variantLabel({ bandwidth: 64_000, audioOnly: true })).toBe('Audio only');
    expect(variantLabel({ audioOnly: false })).toBe('Single quality');
    expect(formatBitrate(5_000_000)).toBe('5.0 Mbps');
  });

  it('summarises parsed media for the stream card', () => {
    const facts = mediaFacts(
      stream({
        manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' },
        media: {
          durationSec: 596,
          variants: [
            { id: 'v0', height: 1080, videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2', audioOnly: false, audioTrackIds: [] },
            { id: 'v1', height: 720, videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.2', audioOnly: false, audioTrackIds: [] },
            { id: 'v2', height: 720, frameRate: 25, videoCodec: 'avc1.64001f', audioOnly: false, audioTrackIds: [] },
            { id: 'v-audio', audioCodec: 'mp4a.40.5', audioOnly: true, audioTrackIds: [] },
          ],
          audioTracks: [
            { id: 'a0', name: 'English', language: 'en', isDefault: true },
            { id: 'a1', name: 'Français', language: 'fr', isDefault: false },
          ],
        },
      }),
    );
    expect(facts).toEqual({
      durationSec: 596,
      qualities: '1080p · 720p · Audio only',
      codecs: 'H.264 · AAC · HE-AAC',
      audio: '2 audio tracks: English / Français',
    });
    expect(streamTags(stream({ manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' }, media: { variants: [], audioTracks: [] } }))).toEqual([]);
  });

  it('takes DASH audio codecs from the audio tracks', () => {
    const facts = mediaFacts(
      stream({
        protocol: 'dash',
        media: {
          variants: [{ id: 'v3', height: 1080, videoCodec: 'hvc1.1.6.L120.90', audioOnly: false, audioTrackIds: [] }],
          audioTracks: [
            { id: 'a2', name: 'English (original)', language: 'en', isDefault: true, codec: 'ec-3' },
            { id: 'a3', name: 'fr (dub)', language: 'fr', isDefault: false, codec: 'mp4a.40.2' },
          ],
        },
      }),
    );
    expect(facts).toMatchObject({ codecs: 'HEVC · E-AC-3 · AAC', audio: '2 audio tracks: English (original) / fr (dub)' });
  });

  it('formats sizes and speeds in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3_500_000)).toBe('3.3 MB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB');
    expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s');
  });

  it('describes where each queue entry stands', () => {
    const progress = { segmentsTotal: 300, segmentsDone: 214, bytes: 412 * 1024 * 1024, bytesPerSecond: 6.4 * 1024 * 1024, percent: 71.3, retries: 3, startedAt: 1 };
    expect(taskProgressLine(makeTask('q'))).toBe('Waiting for a free download slot');
    expect(taskProgressLine(makeTask('d', { status: 'downloading' }))).toBe('Preparing: reading the segment list…');
    expect(taskProgressLine(makeTask('d', { status: 'downloading', progress: { ...progress, segmentsTotal: 0, segmentsDone: 0 } }))).toBe(
      'Preparing: reading the segment list…',
    );
    expect(taskProgressLine(makeTask('d', { status: 'downloading', progress }))).toBe('71.3% · 214 / 300 segments · 412 MB · 6.4 MB/s · 3 retries');
    // No speed once the transfer stopped; a failed task keeps its segments for Retry; one retry is singular.
    expect(taskProgressLine(makeTask('f', { status: 'failed', progress: { ...progress, retries: 1 } }))).toBe(
      '71.3% · 214 / 300 segments kept · 412 MB · 1 retry',
    );
    expect(taskProgressLine(makeTask('f', { status: 'failed', progress: { ...progress, segmentsDone: 0, percent: 0, bytes: 0 } }))).toBe(
      '0.0% · 0 / 300 segments · 0 B · 3 retries',
    );
    expect(taskProgressLine(makeTask('c', { status: 'cancelled' }))).toBeUndefined();
  });

  it('is truthful about resumed downloads', () => {
    const stored = { segmentsTotal: 300, segmentsDone: 120, bytes: 230 * 1024 * 1024, bytesPerSecond: 0, percent: 40, retries: 0, startedAt: 1, stale: true };
    // Retried: what an earlier run stored, while it waits.
    expect(taskProgressLine(makeTask('q', { progress: stored }))).toBe('Waiting for a free download slot · 120 / 300 segments already downloaded');
    // Started or restarted, before the engine has checked the stored segments.
    expect(taskProgressLine(makeTask('d', { status: 'downloading', progress: stored }))).toBe(
      'Resuming · 120 / 300 segments already downloaded',
    );
    expect(taskProgressLine(makeTask('d', { status: 'downloading', progress: { ...stored, segmentsDone: 0 } }))).toBe(
      'Preparing: reading the segment list…',
    );
    // Running again: reused segments count as done, not as speed.
    const running = { ...stored, stale: false, segmentsDone: 150, percent: 50, bytesPerSecond: 1024 * 1024, resumedSegments: 120 };
    expect(taskProgressLine(makeTask('d', { status: 'downloading', progress: running }))).toBe(
      '50.0% · 150 / 300 segments (120 reused) · 230 MB · 1.0 MB/s',
    );
  });

  it('shows the disk space left and warns before downloads stop', () => {
    const reserve = 256 * 1024 * 1024;
    expect(storageLine({}, reserve)).toBeUndefined();
    expect(storageLine({ usage: 1.5 * 1024 ** 3, quota: 101.5 * 1024 ** 3 }, reserve)).toEqual({
      text: 'Downloaded data: 1.5 GB · 100 GB free',
      low: false,
    });
    expect(storageLine({ usage: 1024 ** 3, quota: 1024 ** 3 + 300 * 1024 * 1024 }, reserve)).toEqual({
      text: 'Low disk space: 300 MB free. Downloads stop while less than 256 MB is left.',
      low: true,
    });
  });

  it('combines running downloads into one overall progress, never rounding up to 100%', () => {
    const progress = (segmentsDone: number, segmentsTotal: number, bytesPerSecond: number) => ({
      segmentsTotal,
      segmentsDone,
      bytes: 0,
      bytesPerSecond,
      percent: 0,
      retries: 0,
      startedAt: 1,
    });
    expect(overallProgress([makeTask('q')])).toEqual({ running: 0, percent: undefined, bytesPerSecond: 0 });
    expect(overallProgress([makeTask('b', { status: 'downloading' })])).toEqual({ running: 1, percent: undefined, bytesPerSecond: 0 });
    expect(
      overallProgress([
        makeTask('a', { status: 'downloading', progress: progress(214, 300, 1000) }),
        makeTask('b', { status: 'downloading' }), // still planning
        makeTask('done', { status: 'downloaded', progress: progress(10, 10, 0) }), // not running any more
      ]),
    ).toEqual({ running: 2, percent: 71.3, bytesPerSecond: 1000 });
    expect(overallProgress([makeTask('a', { status: 'downloading', progress: progress(9999, 10000, 0) })]).percent).toBe(99.9);
  });

  it('falls back to the duration hint and hides "single quality"', () => {
    expect(mediaFacts(stream({ durationHint: 42 }))).toEqual({ durationSec: 42 });
    expect(mediaFacts(stream({ media: { variants: [{ id: 'v0', audioOnly: false, audioTrackIds: [] }], audioTracks: [] } }))).toEqual({});
  });

  describe('media processing', () => {
    it('says what FFmpeg is doing', () => {
      const at = (stage: 'waiting' | 'preparing' | 'loading' | 'analysing', step = 1, steps = 1, detail?: string) => ({
        stage,
        step,
        steps,
        percent: 0,
        startedAt: 1,
        ...(detail !== undefined ? { detail } : {}),
      });
      expect(processingLine(undefined)).toBe('Waiting for FFmpeg…');
      expect(processingLine(at('preparing'))).toBe('Reading the downloaded segments…');
      expect(processingLine(at('loading'))).toBe('Loading FFmpeg…');
      expect(processingLine(at('analysing'))).toBe('FFmpeg is checking the video…');
      expect(processingLine(at('analysing', 1, 2))).toBe('FFmpeg is checking the video (1 of 2)…');
      expect(processingLine(at('analysing', 2, 2, 'English'))).toBe('FFmpeg is checking "English" (2 of 2)…');
      expect(taskProgressLine(makeTask('p', { status: 'processing', processing: at('loading') }))).toBe('Loading FFmpeg…');
    });

    it('summarises what FFmpeg found and the container the merge will write', () => {
      expect(mediaSummary(ANALYSED_MEDIA)).toBe('H.264 1280×720 · English: AAC stereo → MP4');
      expect(
        mediaSummary({
          analysedAt: 1,
          container: 'mkv',
          tracks: [
            {
              trackId: 'main',
              trackType: 'main',
              format: 'matroska,webm',
              bytes: 1,
              segments: 1,
              streams: [{ kind: 'video', codec: 'vp8' }, { kind: 'audio', codec: 'vorbis', channels: 6 }, { kind: 'data', codec: 'bin_data' }],
            },
          ],
        }),
      ).toBe('VP8 · Vorbis 5.1 → MKV');
    });

    it('shows the analysed container as the output extension', () => {
      expect(outputExtension(makeTask('a'))).toBe('.mp4');
      expect(outputExtension(makeTask('a', { output: { baseName: 'x', format: 'mkv' } }))).toBe('.mkv');
      expect(outputExtension(makeTask('a', { media: { ...ANALYSED_MEDIA, container: 'mkv' } }))).toBe('.mkv');
    });
  });

  describe('merging, saving and completed tasks', () => {
    const at = (stage: 'merging' | 'verifying' | 'saving', percent: number) => ({ stage, step: 1, steps: 1, percent, startedAt: 1 });

    it('says what happens after the analysis', () => {
      expect(processingLine(at('merging', 52))).toBe('Merging the tracks into one file · 52%');
      expect(processingLine(at('verifying', 95))).toBe('Checking the merged file…');
      expect(processingLine(at('saving', 97))).toBe('Saving to the Downloads folder…');
    });

    it('shows the saved file and its size', () => {
      const saved = makeTask('c', {
        status: 'completed',
        output: { baseName: 'Movie', format: 'auto', downloadId: 2, saved: { path: String.raw`C:\Users\me\Downloads\Movie (1).mp4`, bytes: 2048, savedAt: 5 } },
      });
      expect(outputFileName(saved)).toBe('Movie (1).mp4');
      expect(taskProgressLine(saved)).toBe('Saved · 2.0 KB');
      expect(outputFileName(makeTask('q', { media: { ...ANALYSED_MEDIA, container: 'mkv' } }))).toBe('Movie_q.mkv');
      expect(pathFileName('/home/me/Downloads/x.mkv')).toBe('x.mkv');
    });

    it('lists completed tasks most recently saved first', () => {
      const saved = (id: string, savedAt: number) =>
        makeTask(id, { status: 'completed', output: { baseName: id, format: 'auto', saved: { path: `/${id}.mp4`, bytes: 1, savedAt } } });
      expect(completedTasks([saved('old', 1), makeTask('running', { status: 'downloading' }), saved('new', 9)]).map((task) => task.id)).toEqual(['new', 'old']);
    });
  });
});
