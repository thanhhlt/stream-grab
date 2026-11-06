import { describe, expect, it } from 'vitest';
import {
  parseEngineReport,
  parseEngineWork,
  parseMediaAnalysis,
  parseMediaReport,
  parseSaveRequest,
  parseTaskIds,
} from '@/core/download/engine-messages';
import type { MediaAnalysis } from '@/core/models/media-info';

const progress = { segmentsTotal: 10, segmentsDone: 2, bytes: 100, bytesPerSecond: 50, percent: 20, retries: 0, startedAt: 1 };

describe('engine messages', () => {
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
    expect(parseMediaAnalysis({ ...media, tracks: [{ ...media.tracks[0], trackType: 'subtitle' }] })).toBeNull();
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
});
