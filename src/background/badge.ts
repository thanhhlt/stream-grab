/** Toolbar badge showing how many streams were detected in a tab. */

export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

/**
 * Claw colors (docs/DESIGN.md): `ink` with white text, like the claw's cap. Not tangerine: the
 * toolbar icon is a tangerine square, so a tangerine badge would disappear into it.
 */
const BADGE_BACKGROUND = '#1b2030';
const BADGE_TEXT = '#ffffff';

export function initBadgeStyle(): void {
  void chrome.action.setBadgeBackgroundColor({ color: BADGE_BACKGROUND }).catch(() => undefined);
  void chrome.action.setBadgeTextColor({ color: BADGE_TEXT }).catch(() => undefined);
}

export function updateBadge(tabId: number, count: number): void {
  // Fails harmlessly when the tab has closed in the meantime.
  void chrome.action.setBadgeText({ tabId, text: badgeText(count) }).catch(() => undefined);
}
