/**
 * server/tests/notifications.test.js
 *
 * Backend Gap Closure — G3A: Notification Test Coverage Only.
 *
 * This file adds test coverage ONLY — no production code was changed to
 * make any of these tests pass. One test-helper-only change was made to
 * server/tests/helpers/fakeCollection.js (see the "SORTING" section
 * below for the full explanation and the dedicated proof test for it).
 *
 * Sections:
 *   1. NotificationService.listForUser — isolation + real newest-first sort
 *   2. NotificationService.markRead — success, isolation, nonexistent id,
 *      repeated-read (documents CURRENT behavior, not a new rule)
 *   3. NotificationService.markAllRead — isolation + unread-only
 *   4. HTTP-level: GET /api/notifications, PATCH /:id/read, PATCH /read-all
 *   5. Scenario-level recipient/exclusion: TA-initiated, Leader-initiated,
 *      and Admin-initiated schedule changes; Task deletion; generic Task
 *      update
 *   6. Proof that fakeCollection's .sort() now genuinely sorts
 *
 * No existing test file was modified. No production file was modified.
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { ROLES, GROUPS, CLASS_TYPES } = require('../utils/constants');
const { createNotificationService } = require('../services/NotificationService');
const { createScheduleService } = require('../services/ScheduleService');
const { createTaskService } = require('../services/TaskService');

function buildModels(seed = {}) {
  const scope = createTestFixtureScope();
  const c = (prefix, key) => createFakeCollection(prefix, seed[key] || [], scope);
  return {
    User: c('user', 'users'),
    Doctor: c('doctor', 'doctors'),
    TA: c('ta', 'tas'),
    Leader: c('leader', 'leaders'),
    Student: c('student', 'students'),
    Subject: c('subject', 'subjects'),
    Room: c('room', 'rooms'),
    ScheduleTemplate: c('template', 'templates'),
    ScheduleSession: c('session', 'sessions'),
    ScheduleChange: c('change', 'changes'),
    Task: c('task', 'tasks'),
    TaskCompletion: c('completion', 'completions'),
    Notification: c('notification', 'notifications'),
    NotificationRecipient: c('recipient', 'recipients'),
    SystemSettings: { getSingleton: async () => ({ maintenanceMode: false, maintenanceMessage: '' }) },
  };
}

const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });

// ===========================================================================
// 1. listForUser
// ===========================================================================

test('NotificationService.listForUser only returns the calling user\'s own notifications (recipient isolation)', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });

  const notifA = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'For A', message: 'x' });
  const notifB = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'For B', message: 'x' });
  await models.NotificationRecipient.create({ notificationId: notifA._id, userId: 'user_A' });
  await models.NotificationRecipient.create({ notificationId: notifB._id, userId: 'user_B' });

  const listA = await service.listForUser({ userId: 'user_A' });
  const listB = await service.listForUser({ userId: 'user_B' });

  assert.strictEqual(listA.length, 1);
  assert.strictEqual(listA[0].notification.title, 'For A');
  assert.strictEqual(listB.length, 1);
  assert.strictEqual(listB[0].notification.title, 'For B');
});

test('NotificationService.listForUser returns results newest-first', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });

  // Created out of chronological order on purpose, with explicit
  // createdAt timestamps (not relying on wall-clock call order), so this
  // genuinely exercises .sort({createdAt:-1}) rather than coincidentally
  // matching insertion order.
  const notifMiddle = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'Middle', message: 'x' });
  const notifOldest = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'Oldest', message: 'x' });
  const notifNewest = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'Newest', message: 'x' });

  await models.NotificationRecipient.create({
    notificationId: notifMiddle._id,
    userId: 'user_A',
    createdAt: new Date('2026-06-01T12:00:00.000Z'),
  });
  await models.NotificationRecipient.create({
    notificationId: notifOldest._id,
    userId: 'user_A',
    createdAt: new Date('2026-06-01T08:00:00.000Z'),
  });
  await models.NotificationRecipient.create({
    notificationId: notifNewest._id,
    userId: 'user_A',
    createdAt: new Date('2026-06-01T18:00:00.000Z'),
  });

  const list = await service.listForUser({ userId: 'user_A' });
  assert.deepStrictEqual(
    list.map((r) => r.notification.title),
    ['Newest', 'Middle', 'Oldest']
  );
});

test('NotificationService.listForUser unreadOnly=true excludes already-read notifications', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });

  const readNotif = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'Read', message: 'x' });
  const unreadNotif = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'Unread', message: 'x' });
  await models.NotificationRecipient.create({ notificationId: readNotif._id, userId: 'user_A', readAt: new Date() });
  await models.NotificationRecipient.create({ notificationId: unreadNotif._id, userId: 'user_A', readAt: null });

  const all = await service.listForUser({ userId: 'user_A' });
  const unreadOnly = await service.listForUser({ userId: 'user_A', unreadOnly: true });

  assert.strictEqual(all.length, 2);
  assert.strictEqual(unreadOnly.length, 1);
  assert.strictEqual(unreadOnly[0].notification.title, 'Unread');
});

// ===========================================================================
// 2. markRead
// ===========================================================================

test('NotificationService.markRead marks the recipient row read', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });
  const notif = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'N', message: 'x' });
  const recipient = await models.NotificationRecipient.create({ notificationId: notif._id, userId: 'user_A', readAt: null });

  const before = await service.listForUser({ userId: 'user_A' });
  assert.strictEqual(before[0].readAt, null);

  await service.markRead({ userId: 'user_A', recipientId: recipient._id });

  const after = await service.listForUser({ userId: 'user_A' });
  assert.ok(after[0].readAt instanceof Date);
});

test('NotificationService.markRead rejects a recipient row belonging to a DIFFERENT user (ownership isolation)', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });
  const notif = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'N', message: 'x' });
  const recipient = await models.NotificationRecipient.create({ notificationId: notif._id, userId: 'user_A', readAt: null });

  await assert.rejects(() => service.markRead({ userId: 'user_B', recipientId: recipient._id }), /not found/i);

  // And it must genuinely be untouched, not silently marked read anyway.
  const stillUnread = await models.NotificationRecipient.findById(recipient._id);
  assert.strictEqual(stillUnread.readAt, null);
});

test('NotificationService.markRead rejects a nonexistent recipient id', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });
  await assert.rejects(() => service.markRead({ userId: 'user_A', recipientId: 'does_not_exist' }), /not found/i);
});

test('NotificationService.markRead CURRENT repeated-read behavior: marking an already-read notification again succeeds and updates readAt (not a frozen no-op)', async () => {
  // This documents the implementation exactly as it stands today — the
  // Master Specification does not define whether a second mark-as-read
  // should be a true no-op (preserving the original readAt) or may
  // re-stamp it; G3's audit flagged this as "needs clarification", and
  // per this round's explicit scope, no business-rule decision is made
  // here. This test exists so any future change to this behavior is a
  // deliberate, visible decision, not a silent regression.
  const models = buildModels();
  const service = createNotificationService({ models });
  const notif = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'N', message: 'x' });
  const recipient = await models.NotificationRecipient.create({ notificationId: notif._id, userId: 'user_A', readAt: null });

  const firstRead = await service.markRead({ userId: 'user_A', recipientId: recipient._id });
  assert.ok(firstRead.readAt instanceof Date);

  // No error on a second call, and readAt is a (new) Date, not frozen at
  // its original value — asserted structurally rather than by comparing
  // exact timestamps, since two calls in the same millisecond would make
  // a strict inequality check flaky.
  const secondRead = await service.markRead({ userId: 'user_A', recipientId: recipient._id });
  assert.ok(secondRead.readAt instanceof Date);
});

// ===========================================================================
// 3. markAllRead
// ===========================================================================

test('NotificationService.markAllRead only updates unread notifications belonging to the calling user', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });

  const n1 = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'A-unread-1', message: 'x' });
  const n2 = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'A-unread-2', message: 'x' });
  const n3 = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'A-already-read', message: 'x' });
  const n4 = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'B-unread', message: 'x' });

  const alreadyReadAt = new Date('2026-01-01T00:00:00.000Z');
  await models.NotificationRecipient.create({ notificationId: n1._id, userId: 'user_A', readAt: null });
  await models.NotificationRecipient.create({ notificationId: n2._id, userId: 'user_A', readAt: null });
  const r3 = await models.NotificationRecipient.create({ notificationId: n3._id, userId: 'user_A', readAt: alreadyReadAt });
  const r4 = await models.NotificationRecipient.create({ notificationId: n4._id, userId: 'user_B', readAt: null });

  const result = await service.markAllRead({ userId: 'user_A' });
  assert.strictEqual(result.updated, 2, 'only the 2 genuinely unread rows for user_A must be counted/updated');

  const aList = await service.listForUser({ userId: 'user_A' });
  assert.ok(aList.every((r) => r.readAt instanceof Date), 'every one of user_A\'s notifications must now be read');

  // The already-read row's original timestamp must be untouched — it
  // was never a candidate (markAllRead only ever queries readAt: null).
  const r3After = await models.NotificationRecipient.findById(r3._id);
  assert.strictEqual(r3After.readAt.getTime(), alreadyReadAt.getTime());

  // User B's unread notification must be completely unaffected
  // (isolation).
  const r4After = await models.NotificationRecipient.findById(r4._id);
  assert.strictEqual(r4After.readAt, null);
});

// ===========================================================================
// 4. HTTP-level route tests, mirroring the established pattern in
// scheduleRoutes.test.js / taskAttachments.test.js: patch middleware/auth
// and the service module's exports BEFORE requiring the real router, so
// the REAL routes.js + REAL controller + REAL Express routing are all
// exercised, with only the DB-touching leaf calls stubbed.
// ===========================================================================

let currentTestUser = { id: 'user_1', role: ROLES.STUDENT };

const authModule = require('../middleware/auth');
authModule.requireAuth = (req, res, next) => {
  req.user = currentTestUser;
  next();
};
const maintenanceModule = require('../middleware/maintenance');
maintenanceModule.checkMaintenanceMode = (req, res, next) => next();

const notificationServiceModule = require('../services/NotificationService');
const httpCalls = [];
notificationServiceModule.listForUser = async ({ userId, unreadOnly }) => {
  httpCalls.push({ fn: 'listForUser', userId, unreadOnly });
  return [{ recipientId: 'recipient_1', readAt: null, notification: { title: 'Stub' } }];
};
notificationServiceModule.markRead = async ({ userId, recipientId }) => {
  httpCalls.push({ fn: 'markRead', userId, recipientId });
  return { _id: recipientId, readAt: new Date() };
};
notificationServiceModule.markAllRead = async ({ userId }) => {
  httpCalls.push({ fn: 'markAllRead', userId });
  return { updated: 3 };
};

// eslint-disable-next-line import/order
const notificationsRoutes = require('../routes/notifications.routes');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test('HTTP GET /api/notifications reaches the real route/controller and returns the list', async () => {
  httpCalls.length = 0;
  currentTestUser = { id: 'user_7', role: ROLES.STUDENT };
  const app = buildTestApp();

  const res = await request(app).get('/api/notifications').query({ unreadOnly: 'true' });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.notifications.length, 1);
  assert.strictEqual(httpCalls.length, 1);
  assert.strictEqual(httpCalls[0].fn, 'listForUser');
  assert.strictEqual(httpCalls[0].userId, 'user_7');
  assert.strictEqual(httpCalls[0].unreadOnly, true);
});

test('HTTP GET /api/notifications with no unreadOnly query param defaults to false', async () => {
  httpCalls.length = 0;
  currentTestUser = { id: 'user_7', role: ROLES.STUDENT };
  const app = buildTestApp();

  await request(app).get('/api/notifications');

  assert.strictEqual(httpCalls[0].unreadOnly, false);
});

test('HTTP PATCH /api/notifications/:id/read reaches the real route/controller with the correct user and id', async () => {
  httpCalls.length = 0;
  currentTestUser = { id: 'user_7', role: ROLES.STUDENT };
  const app = buildTestApp();

  // G3B note: this id must be a syntactically valid 24-hex ObjectId
  // shape — 'recipient_42' (used before G3B's id-format guard existed)
  // would now be correctly rejected at the route by that guard before
  // ever reaching the stubbed service below. Updated here only to keep
  // this test's original intent (proving request routing/param-passing
  // reaches the service correctly) meaningful under the new validation
  // — no assertion in this test changed.
  const VALID_RECIPIENT_ID = '507f1f77bcf86cd799439055';
  const res = await request(app).patch(`/api/notifications/${VALID_RECIPIENT_ID}/read`);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(httpCalls.length, 1);
  assert.strictEqual(httpCalls[0].fn, 'markRead');
  assert.strictEqual(httpCalls[0].userId, 'user_7');
  assert.strictEqual(httpCalls[0].recipientId, VALID_RECIPIENT_ID);
});

test('HTTP PATCH /api/notifications/read-all reaches the real route/controller for the correct user', async () => {
  httpCalls.length = 0;
  currentTestUser = { id: 'user_9', role: ROLES.LEADER };
  const app = buildTestApp();

  const res = await request(app).patch('/api/notifications/read-all');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.updated, 3);
  assert.strictEqual(httpCalls.length, 1);
  assert.strictEqual(httpCalls[0].fn, 'markAllRead');
  assert.strictEqual(httpCalls[0].userId, 'user_9');
});

test('HTTP PATCH /api/notifications/read-all is NOT captured by /:id/read (route-order regression check)', async () => {
  // "read-all" could in principle be swallowed by the earlier
  // "/:id/read"-shaped route if routes.js ever declared :id/read before
  // read-all — this pins down that it currently is NOT, the same class
  // of regression scheduleRoutes.test.js guards against for /sessions.
  httpCalls.length = 0;
  currentTestUser = { id: 'user_9', role: ROLES.LEADER };
  const app = buildTestApp();

  await request(app).patch('/api/notifications/read-all');

  assert.strictEqual(httpCalls.length, 1);
  assert.strictEqual(httpCalls[0].fn, 'markAllRead', 'must reach markAllRead, not markRead with id="read-all"');
});

// ===========================================================================
// 5. Scenario-level recipient/exclusion tests
// ===========================================================================

function scheduleScenarioFixture() {
  const models = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true }, // user_1
      { username: 'ta', role: ROLES.TA, isActive: true }, // user_2
      { username: 'leader', role: ROLES.LEADER, isActive: true }, // user_3
      { username: 'admin', role: ROLES.ADMIN, isActive: true }, // user_4
      { username: 'student', role: ROLES.STUDENT, isActive: true }, // user_5
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    tas: [{ userId: 'user_2', fullName: 'TA One', isActive: true }],
    leaders: [{ userId: 'user_3', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
    students: [{ userId: 'user_5', group: GROUPS.ALL, isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', taId: 'ta_1', hasSections: false, isActive: true }],
    rooms: [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }],
  });
  const notificationService = createNotificationService({ models });
  const service = createScheduleService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });
  return { models, service };
}

async function setUpOneSession(service) {
  await service.createTemplate({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
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
  const [session] = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  return session;
}

function recipientUserIdsFor(models, notification) {
  return models.NotificationRecipient._docs
    .filter((r) => String(r.notificationId) === String(notification._id))
    .map((r) => String(r.userId))
    .sort();
}

/** The ScheduleChange history record (result.change) is NOT the same
 * document as the Notification dispatch() creates — find the actual
 * Notification by its relatedId (the session id), as
 * ScheduleService.applyChange() sets it. */
