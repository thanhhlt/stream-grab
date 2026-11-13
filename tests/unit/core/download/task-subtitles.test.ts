import { describe, expect, it } from 'vitest';
import { summarizeManifest } from '@/core/detection/manifest-inspector';
import { parseEngineTaskSpec } from '@/core/download/engine-messages';
import { parseDownloadRequests, TaskService } from '@/core/download/task-service';
import { parseTask, parseTaskSubtitles, TaskStore } from '@/core/download/task-store';
import { PROGRESSIVE_VARIANT_ID, type DetectedStream } from '@/core/models/detected-stream';
import type { DownloadRequest } from '@/core/models/download-task';
import { ManifestFetcher, type FetchFunction } from '@/core/network/manifest-fetcher';
import { HlsAdapter } from '@/core/protocols/hls/hls-adapter';
import { ProtocolRegistry } from '@/core/protocols/protocol-adapter';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '@/shared/settings/settings';
import { FakeStorageArea } from '@tests/fakes/fake-storage';
import hlsMasterSubtitles from '@tests/fixtures/manifests/hls/master-subtitles.m3u8?raw';
import hlsTs from '@tests/fixtures/manifests/hls/media-ts.m3u8?raw';

const MASTER = 'https://cdn.example.com/show/master.m3u8';
const FILE = 'https://media.example.net/v/clip.mp4';
const SITE: Record<string, string> = {
  [MASTER]: hlsMasterSubtitles,
  'https://cdn.example.com/show/video/720p/index.m3u8': hlsTs,
  'https://cdn.example.com/show/video/360p/index.m3u8': hlsTs,
};
const fetch: FetchFunction = (url) => {
  const body = SITE[url];
  return Promise.resolve(body === undefined ? new Response('missing', { status: 404 }) : new Response(body));
};

function stream(id: string, url: string, overrides: Partial<DetectedStream>): DetectedStream {
  return {
    id,
    tabId: 3,
    frameId: 0,
    protocol: 'hls',
    url,
    dedupeKey: url,
    evidence: ['extension'],
    status: 'ready',
    requestContext: {},
    firstSeen: 1,
    lastSeen: 1,
    title: 'Show',
    ...overrides,
  };
}

