/**
 * server/tests/scheduleWeekNavigation.test.js
 *
 * Regression tests for a confirmed date/week-navigation bug: a recurring
 * class appeared to shift to a different weekday every time the user
 * navigated to the previous/next week on the Admin Schedule, Student
 * Schedule, Leader Schedule, Doctor Full Schedule, and TA Full Schedule
 * pages, drifting further with every click until it cycled through
 * different weekdays entirely.
 *
 * ROOT CAUSE (confirmed by direct inspection of all five affected pages —
 * client/js/pages/{student-schedule,admin-schedule,leader-schedule,
 * ta-full-schedule,doctor-full-schedule}.js — they share byte-for-byte
 * identical week-math helpers): `goToPreviousWeek()`/`goToNextWeek()`
 * stepped `weekStart` by `DAYS_IN_WEEK` (6 — the number of columns
 * actually *displayed*, since the academic week is Saturday -> Thursday
 * and Friday is off, per spec section 22), instead of by a true 7-day
 * calendar week. Saturday minus 6 days is the FOLLOWING Sunday, not the
 * prior Saturday, so `weekStart` silently walked one weekday off its
 * Saturday anchor on every single navigation, compounding indefinitely.
 *
 * This was a PURE CLIENT-SIDE DISPLAY bug, not a data bug:
 * ScheduleService.getSessionsForRange (below) independently checks each
 * calendar day in the requested [startDate, endDate] window against the
 * template's real `dayOfWeek`, so a materialized ScheduleSession's `date`
 * is always a real, correct occurrence of that weekday — regardless of
 * whether the requested window itself was Saturday-aligned. What broke
 * was the day-COLUMN LABELING: the pages render day headers positionally
 * (DAY_ORDER[index], e.g. index 0 is always labeled "Saturday") rather
 * than deriving the label from each column's actual date. Once
 * `weekStart` drifted off Saturday, a session's real, correct date no
 * longer fell under the column whose fixed label actually matched that
 * weekday — a Sunday class would render under a column labeled "Monday",
 * "Tuesday", etc., depending on how far the drift had compounded.
 *
 * This file therefore covers two independent layers, both required for
 * the fix to be verified end-to-end:
 *
 *   1. The pure week-stepping arithmetic itself (re-implemented here
 *      identically to the shared client helpers, since this project has
 *      no browser/DOM test runner — see "no client test harness" note
 *      below): proves the NEW constant (7) keeps `weekStart` on Saturday
 *      indefinitely in both directions, and that the OLD constant (6) did
 *      NOT — i.e. a test that would have failed against the pre-fix
 *      implementation.
 *   2. A static-source guard reading the five actual fixed files, so a
 *      future edit can't silently reintroduce `DAYS_IN_WEEK` as the
 *      navigation step without this test failing.
 *   3. Real ScheduleService.getSessionsForRange tests (against the
 *      in-memory fake collections already used throughout this suite —
 *      no live MongoDB needed) proving session materialization always
 *      preserves the template's configured weekday across many
 *      consecutive weeks and across a Saturday-Thursday boundary, which
 *      is what confirms existing/future ScheduleSession data was never
 *      corrupted by this bug.
 *
 * NO CLIENT TEST HARNESS: this project's test suite (`npm test` / `node
 * --test server/tests/*.test.js`) only exercises server-side code — there
 * is no jsdom or browser automation anywhere in the existing suite, and
 * client/js/pages/*.js are ES modules whose top-level IIFEs call
 * `document`-dependent code (`initAppShell`, etc.) the moment they're
 * imported, so they cannot be safely `require()`-d or `import()`-ed from
 * a plain Node test without a DOM. Introducing a browser test runner
 * would be a new dependency and out of scope for this focused fix.
 * Instead, part 1 below re-implements the exact same tiny, pure
 * (DOM-free) date-arithmetic functions the client files use, and part 2
 * reads those files' actual source text to guard against regression —
 * together these cover both "is the math right" and "do the real files
 * still use it".
 */

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { ROLES, CLASS_TYPES, GROUPS } = require('../utils/constants');
const { createScheduleService } = require('../services/ScheduleService');
const { createNotificationService } = require('../services/NotificationService');