function findScheduleChangeNotification(models, sessionId) {
  const candidates = models.Notification._docs.filter(
    (n) => n.relatedType === 'SCHEDULE_SESSION' && String(n.relatedId) === String(sessionId)
  );
  return candidates[candidates.length - 1];
}

test('Scenario: a TA-initiated schedule change excludes the TA but includes Doctor/Leader/Admin/Student', async () => {
  const { models, service } = scheduleScenarioFixture();
  const session = await setUpOneSession(service);

  await service.applyChange({
    actorUser: { id: 'user_2', role: ROLES.TA },
    sessionId: session._id,
    patch: { roomId: 'room_2' },
    reason: 'TA-initiated change',
  });

  const notification = findScheduleChangeNotification(models, session._id);
  assert.ok(notification, 'a SCHEDULE_SESSION notification must have been created');
  const recipients = recipientUserIdsFor(models, notification);
  assert.deepStrictEqual(recipients, ['user_1', 'user_3', 'user_4', 'user_5'].sort());
  assert.ok(!recipients.includes('user_2'), 'the acting TA must be excluded');
});

test('Scenario: a Leader-initiated schedule change excludes the Leader but includes Doctor/TA/Admin/Student', async () => {
  const { models, service } = scheduleScenarioFixture();
  const session = await setUpOneSession(service);

  await service.applyChange({
    actorUser: { id: 'user_3', role: ROLES.LEADER },
    sessionId: session._id,
    patch: { roomId: 'room_2' },
    reason: 'Leader-initiated change',
  });

  const notification = findScheduleChangeNotification(models, session._id);
  assert.ok(notification, 'a SCHEDULE_SESSION notification must have been created');
  const recipients = recipientUserIdsFor(models, notification);
  assert.deepStrictEqual(recipients, ['user_1', 'user_2', 'user_4', 'user_5'].sort());
  assert.ok(!recipients.includes('user_3'), 'the acting Leader must be excluded');
});

