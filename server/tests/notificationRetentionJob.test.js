/**
 * server/tests/notificationRetentionJob.test.js
 *
 * Backend Gap Closure — Part G3D: Notification Retention Job.
 *
 * Covers server/jobs/notificationRetentionJob.js against the same
 * fakeCollection / fakeTransaction harness the rest of the suite uses.
 * No live MongoDB is needed.
 *
 * Test-harness note: the frozen helpers/fakeCollection.js has no
 * deleteMany(). The job needs it (NotificationRecipient.deleteMany), and
 * the helper must not be modified in G3D, so this file adds a minimal
 * deleteMany() to the fake NotificationRecipient collection locally. It
 * removes matching documents in place (splice), which is what lets the
 * fakeTransaction rollback restore them. SystemSettings is supplied as a
 * plain object with getSingleton(), since no fake exists for it.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner } = require('./helpers/fakeTransaction');
const { createNotificationService } = require('../services/NotificationService');
const { createNotificationRetentionJob } = require('../jobs/notificationRetentionJob');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-06T00:00:00.000Z');

function daysAgo(days) {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/**
 * Adds the minimal deleteMany() this job needs to a fake collection.
 * Removes matching docs in place so fakeTransaction's snapshot/restore
 * can bring them back on rollback.
 */
function addDeleteMany(collection) {
  collection.deleteMany = async function deleteMany(filter = {}) {
    const docs = collection._docs;
    let deletedCount = 0;
    for (let i = docs.length - 1; i >= 0; i -= 1) {
      const doc = docs[i];
      const matches = Object.entries(filter).every(([key, value]) => {
        const docValue = doc[key];
        if (docValue && typeof docValue === 'object' && typeof docValue.toString === 'function') {
          return docValue.toString() === String(value);
        }
        return docValue === value;
      });
      if (matches) {
        docs.splice(i, 1);
        deletedCount += 1;
      }
    }
    return { deletedCount };
  };
  return collection;
}

function buildModels({ notifications = [], recipients = [], retentionDays = 180 } = {}) {
  const scope = createTestFixtureScope();
  const models = {
    User: createFakeCollection('user', [], scope),
    Leader: createFakeCollection('leader', [], scope),
    Student: createFakeCollection('student', [], scope),
    Doctor: createFakeCollection('doctor', [], scope),
    TA: createFakeCollection('ta', [], scope),
    Notification: createFakeCollection('notification', notifications, scope),
    NotificationRecipient: addDeleteMany(createFakeCollection('recipient', recipients, scope)),
    SystemSettings: {
      getSingleton: async () => ({ notificationRetentionDays: retentionDays }),
    },
  };
  return models;
}

function buildJob(models, { runInTransaction } = {}) {
  return createNotificationRetentionJob({
    models,
    runInTransaction: runInTransaction || createFakeTransactionRunner(models),
  });
}

// ===========================================================================
// 1. Non-expired notification survives
// ===========================================================================
test('G3D: a notification inside the retention window is not deleted', async () => {
  const models = buildModels({
    notifications: [{ _id: 'notification_1', createdAt: daysAgo(10), type: 'NEW_TASK' }],
    recipients: [{ _id: 'recipient_1', notificationId: 'notification_1', userId: 'user_1' }],
    retentionDays: 180,
  });
  const job = buildJob(models);

  const summary = await job.run({ now: NOW });

  assert.strictEqual(summary.checked, 0);
  assert.strictEqual(summary.deleted, 0);
  assert.strictEqual(models.Notification._docs.length, 1);
  assert.strictEqual(models.NotificationRecipient._docs.length, 1);
});

// ===========================================================================
// 2. Expired notification and all its recipients are deleted
// ===========================================================================
test('G3D: an expired notification and all of its recipients are deleted', async () => {
  const models = buildModels({
    notifications: [{ _id: 'notification_1', createdAt: daysAgo(200), type: 'NEW_TASK' }],
    recipients: [
      { _id: 'recipient_1', notificationId: 'notification_1', userId: 'user_1' },
      { _id: 'recipient_2', notificationId: 'notification_1', userId: 'user_2' },
      { _id: 'recipient_3', notificationId: 'notification_1', userId: 'user_3' },
    ],
    retentionDays: 180,
  });
  const job = buildJob(models);

  const summary = await job.run({ now: NOW });

  assert.deepStrictEqual(summary, { checked: 1, deleted: 1, failed: 0 });
  assert.strictEqual(models.Notification._docs.length, 0);
  assert.strictEqual(models.NotificationRecipient._docs.length, 0);
});

