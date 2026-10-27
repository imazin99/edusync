/**
 * server/tests/notificationRecipientSessionCreate.test.js
 *
 * Regression test for a confirmed production bug: creating a Task (or any
 * other action that dispatches a notification to more than one recipient
 * from inside a transaction — a Schedule change, a Request approval)
 * failed with the generic "An unexpected error occurred" 500. The real
 * server log showed the actual exception:
 *
 *   MongooseError: Cannot call `create()` with a session and multiple
 *   documents unless `ordered: true` is set
 *     at ...NotificationService.js:204:35 (NotificationRecipient.create)
 *
 * Root cause: server/services/NotificationService.js's dispatch() builds
 * one NotificationRecipient document per recipient and creates them all
 * in a single array-form `.create(docsArray, { session })` call — but
 * installed mongoose@8.24.4 refuses an array-form `Model.create()` of
 * more than one document when a `session` option is passed, UNLESS
 * `ordered: true` is also set (confirmed directly against
 * node_modules/mongoose/lib/model.js: `if (options.session &&
 * !options.ordered && args.length > 1) throw ...`). A single
 * ClientSession can only have one operation in flight at a time, so an
 * unordered (parallel) multi-document create sharing that session would
 * race against itself — `ordered: true` is the correct fix, not just
 * error-suppression.
 *
 * This validation happens synchronously inside Model.create(), BEFORE
 * any database I/O, so it can be exercised directly against the REAL
 * NotificationRecipient Mongoose model with no live MongoDB connection —
 * same "real model, no live DB" convention already established in
 * models.test.js (validateSync()/schema.indexes()), extended here to
 * Model.create()'s own argument validation instead of schema validation.
 *
 * Why the existing suite never caught this: every other NotificationService
 * test (notifications.test.js, taskService.test.js, scheduleRoutes.test.js)
 * injects `fakeCollection.js`'s hand-rolled fake models, whose `create()`
 * takes a single `data` argument and never even looks at a second
 * `options` argument (confirmed by reading it) — so no test using fake
 * models could ever reproduce a real Mongoose option-validation error.
 * This file is therefore deliberately the one place in the suite that
 * imports the REAL `server/models` Mongoose models instead.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

// No live MongoDB connection exists in this suite (same as every other
// test file here). Mongoose's default behavior without one is to BUFFER
// any command for up to `bufferTimeoutMS` (10s) before rejecting, which
// would make the "ordered: true avoids the error" test below slow and
// look like it's hanging rather than failing fast with a clear "not
// connected" error. `node --test` runs each matched file in its own
// process (confirmed: this repo's `npm test` is `node --test
// server/tests/*.test.js`), so this process-wide setting cannot leak
// into any other test file.
mongoose.set('bufferCommands', false);

const { NotificationRecipient } = require('../models');
const { createNotificationService } = require('../services/NotificationService');

function twoRecipientDocs() {
  return [
    { notificationId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId() },
    { notificationId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId() },
  ];
}

test('Mongoose refuses an unordered multi-document create() with a session (documents the exact constraint that broke task creation)', async () => {
  await assert.rejects(
    () => NotificationRecipient.create(twoRecipientDocs(), { session: {} }),
    (err) => {
      assert.match(err.message, /Cannot call `create\(\)` with a session and multiple documents unless `ordered: true` is set/);
      return true;
    }
  );
});

test('ordered: true avoids that specific Mongoose error for a multi-document, session-bound create()', async () => {
  // No live MongoDB connection is available in this suite, so the call
  // still fails — but on a connection error, never on the
  // session/ordered argument-validation error above. That distinction is
  // exactly what proves the fix: Mongoose's own synchronous argument
  // check (which runs before any DB I/O) is now satisfied.
  await assert.rejects(
    () => NotificationRecipient.create(twoRecipientDocs(), { session: {}, ordered: true }),
    (err) => {
      assert.doesNotMatch(err.message, /Cannot call `create\(\)` with a session and multiple documents unless `ordered: true` is set/);
      return true;
    }
  );
});

test("NotificationService.dispatch() passes ordered: true alongside session (the actual fix in server/services/NotificationService.js)", async () => {
  // Reads dispatch()'s actual createOptions construction by calling it
  // with a real dbSession-shaped value and intercepting the real
  // NotificationRecipient.create — fake models (used by every other
  // NotificationService test) don't carry this option through, so this
  // has to go through the real model binding createNotificationService()
  // resolves by default when no `models` override is given.
  const originalCreate = NotificationRecipient.create;
  let capturedOptions = null;
  NotificationRecipient.create = async (docs, options) => {
    capturedOptions = options;
    return docs.map((d, i) => ({ ...d, _id: new mongoose.Types.ObjectId(), toString: () => `rec_${i}` }));
  };
  const originalNotificationCreate = require('../models').Notification.create;
  require('../models').Notification.create = async () => [{ _id: new mongoose.Types.ObjectId(), title: 't' }];

  try {
    const notificationService = createNotificationService();
    await notificationService.dispatch({
      type: 'NEW_TASK',
      category: 'TASK',
      title: 'New task',
      message: 'msg',
      createdBy: 'u1',
      relatedType: 'TASK',
      relatedId: new mongoose.Types.ObjectId(),
      recipientUserIds: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()],
      actorUserId: 'u1',
      actorRole: 'ADMIN',
      dbSession: { fake: 'session' },
    });

    assert.ok(capturedOptions, 'NotificationRecipient.create should have been called');
    assert.deepStrictEqual(capturedOptions.session, { fake: 'session' });
    assert.strictEqual(capturedOptions.ordered, true, 'ordered: true must be passed whenever session is set');
  } finally {
    NotificationRecipient.create = originalCreate;
    require('../models').Notification.create = originalNotificationCreate;
  }
});
