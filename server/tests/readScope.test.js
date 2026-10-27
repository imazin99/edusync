/**
 * server/tests/readScope.test.js
 *
 * Regression tests for ReadScopeService — approved read-visibility rules
 * for task list/detail/attachment and schedule change history.
 *
 * Self-contained: model and service dependencies are stubbed through the
 * factory's injection points. No MongoDB, no shared fake helpers modified.
 */

const test = require('node:test');
const assert = require('node:assert');

const AppError = require('../utils/AppError');
const { createReadScopeService } = require('../services/ReadScopeService');

// ---------------------------------------------------------------------------
// Minimal query matcher for the stub models. Supports equality, null
// (matches null/undefined), and { $in: [...] }. Compares by string.
// ---------------------------------------------------------------------------
function matches(doc, filter = {}) {
  return Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && '$in' in cond) {
      return cond.$in.map(String).includes(String(value));
    }
    if (cond === null) return value === null || value === undefined;
    return String(value) === String(cond);
  });
}

// find() returns an awaitable array that also supports .sort(), like Mongoose.
function queryOf(rows) {
  const p = Promise.resolve(rows);
  p.sort = () => Promise.resolve(rows);
  return p;
}

// ---------------------------------------------------------------------------
// Fixture
//   Doctor d1 owns subject s1; Doctor d2 owns subject s2.
//   TA t1 is assigned to s1; TA t2 to s2.
//   Task A (s1) was CREATED by user u_d2, to prove ownership is by subject,
//   not createdBy. Task B (s2) was CREATED by user u_d1, same proof in the
//   other direction. Task C (s1) is soft-deleted.
// ---------------------------------------------------------------------------
function buildFixture() {
  const doctors = [
    { _id: 'd1', userId: 'u_d1' },
    { _id: 'd2', userId: 'u_d2' },
  ];
  const tas = [
    { _id: 't1', userId: 'u_t1' },
    { _id: 't2', userId: 'u_t2' },
  ];
  const subjects = [
    { _id: 's1', doctorId: 'd1', taId: 't1' },
    { _id: 's2', doctorId: 'd2', taId: 't2' },
    { _id: 's3', doctorId: 'd1', taId: null },
  ];
  const tasks = [
    {
      _id: '6a0000000000000000000001',
      subjectId: 's1',
      createdBy: 'u_d2',
      status: 'OPEN',
      deletedAt: null,
      attachments: [{ storageKey: 'key_a', filename: 'a.pdf', mimeType: 'application/pdf' }],
    },
    {
      _id: '6a0000000000000000000002',
      subjectId: 's2',
      createdBy: 'u_d1',
      status: 'OPEN',
      deletedAt: null,
      attachments: [{ storageKey: 'key_b', filename: 'b.pdf', mimeType: 'application/pdf' }],
    },
    {
      _id: '6a0000000000000000000003',
      subjectId: 's1',
      createdBy: 'u_d1',
      status: 'OPEN',
      deletedAt: new Date('2026-01-01T00:00:00Z'),
      attachments: [],
    },
  ];
  const sessions = [
    { _id: '6b0000000000000000000001', subjectId: 's1' },
    { _id: '6b0000000000000000000002', subjectId: 's2' },
  ];

  const models = {
    Doctor: { findOne: async (f) => doctors.find((d) => matches(d, f)) || null },
    TA: { findOne: async (f) => tas.find((t) => matches(t, f)) || null },
    Subject: { find: async (f) => subjects.filter((s) => matches(s, f)) },
    Task: { find: (f) => queryOf(tasks.filter((t) => matches(t, f))) },
    ScheduleSession: { findById: async (id) => sessions.find((s) => s._id === id) || null },
  };

  const taskService = {
    async getById(taskId) {
      const task = tasks.find((t) => t._id === taskId);
      if (!task || task.deletedAt) throw AppError.notFound('Task not found');
      return task;
    },
    async getAttachmentForDownload({ taskId, storageKey }) {
      const task = await taskService.getById(taskId);
      const attachment = (task.attachments || []).find((a) => a.storageKey === storageKey);
      if (!attachment) throw AppError.notFound('Attachment not found');
      return { absolutePath: `/store/${storageKey}`, filename: attachment.filename };
    },
    // Mirrors TaskService.list for the unrestricted (student/leader/admin) path.
    list({ subjectId, status, createdBy } = {}) {
      const filter = { deletedAt: null };
      if (subjectId) filter.subjectId = subjectId;
      if (status) filter.status = status;
      if (createdBy) filter.createdBy = createdBy;
      return queryOf(tasks.filter((t) => matches(t, filter)));
    },
  };

  const historyCalls = [];
  const HISTORY_DATES = {
    s1: '2026-10-01T00:00:00Z',
    s2: '2026-10-03T00:00:00Z',
    s3: '2026-10-05T00:00:00Z',
  };
  const scheduleService = {
    async getChangeHistory(args) {
      historyCalls.push(args);
      if (!args.sessionId && !args.subjectId) {
        throw AppError.badRequest('sessionId or subjectId is required');
      }
      return [
        {
          _id: `h_${args.subjectId || args.sessionId}`,
          createdAt: new Date(HISTORY_DATES[args.subjectId] || '2026-10-02T00:00:00Z'),
        },
      ];
    },
  };

  const readScope = createReadScopeService({ models, taskService, scheduleService });
  return { readScope, historyCalls };
}

