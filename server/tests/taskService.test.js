/**
 * server/tests/taskService.test.js
 *
 * Backend Gap Closure — G3C: TaskService Transaction Gap.
 *
 * Database rollback tests for TaskService.create/update/remove — the
 * three non-attachment operations G3C wraps in a transaction. The two
 * attachment operations (addAttachment/removeAttachment) have their
 * rollback AND filesystem-compensation tests in taskAttachments.test.js
 * instead, alongside their existing G2 tests, per the approved plan.
 *
 * SIMULATION-ONLY: these tests use helpers/fakeTransaction.js, the same
 * in-memory snapshot/restore mechanism already established and proven
 * by Part E's ScheduleService tests and G1's taskDeadlineJob tests. It
 * does NOT exercise real MongoDB ACID behavior — it only proves that
 * TaskService's write phase, as written, correctly treats a thrown
 * error from the notification dispatch as a signal to undo the Task
 * write from the same transaction attempt. Real transactional
 * correctness against a live MongoDB replica set can only be verified
 * by running this project against one directly (see the dedicated G3C
 * live-verification script).
 */

const test = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner } = require('./helpers/fakeTransaction');
const { ROLES } = require('../utils/constants');
const { createTaskService } = require('../services/TaskService');
const { createNotificationService } = require('../services/NotificationService');

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
    Task: c('task', 'tasks'),
    TaskCompletion: c('completion', 'completions'),
    Notification: c('notification', 'notifications'),
    NotificationRecipient: c('recipient', 'recipients'),
  };
}

function baseFixture() {
  const models = buildModels({
    users: [{ username: 'dr', role: ROLES.DOCTOR, isActive: true }],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', hasSections: false, isActive: true }],
  });
  const notificationService = createNotificationService({ models });
  const doctorActor = { id: 'user_1', role: ROLES.DOCTOR };
  return { models, notificationService, doctorActor };
}

/** Forces notifications.dispatch() to throw exactly once (for the one
 * call made inside the transaction under test), via Notification.create
 * — the same injection point G1's own rollback test uses. */
function forceDispatchFailureOnce(models) {
  const originalCreate = models.Notification.create.bind(models.Notification);
  models.Notification.create = async (...args) => {
    models.Notification.create = originalCreate; // one-shot
    throw new Error('SIMULATED_NOTIFICATION_FAILURE');
  };
}

// ===========================================================================
// create()
// ===========================================================================

test('TaskService.create: if notification dispatch fails, the Task is never persisted (full rollback)', async () => {
  const { models, notificationService, doctorActor } = baseFixture();
  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: createFakeTransactionRunner(models),
  });

  forceDispatchFailureOnce(models);

  await assert.rejects(
    () => taskService.create({ actorUser: doctorActor, title: 'Should not persist', description: '', subjectId: 'subject_1' }),
    /SIMULATED_NOTIFICATION_FAILURE/
  );

  assert.strictEqual(models.Task._docs.length, 0, 'no Task document must exist after a failed create()');
  assert.strictEqual(models.Notification._docs.length, 0, 'no Notification document must exist either');
  assert.strictEqual(models.NotificationRecipient._docs.length, 0);
});

test('TaskService.create: regression — a normal (non-failing) create still works inside the real transaction wrapper', async () => {
  const { models, notificationService, doctorActor } = baseFixture();
  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: createFakeTransactionRunner(models),
  });

  const task = await taskService.create({ actorUser: doctorActor, title: 'Fine', description: '', subjectId: 'subject_1' });
  assert.strictEqual(models.Task._docs.length, 1);
  assert.strictEqual(task.title, 'Fine');
  const newTaskNotifs = models.Notification._docs.filter((n) => n.type === 'NEW_TASK');
  assert.strictEqual(newTaskNotifs.length, 1);
});

// ===========================================================================
// update()
// ===========================================================================

