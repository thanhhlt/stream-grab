/** Toolbar badge showing how many streams were detected in a tab. */

export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > 99 ? '99+' : String(count);
}

export function initBadgeStyle(): void {
  void chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' }).catch(() => undefined);
  void chrome.action.setBadgeTextColor({ color: '#ffffff' }).catch(() => undefined);
}

export function updateBadge(tabId: number, count: number): void {
  // Fails harmlessly when the tab has closed in the meantime.
  void chrome.action.setBadgeText({ tabId, text: badgeText(count) }).catch(() => undefined);
}