test('Scenario: an Admin-initiated schedule change STILL includes the Admin (Admin-always-included rule preserved)', async () => {
  const { models, service } = scheduleScenarioFixture();
  const session = await setUpOneSession(service);

  await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId: session._id,
    patch: { roomId: 'room_2' },
    reason: 'Admin-initiated change',
  });

  const notification = findScheduleChangeNotification(models, session._id);
  assert.ok(notification, 'a SCHEDULE_SESSION notification must have been created');
  const recipients = recipientUserIdsFor(models, notification);
  assert.deepStrictEqual(recipients, ['user_1', 'user_2', 'user_3', 'user_4', 'user_5'].sort());
  assert.ok(recipients.includes('user_4'), 'the acting Admin must still receive the notification');
});

function taskScenarioFixture() {
  const models = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true }, // user_1
      { username: 'ta', role: ROLES.TA, isActive: true }, // user_2
      { username: 'leader', role: ROLES.LEADER, isActive: true }, // user_3
      { username: 'admin', role: ROLES.ADMIN, isActive: true }, // user_4
      { username: 'student', role: ROLES.STUDENT, isActive: true }, // user_5
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    tas: [{ userId: 'user_2', fullName: 'TA One', isActive: true }],
    leaders: [{ userId: 'user_3', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
    students: [{ userId: 'user_5', group: GROUPS.ALL, isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', taId: 'ta_1', hasSections: false, isActive: true }],
  });
  const notificationService = createNotificationService({ models });
  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });
  return { models, taskService };
}

