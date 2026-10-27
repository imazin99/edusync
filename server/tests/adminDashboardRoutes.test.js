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

const dashboardService = require('../services/AdminDashboardService');
const SAMPLE_DASHBOARD = {
  counts: { students: 3, subjects: 2, doctors: 1, tas: 1, activeTasks: 4, pendingRequests: 2 },
  recent: { scheduleChanges: [], tasks: [], requests: [], activity: [] },
};
let dashboardCalls = 0;
dashboardService.getDashboard = async () => {
  dashboardCalls += 1;
  return SAMPLE_DASHBOARD;
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

test('GET /api/admin/dashboard: anonymous request is rejected (401)', async () => {
  setAnonymous();
  const res = await request(buildTestApp()).get('/api/admin/dashboard');
  assert.strictEqual(res.status, 401);
});

for (const role of NON_ADMIN_ROLES) {
  test(`GET /api/admin/dashboard: ${role} is rejected (403)`, async () => {
    setUser(role);
    const res = await request(buildTestApp()).get('/api/admin/dashboard');
    assert.strictEqual(res.status, 403);
  });
}

test('GET /api/admin/dashboard: Admin succeeds and receives the dashboard payload', async () => {
  setUser('ADMIN');
  dashboardCalls = 0;
  const res = await request(buildTestApp()).get('/api/admin/dashboard');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.deepStrictEqual(res.body.dashboard, SAMPLE_DASHBOARD);
  assert.strictEqual(dashboardCalls, 1);
});
