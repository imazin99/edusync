/**
 * client/js/pages/ta-profile.js
 *
 * TA Profile page. Read-only account details + account status, plus the
 * shell's existing Logout button (which is this project's whole "account
 * switching" mechanism — see ta/profile.html's comment on the logout
 * button for why no separate switch-account feature exists to reuse).
 * Mirrors doctor-profile.js exactly.
 *
 * REAL API call only:
 *   GET /api/auth/me (already fetched once by initAppShell; this page
 *   does not re-fetch it, since nothing here can change it — there is no
 *   TA-facing mutation endpoint at all, unlike the Student page's
 *   password create/remove and group-change request)
 *
 * WHY THIS PAGE IS SO MUCH SHORTER THAN student-profile.js: every one of
 * that page's forms is backed by a Student-only endpoint —
 *   POST/DELETE /api/auth/password   (server/routes/auth.routes.js —
 *     Student accounts optionally have no password at all, spec section
 *     7; TA accounts always require one, set by Admin, with no
 *     self-service create/remove/change endpoint of any kind)
 *   POST /api/requests/group-change  (Student-only concept — TA has
 *     no "group")
 * Neither exists for TA. Inventing UI for either here would mean wiring
 * a button to nothing real, which is exactly what this project's own
 * conventions (see student-profile.js's "KNOWN, REPORTED LIMITATION"
 * comments) avoid — show only what a real, role-appropriate API backs.
 *
 * WHY ACCOUNT DETAILS SHOWS ONLY Full Name: server/controllers/
 * auth.controller.js's serializeUser() returns, for kind==='ta', exactly
 * `{ fullName }` — no TA._id, no subjectIds, nothing else. This is the
 * same root cause documented in ta-full-schedule.js's and ta-tasks.js's
 * file headers as the reason "my own subject(s)" can't be reliably
 * filtered anywhere in this phase — flagged there (and in the phase
 * report) as a specific, minimal backend capability gap, not invented
 * around here either.
 */
import { initAppShell } from '../app-shell.js';

function formatLastLogin(value) {
  if (!value) return 'No previous login recorded';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function detailRow(term, description) {
  const dt = document.createElement('dt');
  dt.textContent = term;
  const dd = document.createElement('dd');
  if (description instanceof Node) dd.appendChild(description);
  else dd.textContent = description;
  return [dt, dd];
}

function badge(text, variant) {
  const span = document.createElement('span');
  span.className = `badge${variant ? ` badge--${variant}` : ''}`;
  span.textContent = text;
  return span;
}

function renderAccountDetails(user) {
  const list = document.getElementById('profile-details-list');
  if (!list) return;
  list.innerHTML = '';
  const ta = user.ta || {};
  list.append(...detailRow('Full Name', ta.fullName || '—'));
  list.append(...detailRow('Username', user.username || '—'));
  list.append(...detailRow('Role', 'TA'));
}

function renderAccountStatus(user) {
  const list = document.getElementById('profile-status-list');
  if (!list) return;
  list.innerHTML = '';
  list.append(
    ...detailRow(
      'Password status',
      badge(user.hasPassword ? 'Password set' : 'No password set', user.hasPassword ? 'success' : 'warning')
    )
  );
  list.append(...detailRow('Last login', formatLastLogin(user.lastLoginAt)));
}

// ---------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------

(async function initTaProfilePage() {
  const user = await initAppShell({ requiredRole: 'TA' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  renderAccountDetails(user);
  renderAccountStatus(user);
})();