const student = { id: 'u_st', role: 'STUDENT' };
const leader = { id: 'u_ld', role: 'LEADER' };
const admin = { id: 'u_ad', role: 'ADMIN' };
const doctor1 = { id: 'u_d1', role: 'DOCTOR' };
const doctor2 = { id: 'u_d2', role: 'DOCTOR' };
const ta1 = { id: 'u_t1', role: 'TA' };
const doctorWithoutProfile = { id: 'u_ghost', role: 'DOCTOR' };

const ids = (rows) => rows.map((r) => r._id).sort();

async function assertNotFound(promise, label) {
  await assert.rejects(promise, (err) => {
    assert.strictEqual(err.statusCode, 404, `${label}: expected 404`);
    assert.strictEqual(err.message, 'Task not found', `${label}: must not reveal existence`);
    return true;
  });
}

// ===========================================================================
// TASK READ SCOPE — STUDENT
// ===========================================================================
test('student can list all non-deleted tasks across subjects', async () => {
  const { readScope } = buildFixture();
  const rows = await readScope.listTasksForActor({ actorUser: student });
  assert.deepStrictEqual(ids(rows), ['6a0000000000000000000001', '6a0000000000000000000002']);
});

test('student can view a task from any subject', async () => {
  const { readScope } = buildFixture();
  const task = await readScope.assertTaskReadable({ actorUser: student, taskId: '6a0000000000000000000002' });
  assert.strictEqual(task._id, '6a0000000000000000000002');
});

test('student can download an attachment from any subject', async () => {
  const { readScope } = buildFixture();
  await readScope.assertTaskReadable({ actorUser: student, taskId: '6a0000000000000000000002' });
  // Gate passes; the attachment itself is resolved by taskService (stubbed).
});

// ===========================================================================
// TASK READ SCOPE — DOCTOR (ownership by Subject.doctorId, not createdBy)
// ===========================================================================
test('doctor list is limited to own subject(s), not tasks they created elsewhere', async () => {
  const { readScope } = buildFixture();
  // u_d1 created task_b but does NOT own s2 -> must not appear.
  const rows = await readScope.listTasksForActor({ actorUser: doctor1 });
  assert.deepStrictEqual(ids(rows), ['6a0000000000000000000001']);
});

test('doctor ownership is by subject, not createdBy (doctor 2 sees the subject they own)', async () => {
  const { readScope } = buildFixture();
  // u_d2 created task_a (subject s1) but does not own s1 -> must not appear.
  const rows = await readScope.listTasksForActor({ actorUser: doctor2 });
  assert.deepStrictEqual(ids(rows), ['6a0000000000000000000002']);
});

test('doctor cannot expand scope with a foreign subjectId filter (returns empty list)', async () => {
  const { readScope } = buildFixture();
  const rows = await readScope.listTasksForActor({ actorUser: doctor1, subjectId: 's2' });
  assert.deepStrictEqual(rows, []);
});

test('doctor can view own-subject task', async () => {
  const { readScope } = buildFixture();
  const task = await readScope.assertTaskReadable({ actorUser: doctor1, taskId: '6a0000000000000000000001' });
  assert.strictEqual(task._id, '6a0000000000000000000001');
});

