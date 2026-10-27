/**
 * server/tests/devQuickSigninRemoved.test.js
 *
 * Regression tests for the pre-deployment hardening pass (Phase 1:
 * remove the development quick sign-in UI from the production-facing
 * login page).
 *
 * CONFIRMED BEFORE REMOVAL: client/pages/login.html contained a
 * `<details class="dev-quick-signin">` section ("Dev quick sign-in
 * (testing aid)") whose role dropdown autofilled the Identifier/Password
 * fields with one of the fixed, publicly-documented accounts created by
 * `npm run seed:dev` (server/scripts/seed-dev-accounts.js) — including
 * their plaintext passwords, hardcoded directly in client/js/pages/login.js.
 * Investigation confirmed this was strictly a form-filling convenience
 * with NO backend shortcut: it never submitted the form, never set a
 * role/session/cookie itself, and the actual authenticated role always
 * came from the real POST /api/auth/login response — but shipping fixed,
 * publicly-known demo credentials and a "testing aid" label to ordinary
 * users in production is still not appropriate, so both the UI and its
 * supporting JS/CSS were removed.
 *
 * `npm run seed:dev` itself is UNCHANGED and intentionally still present
 * — it already refuses to run when NODE_ENV=production (a hard
 * process.exit(1), confirmed by reading server/scripts/seed-dev-accounts.js),
 * is never invoked by server/app.js or any route, and remains available
 * as a standalone local-testing tool, per the explicit instruction not to
 * remove developer tooling without a clear reason to.
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const LOGIN_HTML = path.join(__dirname, '..', '..', 'client', 'pages', 'login.html');
const LOGIN_JS = path.join(__dirname, '..', '..', 'client', 'js', 'pages', 'login.js');
const LAYOUT_CSS = path.join(__dirname, '..', '..', 'client', 'css', 'layout.css');
const SEED_SCRIPT = path.join(__dirname, '..', 'scripts', 'seed-dev-accounts.js');

test('login.html no longer contains the dev quick sign-in section', () => {
  const html = fs.readFileSync(LOGIN_HTML, 'utf8');
  assert.doesNotMatch(html, /dev-quick-signin/);
  assert.doesNotMatch(html, /Dev quick sign-in/);
  assert.doesNotMatch(html, /dev-role-hint/);
  // The real sign-in form must still be fully intact.
  assert.match(html, /id="login-form"/);
  assert.match(html, /id="identifier"/);
  assert.match(html, /id="password"/);
  assert.match(html, /id="submit-btn"/);
});

test('login.js no longer hardcodes the seeded dev account credentials', () => {
  const js = fs.readFileSync(LOGIN_JS, 'utf8');
  assert.doesNotMatch(js, /DEV_QUICK_SIGNIN_ACCOUNTS/);
  assert.doesNotMatch(js, /DevAdmin123!/);
  assert.doesNotMatch(js, /DevDoctor123!/);
  assert.doesNotMatch(js, /DevTA123!/);
  assert.doesNotMatch(js, /DevLeader123!/);
  assert.doesNotMatch(js, /dev-role-hint/);
  // The real submit handler (POST /api/auth/login via authState.login)
  // must be untouched.
  assert.match(js, /authState\.login\(/);
});

test('layout.css no longer has dead dev-quick-signin styling', () => {
  const css = fs.readFileSync(LAYOUT_CSS, 'utf8');
  assert.doesNotMatch(css, /dev-quick-signin/);
});

test('npm run seed:dev still refuses to run in production (unchanged, still present as a local dev tool)', () => {
  const source = fs.readFileSync(SEED_SCRIPT, 'utf8');
  assert.match(source, /env\.isProduction/);
  assert.match(source, /process\.exit\(1\)/);
});

test('the seed script is never required/invoked by the running application itself', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.doesNotMatch(appSource, /seed-dev-accounts/);
});
