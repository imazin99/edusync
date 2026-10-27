/**
 * Tests for the UNASSIGNED student-group design (approved separately from
 * the roster-import work): a student whose cohort hasn't been split into
 * G1/G2 yet can now be represented with `group: 'UNASSIGNED'` instead of
 * being forced into a guessed G1/G2 value.
 *
 * The ONLY production code change this design required was extending
 * `STUDENT_GROUP_VALUES` in server/utils/constants.js with a new,
 * student-only sentinel (`STUDENT_UNASSIGNED_GROUP`). `GROUPS`/
 * `GROUP_VALUES` (which feed ScheduleSession.group / ScheduleTemplate.group)
 * were deliberately left untouched, so a class session must still be
 * ALL/G1/G2 and can never be "unassigned" — these tests exist specifically
 * to prove that isolation holds, in addition to proving the new value
 * behaves correctly everywhere a Student's group is read.
 *
 * Like models.test.js and phase4.test.js, these run without a live
 * MongoDB connection: model tests use Mongoose's validateSync(), and
 * service tests use the in-memory fake collections from
 * ./helpers/fakeCollection.js.
 *
 * FOLLOW-UP FIX included here: RequestService.createGroupChangeRequest
 * now validates requestedGroup against GROUP_CHANGE_TARGET_VALUES
 * ([G1, G2] only) instead of STUDENT_GROUP_VALUES (which also includes
 * UNASSIGNED, since that's a legal CURRENT group). UNASSIGNED is valid
 * for a student's current group and for StudentService.create() during
 * initial import, but must never be a requestable target — see the
 * RequestService test block below.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');

const {
  ROLES,
  GROUPS,
  GROUP_VALUES,
  STUDENT_GROUP_VALUES,
  STUDENT_UNASSIGNED_GROUP,
  GROUP_CHANGE_TARGET_VALUES,
} = require('../utils/constants');
const { Student, ScheduleSession, ScheduleTemplate } = require('../models');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner } = require('./helpers/fakeTransaction');
const { createStudentService } = require('../services/StudentService');
const { createNotificationService } = require('../services/NotificationService');
const { createRequestService } = require('../services/RequestService');

const oid = () => new mongoose.Types.ObjectId();

function buildModels(seed = {}) {
  const scope = createTestFixtureScope();
  const c = (prefix, key) => createFakeCollection(prefix, seed[key] || [], scope);
  return {
    models: {
      User: c('user', 'users'),
      Student: c('student', 'students'),
      Request: c('request', 'requests'),
      Leader: c('leader', 'leaders'),
      Doctor: c('doctor', 'doctors'),
      TA: c('ta', 'tas'),
    },
  };
}

function spyAudit() {
  const calls = [];
  return { audit: { recordAudit: async (p) => calls.push(p) }, calls };
}

// ===========================================================================
// Constants — the exact shape the design specified
// ===========================================================================

test('STUDENT_UNASSIGNED_GROUP is the literal string "UNASSIGNED"', () => {
  assert.strictEqual(STUDENT_UNASSIGNED_GROUP, 'UNASSIGNED');
});

test('STUDENT_GROUP_VALUES now includes G1, G2, and UNASSIGNED (nothing else)', () => {
  assert.deepStrictEqual([...STUDENT_GROUP_VALUES].sort(), ['G1', 'G2', 'UNASSIGNED'].sort());
});

test('GROUPS / GROUP_VALUES are unchanged — UNASSIGNED was NOT added to the shared schedule-entity enum', () => {
  assert.deepStrictEqual(Object.keys(GROUPS).sort(), ['ALL', 'G1', 'G2'].sort());
  assert.deepStrictEqual([...GROUP_VALUES].sort(), ['ALL', 'G1', 'G2'].sort());
  assert.ok(!GROUP_VALUES.includes(STUDENT_UNASSIGNED_GROUP));
});

// ===========================================================================
// Model validation
// ===========================================================================

test('Student accepts group: UNASSIGNED', () => {
  const err = new Student({
    studentCode: '2501234',
    fullName: 'Test Student',
    group: STUDENT_UNASSIGNED_GROUP,
    userId: oid(),
  }).validateSync();
  assert.strictEqual(err, undefined);
});

test('Student still requires group (regression: UNASSIGNED does not make the field optional)', () => {
  const err = new Student({ studentCode: '2501234', fullName: 'Test Student', userId: oid() }).validateSync();
  assert.ok(err.errors.group);
});

test('Student still rejects group: ALL (regression — unchanged by this design)', () => {
  const err = new Student({
    studentCode: '2501234',
    fullName: 'Test Student',
    group: 'ALL',
    userId: oid(),
  }).validateSync();
  assert.ok(err.errors.group);
});

// -- Schedule-entity isolation: UNASSIGNED must never be legal there --------

function validScheduleState(overrides = {}) {
  return { startTime: '10:00', endTime: '12:00', roomId: oid(), doctorId: oid(), ...overrides };
}

function validTemplateData(overrides = {}) {
  return {
    subjectId: oid(),
    type: 'LECTURE',
    group: 'ALL',
    dayOfWeek: 'SATURDAY',
    startTime: '10:00',
    endTime: '12:00',
    roomId: oid(),
    doctorId: oid(),
    effectiveFrom: new Date('2026-09-01'),
    ...overrides,
  };
}

function validSessionData(overrides = {}) {
  return {
    templateId: oid(),
    subjectId: oid(),
    date: new Date('2026-10-03'),
    type: 'LECTURE',
    group: 'ALL',
    original: validScheduleState(),
    current: validScheduleState(),
    ...overrides,
  };
}

test('ScheduleTemplate rejects group: UNASSIGNED (isolation from Student.group holds)', () => {
  const err = new ScheduleTemplate(
    validTemplateData({ type: 'SECTION', group: STUDENT_UNASSIGNED_GROUP })
  ).validateSync();
  assert.ok(err.errors.group);
});

test('ScheduleSession rejects group: UNASSIGNED (isolation from Student.group holds)', () => {
  const err = new ScheduleSession(
    validSessionData({ type: 'SECTION', group: STUDENT_UNASSIGNED_GROUP })
  ).validateSync();
  assert.ok(err.errors.group);
});

// ===========================================================================
// StudentService
// ===========================================================================

test('StudentService.create accepts group: UNASSIGNED', async () => {
  const { models } = buildModels();
  const { audit } = spyAudit();
  const service = createStudentService({ models, auditService: audit });

  const student = await service.create({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    studentCode: '2501234',
    fullName: 'Unassigned Student',
    group: STUDENT_UNASSIGNED_GROUP,
  });

  assert.strictEqual(student.group, STUDENT_UNASSIGNED_GROUP);
  const user = models.User._docs.find((u) => u.username === '2501234');
  assert.strictEqual(user.passwordHash, null);
});

test('StudentService.create still rejects a missing group (regression: group stays required)', async () => {
  const { models } = buildModels();
  const service = createStudentService({ models, auditService: { recordAudit: async () => {} } });

  await assert.rejects(
    () =>
      service.create({
        actorUser: { id: 'admin_1', role: ROLES.ADMIN },
        studentCode: '2501234',
        fullName: 'No Group',
        group: undefined,
      }),
    (err) => {
      // AppError.badRequest() uses HTTP 422 (see server/utils/AppError.js),
      // not 400 — matching the project's existing convention, confirmed
      // against the same assertion style used elsewhere in this suite.
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

test('StudentService.update can move a student from UNASSIGNED to G1, and back to UNASSIGNED', async () => {
  const { models } = buildModels({
    users: [{ username: '2501234', role: ROLES.STUDENT, isActive: true }],
    students: [
      { userId: 'user_1', studentCode: '2501234', fullName: 'Stu', group: STUDENT_UNASSIGNED_GROUP, isActive: true },
    ],
  });
  const service = createStudentService({ models, auditService: { recordAudit: async () => {} } });

  await service.update({ actorUser: { id: 'admin_1', role: ROLES.ADMIN }, id: 'student_1', group: 'G1' });
  assert.strictEqual(models.Student._docs.find((s) => s._id === 'student_1').group, 'G1');

  await service.update({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    id: 'student_1',
    group: STUDENT_UNASSIGNED_GROUP,
  });
  assert.strictEqual(models.Student._docs.find((s) => s._id === 'student_1').group, STUDENT_UNASSIGNED_GROUP);
});

// ===========================================================================
// NotificationService
// ===========================================================================

test('NotificationService: a SECTION change (group G1) does NOT notify an UNASSIGNED student', async () => {
  const { models } = buildModels({
    students: [
      { userId: 'u_g1', studentCode: 'A', fullName: 'A', group: 'G1', isActive: true },
      { userId: 'u_unassigned', studentCode: 'B', fullName: 'B', group: STUDENT_UNASSIGNED_GROUP, isActive: true },
    ],
  });
  const service = createNotificationService({ models });

  const recipients = await service.computeScheduleChangeRecipients({ session: { group: 'G1' }, subject: {} });

  assert.ok(recipients.includes('u_g1'));
  assert.ok(!recipients.includes('u_unassigned'));
});

test('NotificationService: a LECTURE change (group ALL) DOES notify an UNASSIGNED student', async () => {
  const { models } = buildModels({
    students: [
      { userId: 'u_g1', studentCode: 'A', fullName: 'A', group: 'G1', isActive: true },
      { userId: 'u_unassigned', studentCode: 'B', fullName: 'B', group: STUDENT_UNASSIGNED_GROUP, isActive: true },
    ],
  });
  const service = createNotificationService({ models });

  const recipients = await service.computeScheduleChangeRecipients({
    session: { group: GROUPS.ALL },
    subject: {},
  });

  assert.ok(recipients.includes('u_g1') && recipients.includes('u_unassigned'));
});

// ===========================================================================
// RequestService — group-change request doubles as "first assignment"
// ===========================================================================

test('RequestService: approving a GROUP_CHANGE request moves a student from UNASSIGNED to the requested group', async () => {
  const { models } = buildModels({
    users: [{ username: 'stu', role: ROLES.STUDENT, isActive: true }],
    students: [
      { userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: STUDENT_UNASSIGNED_GROUP, isActive: true },
    ],
  });
  const service = createRequestService({
    models,
    auditService: { recordAudit: async () => {} },
    runInTransaction: createFakeTransactionRunner(models),
  });

  const requestDoc = await service.createGroupChangeRequest({
    actorUser: { id: 'user_1', role: ROLES.STUDENT },
    requestedGroup: 'G1',
  });
  await service.review({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    requestId: requestDoc._id,
    status: 'APPROVED',
  });

  const student = models.Student._docs.find((s) => s._id === 'student_1');
  assert.strictEqual(student.group, 'G1');
});

// FOLLOW-UP FIX: createGroupChangeRequest() previously validated
// requestedGroup against STUDENT_GROUP_VALUES (which includes UNASSIGNED,
// since that's also a legal CURRENT group). It now validates against the
// narrower, dedicated GROUP_CHANGE_TARGET_VALUES ([G1, G2] only), so a
// student can never request UNASSIGNED as a destination — only ever a
// real group. UNASSIGNED remains legal as a student's CURRENT group
// (e.g. right after the initial cohort import) and for StudentService
// .create() — neither of those changed.
test('GROUP_CHANGE_TARGET_VALUES is exactly [G1, G2] — UNASSIGNED is not a requestable target', () => {
  assert.deepStrictEqual([...GROUP_CHANGE_TARGET_VALUES].sort(), ['G1', 'G2'].sort());
  assert.ok(!GROUP_CHANGE_TARGET_VALUES.includes(STUDENT_UNASSIGNED_GROUP));
});

test('RequestService: a GROUP_CHANGE request targeting UNASSIGNED is rejected', async () => {
  const { models } = buildModels({
    users: [{ username: 'stu', role: ROLES.STUDENT, isActive: true }],
    students: [{ userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: 'G1', isActive: true }],
  });
  const service = createRequestService({
    models,
    auditService: { recordAudit: async () => {} },
    runInTransaction: createFakeTransactionRunner(models),
  });

  await assert.rejects(
    () =>
      service.createGroupChangeRequest({
        actorUser: { id: 'user_1', role: ROLES.STUDENT },
        requestedGroup: STUDENT_UNASSIGNED_GROUP,
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
  // Confirms it was rejected before any write: no request was created.
  assert.strictEqual(models.Request._docs.length, 0);
});

test('RequestService: a GROUP_CHANGE request targeting G1 still works for a currently-UNASSIGNED student', async () => {
  const { models } = buildModels({
    users: [{ username: 'stu', role: ROLES.STUDENT, isActive: true }],
    students: [
      { userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: STUDENT_UNASSIGNED_GROUP, isActive: true },
    ],
  });
  const service = createRequestService({
    models,
    auditService: { recordAudit: async () => {} },
    runInTransaction: createFakeTransactionRunner(models),
  });

  const requestDoc = await service.createGroupChangeRequest({
    actorUser: { id: 'user_1', role: ROLES.STUDENT },
    requestedGroup: 'G1',
  });
  await service.review({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    requestId: requestDoc._id,
    status: 'APPROVED',
  });

  const student = models.Student._docs.find((s) => s._id === 'student_1');
  assert.strictEqual(student.group, 'G1');
});

test('RequestService: a GROUP_CHANGE request targeting G2 still works (regression)', async () => {
  const { models } = buildModels({
    users: [{ username: 'stu', role: ROLES.STUDENT, isActive: true }],
    students: [{ userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: 'G1', isActive: true }],
  });
  const service = createRequestService({
    models,
    auditService: { recordAudit: async () => {} },
    runInTransaction: createFakeTransactionRunner(models),
  });

  const requestDoc = await service.createGroupChangeRequest({
    actorUser: { id: 'user_1', role: ROLES.STUDENT },
    requestedGroup: 'G2',
  });
  await service.review({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    requestId: requestDoc._id,
    status: 'APPROVED',
  });

  const student = models.Student._docs.find((s) => s._id === 'student_1');
  assert.strictEqual(student.group, 'G2');
});

test('RequestService: a GROUP_CHANGE request targeting an unrelated invalid string is still rejected (regression)', async () => {
  const { models } = buildModels({
    users: [{ username: 'stu', role: ROLES.STUDENT, isActive: true }],
    students: [{ userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: 'G1', isActive: true }],
  });
  const service = createRequestService({
    models,
    auditService: { recordAudit: async () => {} },
    runInTransaction: createFakeTransactionRunner(models),
  });

  await assert.rejects(
    () =>
      service.createGroupChangeRequest({
        actorUser: { id: 'user_1', role: ROLES.STUDENT },
        requestedGroup: 'G3',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

// ===========================================================================
// Route-level: confirms no accidental group-based filtering was introduced
// on schedule reads (the design's §3 finding: the backend has never
// filtered schedule reads by actor/group, for ANY student — this proves
// that stays true now that a student's group can be UNASSIGNED).
// ===========================================================================

test('GET /api/schedule/sessions returns the identical, unfiltered session list for a G1 student and for an UNASSIGNED student', async () => {
  // Patch shared middleware exports BEFORE requiring the router, same
  // technique scheduleRoutes.test.js already uses, so the REAL router/
  // controller run, with only the DB-touching leaf call stubbed.
  const authModule = require('../middleware/auth');
  const maintenanceModule = require('../middleware/maintenance');
  maintenanceModule.checkMaintenanceMode = (req, res, next) => next();

  const scheduleService = require('../services/ScheduleService');
  const calls = [];
  const canned = [
    { _id: 's1', group: 'ALL' },
    { _id: 's2', group: 'G1' },
    { _id: 's3', group: 'G2' },
  ];
  scheduleService.getSessionsForRange = async (args) => {
    calls.push(args);
    return canned;
  };

  async function fetchAsActor(actorUser) {
    authModule.requireAuth = (req, res, next) => {
      req.user = actorUser;
      next();
    };
    delete require.cache[require.resolve('../routes/schedule.routes')];
    const router = require('../routes/schedule.routes');
    const app = express();
    app.use(express.json());
    app.use('/api/schedule', router);
    const res = await request(app).get('/api/schedule/sessions?date=2026-10-15');
    return res;
  }

  const g1Res = await fetchAsActor({
    id: 'u_g1',
    role: ROLES.STUDENT,
    student: { group: 'G1' },
  });
  const unassignedRes = await fetchAsActor({
    id: 'u_unassigned',
    role: ROLES.STUDENT,
    student: { group: STUDENT_UNASSIGNED_GROUP },
  });

  assert.strictEqual(g1Res.status, 200);
  assert.strictEqual(unassignedRes.status, 200);
  assert.deepStrictEqual(g1Res.body.sessions, canned);
  assert.deepStrictEqual(unassignedRes.body.sessions, canned);
  // Neither call passed any actor/group-derived argument to the service —
  // confirms the controller never reads req.user for this endpoint, so
  // there is no path by which UNASSIGNED could ever trigger different
  // filtering than any other student.
  for (const call of calls) {
    assert.ok(!('group' in call));
    assert.ok(!('studentGroup' in call));
  }
});
