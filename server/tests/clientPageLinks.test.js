/**
 * server/tests/clientPageLinks.test.js
 *
 * Regression tests for a confirmed broken-navigation bug report:
 *
 *   GET /pages/ta/schedule.html      -> 404 ROUTE_NOT_FOUND
 *   GET /pages/ta/history.html       -> 404 ROUTE_NOT_FOUND
 *   GET /pages/leader/history.html   -> 404 ROUTE_NOT_FOUND
 *
 * ROOT CAUSE: client/js/nav-config.js's NAV_BY_ROLE listed sidebar/bottom-
 * nav links for pages that were never built — this was confirmed by
 * direct inspection (static Express serving via `express.static` in
 * server/app.js has no SPA/catch-all fallback, so a missing HTML file at
 * any linked path 404s through server/middleware/errorHandler.js's
 * notFoundHandler, exactly matching the reported response shape). Two
 * distinct causes were found:
 *
 *   1. TA/Doctor's separate "Schedule" nav entries (distinct from "Full
 *      Schedule") pointed at pages that were deliberately never built —
 *      already documented as a known limitation in ta-full-schedule.js's
 *      and doctor-full-schedule.js's file headers (building a "my own
 *      subject only" view requires a Doctor/TA._id the backend doesn't
 *      expose to that role). Fix: the dead duplicate entries were
 *      removed from nav-config.js — "Full Schedule" already covers the
 *      spec's "view the schedule" requirement with a real page.
 *   2. TA, Leader, and (discovered as the same root cause while
 *      investigating) Doctor's "History" nav entries pointed at
 *      /pages/{role}/history.html, which genuinely did not exist — no
 *      page had ever been built for it, unlike Student's and Admin's
 *      equivalent "Changes" page. Fix: client/pages/ta/history.html,
 *      client/pages/leader/history.html, and client/pages/doctor/history.html
 *      were built (plus their matching client/js/pages/*-history.js),
 *      reusing the exact same page shell, API endpoints
 *      (GET /api/schedule/changes?subjectId=X), and schedule-widgets.js
 *      rendering helpers that client/js/pages/student-changes.js already
 *      established — no new API, no new business rule, no framework.
 *
 * THIS TEST FILE is a static-source + filesystem regression guard against
 * this entire CLASS of bug recurring: every href in NAV_BY_ROLE must
 * resolve to a real file under client/pages (this project has no
 * browser/DOM test runner — see scheduleWeekNavigation.test.js's file
 * header for the same constraint and the same style of static-source
 * guard used here).
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const NAV_CONFIG_PATH = path.join(__dirname, '..', '..', 'client', 'js', 'nav-config.js');
const CLIENT_ROOT = path.join(__dirname, '..', '..', 'client');

function extractNavHrefs() {
  const source = fs.readFileSync(NAV_CONFIG_PATH, 'utf8');
  // Matches only actual `href: '...'` object properties — comment prose
  // mentioning a path (e.g. explaining a removed dead link) never matches
  // this pattern, since it's not followed by `href:`.
  return [...source.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);
}

test('nav-config.js exports at least one href per existing role', () => {
  const hrefs = extractNavHrefs();
  // Sanity check that the extraction itself works (would fail loudly if
  // nav-config.js's shape ever changed enough to break the regex), not a
  // meaningful business assertion on its own.
  assert.ok(hrefs.length >= 24, `expected at least 24 nav hrefs, found ${hrefs.length}`);
});

test('every NAV_BY_ROLE href resolves to a real file under client/pages (regression: ta/schedule.html, ta/history.html, leader/history.html, doctor/history.html, doctor/schedule.html used to 404)', () => {
  const hrefs = extractNavHrefs();
  const missing = hrefs.filter((href) => {
    // hrefs are absolute paths like "/pages/ta/history.html" — strip the
    // leading slash and resolve under client/, mirroring exactly how
    // express.static(path.join(__dirname, '../client')) in server/app.js
    // serves them.
    const filePath = path.join(CLIENT_ROOT, href.replace(/^\//, ''));
    return !fs.existsSync(filePath);
  });
  assert.deepStrictEqual(missing, [], `nav-config.js links to non-existent page(s): ${missing.join(', ')}`);
});

test('the three originally-reported pages now exist on disk', () => {
  for (const relPath of ['client/pages/ta/history.html', 'client/pages/leader/history.html']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', relPath)), `${relPath} should exist`);
  }
  // TA Schedule's fix is a removed dead link, not a new page — see the
  // nav-href test above, which already proves no TA nav entry points at
  // a non-existent /pages/ta/schedule.html any more.
});

test('the directly-related Doctor History page (same root cause, discovered during this investigation) also now exists', () => {
  assert.ok(
    fs.existsSync(path.join(__dirname, '..', '..', 'client/pages/doctor/history.html')),
    'client/pages/doctor/history.html should exist'
  );
});

test('each new *-history.js page module requires the role the page shell says it is for', () => {
  const cases = [
    { file: 'client/js/pages/ta-history.js', role: 'TA' },
    { file: 'client/js/pages/leader-history.js', role: 'LEADER' },
    { file: 'client/js/pages/doctor-history.js', role: 'DOCTOR' },
  ];
  for (const { file, role } of cases) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.match(
      source,
      new RegExp(`requiredRole:\\s*'${role}'`),
      `${file} must gate the page behind requiredRole: '${role}'`
    );
    // Reuses the exact same real endpoint student-changes.js and
    // admin-changes.js already use — no new/invented API.
    assert.match(
      source,
      /\/api\/schedule\/changes\?subjectId=/,
      `${file} must use the existing GET /api/schedule/changes?subjectId=... endpoint`
    );
  }
});
