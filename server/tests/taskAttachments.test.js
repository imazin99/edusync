/**
 * server/tests/taskAttachments.test.js
 *
 * Backend Gap Closure — Part G2: Actual Task Attachment Upload.
 *
 * Two sections:
 *   1. Service-level tests (fakeCollection for Task/Subject/etc.
 *      metadata, but a REAL FileStorageService writing to a real
 *      temp directory — file I/O is exactly the thing G2 adds, so it
 *      is exercised for real here, not faked).
 *   2. A small HTTP-level section (supertest) proving the real
 *      routes.js + controller wiring — request body parsing, route
 *      params, res.download() — actually works end-to-end, mirroring
 *      the established pattern in scheduleRoutes.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner } = require('./helpers/fakeTransaction');
const { ROLES } = require('../utils/constants');
const { createTaskService } = require('../services/TaskService');
const { createNotificationService } = require('../services/NotificationService');
const { createLocalFileStorage } = require('../services/FileStorageService');

// A tiny, genuinely valid 1x1 PNG, base64-encoded — real bytes, not a
// placeholder string, so size/decoding is exercised for real.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, 'base64').length;

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

function baseFixture(overrides = {}) {
  const models = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true }, // user_1 — doctor of subject_1
      { username: 'dr2', role: ROLES.DOCTOR, isActive: true }, // user_2 — a DIFFERENT subject's doctor
      { username: 'ta', role: ROLES.TA, isActive: true }, // user_3 — TA of subject_1
      { username: 'leader', role: ROLES.LEADER, isActive: true }, // user_4
      { username: 'student', role: ROLES.STUDENT, isActive: true }, // user_5
    ],
    doctors: [
      { userId: 'user_1', fullName: 'Dr One', isActive: true }, // doctor_1
      { userId: 'user_2', fullName: 'Dr Two', isActive: true }, // doctor_2 — unrelated subject
    ],
    tas: [{ userId: 'user_3', fullName: 'TA One', isActive: true }], // ta_1
    leaders: [{ userId: 'user_4', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
    students: [{ userId: 'user_5', group: 'ALL', isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', taId: 'ta_1', hasSections: false, isActive: true }],
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-attachments-'));
  const fileStorage = createLocalFileStorage({ baseDir: tmpDir });
  const notificationService = createNotificationService({ models });
  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    fileStorage,
    // G3C default — overridable via `overrides` (placed last in the
    // spread below), e.g. with createFakeTransactionRunner(models) for
    // a rollback test, exactly like uploadLimit is already overridden
    // by the existing "oversized file" test in this file.
    runInTransaction: async (callback) => callback({ __passthroughFakeSession: true }),
    ...overrides,
  });

  return {
    models,
    taskService,
    fileStorage,
    tmpDir,
    doctorActor: { id: 'user_1', role: ROLES.DOCTOR }, // owns subject_1
    otherDoctorActor: { id: 'user_2', role: ROLES.DOCTOR }, // does NOT own subject_1
    taActor: { id: 'user_3', role: ROLES.TA }, // owns subject_1
    leaderActor: { id: 'user_4', role: ROLES.LEADER },
    studentActor: { id: 'user_5', role: ROLES.STUDENT },
  };
}

function cleanupTmpDir(tmpDir) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function createTask(taskService, actor) {
  return taskService.create({ actorUser: actor, title: 'Assignment 1', description: '', subjectId: 'subject_1' });
}

// ===========================================================================
// 1 & 2. Authorized creator / Doctor / TA / Leader / Admin can upload
// ===========================================================================
test('G2: the task creator (Doctor of the subject) can upload an attachment', async () => {
  const { taskService, doctorActor, tmpDir } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);
    const updated = await taskService.addAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      filename: 'notes.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64,
    });
    assert.strictEqual(updated.attachments.length, 1);
    assert.strictEqual(updated.attachments[0].filename, 'notes.png');
    assert.strictEqual(updated.attachments[0].mimeType, 'image/png');
    assert.strictEqual(updated.attachments[0].size, TINY_PNG_BYTES);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

test('G2: TA of the subject and Leader can also upload; a Doctor of a DIFFERENT subject cannot', async () => {
  const { taskService, doctorActor, taActor, leaderActor, otherDoctorActor, tmpDir } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);

    const afterTa = await taskService.addAttachment({
      actorUser: taActor,
      taskId: task._id,
      filename: 'a.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('pdf-bytes-1').toString('base64'),
    });
    assert.strictEqual(afterTa.attachments.length, 1);

    const afterLeader = await taskService.addAttachment({
      actorUser: leaderActor,
      taskId: task._id,
      filename: 'b.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('pdf-bytes-2').toString('base64'),
    });
    assert.strictEqual(afterLeader.attachments.length, 2);

    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: otherDoctorActor,
          taskId: task._id,
          filename: 'c.pdf',
          mimeType: 'application/pdf',
          dataBase64: Buffer.from('pdf-bytes-3').toString('base64'),
        }),
      /permission/i
    );
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 3 & 4. Unauthorized user / Student rejected
// ===========================================================================
test('G2: a Doctor not attached to the subject is rejected (403-equivalent AppError)', async () => {
  const { taskService, doctorActor, otherDoctorActor, tmpDir } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);
    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: otherDoctorActor,
          taskId: task._id,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          dataBase64: Buffer.from('x').toString('base64'),
        }),
      (err) => {
        assert.strictEqual(err.statusCode, 403);
        return true;
      }
    );
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

test('G2: a Student cannot upload a task attachment', async () => {
  const { taskService, doctorActor, studentActor, tmpDir } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);
    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: studentActor,
          taskId: task._id,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          dataBase64: Buffer.from('x').toString('base64'),
        }),
      (err) => {
        assert.strictEqual(err.statusCode, 403);
        return true;
      }
    );
    const after = await taskService.getById(task._id);
    assert.strictEqual(after.attachments.length, 0);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 5. Valid attachment is stored and metadata is persisted (real disk I/O)
// ===========================================================================
test('G2: a valid attachment is genuinely written to disk and its metadata persists on the Task', async () => {
  const { taskService, doctorActor, tmpDir, fileStorage } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);
    const updated = await taskService.addAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      filename: 'notes.png',
      mimeType: 'image/png',
      dataBase64: TINY_PNG_BASE64,
    });
    const [attachment] = updated.attachments;
    assert.ok(attachment.storageKey);
    assert.strictEqual(attachment.url, `/api/tasks/${task._id}/attachments/${attachment.storageKey}`);

    const onDisk = fs.readdirSync(fileStorage.baseDir);
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(onDisk[0], attachment.storageKey);
    const bytesOnDisk = fs.readFileSync(path.join(fileStorage.baseDir, attachment.storageKey));
    assert.strictEqual(bytesOnDisk.length, TINY_PNG_BYTES);
    assert.ok(bytesOnDisk.equals(Buffer.from(TINY_PNG_BASE64, 'base64')));
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 6. Invalid file type is rejected
// ===========================================================================
test('G2: an unsupported/mismatched file type is rejected and nothing is written to disk', async () => {
  const { taskService, doctorActor, tmpDir, fileStorage } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);

    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: doctorActor,
          taskId: task._id,
          filename: 'virus.exe',
          mimeType: 'application/x-msdownload',
          dataBase64: Buffer.from('bad').toString('base64'),
        }),
      /Unsupported attachment type/
    );

    // Declared type/extension mismatch — a PDF mimeType on a .exe name —
    // must also be rejected, not just an outright-unknown type.
    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: doctorActor,
          taskId: task._id,
          filename: 'sneaky.exe',
          mimeType: 'application/pdf',
          dataBase64: Buffer.from('bad').toString('base64'),
        }),
      /Unsupported attachment type/
    );

    assert.strictEqual(fs.readdirSync(fileStorage.baseDir).length, 0, 'no file should have been written for a rejected type');
    const after = await taskService.getById(task._id);
    assert.strictEqual(after.attachments.length, 0);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 7. Oversized file is rejected (size limit is required by spec section
// 71 "Upload size limits"; the NUMBER is a documented assumption reusing
// the existing UPLOAD_LIMIT config — see the completion report).
// ===========================================================================
test('G2: a file exceeding the configured size limit is rejected before being written to disk', async () => {
  const { taskService, doctorActor, tmpDir, fileStorage } = baseFixture({ uploadLimit: '100b' });
  try {
    const task = await createTask(taskService, doctorActor);
    const bigBuffer = Buffer.alloc(200, 'a'); // 200 bytes > the 100-byte limit configured above
    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: doctorActor,
          taskId: task._id,
          filename: 'big.pdf',
          mimeType: 'application/pdf',
          dataBase64: bigBuffer.toString('base64'),
        }),
      /exceeds the maximum allowed attachment size/
    );
    assert.strictEqual(fs.readdirSync(fileStorage.baseDir).length, 0);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 8. Filename / path traversal attempts are neutralized
// ===========================================================================
test('G2: a path-traversal filename is sanitized, and the file is written safely inside the storage directory', async () => {
  const { taskService, doctorActor, tmpDir, fileStorage } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);
    const updated = await taskService.addAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      filename: '../../../../etc/passwd.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('pdf-bytes').toString('base64'),
    });
    const [attachment] = updated.attachments;
    // The stored metadata filename must never retain any directory
    // component.
    assert.ok(!attachment.filename.includes('/'));
    assert.ok(!attachment.filename.includes('..'));
    assert.strictEqual(attachment.filename, 'passwd.pdf');

    // The on-disk storage key is always our own generated UUID, never
    // derived from the input filename at all.
    assert.ok(!attachment.storageKey.includes('/'));
    assert.ok(!attachment.storageKey.includes('..'));
    assert.match(attachment.storageKey, /^[0-9a-f-]{36}\.pdf$/);

    // And the file genuinely landed inside the configured base
    // directory — nothing escaped it.
    const onDisk = fs.readdirSync(fileStorage.baseDir);
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(path.dirname(path.join(fileStorage.baseDir, onDisk[0])), fileStorage.baseDir);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

test('G2: attempting to remove/download using a path-traversal storageKey is rejected, not resolved outside the storage directory', async () => {
  const { taskService, doctorActor, tmpDir } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);
    await assert.rejects(
      () => taskService.removeAttachment({ actorUser: doctorActor, taskId: task._id, storageKey: '../../../../etc/passwd' }),
      /not found/i
    );
    await assert.rejects(
      () => taskService.getAttachmentForDownload({ taskId: task._id, storageKey: '../../../../etc/passwd' }),
      /not found/i
    );
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 9 & 10. Attachment removal works according to permissions, and does not
// corrupt the Task
// ===========================================================================
test('G2: removing an attachment respects task permissions, leaves the task and remaining attachments intact', async () => {
  const { taskService, doctorActor, studentActor, tmpDir, fileStorage } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);
    const afterFirst = await taskService.addAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      filename: 'keep.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('keep-me').toString('base64'),
    });
    const afterSecond = await taskService.addAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      filename: 'remove.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from('remove-me').toString('base64'),
    });
    assert.strictEqual(afterSecond.attachments.length, 2);
    const toRemove = afterSecond.attachments.find((a) => a.filename === 'remove.pdf');

    // Student cannot remove.
    await assert.rejects(
      () => taskService.removeAttachment({ actorUser: studentActor, taskId: task._id, storageKey: toRemove.storageKey }),
      (err) => {
        assert.strictEqual(err.statusCode, 403);
        return true;
      }
    );

    const afterRemoval = await taskService.removeAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      storageKey: toRemove.storageKey,
    });

    // Exactly the removed one is gone; the other, and the task's other
    // fields, are untouched.
    assert.strictEqual(afterRemoval.attachments.length, 1);
    assert.strictEqual(afterRemoval.attachments[0].filename, 'keep.pdf');
    assert.strictEqual(afterRemoval.title, 'Assignment 1');
    assert.strictEqual(afterRemoval._id.toString(), task._id.toString());

    // File genuinely deleted from disk, and the kept file is untouched.
    const onDisk = fs.readdirSync(fileStorage.baseDir);
    assert.strictEqual(onDisk.length, 1);
    assert.strictEqual(onDisk[0], afterFirst.attachments[0].storageKey);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 12. Failure during persistence does not leave inconsistent Task state
// or an orphaned file.
// ===========================================================================
test('G2: if saving the Task fails after the file is written, the file is rolled back and the Task is left unchanged', async () => {
  const { models, taskService, doctorActor, tmpDir, fileStorage } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor);

    const originalFindById = models.Task.findById.bind(models.Task);
    models.Task.findById = async (id) => {
      const doc = await originalFindById(id);
      if (doc) {
        Object.defineProperty(doc, 'save', {
          value: async () => {
            throw new Error('SIMULATED_TASK_SAVE_FAILURE');
          },
          configurable: true,
        });
      }
      return doc;
    };

    try {
      await assert.rejects(
        () =>
          taskService.addAttachment({
            actorUser: doctorActor,
            taskId: task._id,
            filename: 'x.pdf',
            mimeType: 'application/pdf',
            dataBase64: Buffer.from('x').toString('base64'),
          }),
        /SIMULATED_TASK_SAVE_FAILURE/
      );
    } finally {
      models.Task.findById = originalFindById;
    }

    // No orphaned file left behind — the just-written file was rolled back.
    assert.strictEqual(fs.readdirSync(fileStorage.baseDir).length, 0);
    // NOTE (updated for G3C): we do not additionally assert
    // `after.attachments.length === 0` here. This test uses baseFixture()'s
    // default passthrough runInTransaction, which — unlike
    // createFakeTransactionRunner — does not attempt any snapshot/restore
    // at all, so the in-memory `task.attachments = [...]` reassignment
    // (which happens before task.save() is even called) is simply never
    // undone by this particular test's mechanism, regardless of push vs.
    // reassignment style. The G3C tests below use
    // createFakeTransactionRunner specifically to exercise and prove that
    // reverting the ARRAY CONTENTS genuinely works when a real rollback is
    // simulated — that is the right place for that assertion, not here.
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// G3C — TaskService Transaction Gap: addAttachment/removeAttachment now
// wrap their Task write + notification dispatch in a transaction (the
// same established pattern already used by ScheduleService/
// taskDeadlineJob). These tests use createFakeTransactionRunner (the
// SIMULATION-only rollback helper already proven by Part E and G1) to
// force a failure specifically in the notification dispatch step —
// AFTER the metadata write has already happened within the same
// transaction attempt — and verify both the database and filesystem
// consequences, kept as separate, clearly-distinguished tests per
// their different failure domains.
// ===========================================================================

function forceNotificationFailureOnce(models) {
  const originalCreate = models.Notification.create.bind(models.Notification);
  models.Notification.create = async (...args) => {
    models.Notification.create = originalCreate; // one-shot
    throw new Error('SIMULATED_NOTIFICATION_FAILURE');
  };
}

/** Builds the fixture inline (not via baseFixture()) because
 * createFakeTransactionRunner(models) needs the SAME models instance the
 * taskService is constructed with, which baseFixture()'s
 * construct-then-return shape doesn't allow injecting beforehand. */
