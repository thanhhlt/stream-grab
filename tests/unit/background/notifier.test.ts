import { describe, expect, it } from 'vitest';
import { fileNameOf, notificationContent, notificationIdOf, taskIdOfNotification } from '@/background/notifier';
import { makeTask } from '@tests/fakes/tasks';

describe('notifications', () => {
  it('names the saved file and its size when a video is saved', () => {
    const task = makeTask('a', {
      status: 'completed',
      output: { baseName: 'Movie', format: 'auto', downloadId: 3, saved: { path: 'C:\\Users\\me\\Downloads\\Movie (1).mp4', bytes: 3_500_000, savedAt: 1 } },
    });
    expect(notificationContent('completed', task)).toEqual({
      title: 'Video saved',
      message: 'Movie (1).mp4 · 3.3 MB',
      contextMessage: 'Click to show it in its folder',
    });
  });

  it('gives the title and a shortened reason when a task fails', () => {
    const task = makeTask('b', { status: 'failed', statusMessage: 'x'.repeat(300) });
    const content = notificationContent('failed', task);
    expect(content).toMatchObject({ title: 'Download failed', message: 'Movie' });
    expect(content.contextMessage).toHaveLength(140);
  });

  it('ties notifications to tasks', () => {
    expect(taskIdOfNotification(notificationIdOf('t-1'))).toBe('t-1');
    expect(taskIdOfNotification('other')).toBeUndefined();
    expect(fileNameOf('/home/me/Downloads/a.mkv')).toBe('a.mkv');
  });
});
