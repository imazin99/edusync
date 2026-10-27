/**
 * client/js/api-client.js
 *
 * The ONE place that knows how to talk to the backend (spec section 117:
 * "Create a reusable frontend API client... Do not duplicate fetch logic
 * everywhere."). Every page/module calls through here, never raw fetch().
 *
 * Backend error contract (spec section 72, confirmed directly against
 * server/utils/AppError.js and server/middleware/errorHandler.js):
 *   Success: { success: true, ...data }
 *   Error:   { success: false, message: "...", code: "SOME_CODE" }
 *   Status codes in real use: 401, 403, 404, 409, 422, 429, 503, 500.
 *
 * Session/auth (spec section 69): the backend uses an HTTP-only session
 * cookie (server/config/session.js + express-session), never a token the
 * frontend reads or stores. Every request here is sent with
 * credentials: 'include' so the cookie travels on both same-origin and
 * configured cross-origin setups (server/app.js already sets
 * `cors({ credentials: true, origin: env.corsOrigin })` — see
 * client/js/config.js and client/README.md for the matching setup note).
 * There is no Authorization header and no token to attach — by design.
 */

import { APP_CONFIG } from './config.js';

/**
 * ApiError — thrown for every non-2xx response and for network failures.
 * `status` is 0 for a network-level failure (server unreachable, CORS
 * misconfiguration, offline), matching nothing the backend itself would
 * ever return, so callers can distinguish "couldn't reach the server" from
 * any real backend status.
 */
export class ApiError extends Error {
  constructor(message, { status, code, fieldErrors } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.code = code || (this.status === 0 ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR');
    this.fieldErrors = fieldErrors || null;
  }

  /** True when this represents "not logged in" (401). */
  get isUnauthorized() {
    return this.status === 401;
  }

  /** True when this represents "logged in, but not allowed" (403). */
  get isForbidden() {
    return this.status === 403;
  }

  /** True when the backend is in maintenance mode (503). */
  get isMaintenance() {
    return this.status === 503;
  }

  /** True when this is a validation error the user can fix and retry (422). */
  get isValidation() {
    return this.status === 422;
  }
}

/**
 * Fired on every 401 response, after the shared handling below has run.
 * Pages/auth-state listen for this instead of each one re-checking
 * response status itself. CustomEvent (not a plain callback list) so
 * this module has zero knowledge of what listens — no circular import
 * with auth-state.js.
 */
const UNAUTHORIZED_EVENT = 'api:unauthorized';
/** Fired on every 503 (maintenance mode) response. */
const MAINTENANCE_EVENT = 'api:maintenance';

function dispatchGlobalEvent(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

/**
 * Core request function. Every exported helper below (get/post/patch/
 * delete) is a thin wrapper over this.
 *
 * @param {string} path - e.g. '/api/auth/login' (leading slash required)
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.body] - plain object, JSON-stringified automatically
 * @param {boolean} [options.skipUnauthorizedEvent] - the login/me probe on
 *   app start expects a 401 when logged out; that is not a surprising
 *   "your session just died" event the rest of the app should react to.
 * @returns {Promise<any>} the parsed JSON body's data (everything in the
 *   response except the `success` envelope flag — see unwrap() below)
 * @throws {ApiError}
 */
async function request(path, { method = 'GET', body, skipUnauthorizedEvent = false } = {}) {
  const url = `${APP_CONFIG.apiBaseUrl}${path}`;

  let response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    // fetch() itself only rejects on a true network-level failure
    // (unreachable host, CORS block, offline) — never for a non-2xx
    // HTTP response, which is handled below instead.
    throw new ApiError('Could not reach the server. Check your connection and try again.', {
      status: 0,
      code: 'NETWORK_ERROR',
    });
  }

  let payload = null;
  try {
    // 204/empty bodies (none of this backend's routes currently return
    // one, but this keeps the client correct if one ever does) parse to
    // null rather than throwing on empty input.
    const text = await response.text();
    payload = text ? JSON.parse(text) : null;
  } catch (parseErr) {
    // A non-JSON body on an error response (e.g. a proxy's own HTML error
    // page) must not crash the caller — fall back to the status text.
    payload = null;
  }

  if (!response.ok) {
    const message =
      (payload && payload.message) || response.statusText || 'Something went wrong. Please try again.';
    const code = (payload && payload.code) || `HTTP_${response.status}`;
    const error = new ApiError(message, { status: response.status, code });

    if (response.status === 401 && !skipUnauthorizedEvent) {
      dispatchGlobalEvent(UNAUTHORIZED_EVENT, { path });
    }
    if (response.status === 503) {
      dispatchGlobalEvent(MAINTENANCE_EVENT, { message });
    }
    throw error;
  }

  return payload;
}

/**
 * Strips the `{ success: true, ... }` envelope down to just the
 * meaningful payload, and — for the common single-extra-key shape every
 * endpoint in this backend uses (`{ success, user }`, `{ success, settings }`,
 * `{ success, auditLogs }`, `{ success, dashboard }`, `{ success, items }`,
 * `{ success, tasks }`, etc.) — returns that one value directly, so
 * callers write `const user = await apiClient.get(...)` instead of
 * `const { user } = await apiClient.get(...)`. Falls back to the whole
 * payload (minus `success`) when the shape doesn't match that pattern
 * (e.g. a plain `{ success, message }` acknowledgement).
 */
function unwrap(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const { success, ...rest } = payload;
  const keys = Object.keys(rest);
  if (keys.length === 1) return rest[keys[0]];
  return rest;
}

export const apiClient = {
  async get(path, options) {
    return unwrap(await request(path, { ...options, method: 'GET' }));
  },
  async post(path, body, options) {
    return unwrap(await request(path, { ...options, method: 'POST', body }));
  },
  async patch(path, body, options) {
    return unwrap(await request(path, { ...options, method: 'PATCH', body }));
  },
  async delete(path, options) {
    return unwrap(await request(path, { ...options, method: 'DELETE' }));
  },
  /** Escape hatch for a caller that needs the full `{ success, ... }` envelope untouched. */
  async raw(path, options) {
    return request(path, options);
  },
};

export const API_EVENTS = { UNAUTHORIZED: UNAUTHORIZED_EVENT, MAINTENANCE: MAINTENANCE_EVENT };
