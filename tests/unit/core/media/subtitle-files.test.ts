import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { MediaManager } from '@/core/media/media-manager';
import { parseProbeOutput, probeJob } from '@/core/media/probe';
import type { MediaTaskSpec, SaveRequest } from '@/core/models/download-task';
import { parseWebVtt } from '@/core/subtitles/webvtt';
import { NodeFfmpegRunner } from '@tests/fakes/ffmpeg-node';
import { storeSegments, type StoredSegmentSpec } from '@tests/fakes/stored-media';
import { syntheticMedia, type Rendition, type SyntheticMedia } from '@tests/fixtures/media/synthetic-media';

/**
 * Subtitle files of merged videos (0.7.0), with the real FFmpeg core on
 * synthetic MPEG-TS media: cues land on the merged file's timeline (HLS by
 * X-TIMESTAMP-MAP, DASH from the period start, joined runs one after the
 * other), repeats and cues after the video's end go, and a track that cannot
 * be read does not stop the video.
 */

let media: SyntheticMedia;
const ffmpeg = new NodeFfmpegRunner();
/** First timestamp of the muxed rendition, in seconds (the packager does not start at 0). */
let firstPts: number;

beforeAll(async () => {
  media = await syntheticMedia();
  const probe = parseProbeOutput((await ffmpeg.run(probeJob('main.ts', new Blob(media.ts.muxed.segments)))).stdout);
  firstPts = probe?.startSec ?? 0;
}, 60_000);

const segmentsOf = (rendition: Rendition, discontinuity = 0): StoredSegmentSpec[] =>
  rendition.segments.map((body, index) => ({ body, duration: rendition.durations[index] ?? 0, discontinuity }));

const vtt = (text: string, discontinuity = 0): StoredSegmentSpec => ({ body: new TextEncoder().encode(text), duration: 2, discontinuity });

const mpegts = (seconds: number) => Math.round(seconds * 90_000);

async function process(tracks: Parameters<typeof storeSegments>[2], subtitles: NonNullable<MediaTaskSpec['subtitles']>) {
  const storage = new IndexedDbSegmentStorage(new IDBFactory());
  await storeSegments(storage, 't', tracks);
  const saves: SaveRequest[] = [];
  const urls = new Map<string, Blob>();
  let next = 0;
  const manager = new MediaManager({
    storage,
    ffmpeg,
    report: () => undefined,
    save: (request) => {
      saves.push(request);
      return Promise.resolve(true);
    },
    createUrl: (blob) => {
      const url = `blob:test/${++next}`;
      urls.set(url, blob);
      return url;
    },
    revokeUrl: (url) => urls.delete(url),
    reportIntervalMs: 0,
  });
  manager.sync([{ taskId: 't', job: 'process', format: 'mkv', title: 'Subtitled', subtitles }]);
  await manager.idle();
  const request = saves[0];
  const file = async (trackId: string) => {
    const url = request?.subtitles?.find((subtitle) => subtitle.trackId === trackId)?.url;
    const blob = url ? urls.get(url) : undefined;
    return blob ? { type: blob.type, text: await blob.text() } : undefined;
  };
  return { request, file, manager, urls };
}