test('TaskService.update: if notification dispatch fails, the Task\'s fields are reverted (full rollback)', async () => {
  const { models, notificationService, doctorActor } = baseFixture();
  const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });
  const setupService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });
  const task = await setupService.create({
    actorUser: doctorActor,
    title: 'Original title',
    description: 'original description',
    subjectId: 'subject_1',
    deadline: new Date('2026-07-01T00:00:00.000Z'),
  });

  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: createFakeTransactionRunner(models),
  });

  forceDispatchFailureOnce(models);

  await assert.rejects(
    () =>
      taskService.update({
        actorUser: doctorActor,
        taskId: task._id,
        title: 'Changed title',
        description: 'changed description',
        deadline: new Date('2026-08-01T00:00:00.000Z'),
      }),
    /SIMULATED_NOTIFICATION_FAILURE/
  );

  const after = await models.Task.findById(task._id);
  assert.strictEqual(after.title, 'Original title', 'title must revert');
  assert.strictEqual(after.description, 'original description', 'description must revert');
  assert.strictEqual(after.deadline.toISOString(), new Date('2026-07-01T00:00:00.000Z').toISOString(), 'deadline must revert');

  // Only the original NEW_TASK notification exists — no DEADLINE_CHANGED
  // or TASK_UPDATED notification from the failed attempt.
  assert.strictEqual(models.Notification._docs.filter((n) => n.type !== 'NEW_TASK').length, 0);
});

test('TaskService.update: regression — a normal update still dispatches DEADLINE_CHANGED correctly inside the real transaction wrapper', async () => {
  const { models, notificationService, doctorActor } = baseFixture();
  const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });
  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });
  const task = await taskService.create({
    actorUser: doctorActor,
    title: 'T',
    description: '',
    subjectId: 'subject_1',
    deadline: new Date('2026-07-01T00:00:00.000Z'),
  });

  const updated = await taskService.update({
    actorUser: doctorActor,
    taskId: task._id,
    deadline: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.strictEqual(updated.deadline.toISOString(), new Date('2026-07-15T00:00:00.000Z').toISOString());
  assert.strictEqual(models.Notification._docs.filter((n) => n.type === 'DEADLINE_CHANGED').length, 1);
});

// ===========================================================================
// remove()
// ===========================================================================

test('TaskService.remove: if notification dispatch fails, the Task is NOT soft-deleted (full rollback)', async () => {
  const { models, notificationService, doctorActor } = baseFixture();
  const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });
  const setupService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });
  const task = await setupService.create({ actorUser: doctorActor, title: 'T', description: '', subjectId: 'subject_1' });

  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: createFakeTransactionRunner(models),
  });

  forceDispatchFailureOnce(models);

  await assert.rejects(
    () => taskService.remove({ actorUser: doctorActor, taskId: task._id }),
    /SIMULATED_NOTIFICATION_FAILURE/
  );

  const after = await models.Task.findById(task._id);
  // Falsy check, not strict-equal-null: a never-deleted task created via
  // this harness never had `deletedAt` set as a key at all (the real
  // Mongoose schema default `null` is what provides that in
  // production — the fake collection doesn't apply schema defaults).
  // The rollback correctly removes the key the failed attempt added,
  // landing back at `undefined`, which is exactly as "not deleted" as
  // `null` — this is what TaskService's own code checks for too
  // (`if (!task || task.deletedAt)`).
  assert.ok(!after.deletedAt, 'deletedAt must be reverted — the task must still be considered active');
  assert.strictEqual(models.Notification._docs.filter((n) => n.type === 'TASK_DELETED').length, 0);
});

test('TaskService.remove: regression — a normal remove still soft-deletes and dispatches TASK_DELETED inside the real transaction wrapper', async () => {
  const { models, notificationService, doctorActor } = baseFixture();
  const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });
  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });
  const task = await taskService.create({ actorUser: doctorActor, title: 'T', description: '', subjectId: 'subject_1' });

  await taskService.remove({ actorUser: doctorActor, taskId: task._id });

  const after = await models.Task.findById(task._id);
  assert.ok(after.deletedAt instanceof Date);
  assert.strictEqual(models.Notification._docs.filter((n) => n.type === 'TASK_DELETED').length, 1);
});