// ===========================================================================
// Part 1 — pure week-stepping arithmetic (mirrors the client helpers)
// ===========================================================================

function dateOnly(d) {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/** Saturday on/before `date` — identical to every affected page's startOfAcademicWeek(). */
function startOfAcademicWeek(date) {
  const d = dateOnly(date);
  const daysSinceSaturday = (d.getUTCDay() - 6 + 7) % 7;
  return addDays(d, -daysSinceSaturday);
}

const SATURDAY = 6; // Date#getUTCDay() value

test('startOfAcademicWeek always resolves to a Saturday, for every day of an arbitrary week', () => {
  const anchor = new Date('2026-10-18T00:00:00.000Z'); // a known Sunday
  for (let i = 0; i < 14; i += 1) {
    const d = addDays(anchor, i);
    assert.strictEqual(startOfAcademicWeek(d).getUTCDay(), SATURDAY, `offset ${i} did not resolve to Saturday`);
  }
});

test('stepping weekStart by 7 days (the fix) stays on Saturday across many consecutive navigations, both directions', () => {
  const DAYS_IN_CALENDAR_WEEK = 7;
  let weekStart = startOfAcademicWeek(new Date('2026-10-18T00:00:00.000Z'));
  assert.strictEqual(weekStart.getUTCDay(), SATURDAY);

  // Forward 20 weeks.
  for (let i = 0; i < 20; i += 1) {
    weekStart = addDays(weekStart, DAYS_IN_CALENDAR_WEEK);
    assert.strictEqual(weekStart.getUTCDay(), SATURDAY, `drifted off Saturday navigating forward at step ${i}`);
  }
  // Back 40 weeks (crossing the original start).
  for (let i = 0; i < 40; i += 1) {
    weekStart = addDays(weekStart, -DAYS_IN_CALENDAR_WEEK);
    assert.strictEqual(weekStart.getUTCDay(), SATURDAY, `drifted off Saturday navigating backward at step ${i}`);
  }
});

test('REGRESSION: stepping weekStart by 6 days (the pre-fix bug) drifts off Saturday — this is exactly what the fix corrects', () => {
  const PRE_FIX_BUGGY_STEP = 6; // the old DAYS_IN_WEEK value, used for navigation before the fix
  let weekStart = startOfAcademicWeek(new Date('2026-10-18T00:00:00.000Z'));
  assert.strictEqual(weekStart.getUTCDay(), SATURDAY);

  weekStart = addDays(weekStart, -PRE_FIX_BUGGY_STEP); // "previous week", old behavior
  assert.notStrictEqual(
    weekStart.getUTCDay(),
    SATURDAY,
    'expected the pre-fix 6-day step to already be off Saturday after a single navigation'
  );

  // Confirms the drift compounds (cycles through weekdays) rather than
  // self-correcting, matching the reported "keeps shifting... eventually
  // cycling through different weekdays" symptom.
  const seenWeekdays = new Set([weekStart.getUTCDay()]);
  for (let i = 0; i < 6; i += 1) {
    weekStart = addDays(weekStart, -PRE_FIX_BUGGY_STEP);
    seenWeekdays.add(weekStart.getUTCDay());
  }
  assert.ok(seenWeekdays.size > 1, 'expected the buggy step to cycle through multiple different weekdays');
});

// ===========================================================================
// Part 2 — static-source regression guard on the five actual fixed files
// ===========================================================================

const AFFECTED_FILES = [
  'client/js/pages/student-schedule.js',
  'client/js/pages/admin-schedule.js',
  'client/js/pages/leader-schedule.js',
  'client/js/pages/ta-full-schedule.js',
  'client/js/pages/doctor-full-schedule.js',
];

for (const relPath of AFFECTED_FILES) {
  test(`${relPath}: week navigation steps by a real 7-day calendar week, not the 6-day display count`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');

    // The fix: a dedicated 7-day constant exists...
    assert.match(
      source,
      /const DAYS_IN_CALENDAR_WEEK = 7;/,
      'expected a DAYS_IN_CALENDAR_WEEK = 7 constant (the navigation step)'
    );

    // ...and goToPreviousWeek/goToNextWeek use IT, not DAYS_IN_WEEK (6).
    const navSection = source.slice(source.indexOf('function goToPreviousWeek'));
    assert.match(
      navSection,
      /weekStart = addDays\(weekStart, -DAYS_IN_CALENDAR_WEEK\)/,
      'goToPreviousWeek must step by -DAYS_IN_CALENDAR_WEEK'
    );
    assert.match(
      navSection,
      /weekStart = addDays\(weekStart, DAYS_IN_CALENDAR_WEEK\)/,
      'goToNextWeek must step by DAYS_IN_CALENDAR_WEEK'
    );

    // The bug pattern must not have been reintroduced: no navigation line
    // may step by the bare 6-day display constant.
    assert.doesNotMatch(
      navSection,
      /weekStart = addDays\(weekStart, -?DAYS_IN_WEEK\)/,
      'navigation must not step by DAYS_IN_WEEK (6) — that is the exact regression this test guards against'
    );
  });
}

