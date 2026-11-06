import { describe, expect, it } from 'vitest';
import { iso6392 } from '@/core/media/languages';
import { buildMergeJob, trackRuns, type MergeTrack } from '@/core/media/merge-plan';
import type { TrackAnalysis, TrackLayout } from '@/core/models/media-info';

const layout = (overrides: Partial<TrackLayout> = {}): TrackLayout => ({
  trackId: 'main',
  trackType: 'main',
  segments: 4,
  initIndexes: [],
  discontinuityIndexes: [],
  container: 'mpeg-ts',
  durationSec: 16,
  ...overrides,
});

describe('trackRuns', () => {
  it('keeps a plain MPEG-TS track as one run', () => {
    expect(trackRuns(layout())).toEqual([[0, 1, 2, 3]]);
  });

  it('cuts MPEG-TS tracks at discontinuities', () => {
    expect(trackRuns(layout({ segments: 6, discontinuityIndexes: [2, 4] }))).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });

  it('starts a run at each init segment of fragmented MP4', () => {
    expect(trackRuns(layout({ segments: 6, container: 'fmp4', initIndexes: [0, 3], discontinuityIndexes: [3] }))).toEqual([
      [0, 1, 2],
      [3, 4, 5],
    ]);
  });

  it('gives a run that starts without its own init segment the current one', () => {
    expect(trackRuns(layout({ segments: 5, container: 'fmp4', initIndexes: [0], discontinuityIndexes: [3] }))).toEqual([
      [0, 1, 2],
      [0, 3, 4],
    ]);
  });

  it('drops a run that is only an init segment', () => {
    expect(trackRuns(layout({ segments: 4, container: 'fmp4', initIndexes: [0, 3] }))).toEqual([[0, 1, 2]]);
  });
});

const video: TrackAnalysis = {
  trackId: 'main',
  trackType: 'main',
  format: 'mpegts',
  bytes: 1,
  segments: 4,
  durationSec: 16,
  startSec: 1.4,
  streams: [{ kind: 'video', codec: 'h264', width: 1280, height: 720 }],
};
const english: TrackAnalysis = {
  trackId: 'audio-0',
  trackType: 'audio',
  name: 'English',
  format: 'mpegts',
  bytes: 1,
  segments: 4,
  durationSec: 16.02,
  startSec: 1.42,
  streams: [{ kind: 'audio', codec: 'aac', channels: 2 }],
};
const blob = new Blob(['x']);

function tracks(): MergeTrack[] {
  return [
    { layout: layout(), analysis: video, runs: [blob] },
    { layout: layout({ trackId: 'audio-0', trackType: 'audio', name: 'English', language: 'en', durationSec: 16 }), analysis: english, runs: [blob] },
  ];
}

describe('buildMergeJob', () => {
  it('maps video and audio, keeps their relative timing, names and tags the audio, and writes MP4', () => {
    const plan = buildMergeJob(tracks(), { container: 'mp4', title: 'My\u0007 Movie\n' });
    expect(plan.job.args).toEqual([
      '-hide_banner',
      '-stats',
      '-i',
      '/in/t1.ts',
      '-itsoffset',
      '0.020', // audio starts 20 ms after the video
      '-i',
      '/in/t2.ts',
      '-map',
      '0:V?',
      '-map',
      '0:a?',
      '-map',
      '1:a',
      '-c',
      'copy',
      '-map_metadata',
      '-1',
      '-max_muxing_queue_size',
      '4096',
      '-metadata',
      'title=My Movie',
      '-metadata:s:a:0',
      'language=eng',
      '-metadata:s:a:0',
      'title=English',
      '-metadata:s:a:0',
      'handler_name=English',
      '-disposition:a:0',
      'default',
      '-f',
      'mp4',
      '/out/output.mp4',
    ]);
    expect(plan.job.inputs.map((input) => input.name)).toEqual(['t1.ts', 't2.ts']);
    expect(plan.job.outputs).toEqual(['output.mp4']);
    expect(plan.expectedStreams).toEqual({ video: 1, audio: 1 });
    expect(plan.expectedSeconds).toBeCloseTo(16.04, 2);
  });

  it('joins several runs with the concat demuxer', async () => {
    const [main, audio] = tracks();
    const plan = buildMergeJob(
      [
        { ...main!, layout: layout({ discontinuityIndexes: [2] }), runs: [blob, blob] },
        audio!,
      ],
      { container: 'mkv' },
    );
    expect(plan.job.args.slice(2, 9)).toEqual(['-f', 'concat', '-safe', '0', '-i', '/in/t1.ffconcat', '-itsoffset']);
    const list = plan.job.inputs.find((input) => input.name === 't1.ffconcat');
    expect(await list?.data.text()).toBe("ffconcat version 1.0\nfile '/in/t1r1.ts'\nfile '/in/t1r2.ts'\n");
    expect(plan.job.inputs.map((input) => input.name)).toEqual(['t1r1.ts', 't1r2.ts', 't1.ffconcat', 't2.ts']);
    expect(plan.job.args.slice(-3)).toEqual(['-f', 'matroska', '/out/output.mkv']);
    // Matroska keeps titles itself: no handler name.
    expect(plan.job.args).not.toContain('handler_name=English');
  });

  it('keeps muxed audio first, makes only the first audio default, and tags HEVC for Apple players', () => {
    const main: TrackAnalysis = {
      ...video,
      streams: [
        { kind: 'video', codec: 'hevc' },
        { kind: 'audio', codec: 'aac', language: 'fre' },
      ],
    };
    const plan = buildMergeJob([{ layout: layout(), analysis: main, runs: [blob] }, tracks()[1]!], { container: 'mp4' });
    const args = plan.job.args.join(' ');
    expect(args).toContain('-metadata:s:a:0 language=fre -disposition:a:0 default');
    expect(args).toContain('-metadata:s:a:1 language=eng -metadata:s:a:1 title=English -metadata:s:a:1 handler_name=English -disposition:a:1 0');
    expect(args).toContain('-tag:v hvc1');
    expect(plan.expectedStreams).toEqual({ video: 1, audio: 2 });
  });

  it('does not name a track after its language code', () => {
    const [main, audio] = tracks();
    const plan = buildMergeJob([main!, { ...audio!, layout: { ...audio!.layout, name: 'EN', language: 'en' } }], { container: 'mkv' });
    expect(plan.job.args.join(' ')).not.toContain('title=EN');
  });
});

describe('iso6392', () => {
  it('turns manifest language tags into the codes MP4 stores', () => {
    expect(iso6392('en')).toBe('eng');
    expect(iso6392('pt-BR')).toBe('por');
    expect(iso6392('zh_Hant')).toBe('zho');
    expect(iso6392('fre')).toBe('fre');
    expect(iso6392('und')).toBeUndefined();
    expect(iso6392('english')).toBeUndefined();
    expect(iso6392(undefined)).toBeUndefined();
  });
});
