import type { DownloadTask } from '@/core/models/download-task';
import type { MediaAnalysis } from '@/core/models/media-info';

/** An analysis as FFmpeg would report it for a 720p H.264 video with English AAC audio. */
export const ANALYSED_MEDIA: MediaAnalysis = {
  analysedAt: 2,
  container: 'mp4',
  tracks: [
    { trackId: 'main', trackType: 'main', format: 'mpegts', bytes: 1000, segments: 10, streams: [{ kind: 'video', codec: 'h264', width: 1280, height: 720 }] },
    {
      trackId: 'audio-0',
      trackType: 'audio',
      name: 'English',
      format: 'mpegts',
      bytes: 100,
      segments: 10,
      streams: [{ kind: 'audio', codec: 'aac', channels: 2, sampleRate: 48000 }],
    },
  ],
};

export function makeTask(id: string, overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    status: 'queued',
    source: { protocol: 'hls', manifestUrl: 'https://cdn.example.com/master.m3u8', title: 'Movie', tabId: 3, streamId: 's1' },
    selection: { variantId: 'video-0', variantLabel: '1080p', height: 1080, audioTrackIds: [], audioTrackNames: [] },
    output: { baseName: `Movie_${id}`, format: 'auto' },
    ...overrides,
  };
}
