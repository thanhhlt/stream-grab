// Popup theme before the first paint (a classic script in <head>: MV3 allows 'self' scripts, not inline ones).
// The Theme setting lives in chrome.storage, which is async; src/popup/theme.ts keeps a copy of it in
// localStorage under the key below, and keeps <html data-theme> current once the popup runs.
(() => {
  let theme = 'system';
  try {
    theme = localStorage.getItem('streamgrab.theme') ?? 'system';
  } catch {
    // No localStorage: follow the system until the settings load.
  }
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
})();
