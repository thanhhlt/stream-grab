/**
 * Hiệu ứng gắp, chuyển động đặc trưng của Claw (docs/DESIGN.md, "Motion"): sau khi video vào hàng
 * đợi, một bản sao ô poster bay lên móng gắp, móng hạ xuống và khép càng, rồi thả bản sao xuống số
 * đếm của tab Queue, số đếm nảy lên.
 *
 * - Chỉ là trình bày: số đếm luôn lấy từ danh sách task thật, hiệu ứng không đổi số nào.
 * - Không chặn thao tác: bản sao `position: fixed`, `pointer-events: none`, `aria-hidden`.
 * - Lượt gắp mới kết thúc ngay lượt cũ (hủy animation, bỏ bản sao).
 * - `prefers-reduced-motion: reduce`: không bay, không cử động móng, không nảy.
 * - Chỉ dùng Web Animations API và `transform`/`opacity`/`rotate`.
 */

const EASE_IN_OUT = 'cubic-bezier(0.45, 0, 0.2, 1)';
const SPRING = 'cubic-bezier(0.3, 1.6, 0.5, 1)';
/** Tổng thời gian một lượt bay. */
const GRAB_MS = 1000;
/** 0–380 ms bay tới móng, 380–620 ms giữ dưới móng; phần còn lại thả xuống số đếm. */
const REACH_MS = 380;
const HOLD_END_MS = 620;
const BUMP_MS = 350;
/** Một lần tải nhiều video chỉ bay tối đa 3 ô, cách nhau 80 ms. */
const MAX_FLIGHTS = 3;
const STAGGER_MS = 80;
/**
 * Tâm ô khi nằm dưới móng: cách mép trên của móng 50 px, để hai càng (đã hạ, khép) kẹp nửa trên của
 * ô 22 px. Bản sao nằm dưới header (z 5 < 10) nên móng được vẽ đè lên ô.
 */
const CLAW_GRIP_Y = 50;
const GHOST_Z = '5';
/**
 * Móng hạ 9 px trên màn hình. Móng là SVG viewBox 32 × 50 vẽ ở 30 × 50 (tỉ lệ 0.9375), và `px` trong
 * transform của phần tử SVG là đơn vị của viewBox: 9.6 → 9 px.
 */
const CLAW_DROP = 9.6;
const PRONG_OPEN_DEG = 20;

export interface GrabStage {
  /** Móng gắp trong header (svg chứa các `[data-claw-part]`). */
  claw: Element | null;
  /** Thanh tab: đích là `[data-tab-count="queue"]`, hoặc tab Queue (`[data-tab="queue"]`) khi chưa có số đếm. */
  tabs: Element | null;
}

const running = { animations: new Set<Animation>(), ghosts: new Set<Element>() };

function track(animation: Animation): Animation {
  running.animations.add(animation);
  const forget = () => running.animations.delete(animation);
  // Bị hủy (lượt gắp mới) thì `finished` bị từ chối: không phải lỗi.
  animation.finished.then(forget, forget);
  return animation;
}

/** Kết thúc ngay lượt gắp đang chạy: hủy mọi animation, bỏ các bản sao. */
export function stopGrab(): void {
  for (const animation of running.animations) animation.cancel();
  running.animations.clear();
  for (const ghost of running.ghosts) ghost.remove();
  running.ghosts.clear();
}

