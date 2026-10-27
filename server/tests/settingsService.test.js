/**
 * server/tests/settingsService.test.js
 *
 * Unit tests for SettingsService — Part G3E-A (Admin Settings API).
 * Fully stubbed: no MongoDB, no shared fake helpers modified. The stub
 * SystemSettings model mimics just enough of the real schema's behaviour
 * (the key-based singleton, the notificationRetentionDays `min: 1`
 * validator, the weekOffDay enum) to exercise SettingsService's own error
 * mapping without needing a live database.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createSettingsService } = require('../services/SettingsService');

const SINGLETON_KEY = 'singleton';
const DAY_OF_WEEK_VALUES = ['SATURDAY', 'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

function buildFixture(overrides = {}) {
  let doc = {
    _id: 'settings_doc_1',
    key: SINGLETON_KEY,
    maintenanceMode: false,
    maintenanceMessage: '',
    currentAcademicTerm: '',
    notificationRetentionDays: 180,
    weekOffDay: null,
    otherSettings: {},
    ...overrides,
  };
  let getSingletonCalls = 0;
  let findOneAndUpdateCalls = 0;

  const SystemSettings = {
    SINGLETON_KEY,
    async getSingleton() {
      getSingletonCalls += 1;
      return { ...doc };
    },
    async findOneAndUpdate(filter, update, options) {
      findOneAndUpdateCalls += 1;
      assert.strictEqual(filter.key, SINGLETON_KEY, 'must always target the singleton key');
      assert.ok(options && options.runValidators, 'runValidators must be enabled');
      const set = update.$set || {};

      // Mimic the real schema's `min: 1` validator for notificationRetentionDays.
      if (
        Object.prototype.hasOwnProperty.call(set, 'notificationRetentionDays') &&
        set.notificationRetentionDays < 1
      ) {
        const err = new Error(
          'SystemSettings validation failed: notificationRetentionDays: Path `notificationRetentionDays` ' +
            `(${set.notificationRetentionDays}) is less than minimum allowed value (1).`
        );
        err.name = 'ValidationError';
        throw err;
      }
      // Mimic the real schema's enum validator for weekOffDay.
      if (
        Object.prototype.hasOwnProperty.call(set, 'weekOffDay') &&
        set.weekOffDay !== null &&
        !DAY_OF_WEEK_VALUES.includes(set.weekOffDay)
      ) {
        const err = new Error(`\`${set.weekOffDay}\` is not a valid enum value for path \`weekOffDay\`.`);
        err.name = 'ValidationError';
        throw err;
      }

      doc = { ...doc, ...set };
      return { ...doc };
    },
  };

  const auditCalls = [];
  const auditService = {
    async recordAudit(entry) {
      auditCalls.push(entry);
    },
  };

  return {
    models: { SystemSettings },
    auditService,
    auditCalls,
    getDoc: () => doc,
    counters: {
      getSingletonCalls: () => getSingletonCalls,
      findOneAndUpdateCalls: () => findOneAndUpdateCalls,
    },
  };
}

const admin = { id: 'u_admin', role: 'ADMIN' };

// ===========================================================================
// GET behavior / singleton
// ===========================================================================
test('get() returns the existing singleton, unmodified', async () => {
  const fx = buildFixture({ notificationRetentionDays: 90 });
  const service = createSettingsService(fx);
  const settings = await service.get();
  assert.strictEqual(settings.notificationRetentionDays, 90);
  assert.strictEqual(settings.key, SINGLETON_KEY);
});

test('repeated get() calls operate on the same singleton (no duplicate created)', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  const first = await service.get();
  const second = await service.get();
  assert.strictEqual(first._id, second._id);
  assert.strictEqual(fx.counters.getSingletonCalls(), 2);
});

// ===========================================================================
// PATCH — partial update semantics
// ===========================================================================
test('update() changes only the supplied field; everything else is untouched', async () => {
  const fx = buildFixture({
    maintenanceMode: false,
    maintenanceMessage: 'original message',
    currentAcademicTerm: 'Fall 2026',
    notificationRetentionDays: 180,
  });
  const service = createSettingsService(fx);

  const updated = await service.update({ actorUser: admin, patch: { notificationRetentionDays: 60 } });

  assert.strictEqual(updated.notificationRetentionDays, 60);
  assert.strictEqual(updated.maintenanceMode, false);
  assert.strictEqual(updated.maintenanceMessage, 'original message');
  assert.strictEqual(updated.currentAcademicTerm, 'Fall 2026');
});

test('update() with multiple fields changes only those fields', async () => {
  const fx = buildFixture({ maintenanceMode: false, notificationRetentionDays: 180 });
  const service = createSettingsService(fx);

  await service.update({
    actorUser: admin,
    patch: { maintenanceMode: true, maintenanceMessage: 'Down for upgrades' },
  });

  const doc = fx.getDoc();
  assert.strictEqual(doc.maintenanceMode, true);
  assert.strictEqual(doc.maintenanceMessage, 'Down for upgrades');
  assert.strictEqual(doc.notificationRetentionDays, 180, 'untouched field must remain unchanged');
});

test('update() continues to operate on the same singleton across repeated calls', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  await service.update({ actorUser: admin, patch: { notificationRetentionDays: 30 } });
  await service.update({ actorUser: admin, patch: { notificationRetentionDays: 45 } });
  assert.strictEqual(fx.counters.findOneAndUpdateCalls(), 2);
  assert.strictEqual(fx.getDoc().notificationRetentionDays, 45);
});

// ===========================================================================
// PATCH — notificationRetentionDays validation
// ===========================================================================
test('notificationRetentionDays boundary value of 1 is accepted', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  const updated = await service.update({ actorUser: admin, patch: { notificationRetentionDays: 1 } });
  assert.strictEqual(updated.notificationRetentionDays, 1);
});

test('notificationRetentionDays of 0 is rejected', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  await assert.rejects(
    service.update({ actorUser: admin, patch: { notificationRetentionDays: 0 } }),
    (err) => err.statusCode === 422
  );
  assert.strictEqual(fx.getDoc().notificationRetentionDays, 180, 'rejected update must not apply');
});

test('negative notificationRetentionDays is rejected', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  await assert.rejects(
    service.update({ actorUser: admin, patch: { notificationRetentionDays: -5 } }),
    (err) => err.statusCode === 422
  );
});

test('non-numeric notificationRetentionDays types are rejected without silent coercion', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  for (const badValue of ['180', 'abc', null, true, [180], { days: 180 }]) {
    await assert.rejects(
      service.update({ actorUser: admin, patch: { notificationRetentionDays: badValue } }),
      (err) => err.statusCode === 422,
      `expected rejection for value: ${JSON.stringify(badValue)}`
    );
  }
  assert.strictEqual(fx.getDoc().notificationRetentionDays, 180, 'no bad value must have applied');
});

// ===========================================================================
// PATCH — unknown / unapproved fields
// ===========================================================================
test('unknown field names are rejected, not silently dropped or stored', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  await assert.rejects(
    service.update({ actorUser: admin, patch: { someRandomField: 'x' } }),
    (err) => err.statusCode === 422 && /someRandomField/.test(err.message)
  );
  assert.strictEqual(fx.counters.findOneAndUpdateCalls(), 0, 'must reject before touching the database');
});

test('attempting to set the immutable key field is rejected', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  await assert.rejects(
    service.update({ actorUser: admin, patch: { key: 'something-else' } }),
    (err) => err.statusCode === 422
  );
});

test('empty patch object is rejected', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  await assert.rejects(
    service.update({ actorUser: admin, patch: {} }),
    (err) => err.statusCode === 422
  );
});

// ===========================================================================
// AUDIT
// ===========================================================================
test('a successful update creates exactly one audit entry identifying the admin and the change', async () => {
  const fx = buildFixture({ notificationRetentionDays: 180 });
  const service = createSettingsService(fx);

  await service.update({ actorUser: admin, patch: { notificationRetentionDays: 90 } });

  assert.strictEqual(fx.auditCalls.length, 1);
  const entry = fx.auditCalls[0];
  assert.strictEqual(entry.actorId, admin.id);
  assert.strictEqual(entry.actorRole, admin.role);
  assert.strictEqual(entry.entityType, 'SystemSettings');
  assert.ok(entry.action, 'action must be set');
  assert.strictEqual(entry.before.notificationRetentionDays, 180);
  assert.strictEqual(entry.after.notificationRetentionDays, 90);
});

test('audit payload contains only the supplied/changed fields, never the whole document', async () => {
  const fx = buildFixture({ maintenanceMode: false, maintenanceMessage: 'x', notificationRetentionDays: 180 });
  const service = createSettingsService(fx);

  await service.update({ actorUser: admin, patch: { maintenanceMode: true } });

  const entry = fx.auditCalls[0];
  assert.deepStrictEqual(Object.keys(entry.before), ['maintenanceMode']);
  assert.deepStrictEqual(Object.keys(entry.after), ['maintenanceMode']);
  assert.ok(!('notificationRetentionDays' in entry.after), 'must not leak unrelated fields into the audit entry');
});

test('a rejected update (validation failure) creates no audit entry', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  await assert.rejects(service.update({ actorUser: admin, patch: { notificationRetentionDays: 0 } }));
  assert.strictEqual(fx.auditCalls.length, 0);
});

test('an audit-recording failure does not roll back an otherwise successful update (best-effort contract)', async () => {
  const fx = buildFixture({ notificationRetentionDays: 180 });
  // Mirrors the REAL AuditService contract: recordAudit catches its own
  // errors internally and never rejects (server/services/AuditService.js).
  fx.auditService.recordAudit = async () => {
    try {
      throw new Error('simulated audit backend outage');
    } catch (err) {
      // swallowed, exactly like the real best-effort implementation
    }
  };
  const service = createSettingsService(fx);

  const updated = await service.update({ actorUser: admin, patch: { notificationRetentionDays: 60 } });

  assert.strictEqual(updated.notificationRetentionDays, 60, 'settings update must still succeed');
  assert.strictEqual(fx.getDoc().notificationRetentionDays, 60);
});

// ===========================================================================
// PATCH — other allowed fields reach the real schema-shaped validation
// ===========================================================================
test('weekOffDay accepts a valid enum value and rejects an invalid one', async () => {
  const fx = buildFixture();
  const service = createSettingsService(fx);
  const updated = await service.update({ actorUser: admin, patch: { weekOffDay: 'FRIDAY' } });
  assert.strictEqual(updated.weekOffDay, 'FRIDAY');

  await assert.rejects(
    service.update({ actorUser: admin, patch: { weekOffDay: 'SOMEDAY' } }),
    (err) => err.statusCode === 422
  );
});
