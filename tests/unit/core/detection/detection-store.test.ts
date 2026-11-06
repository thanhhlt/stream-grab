import { describe, expect, it } from 'vitest';
import {
  detectionStorageKey,
  parseStoredTabDetections,
  SessionDetectionStore,
  type StoredTabDetections,
} from '@/core/detection/detection-store';
import type { DetectedStream } from '@/core/models/detected-stream';
import { FakeStorageArea } from '@tests/fakes/fake-storage';

const stream: DetectedStream = {
  id: 's1',
  tabId: 4,
  frameId: 0,
  protocol: 'dash',
  url: 'https://a.example/x.mpd',
  dedupeKey: 'https://a.example/x.mpd',
  evidence: ['extension', 'content-type'],
  status: 'ready',
  manifest: { role: 'presentation', live: false, drmSystems: [], encryption: 'none' },
  requestContext: { referer: 'https://site.example/' },
  title: 'A video',
  durationHint: 30,
  firstSeen: 1,
  lastSeen: 2,
  inspectedAt: 3,
};

const record: StoredTabDetections = { version: 1, tabId: 4, generation: 2, pageUrl: 'https://site.example/', streams: [stream], updatedAt: 9 };

describe('SessionDetectionStore', () => {
  it('round-trips a tab record under a per-tab key', async () => {
    const area = new FakeStorageArea('session');
    const store = new SessionDetectionStore(area);
    await store.save(record);
    expect([...area.data.keys()]).toEqual([detectionStorageKey(4)]);
    await expect(store.load(4)).resolves.toEqual(record);
    await store.remove(4);
    await expect(store.load(4)).resolves.toBeNull();
  });
});

describe('parseStoredTabDetections', () => {
  it('rejects unusable records', () => {
    for (const raw of [undefined, null, 'x', { version: 2, tabId: 1, generation: 0, streams: [] }, { version: 1, streams: [] }]) {
      expect(parseStoredTabDetections(raw)).toBeNull();
    }
  });

  it('keeps progressive files with their container and validated details, and drops them without a container', () => {
    const { manifest: _manifest, ...base } = stream;
    const file = { ...base, id: 'p1', protocol: 'progressive', url: 'https://a.example/clip.webm', dedupeKey: 'https://a.example/clip.webm' };
    const parsed = parseStoredTabDetections({
      ...record,
      streams: [
        {
          ...file,
          progressive: { container: 'webm', mimeType: 'video/webm', bytes: 52_428_800, acceptsRanges: true, fileName: 'clip.webm', junk: 1 },
        },
        { ...file, id: 'p2', progressive: { container: 'mp4', bytes: -5, acceptsRanges: 'yes', mimeType: 42 } },
        { ...file, id: 'p3', progressive: { container: 'mkv' } },
        { ...file, id: 'p4' },
      ],
    });
    expect(parsed?.streams.map((entry) => [entry.id, entry.progressive])).toEqual([
      ['p1', { container: 'webm', mimeType: 'video/webm', bytes: 52_428_800, acceptsRanges: true, fileName: 'clip.webm' }],
      ['p2', { container: 'mp4' }],
    ]);
    // HLS/DASH streams are unchanged and carry no progressive details.
    expect(parseStoredTabDetections(record)?.streams[0]).toEqual(stream);
  });

  it('drops invalid streams and unknown enum values but keeps valid ones', () => {
    const parsed = parseStoredTabDetections({
      ...record,
      streams: [
        { ...stream, evidence: ['extension', 'telepathy'], manifest: { ...stream.manifest, drmSystems: ['widevine', 'x'] } },
        { ...stream, id: 's2', status: 'exploded' },
        { ...stream, id: 's3', protocol: 'smooth' },
        'garbage',
      ],
    });
    expect(parsed?.streams).toHaveLength(1);
    expect(parsed?.streams[0]?.evidence).toEqual(['extension']);
    expect(parsed?.streams[0]?.manifest?.drmSystems).toEqual(['widevine']);
  });

  it('validates the media summary', () => {
    const parsed = parseStoredTabDetections({
      ...record,
      streams: [
        {
          ...stream,
          media: {
            durationSec: 'long',
            variants: [{ id: 'video-0', height: 1080, width: -5, videoCodec: 'avc1.640028', audioOnly: 'no', audioTrackIds: ['audio-0', 7] }, { height: 720 }, null],
            audioTracks: [{ id: 'audio-0', name: 'English', language: 'en', isDefault: true }, { id: 'audio-1', language: 'fr' }],
          },
        },
      ],
    });
    expect(parsed?.streams[0]?.media).toEqual({
      variants: [{ id: 'video-0', height: 1080, videoCodec: 'avc1.640028', audioOnly: false, audioTrackIds: ['audio-0'] }],
      audioTracks: [{ id: 'audio-0', name: 'English', language: 'en', isDefault: true }],
    });
  });
});