describe('subtitle files of merged videos (real FFmpeg)', () => {
  it('HLS: times cues by X-TIMESTAMP-MAP on the merged file, drops repeats and cuts at the video’s end (SRT)', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    const { request, file } = await process(
      [
        { trackId: 'main', trackType: 'main', container: 'mpeg-ts', segments: segmentsOf(media.ts.muxed) },
        {
          trackId: 'subtitle-0',
          trackType: 'subtitle',
          container: 'webvtt',
          segments: [
            vtt(`WEBVTT\n${map}\n\n00:00:01.000 --> 00:00:02.500\nHello\n`),
            // The cue repeated in the next segment, one there, and one after the video's end.
            vtt(`WEBVTT\n${map}\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:00:05.000 --> 00:00:06.000\n<v Ann>World</v>\n\n00:00:30.000 --> 00:00:31.000\nLate\n`),
          ],
        },
      ],
      { protocol: 'hls', format: 'srt' },
    );
    expect(request?.container).toBe('mkv');
    expect(request?.subtitles).toEqual([{ trackId: 'subtitle-0', url: expect.any(String) as string, size: expect.any(Number) as number }]);
    expect(await file('subtitle-0')).toEqual({
      type: 'application/x-subrip',
      text: '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:05,000 --> 00:00:06,000\r\nWorld\r\n',
    });
  });

  it('HLS: a cue after a discontinuity lands in the joined run, after the first run’s length (WebVTT)', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    const run = parseProbeOutput((await ffmpeg.run(probeJob('run.ts', new Blob(media.ts.muxed.segments)))).stdout);
    const { file } = await process(
      [
        // The same clip twice: timestamps restart at the discontinuity.
        { trackId: 'main', trackType: 'main', container: 'mpeg-ts', segments: [...segmentsOf(media.ts.muxed), ...segmentsOf(media.ts.muxed, 1)] },
        {
          trackId: 'subtitle-0',
          trackType: 'subtitle',
          container: 'webvtt',
          segments: [vtt(`WEBVTT\n${map}\n\n00:00:01.000 --> 00:00:02.000\nOne\n`), vtt(`WEBVTT\n${map}\n\n00:00:01.000 --> 00:00:02.000\nTwo\n`, 1)],
        },
      ],
      { protocol: 'hls', format: 'vtt' },
    );
    const saved = await file('subtitle-0');
    expect(saved?.type).toBe('text/vtt');
    const cues = parseWebVtt(saved?.text ?? '')?.cues ?? [];
    expect(cues.map((cue) => cue.text)).toEqual(['One', 'Two']);
    expect(cues[0]?.start).toBeCloseTo(1, 3);
    expect(cues[1]?.start).toBeCloseTo(1 + (run?.durationSec ?? 0), 2);
  });

  it('HLS: where timestamps go back inside one run, a segment goes to the part it falls in', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    const run = parseProbeOutput((await ffmpeg.run(probeJob('run.ts', new Blob(media.ts.muxed.segments)))).stdout);
    const empty = (discontinuity: number) => vtt(`WEBVTT\n${map}\n`, discontinuity);
    const cue = (text: string, discontinuity: number) => vtt(`WEBVTT\n${map}\n\n00:00:01.000 --> 00:00:02.000\n${text}\n`, discontinuity);
    const { file } = await process(
      [
        // Run 2 holds the clip twice without a discontinuity between: its timestamps restart halfway.
        {
          trackId: 'main',
          trackType: 'main',
          container: 'mpeg-ts',
          segments: [...segmentsOf(media.ts.muxed), ...segmentsOf(media.ts.muxed, 1), ...segmentsOf(media.ts.muxed, 1)],
        },
        {
          trackId: 'subtitle-0',
          trackType: 'subtitle',
          container: 'webvtt',
          segments: [cue('One', 0), empty(0), empty(0), empty(0), cue('Two', 1), empty(1), empty(1), empty(1), cue('Three', 1), empty(1), empty(1), empty(1)],
        },
      ],
      { protocol: 'hls', format: 'vtt' },
    );
    const cues = parseWebVtt((await file('subtitle-0'))?.text ?? '')?.cues ?? [];
    const length = run?.durationSec ?? 0;
    expect(cues.map((item) => item.text)).toEqual(['One', 'Two', 'Three']);
    expect(cues[1]?.start).toBeCloseTo(1 + length, 2);
    expect(cues[2]?.start).toBeCloseTo(1 + 2 * length, 2);
  });

  it('holds the subtitle files with the video and lets go of them together', async () => {
    const { request, manager, urls } = await process(
      [
        { trackId: 'main', trackType: 'main', container: 'mpeg-ts', segments: segmentsOf(media.ts.muxed) },
        { trackId: 'subtitle-0', trackType: 'subtitle', container: 'webvtt', segments: [vtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n')] },
      ],
      { protocol: 'hls', format: 'srt' },
    );
    expect(urls.size).toBe(2);
    expect(manager.running).toEqual(['t']);
    manager.sync([]);
    expect(urls.size).toBe(0);
    expect(request?.subtitles).toHaveLength(1);
  });

  it('DASH: cues count from the period start; a track that is not WebVTT is reported and the video is still saved', async () => {
    const { request, file } = await process(
      [
        { trackId: 'main', trackType: 'main', container: 'mpeg-ts', segments: segmentsOf(media.ts.muxed) },
        {
          trackId: 'subtitle-0',
          trackType: 'subtitle',
          container: 'webvtt',
          segments: [vtt('WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nBonjour\n'), vtt('not a subtitle file')],
        },
        { trackId: 'subtitle-1', trackType: 'subtitle', container: 'webvtt', segments: [vtt('{"error":"gone"}')] },
      ],
      { protocol: 'dash', format: 'srt' },
    );
    expect((await file('subtitle-0'))?.text).toBe('1\r\n00:00:03,000 --> 00:00:04,000\r\nBonjour\r\n');
    expect(request?.subtitles?.[1]).toEqual({ trackId: 'subtitle-1', error: 'The subtitle track is not WebVTT.' });
    expect(request?.media?.tracks.map((track) => track.trackId)).toEqual(['main']);
  });
});
