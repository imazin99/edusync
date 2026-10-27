/**
 * server/tests/staticAssetDelivery.test.js
 *
 * Follow-up to a browser bug report on the Admin Students page: "Reset
 * Password still displays 'userId is not a valid id'" even though
 * client/js/pages/admin-students.js on disk was already confirmed fixed
 * (its loadList()/openReset()/handleResetSubmit() correctly use s.userId
 * — see adminStudentsListAndResetPassword.test.js). Re-reading the file
 * found nothing wrong with it, so the remaining explanation the task
 * explicitly asked to rule out was a stale, browser-cached copy of the
 * script being served from a previous (buggy) state.
 *
 * server/app.js's static middleware had no explicit Cache-Control, so it
 * fell back to express.static/`send`'s default (`max-age=0`, no `no-cache`
 * directive) — not provably wrong, but not provably safe either. This
 * pins the hardened behavior added alongside that investigation: every
 * static response now carries an explicit `Cache-Control: no-cache`,
 * forcing revalidation with the server instead of ever reusing a cached
 * copy without checking first.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { createApp } = require('../app');

test('Static client JS is served with Cache-Control: no-cache (forces revalidation, never silently stale)', async () => {
  const app = createApp();
  const res = await request(app).get('/js/pages/admin-students.js');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['cache-control'], 'no-cache');
});

test('Static client HTML/CSS are also served with Cache-Control: no-cache', async () => {
  const app = createApp();

  const html = await request(app).get('/pages/admin/students.html');
  assert.strictEqual(html.status, 200);
  assert.strictEqual(html.headers['cache-control'], 'no-cache');

  const css = await request(app).get('/css/components.css');
  assert.strictEqual(css.status, 200);
  assert.strictEqual(css.headers['cache-control'], 'no-cache');
});

/**
 * Regression guard for the modal-stacking bug reported on the Admin
 * Students page: `.modal-backdrop { display: flex; ... }` (an author-
 * origin rule) overrides the UA stylesheet's `[hidden] { display: none }`
 * regardless of specificity, because author rules of normal importance
 * always beat user-agent rules of normal importance in the CSS cascade.
 * Every admin-*.js page toggles its modals solely via the native `hidden`
 * attribute (e.g. `document.getElementById('reset-modal-backdrop').hidden
 * = true`), so without a `.modal-backdrop[hidden]` override, EVERY modal
 * on EVERY page using this shared class rendered visible and stacked
 * regardless of its hidden state — exactly "Add Student (background) +
 * Reset Password (foreground) both visible" and "Cancel doesn't appear to
 * dismiss it". There's no DOM/browser harness in this backend-only test
 * suite to assert actual rendered visibility, so this pins the fix at the
 * only level available here: the served CSS source must contain a rule
 * that re-hides a `[hidden]` `.modal-backdrop`, positioned after the
 * unconditional rule so it would win even under equal-origin ordering
 * rules too.
 */
test('.modal-backdrop[hidden] is re-hidden in components.css (fixes modal-stacking bug)', async () => {
  const app = createApp();
  const res = await request(app).get('/css/components.css');
  assert.strictEqual(res.status, 200);

  const css = res.text;
  const baseRuleIndex = css.indexOf('.modal-backdrop {');
  const hiddenRuleMatch = css.match(/\.modal-backdrop\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/);

  assert.ok(baseRuleIndex !== -1, 'expected the base .modal-backdrop rule to exist');
  assert.ok(hiddenRuleMatch, 'expected a .modal-backdrop[hidden] { display: none } override rule');
  assert.ok(
    hiddenRuleMatch.index > baseRuleIndex,
    'the [hidden] override must come after the base rule'
  );
});
