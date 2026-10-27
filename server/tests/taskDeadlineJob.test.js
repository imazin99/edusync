/**
 * server/tests/taskDeadlineJob.test.js
 *
 * Backend Gap Closure — Part G1: Task Deadline Background Job.
 *
 * Covers the job itself (server/jobs/taskDeadlineJob.js) against the
 * fakeCollection/fakeTransaction harness this project's whole test
 * suite already uses (consistent with phase4.test.js, concurrency.test.js,
 * etc. — no live MongoDB here; that's a separate, later manual step per
 * this project's established practice for Parts E and F).
 *
 * There was no prior test file for Task/TaskService at all, so this file
 * also includes a small baseline regression section for TaskService's
 * existing create/update/remove/markDone behavior — otherwise "existing
 * task behavior remains intact" would be unverifiable.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner } = require('./helpers/fakeTransaction');
const { ROLES, TASK_STATUS } = require('../utils/constants');
const { createTaskService } = require('../services/TaskService');
const { createNotificationService } = require('../services/NotificationService');
const { createTaskDeadlineJob } = require('../jobs/taskDeadlineJob');

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
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'leader', role: ROLES.LEADER, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    leaders: [{ userId: 'user_2', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', hasSections: false, isActive: true }],
  });

  const notificationService = createNotificationService({ models });
  const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });

  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: passthroughTx,
  });
  const job = createTaskDeadlineJob({ models, notificationService, runInTransaction: passthroughTx });

  const doctorActor = { id: 'user_1', role: ROLES.DOCTOR };

  return { models, taskService, job, notificationService, doctorActor };
}

async function createTask(taskService, doctorActor, overrides = {}) {
  return taskService.create({
    actorUser: doctorActor,
    title: 'Assignment 1',
    description: 'Read chapter 3',
    subjectId: 'subject_1',
    ...overrides,
  });
}

// ===========================================================================
// 1. Task with no deadline
// ===========================================================================
test('Part G1: a task with no deadline is never a candidate and is left untouched', async () => {
  const { models, taskService, job, doctorActor } = baseFixture();
  const task = await createTask(taskService, doctorActor); // no deadline given

  const before = models.Notification._docs.length;
  const summary = await job.run({ now: new Date() });

  assert.strictEqual(summary.checked, 0);
  assert.strictEqual(summary.markedOverdue, 0);
  const after = await models.Task.findById(task._id);
  assert.strictEqual(after.status, TASK_STATUS.ACTIVE);
  assert.strictEqual(models.Notification._docs.length, before);
});

// ===========================================================================
// 2. Task whose deadline is still in the future
// ===========================================================================
test('Part G1: a task whose deadline is still in the future is left untouched', async () => {
  const { models, taskService, job, doctorActor } = baseFixture();
  const now = new Date('2026-06-01T00:00:00.000Z');
  const future = new Date('2026-06-02T00:00:00.000Z');
  const task = await createTask(taskService, doctorActor, { deadline: future });

  const before = models.Notification._docs.length;
  const summary = await job.run({ now });

  assert.strictEqual(summary.checked, 0);
  const after = await models.Task.findById(task._id);
  assert.strictEqual(after.status, TASK_STATUS.ACTIVE);
  assert.strictEqual(models.Notification._docs.length, before);
});

// ===========================================================================
// 3. Task whose deadline has passed
// ===========================================================================
test('Part G1: a task whose deadline has passed is marked OVERDUE', async () => {
  const { models, taskService, job, doctorActor } = baseFixture();
  const now = new Date('2026-06-01T00:00:00.000Z');
  const past = new Date('2026-05-31T00:00:00.000Z');
  const task = await createTask(taskService, doctorActor, { deadline: past });

  const summary = await job.run({ now });

  assert.strictEqual(summary.checked, 1);
  assert.strictEqual(summary.markedOverdue, 1);
  const after = await models.Task.findById(task._id);
  assert.strictEqual(after.status, TASK_STATUS.OVERDUE);
});

// ===========================================================================
// 4. Deadline-passed notification is created
// ===========================================================================
test('Part G1: a deadline-passed notification is created with the right fields and recipients', async () => {
  const { models, taskService, job, doctorActor } = baseFixture();
  const now = new Date('2026-06-01T00:00:00.000Z');
  const past = new Date('2026-05-31T00:00:00.000Z');
  const task = await createTask(taskService, doctorActor, { deadline: past });
  const notificationsBefore = models.Notification._docs.length; // the NEW_TASK one from create()

  await job.run({ now });

  const deadlinePassed = models.Notification._docs.filter((n) => n.type === 'DEADLINE_PASSED');
  assert.strictEqual(deadlinePassed.length, 1);
  const notification = deadlinePassed[0];
  assert.strictEqual(notification.category, 'TASK');
  assert.strictEqual(notification.relatedType, 'TASK');
  assert.strictEqual(String(notification.relatedId), String(task._id));
  assert.strictEqual(notification.createdBy, null); // system-generated, no human actor

  const recipients = models.NotificationRecipient._docs.filter(
    (r) => String(r.notificationId) === String(notification._id)
  );
  const recipientUserIds = recipients.map((r) => String(r.userId)).sort();
  // Doctor (subject staff), Leader, and Admin should all be notified —
  // there is no actor here to exclude (createdBy is null).
  assert.deepStrictEqual(recipientUserIds, ['user_1', 'user_2', 'user_3'].sort());
  assert.ok(models.Notification._docs.length === notificationsBefore + 1);
});

// ===========================================================================
// 5. Running the job twice does not create a duplicate notification
// ===========================================================================
test('Part G1: running the job twice does not create a duplicate deadline-passed notification', async () => {
  const { models, taskService, job, doctorActor } = baseFixture();
  const now = new Date('2026-06-01T00:00:00.000Z');
  const past = new Date('2026-05-31T00:00:00.000Z');
  await createTask(taskService, doctorActor, { deadline: past });

  const first = await job.run({ now });
  const second = await job.run({ now: new Date(now.getTime() + 1000) }); // simulate the next scheduled run

  assert.strictEqual(first.markedOverdue, 1);
  // On a plain sequential re-run, the task's status is ALREADY OVERDUE,
  // so the query itself excludes it from `candidates` entirely — it's
  // not even considered a second time. (summary.alreadyHandled counts a
  // different scenario: a task that WAS fetched as a candidate in this
  // run but got claimed by another overlapping run before this run's
  // own claim — see the missing-Subject test above, which does not
  // apply here.)
  assert.strictEqual(second.checked, 0);
  assert.strictEqual(second.markedOverdue, 0);
  assert.strictEqual(second.alreadyHandled, 0);

  const deadlinePassed = models.Notification._docs.filter((n) => n.type === 'DEADLINE_PASSED');
  assert.strictEqual(deadlinePassed.length, 1, 'exactly one DEADLINE_PASSED notification must exist after two runs');
});

// ===========================================================================
// 6. Multiple overdue tasks are handled correctly
// ===========================================================================
test('Part G1: multiple overdue tasks are each handled correctly in one run, unaffected tasks are left alone', async () => {
  const { models, taskService, job, doctorActor } = baseFixture();
  const now = new Date('2026-06-01T00:00:00.000Z');
  const past1 = new Date('2026-05-30T00:00:00.000Z');
  const past2 = new Date('2026-05-31T12:00:00.000Z');
  const future = new Date('2026-06-05T00:00:00.000Z');

  const overdueA = await createTask(taskService, doctorActor, { title: 'Overdue A', deadline: past1 });
  const overdueB = await createTask(taskService, doctorActor, { title: 'Overdue B', deadline: past2 });
  const stillFuture = await createTask(taskService, doctorActor, { title: 'Future task', deadline: future });
  const noDeadline = await createTask(taskService, doctorActor, { title: 'No deadline task' });

  const summary = await job.run({ now });

  assert.strictEqual(summary.checked, 2);
  assert.strictEqual(summary.markedOverdue, 2);

  assert.strictEqual((await models.Task.findById(overdueA._id)).status, TASK_STATUS.OVERDUE);
  assert.strictEqual((await models.Task.findById(overdueB._id)).status, TASK_STATUS.OVERDUE);
  assert.strictEqual((await models.Task.findById(stillFuture._id)).status, TASK_STATUS.ACTIVE);
  assert.strictEqual((await models.Task.findById(noDeadline._id)).status, TASK_STATUS.ACTIVE);

  const deadlinePassed = models.Notification._docs.filter((n) => n.type === 'DEADLINE_PASSED');
  assert.strictEqual(deadlinePassed.length, 2);
  const relatedIds = deadlinePassed.map((n) => String(n.relatedId)).sort();
  assert.deepStrictEqual(relatedIds, [String(overdueA._id), String(overdueB._id)].sort());
});

// ===========================================================================
// Extra safety-net check: a genuine data anomaly (missing Subject) rolls
// back the claim instead of silently marking OVERDUE with no
// notification — this is what justifies wrapping the claim + dispatch
// in a transaction at all. Uses the REAL fake-transaction rollback
// simulation (helpers/fakeTransaction.js), not the plain passthrough.
// ===========================================================================
test('Part G1: a task referencing a missing Subject is left retryable, not silently marked OVERDUE', async () => {
  const { models, taskService, doctorActor } = baseFixture();
  const now = new Date('2026-06-01T00:00:00.000Z');
  const past = new Date('2026-05-31T00:00:00.000Z');
  const task = await createTask(taskService, doctorActor, { deadline: past });

  // Simulate the referenced Subject having vanished.
  const idx = models.Subject._docs.findIndex((s) => s._id === 'subject_1');
  models.Subject._docs.splice(idx, 1);

  const notificationService = createNotificationService({ models });
  const fakeTxRunner = createFakeTransactionRunner(models);
  const job = createTaskDeadlineJob({ models, notificationService, runInTransaction: fakeTxRunner });

  const summary = await job.run({ now });

  assert.strictEqual(summary.failed, 1);
  assert.strictEqual(summary.markedOverdue, 0);
  const after = await models.Task.findById(task._id);
  assert.strictEqual(after.status, TASK_STATUS.ACTIVE, 'the claim must be rolled back, leaving the task retryable next run');
  const deadlinePassed = models.Notification._docs.filter((n) => n.type === 'DEADLINE_PASSED');
  assert.strictEqual(deadlinePassed.length, 0);
});

// ===========================================================================
// 7. Existing task behavior / regression (no prior test file covered this)
// ===========================================================================
test('Part G1 regression: TaskService.create/update/remove/markDone/unmarkDone still behave as before', async () => {
  const { models, taskService, doctorActor } = baseFixture();

  const task = await createTask(taskService, doctorActor, { deadline: new Date('2026-07-01T00:00:00.000Z') });
  assert.strictEqual(task.status, TASK_STATUS.ACTIVE);
  const newTaskNotifications = models.Notification._docs.filter((n) => n.type === 'NEW_TASK');
  assert.strictEqual(newTaskNotifications.length, 1);

  const updated = await taskService.update({
    actorUser: doctorActor,
    taskId: task._id,
    deadline: new Date('2026-07-15T00:00:00.000Z'),
  });
  assert.strictEqual(updated.deadline.toISOString(), new Date('2026-07-15T00:00:00.000Z').toISOString());
  const deadlineChangedNotifications = models.Notification._docs.filter((n) => n.type === 'DEADLINE_CHANGED');
  assert.strictEqual(deadlineChangedNotifications.length, 1);

  models.Student._docs.push({ _id: 'student_1', userId: 'user_4', group: 'ALL', isActive: true });
  const completion = await taskService.markDone({ actorUser: { id: 'user_4' }, taskId: task._id });
  assert.ok(completion._id);
  const completionsAfterMark = models.TaskCompletion._docs.filter((c) => String(c.taskId) === String(task._id));
  assert.strictEqual(completionsAfterMark.length, 1);

  await taskService.unmarkDone({ actorUser: { id: 'user_4' }, taskId: task._id });
  const completionsAfterUnmark = models.TaskCompletion._docs.filter((c) => String(c.taskId) === String(task._id));
  assert.strictEqual(completionsAfterUnmark.length, 0);

  await taskService.remove({ actorUser: doctorActor, taskId: task._id });
  await assert.rejects(() => taskService.getById(task._id), /not found/i);
  const raw = await models.Task.findById(task._id);
  assert.ok(raw.deletedAt, 'task must be soft-deleted, not hard-removed');
});
