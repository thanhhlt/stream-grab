import type { FfmpegJob, FfmpegResult, FfmpegRunner, FfmpegRunOptions } from '@/core/media/ffmpeg-job';

/** An FfmpegRunner whose answers the test decides (no FFmpeg involved). */
export class ScriptedRunner implements FfmpegRunner {
  readonly jobs: FfmpegJob[] = [];
  readonly #answer: (job: FfmpegJob, options: FfmpegRunOptions) => Promise<FfmpegResult>;

  constructor(answer: (job: FfmpegJob, options: FfmpegRunOptions) => Promise<FfmpegResult>) {
    this.#answer = answer;
  }

  run(job: FfmpegJob, options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
    this.jobs.push(job);
    options.onStarted?.();
    return this.#answer(job, options);
  }
}

/** What ffprobe prints for an input with these streams. */
export function probeResult(streams: object[], format = 'mpegts'): FfmpegResult {
  return {
    exitCode: undefined,
    stdout: JSON.stringify({ streams, format: { format_name: format } }),
    stderrTail: [],
    outputs: [],
    runMs: 1,
    loadMs: 0,
  };
}

const VIDEO = { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 };
const AUDIO = { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' };

/**
 * Stands in for FFmpeg in download tests whose segments are filler bytes
 * (they prove storage order, not media handling):
 * - probes: the first track holds H.264 video, other tracks AAC audio, and the
 *   merged file one video plus one audio stream per audio track merged;
 * - the merge writes its inputs one after the other (concat lists skipped),
 *   so the saved file shows the order in which segments were assembled.
 */
export function fakeFfmpeg(): ScriptedRunner {
  let audioTracks = 0;
  return new ScriptedRunner((job) => {
    if (job.tool === 'ffmpeg') {
      const inputs = job.inputs.filter((input) => !input.name.endsWith('.ffconcat'));
      audioTracks = new Set(inputs.map((input) => /^t(\d+)/.exec(input.name)?.[1])).size - 1;
      const name = job.outputs[0] ?? 'output.mp4';
      return Promise.resolve({ ...probeResult([]), exitCode: 0, stdout: '', outputs: [{ name, data: new Blob(inputs.map((input) => input.data)) }] });
    }
    const name = job.inputs[0]?.name ?? '';
    if (name.startsWith('output.')) return Promise.resolve(probeResult([VIDEO, ...Array.from({ length: audioTracks }, () => AUDIO)], 'mov,mp4,m4a,3gp,3g2,mj2'));
    return Promise.resolve(probeResult(name.startsWith('track-1') ? [VIDEO] : [AUDIO]));
  });
}
