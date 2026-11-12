// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectionStorageKey } from '@/core/detection/detection-store';
import type { DetectedStream } from '@/core/models/detected-stream';
import { DetectedPage } from '@/popup/pages/DetectedPage';
import { click, installPopupChrome, render } from '@tests/fakes/popup-dom';

/**
 * Tab Detected (v0.2.0): tiêu đề nổi bật, thông tin phụ gọn, chọn chất lượng
 * ngay trên thẻ, audio vẫn chọn được, tải riêng từng video và tải hàng loạt
 * có số lượng đã chọn.
 */

const TAB = { id: 7, url: 'https://video.example.com/watch/42' };

const stream = (id: string, overrides: Partial<DetectedStream> = {}): DetectedStream => ({
  id,
  tabId: TAB.id,
  frameId: 0,
  protocol: 'hls',
  url: `https://cdn.example.com/vod/${id}.m3u8`,
  dedupeKey: `https://cdn.example.com/vod/${id}.m3u8`,
  evidence: ['extension'],
  status: 'ready',
  requestContext: {},
  firstSeen: 1,
  lastSeen: 1,
  title: 'Movie Title',
  pageUrl: TAB.url,
  manifest: { role: 'master', live: false, drmSystems: [], encryption: 'none' },
  media: {
    durationSec: 734,
    variants: [
      { id: 'video-0', height: 1080, bandwidth: 5_000_000, videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2', audioOnly: false, audioTrackIds: ['audio-0', 'audio-1'] },
      { id: 'video-1', height: 720, bandwidth: 2_800_000, videoCodec: 'avc1.64001f', audioCodec: 'mp4a.40.2', audioOnly: false, audioTrackIds: ['audio-0', 'audio-1'] },
    ],
    audioTracks: [
      { id: 'audio-0', name: 'English', isDefault: true },
      { id: 'audio-1', name: 'Français', isDefault: false },
    ],
  },
  ...overrides,
});

let unmount: (() => void) | undefined;
afterEach(() => {
  act(() => unmount?.());
  document.body.innerHTML = '';
});

async function setup() {
  const chrome = await installPopupChrome({
    activeTab: TAB,
    answers: { 'downloads/start': { created: [], failed: [] } },
  });
  const { media: _media, ...locked } = stream('locked', { title: 'Protected video', status: 'drm', statusMessage: 'Widevine DRM' });
  const streams = [
    stream('first'),
    stream('second', { protocol: 'dash', url: 'https://cdn.example.com/vod/second.mpd', dedupeKey: 'https://cdn.example.com/vod/second.mpd' }),
    stream('other', { title: 'Another video' }),
    locked,
  ];
  await chrome.session.set({ [detectionStorageKey(TAB.id)]: { version: 1, tabId: TAB.id, generation: 1, streams, updatedAt: 1 } });
  const view = await render(DetectedPage, { onShowQueue: () => undefined });
  unmount = () => view.root.unmount();
  const rows = () => [...view.container.querySelectorAll('li')];
  return { ...chrome, view, rows };
}

const check = async (input: Element | null | undefined) => {
  if (!(input instanceof HTMLInputElement)) throw new Error('no checkbox');
  await act(async () => {
    input.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('Detected tab: progressive files (0.3.0)', () => {
  it('lists MP4 and WebM files next to streams and queues them like streams, with the file extension', async () => {
    const { session, sent } = await installPopupChrome({ activeTab: TAB, answers: { 'downloads/start': { created: [], failed: [] } } });
    const { manifest: _manifest, media: _media, ...base } = stream('base');
    const file = (id: string, container: 'mp4' | 'webm', overrides: Partial<DetectedStream> = {}): DetectedStream => ({
      ...base,
      id,
      protocol: 'progressive',
      url: `https://media.example.net/files/${id}.${container}`,
      dedupeKey: `https://media.example.net/files/${id}.${container}`,
      evidence: ['content-type'],
      progressive: { container, mimeType: `video/${container}`, bytes: 52_428_800, acceptsRanges: true },
      media: { variants: [{ id: 'file', audioOnly: false, audioTrackIds: [] }], audioTracks: [] },
      ...overrides,
    });
    const streams = [
      stream('first'),
      file('trailer', 'mp4', { title: 'Trailer', durationHint: 95 }),
      file('loop', 'webm', { title: 'Background loop' }),
      file('gone', 'mp4', { title: 'Expired clip', status: 'error', statusMessage: 'Access denied (HTTP 403).' }),
    ];
    await session.set({ [detectionStorageKey(TAB.id)]: { version: 1, tabId: TAB.id, generation: 1, streams, updatedAt: 1 } });
    const view = await render(DetectedPage, { onShowQueue: () => undefined });
    unmount = () => view.root.unmount();
    const rows = () => [...view.container.querySelectorAll('li')];
    const [hls, trailer, loop, gone] = rows().map((row) => row.textContent ?? '');

    expect(hls).toContain('HLS');
    expect(trailer).toMatch(/^Trailer/);
    expect(trailer).toContain('MP4');
    expect(trailer).toContain('1:35');
    expect(loop).toContain('WebM');
    expect(gone).toContain('Unavailable');
    expect(gone).toContain('Access denied (HTTP 403).');
    expect((rows()[3]?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.disabled).toBe(true);

    // The options show the file's own extension (not the output format's).
    const options = [...(rows()[2]?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.startsWith('Options'));
    await act(async () => {
      options?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(rows()[2]?.textContent).toContain('.webm');

    await click(view.container, 'Download Trailer');
    expect(sent.at(-1)).toEqual({
      type: 'downloads/start',
      payload: { requests: [{ tabId: TAB.id, streamId: 'trailer', variantId: 'file', audioTrackIds: [], fileName: 'Trailer' }] },
    });
  });
});

describe('Detected tab', () => {
  it('shows the title first, then protocol, site and duration, without codecs or manifest names unless needed', async () => {
    const { rows } = await setup();
    const [first, second, other, locked] = rows().map((row) => row.textContent ?? '');
    expect(first).toMatch(/^Movie Title/);
    expect(first).toContain('HLS');
    expect(first).toContain('video.example.com');
    expect(first).toContain('12:14');
    expect(second).toContain('DASH');
    // Hai video cùng tiêu đề: tên file manifest giúp phân biệt; tiêu đề riêng thì không cần.
    expect(first).toContain('first.m3u8');
    expect(second).toContain('second.mpd');
    expect(other).not.toContain('other.m3u8');
    // Codec chỉ hiện trong phần mở rộng; trạng thái "Ready" không chiếm chỗ.
    expect(first).not.toContain('H.264');
    expect(first).not.toContain('Ready');
    expect(locked).toContain('DRM · not supported');
    expect(locked).toContain('Widevine DRM');
  });

  it('offers a compact quality selector, audio tracks behind one toggle, and a download button per video', async () => {
    const { view, rows, sent } = await setup();
    const select = rows()[2]?.querySelector('select');
    expect(select?.getAttribute('aria-label')).toBe('Quality of Another video');
    expect([...(select?.options ?? [])].map((option) => option.textContent)).toEqual(['1080p', '720p']);
    await act(async () => {
      if (!select) return;
      select.value = 'video-1';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const toggle = [...(rows()[2]?.querySelectorAll('button') ?? [])].find((button) => button.textContent?.startsWith('Audio: English'));
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const panel = rows()[2]?.textContent ?? '';
    expect(panel).toContain('Français');
    expect(panel).toContain('DetailsHLS · H.264 · AAC');
    await check([...(rows()[2]?.querySelectorAll('input[type="checkbox"]') ?? [])].find((input) => input.parentElement?.textContent?.startsWith('Français')));

    await click(view.container, 'Download Another video');
    expect(sent.at(-1)).toEqual({
      type: 'downloads/start',
      payload: { requests: [{ tabId: TAB.id, streamId: 'other', variantId: 'video-1', audioTrackIds: ['audio-0', 'audio-1'], fileName: 'Another_video_720p' }] },
    });
  });

  it('counts the selected videos in the bulk download button and marks selected cards', async () => {
    const { view, rows, sent } = await setup();
    const bulk = () => [...view.container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Download selected'));
    expect(bulk()?.textContent).toBe('Download selected');
    expect(bulk()?.disabled).toBe(true);
    // The DRM-protected video cannot be selected.
    expect(rows()[3]?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true);

    await check(rows()[0]?.querySelector('input[type="checkbox"]'));
    await check(rows()[2]?.querySelector('input[type="checkbox"]'));
    expect(view.container.textContent).toContain('2 of 3 selected');
    expect(bulk()?.textContent).toBe('Download selected (2)');
    expect(rows()[0]?.dataset.selected).toBe('true');
    expect(rows()[1]?.dataset.selected).toBe('false');

    await click(view.container, 'Download selected (2)');
    const request = sent.at(-1) as { type: string; payload: { requests: { streamId: string }[] } };
    expect(request.type).toBe('downloads/start');
    expect(request.payload.requests.map((entry) => entry.streamId)).toEqual(['first', 'other']);
  });
});

describe('Detected tab: grab animation (0.5.0)', () => {
  it('hands the poster tiles of the videos that were queued, and only those, to the animation', async () => {
    const { session } = await installPopupChrome({
      activeTab: TAB,
      answers: {
        'downloads/start': {
          created: [{ taskId: 'task-1', streamId: 'first', baseName: 'Movie_Title' }],
          failed: [{ streamId: 'other', message: 'The playlist could not be read.' }],
        },
      },
    });
    await session.set({ [detectionStorageKey(TAB.id)]: { version: 1, tabId: TAB.id, generation: 1, streams: [stream('first'), stream('other', { title: 'Another video' })], updatedAt: 1 } });
    // happy-dom has no layout: give every element a visible box.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 52, 52));
    const queued: HTMLElement[][] = [];
    const view = await render(DetectedPage, {
      onShowQueue: () => undefined,
      onQueued: (tiles: HTMLElement[]) => {
        queued.push(tiles);
      },
    });
    unmount = () => view.root.unmount();
    const rows = () => [...view.container.querySelectorAll('li')];

    await check(rows()[0]?.querySelector('input[type="checkbox"]'));
    await check(rows()[1]?.querySelector('input[type="checkbox"]'));
    await click(view.container, 'Download selected (2)');

    expect(queued).toHaveLength(1);
    expect(queued[0]?.map((tile) => tile.closest('li')?.dataset.streamId)).toEqual(['first']);
    expect(queued[0]?.[0]?.getAttribute('data-poster')).toBe('play');
    expect(rows()[1]?.textContent).toContain('The playlist could not be read.');
    vi.restoreAllMocks();
  });
});

describe('Detected tab: subtitles (0.7.0)', () => {
  it('ticks the subtitles of the Settings languages, says where they go, and sends the chosen ones', async () => {
    const chrome = await installPopupChrome({
      activeTab: TAB,
      settings: { subtitleLanguages: 'vi', subtitleMode: 'both' },
      answers: { 'downloads/start': { created: [], failed: [] } },
    });
    const base = stream('subbed');
    const media = base.media ?? { variants: [], audioTracks: [] };
    const subbed: DetectedStream = {
      ...base,
      media: {
        ...media,
        variants: media.variants.map((variant) => ({ ...variant, subtitleTrackIds: ['sub-en', 'sub-vi', 'sub-en-forced'] })),
        subtitleTracks: [
          { id: 'sub-en', name: 'English', language: 'en', isDefault: true },
          { id: 'sub-vi', name: 'Tiếng Việt', language: 'vi', isDefault: false },
          { id: 'sub-en-forced', name: 'English', language: 'en', isDefault: false, forced: true },
        ],
      },
    };
    const { media: _media, ...plain } = stream('plain', { title: 'Plain video' });
    const noAudio = { ...plain, media: { variants: [{ id: 'file', audioOnly: false, audioTrackIds: [], subtitleTrackIds: ['sub-vi'] }], audioTracks: [], subtitleTracks: [{ id: 'sub-vi', name: 'Tiếng Việt', language: 'vi', isDefault: false }] } };
    await chrome.session.set({ [detectionStorageKey(TAB.id)]: { version: 1, tabId: TAB.id, generation: 1, streams: [subbed, noAudio], updatedAt: 1 } });
    const view = await render(DetectedPage, { onShowQueue: () => undefined });
    unmount = () => view.root.unmount();
    const row = () => view.container.querySelectorAll('li')[0];

    const toggle = [...(row()?.querySelectorAll('button') ?? [])].find((button) => button.getAttribute('aria-controls') !== null);
    expect(toggle?.textContent).toBe('English · 1 sub');
    expect(toggle?.getAttribute('title')).toBe('Audio tracks, subtitles and file name');
    const otherToggle = [...(view.container.querySelectorAll('li')[1]?.querySelectorAll('button') ?? [])].find((button) => button.getAttribute('aria-controls') !== null);
    expect(otherToggle?.textContent).toBe('Subtitles: Tiếng Việt');

    await act(async () => {
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const boxes = () => [...(row()?.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]') ?? [])];
    const box = (label: string) => boxes().find((input) => input.parentElement?.textContent === label);
    expect(box('Tiếng Việt')?.checked).toBe(true);
    expect(box('English')?.checked).toBe(false);
    expect(box('English (forced)')?.checked).toBe(false);
    expect(row()?.textContent).toContain('Added to the video and saved as SRT files next to the video');
    await check(box('English'));
    expect(toggle?.textContent).toBe('English · 2 subs');

    await click(view.container, 'Download Movie Title');
    expect(chrome.sent.at(-1)).toEqual({
      type: 'downloads/start',
      payload: {
        requests: [
          {
            tabId: TAB.id,
            streamId: 'subbed',
            variantId: 'video-0',
            audioTrackIds: ['audio-0'],
            subtitleTrackIds: ['sub-vi', 'sub-en'],
            fileName: 'Movie_Title_1080p',
          },
        ],
      },
    });
  });
});
