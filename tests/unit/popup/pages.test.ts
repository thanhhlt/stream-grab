// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DownloadTask, MediaProgress } from '@/core/models/download-task';
import { CompletedPage } from '@/popup/pages/CompletedPage';
import { QueuePage } from '@/popup/pages/QueuePage';
import { click, installPopupChrome, render } from '@tests/fakes/popup-dom';
import { ANALYSED_MEDIA, makeTask } from '@tests/fakes/tasks';

/**
 * The Queue and Completed tabs as the user sees them, rendered with React in
 * happy-dom against a stubbed chrome.*: what each state says, which buttons
 * it offers, and which message each button sends.
 */

const stage = (stage: MediaProgress['stage'], percent: number): MediaProgress => ({ stage, step: 1, steps: 1, percent, startedAt: 1 });
const saved = (id: string, downloadId: number, path: string, bytes: number, savedAt: number): DownloadTask =>
  makeTask(id, { status: 'completed', media: ANALYSED_MEDIA, output: { baseName: id, format: 'auto', downloadId, saved: { path, bytes, savedAt } } });

let unmount: (() => void) | undefined;
afterEach(() => {
  act(() => unmount?.());
  document.body.innerHTML = '';
});

describe('Queue tab', () => {
  const tasks = [
    makeTask('merge', { status: 'processing', processing: stage('merging', 63) }),
    makeTask('save', { status: 'processing', media: ANALYSED_MEDIA, processing: stage('saving', 97), output: { baseName: 'Saving', format: 'auto', downloadId: 4 } }),
    makeTask('fail', { status: 'failed', statusMessage: 'Not enough disk space to merge this video.' }),
    makeTask('fail2', { status: 'failed', statusMessage: 'HTTP 500' }),
    saved('done', 7, 'C:\\Users\\me\\Downloads\\Movie (1).mp4', 5 * 1024 ** 2, 2),
  ];

  it('shows each stage of processing, the finished videos, and failures with their reason', async () => {
    await installPopupChrome();
    const view = await render(QueuePage, { tasks });
    unmount = () => view.root.unmount();
    const text = view.container.textContent ?? '';
    expect(text).toContain('Merging tracks63%');
    expect(text).toContain('Saving file97%');
    expect(text).toContain('H.264 1280×720 · English: AAC stereo → MP4');
    expect(text).toContain('Finished');
    expect(text).toContain('Saved · 5.0 MB');
    expect(text).toContain('Not enough disk space to merge this video.');
    // FFmpeg có thanh tiến độ riêng, tách khỏi tiến độ tải.
    const bars = [...view.container.querySelectorAll('[role="progressbar"]')].map((bar) => bar.getAttribute('aria-label'));
    expect(bars).toEqual(['Processing progress of Movie', 'Processing progress of Movie']);
    // Tên file nằm trong tooltip, không lặp lại bên dưới tiêu đề.
    expect(text).not.toContain('Movie (1).mp4');
    expect(view.container.querySelector('[title*="Movie (1).mp4"]')).not.toBeNull();
  });

  it('shows a running download with percentage, segments, sizes, speed and ETA, and notices a stall', async () => {
    await installPopupChrome();
    const now = Date.now();
    const progress = {
      segmentsTotal: 368,
      segmentsDone: 74,
      bytes: 36.4 * 1024 ** 2,
      bytesPerSecond: 7.4 * 1024 ** 2,
      averageBytesPerSecond: 7.4 * 1024 ** 2,
      percent: 20.1,
      retries: 1,
      startedAt: now - 10_000,
    };
    const running = [
      makeTask('run', { status: 'downloading', updatedAt: now, progress, source: { ...makeTask('x').source, title: 'Test your own stream' } }),
      makeTask('stuck', { status: 'downloading', updatedAt: now - 60_000, progress: { ...progress, startedAt: now - 120_000 } }),
      makeTask('wait', { status: 'queued' }),
      makeTask('ffmpeg', { status: 'downloaded', progress: { ...progress, segmentsDone: 368, percent: 100, bytes: 181 * 1024 ** 2 } }),
    ];
    const view = await render(QueuePage, { tasks: running });
    unmount = () => view.root.unmount();
    const [run, stuck, ffmpeg, wait] = [...view.container.querySelectorAll('li')].map((row) => row.textContent ?? '');
    expect(run).toContain('Test your own stream');
    expect(run).toContain('Downloading20.1%');
    expect(run).toContain('74 / 368 segments');
    expect(run).toContain('36.4 MB / ~181 MB');
    expect(run).toContain('Remaining ~145 MB');
    expect(run).toContain('Speed 7.4 MB/s');
    expect(run).toContain('ETA ~20 seconds');
    expect(run).toContain('1 retry');
    expect(stuck).toContain('Stalled');
    expect(stuck).toContain('ETA —');
    expect(ffmpeg).toContain('Downloaded · 368 segments · 181 MB');
    expect(ffmpeg).toContain('ProcessingWaiting for FFmpeg');
    expect(wait).toContain('Pending');
    expect(wait).toContain('Waiting for a free download slot');
    expect(view.container.querySelector('[aria-label="Download progress of Test your own stream"]')?.getAttribute('aria-valuenow')).toBe('20');
  });

  it('cancels, retries, shows the saved file and clears it from the queue', async () => {
    const { sent, shown } = await installPopupChrome();
    const view = await render(QueuePage, { tasks });
    unmount = () => view.root.unmount();
    await click(view.container, 'Cancel Movie');
    await click(view.container, 'Retry all failed (2)');
    await click(view.container, 'Show in folder Movie');
    await click(view.container, 'Clear all');
    expect(sent).toEqual([
      { type: 'downloads/cancel', payload: { taskIds: ['merge'] } },
      { type: 'downloads/retry', payload: { taskIds: ['fail', 'fail2'] } },
      { type: 'downloads/dismiss', payload: { taskIds: ['done'] } },
    ]);
    expect(shown).toEqual([7]);
  });

  it('leaves finished videos to the Completed tab when Settings say so', async () => {
    await installPopupChrome({ settings: { autoRemoveCompleted: true } });
    const view = await render(QueuePage, { tasks });
    unmount = () => view.root.unmount();
    expect(view.container.textContent).not.toContain('Finished');
    expect(view.container.textContent).not.toContain('Movie (1).mp4');
  });
});

