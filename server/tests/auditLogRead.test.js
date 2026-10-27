/**
 * server/tests/auditLogRead.test.js
 *
 * Unit tests for AuditService.list() — Part G3E-B (Admin Audit Log Read
 * API). READ-ONLY: these tests never assert that a record was deleted or
 * modified, only that list() returns/filters the existing records
 * correctly. recordAudit() (the existing write path) is exercised here
 * only to prove it is completely unaffected by this additive change.
 *
 * Fully stubbed: no MongoDB, no shared fake helpers modified.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createAuditService } = require('../services/AuditService');

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, value]) => String(doc[key]) === String(value));
}

function buildFixture(initialRecords = []) {
  let records = [...initialRecords];
  const AuditLog = {
    find(filter = {}) {
      const rows = records.filter((r) => matches(r, filter));
      const q = Promise.resolve([...rows].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
      q.sort = () => q; // not actually used by the service (sort happens in find() above), kept for shape parity
      return q;
    },
    async create(doc) {
      const record = { _id: `al_${records.length + 1}`, createdAt: new Date(), ...doc };
      records.push(record);
      return record;
    },
  };
  return { models: { AuditLog }, getRecords: () => records };
}

const VALID_ID_1 = '6c0000000000000000000001';
const VALID_ID_2 = '6c0000000000000000000002';
const ENTITY_ID_1 = '6d0000000000000000000001';
const ENTITY_ID_2 = '6d0000000000000000000002';

function seedRecords() {
  return [
    {
      _id: 'al_1',
      actorId: VALID_ID_1,
      actorRole: 'ADMIN',
      action: 'SETTINGS_UPDATED',
      entityType: 'SystemSettings',
      entityId: ENTITY_ID_1,
      before: { notificationRetentionDays: 180 },
      after: { notificationRetentionDays: 90 },
      createdAt: new Date('2026-10-01T00:00:00Z'),
    },
    {
      _id: 'al_2',
      actorId: VALID_ID_2,
      actorRole: 'ADMIN',
      action: 'ROOM_CREATED',
      entityType: 'Room',
      entityId: ENTITY_ID_2,
      after: { building: 'A', floor: '1', roomNumber: '101' },
      createdAt: new Date('2026-10-03T00:00:00Z'),
    },
    {
      _id: 'al_3',
      actorId: VALID_ID_1,
      actorRole: 'ADMIN',
      action: 'SETTINGS_UPDATED',
      entityType: 'SystemSettings',
      entityId: ENTITY_ID_1,
      before: { maintenanceMode: false },
      after: { maintenanceMode: true },
      createdAt: new Date('2026-10-05T00:00:00Z'),
    },
  ];
}

// ===========================================================================
// READ BEHAVIOR
// ===========================================================================
test('list() with no filters returns all existing records, newest first', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list();
  assert.deepStrictEqual(rows.map((r) => r._id), ['al_3', 'al_2', 'al_1']);
});

test('list() on an empty audit log returns an empty array', async () => {
  const fx = buildFixture([]);
  const service = createAuditService(fx);
  const rows = await service.list();
  assert.deepStrictEqual(rows, []);
});

test('list() filters by entityType', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list({ entityType: 'SystemSettings' });
  assert.deepStrictEqual(rows.map((r) => r._id), ['al_3', 'al_1']);
});

test('list() filters by action', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list({ action: 'ROOM_CREATED' });
  assert.deepStrictEqual(rows.map((r) => r._id), ['al_2']);
});

test('list() filters by actorId', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list({ actorId: VALID_ID_2 });
  assert.deepStrictEqual(rows.map((r) => r._id), ['al_2']);
});

test('list() filters by entityId', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list({ entityId: ENTITY_ID_1 });
  assert.deepStrictEqual(rows.map((r) => r._id), ['al_3', 'al_1']);
});

test('combining supported filters (entityType + entityId) narrows correctly', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list({ entityType: 'SystemSettings', entityId: ENTITY_ID_1, action: 'SETTINGS_UPDATED' });
  assert.deepStrictEqual(rows.map((r) => r._id), ['al_3', 'al_1']);
});

test('combining filters that match nothing returns an empty array', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list({ entityType: 'Room', action: 'SETTINGS_UPDATED' });
  assert.deepStrictEqual(rows, []);
});

// ===========================================================================
// VALIDATION
// ===========================================================================
test('malformed actorId is rejected (422) before querying', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  await assert.rejects(
    service.list({ actorId: 'not-an-id' }),
    (err) => err.statusCode === 422 && err.code === 'INVALID_ACTOR_ID'
  );
});

test('malformed entityId is rejected (422) before querying', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  await assert.rejects(
    service.list({ entityId: 'xyz' }),
    (err) => err.statusCode === 422 && err.code === 'INVALID_ENTITY_ID'
  );
});

// ===========================================================================
// DATA SAFETY
// ===========================================================================
test('returned records preserve before/after exactly as stored, with no secret fields present', async () => {
  const fx = buildFixture(seedRecords());
  const service = createAuditService(fx);
  const rows = await service.list({ action: 'SETTINGS_UPDATED', entityId: ENTITY_ID_1 });
  const first = rows.find((r) => r._id === 'al_1');
  assert.deepStrictEqual(first.before, { notificationRetentionDays: 180 });
  assert.deepStrictEqual(first.after, { notificationRetentionDays: 90 });
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    assert.ok(!/passwordHash|password|secret|token/i.test(serialized), 'must never expose secret-like fields');
  }
});

// ===========================================================================
// REGRESSION — existing write behavior untouched by this additive change
// ===========================================================================
test('recordAudit() still writes a record exactly as before, unaffected by list() being added', async () => {
  const fx = buildFixture([]);
  const service = createAuditService(fx);

  await service.recordAudit({
    actorId: VALID_ID_1,
    actorRole: 'ADMIN',
    action: 'ROOM_CREATED',
    entityType: 'Room',
    entityId: ENTITY_ID_2,
    after: { building: 'B', floor: '2', roomNumber: '202' },
  });

  assert.strictEqual(fx.getRecords().length, 1);
  const written = fx.getRecords()[0];
  assert.strictEqual(written.action, 'ROOM_CREATED');
  assert.strictEqual(written.entityType, 'Room');

  const rows = await service.list({ entityType: 'Room' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].action, 'ROOM_CREATED');
});

test('recordAudit() failures remain best-effort (swallowed, never thrown) — unchanged contract', async () => {
  const fx = buildFixture([]);
  fx.models.AuditLog.create = async () => {
    throw new Error('simulated DB outage');
  };
  const service = createAuditService(fx);

  // Must NOT throw — this is the pre-existing contract, unchanged.
  await service.recordAudit({
    actorId: VALID_ID_1,
    actorRole: 'ADMIN',
    action: 'ROOM_CREATED',
    entityType: 'Room',
    entityId: ENTITY_ID_2,
  });
});
