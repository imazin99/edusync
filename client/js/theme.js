/**
 * client/js/theme.js
 *
 * Light/dark theme persistence (theme-refinement phase, requirement 6).
 * Remembers an explicit choice in localStorage (a display preference, not
 * session/auth data, so it is fine to keep it outside the per-tab
 * sessionStorage auth cache and let it persist across visits).
 *
 * DEFAULT THEME: Light Mode is the default for a first-time visitor with
 * no saved preference — unconditionally, regardless of the OS/browser's
 * own color-scheme preference (requirement 6.1). Earlier, a visitor with
 * no saved choice fell through to css/tokens.css's
 * `@media (prefers-color-scheme: dark)` rule, so a dark-mode OS put them
 * in Dark Mode by default — that rule has been removed from tokens.css,
 * and initTheme()/getTheme() below now default to 'light' explicitly
 * instead of consulting matchMedia('(prefers-color-scheme: dark)') at
 * all, so the two layers (CSS and JS) can't disagree with each other.
 *
 * No saved choice is never "overwritten" by this default — initTheme()
 * only ever WRITES to localStorage from setTheme()/toggleTheme(), i.e.
 * when the user actively picks a theme via the toggle (requirement 6.10).
 */

const STORAGE_KEY = 'academic_schedule.theme';

export function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    // localStorage can throw in some private-browsing contexts — fall
    // through to the same explicit Light Mode default used when nothing
    // is stored.
  }
  document.documentElement.setAttribute('data-theme', stored === 'dark' ? 'dark' : 'light');
}

export function getTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Non-fatal — the choice just won't persist across reloads.
  }
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}
