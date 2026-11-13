import { describe, expect, it } from 'vitest';
import {
  parseEngineReport,
  parseEngineWork,
  parseMediaAnalysis,
  parseMediaReport,
  parseMediaTaskSpec,
  parseSaveRequest,
  parseTaskIds,
} from '@/core/download/engine-messages';
import type { MediaAnalysis } from '@/core/models/media-info';

const progress = { segmentsTotal: 10, segmentsDone: 2, bytes: 100, bytesPerSecond: 50, percent: 20, retries: 0, startedAt: 1 };

describe('engine messages', () => {
  it('keeps the run number of a task spec, so the engine tells a Retry from the run before (0.9.0)', () => {
    const base = { taskId: 't1', protocol: 'hls', manifestUrl: 'https://cdn.example.com/a.m3u8', variant: { id: 'video-0' }, audioTrackIds: [] };
    const runs = [2, 0, 1.5, 'x', undefined].map((run) => parseEngineWork({ downloads: [{ ...base, run }], media: [] }).downloads[0]?.run);
    expect(runs).toEqual([2, undefined, undefined, undefined, undefined]);
  });

  it('validates task specs and clamps concurrency', () => {
    const { downloads: specs } = parseEngineWork({
      downloads: [
        {
          taskId: 't1',
          protocol: 'hls',
          manifestUrl: 'https://cdn.example.com/a.m3u8',
          context: { referer: 'https://site.example/', cookie: 'nope' },
          variant: { id: 'video-0', height: 720, bandwidth: 'x' },
          audioTrackIds: ['audio-0', 5],
          concurrency: 99,
        },
        { taskId: 't2', protocol: 'smooth', manifestUrl: 'https://x', variant: { id: 'v' } },
        { taskId: 't3', protocol: 'dash', manifestUrl: 'https://x/a.mpd' },
      ],
    });
    expect(specs).toEqual([
      {
        taskId: 't1',
        protocol: 'hls',
        manifestUrl: 'https://cdn.example.com/a.m3u8',
        context: { referer: 'https://site.example/' },
        variant: { id: 'video-0', height: 720 },
        audioTrackIds: ['audio-0'],
        concurrency: 16,
      },
    ]);
  });

  it('validates reports', () => {
    expect(parseEngineReport({ taskId: 't', progress })).toEqual({ taskId: 't', progress });
    expect(parseEngineReport({ taskId: 't', progress, outcome: { status: 'failed', message: 'HTTP 500' } })?.outcome).toEqual({
      status: 'failed',
      message: 'HTTP 500',
    });
    expect(parseEngineReport({ taskId: 't', progress, outcome: { status: 'exploded' } })?.outcome).toBeUndefined();
    expect(parseEngineReport({ taskId: 't', progress: { ...progress, bytes: -1 } })).toBeNull();
    expect(parseEngineReport({ progress })).toBeNull();
  });

  it('carries resumed segments and known failure reasons, never the service worker\'s stale marker', () => {
    const report = parseEngineReport({
      taskId: 't',
      progress: { ...progress, resumedSegments: 2, stale: true },
      outcome: { status: 'failed', message: 'Disk full', reason: 'disk-full' },
    });
    expect(report).toEqual({
      taskId: 't',
      progress: { ...progress, resumedSegments: 2 },
      outcome: { status: 'failed', message: 'Disk full', reason: 'disk-full' },
    });
    expect(parseEngineReport({ taskId: 't', progress, outcome: { status: 'failed', message: 'x', reason: 'meteor' } })?.outcome).toEqual({
      status: 'failed',
      message: 'x',
    });
    expect(parseEngineReport({ taskId: 't', progress: { ...progress, resumedSegments: -3 } })?.progress.resumedSegments).toBeUndefined();
  });

  it('carries the per-track figures and the average speed (v0.2.0), dropping malformed ones', () => {
    const tracks = [{ trackId: 'main', segmentsTotal: 5, segmentsDone: 2, bytes: 200, declaredBytes: 500 }];
    expect(parseEngineReport({ taskId: 't', progress: { ...progress, averageBytesPerSecond: 12, tracks } })?.progress).toEqual({
      ...progress,
      averageBytesPerSecond: 12,
      tracks,
    });
    const damaged = parseEngineReport({ taskId: 't', progress: { ...progress, averageBytesPerSecond: Number.NaN, tracks: [{ trackId: '', segmentsTotal: 1 }] } });
    expect(damaged?.progress).toEqual(progress);
    expect(parseEngineReport({ taskId: 't', progress: { ...progress, tracks: 'many' } })?.progress.tracks).toBeUndefined();
  });

  it('validates task ID lists', () => {
    expect(parseTaskIds({ taskIds: ['a', 7, '', 'b'] })).toEqual(['a', 'b']);
    expect(parseTaskIds(null)).toEqual([]);
  });

  it('validates the media jobs of a work list', () => {
    expect(
      parseEngineWork({
        downloads: [],
        media: [
          { taskId: 'a', job: 'process', format: 'auto', title: 'A movie' },
          { taskId: 'b', job: 'transcode', format: 'auto' },
          { taskId: 'c', job: 'process', format: 'avi' },
          { taskId: 'd', job: 'process', format: 'mkv' },
        ],
      }),
    ).toEqual({
      downloads: [],
      media: [
        { taskId: 'a', job: 'process', format: 'auto', title: 'A movie' },
        { taskId: 'd', job: 'process', format: 'mkv', title: '' },
      ],
    });
    expect(parseEngineWork(undefined)).toEqual({ downloads: [], media: [] });
  });

  const media: MediaAnalysis = {
    analysedAt: 5,
    container: 'mp4',
    tracks: [
      {
        trackId: 'main',
        trackType: 'main',
        format: 'mpegts',
        durationSec: 8,
        bytes: 1000,
        segments: 4,
        streams: [{ kind: 'video', codec: 'h264', width: 320, height: 180, frameRate: 10 }],
      },
      { trackId: 'audio-0', trackType: 'audio', name: 'English', format: 'mpegts', bytes: 500, segments: 4, streams: [{ kind: 'audio', codec: 'aac', channels: 2 }] },
    ],
  };
  const mediaProgress = { stage: 'analysing', step: 1, steps: 2, percent: 50, startedAt: 1, detail: 'English' };

  it('validates media reports and analyses', () => {
    expect(parseMediaReport({ taskId: 't', progress: mediaProgress })).toEqual({ taskId: 't', progress: mediaProgress });
    expect(parseMediaReport({ taskId: 't', progress: mediaProgress, outcome: { status: 'failed', message: 'm', discardedData: true } })?.outcome).toEqual({
      status: 'failed',
      message: 'm',
      discardedData: true,
    });
    expect(parseMediaReport({ taskId: 't', progress: { ...mediaProgress, stage: 'dancing' } })).toBeNull();
    expect(parseMediaReport({ taskId: 't', progress: { ...mediaProgress, stage: 'merging' }, outcome: { status: 'cancelled' } })?.outcome).toEqual({ status: 'cancelled' });
    expect(parseMediaAnalysis({ ...media, tracks: [{ ...media.tracks[0], trackType: 'chapters' }] })).toBeNull();
    expect(parseMediaAnalysis(JSON.parse(JSON.stringify(media)))).toEqual(media);
  });

  it('accepts save requests only for blob: URLs of this extension', () => {
    const origin = 'chrome-extension://abcdef/';
    const request = { taskId: 't', url: 'blob:chrome-extension://abcdef/0b6f-41', container: 'mp4', size: 10, media };
    expect(parseSaveRequest(request, origin)).toEqual(request);
    expect(parseSaveRequest({ ...request, url: 'https://evil.example/file.mp4' }, origin)).toBeNull();
    expect(parseSaveRequest({ ...request, url: 'blob:chrome-extension://other/0b6f' }, origin)).toBeNull();
    expect(parseSaveRequest({ ...request, container: 'exe' }, origin)).toBeNull();
    expect(parseSaveRequest({ ...request, media: { tracks: 'x' } }, origin)).toBeNull();
  });

  it('carries progressive file specs only with their container, and saves of files without container or analysis (0.3.0)', () => {
    const file = {
      taskId: 'f1',
      protocol: 'progressive',
      manifestUrl: 'https://cdn.example.com/clip.mp4',
      context: { referer: 'https://site.example/' },
      variant: { id: 'file' },
      audioTrackIds: [],
      concurrency: 1,
      file: { container: 'webm', bytes: 1234 },
    };
    const { downloads } = parseEngineWork({
      downloads: [
        file,
        { ...file, taskId: 'f2', file: { container: 'mkv' } },
        { ...file, taskId: 'f3', file: undefined },
        { ...file, taskId: 'f4', protocol: 'hls' }, // a stream never carries a file
      ],
    });
    expect(downloads).toEqual([{ ...file, file: { container: 'webm', bytes: 1234 } }]);

    const origin = 'chrome-extension://abcdef/';
    const save = { taskId: 'f1', url: 'blob:chrome-extension://abcdef/77', size: 1234 };
    expect(parseSaveRequest(save, origin)).toEqual(save);
    expect(parseSaveRequest({ ...save, container: 'mp4' }, origin)).toBeNull(); // half a merged-video save
    expect(parseSaveRequest({ ...save, url: 'https://cdn.example.com/clip.mp4' }, origin)).toBeNull();
  });

  it('carries subtitle settings of media jobs and subtitle files of merged saves, blob: URLs of this extension only (0.7.0)', () => {
    const job = { taskId: 't', job: 'process', format: 'mkv', title: 'Movie' };
    // A spec without a mode (before it existed) saves files.
    expect(parseMediaTaskSpec({ ...job, subtitles: { protocol: 'hls', format: 'srt' } })).toEqual({ ...job, subtitles: { protocol: 'hls', format: 'srt', mode: 'file' } });
    expect(parseMediaTaskSpec({ ...job, subtitles: { protocol: 'hls', format: 'vtt', mode: 'both' } })?.subtitles).toEqual({ protocol: 'hls', format: 'vtt', mode: 'both' });
    expect(parseMediaTaskSpec({ ...job, subtitles: { protocol: 'hls', format: 'vtt', mode: 'burn' } })?.subtitles?.mode).toBe('file');
    expect(parseMediaTaskSpec({ ...job, subtitles: { protocol: 'progressive', format: 'srt' } })).toEqual(job);
    expect(parseMediaTaskSpec({ ...job, subtitles: { protocol: 'dash', format: 'ass' } })).toEqual(job);

    const origin = 'chrome-extension://abcdef/';
    const request = { taskId: 't', url: 'blob:chrome-extension://abcdef/1', container: 'mkv', size: 10, media };
    const subtitles = [
      { trackId: 'subtitle-0', url: 'blob:chrome-extension://abcdef/2', size: 40 },
      { trackId: 'subtitle-1', error: 'The subtitle track is not WebVTT.' },
      { trackId: 'subtitle-2', url: 'https://evil.example/x.srt', size: 1 },
      { trackId: 'subtitle-3', url: 'blob:chrome-extension://abcdef/3' },
      { trackId: 'subtitle-4', embedded: true },
      { trackId: 'subtitle-5', embedded: true, url: 'blob:chrome-extension://abcdef/4', size: 9 },
      // Embedded, but its file could not be made (or its URL is not ours): embedded only.
      { trackId: 'subtitle-6', embedded: true, url: 'https://evil.example/x.srt', size: 1 },
      { trackId: 'subtitle-7', embedded: 'yes' },
    ];
    expect(parseSaveRequest({ ...request, subtitles }, origin)?.subtitles).toEqual([
      ...subtitles.slice(0, 2),
      { trackId: 'subtitle-4', embedded: true },
      { trackId: 'subtitle-5', embedded: true, url: 'blob:chrome-extension://abcdef/4', size: 9 },
      { trackId: 'subtitle-6', embedded: true },
    ]);
    // A progressive file's save never carries subtitle files.
    expect(parseSaveRequest({ taskId: 't', url: 'blob:chrome-extension://abcdef/1', size: 10, subtitles }, origin)?.subtitles).toBeUndefined();
  });
});
