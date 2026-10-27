/**
 * Regression tests for two Express-routing/input-validation bugs found
 * during live MongoDB verification:
 *
 * 1. GET /api/schedule/sessions was being captured by the generic
 *    GET /api/schedule/:sessionId route (no literal /sessions route
 *    existed), so Express bound sessionId = "sessions" and passed it
 *    straight to ScheduleSession.findById("sessions") — an invalid
 *    ObjectId, producing an uncaught CastError (500).
 *
 * 2. POST /api/schedule/:sessionId/change (and the permanent-change
 *    endpoint) had NO validation of the sessionId's format before
 *    passing it straight to Mongoose's findById — a malformed id (e.g.
 *    one character short of a real ObjectId) produced an uncaught
 *    CastError (500) instead of a clean 400.
 *
 * Both are routing/input-validation bugs, not business-logic bugs, so
 * they can only be caught by a real HTTP-level test against the actual
 * router — a service-layer test (as used elsewhere in this project)
 * would never exercise Express's route-matching or the controller's own
 * validation at all.
 *
 * To run this without a live MongoDB, the DB-touching leaf calls
 * (ScheduleService.getSessionsForRange / getSessionById / applyChange,
 * and the DB-backed auth/maintenance middleware) are monkey-patched on
 * their shared module exports BEFORE the real router is required, so
 * the REAL routes.js, REAL controller, and REAL Express route-matching
 * are all exercised exactly as they run in production — only the leaf
 * calls that would otherwise need a database are stubbed.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

// Patch shared middleware exports BEFORE requiring the router, so the
// router's own `require(...)` calls (which run once, at require time)
// pick up the patched versions via Node's module cache.
const authModule = require('../middleware/auth');
authModule.requireAuth = (req, res, next) => {
  req.user = { id: 'user_1', username: 'admin', role: 'ADMIN' };
  next();
};

const maintenanceModule = require('../middleware/maintenance');
maintenanceModule.checkMaintenanceMode = (req, res, next) => next();

// Patch the DB-touching leaf calls the controller invokes at request
// time (these are read as properties on the module object on every
// call, not destructured once, so mutating them here takes effect for
// any request handled afterwards).
const scheduleService = require('../services/ScheduleService');
const calls = [];
const VALID_ID = '507f1f77bcf86cd799439011'; // a syntactically valid 24-hex ObjectId
const MALFORMED_ID_FROM_LIVE_BUG = '6aae75b903dde801bf94bd6'; // 23 chars — the exact id from the live report

scheduleService.getSessionsForRange = async ({ startDate, endDate, subjectId }) => {
  calls.push({ fn: 'getSessionsForRange', startDate, endDate, subjectId });
  return [{ _id: VALID_ID, date: new Date(startDate) }];
};
scheduleService.getSessionById = async (id) => {
  calls.push({ fn: 'getSessionById', id });
  // Simulates the exact real-world failure mode being guarded against:
  // if this is ever called with something that isn't a real ObjectId,
  // something is wrong upstream (the controller should have rejected it
  // before this point).
  if (id === 'sessions' || id === MALFORMED_ID_FROM_LIVE_BUG) {
    throw new Error(`CastError: would have attempted to cast "${id}" as an ObjectId`);
  }
  return { _id: id };
};
scheduleService.applyChange = async ({ sessionId, patch, reason }) => {
  calls.push({ fn: 'applyChange', sessionId, patch, reason });
  if (sessionId === MALFORMED_ID_FROM_LIVE_BUG) {
    throw new Error(`CastError: would have attempted to cast "${sessionId}" as an ObjectId`);
  }
  return { session: { _id: sessionId }, change: { _id: 'change_1' }, warnings: [], noop: false };
};

// eslint-disable-next-line import/order
const scheduleRoutes = require('../routes/schedule.routes');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/schedule', scheduleRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test('GET /api/schedule/sessions reaches the sessions handler, not /:sessionId', async () => {
  calls.length = 0;
  const app = buildTestApp();

  const res = await request(app).get('/api/schedule/sessions').query({ date: '2026-09-19' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.ok(Array.isArray(res.body.sessions));

  // The route it actually hit:
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].fn, 'getSessionsForRange');
  assert.strictEqual(calls[0].startDate, '2026-09-19');
  assert.strictEqual(calls[0].endDate, '2026-09-19');

  // Explicitly confirm getSessionById was never called with "sessions"
  // (the exact failure this regression test guards against).
  assert.ok(!calls.some((c) => c.fn === 'getSessionById' && c.id === 'sessions'));
});

test('GET /api/schedule/sessions supports startDate/endDate as an alternative to date', async () => {
  calls.length = 0;
  const app = buildTestApp();

  const res = await request(app)
    .get('/api/schedule/sessions')
    .query({ startDate: '2026-09-19', endDate: '2026-09-25' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[0].fn, 'getSessionsForRange');
  assert.strictEqual(calls[0].startDate, '2026-09-19');
  assert.strictEqual(calls[0].endDate, '2026-09-25');
});

test('GET /api/schedule/:sessionId still works for a valid-format session id (no regression)', async () => {
  calls.length = 0;
  const app = buildTestApp();

  const res = await request(app).get(`/api/schedule/${VALID_ID}`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[0].fn, 'getSessionById');
  assert.strictEqual(calls[0].id, VALID_ID);
});

test('GET /api/schedule/today and /api/schedule/changes still take precedence over /:sessionId (no regression)', async () => {
  scheduleService.getToday = async () => [{ _id: 'today_session' }];
  scheduleService.getChangeHistory = async () => [];
  const app = buildTestApp();

  const todayRes = await request(app).get('/api/schedule/today');
  assert.strictEqual(todayRes.status, 200);
  assert.deepStrictEqual(todayRes.body.sessions, [{ _id: 'today_session' }]);

  const changesRes = await request(app).get('/api/schedule/changes').query({ sessionId: 'x' });
  assert.strictEqual(changesRes.status, 200);
});

// ===========================================================================
// Regression: POST /api/schedule/:sessionId/change with a malformed session
// id (the exact live bug — a 23-character id, one short of a real
// ObjectId) must return a clean 400, never an uncaught CastError/500, and
// must never reach the service/DB layer at all.
// ===========================================================================

test('POST /api/schedule/:sessionId/change with the EXACT malformed id from the live bug report returns a clean validation error, not 500', async () => {
  calls.length = 0;
  const app = buildTestApp();

  const res = await request(app)
    .post(`/api/schedule/${MALFORMED_ID_FROM_LIVE_BUG}/change`)
    .send({ startTime: '11:00', endTime: '13:00', reason: 'Phase 4 live test' });

  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.success, false);
  assert.strictEqual(res.body.code, 'INVALID_SESSION_ID');
  // Must never have reached the service layer / attempted a DB query:
  assert.strictEqual(calls.length, 0, 'applyChange must never be called with a malformed id');
});

test('POST /api/schedule/:sessionId/change with a valid-format id reaches the service correctly (no regression)', async () => {
  calls.length = 0;
  const app = buildTestApp();

  const res = await request(app)
    .post(`/api/schedule/${VALID_ID}/change`)
    .send({ startTime: '11:00', endTime: '13:00', reason: 'A legitimate change' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].fn, 'applyChange');
  assert.strictEqual(calls[0].sessionId, VALID_ID);
});

test('GET /api/schedule/:sessionId with a malformed id returns a clean validation error, not 500', async () => {
  calls.length = 0;
  const app = buildTestApp();

  const res = await request(app).get(`/api/schedule/${MALFORMED_ID_FROM_LIVE_BUG}`);

  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.code, 'INVALID_SESSION_ID');
  assert.strictEqual(calls.length, 0);
});

// ===========================================================================
// Regression: POST /:sessionId/change with `status` nested inside `current`
// (the exact live body shape: { current: { status: "CANCELLED" }, reason })
// was silently discarded by the controller before ever reaching
// ScheduleService — see schedule.controller.js's applyOneTimeChange for the
// full root-cause explanation. This block wires the REAL (fake-model-backed)
// ScheduleService into the shared module — replacing the simple stub used by
// the tests above, only for these tests, added last in the file so it
// doesn't affect any test declared earlier — so both the fixed controller
// AND the real CANCELLED/RESTORED/noop logic in ScheduleService are proven
// together, exactly reproducing the live scenario end-to-end.
// ===========================================================================

test('POST /:sessionId/change (status nested in current): full ACTIVE -> CANCELLED -> RESTORED -> noop cycle', async () => {
  // eslint-disable-next-line global-require
  const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
  // eslint-disable-next-line global-require
  const { createScheduleService } = require('../services/ScheduleService');
  // eslint-disable-next-line global-require
  const { createNotificationService } = require('../services/NotificationService');
  // eslint-disable-next-line global-require
  const { ROLES, CLASS_TYPES, GROUPS } = require('../utils/constants');

  const scope = createTestFixtureScope();
  const fakeModels = {
    User: createFakeCollection('user', [{ username: 'admin', role: ROLES.ADMIN, isActive: true }], scope),
    Student: createFakeCollection('student', [], scope),
    Doctor: createFakeCollection('doctor', [{ userId: 'user_1', fullName: 'Dr One', isActive: true }], scope),
    TA: createFakeCollection('ta', [], scope),
    Leader: createFakeCollection('leader', [], scope),
    Subject: createFakeCollection(
      'subject',
      [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', isActive: true }],
      scope
    ),
    Room: createFakeCollection('room', [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }], scope),
    ScheduleTemplate: createFakeCollection('template', [], scope),
    ScheduleSession: createFakeCollection('session', [], scope),
    ScheduleChange: createFakeCollection('change', [], scope),
    Notification: createFakeCollection('notification', [], scope),
    NotificationRecipient: createFakeCollection('recipient', [], scope),
    Request: createFakeCollection('request', [], scope),
    AuditLog: createFakeCollection('audit', [], scope),
    SystemSettings: { getSingleton: async () => ({ maintenanceMode: false, maintenanceMessage: '' }) },
  };

  const notificationService = createNotificationService({ models: fakeModels });
  const realScheduleService = createScheduleService({
    models: fakeModels,
    auditService: { recordAudit: async () => {} },
    notificationService,
    // Pass-through — no real MongoDB in this test file; the default
    // production runInTransaction would try mongoose.startSession()
    // against a non-existent connection and time out.
    runInTransaction: async (callback) => callback({ __passthroughFakeSession: true }),
  });

  await realScheduleService.createTemplate({
    actorUser: { id: 'user_1', role: ROLES.ADMIN },
    subjectId: 'subject_1',
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek: 'SATURDAY',
    startTime: '10:00',
    endTime: '12:00',
    roomId: 'room_1',
    doctorId: 'doctor_1',
    effectiveFrom: '2026-01-01',
  });
  const [session] = await realScheduleService.getSessionsForRange({
    startDate: '2026-10-03',
    endDate: '2026-10-03',
  });
  assert.strictEqual(session.status, 'ACTIVE');

  // The fake collection generates readable ids like 'session_1', which
  // is not a syntactically valid ObjectId — the controller's ID-format
  // guard (added in a prior correction round) would reject it before
  // ever reaching the service. Since `session` is the SAME object
  // reference stored inside the fake collection (see fakeCollection.js),
  // overriding its _id here mutates the actual stored document too, so
  // subsequent lookups by this id still resolve correctly.
  session._id = '507f1f77bcf86cd799439099';

  // Wire the REAL service into the already-required router/controller
  // (this overrides the simple stub used by every test above; declared
  // last so nothing earlier is affected).
  scheduleService.getSessionById = realScheduleService.getSessionById;
  scheduleService.applyChange = realScheduleService.applyChange;

  const app = buildTestApp();

  // Step 1: ACTIVE -> CANCELLED, using the EXACT nested body shape from
  // the live bug report.
  const cancelRes = await request(app)
    .post(`/api/schedule/${session._id}/change`)
    .send({ current: { status: 'CANCELLED' }, reason: 'Phase 4 cancellation live test' });

  assert.strictEqual(cancelRes.status, 200);
  assert.strictEqual(cancelRes.body.noop, false, 'must NOT be a no-op — this is the exact bug being fixed');
  assert.ok(cancelRes.body.change, 'a ScheduleChange must have been created');
  assert.ok(cancelRes.body.change.changeTypes.includes('CANCELLED'));

  const afterCancel = await realScheduleService.getSessionById(session._id);
  assert.strictEqual(afterCancel.status, 'CANCELLED');

  // Step 2: CANCELLED -> ACTIVE (restore), same nested shape.
  const restoreRes = await request(app)
    .post(`/api/schedule/${session._id}/change`)
    .send({ current: { status: 'ACTIVE' }, reason: 'Restoring' });

  assert.strictEqual(restoreRes.status, 200);
  assert.strictEqual(restoreRes.body.noop, false);
  assert.ok(restoreRes.body.change.changeTypes.includes('RESTORED'));

  const afterRestore = await realScheduleService.getSessionById(session._id);
  assert.strictEqual(afterRestore.status, 'ACTIVE');

  // Step 3: an identical status request (already ACTIVE -> ACTIVE) must
  // be a genuine no-op — no new ScheduleChange, no new notification.
  const changeCountBefore = fakeModels.ScheduleChange._docs.length;
  const noopRes = await request(app)
    .post(`/api/schedule/${session._id}/change`)
    .send({ current: { status: 'ACTIVE' }, reason: 'Already active' });

  assert.strictEqual(noopRes.status, 200);
  assert.strictEqual(noopRes.body.noop, true);
  assert.strictEqual(noopRes.body.change, null);
  assert.strictEqual(fakeModels.ScheduleChange._docs.length, changeCountBefore, 'no new ScheduleChange for a no-op');
});
