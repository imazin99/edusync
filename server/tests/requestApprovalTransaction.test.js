/**
 * server/tests/requestApprovalTransaction.test.js
 *
 * G3H fix 2 — atomic group-change request approval. RequestService.review
 * now wraps the Request status write and the Student group write in the
 * SAME runInTransaction call (same pattern already established and frozen
 * by TaskService/ScheduleService/taskDeadlineJob — see server/utils/transaction.js).
 *
 * This file covers exactly what G3H asks for:
 *   1. successful approval updates both request and student group
 *   2/3. a forced failure rolls back BOTH the request update and the
 *        student group update (not just one of them)
 *   4. both saves receive the SAME session/transaction object
 *
 * The existing phase4.test.js RequestService tests (approve updates
 * group; reviewing an already-reviewed request is rejected) were updated
 * to inject the existing fakeTransaction helper and still pass unchanged
 * in substance — not duplicated here.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner } = require('./helpers/fakeTransaction');
const { createRequestService } = require('../services/RequestService');
const { ROLES, REQUEST_STATUS } = require('../utils/constants');

function buildModels() {
  const scope = createTestFixtureScope();
  const models = {
    User: createFakeCollection('user', [], scope),
    Student: createFakeCollection(
      'student',
      [{ userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: 'G1', isActive: true }],
      scope
    ),
    Request: createFakeCollection('request', [], scope),
  };
  return models;
}

const noopAudit = { recordAudit: async () => {} };
const admin = { id: 'admin_1', role: ROLES.ADMIN };

async function seedGroupChangeRequest(service) {
  return service.createGroupChangeRequest({
    actorUser: { id: 'user_1', role: ROLES.STUDENT },
    requestedGroup: 'G2',
  });
}

// ===========================================================================
// 1. Successful approval updates both request and student group
// ===========================================================================
test('review(APPROVED, GROUP_CHANGE): both the request status and the student group are updated', async () => {
  const models = buildModels();
  const service = createRequestService({
    models,
    auditService: noopAudit,
    runInTransaction: createFakeTransactionRunner(models),
  });

  const request = await seedGroupChangeRequest(service);
  const reviewed = await service.review({ actorUser: admin, requestId: request._id, status: 'APPROVED' });

  assert.strictEqual(reviewed.status, REQUEST_STATUS.APPROVED);
  const student = models.Student._docs.find((s) => s.userId === 'user_1');
  assert.strictEqual(student.group, 'G2');
});

// ===========================================================================
// 2 & 3. A forced failure rolls back BOTH writes together
// ===========================================================================
test('review(APPROVED, GROUP_CHANGE): a failure after both writes rolls back BOTH the request status and the student group', async () => {
  const models = buildModels();
  const service = createRequestService({
    models,
    auditService: noopAudit,
    runInTransaction: createFakeTransactionRunner(models),
  });

  const request = await seedGroupChangeRequest(service);

  // Force a failure that happens only AFTER both saves ran inside the
  // transaction's callback, by making the student document's own .save
  // throw — proving the request's save (which already ran) is undone too,
  // not just the student's.
  const student = models.Student._docs.find((s) => s.userId === 'user_1');
  const originalStudentSave = student.save;
  Object.defineProperty(student, 'save', {
    value: async () => {
    throw new Error('simulated failure saving the student');
  },
    enumerable: false,
    configurable: true,
  });

  await assert.rejects(
    service.review({ actorUser: admin, requestId: request._id, status: 'APPROVED' }),
    /simulated failure saving the student/
  );

  Object.defineProperty(student, 'save', { value: originalStudentSave, enumerable: false, configurable: true });

  // Rollback must have restored BOTH documents to their pre-transaction state.
  const requestAfter = models.Request._docs.find((r) => r._id === request._id);
  assert.strictEqual(requestAfter.status, REQUEST_STATUS.PENDING, 'request status must be rolled back');
  assert.strictEqual(requestAfter.reviewedBy, undefined, 'reviewedBy must be rolled back');
  assert.strictEqual(student.group, 'G1', 'student group must be rolled back, not left as G2');
});

test('review(APPROVED, GROUP_CHANGE): a failure saving the REQUEST itself also leaves the student group untouched', async () => {
  const models = buildModels();
  const service = createRequestService({
    models,
    auditService: noopAudit,
    runInTransaction: createFakeTransactionRunner(models),
  });

  const request = await seedGroupChangeRequest(service);
  const requestDoc = models.Request._docs.find((r) => r._id === request._id);
  const originalRequestSave = requestDoc.save;
  Object.defineProperty(requestDoc, 'save', {
    value: async () => {
    throw new Error('simulated failure saving the request');
  },
    enumerable: false,
    configurable: true,
  });

  await assert.rejects(
    service.review({ actorUser: admin, requestId: request._id, status: 'APPROVED' }),
    /simulated failure saving the request/
  );

  Object.defineProperty(requestDoc, 'save', { value: originalRequestSave, enumerable: false, configurable: true });

  const student = models.Student._docs.find((s) => s.userId === 'user_1');
  assert.strictEqual(student.group, 'G1', 'student group must never have been committed');
  assert.strictEqual(requestDoc.status, REQUEST_STATUS.PENDING);
});

// ===========================================================================
// 4. Both operations use the SAME transaction/session
// ===========================================================================
test('review(APPROVED, GROUP_CHANGE): the request save and the student save receive the identical session object', async () => {
  const models = buildModels();
  const seenSessions = [];
  const sentinelSession = { __sentinel: true };

  // Lightweight spy runner (not the snapshot/restore fake) — only needs to
  // hand the SAME session object to the callback, and the saves below
  // record what they were actually called with.
  const spyRunInTransaction = async (callback) => callback(sentinelSession);

  const service = createRequestService({
    models,
    auditService: noopAudit,
    runInTransaction: spyRunInTransaction,
  });

  const request = await seedGroupChangeRequest(service);
  const requestDoc = models.Request._docs.find((r) => r._id === request._id);
  const student = models.Student._docs.find((s) => s.userId === 'user_1');

  const originalRequestSave = requestDoc.save;
  const originalStudentSave = student.save;
  Object.defineProperty(requestDoc, 'save', {
    value: async (opts) => {
      seenSessions.push({ who: 'request', session: opts && opts.session });
      return requestDoc;
    },
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(student, 'save', {
    value: async (opts) => {
      seenSessions.push({ who: 'student', session: opts && opts.session });
      return student;
    },
    enumerable: false,
    configurable: true,
  });

  try {
    await service.review({ actorUser: admin, requestId: request._id, status: 'APPROVED' });
  } finally {
    Object.defineProperty(requestDoc, 'save', { value: originalRequestSave, enumerable: false, configurable: true });
    Object.defineProperty(student, 'save', { value: originalStudentSave, enumerable: false, configurable: true });
  }

  assert.strictEqual(seenSessions.length, 2);
  assert.strictEqual(seenSessions[0].session, sentinelSession);
  assert.strictEqual(seenSessions[1].session, sentinelSession);
  assert.strictEqual(seenSessions[0].session, seenSessions[1].session, 'both saves must share the identical session object');
});

// ===========================================================================
// Preserved behaviour: non-group-change paths are unaffected
// ===========================================================================
test('review(REJECTED): still works, and no Student write is attempted', async () => {
  const models = buildModels();
  const service = createRequestService({
    models,
    auditService: noopAudit,
    runInTransaction: createFakeTransactionRunner(models),
  });

  const request = await seedGroupChangeRequest(service);
  const reviewed = await service.review({ actorUser: admin, requestId: request._id, status: 'REJECTED' });

  assert.strictEqual(reviewed.status, REQUEST_STATUS.REJECTED);
  const student = models.Student._docs.find((s) => s.userId === 'user_1');
  assert.strictEqual(student.group, 'G1', 'rejecting a request must never touch the student group');
});

test('review: reviewing an already-reviewed request is still rejected with 409 (unchanged)', async () => {
  const models = buildModels();
  const service = createRequestService({
    models,
    auditService: noopAudit,
    runInTransaction: createFakeTransactionRunner(models),
  });

  const request = await seedGroupChangeRequest(service);
  await service.review({ actorUser: admin, requestId: request._id, status: 'APPROVED' });

  await assert.rejects(
    service.review({ actorUser: admin, requestId: request._id, status: 'REJECTED' }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      return true;
    }
  );
});