async function setup(settings: Partial<Settings> = {}) {
  const fetcher = new ManifestFetcher({ fetch });
  const protocols = new ProtocolRegistry().register(new HlsAdapter({ fetcher }));
  const manifest = await protocols.forProtocol('hls')!.parseManifest(MASTER);
  const streams = new Map<string, DetectedStream>([
    ['hls', stream('hls', MASTER, { manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' }, media: summarizeManifest(manifest) })],
    [
      'file',
      stream('file', FILE, {
        protocol: 'progressive',
        progressive: { container: 'mp4' },
        media: {
          variants: [{ id: PROGRESSIVE_VARIANT_ID, audioOnly: false, audioTrackIds: [], subtitleTrackIds: ['track-0'] }],
          audioTracks: [],
          subtitleTracks: [{ id: 'track-0', name: 'English', language: 'en', isDefault: true, url: 'https://media.example.net/v/en.vtt' }],
        },
      }),
    ],
  ]);
  const store = new TaskStore(new FakeStorageArea('local'), new FakeStorageArea('session'));
  let counter = 0;
  const service = new TaskService({
    store,
    getStream: (_tabId, streamId) => Promise.resolve(streams.get(streamId)),
    protocols,
    getSettings: () => Promise.resolve({ ...DEFAULT_SETTINGS, ...settings }),
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

describe('subtitles in download requests and tasks (0.7.0)', () => {
  it('validates subtitle ids in requests and keeps requests without them', () => {
    const base = { tabId: 1, streamId: 's', variantId: 'v', audioTrackIds: [], fileName: '' };
    expect(
      parseDownloadRequests({
        requests: [
          { ...base, subtitleTrackIds: ['subtitle-1', 'subtitle-0', 'subtitle-1'] },
          base,
          { ...base, subtitleTrackIds: [] },
          { ...base, subtitleTrackIds: [42] },
          { ...base, subtitleTrackIds: 'subtitle-0' },
        ],
      }),
    ).toEqual([{ ...base, subtitleTrackIds: ['subtitle-1', 'subtitle-0'] }, base, base]);
  });

  it('records the chosen manifest subtitles, the subtitle format and where they go on the task', async () => {
    const { service, store } = await setup({ subtitleFormat: 'vtt', subtitleMode: 'both' });
    const result = await service.start([request('hls', { subtitleTrackIds: ['subtitle-1', 'subtitle-2'] })]);
    expect(result.failed).toEqual([]);
    const [task] = await store.list();
    expect(task?.selection.subtitles).toEqual([
      { id: 'subtitle-1', name: 'Tiếng Việt', language: 'vi' },
      { id: 'subtitle-2', name: 'English (forced)', language: 'en', forced: true },
    ]);
    expect(task?.output.subtitleFormat).toBe('vtt');
    expect(task?.output.subtitleMode).toBe('both');
  });

  it('leaves tasks without subtitles unchanged', async () => {
    const { service, store } = await setup();
    await service.start([request('hls')]);
    const [task] = await store.list();
    expect(task?.selection.subtitles).toBeUndefined();
    expect(task?.output.subtitleFormat).toBeUndefined();
    expect(task?.output.subtitleMode).toBeUndefined();
  });

  it('refuses subtitles the chosen quality does not offer', async () => {
    const { service } = await setup();
    const result = await service.start([
      request('hls', { variantId: 'video-1', subtitleTrackIds: ['subtitle-0'] }),
      request('hls', { subtitleTrackIds: ['subtitle-9'] }),
    ]);
    expect(result.created).toEqual([]);
    expect(result.failed.map((failure) => failure.message)).toEqual([
      'The selected subtitles are no longer offered for this quality.',
      'The selected subtitles are no longer offered for this quality.',
    ]);
  });

  it('records a progressive file’s <track> subtitles with their URL (SRT by default; always files)', async () => {
    const { service, store } = await setup({ subtitleMode: 'embed' });
    await service.start([request('file', { variantId: PROGRESSIVE_VARIANT_ID, subtitleTrackIds: ['track-0'] })]);
    const [task] = await store.list();
    expect(task?.selection.subtitles).toEqual([{ id: 'track-0', name: 'English', language: 'en', url: 'https://media.example.net/v/en.vtt' }]);
    expect(task?.output.subtitleFormat).toBe('srt');
    expect(task?.output.subtitleMode).toBeUndefined();
  });

  it('reads stored subtitles back, dropping damaged entries', async () => {
    const { service, store } = await setup({ subtitleFormat: 'vtt', subtitleMode: 'embed' });
    await service.start([request('hls', { subtitleTrackIds: ['subtitle-0'] })]);
    const [task] = await store.list();
    expect(task?.output.subtitleMode).toBe('embed');
    expect(parseTask(JSON.parse(JSON.stringify(task)))).toEqual(task);
    expect(
      parseTaskSubtitles([{ id: 'a', name: 'A', url: 'ftp://x/y.vtt' }, { id: '', name: 'B' }, { id: 'c', name: 'C', language: 'en', forced: 'yes' }, 7]),
    ).toEqual([{ id: 'c', name: 'C', language: 'en' }]);
  });

  it('passes subtitle ids to the engine', () => {
    const spec = {
      taskId: 't',
      protocol: 'hls',
      manifestUrl: MASTER,
      context: {},
      variant: { id: 'video-0' },
      audioTrackIds: [],
      concurrency: 6,
    };
    expect(parseEngineTaskSpec({ ...spec, subtitleTrackIds: ['subtitle-0', 3, 'x'.repeat(65)] })?.subtitleTrackIds).toEqual(['subtitle-0']);
    expect(parseEngineTaskSpec(spec)?.subtitleTrackIds).toBeUndefined();
  });

  it('records a page subtitle file with an HLS stream, after its manifest subtitles (0.7.2)', async () => {
    const { service, store, streams } = await setup({ subtitleMode: 'embed' });
    const hls = streams.get('hls')!;
    const page = { id: 'page-0', name: 'Chinese', language: 'zh', isDefault: false, url: 'https://cdn.example.com/sub/captions.zh.vtt.r2024' };
    hls.media = {
      ...hls.media!,
      subtitleTracks: [...(hls.media!.subtitleTracks ?? []), page],
      variants: hls.media!.variants.map((variant) => ({ ...variant, subtitleTrackIds: [...(variant.subtitleTrackIds ?? []), 'page-0'] })),
    };
    const result = await service.start([request('hls', { variantId: 'video-1', subtitleTrackIds: ['page-0'] })]);
    expect(result.failed).toEqual([]);
    const [task] = await store.list();
    expect(task?.selection.subtitles).toEqual([{ id: 'page-0', name: 'Chinese', language: 'zh', url: page.url }]);
    expect(task?.output.subtitleMode).toBe('embed');
    expect(parseTask(JSON.parse(JSON.stringify(task)))).toEqual(task);
  });

  it('passes page subtitle files to the engine by URL, never for a progressive file (0.7.2)', () => {
    const spec = { taskId: 't', protocol: 'hls', manifestUrl: MASTER, context: {}, variant: { id: 'video-0' }, audioTrackIds: [], concurrency: 6 };
    const zh = { id: 'page-0', url: 'https://cdn.example.com/sub/zh.vtt', name: 'Chinese', language: 'zh' };
    expect(
      parseEngineTaskSpec({
        ...spec,
        subtitleTrackIds: ['subtitle-0'],
        pageSubtitles: [zh, { id: 'page-1', url: 'ftp://x/y.vtt', name: 'X' }, { id: 'subtitle-0', url: zh.url, name: 'Dup' }, 'junk'],
      })?.pageSubtitles,
    ).toEqual([zh]);
    const file = { ...spec, protocol: 'progressive', file: { container: 'mp4' } };
    expect(parseEngineTaskSpec({ ...file, pageSubtitles: [zh] })?.pageSubtitles).toBeUndefined();
  });

  it('defaults the subtitle format to SRT and accepts WebVTT', () => {
    expect(DEFAULT_SETTINGS.subtitleFormat).toBe('srt');
    expect(normalizeSettings({ subtitleFormat: 'vtt' }).subtitleFormat).toBe('vtt');
    expect(normalizeSettings({ subtitleFormat: 'ass' }).subtitleFormat).toBe('srt');
  });
});
