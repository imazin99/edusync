/**
 * client/js/auth-state.js
 *
 * The shared authentication/session state foundation (frontend phase,
 * step 5). Wraps the backend's existing, unmodified auth contract exactly
 * (server/controllers/auth.controller.js):
 *
 *   POST /api/auth/login  { identifier, password? } -> { user }
 *   POST /api/auth/logout                           -> { message }
 *   GET  /api/auth/me                                -> { user }
 *
 * `user` shape (exactly as the backend serializes it — see
 * auth.controller.js's serializeUser — never invented client-side):
 *   { id, username, role, hasPassword, lastLoginAt,
 *     student?: { studentCode, fullName, group },
 *     doctor?:  { fullName },
 *     ta?:      { fullName },
 *     leader?:  { slot } }
 * role is one of: STUDENT | DOCTOR | TA | LEADER | ADMIN — this exact
 * string, as the server sets it. This module NEVER invents or guesses a
 * role; it only ever stores what the server returned.
 *
 * SECURITY BOUNDARY (spec sections 69/70/122 — do not weaken this):
 * The session itself lives in an HTTP-only cookie this code can never
 * read. Everything cached here (sessionStorage) is purely a UI
 * convenience — e.g. "don't flash a login form while we check" — and is
 * NEVER the source of authorization truth. Every real permission check
 * happens server-side, on every request, regardless of what this cache
 * says. A page may use getRole()/hasRole() to decide what to SHOW, but
 * must never assume that alone means an action will SUCCEED — the
 * backend enforces that independently and is the only real boundary.
 */

import { apiClient, ApiError, API_EVENTS } from './api-client.js';

const CACHE_KEY = 'academic_schedule.current_user';

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(user) {
  try {
    if (user) sessionStorage.setItem(CACHE_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // sessionStorage can throw in some locked-down/private-browsing
    // contexts — the cache is a convenience, never required, so a
    // failure here must not break login/logout.
  }
}

let currentUser = readCache();

function setCurrentUser(user) {
  currentUser = user;
  writeCache(user);
}

export const authState = {
  /** The last known user from this tab, or null. Does NOT hit the network. */
  getUser() {
    return currentUser;
  },

  /** Convenience: current role string, or null if logged out. */
  getRole() {
    return currentUser ? currentUser.role : null;
  },

  /** UI-only convenience check — see the security boundary note above. */
  hasRole(role) {
    return currentUser != null && currentUser.role === role;
  },

  isLoggedIn() {
    return currentUser != null;
  },

  /**
   * POST /api/auth/login. identifier is required; password is OPTIONAL
   * (spec section 7: a student with no password set logs in with just
   * their Student Code — the backend decides this, never the frontend).
   * Throws ApiError on failure (INVALID_CREDENTIALS, ACCOUNT_DISABLED,
   * MAINTENANCE, VALIDATION_ERROR, etc. — see server/utils/AppError.js).
   */
  async login(identifier, password) {
    const body = password ? { identifier, password } : { identifier };
    // The login request itself returning 401 is an expected, handled
    // outcome (wrong credentials) — not a "your session died" event.
    const user = await apiClient.post('/api/auth/login', body, { skipUnauthorizedEvent: true });
    setCurrentUser(user);
    return user;
  },

  /**
   * POST /api/auth/logout. Always allowed, even during maintenance mode
   * (server-enforced) — never blocked client-side either. Clears the
   * local cache regardless of whether the network call itself succeeds,
   * since the user's intent is to no longer be logged in on this device.
   */
  async logout() {
    try {
      await apiClient.post('/api/auth/logout');
    } finally {
      setCurrentUser(null);
    }
  },

  /**
   * GET /api/auth/me — the one true source of "am I logged in, and as
   * whom". Call this once when any page loads, before trusting the
   * cache for anything beyond "don't flash the wrong UI for a moment".
   * Returns the user on success, or null if not logged in (401) —
   * never throws for the ordinary "logged out" case, since that is not
   * exceptional, it's one of the two normal outcomes of this check.
   * Any OTHER failure (network error, 503 maintenance, 500) still
   * throws, since the caller genuinely cannot tell "logged in or not"
   * in that case and should not silently treat it as "logged out".
   */
  async fetchCurrentUser() {
    try {
      const user = await apiClient.get('/api/auth/me', { skipUnauthorizedEvent: true });
      setCurrentUser(user);
      return user;
    } catch (err) {
      if (err instanceof ApiError && err.isUnauthorized) {
        setCurrentUser(null);
        return null;
      }
      throw err;
    }
  },

  /**
   * Subscribes to "the server just told us (via any API call, anywhere
   * in the app) that our session is no longer valid" — fired by
   * api-client.js on any 401 that wasn't explicitly suppressed (see
   * skipUnauthorizedEvent above). A page's own script decides what to do
   * (typically: clear local state, redirect to /pages/login.html).
   * Returns an unsubscribe function.
   */
  onSessionExpired(callback) {
    const handler = () => {
      setCurrentUser(null);
      callback();
    };
    window.addEventListener(API_EVENTS.UNAUTHORIZED, handler);
    return () => window.removeEventListener(API_EVENTS.UNAUTHORIZED, handler);
  },

  /**
   * Subscribes to "the backend is in maintenance mode" (503), fired by
   * api-client.js. detail.message is the backend's maintenanceMessage
   * when available. Returns an unsubscribe function.
   */
  onMaintenance(callback) {
    const handler = (event) => callback(event.detail);
    window.addEventListener(API_EVENTS.MAINTENANCE, handler);
    return () => window.removeEventListener(API_EVENTS.MAINTENANCE, handler);
  },
};

/**
 * Where a just-logged-in (or already-logged-in) user of a given role
 * belongs, per spec section 80's per-role dashboard route. Pages outside
 * this foundation phase do not exist yet, so this intentionally only
 * points at paths — not every target page is built yet (see
 * client/js/nav-config.js and the phase report for what's next).
 */
export function dashboardPathForRole(role) {
  const byRole = {
    STUDENT: '/pages/student/dashboard.html',
    DOCTOR: '/pages/doctor/dashboard.html',
    TA: '/pages/ta/dashboard.html',
    LEADER: '/pages/leader/dashboard.html',
    ADMIN: '/pages/admin/dashboard.html',
  };
  return byRole[role] || '/pages/login.html';
}