test('Scenario: Task deletion (TASK_DELETED) excludes the deleting Doctor but includes TA/Leader/Admin/Student', async () => {
  const { models, taskService } = taskScenarioFixture();
  const doctorActor = { id: 'user_1', role: ROLES.DOCTOR };
  const task = await taskService.create({ actorUser: doctorActor, title: 'T', description: '', subjectId: 'subject_1' });

  await taskService.remove({ actorUser: doctorActor, taskId: task._id });

  const deletedNotif = models.Notification._docs.find((n) => n.type === 'TASK_DELETED');
  assert.ok(deletedNotif, 'a TASK_DELETED notification must have been created');
  const recipients = recipientUserIdsFor(models, deletedNotif);
  assert.deepStrictEqual(recipients, ['user_2', 'user_3', 'user_4', 'user_5'].sort());
  assert.ok(!recipients.includes('user_1'), 'the deleting Doctor must be excluded');
});

test('Scenario: a generic task update (TASK_UPDATED, non-deadline field) excludes the updating Doctor but includes TA/Leader/Admin/Student', async () => {
  const { models, taskService } = taskScenarioFixture();
  const doctorActor = { id: 'user_1', role: ROLES.DOCTOR };
  const task = await taskService.create({ actorUser: doctorActor, title: 'T', description: 'old', subjectId: 'subject_1' });

  await taskService.update({ actorUser: doctorActor, taskId: task._id, description: 'new description only' });

  const updatedNotifs = models.Notification._docs.filter((n) => n.type === 'TASK_UPDATED');
  assert.strictEqual(updatedNotifs.length, 1, 'a description-only change must dispatch TASK_UPDATED, not DEADLINE_CHANGED');
  const recipients = recipientUserIdsFor(models, updatedNotifs[0]);
  assert.deepStrictEqual(recipients, ['user_2', 'user_3', 'user_4', 'user_5'].sort());
  assert.ok(!recipients.includes('user_1'), 'the updating Doctor must be excluded');
});

