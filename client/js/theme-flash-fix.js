/**
 * client/js/theme-flash-fix.js
 *
 * Applies the right theme BEFORE first paint. Must be a plain
 * synchronous, non-module script loaded via <script src="..."> in <head>,
 * not type="module" (module scripts are always deferred until after
 * parsing, which is exactly what let the page render once in the wrong
 * theme first on every reload — the underlying cause of the dark-mode
 * toggle "not working").
 *
 * This file exists as an EXTERNAL script (rather than inline in the HTML)
 * because the backend's helmet() default Content-Security-Policy is
 * `script-src 'self'`, which silently blocks inline <script> execution
 * without an `'unsafe-inline'` keyword, a hash, or a nonce. An inline
 * version of this script is therefore never executed when the page is
 * served through the backend, causing a flash-of-wrong-theme on every
 * load even though the code itself was correct. Loading the exact same
 * code from a same-origin external file satisfies `script-src 'self'`
 * with no change to any backend file or CSP configuration.
 *
 * DEFAULT THEME (theme-refinement phase, requirement 6.1): Light Mode is
 * the default when nothing is stored — unconditionally, never based on
 * the OS/browser's prefers-color-scheme. This mirrors js/theme.js's
 * initTheme()/getTheme() exactly (same explicit-default logic, same
 * STORAGE_KEY, duplicated here on purpose since this must run standalone
 * before any module has loaded) so the two can never disagree about what
 * "no saved preference" renders as.
 */
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem('academic_schedule.theme');
  } catch (e) {
    /* localStorage unavailable (e.g. private browsing) — falls through
       to the same explicit Light Mode default used when nothing is
       stored. */
  }
  document.documentElement.setAttribute('data-theme', stored === 'dark' ? 'dark' : 'light');
})();