test('doctor gets 404 for another subject task', async () => {
  const { readScope } = buildFixture();
  await assertNotFound(
    readScope.assertTaskReadable({ actorUser: doctor1, taskId: '6a0000000000000000000002' }),
    'doctor detail foreign'
  );
});

test('doctor attachment gate passes for own-subject task', async () => {
  const { readScope } = buildFixture();
  const task = await readScope.assertTaskReadable({ actorUser: doctor1, taskId: '6a0000000000000000000001' });
  assert.strictEqual(task.attachments[0].storageKey, 'key_a');
});

test('doctor attachment gate returns 404 for another subject task', async () => {
  const { readScope } = buildFixture();
  await assertNotFound(
    readScope.assertTaskReadable({ actorUser: doctor1, taskId: '6a0000000000000000000002' }),
    'doctor attachment foreign'
  );
});

test('doctor with no Doctor profile sees no tasks', async () => {
  const { readScope } = buildFixture();
  const rows = await readScope.listTasksForActor({ actorUser: doctorWithoutProfile });
  assert.deepStrictEqual(rows, []);
});

// ===========================================================================
// TASK READ SCOPE — TA (ownership by Subject.taId)
// ===========================================================================
test('TA list is limited to own subject tasks', async () => {
  const { readScope } = buildFixture();
  const rows = await readScope.listTasksForActor({ actorUser: ta1 });
  assert.deepStrictEqual(ids(rows), ['6a0000000000000000000001']);
});

test('TA explicit foreign subjectId filter returns empty list', async () => {
  const { readScope } = buildFixture();
  const rows = await readScope.listTasksForActor({ actorUser: ta1, subjectId: 's2' });
  assert.deepStrictEqual(rows, []);
});

test('TA can view own-subject task', async () => {
  const { readScope } = buildFixture();
  const task = await readScope.assertTaskReadable({ actorUser: ta1, taskId: '6a0000000000000000000001' });
  assert.strictEqual(task._id, '6a0000000000000000000001');
});

test('TA gets 404 for another subject task', async () => {
  const { readScope } = buildFixture();
  await assertNotFound(
    readScope.assertTaskReadable({ actorUser: ta1, taskId: '6a0000000000000000000002' }),
    'TA detail foreign'
  );
});

test('TA attachment gate passes for own-subject task', async () => {
  const { readScope } = buildFixture();
  const task = await readScope.assertTaskReadable({ actorUser: ta1, taskId: '6a0000000000000000000001' });
  assert.strictEqual(task.attachments[0].storageKey, 'key_a');
});

test('TA attachment gate returns 404 for another subject task', async () => {
  const { readScope } = buildFixture();
  await assertNotFound(
    readScope.assertTaskReadable({ actorUser: ta1, taskId: '6a0000000000000000000002' }),
    'TA attachment foreign'
  );
});

// ===========================================================================
// TASK READ SCOPE — LEADER / ADMIN and shared guarantees
// ===========================================================================
test('leader and admin keep unrestricted task list, detail and attachment access', async () => {
  const { readScope } = buildFixture();
  for (const actor of [leader, admin]) {
    const rows = await readScope.listTasksForActor({ actorUser: actor });
    assert.deepStrictEqual(ids(rows), ['6a0000000000000000000001', '6a0000000000000000000002'], `${actor.role} list`);
    const detail = await readScope.assertTaskReadable({ actorUser: actor, taskId: '6a0000000000000000000002' });
    assert.strictEqual(detail._id, '6a0000000000000000000002', `${actor.role} detail`);
  }
});

test('soft-deleted tasks are never returned to any role', async () => {
  const { readScope } = buildFixture();
  for (const actor of [student, leader, admin, doctor1, ta1]) {
    const rows = await readScope.listTasksForActor({ actorUser: actor });
    assert.ok(!rows.some((r) => r._id === '6a0000000000000000000003'), `${actor.role} must not see deleted task`);
  }
  await assert.rejects(
    readScope.assertTaskReadable({ actorUser: leader, taskId: '6a0000000000000000000003' }),
    (err) => err.statusCode === 404
  );
});

