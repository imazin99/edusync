/**
 * client/js/pages/login.js
 *
 * The login screen's behavior (frontend phase, step 8). Handles exactly
 * the states spec section 69/102/126 call for: loading, invalid
 * credentials, validation errors, maintenance mode, server/network
 * errors, successful login, and the role-based redirect.
 *
 * Deliberately NOT included here (out of scope for this foundation
 * phase, per the explicit instruction): forgot-password UI, the "create
 * a password" reminder for passwordless students (spec section 7 — that
 * belongs on the student dashboard/profile, which don't exist yet).
 *
 * Pre-deployment hardening note (2026-10): this file used to also
 * contain a dev-only "quick sign-in" testing aid (an autofill dropdown
 * tied to the seeded accounts from `npm run seed:dev`). It never
 * submitted the form or touched the actual authenticated role itself —
 * see the bug-fix report for the full confirmation — but it was still
 * development-only UI with no place on a production-facing login page,
 * so it (and its markup in login.html) was removed. `npm run seed:dev`
 * (server/scripts/seed-dev-accounts.js) is unaffected and still works
 * exactly as before for local testing — it was never wired to this file
 * or any other route; this was purely a convenience that filled in the
 * credentials it prints to the console.
 */
import { authState, dashboardPathForRole } from '../auth-state.js';
import { ApiError } from '../api-client.js';
import { showAlert, clearAlert, setButtonLoading, setFieldError } from '../ui.js';
import { initTheme, toggleTheme, getTheme } from '../theme.js';

/**
 * Safety cleanup: if `identifier`/`password` ever ended up as URL query
 * parameters (the native-form-fallback bug this fix addresses — see
 * login.html's method="post" comment), scrub ONLY those two keys from
 * the visible URL immediately. This NEVER reads the values to attempt a
 * login (that would be submitting credentials that already leaked) and
 * NEVER logs them anywhere — they are discarded. Any other, unrelated
 * query parameter is left exactly as it was. history.replaceState swaps
 * the address bar without a reload or a new navigation entry.
 */
(function scrubCredentialsFromUrl() {
  const params = new URLSearchParams(window.location.search);
  let changed = false;
  for (const key of ['identifier', 'password']) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return;
  const query = params.toString();
  const cleanUrl = window.location.pathname + (query ? `?${query}` : '') + window.location.hash;
  window.history.replaceState(window.history.state, '', cleanUrl);
})();

initTheme();
const themeToggleBtn = document.getElementById('theme-toggle');
const themeToggleLabel = document.getElementById('theme-toggle-label');
function syncThemeLabel() {
  // aria-pressed exposes the toggle's CURRENT state to assistive tech
  // (true = Dark Mode is active) alongside the visible label, which names
  // the action the button performs NEXT — same pattern as js/app-shell.js.
  const isDark = getTheme() === 'dark';
  themeToggleLabel.textContent = isDark ? 'Light mode' : 'Dark mode';
  themeToggleBtn.setAttribute('aria-pressed', String(isDark));
}
syncThemeLabel();
themeToggleBtn.addEventListener('click', () => {
  toggleTheme();
  syncThemeLabel();
});

const form = document.getElementById('login-form');
const identifierInput = document.getElementById('identifier');
const passwordInput = document.getElementById('password');
const submitBtn = document.getElementById('submit-btn');
const alertContainer = document.getElementById('form-alert');

/**
 * If a session already exists (e.g. the user navigated back to /login
 * after logging in, or still has a valid cookie from an earlier visit),
 * send them straight to their dashboard instead of showing the form.
 * This calls the REAL /me endpoint — it never trusts a cached role to
 * decide this, only what the server confirms right now.
 */
(async function redirectIfAlreadyLoggedIn() {
  try {
    const user = await authState.fetchCurrentUser();
    if (user) {
      window.location.replace(dashboardPathForRole(user.role));
    }
  } catch {
    // Maintenance mode or a network error here just means: stay on the
    // login page and let the user try submitting, which will surface
    // the same condition through the normal submit-handling path below.
  }
})();

function messageForError(err) {
  if (!(err instanceof ApiError)) {
    return 'Something went wrong. Please try again.';
  }
  if (err.status === 0) {
    return 'Could not reach the server. Check your connection and try again.';
  }
  if (err.isMaintenance) {
    return err.message || 'The system is temporarily under maintenance. Please try again shortly.';
  }
  if (err.code === 'ACCOUNT_DISABLED') {
    return 'This account has been disabled. Contact an administrator.';
  }
  if (err.code === 'INVALID_CREDENTIALS') {
    return 'Incorrect Student Code/Username or password.';
  }
  if (err.isValidation) {
    return err.message || 'Please check the form and try again.';
  }
  return err.message || 'Something went wrong. Please try again.';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearAlert(alertContainer);
  setFieldError(identifierInput, '');

  const identifier = identifierInput.value.trim();
  if (!identifier) {
    setFieldError(identifierInput, 'This field is required.');
    identifierInput.focus();
    return;
  }

  setButtonLoading(submitBtn, true, 'Signing in…');
  try {
    const user = await authState.login(identifier, passwordInput.value);
    showAlert(alertContainer, 'Signed in. Redirecting…', 'success');
    window.location.replace(dashboardPathForRole(user.role));
    // Intentionally not clearing the loading state on success — the page
    // is navigating away, and a button re-enabling for an instant right
    // before that happens is just visual noise.
  } catch (err) {
    setButtonLoading(submitBtn, false);
    showAlert(alertContainer, messageForError(err), 'error');
  }
});