// ===========================================================================
// 3. Repeated execution is safe
// ===========================================================================
test('G3D: running twice with nothing left to delete is a clean no-op', async () => {
  const models = buildModels({
    notifications: [{ _id: 'notification_1', createdAt: daysAgo(200), type: 'NEW_TASK' }],
    recipients: [{ _id: 'recipient_1', notificationId: 'notification_1', userId: 'user_1' }],
    retentionDays: 180,
  });
  const job = buildJob(models);

  const first = await job.run({ now: NOW });
  const second = await job.run({ now: NOW });

  assert.strictEqual(first.deleted, 1);
  assert.strictEqual(second.checked, 0);
  assert.strictEqual(second.deleted, 0);
  assert.strictEqual(second.failed, 0);
});

// ===========================================================================
// 4. Multiple expired notifications; only expired ones are removed
// ===========================================================================
test('G3D: multiple expired notifications are removed with their recipients; fresh ones are untouched', async () => {
  const models = buildModels({
    notifications: [
      { _id: 'notification_1', createdAt: daysAgo(300), type: 'A' },
      { _id: 'notification_2', createdAt: daysAgo(181), type: 'B' },
      { _id: 'notification_3', createdAt: daysAgo(5), type: 'C' },
      { _id: 'notification_4', createdAt: daysAgo(1), type: 'D' },
    ],
    recipients: [
      { _id: 'recipient_1', notificationId: 'notification_1', userId: 'user_1' },
      { _id: 'recipient_2', notificationId: 'notification_1', userId: 'user_2' },
      { _id: 'recipient_3', notificationId: 'notification_2', userId: 'user_1' },
      { _id: 'recipient_4', notificationId: 'notification_3', userId: 'user_1' },
      { _id: 'recipient_5', notificationId: 'notification_4', userId: 'user_2' },
    ],
    retentionDays: 180,
  });
  const job = buildJob(models);

  const summary = await job.run({ now: NOW });

  assert.deepStrictEqual(summary, { checked: 2, deleted: 2, failed: 0 });
  assert.deepStrictEqual(
    models.Notification._docs.map((n) => n._id).sort(),
    ['notification_3', 'notification_4']
  );
  assert.deepStrictEqual(
    models.NotificationRecipient._docs.map((r) => r._id).sort(),
    ['recipient_4', 'recipient_5']
  );
});

// ===========================================================================
// 5. Non-default retentionDays controls the cutoff (not a hard-coded value)
// ===========================================================================
test('G3D: the cutoff uses SystemSettings.notificationRetentionDays, not a hard-coded default', async () => {
  // With a 7-day setting, a 10-day-old notification is expired.
  // With the schema default of 180 it would survive, so this proves the
  // configured value is what the job actually uses.
  const models = buildModels({
    notifications: [
      { _id: 'notification_old', createdAt: daysAgo(10), type: 'OLD' },
      { _id: 'notification_new', createdAt: daysAgo(3), type: 'NEW' },
    ],
    recipients: [
      { _id: 'recipient_1', notificationId: 'notification_old', userId: 'user_1' },
      { _id: 'recipient_2', notificationId: 'notification_new', userId: 'user_1' },
    ],
    retentionDays: 7,
  });
  const job = buildJob(models);

  const summary = await job.run({ now: NOW });

  assert.deepStrictEqual(summary, { checked: 1, deleted: 1, failed: 0 });
  assert.deepStrictEqual(models.Notification._docs.map((n) => n._id), ['notification_new']);
  assert.deepStrictEqual(models.NotificationRecipient._docs.map((r) => r._id), ['recipient_2']);
});

