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
    expect(text).toContain('Merging the tracks into one file · 63%');
    expect(text).toContain('Saving to the Downloads folder…');
    expect(text).toContain('H.264 1280×720 · English: AAC stereo → MP4');
    expect(text).toContain('Finished');
    expect(text).toContain('Movie (1).mp4');
    expect(text).toContain('Saved · 5.0 MB');
    expect(text).toContain('Not enough disk space to merge this video.');
    expect(view.container.querySelectorAll('[role="progressbar"]')).toHaveLength(2);
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

describe('Completed tab', () => {
  it('lists saved videos with name and size, newest first, and marks files that are gone', async () => {
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
    expect(rows[0]).toContain('Movie.mp4');
    expect(rows[0]).toContain('5.0 MB');
    expect(rows[1]).toContain('Lecture.mkv');
    expect(rows[1]).toContain('File moved or deleted');
    expect(view.container.textContent).toContain('2 videos · 779 MB');

    await click(view.container, 'Show Movie.mp4 in its folder');
    expect(shown).toEqual([9]);
    // The missing file has no "Show in folder"; removing an entry never touches the file.
    expect(view.container.querySelector('[aria-label="Show Lecture.mkv in its folder"]')).toBeNull();
    await click(view.container, 'Remove Movie from the list');
    expect(sent.at(-1)).toEqual({ type: 'downloads/remove', payload: { taskIds: ['newer'] } });
  });

  it('explains where videos will appear when there are none', async () => {
    await installPopupChrome();
    const view = await render(CompletedPage, { tasks: [] });
    unmount = () => view.root.unmount();
    expect(view.container.textContent).toContain('No completed downloads');
  });
});
