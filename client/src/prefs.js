/**
 * Per-browser conveniences (theme, chosen portfolio). Storage can be unavailable (private windows, blocked site data),
 * so every read and write is guarded and the app works without it.
 */
export function readPref(key, fallback) {
  try {
    return window.localStorage.getItem(`stockbeat.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(`stockbeat.${key}`);
    else window.localStorage.setItem(`stockbeat.${key}`, String(value));
  } catch {
    /* not saved; the choice still applies until the page is closed */
  }
}

/** 'system' follows the device; 'light' and 'dark' override it. */
export const THEMES = ['system', 'light', 'dark'];

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
  const dark = theme === 'dark' || (theme !== 'light' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0f172a' : '#2563eb');
}
