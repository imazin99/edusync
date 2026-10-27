/**
 * client/js/config.js
 *
 * Single place to configure where the backend API lives. Native ES
 * module — no build step, no bundler, loaded directly by the browser
 * via <script type="module">.
 *
 * Spec section 69: authentication uses an HTTP-only session cookie, not
 * a token the frontend can read or store. Because of that, the backend
 * (server/app.js) requires CORS_ORIGIN to explicitly list whatever
 * origin this client is served from, with credentials: true — it
 * already does this (server/app.js reads env.corsOrigin), so nothing
 * backend-side needs to change; only CORS_ORIGIN needs to be set to
 * match wherever this client folder is served from. See client/README.md.
 *
 * apiBaseUrl is empty-string ('') by default, meaning "same origin as
 * the page" (plain relative /api/... fetches) — the simplest setup,
 * used when the backend itself serves this client folder (a possible,
 * but NOT yet made, backend change). Override it here for local
 * development against a backend running on a different origin, e.g.
 * 'http://localhost:3000'.
 */
export const APP_CONFIG = {
  apiBaseUrl: '',
};