// ===========================================================================
// Part 3 — real ScheduleService.getSessionsForRange: materialization always
// preserves the template's configured weekday, across many weeks and across
// the Saturday-Thursday boundary, using 7-day (correct) windows the way the
// fixed frontend now requests them.
// ===========================================================================

function buildScheduleModels() {
  const scope = createTestFixtureScope();
  const c = (prefix) => createFakeCollection(prefix, [], scope);
  return {
    ScheduleTemplate: c('template'),
    ScheduleSession: c('session'),
    ScheduleChange: c('change'),
    Subject: c('subject'),
    Doctor: c('doctor'),
    TA: c('ta'),
    User: c('user'),
    Student: c('student'),
    Leader: c('leader'),
  };
}

function scheduleWeekFixture() {
  const models = buildScheduleModels();
  const audit = { recordAudit: async () => {} };
  const notificationService = createNotificationService({ models });
  const service = createScheduleService({
    models,
    auditService: audit,
    notificationService,
    runInTransaction: async (cb) => cb({ __passthroughFakeSession: true }),
  });
  return { models, service };
}

async function seedSubjectAndTemplate(models, service, { dayOfWeek }) {
  const subject = await models.Subject.create({ name: 'MATH3', code: 'MATH3', hasSections: false, isActive: true });
  const doctor = await models.Doctor.create({ userId: 'user_doc', fullName: 'Dr Math', isActive: true });
  const template = await service.createTemplate({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    subjectId: subject._id,
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek,
    startTime: '10:00',
    endTime: '12:00',
    roomId: 'room_1',
    doctorId: doctor._id,
    effectiveFrom: '2026-01-01',
  });
  return { subject, doctor, template };
}

const JS_DAY_TO_NAME = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

test('a recurring SUNDAY class materializes on an actual Sunday in several consecutive 7-day weeks', async () => {
  const { models, service } = scheduleWeekFixture();
  await seedSubjectAndTemplate(models, service, { dayOfWeek: 'SUNDAY' });

  let weekStart = startOfAcademicWeek(new Date('2026-10-18T00:00:00.000Z')); // a real Saturday
  for (let week = 0; week < 6; week += 1) {
    const start = weekStart;
    const end = addDays(weekStart, 5); // the 6 displayed days, Sat..Thu
    // eslint-disable-next-line no-await-in-loop
    const sessions = await service.getSessionsForRange({
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    });
    assert.strictEqual(sessions.length, 1, `week ${week}: expected exactly one materialized session`);
    const sessionDate = dateOnly(sessions[0].date);
    assert.strictEqual(
      JS_DAY_TO_NAME[sessionDate.getUTCDay()],
      'SUNDAY',
      `week ${week}: session date ${sessionDate.toISOString()} was not a Sunday`
    );
    weekStart = addDays(weekStart, 7);
  }
});

