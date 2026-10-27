/**
 * server/tests/adminSettingsRoutes.test.js
 *
 * HTTP-level regression tests for Part G3E-A (Admin Settings API):
 *   GET   /api/admin/settings
 *   PATCH /api/admin/settings
 *
 * This exercises the REAL router (server/routes/admin.routes.js), the
 * REAL requireAuth/requireRole/checkMaintenanceMode chain already applied
 * to every /api/admin/* route, and the REAL controller — only the DB-
 * touching leaf calls (SettingsService's underlying SystemSettings model
 * access, and the User lookup inside requireAuth) are stubbed, following
 * the same monkey-patch-before-require pattern used in
 * server/tests/scheduleRoutes.test.js.
 *
 * requireRole is left UNPATCHED so role rejection is genuinely exercised
 * for every role, not simulated.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

// --- Patch auth BEFORE requiring the router -------------------------------
// currentTestUser === null simulates an anonymous (no session) request.
let currentTestUser = null;
const authModule = require('../middleware/auth');
const AppError = require('../utils/AppError');
authModule.requireAuth = (req, res, next) => {
  if (!currentTestUser) {
    return next(AppError.unauthorized('Authentication required'));
  }
  req.user = currentTestUser;
  next();
};
// requireRole is intentionally left as the REAL implementation.

// --- Patch maintenance to a pass-through (same convention as scheduleRoutes.test.js) ---
const maintenanceModule = require('../middleware/maintenance');
maintenanceModule.checkMaintenanceMode = (req, res, next) => next();

// --- Patch the settings service's leaf calls --------------------------------
const settingsService = require('../services/SettingsService');
const calls = [];
let fakeSettingsDoc = {
  _id: 'settings_doc_1',
  key: 'singleton',
  maintenanceMode: false,
  maintenanceMessage: '',
  currentAcademicTerm: '',
  notificationRetentionDays: 180,
  weekOffDay: null,
  otherSettings: {},
};

settingsService.get = async () => {
  calls.push({ fn: 'get' });
  return { ...fakeSettingsDoc };
};
settingsService.update = async ({ actorUser, patch }) => {
  calls.push({ fn: 'update', actorUser, patch });
  if (
    Object.prototype.hasOwnProperty.call(patch, 'notificationRetentionDays') &&
    (typeof patch.notificationRetentionDays !== 'number' || patch.notificationRetentionDays < 1)
  ) {
    throw AppError.badRequest('notificationRetentionDays must be a number >= 1', 'VALIDATION_ERROR');
  }
  fakeSettingsDoc = { ...fakeSettingsDoc, ...patch };
  return { ...fakeSettingsDoc };
};

// eslint-disable-next-line global-require
const adminRoutes = require('../routes/admin.routes');
const { errorHandler } = require('../middleware/errorHandler');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  app.use(errorHandler);
  return app;
}

function setUser(role, id = `u_${role.toLowerCase()}`) {
  currentTestUser = { id, username: id, role };
}
function setAnonymous() {
  currentTestUser = null;
}

const NON_ADMIN_ROLES = ['STUDENT', 'DOCTOR', 'TA', 'LEADER'];

// ===========================================================================
// GET /api/admin/settings — authorization
// ===========================================================================
test('GET /api/admin/settings: anonymous request is rejected (401)', async () => {
  setAnonymous();
  const res = await request(buildTestApp()).get('/api/admin/settings');
  assert.strictEqual(res.status, 401);
});

for (const role of NON_ADMIN_ROLES) {
  test(`GET /api/admin/settings: ${role} is rejected (403)`, async () => {
    setUser(role);
    const res = await request(buildTestApp()).get('/api/admin/settings');
    assert.strictEqual(res.status, 403);
  });
}

test('GET /api/admin/settings: Admin succeeds and returns the singleton', async () => {
  setUser('ADMIN');
  calls.length = 0;
  const res = await request(buildTestApp()).get('/api/admin/settings');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.settings.notificationRetentionDays, fakeSettingsDoc.notificationRetentionDays);
  assert.deepStrictEqual(calls, [{ fn: 'get' }]);
  // Pins the exact single-key envelope { success, settings } that
  // client/js/pages/admin-settings.js's loadSettings() depends on:
  // apiClient.get() unwraps a response shaped like this to the bare
  // `settings` object directly (see client/js/api-client.js's unwrap()),
  // so the page must NOT destructure `.settings` off the result — it did,
  // which is exactly what made Settings show "Could not load settings."
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['settings', 'success']);
});

// ===========================================================================
// PATCH /api/admin/settings — authorization
// ===========================================================================
test('PATCH /api/admin/settings: anonymous request is rejected (401)', async () => {
  setAnonymous();
  const res = await request(buildTestApp())
    .patch('/api/admin/settings')
    .send({ notificationRetentionDays: 60 });
  assert.strictEqual(res.status, 401);
});

for (const role of NON_ADMIN_ROLES) {
  test(`PATCH /api/admin/settings: ${role} is rejected (403)`, async () => {
    setUser(role);
    const res = await request(buildTestApp())
      .patch('/api/admin/settings')
      .send({ notificationRetentionDays: 60 });
    assert.strictEqual(res.status, 403);
  });
}

test('PATCH /api/admin/settings: Admin succeeds', async () => {
  setUser('ADMIN', 'u_admin_1');
  calls.length = 0;
  const res = await request(buildTestApp())
    .patch('/api/admin/settings')
    .send({ notificationRetentionDays: 45 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.settings.notificationRetentionDays, 45);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].fn, 'update');
  assert.strictEqual(calls[0].actorUser.id, 'u_admin_1');
  assert.deepStrictEqual(calls[0].patch, { notificationRetentionDays: 45 });
  // Same single-key-envelope contract as the GET test above — this is
  // what handleSubmit()'s apiClient.patch() call depends on too.
  assert.deepStrictEqual(Object.keys(res.body).sort(), ['settings', 'success']);
});

test('PATCH /api/admin/settings: invalid notificationRetentionDays is rejected with a clean error', async () => {
  setUser('ADMIN');
  const res = await request(buildTestApp())
    .patch('/api/admin/settings')
    .send({ notificationRetentionDays: 0 });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.success, false);
});