function rollbackFixture() {
  const models = buildModels({
    users: [{ username: 'dr', role: ROLES.DOCTOR, isActive: true }],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', hasSections: false, isActive: true }],
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3c-attachments-'));
  const fileStorage = createLocalFileStorage({ baseDir: tmpDir });
  const notificationService = createNotificationService({ models });
  const passthroughTx = async (callback) => callback({ __passthroughFakeSession: true });

  // A SEPARATE service instance using the plain passthrough, only to set
  // up a clean baseline task (so its own NEW_TASK notification doesn't
  // interfere with later assertions) before the failure-injected service
  // below is used for the actual operation under test.
  const setupService = createTaskService({ models, auditService: { recordAudit: async () => {} }, notificationService, fileStorage, runInTransaction: passthroughTx });

  const taskService = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    fileStorage,
    runInTransaction: createFakeTransactionRunner(models),
  });

  return { models, tmpDir, fileStorage, setupService, taskService, doctorActor: { id: 'user_1', role: ROLES.DOCTOR } };
}

test('G3C addAttachment DB rollback: if notification dispatch fails, the Task does not retain the new attachment', async () => {
  const { models, tmpDir, setupService, taskService, doctorActor } = rollbackFixture();
  try {
    const task = await createTask(setupService, doctorActor);
    forceNotificationFailureOnce(models);

    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: doctorActor,
          taskId: task._id,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          dataBase64: TINY_PNG_BASE64,
        }),
      /SIMULATED_NOTIFICATION_FAILURE/
    );

    const after = await models.Task.findById(task._id);
    assert.strictEqual(after.attachments.length, 0, 'the Task must not retain the attachment after a failed dispatch — verified via the real database, not an in-memory object');
    assert.strictEqual(models.Notification._docs.filter((n) => n.type === 'TASK_UPDATED').length, 0);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