test('malformed task id is rejected with 422 for restricted roles', async () => {
  const { readScope } = buildFixture();
  await assert.rejects(
    readScope.assertTaskReadable({ actorUser: ta1, taskId: 'not-an-id' }),
    (err) => err.statusCode === 422 && err.code === 'INVALID_TASK_ID'
  );
  await assert.rejects(
    readScope.assertAttachmentReadable({ actorUser: doctor1, taskId: 'not-an-id' }),
    (err) => err.statusCode === 422 && err.code === 'INVALID_TASK_ID'
  );
});

test('unrestricted roles keep the previous behaviour for malformed ids (no new validation)', async () => {
  const { readScope } = buildFixture();
  // Student is unrestricted: the id goes straight to TaskService.getById,
  // which in this stub reports a missing task (404), as before.
  await assert.rejects(
    readScope.assertTaskReadable({ actorUser: student, taskId: 'not-an-id' }),
    (err) => err.statusCode === 404
  );
});

test('student attachment gate performs no lookup (valid but missing task id passes)', async () => {
  const { readScope } = buildFixture();
  // 24-hex id that does not exist: a lookup would 404, the unrestricted gate must not look up.
  await readScope.assertAttachmentReadable({
    actorUser: student,
    taskId: '6a00000000000000000000ff',
  });
});

test('attachment gate: leader and admin pass for any task', async () => {
  const { readScope } = buildFixture();
  await readScope.assertAttachmentReadable({ actorUser: leader, taskId: '6a0000000000000000000002' });
  await readScope.assertAttachmentReadable({ actorUser: admin, taskId: '6a0000000000000000000002' });
});

test('attachment gate: TA passes for own-subject task and gets 404 for foreign task', async () => {
  const { readScope } = buildFixture();
  await readScope.assertAttachmentReadable({ actorUser: ta1, taskId: '6a0000000000000000000001' });
  await assertNotFound(
    readScope.assertAttachmentReadable({ actorUser: ta1, taskId: '6a0000000000000000000002' }),
    'attachment gate TA foreign'
  );
});

test('attachment gate: doctor passes for own-subject task and gets 404 for foreign task', async () => {
  const { readScope } = buildFixture();
  await readScope.assertAttachmentReadable({ actorUser: doctor1, taskId: '6a0000000000000000000001' });
  await assertNotFound(
    readScope.assertAttachmentReadable({ actorUser: doctor1, taskId: '6a0000000000000000000002' }),
    'attachment gate doctor foreign'
  );
});

// ===========================================================================
// SCHEDULE HISTORY SCOPE
// ===========================================================================
test('student history is passed through unfiltered (both groups, not own group only)', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({
    actorUser: student,
    sessionId: undefined,
    subjectId: 's2',
  });
  assert.deepStrictEqual(historyCalls, [{ sessionId: undefined, subjectId: 's2' }]);
  assert.strictEqual(rows.length, 1);
});

test('student can read history for a foreign session (no subject restriction)', async () => {
  const { readScope, historyCalls } = buildFixture();
  await readScope.getChangeHistoryForActor({ actorUser: student, sessionId: '6b0000000000000000000002' });
  assert.deepStrictEqual(historyCalls, [{ sessionId: '6b0000000000000000000002', subjectId: undefined }]);
});

test('doctor sees history for own subject', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: doctor1, subjectId: 's1' });
  assert.deepStrictEqual(historyCalls, [{ subjectId: 's1' }]);
  assert.strictEqual(rows.length, 1);
});

test('doctor gets empty history for a foreign subject and the service is not called', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: doctor1, subjectId: 's2' });
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(historyCalls, []);
});

test('doctor gets empty history for a session of a foreign subject', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: doctor1, sessionId: '6b0000000000000000000002' });
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(historyCalls, []);
});

test('doctor sees history for a session of an own subject', async () => {
  const { readScope, historyCalls } = buildFixture();
  await readScope.getChangeHistoryForActor({ actorUser: doctor1, sessionId: '6b0000000000000000000001' });
  assert.deepStrictEqual(historyCalls, [{ sessionId: '6b0000000000000000000001' }]);
});

test('TA sees history for own subject and not for a foreign subject', async () => {
  const { readScope, historyCalls } = buildFixture();
  await readScope.getChangeHistoryForActor({ actorUser: ta1, subjectId: 's1' });
  const foreign = await readScope.getChangeHistoryForActor({ actorUser: ta1, subjectId: 's2' });
  assert.deepStrictEqual(historyCalls, [{ subjectId: 's1' }]);
  assert.deepStrictEqual(foreign, []);
});

