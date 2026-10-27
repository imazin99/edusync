/**
 * client/js/pages/leader-profile.js
 *
 * Leader Profile page. Read-only account details + account status, plus
 * the shell's existing Logout button (which is this project's whole
 * "account switching" mechanism — see leader/profile.html's comment on
 * the logout button for why no separate switch-account feature exists to
 * reuse, including switching to/from this Leader's own, separate Student
 * account — spec section 17).
 *
 * REAL API call only:
 *   GET /api/auth/me (already fetched once by initAppShell; this page
 *   does not re-fetch it, since nothing here can change it — there is no
 *   Leader-facing mutation endpoint at all, unlike the Student page's
 *   password create/remove and group-change request)
 *
 * WHY THIS PAGE IS SO MUCH SHORTER THAN student-profile.js: every one of
 * that page's forms is backed by a Student-only endpoint —
 *   POST/DELETE /api/auth/password   (server/routes/auth.routes.js —
 *     Student accounts optionally have no password at all, spec section
 *     7; Leader accounts always require one, set by Admin, with no
 *     self-service create/remove/change endpoint of any kind)
 *   POST /api/requests/group-change  (Student-only concept — the Leader
 *     role/account itself has no "group"; that concept belongs to the
 *     Leader's separate Student account, not this one)
 * Neither exists for Leader. Inventing UI for either here would mean
 * wiring a button to nothing real, which is exactly what this project's
 * own conventions (see student-profile.js's "KNOWN, REPORTED LIMITATION"
 * comments) avoid — show only what a real, role-appropriate API backs.
 *
 * WHY ACCOUNT DETAILS SHOWS Slot, NOT A NAME: server/controllers/
 * auth.controller.js's serializeUser() returns, for kind==='leader',
 * exactly `{ slot }` (server/models/Leader.js: slot is MALE or FEMALE,
 * identifying which of the two fixed Leader seats this account occupies
 * — spec section 17 — not a comment on gender identity) — no fullName,
 * unlike Doctor/TA, and no Leader._id or linkedStudentId either. This is
 * NOT the same Doctor._id/TA._id gap reported in those phases (there is
 * no "my own subject(s)" concept for Leader to need an id for at all —
 * see leader-schedule.js's and leader-tasks.js's file headers); it is
 * simply the complete, real shape of what this endpoint returns for this
 * role, shown as-is rather than inventing a display name.
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

const SLOT_LABELS = { MALE: 'Male', FEMALE: 'Female' };

function renderAccountDetails(user) {
  const list = document.getElementById('profile-details-list');
  if (!list) return;
  list.innerHTML = '';
  const leader = user.leader || {};
  list.append(...detailRow('Slot', leader.slot ? SLOT_LABELS[leader.slot] || leader.slot : '—'));
  list.append(...detailRow('Username', user.username || '—'));
  list.append(...detailRow('Role', 'Leader'));
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

(async function initLeaderProfilePage() {
  const user = await initAppShell({ requiredRole: 'LEADER' });
  if (!user) return; // initAppShell already redirected (logged out / wrong role / fatal error shown)

  renderAccountDetails(user);
  renderAccountStatus(user);
})();
