import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it } from 'vitest';
import { IndexedDbSegmentStorage } from '@/core/download/download-storage';
import { FfmpegError, type FfmpegRunner } from '@/core/media/ffmpeg-job';
import { MediaManager } from '@/core/media/media-manager';
import { parseProbeOutput, probeJob } from '@/core/media/probe';
import type { MediaTaskSpec, SaveRequest } from '@/core/models/download-task';
import { parseWebVtt } from '@/core/subtitles/webvtt';
import { NodeFfmpegRunner } from '@tests/fakes/ffmpeg-node';
import { MemoryOutputFiles } from '@tests/fakes/output-files';
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

async function process(
  tracks: Parameters<typeof storeSegments>[2],
  subtitles: NonNullable<MediaTaskSpec['subtitles']>,
  format: MediaTaskSpec['format'] = 'mkv',
  runner: FfmpegRunner = ffmpeg,
  files?: MemoryOutputFiles,
) {
  const storage = new IndexedDbSegmentStorage(new IDBFactory());
  await storeSegments(storage, 't', tracks);
  const saves: SaveRequest[] = [];
  const urls = new Map<string, Blob>();
  let next = 0;
  const manager = new MediaManager({
    storage,
    ffmpeg: runner,
    ...(files ? { files } : {}),
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
  manager.sync([{ taskId: 't', job: 'process', format, title: 'Subtitled', subtitles }]);
  await manager.idle();
  const request = saves[0];
  const file = async (trackId: string) => {
    const url = request?.subtitles?.find((subtitle) => subtitle.trackId === trackId)?.url;
    const blob = url ? urls.get(url) : undefined;
    return blob ? { type: blob.type, text: await blob.text() } : undefined;
  };
  const video = () => (request ? urls.get(request.url) : undefined);
  return { request, file, video, manager, urls };
}

/** The subtitle streams of a merged file (ffprobe), and the first one's cues as WebVTT. */
async function embeddedSubtitles(data: Blob, ext: 'mkv' | 'mp4') {
  const name = `merged.${ext}`;
  const probe = await ffmpeg.run({
    tool: 'ffprobe',
    args: ['-hide_banner', '-v', 'error', '-show_streams', '-select_streams', 's', '-of', 'json', `/in/${name}`],
    inputs: [{ name, data }],
    outputs: [],
  });
  const streams = (JSON.parse(probe.stdout) as { streams: { codec_name: string; tags?: Record<string, string>; disposition?: Record<string, number> }[] }).streams;
  const extract = await ffmpeg.run({
    tool: 'ffmpeg',
    args: ['-hide_banner', '-i', `/in/${name}`, '-map', '0:s:0', '-c:s', 'webvtt', '-f', 'webvtt', '/out/first.vtt'],
    inputs: [{ name, data }],
    outputs: ['first.vtt'],
  });
  const text = await extract.outputs.find((output) => output.name === 'first.vtt')?.data?.text();
  return { streams, cues: parseWebVtt(text ?? '')?.cues ?? [] };
}

const embedTracks = (map: string): Parameters<typeof storeSegments>[2] => [
  { trackId: 'main', trackType: 'main', container: 'mpeg-ts', segments: segmentsOf(media.ts.muxed) },
  {
    trackId: 'subtitle-0',
    trackType: 'subtitle',
    container: 'webvtt',
    name: 'English CC',
    language: 'en',
    segments: [vtt(`WEBVTT\n${map}\n\n00:00:01.000 --> 00:00:02.500\nHello\n\n00:00:30.000 --> 00:00:31.000\nLate\n`)],
  },
  {
    trackId: 'subtitle-1',
    trackType: 'subtitle',
    container: 'webvtt',
    name: 'Français',
    language: 'fr',
    segments: [vtt(`WEBVTT\n${map}\n\n00:00:03.000 --> 00:00:04.000\nBonjour\n`)],
  },
];


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
      { protocol: 'hls', format: 'srt', mode: 'file' },
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
      { protocol: 'hls', format: 'vtt', mode: 'file' },
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
      { protocol: 'hls', format: 'vtt', mode: 'file' },
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
      { protocol: 'hls', format: 'srt', mode: 'file' },
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
      { protocol: 'dash', format: 'srt', mode: 'file' },
    );
    expect((await file('subtitle-0'))?.text).toBe('1\r\n00:00:03,000 --> 00:00:04,000\r\nBonjour\r\n');
    expect(request?.subtitles?.[1]).toEqual({ trackId: 'subtitle-1', error: 'The subtitle track is not WebVTT.' });
    expect(request?.media?.tracks.map((track) => track.trackId)).toEqual(['main']);
  });

  it('embeds the subtitles in MKV as WebVTT with language and name, none default, cut at the video end (embed only)', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    const { request, video, urls } = await process(embedTracks(map), { protocol: 'hls', format: 'srt', mode: 'embed' });
    expect(request?.subtitles).toEqual([
      { trackId: 'subtitle-0', embedded: true },
      { trackId: 'subtitle-1', embedded: true },
    ]);
    // Only the video is held: no subtitle file was made.
    expect(urls.size).toBe(1);
    const data = video();
    if (!data) throw new Error('no merged file');
    const { streams, cues } = await embeddedSubtitles(data, 'mkv');
    expect(streams.map((stream) => [stream.codec_name, stream.tags?.['language'], stream.tags?.['title'], stream.disposition?.['default']])).toEqual([
      ['webvtt', 'eng', 'English CC', 0],
      ['webvtt', 'fra', 'Français', 0],
    ]);
    expect(cues.map((cue) => [cue.text, cue.start, cue.end])).toEqual([['Hello', 1, 2.5]]);
  });

  it('embeds the subtitles in MP4 as mov_text and also saves them as files (both)', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    const { request, video, file } = await process(embedTracks(map), { protocol: 'hls', format: 'vtt', mode: 'both' }, 'mp4');
    expect(request?.container).toBe('mp4');
    expect(request?.subtitles?.map((entry) => [entry.trackId, entry.embedded, typeof entry.url])).toEqual([
      ['subtitle-0', true, 'string'],
      ['subtitle-1', true, 'string'],
    ]);
    expect((await file('subtitle-1'))?.text).toContain('00:00:03.000 --> 00:00:04.000\nBonjour');
    const data = video();
    if (!data) throw new Error('no merged file');
    const { streams, cues } = await embeddedSubtitles(data, 'mp4');
    expect(streams.map((stream) => [stream.codec_name, stream.tags?.['language'], stream.tags?.['handler_name'], stream.disposition?.['default']])).toEqual([
      // FFmpeg's MP4 muxer enables the first track of each kind, whatever the disposition says.
      ['mov_text', 'eng', 'English CC', 1],
      ['mov_text', 'fra', 'Français', 0],
    ]);
    expect(cues.map((cue) => [cue.text, cue.start, cue.end])).toEqual([['Hello', 1, 2.5]]);
  });

  it('embeds the tracks with cues within the video; one with none is reported, not embedded', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    const tracks = [...embedTracks(map)];
    const french = tracks[2];
    if (!french) throw new Error('no track');
    tracks[2] = { ...french, segments: [vtt(`WEBVTT\n${map}\n\n00:01:00.000 --> 00:01:01.000\nToo late\n`)] };
    const { request, video } = await process(tracks, { protocol: 'hls', format: 'srt', mode: 'embed' });
    expect(request?.subtitles).toEqual([
      { trackId: 'subtitle-0', embedded: true },
      { trackId: 'subtitle-1', error: 'The subtitle track has no subtitles within the video.' },
    ]);
    const data = video();
    if (!data) throw new Error('no merged file');
    expect((await embeddedSubtitles(data, 'mkv')).streams).toHaveLength(1);
  });

  it('merges the video again without subtitles when they make the merge fail, and saves them as files', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    // An input format FFmpeg does not know makes every merge with subtitles fail.
    const failing: FfmpegRunner = {
      run: (job, options) => ffmpeg.run({ ...job, args: job.args.map((arg) => (arg === 'webvtt' ? 'no-such-format' : arg)) }, options),
    };
    const { request, video, file } = await process(embedTracks(map), { protocol: 'hls', format: 'srt', mode: 'embed' }, 'mkv', failing);
    expect(request?.subtitles?.map((entry) => [entry.trackId, entry.embedded, typeof entry.url])).toEqual([
      ['subtitle-0', undefined, 'string'],
      ['subtitle-1', undefined, 'string'],
    ]);
    expect((await file('subtitle-0'))?.text).toBe('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n');
    const data = video();
    if (!data) throw new Error('no merged file');
    expect((await embeddedSubtitles(data, 'mkv')).streams).toHaveLength(0);
  });

  it('when FFmpeg crashes merging with subtitles, deletes that file and merges again into a new one without them', async () => {
    const map = `X-TIMESTAMP-MAP=MPEGTS:${mpegts(firstPts)},LOCAL:00:00:00.000`;
    const files = new MemoryOutputFiles();
    const disk = new NodeFfmpegRunner({ files });
    const crashing: FfmpegRunner = {
      run: async (job, options) => {
        const result = await disk.run(job, options);
        if (job.inputs.some((input) => input.name === 's1.vtt')) throw new FfmpegError('FFmpeg stopped unexpectedly.', 'crashed');
        return result;
      },
    };
    const { request, video } = await process(embedTracks(map), { protocol: 'hls', format: 'srt', mode: 'embed' }, 'mkv', crashing, files);
    expect(request?.subtitles?.map((entry) => [entry.trackId, entry.embedded, typeof entry.url])).toEqual([
      ['subtitle-0', undefined, 'string'],
      ['subtitle-1', undefined, 'string'],
    ]);
    const [first, second] = files.opened;
    expect(first).toBeDefined();
    expect(second).not.toBe(first);
    expect(files.removed).toContain(first);
    expect(await files.names()).toEqual([second]);
    const data = video();
    if (!data) throw new Error('no merged file');
    expect((await embeddedSubtitles(data, 'mkv')).streams).toHaveLength(0);
  });
});
