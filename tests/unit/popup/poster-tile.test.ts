// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PosterTile, posterIndex } from '@/popup/components/PosterTile';
import { render } from '@tests/fakes/popup-dom';

/**
 * Ô poster (Claw, docs/DESIGN.md): luồng không có ảnh thu nhỏ nên mỗi dòng mang một trong 8 màu,
 * chọn ổn định theo host. Ô chỉ để trình bày; trạng thái luôn có chữ ở dòng của nó.
 */

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

async function tile(props: Parameters<typeof PosterTile>[0]): Promise<HTMLElement> {
  const { container, root } = await render(PosterTile, props);
  cleanup = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  const element = container.firstElementChild;
  if (!(element instanceof HTMLElement)) throw new Error('PosterTile rendered nothing');
  return element;
}

describe('posterIndex', () => {
  it('is stable, case-insensitive and within the 8 colors', () => {
    expect(posterIndex('www.example.com')).toBe(posterIndex('www.example.com'));
    expect(posterIndex('WWW.Example.com')).toBe(posterIndex('www.example.com'));
    for (const host of ['', 'a.com', 'video.example.org', 'xn--bcher-kva.example', 'localhost']) {
      expect(posterIndex(host)).toBeGreaterThanOrEqual(0);
      expect(posterIndex(host)).toBeLessThan(8);
    }
  });

  it('spreads common hosts over several colors', () => {
    const hosts = Array.from({ length: 40 }, (_, i) => `site${i}.example.com`);
    expect(new Set(hosts.map(posterIndex)).size).toBeGreaterThanOrEqual(6);
  });
});

describe('PosterTile', () => {
  it('is hidden from assistive technology and colored by host', async () => {
    const element = await tile({ host: 'video.example.com', duration: '12:14' });
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.dataset['poster']).toBe('play');
    expect(element.className).toContain(`bg-poster-${posterIndex('video.example.com') + 1}`);
    expect(element.textContent).toBe('12:14');
  });

  it('shows no host color or duration when locked or failed', async () => {
    for (const state of ['locked', 'failed'] as const) {
      const element = await tile({ host: 'video.example.com', state, duration: '12:14' });
      expect(element.dataset['poster']).toBe(state);
      expect(element.className).not.toContain('bg-poster-');
      expect(element.textContent).toBe('');
      cleanup?.();
      cleanup = undefined;
    }
  });
});