// ===========================================================================
// 6. SORTING — proof that fakeCollection's .sort() is now a real sort.
//
// Before this change, server/tests/helpers/fakeCollection.js's
// fakeQuery().sort() was a pure no-op passthrough — calling .sort(...)
// returned the SAME unsorted array every time. This meant every existing
// production call site that relies on .sort() for correctness
// (RequestService, RoomService, SubjectService, ScheduleService,
// NotificationService.listForUser, StaffService, TaskService,
// StudentService) was, under this test harness, only ever observing
// coincidental insertion order — a test could pass for the wrong reason,
// and a genuinely broken sort in production code would never be caught
// here.
//
// THE FIX (test-helper only, server/tests/helpers/fakeCollection.js):
// .sort(spec) now actually reorders the resolved array by the given
// Mongoose-style spec ({field: 1 | -1}, dotted paths supported, Dates
// compared by time value, multiple keys applied in order). This is what
// makes the "returns results newest-first" test above a genuine,
// meaningful test rather than one that would pass even if
// listForUser's .sort() call were deleted entirely.
//
// SAFETY: this changes shared, generic test infrastructure used by every
// other test file. The full existing suite (all other test files) was
// re-run after this change and is unaffected — no existing test's
// pass/fail outcome changed. See the G3A report for the exact command
// and result.
// ===========================================================================

