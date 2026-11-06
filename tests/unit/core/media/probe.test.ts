import { describe, expect, it } from 'vitest';
import { parseProbeOutput, probeError, probeJob } from '@/core/media/probe';

const json = (value: unknown): string => JSON.stringify(value, null, 4);

describe('probeJob', () => {
  it('asks ffprobe for format and streams as JSON, on the mounted input', () => {
    const data = new Blob(['x']);
    expect(probeJob('track-1.ts', data)).toEqual({
      tool: 'ffprobe',
      args: ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', '/in/track-1.ts'],
      inputs: [{ name: 'track-1.ts', data }],
      outputs: [],
    });
  });
});

describe('parseProbeOutput', () => {
  it('reads video and audio streams, the container and the duration', () => {
    const output = json({
      streams: [
        { index: 0, codec_name: 'h264', profile: 'High', codec_type: 'video', width: 1280, height: 720, r_frame_rate: '25/1', avg_frame_rate: '30000/1001', tags: { language: 'und' } },
        { index: 1, codec_name: 'aac', profile: 'LC', codec_type: 'audio', sample_rate: '48000', channels: 2, tags: { language: 'eng' } },
        { index: 2, codec_name: 'timed_id3', codec_type: 'data' },
      ],
      format: { format_name: 'mpegts', duration: '480.000000', size: '1000' },
    });
    expect(parseProbeOutput(output)).toEqual({
      format: 'mpegts',
      durationSec: 480,
      streams: [
        { kind: 'video', codec: 'h264', profile: 'High', width: 1280, height: 720, frameRate: 29.97 },
        { kind: 'audio', codec: 'aac', profile: 'LC', channels: 2, sampleRate: 48000, language: 'eng' },
        { kind: 'data', codec: 'timed_id3' },
      ],
    });
  });

  it('does not count cover art as video, and tolerates odd values', () => {
    const output = json({
      streams: [
        { codec_name: 'mjpeg', codec_type: 'video', width: 300, height: 300, disposition: { attached_pic: 1 } },
        { codec_name: 'mp3', codec_type: 'audio', sample_rate: 'N/A', channels: -1 },
        { codec_name: '<script>', codec_type: 'video', avg_frame_rate: '0/0', r_frame_rate: '25/0' },
        { codec_type: 'attachment' },
        { codec_name: 'x', codec_type: 'nonsense' },
        'not a stream',
      ],
      format: { format_name: 'mp3', duration: 'N/A' },
    });
    expect(parseProbeOutput(output)).toEqual({
      format: 'mp3',
      streams: [
        { kind: 'data', codec: 'mjpeg' },
        { kind: 'audio', codec: 'mp3' },
        { kind: 'video', codec: 'unknown' },
        { kind: 'data', codec: 'unknown' },
      ],
    });
  });

  it('returns null when ffprobe could not read the input', () => {
    expect(parseProbeOutput('{\n\n}\n')).toBeNull(); // what ffprobe prints for invalid data
    expect(parseProbeOutput('')).toBeNull();
    expect(parseProbeOutput('{"streams": []}')).toBeNull();
    expect(parseProbeOutput('[1, 2]')).toBeNull();
  });
});

describe('probeError', () => {
  it('names the problem without the internal path', () => {
    expect(probeError(['/in/track-1.ts: Invalid data found when processing input', 'Aborted()'])).toBe('Invalid data found when processing input');
    expect(probeError([])).toBeUndefined();
  });
});