describe('progressive files in the Queue and Completed tabs (0.3.0)', () => {
  const file = (id: string, overrides: Partial<DownloadTask> = {}): DownloadTask =>
    makeTask(id, {
      source: { protocol: 'progressive', manifestUrl: `https://cdn.example.com/${id}.webm`, title: `Clip ${id}`, tabId: 3, streamId: id },
      selection: { variantId: 'file', variantLabel: 'Single quality', audioTrackIds: [], audioTrackNames: [], durationSec: 95 },
      progressive: { container: 'webm', fetch: 'browser' },
      ...overrides,
    });

  it('shows bytes, speed and ETA of a file, never segments or FFmpeg', async () => {
    await installPopupChrome();
    const now = Date.now();
    const progress = {
      segmentsTotal: 1,
      segmentsDone: 0,
      bytes: 20 * 1024 ** 2,
      bytesPerSecond: 2 * 1024 ** 2,
      averageBytesPerSecond: 2 * 1024 ** 2,
      percent: 40,
      retries: 0,
      startedAt: now - 10_000,
      tracks: [{ trackId: 'file', segmentsTotal: 1, segmentsDone: 0, bytes: 20 * 1024 ** 2, declaredBytes: 50 * 1024 ** 2 }],
    };
    const view = await render(QueuePage, { tasks: [file('run', { status: 'downloading', updatedAt: now, progress }), file('new', { status: 'downloading' })] });
    unmount = () => view.root.unmount();
    const [run, starting] = [...view.container.querySelectorAll('li')].map((row) => row.textContent ?? '');
    expect(run).toContain('WebM');
    expect(run).toContain('Downloading40.0%');
    expect(run).toContain('20.0 MB / 50.0 MB');
    expect(run).toContain('Speed 2.0 MB/s');
    expect(run).toContain('ETA ~15 seconds');
    expect(run).not.toContain('segment');
    expect(run).not.toContain('FFmpeg');
    expect(starting).toContain('Starting the download…');
  });

  it('lists a saved file with its real size and container, without invented details', async () => {
    await installPopupChrome();
    const view = await render(CompletedPage, {
      tasks: [file('done', { status: 'completed', output: { baseName: 'Clip done', format: 'auto', downloadId: 3, saved: { path: '/Downloads/Clip done.webm', bytes: 52_428_800, savedAt: 9 } } })],
    });
    unmount = () => view.root.unmount();
    const row = view.container.querySelector('li')?.textContent ?? '';
    expect(row).toContain('Clip done');
    expect(row).toContain('Single quality · 1:35 · 50.0 MB');
    expect(row).toContain('WEBM');
    expect(row).not.toMatch(/H\.264|AAC|MP4/);
    expect(row).toContain('Show in folder');
  });
});

