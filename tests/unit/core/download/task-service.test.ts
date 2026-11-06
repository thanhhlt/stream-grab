import { describe, expect, it } from 'vitest';
import { summarizeManifest } from '@/core/detection/manifest-inspector';
import { parseDownloadRequests, TaskService } from '@/core/download/task-service';
import { TaskStore } from '@/core/download/task-store';
import type { DetectedStream } from '@/core/models/detected-stream';
import type { DownloadRequest } from '@/core/models/download-task';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { DashAdapter } from '@/core/protocols/dash/dash-adapter';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { DEFAULT_SETTINGS, type Settings } from '@/shared/settings/settings';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import { makeTask } from '@tests/fakes/tasks';
import dashStatic from '@tests/fixtures/manifests/dash/static-separate-av.mpd?raw';
import hlsMaster from '@tests/fixtures/manifests/hls/master.m3u8?raw';
import hlsSampleAes from '@tests/fixtures/manifests/hls/media-sample-aes.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';

const MASTER = 'https://cdn.example.com/vod/movie/master.m3u8';
const MPD = 'https://dash.example.com/sintel/manifest.mpd';
const SITE: Record<string, string | { body: string; status: number }> = {
  [MASTER]: hlsMaster,
  'https://cdn.example.com/vod/movie/video/1080p/prog_index.m3u8': hlsTs,
  [MPD]: dashStatic,
  'https://expired.example.com/master.m3u8': { body: 'Forbidden', status: 403 },
};

const fetch: FetchFunction = (url) => {
  const entry = SITE[url];
  if (entry === undefined) return Promise.resolve(new Response('missing', { status: 404 }));
  return Promise.resolve(typeof entry === 'string' ? new Response(entry) : new Response(entry.body, { status: entry.status }));
};

function baseStream(id: string, url: string, overrides: Partial<DetectedStream> = {}): DetectedStream {
  return {
    id,
    tabId: 3,
    frameId: 0,
    protocol: url.endsWith('.mpd') ? 'dash' : 'hls',
    url,
    dedupeKey: url,
    evidence: ['extension'],
    status: 'ready',
    requestContext: { referer: 'https://site.example/watch' },
    firstSeen: 1,
    lastSeen: 1,
    title: 'Big Buck Bunny',
    pageUrl: 'https://site.example/watch',
    ...overrides,
  };
}

