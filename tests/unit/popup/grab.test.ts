// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playGrab, stopGrab } from '@/popup/grab';

/**
 * Hiệu ứng gắp (Claw, docs/DESIGN.md "Motion"): bản sao ô poster bay lên móng rồi xuống số đếm
 * của Queue. Web Animations API được thay bằng bản giả để điều khiển lúc kết thúc.
 */

interface FakeAnimation {
  element: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  cancelled: boolean;
  finished: Promise<unknown>;
  finish: () => void;
  cancel: () => void;
}

let animations: FakeAnimation[] = [];
const original = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');

function fakeAnimate(this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const finished = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const animation: FakeAnimation = {
    element: this,
    keyframes,
    options,
    cancelled: false,
    finished,
    finish: () => {
      resolve(animation);
    },
    cancel: () => {
      animation.cancelled = true;
      reject(new DOMException('The animation was aborted.', 'AbortError'));
    },
  };
  animations.push(animation);
  return animation;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ghosts = () => [...document.querySelectorAll('[data-grab-ghost]')];
const on = (element: Element | null | undefined) => animations.filter((animation) => animation.element === element);

function setup() {
  document.body.innerHTML = `
    <header><svg data-claw><g data-claw-part="rig"><path data-claw-part="prong-left"/><path data-claw-part="prong-right"/></g></svg></header>
    <div role="tablist" data-tabs>
      <button role="tab" data-tab="detected">Detected</button>
      <button role="tab" data-tab="queue">Queue <span data-tab-count="queue">2</span></button>
    </div>
    <ul>${[1, 2, 3, 4].map((n) => `<li><span data-poster="play" aria-hidden="true">${n}:00</span></li>`).join('')}</ul>`;
  const tiles = [...document.querySelectorAll<HTMLElement>('[data-poster]')];
  const stage = { claw: document.querySelector('[data-claw]'), tabs: document.querySelector('[data-tabs]') };
  return { tiles, stage };
}

beforeEach(() => {
  animations = [];
  Object.defineProperty(Element.prototype, 'animate', { value: fakeAnimate, configurable: true, writable: true });
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false } as MediaQueryList);
});

afterEach(() => {
  stopGrab();
  if (original) Object.defineProperty(Element.prototype, 'animate', original);
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('grab animation', () => {
  it('flies at most three non-interactive ghost tiles, 80 ms apart, and moves the claw once', () => {
    const { tiles, stage } = setup();
    playGrab(tiles, stage);

    expect(ghosts()).toHaveLength(3);
    for (const ghost of ghosts()) {
      expect(ghost.getAttribute('aria-hidden')).toBe('true');
      expect(ghost.hasAttribute('data-poster')).toBe(false);
      expect((ghost as HTMLElement).style.position).toBe('fixed');
      expect((ghost as HTMLElement).style.pointerEvents).toBe('none');
    }
    expect(ghosts().map((ghost) => on(ghost)[0]?.options.delay)).toEqual([0, 80, 160]);
    // Only transform and opacity on the ghosts; the claw drops (transform) and the prongs close (rotate).
    for (const ghost of ghosts()) {
      for (const frame of on(ghost)[0]?.keyframes ?? []) {
        expect(Object.keys(frame).filter((key) => !['offset', 'easing'].includes(key))).toEqual(['transform']);
      }
    }
    expect(on(document.querySelector('[data-claw-part="rig"]'))).toHaveLength(1);
    expect(on(document.querySelector('[data-claw-part="prong-left"]'))[0]?.keyframes.map((frame) => frame['rotate'])).toEqual([
      '20deg',
      '20deg',
      '0deg',
      '0deg',
      '20deg',
    ]);
    // The real tiles are untouched.
    expect(tiles.every((tile) => on(tile).length === 0)).toBe(true);
  });

  it('drops the ghost onto the Queue count, then removes it and bumps the count', async () => {
    const { tiles, stage } = setup();
    playGrab(tiles.slice(0, 1), stage);
    const [ghost] = ghosts();
    on(ghost)[0]?.finish();
    await settle();

    const drop = on(ghost)[1];
    expect(drop?.keyframes.at(-1)).toMatchObject({ opacity: 0.2 });
    expect(String(drop?.keyframes.at(-1)?.transform)).toContain('scale(0.2)');
    drop?.finish();
    await settle();

    expect(ghosts()).toHaveLength(0);
    const count = document.querySelector('[data-tab-count="queue"]');
    expect(on(count)).toHaveLength(1);
    // The animation never changes the number: it comes from the task list.
    expect(count?.textContent).toBe('2');
  });

  it('is cut short by a new grab: earlier animations are cancelled and their ghosts removed', async () => {
    const { tiles, stage } = setup();
    playGrab(tiles.slice(0, 2), stage);
    const first = [...animations];
    playGrab(tiles.slice(2, 3), stage);
    await settle();

    expect(first.every((animation) => animation.cancelled)).toBe(true);
    expect(ghosts()).toHaveLength(1);
    // A cancelled flight never bumps the count.
    expect(on(document.querySelector('[data-tab-count="queue"]'))).toHaveLength(0);
  });

  it('does nothing when the user prefers reduced motion', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
    const { tiles, stage } = setup();
    playGrab(tiles, stage);
    expect(ghosts()).toHaveLength(0);
    expect(animations).toHaveLength(0);
  });
});