function motionAllowed(): boolean {
  // happy-dom (test) không có Web Animations API.
  if (typeof Element.prototype.animate !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function center(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/** Điểm hạ cánh: tâm số đếm của Queue; chưa có số đếm (task đầu tiên) thì gần mép phải tab Queue, nơi nó sẽ hiện. */
function landingPoint(tabs: Element): { x: number; y: number } | undefined {
  const count = tabs.querySelector('[data-tab-count="queue"]');
  if (count) return center(count.getBoundingClientRect());
  const tab = tabs.querySelector('[data-tab="queue"]')?.getBoundingClientRect();
  return tab ? { x: tab.right - 12, y: tab.top + tab.height / 2 } : undefined;
}

function moveClaw(claw: Element): void {
  const timing = { duration: GRAB_MS };
  const rig = claw.querySelector('[data-claw-part="rig"]');
  if (rig) {
    // Hạ xuống, nhấc lên 6 px cùng ô trong lúc giữ, rồi kéo lên.
    track(
      rig.animate(
        [
          { transform: 'translateY(0)', easing: EASE_IN_OUT },
          { offset: REACH_MS / GRAB_MS, transform: `translateY(${CLAW_DROP}px)`, easing: EASE_IN_OUT },
          { offset: HOLD_END_MS / GRAB_MS, transform: `translateY(${CLAW_DROP - 6.4}px)`, easing: EASE_IN_OUT },
          { transform: 'translateY(0)' },
        ],
        timing,
      ),
    );
  }
  // Càng khép 300–420 ms, mở lại khi móng kéo lên. Càng dùng thuộc tính `rotate` (ClawMark).
  for (const [part, open] of [
    ['prong-left', PRONG_OPEN_DEG],
    ['prong-right', -PRONG_OPEN_DEG],
  ] as const) {
    const prong = claw.querySelector(`[data-claw-part="${part}"]`);
    if (!prong) continue;
    track(
      prong.animate(
        [
          { rotate: `${open}deg` },
          { offset: 0.3, rotate: `${open}deg`, easing: EASE_IN_OUT },
          { offset: 0.42, rotate: '0deg' },
          { offset: 0.66, rotate: '0deg', easing: EASE_IN_OUT },
          { rotate: `${open}deg` },
        ],
        timing,
      ),
    );
  }
}

let bumping: Animation | undefined;

function bump(tabs: Element): void {
  const count = tabs.querySelector('[data-tab-count="queue"]');
  if (!count) return;
  bumping?.cancel();
  bumping = track(
    count.animate(
      [
        { transform: 'scale(1)', easing: SPRING },
        { offset: 0.45, transform: 'scale(1.45)', easing: SPRING },
        { transform: 'scale(1)' },
      ],
      { duration: BUMP_MS },
    ),
  );
}

function fly(tile: HTMLElement, claw: Element, tabs: Element, delay: number): void {
  const from = tile.getBoundingClientRect();
  const start = center(from);
  const ghost = tile.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('data-poster');
  ghost.setAttribute('data-grab-ghost', '');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: '0',
    zIndex: GHOST_Z,
    pointerEvents: 'none',
  });
  document.body.append(ghost);
  running.ghosts.add(ghost);

  const grip = claw.getBoundingClientRect();
  const dx = grip.left + grip.width / 2 - start.x;
  const dy = grip.top + CLAW_GRIP_Y - start.y;
  const held = `translate(${dx}px, ${dy - 6}px) scale(0.42)`;
  const reach = track(
    ghost.animate(
      [
        { transform: 'translate(0, 0) scale(1)', easing: EASE_IN_OUT },
        { offset: REACH_MS / HOLD_END_MS, transform: `translate(${dx}px, ${dy}px) scale(0.42)`, easing: EASE_IN_OUT },
        { transform: held },
      ],
      { duration: HOLD_END_MS, delay, fill: 'both' },
    ),
  );
  reach.finished
    .then(() => {
      // Đích được đo lúc thả: số đếm có thể vừa xuất hiện (task đầu tiên) hoặc vừa đổi độ rộng.
      const land = landingPoint(tabs);
      if (!land) throw new Error('no landing point');
      const drop = track(
        ghost.animate(
          [
            { transform: held, opacity: 1 },
            { transform: `translate(${land.x - start.x}px, ${land.y - start.y}px) scale(0.2)`, opacity: 0.2 },
          ],
          { duration: GRAB_MS - HOLD_END_MS, easing: EASE_IN_OUT, fill: 'forwards' },
        ),
      );
      return drop.finished;
    })
    .then(
      () => {
        bump(tabs);
      },
      () => undefined, // bị cắt ngang bởi lượt gắp mới, hoặc không có tab Queue
    )
    .finally(() => {
      ghost.remove();
      running.ghosts.delete(ghost);
    });
}

/**
 * Chạy hiệu ứng gắp cho các ô poster của video vừa vào hàng đợi (tối đa 3 ô bay, cách nhau 80 ms).
 * Không làm gì khi người dùng chọn giảm chuyển động.
 */
export function playGrab(tiles: readonly HTMLElement[], stage: GrabStage): void {
  stopGrab();
  const { claw, tabs } = stage;
  if (tiles.length === 0 || !claw || !tabs || !motionAllowed()) return;
  moveClaw(claw);
  tiles.slice(0, MAX_FLIGHTS).forEach((tile, index) => {
    fly(tile, claw, tabs, index * STAGGER_MS);
  });
}
