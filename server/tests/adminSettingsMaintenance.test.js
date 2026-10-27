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

let fakeDoc = {
  _id: 'settings_doc_1',
  key: 'singleton',
  maintenanceMode: false,
  maintenanceMessage: '',
  currentAcademicTerm: '',
  notificationRetentionDays: 180,
  weekOffDay: null,
  otherSettings: {},
};
const fakeSystemSettings = {
  SINGLETON_KEY: 'singleton',
  async getSingleton() {
    return { ...fakeDoc };
  },
  async findOneAndUpdate(filter, update, options) {
    fakeDoc = { ...fakeDoc, ...(update.$set || {}) };
    return { ...fakeDoc };
  },
};
const { createMaintenanceMiddleware } = require('../middleware/maintenance');
const { createSettingsService } = require('../services/SettingsService');

const auditCalls = [];
const realCheckMaintenanceMode = createMaintenanceMiddleware({
  models: { SystemSettings: fakeSystemSettings },
}).checkMaintenanceMode;
const realSettingsServiceInstance = createSettingsService({
  models: { SystemSettings: fakeSystemSettings },
  auditService: { recordAudit: async (entry) => auditCalls.push(entry) },
});

const maintenanceModule = require('../middleware/maintenance');
maintenanceModule.checkMaintenanceMode = realCheckMaintenanceMode;
const settingsServiceModule = require('../services/SettingsService');
settingsServiceModule.get = realSettingsServiceInstance.get;
settingsServiceModule.update = realSettingsServiceInstance.update;

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

test('1. Admin can still GET /api/admin/settings while maintenanceMode is true', async () => {
  fakeDoc.maintenanceMode = true;
  fakeDoc.maintenanceMessage = 'Down for upgrades.';
  setUser('ADMIN');

  const res = await request(buildTestApp()).get('/api/admin/settings');

  assert.strictEqual(res.status, 200, 'Admin must not be blocked by maintenance mode');
  assert.strictEqual(res.body.settings.maintenanceMode, true);
});

test('2. Admin can PATCH { maintenanceMode: false } to turn maintenance off, while maintenance is currently on', async () => {
  fakeDoc.maintenanceMode = true;
  setUser('ADMIN');

  const res = await request(buildTestApp())
    .patch('/api/admin/settings')
    .send({ maintenanceMode: false });

  assert.strictEqual(res.status, 200, 'the PATCH request itself must not be blocked by the mode it is turning off');
  assert.strictEqual(res.body.settings.maintenanceMode, false);
  assert.strictEqual(fakeDoc.maintenanceMode, false, 'the underlying singleton must actually be updated');
});

test('3. This is already allowed by the existing checkMaintenanceMode implementation (no middleware change)', async () => {

  const layer = adminRoutes.stack.find((l) => l.route && l.route.path === '/settings');
  assert.ok(layer, '/settings route must be registered on the admin router');

});

test('4. Enabling maintenance mode via PATCH still behaves correctly (value round-trips, Admin keeps access)', async () => {
  fakeDoc.maintenanceMode = false;
  setUser('ADMIN');

  const enableRes = await request(buildTestApp())
    .patch('/api/admin/settings')
    .send({ maintenanceMode: true, maintenanceMessage: 'Scheduled maintenance.' });

  assert.strictEqual(enableRes.status, 200);
  assert.strictEqual(enableRes.body.settings.maintenanceMode, true);
  assert.strictEqual(fakeDoc.maintenanceMode, true);

  const getRes = await request(buildTestApp()).get('/api/admin/settings');
  assert.strictEqual(getRes.status, 200);
  assert.strictEqual(getRes.body.settings.maintenanceMode, true);
});

for (const role of ['STUDENT', 'DOCTOR', 'TA', 'LEADER']) {
  test(`5. ${role} remains blocked from /api/admin/settings regardless of maintenanceMode value`, async () => {
    for (const mode of [true, false]) {
      fakeDoc.maintenanceMode = mode;
      setUser(role);
      const res = await request(buildTestApp()).get('/api/admin/settings');
      assert.strictEqual(res.status, 403, `${role} with maintenanceMode=${mode}`);
    }
  });
}

test('audit entry is still recorded when maintenanceMode is toggled off via PATCH', async () => {
  fakeDoc.maintenanceMode = true;
  auditCalls.length = 0;
  setUser('ADMIN', 'u_admin_mm');

  await request(buildTestApp()).patch('/api/admin/settings').send({ maintenanceMode: false });

  assert.strictEqual(auditCalls.length, 1);
  assert.strictEqual(auditCalls[0].actorId, 'u_admin_mm');
  assert.strictEqual(auditCalls[0].after.maintenanceMode, false);
});
