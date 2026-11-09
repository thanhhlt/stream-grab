import { Icon } from './Icon';

/** Luồng không có ảnh thu nhỏ, nên mỗi dòng có một ô 52 px mang một trong 8 màu, chọn theo tên host. */
const POSTER_COLORS = [
  'bg-poster-1',
  'bg-poster-2',
  'bg-poster-3',
  'bg-poster-4',
  'bg-poster-5',
  'bg-poster-6',
  'bg-poster-7',
  'bg-poster-8',
] as const;

/** Chỉ số màu (0–7) ổn định cho một host: FNV-1a 32 bit trên tên host viết thường. */
export function posterIndex(host: string): number {
  let hash = 0x811c9dc5;
  for (const char of host.toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % POSTER_COLORS.length;
}

/**
 * - `play`: màu theo host, tam giác phát màu trắng.
 * - `locked`: DRM hoặc không tải được; ô `surface` có ổ khóa.
 * - `failed`: ô `danger` có dấu cảnh báo.
 * - `done`: màu theo host, dấu tích thành công ở góc.
 */
export type PosterState = 'play' | 'locked' | 'failed' | 'done';

interface PosterTileProps {
  /** Tên host của trang (vd. "www.example.com"); quyết định màu. */
  host: string;
  state?: PosterState;
  /** Thời lượng đã định dạng (vd. "12:04"), hiện ở góc dưới bên phải. */
  duration?: string | undefined;
}

/** Ô "poster" của một dòng. Chỉ để trình bày (`aria-hidden`): trạng thái luôn có chữ ở dòng đó. */
export function PosterTile({ host, state = 'play', duration }: PosterTileProps) {
  const surface =
    state === 'locked' ? 'bg-surface text-faint' : state === 'failed' ? 'bg-danger text-on-danger' : `${POSTER_COLORS[posterIndex(host)]} text-on-poster`;
  return (
    <span aria-hidden data-poster={state} className={`relative grid size-[52px] shrink-0 place-items-center rounded-tile ${surface}`}>
      <Icon
        name={state === 'locked' ? 'lock' : state === 'failed' ? 'warning' : 'play'}
        className={state === 'play' || state === 'done' ? 'size-[18px]' : 'size-5'}
      />
      {duration && state !== 'locked' && state !== 'failed' && (
        <span className="absolute right-[3px] bottom-[3px] rounded-[5px] bg-scrim px-1 text-[10px] leading-[14px] font-bold text-on-poster tabular-nums">
          {duration}
        </span>
      )}
      {state === 'done' && (
        // Dấu tích dùng màu nền popup để tương phản trên `success` ở cả hai chế độ.
        <span className="absolute -top-1 -right-1 grid size-[18px] place-items-center rounded-full bg-success text-bg ring-2 ring-bg">
          <Icon name="tick" className="size-3 stroke-[2.6]" />
        </span>
      )}
    </span>
  );
}