// ===========================================================================
// 6. Transactional rollback prevents partial deletion
// ===========================================================================
test('G3D: if the notification delete fails after recipients are deleted, the recipients are restored', async () => {
  const models = buildModels({
    notifications: [{ _id: 'notification_1', createdAt: daysAgo(200), type: 'NEW_TASK' }],
    recipients: [
      { _id: 'recipient_1', notificationId: 'notification_1', userId: 'user_1' },
      { _id: 'recipient_2', notificationId: 'notification_1', userId: 'user_2' },
    ],
    retentionDays: 180,
  });

  // Force the notification delete to fail AFTER the recipient delete has
  // already succeeded inside the same transaction.
  const originalDeleteOne = models.Notification.deleteOne;
  models.Notification.deleteOne = async () => {
    throw new Error('simulated failure deleting notification');
  };

  const job = buildJob(models);
  const summary = await job.run({ now: NOW });

  // Restore the real method before asserting, so nothing leaks.
  models.Notification.deleteOne = originalDeleteOne;

  assert.deepStrictEqual(summary, { checked: 1, deleted: 0, failed: 1 });
  assert.strictEqual(models.Notification._docs.length, 1, 'notification must remain');
  assert.strictEqual(
    models.NotificationRecipient._docs.length,
    2,
    'recipients must be restored by the rollback, not left deleted'
  );
});

// ===========================================================================
// 7. Regression smoke: existing notification behavior is unaffected
// ===========================================================================
test('G3D regression: dispatch, listForUser and markRead still behave normally alongside retention', async () => {
  const models = buildModels({ retentionDays: 180 });
  const notificationService = createNotificationService({ models });

  // A notification created "now" is well inside the retention window.
  const createdNow = new Date();
  await notificationService.dispatch({
    type: 'NEW_TASK',
    category: 'TASK',
    title: 'New task',
    message: 'A new task was posted.',
    createdBy: null,
    relatedType: 'TASK',
    relatedId: 'task_1',
    recipientUserIds: ['user_1'],
  });

  const job = buildJob(models);
  const summary = await job.run({ now: createdNow });
  assert.strictEqual(summary.deleted, 0, 'a fresh notification must not be deleted');

  const listed = await notificationService.listForUser({ userId: 'user_1' });
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].notification.title, 'New task');

  const result = await notificationService.markRead({
    userId: 'user_1',
    recipientId: listed[0].recipientId,
  });
  assert.ok(result, 'markRead should succeed for the owning user');

  // markAllRead: a second fresh notification, then mark everything read.
  // The first was already marked read above, so only one should update.
  await notificationService.dispatch({
    type: 'NEW_TASK',
    category: 'TASK',
    title: 'Second task',
    message: 'Another task was posted.',
    createdBy: null,
    relatedType: 'TASK',
    relatedId: 'task_2',
    recipientUserIds: ['user_1'],
  });
  await job.run({ now: createdNow });

  const allReadResult = await notificationService.markAllRead({ userId: 'user_1' });
  assert.strictEqual(allReadResult.updated, 1, 'only the still-unread notification should update');

  const unreadAfter = await notificationService.listForUser({ userId: 'user_1', unreadOnly: true });
  assert.strictEqual(unreadAfter.length, 0, 'no unread notifications should remain');
  const totalAfter = await notificationService.listForUser({ userId: 'user_1' });
  assert.strictEqual(totalAfter.length, 2, 'retention pass must not have removed fresh notifications');
});

// ===========================================================================
// 8. Invalid / missing notificationRetentionDays fails fast (no fallback)
// ===========================================================================
test('G3D: invalid or missing notificationRetentionDays throws and deletes nothing', async () => {
  const invalidValues = [0, -1, -180, undefined, null, NaN, '180'];

  for (const invalid of invalidValues) {
    const models = buildModels({
      notifications: [{ _id: 'notification_1', createdAt: daysAgo(200), type: 'NEW_TASK' }],
      recipients: [{ _id: 'recipient_1', notificationId: 'notification_1', userId: 'user_1' }],
    });
    // Override the settings source to return the invalid value.
    models.SystemSettings = {
      getSingleton: async () => ({ notificationRetentionDays: invalid }),
    };
    const job = buildJob(models);

    await assert.rejects(
      () => job.run({ now: NOW }),
      /Invalid notificationRetentionDays/,
      `expected a throw for notificationRetentionDays=${String(invalid)}`
    );

    // Validation happens before any query or deletion, so nothing is removed.
    assert.strictEqual(models.Notification._docs.length, 1, `notification kept for ${String(invalid)}`);
    assert.strictEqual(models.NotificationRecipient._docs.length, 1, `recipient kept for ${String(invalid)}`);
  }
});