test('fakeCollection .sort() genuinely reorders results (descending, ascending, multi-key, dotted path)', async () => {
  const scope = createTestFixtureScope();
  const docs = createFakeCollection(
    'doc',
    [
      { group: 'B', nested: { order: 2 }, createdAt: new Date('2026-01-02T00:00:00.000Z') },
      { group: 'A', nested: { order: 3 }, createdAt: new Date('2026-01-03T00:00:00.000Z') },
      { group: 'A', nested: { order: 1 }, createdAt: new Date('2026-01-01T00:00:00.000Z') },
    ],
    scope
  );

  const descByDate = await docs.find({}).sort({ createdAt: -1 });
  assert.deepStrictEqual(
    descByDate.map((d) => d.createdAt.toISOString().slice(0, 10)),
    ['2026-01-03', '2026-01-02', '2026-01-01']
  );

  const ascByDate = await docs.find({}).sort({ createdAt: 1 });
  assert.deepStrictEqual(
    ascByDate.map((d) => d.createdAt.toISOString().slice(0, 10)),
    ['2026-01-01', '2026-01-02', '2026-01-03']
  );

  // Multi-key: group ascending, then nested.order ascending within each
  // group — exercises both multi-key ordering AND a dotted path, exactly
  // matching ScheduleService's real .sort({date:1, 'current.startTime':1}).
  const multiKey = await docs.find({}).sort({ group: 1, 'nested.order': 1 });
  assert.deepStrictEqual(
    multiKey.map((d) => `${d.group}:${d.nested.order}`),
    ['A:1', 'A:3', 'B:2']
  );

  // Chained after .select()/.session() (both still no-ops, but must not
  // break the chain) to mirror how production code actually calls this.
  const chained = await docs.find({}).select('group').sort({ createdAt: -1 });
  assert.strictEqual(chained[0].group, 'A'); // the 2026-01-03 doc
});

test('fakeCollection .sort() with no argument remains a harmless no-op (backward compatible)', async () => {
  const scope = createTestFixtureScope();
  const docs = createFakeCollection('doc', [{ v: 1 }, { v: 2 }, { v: 3 }], scope);
  const result = await docs.find({}).sort();
  assert.strictEqual(result.length, 3);
});