test('a recurring MONDAY class materializes on an actual Monday in several consecutive 7-day weeks', async () => {
  const { models, service } = scheduleWeekFixture();
  await seedSubjectAndTemplate(models, service, { dayOfWeek: 'MONDAY' });

  let weekStart = startOfAcademicWeek(new Date('2026-10-18T00:00:00.000Z'));
  for (let week = 0; week < 6; week += 1) {
    const start = weekStart;
    const end = addDays(weekStart, 5);
    // eslint-disable-next-line no-await-in-loop
    const sessions = await service.getSessionsForRange({
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    });
    assert.strictEqual(sessions.length, 1, `week ${week}: expected exactly one materialized session`);
    const sessionDate = dateOnly(sessions[0].date);
    assert.strictEqual(
      JS_DAY_TO_NAME[sessionDate.getUTCDay()],
      'MONDAY',
      `week ${week}: session date ${sessionDate.toISOString()} was not a Monday`
    );
    weekStart = addDays(weekStart, 7);
  }
});

test('session materialization respects the Saturday-Thursday window boundary: a FRIDAY-dated template day is never requested/materialized by the normal 6-day display window', async () => {
  const { models, service } = scheduleWeekFixture();
  // No template is seeded for FRIDAY at all — the academic week excludes
  // it (spec section 22) — this test instead proves the 6-day display
  // window [Sat..Thu] itself never asks for Friday, independent of any
  // template, by checking the exact dates requested never include one
  // whose real weekday is Friday.
  const weekStart = startOfAcademicWeek(new Date('2026-10-18T00:00:00.000Z'));
  const end = addDays(weekStart, 5);
  for (let d = new Date(weekStart); d <= end; d = addDays(d, 1)) {
    assert.notStrictEqual(JS_DAY_TO_NAME[d.getUTCDay()], 'FRIDAY', 'the displayed 6-day window must never include Friday');
  }
  // Sanity: it's exactly Saturday..Thursday, 6 calendar days.
  assert.strictEqual(JS_DAY_TO_NAME[weekStart.getUTCDay()], 'SATURDAY');
  assert.strictEqual(JS_DAY_TO_NAME[end.getUTCDay()], 'THURSDAY');

  const sessions = await service.getSessionsForRange({
    startDate: weekStart.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  });
  assert.strictEqual(sessions.length, 0); // no templates seeded in this test — just confirms no crash across the boundary
});

test('navigating backward then forward across multiple weeks returns the recurring class on its configured weekday every time (no drift)', async () => {
  const { models, service } = scheduleWeekFixture();
  await seedSubjectAndTemplate(models, service, { dayOfWeek: 'SUNDAY' });

  let weekStart = startOfAcademicWeek(new Date('2026-10-18T00:00:00.000Z'));
  const steps = [-7, -7, -7, 7, 7, 7, 7, -7]; // simulates prev/prev/prev/next/next/next/next/prev clicks
  for (const step of steps) {
    weekStart = addDays(weekStart, step);
    const end = addDays(weekStart, 5);
    assert.strictEqual(weekStart.getUTCDay(), SATURDAY, 'weekStart drifted off Saturday during navigation');
    // eslint-disable-next-line no-await-in-loop
    const sessions = await service.getSessionsForRange({
      startDate: weekStart.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
    });
    assert.strictEqual(sessions.length, 1);
    assert.strictEqual(JS_DAY_TO_NAME[dateOnly(sessions[0].date).getUTCDay()], 'SUNDAY');
  }
});