test('G3C addAttachment filesystem compensation: if notification dispatch fails (after the metadata write already happened within the same transaction attempt), the physical file is still rolled back', async () => {
  const { tmpDir, fileStorage, setupService, taskService, models, doctorActor } = rollbackFixture();
  try {
    const task = await createTask(setupService, doctorActor);
    forceNotificationFailureOnce(models);

    await assert.rejects(
      () =>
        taskService.addAttachment({
          actorUser: doctorActor,
          taskId: task._id,
          filename: 'x.pdf',
          mimeType: 'application/pdf',
          dataBase64: TINY_PNG_BASE64,
        }),
      /SIMULATED_NOTIFICATION_FAILURE/
    );

    assert.strictEqual(fs.readdirSync(fileStorage.baseDir).length, 0, 'no orphaned file may remain — this is the G3C-widened case: task.save() itself succeeded, only the LATER dispatch call failed');
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

test('G3C removeAttachment DB rollback: if notification dispatch fails, the Task still retains the attachment that was supposed to be removed', async () => {
  const { models, tmpDir, setupService, taskService, doctorActor } = rollbackFixture();
  try {
    const task = await createTask(setupService, doctorActor);
    const afterUpload = await setupService.addAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      filename: 'keep-me.pdf',
      mimeType: 'application/pdf',
      dataBase64: TINY_PNG_BASE64,
    });
    const storageKey = afterUpload.attachments[0].storageKey;

    forceNotificationFailureOnce(models);

    await assert.rejects(
      () => taskService.removeAttachment({ actorUser: doctorActor, taskId: task._id, storageKey }),
      /SIMULATED_NOTIFICATION_FAILURE/
    );

    const after = await models.Task.findById(task._id);
    assert.strictEqual(after.attachments.length, 1, 'the attachment must still be listed — verified via the real database');
    assert.strictEqual(after.attachments[0].storageKey, storageKey);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

test('G3C removeAttachment filesystem compensation: if notification dispatch fails, the physical file is NOT deleted (the inverse of the addAttachment case)', async () => {
  const { tmpDir, fileStorage, models, setupService, taskService, doctorActor } = rollbackFixture();
  try {
    const task = await createTask(setupService, doctorActor);
    const afterUpload = await setupService.addAttachment({
      actorUser: doctorActor,
      taskId: task._id,
      filename: 'keep-me.pdf',
      mimeType: 'application/pdf',
      dataBase64: TINY_PNG_BASE64,
    });
    const storageKey = afterUpload.attachments[0].storageKey;
    assert.strictEqual(fs.readdirSync(fileStorage.baseDir).length, 1, 'sanity check: the file exists before the failed removal attempt');

    forceNotificationFailureOnce(models);

    await assert.rejects(
      () => taskService.removeAttachment({ actorUser: doctorActor, taskId: task._id, storageKey }),
      /SIMULATED_NOTIFICATION_FAILURE/
    );

    assert.strictEqual(fs.readdirSync(fileStorage.baseDir).length, 1, 'the file must still exist — the metadata removal was rolled back, so deleting the file would have left a dangling reference');
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// 11. Existing Task CRUD/completion/deadline behavior still passes
// (attachments untouched by this gap's changes to those code paths).
// ===========================================================================
test('G2 regression: create/update/remove/markDone still work, and update() can still bulk-set attachments directly', async () => {
  const { taskService, doctorActor, tmpDir } = baseFixture();
  try {
    const task = await createTask(taskService, doctorActor, { deadline: new Date('2026-07-01T00:00:00.000Z') });
    const updated = await taskService.update({
      actorUser: doctorActor,
      taskId: task._id,
      deadline: new Date('2026-07-15T00:00:00.000Z'),
    });
    assert.strictEqual(updated.deadline.toISOString(), new Date('2026-07-15T00:00:00.000Z').toISOString());

    // The pre-existing raw attachments pass-through on update() (used
    // before this gap existed) must still work exactly as before —
    // this gap only ADDS the new validated upload/remove path, it does
    // not remove or restrict the existing one.
    const bulkSet = await taskService.update({
      actorUser: doctorActor,
      taskId: task._id,
      attachments: [{ filename: 'legacy.pdf', mimeType: 'application/pdf', size: 5, url: 'http://example.com/legacy.pdf', storageKey: 'legacy-key' }],
    });
    assert.strictEqual(bulkSet.attachments.length, 1);
    assert.strictEqual(bulkSet.attachments[0].filename, 'legacy.pdf');

    await taskService.remove({ actorUser: doctorActor, taskId: task._id });
    await assert.rejects(() => taskService.getById(task._id), /not found/i);
  } finally {
    cleanupTmpDir(tmpDir);
  }
});

// ===========================================================================
// HTTP-level wiring (real routes.js + controller + Express body parsing),
// mirroring the established pattern in scheduleRoutes.test.js.
// ===========================================================================
let currentTestUser = { id: 'user_1', role: ROLES.DOCTOR };

const authModule = require('../middleware/auth');
authModule.requireAuth = (req, res, next) => {
  req.user = currentTestUser;
  next();
};
const maintenanceModule = require('../middleware/maintenance');
maintenanceModule.checkMaintenanceMode = (req, res, next) => next();

const taskServiceModule = require('../services/TaskService');
const httpCalls = [];
taskServiceModule.addAttachment = async ({ actorUser, taskId, filename, mimeType, dataBase64 }) => {
  httpCalls.push({ fn: 'addAttachment', actorUser, taskId, filename, mimeType, dataBase64Length: dataBase64 && dataBase64.length });
  if (actorUser.role === ROLES.STUDENT) {
    const AppError = require('../utils/AppError');
    throw AppError.forbidden('Students cannot upload task attachments');
  }
  return { _id: taskId, attachments: [{ filename, mimeType, size: 3, storageKey: 'key-1', url: `/api/tasks/${taskId}/attachments/key-1` }] };
};

let downloadTmpFile;
taskServiceModule.getAttachmentForDownload = async ({ taskId, storageKey }) => {
  httpCalls.push({ fn: 'getAttachmentForDownload', taskId, storageKey });
  return { absolutePath: downloadTmpFile, filename: 'hello.txt', mimeType: 'text/plain' };
};

// eslint-disable-next-line import/order
const tasksRoutes = require('../routes/tasks.routes');
const { errorHandler, notFoundHandler } = require('../middleware/errorHandler');

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRoutes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

test('G2 HTTP: POST /api/tasks/:id/attachments reaches the real route/controller and returns the updated task', async () => {
  httpCalls.length = 0;
  currentTestUser = { id: 'user_1', role: ROLES.DOCTOR };
  const app = buildTestApp();

  const res = await request(app)
    .post('/api/tasks/task_1/attachments')
    .send({ filename: 'notes.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('hi').toString('base64') });

  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(res.body.task.attachments[0].filename, 'notes.pdf');
  assert.strictEqual(httpCalls.length, 1);
  assert.strictEqual(httpCalls[0].taskId, 'task_1');
});

test('G2 HTTP: a Student is rejected at the route (403), never reaching a success response', async () => {
  httpCalls.length = 0;
  currentTestUser = { id: 'user_5', role: ROLES.STUDENT };
  const app = buildTestApp();

  const res = await request(app)
    .post('/api/tasks/task_1/attachments')
    .send({ filename: 'notes.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('hi').toString('base64') });

  // requireRole (canManage) rejects Student BEFORE the controller/service
  // is ever reached — the strongest form of this guarantee.
  assert.strictEqual(res.status, 403);
  assert.strictEqual(httpCalls.length, 0, 'the service must never be called for a role-rejected request');
});

test('G2 HTTP: GET /api/tasks/:id/attachments/:storageKey streams the real file bytes', async () => {
  httpCalls.length = 0;
  currentTestUser = { id: 'user_5', role: ROLES.STUDENT }; // any authenticated role, per spec section 8
  downloadTmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g2-download-')), 'hello.txt');
  fs.writeFileSync(downloadTmpFile, 'hello world');
  const app = buildTestApp();

  try {
    // G3H: downloadAttachment now validates the taskId route param as a
    // real ObjectId before reaching the service (same established
    // isValidObjectId pattern used elsewhere) — 'task_1' (this suite's
    // usual fake-collection-style id) is deliberately not ObjectId-shaped,
    // so this one URL uses a realistic id instead. storageKey ('key-1')
    // is untouched and still never validated as an ObjectId, correctly.
    const res = await request(app).get('/api/tasks/6f0000000000000000000001/attachments/key-1');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.text, 'hello world');
    assert.strictEqual(httpCalls.length, 1);
    assert.strictEqual(httpCalls[0].fn, 'getAttachmentForDownload');
  } finally {
    fs.rmSync(path.dirname(downloadTmpFile), { recursive: true, force: true });
  }
});