describe('Completed tab', () => {
  it('lists saved videos compactly, newest first, with the real file size, and marks files that are gone', async () => {
    const { sent, shown } = await installPopupChrome({ missingDownloads: [3] });
    const tasks = [
      saved('older', 3, '/home/me/Downloads/Lecture.mkv', 812_000_000, 1),
      saved('newer', 9, '/home/me/Downloads/Movie.mp4', 5 * 1024 ** 2, 9),
      makeTask('running', { status: 'downloading' }),
    ];
    const view = await render(CompletedPage, { tasks });
    unmount = () => view.root.unmount();
    const rows = [...view.container.querySelectorAll('li')].map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    // Tiêu đề; độ phân giải · thời lượng · dung lượng; codec · container. Không lặp tên file trùng tiêu đề, không URL manifest.
    expect(rows[0]).toContain('720p · 5.0 MB');
    expect(rows[0]).toContain('H.264 · AAC Stereo · MP4');
    expect(rows[0]).not.toContain('Movie.mp4');
    expect(rows[0]).not.toContain('cdn.example.com');
    expect(rows[0]).not.toContain('File missing');
    expect(rows[1]).toContain('Saved as Lecture.mkv');
    expect(rows[1]).toContain('774 MB');
    expect(rows[1]).toContain('File missing');
    expect(view.container.textContent).toContain('2 videos·779 MBRemove missing (1)Remove all');

    await click(view.container, 'Show Movie.mp4 in its folder');
    expect(shown).toEqual([9]);
    // The missing file has no "Show in folder"; removing an entry (in the overflow menu) never touches the file.
    expect(view.container.querySelector('[aria-label="Show Lecture.mkv in its folder"]')).toBeNull();
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
    await click(view.container, 'More actions for Movie');
    expect(view.container.querySelector('[role="menu"]')).not.toBeNull();
    await click(view.container, 'Remove from list');
    expect(sent.at(-1)).toEqual({ type: 'downloads/remove', payload: { taskIds: ['newer'] } });
    expect(view.container.querySelector('[role="menu"]')).toBeNull();
  });

  it('removes the entries whose file is missing, and all entries only after a confirmation; files are never touched', async () => {
    const { sent } = await installPopupChrome({ missingDownloads: [3, 5] });
    const tasks = [
      saved('a', 3, '/Downloads/A.mp4', 1_000, 1),
      saved('b', 5, '/Downloads/B.mp4', 1_000, 2),
      saved('c', 9, '/Downloads/C.mp4', 1_000, 3),
    ];
    const view = await render(CompletedPage, { tasks });
    unmount = () => view.root.unmount();
    const dialog = () => view.container.querySelector<HTMLElement>('[role="alertdialog"]');

    await click(view.container, 'Remove missing (2)');
    expect(sent).toEqual([{ type: 'downloads/remove', payload: { taskIds: ['b', 'a'] } }]);

    // Remove all asks first; Cancel and Escape leave the list as it is.
    await click(view.container, 'Remove all');
    expect(dialog()?.textContent).toContain('All 3 entries are removed from this list. The saved files stay in your Downloads folder.');
    expect(document.activeElement?.textContent).toBe('Cancel');
    await click(dialog() ?? view.container, 'Cancel');
    expect(dialog()).toBeNull();
    expect(document.activeElement?.textContent).toBe('Remove all');
    await click(view.container, 'Remove all');
    await act(async () => {
      dialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await Promise.resolve();
    });
    expect(dialog()).toBeNull();
    expect(sent).toHaveLength(1);

    await click(view.container, 'Remove all');
    await click(dialog() ?? view.container, 'Remove all');
    expect(dialog()).toBeNull();
    expect(sent.at(-1)).toEqual({ type: 'downloads/remove', payload: { taskIds: ['c', 'b', 'a'] } });
  });

  it('offers Remove missing only when a file is missing', async () => {
    await installPopupChrome();
    const view = await render(CompletedPage, { tasks: [saved('a', 3, '/Downloads/A.mp4', 1_000, 1)] });
    unmount = () => view.root.unmount();
    expect(view.container.textContent).toContain('Remove all');
    expect(view.container.textContent).not.toContain('Remove missing');
  });

  it('explains where videos will appear when there are none', async () => {
    await installPopupChrome();
    const view = await render(CompletedPage, { tasks: [] });
    unmount = () => view.root.unmount();
    expect(view.container.textContent).toContain('No completed downloads');
  });
});
