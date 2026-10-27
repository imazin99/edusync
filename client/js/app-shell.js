/**
 * client/js/app-shell.js
 *
 * Shared authenticated-page shell (spec section 116: "Separate... UI
 * components" — this is the one piece every authenticated page needs:
 * the header, the role-aware nav (sidebar + mobile bottom nav, built from
 * js/nav-config.js), the logout button, and the auth guard that decides
 * whether the viewer is even allowed to see the page at all).
 *
 * This is infrastructure, not a page — it renders INTO containers that
 * already exist in a page's HTML (see client/pages/student/dashboard.html
 * for the expected markup), and it is role-agnostic: it reads
 * NAV_BY_ROLE for whichever role is actually logged in, rather than
 * assuming Student. Building it this way (instead of copy-pasting a
 * Student-only header into student-dashboard.js) is what lets later
 * phases' Doctor/TA/Leader/Admin pages reuse it unchanged — but this
 * phase only ever calls it with a Student page, and builds no other
 * page.
 */
import { authState, dashboardPathForRole } from './auth-state.js';
import { renderNav } from './nav-config.js';
import { initTheme, toggleTheme, getTheme } from './theme.js';
import { showAlert } from './ui.js';

/**
 * Human-readable role label for the header's "signed in as" line. Not a
 * spec requirement by itself, but needed so the header isn't just a bare
 * enum string like "STUDENT".
 */
const ROLE_LABELS = {
  STUDENT: 'Student',
  DOCTOR: 'Doctor',
  TA: 'TA',
  LEADER: 'Leader',
  ADMIN: 'Admin',
};

/**
 * Picks the best available display name for the header from whatever
 * role-specific profile GET /api/auth/me actually returned — never
 * invented, only ever a field the server sent.
 */
function displayNameFor(user) {
  if (user.student) return user.student.fullName;
  if (user.doctor) return user.doctor.fullName;
  if (user.ta) return user.ta.fullName;
  if (user.leader) return user.username;
  if (user.role === 'ADMIN') return user.username;
  return user.username;
}

/**
 * Initializes the authenticated shell for one page.
 *
 * @param {object} options
 * @param {string} options.requiredRole - the role this page is built
 *   for (e.g. 'STUDENT'). If the actual logged-in user has a different
 *   role, they are redirected to THEIR OWN dashboard instead of seeing a
 *   page built for someone else.
 * @param {string} options.currentPath - window.location.pathname, used
 *   to mark the active nav link.
 * @returns {Promise<object|null>} the authenticated user object on
 *   success. Returns null (after redirecting to /pages/login.html) if no
 *   session exists — callers should stop their own page setup in that
 *   case, since navigation is already underway.
 */
export async function initAppShell({ requiredRole, currentPath = window.location.pathname } = {}) {
  initTheme();

  let user;
  try {
    user = await authState.fetchCurrentUser();
  } catch (err) {
    // Network/maintenance/unexpected error while checking the session —
    // not the ordinary "logged out" case (that resolves to `null` below,
    // not a throw). Surface it instead of silently redirecting, so a
    // temporarily-unreachable backend doesn't look like "you got logged
    // out".
    renderFatalError(
      'Could not verify your session. Check your connection and try again.'
    );
    return null;
  }

  if (!user) {
    window.location.replace('/pages/login.html');
    return null;
  }

  if (requiredRole && user.role !== requiredRole) {
    // Authenticated, but this page wasn't built for their role — send
    // them to the page that was, rather than showing them someone
    // else's dashboard shell.
    window.location.replace(dashboardPathForRole(user.role));
    return null;
  }

  renderHeader(user);
  renderNavigation(user.role, currentPath);
  wireLogout();
  wireSessionAndMaintenanceBanners();

  return user;
}

function renderHeader(user) {
  const nameEl = document.getElementById('shell-user-name');
  const roleEl = document.getElementById('shell-user-role');
  if (nameEl) nameEl.textContent = displayNameFor(user);
  if (roleEl) roleEl.textContent = ROLE_LABELS[user.role] || user.role;

  const themeToggleBtn = document.getElementById('theme-toggle');
  const themeToggleLabel = document.getElementById('theme-toggle-label');
  if (themeToggleBtn && themeToggleLabel) {
    // aria-pressed exposes the toggle's CURRENT state to assistive tech
    // (true = Dark Mode is active) alongside the visible label, which
    // names the action the button performs NEXT (requirement 6.9: "use
    // correct accessible labels... and expose the current state clearly").
    const syncLabel = () => {
      const isDark = getTheme() === 'dark';
      themeToggleLabel.textContent = isDark ? 'Light mode' : 'Dark mode';
      themeToggleBtn.setAttribute('aria-pressed', String(isDark));
    };
    syncLabel();
    themeToggleBtn.addEventListener('click', () => {
      toggleTheme();
      syncLabel();
    });
  }
}

function renderNavigation(role, currentPath) {
  const sidebarContainer = document.getElementById('shell-sidebar-nav');
  const bottomNavContainer = document.getElementById('shell-bottom-nav');
  if (sidebarContainer) renderNav(sidebarContainer, role, currentPath);
  if (bottomNavContainer) renderNav(bottomNavContainer, role, currentPath);
}

function wireLogout() {
  const btn = document.getElementById('shell-logout-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await authState.logout();
    } finally {
      window.location.replace('/pages/login.html');
    }
  });
}

/**
 * Subscribes to the two cross-cutting events api-client.js/auth-state.js
 * already dispatch on every API call anywhere on the page (spec section
 * 102: loading/error feedback must be consistent, not re-implemented per
 * page): session-expired (401 the user didn't cause by logging out
 * themselves) and maintenance mode (503). Both are shown via the same
 * #shell-page-alert region every other page-level message uses.
 */
function wireSessionAndMaintenanceBanners() {
  authState.onSessionExpired(() => {
    window.location.replace('/pages/login.html');
  });
  authState.onMaintenance((detail) => {
    const container = document.getElementById('shell-page-alert');
    if (container) {
      showAlert(
        container,
        detail?.message || 'The system is temporarily under maintenance. Please try again shortly.',
        'error'
      );
    }
  });
}

function renderFatalError(message) {
  const container = document.getElementById('shell-page-alert') || document.body;
  if (container === document.body) {
    // No shell markup rendered yet at all — extremely unlikely, but fail
    // visibly rather than silently.
    const p = document.createElement('p');
    p.textContent = message;
    document.body.prepend(p);
    return;
  }
  showAlert(container, message, 'error');
}

export { ROLE_LABELS, displayNameFor };