test('leader and admin see all schedule history, including foreign sessions', async () => {
  const { readScope, historyCalls } = buildFixture();
  await readScope.getChangeHistoryForActor({ actorUser: leader, sessionId: '6b0000000000000000000002' });
  await readScope.getChangeHistoryForActor({ actorUser: admin, subjectId: 's2' });
  assert.deepStrictEqual(historyCalls, [
    { sessionId: '6b0000000000000000000002', subjectId: undefined },
    { sessionId: undefined, subjectId: 's2' },
  ]);
});

test('doctor with no filter gets history for ALL of their own subjects, newest first', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: doctor1 });
  // d1 owns s1 and s3 (multi-subject). Never s2 (owned by d2).
  assert.deepStrictEqual(historyCalls, [{ subjectId: 's1' }, { subjectId: 's3' }]);
  assert.deepStrictEqual(rows.map((r) => r._id), ['h_s3', 'h_s1']);
});

test('doctor with no filter does not receive another doctor\'s subject history', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: doctor1 });
  assert.ok(!rows.some((r) => r._id === 'h_s2'));
  assert.ok(!historyCalls.some((c) => c.subjectId === 's2'));
});

test('doctor 2 with no filter gets only their own subject history', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: doctor2 });
  assert.deepStrictEqual(historyCalls, [{ subjectId: 's2' }]);
  assert.deepStrictEqual(rows.map((r) => r._id), ['h_s2']);
});

test('TA with no filter gets history for their own subject', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: ta1 });
  assert.deepStrictEqual(historyCalls, [{ subjectId: 's1' }]);
  assert.deepStrictEqual(rows.map((r) => r._id), ['h_s1']);
});

test('TA with no filter does not receive another TA/subject history', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: ta1 });
  assert.ok(!rows.some((r) => r._id === 'h_s2' || r._id === 'h_s3'));
  assert.ok(!historyCalls.some((c) => c.subjectId === 's2'));
});

test('foreign supplied subjectId cannot expand access for doctor or TA', async () => {
  const { readScope, historyCalls } = buildFixture();
  const doctorForeign = await readScope.getChangeHistoryForActor({ actorUser: doctor1, subjectId: 's2' });
  const taForeign = await readScope.getChangeHistoryForActor({ actorUser: ta1, subjectId: 's2' });
  assert.deepStrictEqual(doctorForeign, []);
  assert.deepStrictEqual(taForeign, []);
  assert.deepStrictEqual(historyCalls, []);
});

test('doctor without a Doctor profile gets empty history with no filter and no service call', async () => {
  const { readScope, historyCalls } = buildFixture();
  const rows = await readScope.getChangeHistoryForActor({ actorUser: doctorWithoutProfile });
  assert.deepStrictEqual(rows, []);
  assert.deepStrictEqual(historyCalls, []);
});

test('student, leader and admin with no filter keep the existing service validation (422)', async () => {
  const { readScope, historyCalls } = buildFixture();
  for (const actor of [student, leader, admin]) {
    await assert.rejects(
      readScope.getChangeHistoryForActor({ actorUser: actor }),
      (err) => err.statusCode === 422,
      `${actor.role} no-filter must stay unchanged`
    );
  }
  assert.strictEqual(historyCalls.length, 3);
  assert.deepStrictEqual(historyCalls[0], { sessionId: undefined, subjectId: undefined });
});

test('malformed sessionId for a restricted caller still returns 422 INVALID_SESSION_ID', async () => {
  const { readScope, historyCalls } = buildFixture();
  await assert.rejects(
    readScope.getChangeHistoryForActor({ actorUser: ta1, sessionId: 'x' }),
    (err) => err.statusCode === 422 && err.code === 'INVALID_SESSION_ID'
  );
  assert.deepStrictEqual(historyCalls, []);
});

test('malformed sessionId for a restricted caller is rejected with 422', async () => {
  const { readScope } = buildFixture();
  await assert.rejects(
    readScope.getChangeHistoryForActor({ actorUser: ta1, sessionId: 'x' }),
    (err) => err.statusCode === 422 && err.code === 'INVALID_SESSION_ID'
  );
});