async function setup(options: { settings?: Partial<Settings>; existing?: ReturnType<typeof makeTask>[] } = {}) {
  const fetcher = new ManifestFetcher({ fetch });
  const protocols = new ProtocolRegistry().register(new HlsAdapter({ fetcher })).register(new DashAdapter({ fetcher }));
  const hlsManifest = await protocols.forProtocol('hls')?.parseManifest(MASTER);
  const dashManifest = await protocols.forProtocol('dash')?.parseManifest(MPD);
  if (!hlsManifest || !dashManifest) throw new Error('fixtures did not parse');

  const streams = new Map<string, DetectedStream>([
    ['hls', baseStream('hls', MASTER, { manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' }, media: summarizeManifest(hlsManifest) })],
    ['dash', baseStream('dash', MPD, { title: 'Sintel', media: summarizeManifest(dashManifest) })],
    ['pending', baseStream('pending', MASTER, { status: 'pending' })],
    ['drm', baseStream('drm', MASTER, { status: 'drm', statusMessage: 'Protected by Widevine DRM. DRM-protected streams are not supported.' })],
    ['live', baseStream('live', MASTER, { manifest: { role: 'media', live: true, drmSystems: [], encryption: 'none' } })],
    ['expired', baseStream('expired', 'https://expired.example.com/master.m3u8')],
  ]);
  const local = new FakeStorageArea('local');
  const session = new FakeStorageArea('session');
  const store = new TaskStore(local, session);
  if (options.existing) await store.add(options.existing.map((task) => ({ task, context: {} })));
  let counter = 0;
  const service = new TaskService({
    store,
    getStream: (tabId, streamId) => Promise.resolve(tabId === 3 ? streams.get(streamId) : undefined),
    protocols,
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, ...options.settings }),
    now: () => 1000,
    newId: () => `task-${++counter}`,
  });
  return { service, store, streams };
}

const request = (streamId: string, overrides: Partial<DownloadRequest> = {}): DownloadRequest => ({
  tabId: 3,
  streamId,
  variantId: 'video-0',
  audioTrackIds: [],
  fileName: '',
  ...overrides,
});

describe('TaskService.start', () => {
  it('queues a task for a valid HLS choice, with a generated name and the request context kept in session', async () => {
    const { service, store } = await setup({ settings: { outputFormat: 'mkv' } });
    const result = await service.start([request('hls', { variantId: 'video-1', audioTrackIds: ['audio-1'] })]);
    expect(result).toEqual({ created: [{ taskId: 'task-1', streamId: 'hls', baseName: 'Big_Buck_Bunny_720p' }], failed: [] });
    expect(await store.list()).toEqual([
      {
        id: 'task-1',
        createdAt: 1000,
        updatedAt: 1000,
        status: 'queued',
        source: { protocol: 'hls', manifestUrl: MASTER, title: 'Big Buck Bunny', pageUrl: 'https://site.example/watch', tabId: 3, streamId: 'hls' },
        selection: {
          variantId: 'video-1',
          variantLabel: '720p',
          width: 1280,
          height: 720,
          bandwidth: 3200000,
          audioTrackIds: ['audio-1'],
          audioTrackNames: ['Français, stéréo'],
          durationSec: 34.5,
        },
        output: { baseName: 'Big_Buck_Bunny_720p', format: 'mkv' },
      },
    ]);
    expect(await store.getContext('task-1')).toEqual({ referer: 'https://site.example/watch' });
  });

  it('queues DASH choices the same way', async () => {
    const { service } = await setup();
    const result = await service.start([request('dash', { variantId: 'video-0', audioTrackIds: ['audio-0'] })]);
    expect(result.created).toEqual([{ taskId: 'task-1', streamId: 'dash', baseName: 'Sintel_1080p' }]);
  });

  it('sanitises custom names and keeps names unique among active tasks and within a batch', async () => {
    const { service } = await setup({
      existing: [makeTask('old', { output: { baseName: 'My_Movie', format: 'auto' } }), makeTask('done', { status: 'completed', output: { baseName: 'Done', format: 'auto' } })],
    });
    // Different qualities/audio of the same video, so none is a duplicate download.
    const result = await service.start([
      request('hls', { variantId: 'video-0', fileName: 'My:Movie?' }),
      request('hls', { variantId: 'video-1', fileName: 'my movie' }),
      request('hls', { variantId: 'video-2', fileName: 'Done' }),
      request('hls', { variantId: 'video-0', audioTrackIds: ['audio-0'], fileName: 'My_Movie' }),
    ]);
    expect(result.failed).toEqual([]);
    expect(result.created.map((entry) => entry.baseName)).toEqual(['My Movie', 'my movie_2', 'Done', 'My_Movie_2']);
  });

  it('prevents duplicate downloads of the same video, quality and audio', async () => {
    const { service } = await setup();
    const first = await service.start([request('hls', { audioTrackIds: ['audio-0'] })]);
    expect(first.created).toHaveLength(1);
    // Same choice again, with the audio tracks in another order and a fresh token on the manifest URL.
    const again = await service.start([
      request('hls', { audioTrackIds: ['audio-0'] }),
      request('hls', { audioTrackIds: [] }),
      request('hls', { audioTrackIds: [] }),
    ]);
    expect(again.created).toHaveLength(1);
    expect(again.failed).toEqual([
      { streamId: 'hls', message: 'This video is already in the queue with the same quality and audio.' },
      { streamId: 'hls', message: 'This video is already in the queue with the same quality and audio.' },
    ]);
  });

  it('allows downloading again once the earlier download finished or failed', async () => {
    const { service } = await setup({
      existing: [
        makeTask('earlier', {
          status: 'failed',
          source: { protocol: 'hls', manifestUrl: `${MASTER}?token=old`, title: 'Big Buck Bunny', tabId: 3, streamId: 'hls' },
        }),
      ],
    });
    expect((await service.start([request('hls')])).created).toHaveLength(1);
  });

  it('refuses SAMPLE-AES encrypted streams up front', async () => {
    const { service, streams } = await setup();
    const sampleAes = 'https://cdn.example.com/sample/index.m3u8';
    SITE[sampleAes] = hlsSampleAes;
    streams.set('sample', baseStream('sample', sampleAes, { media: { variants: [{ id: 'video-0', audioOnly: false, audioTrackIds: [] }], audioTracks: [] } }));
    const result = await service.start([request('sample')]);
    expect(result.failed).toEqual([{ streamId: 'sample', message: 'SAMPLE-AES encrypted streams are not supported yet.' }]);
  });

  it('refuses each invalid request with a reason, without failing the others', async () => {
    const { service, store } = await setup();
    const result = await service.start([
      request('hls'),
      request('gone'),
      request('pending'),
      request('drm'),
      request('live'),
      request('hls', { variantId: 'video-9' }),
      request('hls', { audioTrackIds: ['audio-9'] }),
      request('expired'),
    ]);
    expect(result.created.map((entry) => entry.streamId)).toEqual(['hls']);
    expect(result.failed).toEqual([
      { streamId: 'gone', message: 'This video is no longer listed. Reload the page and play it again.' },
      { streamId: 'pending', message: 'This stream is still being inspected. Try again in a moment.' },
      { streamId: 'drm', message: 'Protected by Widevine DRM. DRM-protected streams are not supported.' },
      { streamId: 'live', message: 'Live streams cannot be downloaded yet.' },
      { streamId: 'hls', message: 'The selected quality is no longer offered. Reopen the list and choose again.' },
      { streamId: 'hls', message: 'The selected audio track is no longer offered for this quality.' },
      { streamId: 'expired', message: result.failed.at(-1)?.message ?? '' },
    ]);
    expect(result.failed.at(-1)?.message).toMatch(/^Access denied \(HTTP 403\)/);
    expect(await store.list()).toHaveLength(1);
  });

  it('finds the chosen quality by resolution when variant positions changed since the list was shown', async () => {
    const { service, streams } = await setup();
    const stream = streams.get('hls');
    if (!stream?.media) throw new Error('fixture');
    // The popup listed 720p as "video-0" (an older version of the manifest).
    stream.media.variants = [{ id: 'video-0', height: 720, bandwidth: 3200000, audioOnly: false, audioTrackIds: [] }];
    const result = await service.start([request('hls', { variantId: 'video-0' })]);
    expect(result.created[0]?.baseName).toBe('Big_Buck_Bunny_720p');
  });
});

describe('TaskService.remove', () => {
  it('removes queued and finished tasks but not running ones', async () => {
    const { service, store } = await setup({
      existing: [makeTask('q'), makeTask('running', { status: 'downloading' }), makeTask('done', { status: 'completed' })],
    });
    await expect(service.remove(['q', 'running', 'done', 'missing'])).resolves.toEqual(['q', 'done']);
    expect((await store.list()).map((task) => task.id)).toEqual(['running']);
  });
});

describe('parseDownloadRequests', () => {
  it('keeps well-formed requests only', () => {
    expect(
      parseDownloadRequests({
        requests: [
          request('hls', { audioTrackIds: ['audio-0'], fileName: 'x' }),
          { ...request('hls'), tabId: -1 },
          { ...request('hls'), variantId: '' },
          { ...request('hls'), audioTrackIds: [1] },
          { ...request('hls'), fileName: 'x'.repeat(600) },
          'nope',
        ],
      }),
    ).toEqual([request('hls', { audioTrackIds: ['audio-0'], fileName: 'x' })]);
    expect(parseDownloadRequests(null)).toEqual([]);
  });
});
