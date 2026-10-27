const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

let currentTestUser = null;
const authModule = require('../middleware/auth');
const AppError = require('../utils/AppError');
authModule.requireAuth = (req, res, next) => {
  if (!currentTestUser) return next(AppError.unauthorized('Authentication required'));
  req.user = currentTestUser;
  next();
};

const maintenanceModule = require('../middleware/maintenance');
maintenanceModule.checkMaintenanceMode = (req, res, next) => next();

const auditService = require('../services/AuditService');
const calls = [];
const SAMPLE_RECORDS = [
  { _id: 'al_2', actorId: 'u_admin', actorRole: 'ADMIN', action: 'SETTINGS_UPDATED', entityType: 'SystemSettings', entityId: 'e2', before: {}, after: {}, createdAt: new Date('2026-10-05') },
  { _id: 'al_1', actorId: 'u_admin', actorRole: 'ADMIN', action: 'ROOM_CREATED', entityType: 'Room', entityId: 'e1', after: {}, createdAt: new Date('2026-10-01') },
];
auditService.list = async (args) => {
  calls.push(args);
  return SAMPLE_RECORDS;
};

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
test('GET /api/admin/audit-logs: anonymous request is rejected (401)', async () => {
  setAnonymous();
  const res = await request(buildTestApp()).get('/api/admin/audit-logs');
  assert.strictEqual(res.status, 401);
});

for (const role of NON_ADMIN_ROLES) {
  test(`GET /api/admin/audit-logs: ${role} is rejected (403)`, async () => {
    setUser(role);
    const res = await request(buildTestApp()).get('/api/admin/audit-logs');
    assert.strictEqual(res.status, 403);
  });
}

test('GET /api/admin/audit-logs: Admin succeeds', async () => {
  setUser('ADMIN');
  calls.length = 0;
  const res = await request(buildTestApp()).get('/api/admin/audit-logs');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.auditLogs.length, 2);
  assert.deepStrictEqual(calls, [{ actorId: undefined, action: undefined, entityType: undefined, entityId: undefined }]);
});
test('GET /api/admin/audit-logs: query filters are passed through to AuditService.list', async () => {
  setUser('ADMIN');
  calls.length = 0;
  await request(buildTestApp())
    .get('/api/admin/audit-logs')
    .query({ entityType: 'SystemSettings', action: 'SETTINGS_UPDATED' });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].entityType, 'SystemSettings');
  assert.strictEqual(calls[0].action, 'SETTINGS_UPDATED');
});

test('GET /api/admin/audit-logs: service-level validation errors surface as the standard error response', async () => {
  setUser('ADMIN');
  auditService.list = async () => {
    throw AppError.badRequest('actorId is not a valid id', 'INVALID_ACTOR_ID');
  };
  const res = await request(buildTestApp()).get('/api/admin/audit-logs').query({ actorId: 'bad' });
  assert.strictEqual(res.status, 422);
  assert.strictEqual(res.body.success, false);
  auditService.list = async (args) => {
    calls.push(args);
    return SAMPLE_RECORDS;
  };
});