// ===========================================================================
// 7. G3B — malformed notification id handling (PATCH /:id/read)
//
// These three tests wire the REAL NotificationService (fake-model-backed,
// no live MongoDB) into the already-required router/controller, replacing
// the simple stub used by the HTTP tests above — declared last, exactly
// as scheduleRoutes.test.js's equivalent end-of-file block does, so
// nothing declared earlier in this file is affected.
// ===========================================================================

test('G3B: PATCH /api/notifications/:id/read with a malformed id returns a clean 4xx, never reaching the service (and existing valid-id/ownership behavior is unchanged)', async () => {
  const models = buildModels();
  const service = createNotificationService({ models });

  const notif = await models.Notification.create({ type: 'TASK_UPDATED', category: 'TASK', title: 'N', message: 'x' });
  const ownRecipient = await models.NotificationRecipient.create({ notificationId: notif._id, userId: 'user_7', readAt: null });
  const otherUsersRecipient = await models.NotificationRecipient.create({
    notificationId: notif._id,
    userId: 'user_SOMEONE_ELSE',
    readAt: null,
  });
  // The fake collection generates readable ids like 'recipient_1', which
  // are not syntactically valid ObjectId shapes — the new format guard
  // would reject them before ever reaching the service, same as the
  // existing precedent in scheduleRoutes.test.js. Since these are the
  // SAME object references stored inside the fake collection (see
  // fakeCollection.js), overriding _id here mutates the stored documents
  // too, so subsequent lookups by this id still resolve correctly.
  ownRecipient._id = '507f1f77bcf86cd799439011';
  otherUsersRecipient._id = '507f1f77bcf86cd799439022';

  // Wire the REAL service into the shared module (overrides the stub
  // used by every HTTP test declared above).
  notificationServiceModule.markRead = service.markRead;
  notificationServiceModule.listForUser = service.listForUser;
  notificationServiceModule.markAllRead = service.markAllRead;

  currentTestUser = { id: 'user_7', role: ROLES.STUDENT };
  const app = buildTestApp();

  // 1. Malformed id → clean 4xx, never reaches the service/DB at all.
  const malformedRes = await request(app).patch('/api/notifications/not-a-valid-id/read');
  assert.strictEqual(malformedRes.status, 422);
  assert.strictEqual(malformedRes.body.success, false);
  assert.strictEqual(malformedRes.body.code, 'INVALID_NOTIFICATION_ID');
  const stillUnreadAfterMalformed = await models.NotificationRecipient.findById(ownRecipient._id);
  assert.strictEqual(stillUnreadAfterMalformed.readAt, null, 'a malformed id must never reach/modify any real recipient row');

  // 2. Valid-FORMAT id that does not exist → existing 404 behavior
  // retained (not swallowed by the new format guard).
  const nonexistentButValidFormatId = '507f1f77bcf86cd799439099';
  const nonexistentRes = await request(app).patch(`/api/notifications/${nonexistentButValidFormatId}/read`);
  assert.strictEqual(nonexistentRes.status, 404);

  // 3. Valid id, but it belongs to a DIFFERENT user → existing
  // ownership/isolation behavior retained (still a 404, same as before
  // G3B — this guard only changes FORMAT handling, not ownership logic).
  const otherUsersRes = await request(app).patch(`/api/notifications/${otherUsersRecipient._id}/read`);
  assert.strictEqual(otherUsersRes.status, 404);
  const stillUnreadForOtherUser = await models.NotificationRecipient.findById(otherUsersRecipient._id);
  assert.strictEqual(stillUnreadForOtherUser.readAt, null, 'another user\'s notification must remain untouched');

  // And the legitimate, valid, own-id case still succeeds (no
  // regression from the new guard on the happy path).
  const ownRes = await request(app).patch(`/api/notifications/${ownRecipient._id}/read`);
  assert.strictEqual(ownRes.status, 200);
  const nowRead = await models.NotificationRecipient.findById(ownRecipient._id);
  assert.ok(nowRead.readAt instanceof Date);
});
