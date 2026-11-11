import type { TaskProgress, TrackProgress } from '@/core/models/download-task';

/**
 * Ước lượng dung lượng, tốc độ trung bình và thời gian còn lại (ETA) của một
 * lượt tải — các hàm thuần, dùng chung cho engine (tốc độ trung bình) và
 * popup (hiển thị). Không bịa số liệu:
 *
 * - Kích thước "chính xác" chỉ khi manifest khai báo kích thước từng segment
 *   (byte range không mã hoá) hoặc mọi segment đã tải xong.
 * - Ngược lại, kích thước còn lại được ngoại suy theo TỪNG TRACK: trung bình
 *   bytes/segment đã tải của track × số segment còn lại của track đó. Plan tải
 *   hết track chính (video) rồi mới tới audio, nên ngoại suy trên toàn task
 *   sẽ lệch (gần gấp đôi với audio tách riêng).
 * - Track chưa có đủ mẫu thì không ngoại suy: tổng ước lượng là cận dưới
 *   (`partial`), popup hiển thị kèm dấu "+".
 * - Không có ETA khi chưa đủ dữ liệu: chưa biết số segment (live), chưa đủ
 *   mẫu, tốc độ bằng 0 / đứng yên, hoặc engine mới chạy chưa đủ lâu.
 */

/** Số media segment tối thiểu đã xong của một track trước khi ngoại suy kích thước của track đó. */
export const MIN_SEGMENT_SAMPLES = 3;
/**
 * Thứ tự tải các vị trí còn lại: MIN_SEGMENT_SAMPLES segment đầu còn thiếu của
 * MỖI track đi trước (xen kẽ giữa các track), phần còn lại giữ nguyên thứ tự
 * plan. Nhờ vậy audio tách riêng đủ mẫu ngay từ đầu và kích thước ước lượng
 * không phải đợi cả video tải xong. Chỉ đổi thứ tự tải, không đổi plan.
 */
export function samplesFirst(pending: readonly number[], trackOf: (position: number) => string): number[] {
  const taken = new Map<string, number>();
  const early: number[] = [];
  const rest: number[] = [];
  for (const position of pending) {
    const track = trackOf(position);
    const count = taken.get(track) ?? 0;
    if (count < MIN_SEGMENT_SAMPLES) {
      taken.set(track, count + 1);
      early.push(position);
    } else {
      rest.push(position);
    }
  }
  // Xen kẽ theo "vòng": segment thứ k của mọi track trước segment thứ k+1.
  const rounds = new Map<string, number[]>();
  for (const position of early) rounds.set(trackOf(position), [...(rounds.get(trackOf(position)) ?? []), position]);
  const lists = [...rounds.values()];
  const interleaved: number[] = [];
  for (let round = 0; round < MIN_SEGMENT_SAMPLES; round++) {
    for (const list of lists) {
      const position = list[round];
      if (position !== undefined) interleaved.push(position);
    }
  }
  return [...interleaved, ...rest];
}

/** Engine phải chạy ít nhất chừng này trước khi tốc độ đủ tin cậy để tính ETA. */
export const MIN_SPEED_ELAPSED_MS = 3000;
/** Không nhận được báo cáo nào trong chừng này khi đang tải: coi như đứng yên (engine báo ≤ 2 lần/s khi có dữ liệu). */
export const STALL_AFTER_MS = 8000;
/** Hằng số thời gian của trung bình trượt hàm mũ cho tốc độ. */
export const SPEED_TIME_CONSTANT_MS = 10_000;

export interface SpeedAverage {
  bytesPerSecond: number;
  /** Thời điểm của mẫu cuối cùng (ms). */
  at: number;
}

/**
 * Trung bình trượt hàm mũ theo thời gian của tốc độ: trọng số của mẫu mới
 * tăng theo khoảng cách tới mẫu trước, nên kết quả không phụ thuộc tần suất
 * báo cáo. Mẫu 0 (không nhận byte nào trong cả cửa sổ đo) nghĩa là đứng yên:
 * trung bình về 0 và lần chạy lại sau đó bắt đầu từ đầu.
 */
export function averageSpeed(
  previous: SpeedAverage | undefined,
  sample: number,
  at: number,
  timeConstantMs = SPEED_TIME_CONSTANT_MS,
): SpeedAverage {
  if (!(sample > 0) || !Number.isFinite(sample)) return { bytesPerSecond: 0, at };
  if (!previous || previous.bytesPerSecond <= 0) return { bytesPerSecond: sample, at };
  const elapsed = at - previous.at;
  if (elapsed <= 0) return previous;
  const weight = 1 - Math.exp(-elapsed / timeConstantMs);
  return { bytesPerSecond: previous.bytesPerSecond + weight * (sample - previous.bytesPerSecond), at };
}

export interface SizeEstimate {
  /** Bytes đã lưu. */
  downloaded: number;
  /** Tổng dung lượng: chính xác khi `exact`, ngược lại là ước lượng (cận dưới khi `partial`). */
  total: number;
  remaining: number;
  /** Mọi kích thước đều biết chắc (khai báo trong manifest hoặc đã tải xong): hiển thị không có "~". */
  exact: boolean;
  /** Có track chưa đủ mẫu và không khai báo kích thước: không tính vào `total`, tổng thực tế lớn hơn. */
  partial: boolean;
}

/**
 * Tổng dung lượng và phần còn lại của một lượt tải. Undefined khi chưa thể
 * ước lượng: chưa biết số segment (live, đang đọc danh sách segment) hoặc
 * chưa track nào có đủ mẫu.
 */
export function estimateSize(progress: TaskProgress): SizeEstimate | undefined {
  const downloaded = progress.bytes;
  if (!(progress.segmentsTotal > 0)) return undefined;
  if (progress.segmentsDone >= progress.segmentsTotal) {
    return { downloaded, total: downloaded, remaining: 0, exact: true, partial: false };
  }
  // Progress của v0.1.0 (hoặc chưa có plan theo track): coi cả task là một track.
  const tracks: readonly TrackProgress[] = progress.tracks?.length
    ? progress.tracks.filter((track) => track.segmentsTotal > 0)
    : [{ trackId: 'all', segmentsTotal: progress.segmentsTotal, segmentsDone: progress.segmentsDone, bytes: progress.bytes }];

  let remaining = 0;
  let exact = true;
  let partial = false;
  let known = 0;
  for (const track of tracks) {
    const left = Math.max(0, track.segmentsTotal - track.segmentsDone);
    if (track.declaredBytes !== undefined) {
      remaining += Math.max(0, track.declaredBytes - track.bytes);
      known += 1;
    } else if (left === 0) {
      known += 1;
    } else if (track.segmentsDone >= MIN_SEGMENT_SAMPLES) {
      remaining += (track.bytes / track.segmentsDone) * left;
      exact = false;
      known += 1;
    } else {
      exact = false;
      partial = true;
    }
  }
  if (known === 0) return undefined;
  // Có track chưa đủ mẫu và chưa track nào cho ra ước lượng thật: thà không hiển thị.
  if (partial && remaining === 0) return undefined;
  remaining = Math.round(remaining);
  return { downloaded, total: downloaded + remaining, remaining, exact, partial };
}

/** Giây còn lại; undefined khi tốc độ bằng 0 hoặc dữ liệu không hợp lệ. */
export function estimateEtaSeconds(remainingBytes: number, bytesPerSecond: number): number | undefined {
  if (!(bytesPerSecond > 0) || !Number.isFinite(bytesPerSecond)) return undefined;
  if (!(remainingBytes >= 0) || !Number.isFinite(remainingBytes)) return undefined;
  return remainingBytes / bytesPerSecond;
}

export interface DownloadEstimate {
  size?: SizeEstimate;
  /** Tốc độ hiện tại (cửa sổ 5 s của engine); 0 khi đứng yên. */
  bytesPerSecond: number;
  /** Không nhận được dữ liệu một lúc. */
  stalled: boolean;
  /** Giây còn lại, chỉ khi đủ dữ liệu. */
  etaSec?: number;
}

/**
 * Mọi con số của một lượt tải đang chạy. `now`: thời điểm hiển thị;
 * `reportedAt`: thời điểm của báo cáo progress mới nhất (task.updatedAt).
 */
export function estimateDownload(progress: TaskProgress, timing: { now: number; reportedAt: number }): DownloadEstimate {
  const size = estimateSize(progress);
  const silent = timing.now - timing.reportedAt > STALL_AFTER_MS;
  const elapsed = timing.reportedAt - progress.startedAt;
  const running = elapsed >= MIN_SPEED_ELAPSED_MS;
  // Tiến độ mang từ lần chạy trước (stale) không có tốc độ thật; một lượt chạy chưa tải xong segment nào
  // của chính nó (vừa đọc xong danh sách segment, hoặc vừa resume) chưa thể gọi là đứng yên.
  const started = progress.segmentsDone > (progress.resumedSegments ?? 0);
  const stalled =
    !progress.stale && running && started && (silent || progress.bytesPerSecond === 0) && progress.segmentsDone < progress.segmentsTotal;
  const bytesPerSecond = stalled || progress.stale ? 0 : progress.bytesPerSecond;
  const estimate: DownloadEstimate = { bytesPerSecond, stalled };
  if (size) estimate.size = size;
  if (size && size.remaining > 0 && running && !stalled && !progress.stale) {
    const eta = estimateEtaSeconds(size.remaining, progress.averageBytesPerSecond ?? progress.bytesPerSecond);
    if (eta !== undefined) estimate.etaSec = eta;
  }
  return estimate;
}
