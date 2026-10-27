/**
 * Phase 4 tests: service-layer business logic for Students, Doctors, TAs,
 * Leaders, Subjects, Rooms, the Schedule engine (one-time vs permanent
 * changes, conflicts, history, group scoping), Tasks (permission model),
 * Notifications (actor exclusion, recipient scoping), and Requests.
 *
 * Like Phase 2/3, these run without a live MongoDB connection: every
 * service here is a factory accepting injectable models, exercised
 * against the in-memory fake collections in helpers/fakeCollection.js.
 * This is deliberately service-layer-focused rather than full HTTP/
 * supertest coverage of every route — see the Phase 4 report for the
 * documented scope decision.
 */

const test = require('node:test');
const assert = require('node:assert');

const { createFakeCollection, createTestFixtureScope } = require('./helpers/fakeCollection');
const { createFakeTransactionRunner } = require('./helpers/fakeTransaction');
const { ROLES, GROUPS, CLASS_TYPES, SESSION_STATUS } = require('../utils/constants');

const { createStudentService } = require('../services/StudentService');
const { createStaffService } = require('../services/StaffService');
const { createLeaderService } = require('../services/LeaderService');
const { createSubjectService } = require('../services/SubjectService');
const { createRoomService } = require('../services/RoomService');
const { createNotificationService } = require('../services/NotificationService');
const { createScheduleService } = require('../services/ScheduleService');
const { createTaskService } = require('../services/TaskService');
const { createRequestService } = require('../services/RequestService');

// ---------------------------------------------------------------------------
// Shared fixture: every model as a fake collection sharing one ID scope,
// plus a spy audit service and a real (fake-backed) notification service
// so schedule/task tests can assert on actual dispatched notifications.
// ---------------------------------------------------------------------------

function buildModels(seed = {}) {
  const scope = createTestFixtureScope();
  const c = (prefix, key) => createFakeCollection(prefix, seed[key] || [], scope);
  return {
    scope,
    models: {
      User: c('user', 'users'),
      Student: c('student', 'students'),
      Doctor: c('doctor', 'doctors'),
      TA: c('ta', 'tas'),
      Leader: c('leader', 'leaders'),
      Subject: c('subject', 'subjects'),
      Room: c('room', 'rooms'),
      ScheduleTemplate: c('template', 'templates'),
      ScheduleSession: c('session', 'sessions'),
      ScheduleChange: c('change', 'changes'),
      Task: c('task', 'tasks'),
      TaskCompletion: c('completion', 'completions'),
      Notification: c('notification', 'notifications'),
      NotificationRecipient: c('recipient', 'recipients'),
      Request: c('request', 'requests'),
      AuditLog: c('audit', 'auditLogs'),
      SystemSettings: {
        getSingleton: async () => ({ maintenanceMode: false, maintenanceMessage: '' }),
      },
    },
  };
}

function spyAudit() {
  const calls = [];
  return { audit: { recordAudit: async (p) => calls.push(p) }, calls };
}

// ===========================================================================
// StudentService
// ===========================================================================

test('StudentService.create creates a User (role STUDENT, no password) and a Student', async () => {
  const { models } = buildModels();
  const { audit, calls } = spyAudit();
  const service = createStudentService({ models, auditService: audit });

  const student = await service.create({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    studentCode: '2201234',
    fullName: 'Ada Lovelace',
    group: 'G1',
  });

  assert.strictEqual(student.studentCode, '2201234');
  const user = models.User._docs.find((u) => u.username === '2201234');
  assert.strictEqual(user.role, ROLES.STUDENT);
  assert.strictEqual(user.passwordHash, null);
  assert.ok(calls.some((c) => c.action === 'STUDENT_CREATED'));
});

test('StudentService.create rejects a duplicate studentCode', async () => {
  const { models } = buildModels({ users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true }] });
  const service = createStudentService({ models, auditService: { recordAudit: async () => {} } });

  await assert.rejects(
    () =>
      service.create({
        actorUser: { id: 'admin_1', role: ROLES.ADMIN },
        studentCode: '2201234',
        fullName: 'Dup',
        group: 'G1',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      return true;
    }
  );
});

test('StudentService.update changing studentCode also syncs User.username', async () => {
  const { models } = buildModels({
    users: [{ username: '2201234', role: ROLES.STUDENT, isActive: true }],
    students: [{ userId: 'user_1', studentCode: '2201234', fullName: 'Ada', group: 'G1', isActive: true }],
  });
  const service = createStudentService({ models, auditService: { recordAudit: async () => {} } });

  await service.update({
    actorUser: { id: 'admin_1', role: ROLES.ADMIN },
    id: 'student_1',
    studentCode: '2209999',
  });

  const user = models.User._docs.find((u) => u._id === 'user_1');
  assert.strictEqual(user.username, '2209999');
});

// ===========================================================================
// StaffService (Doctor/TA)
// ===========================================================================

test('StaffService.create requires a password (Doctor/TA never code-only)', async () => {
  const { models } = buildModels();
  const service = createStaffService({
    models,
    auditService: { recordAudit: async () => {} },
    role: ROLES.DOCTOR,
    ProfileModelName: 'Doctor',
  });

  await assert.rejects(
    () => service.create({ actorUser: { id: 'a', role: ROLES.ADMIN }, username: 'dr_x', fullName: 'Dr X' }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

test('StaffService.create makes a User with a password hash and a matching profile', async () => {
  const { models } = buildModels();
  const service = createStaffService({
    models,
    auditService: { recordAudit: async () => {} },
    role: ROLES.DOCTOR,
    ProfileModelName: 'Doctor',
  });

  const doctor = await service.create({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    username: 'dr_x',
    fullName: 'Dr X',
    password: 'a-real-password-1',
  });

  const user = models.User._docs.find((u) => u.username === 'dr_x');
  assert.strictEqual(user.role, ROLES.DOCTOR);
  assert.ok(user.passwordHash);
  assert.strictEqual(doctor.fullName, 'Dr X');
});

// ===========================================================================
// LeaderService
// ===========================================================================

test('LeaderService.create rejects a second active leader in the same slot', async () => {
  const { models } = buildModels({
    students: [{ userId: 'u', studentCode: 'S1', fullName: 'S', group: 'G1', isActive: true }],
  });
  const service = createLeaderService({ models, auditService: { recordAudit: async () => {} } });

  await service.create({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    slot: 'FEMALE',
    linkedStudentId: 'student_1',
    username: 'leader_f1',
    password: 'a-real-password-1',
  });

  await assert.rejects(
    () =>
      service.create({
        actorUser: { id: 'a', role: ROLES.ADMIN },
        slot: 'FEMALE',
        linkedStudentId: 'student_1',
        username: 'leader_f2',
        password: 'a-real-password-1',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      assert.strictEqual(err.code, 'LEADER_SLOT_TAKEN');
      return true;
    }
  );
});

test('LeaderService replacement flow: deactivate old, then create succeeds for the same slot', async () => {
  const { models } = buildModels({
    students: [{ userId: 'u', studentCode: 'S1', fullName: 'S', group: 'G1', isActive: true }],
  });
  const service = createLeaderService({ models, auditService: { recordAudit: async () => {} } });

  const oldLeader = await service.create({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    slot: 'MALE',
    linkedStudentId: 'student_1',
    username: 'leader_m1',
    password: 'a-real-password-1',
  });

  await service.setActive({ actorUser: { id: 'a', role: ROLES.ADMIN }, id: oldLeader._id, isActive: false });

  const newLeader = await service.create({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    slot: 'MALE',
    linkedStudentId: 'student_1',
    username: 'leader_m2',
    password: 'a-real-password-1',
  });

  assert.strictEqual(newLeader.isActive, true);
  const stillThere = models.Leader._docs.find((l) => l._id === oldLeader._id);
  assert.strictEqual(stillThere.isActive, false, 'old leader record must NOT be erased');
});

// ===========================================================================
// SubjectService / RoomService (basic validation)
// ===========================================================================

test('SubjectService.create rejects an unknown doctorId', async () => {
  const { models } = buildModels();
  const service = createSubjectService({ models, auditService: { recordAudit: async () => {} } });

  await assert.rejects(
    () =>
      service.create({
        actorUser: { id: 'a', role: ROLES.ADMIN },
        name: 'OOP',
        code: 'OOP101',
        doctorId: 'doctor_ghost',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

test('RoomService.create rejects a duplicate room', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  await service.create({ actorUser: { id: 'a', role: ROLES.ADMIN }, building: 'H', floor: '2', roomNumber: '204' });
  await assert.rejects(
    () =>
      service.create({ actorUser: { id: 'a', role: ROLES.ADMIN }, building: 'H', floor: '2', roomNumber: '204' }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      return true;
    }
  );
});

// -- Regression tests: numeric `floor` (bug found in live verification) ----

test('RoomService.create accepts a NUMBER floor and stores it as a string (matches the frozen schema type)', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  const room = await service.create({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    building: 'H',
    floor: 3, // number, not string — this is exactly what crashed live
    roomNumber: '301',
  });

  assert.strictEqual(room.floor, '3');
  assert.strictEqual(typeof room.floor, 'string');
});

test('RoomService.create accepts floor: 0 (a legitimate ground floor), not treated as missing', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  const room = await service.create({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    building: 'G',
    floor: 0,
    roomNumber: '001',
  });

  assert.strictEqual(room.floor, '0');
});

test('RoomService.create still accepts a STRING floor exactly as before (no regression)', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  const room = await service.create({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    building: 'E',
    floor: 'Ground',
    roomNumber: 'A1',
  });

  assert.strictEqual(room.floor, 'Ground');
});

test('RoomService.create still rejects a missing floor (undefined)', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  await assert.rejects(
    () =>
      service.create({ actorUser: { id: 'a', role: ROLES.ADMIN }, building: 'H', roomNumber: '204' }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

test('RoomService.create rejects an empty-string floor', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  await assert.rejects(
    () =>
      service.create({ actorUser: { id: 'a', role: ROLES.ADMIN }, building: 'H', floor: '', roomNumber: '204' }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

test('RoomService.create rejects a whitespace-only floor', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  await assert.rejects(
    () =>
      service.create({ actorUser: { id: 'a', role: ROLES.ADMIN }, building: 'H', floor: '   ', roomNumber: '204' }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

test('RoomService.create treats a numeric floor and its string equivalent as the SAME room for duplicate detection', async () => {
  const { models } = buildModels();
  const service = createRoomService({ models, auditService: { recordAudit: async () => {} } });

  await service.create({ actorUser: { id: 'a', role: ROLES.ADMIN }, building: 'H', floor: 3, roomNumber: '301' });
  await assert.rejects(
    () =>
      service.create({
        actorUser: { id: 'a', role: ROLES.ADMIN },
        building: 'H',
        floor: '3', // same floor, sent as a string this time
        roomNumber: '301',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      return true;
    }
  );
});

// ===========================================================================
// NotificationService — actor exclusion + group scoping
// ===========================================================================

test('NotificationService.dispatch excludes the actor and includes everyone else', async () => {
  const { models } = buildModels({
    users: [
      { username: 'stu', role: ROLES.STUDENT, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ],
  });
  const service = createNotificationService({ models });

  const notification = await service.dispatch({
    type: 'TEST',
    category: 'TASK',
    title: 't',
    message: 'm',
    createdBy: 'user_1',
    relatedType: 'TASK',
    relatedId: 'task_1',
    recipientUserIds: ['user_1', 'user_2'],
    actorUserId: 'user_1',
  });

  const recipients = models.NotificationRecipient._docs.filter(
    (r) => r.notificationId === notification._id
  );
  assert.strictEqual(recipients.length, 1);
  assert.strictEqual(recipients[0].userId, 'user_2');
});

test('NotificationService.dispatch STILL excludes a non-Admin actor when actorRole is explicitly passed (no regression)', async () => {
  const { models } = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'stu', role: ROLES.STUDENT, isActive: true },
    ],
  });
  const service = createNotificationService({ models });

  const notification = await service.dispatch({
    type: 'TEST',
    category: 'SCHEDULE',
    title: 't',
    message: 'm',
    createdBy: 'user_1',
    relatedType: 'SCHEDULE_SESSION',
    relatedId: 'session_1',
    recipientUserIds: ['user_1', 'user_2'],
    actorUserId: 'user_1',
    actorRole: ROLES.DOCTOR,
  });

  const recipients = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);
  assert.deepStrictEqual(recipients, ['user_2']);
});

test('NotificationService.dispatch does NOT exclude the actor when actorRole is ADMIN (regression: live bug)', async () => {
  // Reproduces the exact reported scenario: an Admin causes an event and
  // is ALSO present in recipientUserIds (as "an active Admin") — spec
  // section 58 requires Admin to receive it anyway, unlike every other role.
  const { models } = buildModels({
    users: [
      { username: 'phase4admin', role: ROLES.ADMIN, isActive: true },
      { username: 'stu', role: ROLES.STUDENT, isActive: true },
    ],
  });
  const service = createNotificationService({ models });

  const notification = await service.dispatch({
    type: 'TIME_CHANGED',
    category: 'SCHEDULE',
    title: 't',
    message: 'm',
    createdBy: 'user_1',
    relatedType: 'SCHEDULE_SESSION',
    relatedId: 'session_1',
    recipientUserIds: ['user_1', 'user_2'], // user_1 = the acting Admin, also a recipient
    actorUserId: 'user_1',
    actorRole: ROLES.ADMIN,
  });

  const recipients = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);
  assert.ok(recipients.includes('user_1'), 'the acting Admin must still receive the notification');
  assert.ok(recipients.includes('user_2'));
  assert.strictEqual(recipients.length, 2);
});

test('NotificationService.computeScheduleChangeRecipients scopes students to the session group', async () => {
  const { models } = buildModels({
    students: [
      { userId: 'u_g1', studentCode: 'A', fullName: 'A', group: 'G1', isActive: true },
      { userId: 'u_g2', studentCode: 'B', fullName: 'B', group: 'G2', isActive: true },
    ],
  });
  const service = createNotificationService({ models });

  const g1Recipients = await service.computeScheduleChangeRecipients({
    session: { group: 'G1' },
    subject: {},
  });
  assert.ok(g1Recipients.includes('u_g1'));
  assert.ok(!g1Recipients.includes('u_g2'));

  const allRecipients = await service.computeScheduleChangeRecipients({
    session: { group: GROUPS.ALL },
    subject: {},
  });
  assert.ok(allRecipients.includes('u_g1') && allRecipients.includes('u_g2'));
});

// ===========================================================================
// ScheduleService — templates, one-time vs permanent, conflicts, history
// ===========================================================================

function scheduleFixture({ runInTransaction } = {}) {
  const { models } = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'dr2', role: ROLES.DOCTOR, isActive: true },
      { username: 'leader', role: ROLES.LEADER, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ],
    doctors: [
      { userId: 'user_1', fullName: 'Dr One', isActive: true },
      { userId: 'user_2', fullName: 'Dr Two', isActive: true },
    ],
    leaders: [{ userId: 'user_3', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
    subjects: [
      { name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', hasSections: true, isActive: true },
      { name: 'DB', code: 'DB101', doctorId: 'doctor_2', hasSections: false, isActive: true },
    ],
    rooms: [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }],
  });
  const { audit } = spyAudit();
  const notificationService = createNotificationService({ models });
  // Default: a simple pass-through (no real transaction, no rollback
  // simulation) — every existing schedule test relies on this exact
  // behavior and is unaffected by the transactional restructuring.
  // Tests that specifically need to prove rollback pass a real
  // simulation runner (see helpers/fakeTransaction.js) instead.
  const txRunner = runInTransaction || (async (callback) => callback({ __passthroughFakeSession: true }));
  const service = createScheduleService({
    models,
    auditService: audit,
    notificationService,
    runInTransaction: txRunner,
  });
  return { models, service, notificationService };
}

test('ScheduleService.createTemplate rejects a SECTION without an existing LECTURE', async () => {
  const { models, service } = scheduleFixture();
  await assert.rejects(
    () =>
      service.createTemplate({
        actorUser: { id: 'user_4', role: ROLES.ADMIN },
        subjectId: 'subject_1',
        type: CLASS_TYPES.SECTION,
        group: 'G1',
        dayOfWeek: 'SATURDAY',
        startTime: '10:00',
        endTime: '12:00',
        roomId: 'room_1',
        doctorId: 'doctor_1',
      }),
    (err) => {
      assert.strictEqual(err.code, 'LECTURE_REQUIRED');
      return true;
    }
  );
});

test('ScheduleService: Doctor one-time change on OWN subject succeeds and is never permanent', async () => {
  const { models, service } = scheduleFixture();

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

  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const session = sessions[0];

  const result = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR }, // Dr One, owns subject_1
    sessionId: session._id,
    patch: { roomId: 'room_2' },
    // no isPermanent flag at all — a real Doctor client never sends one
    // (spec section 88: no permanent-change selector is ever shown to them)
  });

  assert.strictEqual(result.noop, false);
  assert.strictEqual(result.change.isPermanent, false);
  assert.ok(result.change.changeTypes.includes('ROOM_CHANGED'));
});

test("ScheduleService: Doctor CANNOT edit another subject's session", async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    subjectId: 'subject_2', // DB, owned by doctor_2
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek: 'SATURDAY',
    startTime: '10:00',
    endTime: '12:00',
    roomId: 'room_1',
    doctorId: 'doctor_2',
    effectiveFrom: '2026-01-01',
  });
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  await assert.rejects(
    () =>
      service.applyChange({
        actorUser: { id: 'user_1', role: ROLES.DOCTOR }, // Dr One — does NOT own subject_2
        sessionId: sessions[0]._id,
        patch: { roomId: 'room_2' },
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      return true;
    }
  );
});

test('ScheduleService: Leader can edit any subject one-time, but never permanently', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    subjectId: 'subject_2',
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek: 'SATURDAY',
    startTime: '10:00',
    endTime: '12:00',
    roomId: 'room_1',
    doctorId: 'doctor_2',
    effectiveFrom: '2026-01-01',
  });
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  const result = await service.applyChange({
    actorUser: { id: 'user_3', role: ROLES.LEADER },
    sessionId: sessions[0]._id,
    patch: { startTime: '11:00', endTime: '13:00' },
  });

  assert.strictEqual(result.change.isPermanent, false);
  assert.strictEqual(result.change.changedByRole, ROLES.LEADER);
});

test('ScheduleService: a non-Admin explicitly requesting isPermanent is rejected (never silently downgraded)', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    subjectId: 'subject_2',
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek: 'SATURDAY',
    startTime: '10:00',
    endTime: '12:00',
    roomId: 'room_1',
    doctorId: 'doctor_2',
    effectiveFrom: '2026-01-01',
  });
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  await assert.rejects(
    () =>
      service.applyChange({
        actorUser: { id: 'user_3', role: ROLES.LEADER },
        sessionId: sessions[0]._id,
        patch: { roomId: 'room_1' },
        isPermanent: true,
        effectiveFrom: '2026-10-03',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      return true;
    }
  );
});

test('ScheduleService: Admin permanent change versions the template (old closed, new opened)', async () => {
  const { models, service } = scheduleFixture();
  const template = await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  const result = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId: sessions[0]._id,
    patch: { startTime: '14:00', endTime: '16:00' },
    isPermanent: true,
    effectiveFrom: '2026-10-03',
  });

  assert.strictEqual(result.change.isPermanent, true);

  const oldTemplate = models.ScheduleTemplate._docs.find((t) => t._id === template._id);
  assert.strictEqual(oldTemplate.isActive, false);
  assert.ok(oldTemplate.effectiveTo);

  const newTemplates = models.ScheduleTemplate._docs.filter(
    (t) => t.subjectId === 'subject_1' && t._id !== template._id
  );
  assert.strictEqual(newTemplates.length, 1);
  assert.strictEqual(newTemplates[0].startTime, '14:00');
  assert.strictEqual(newTemplates[0].isActive, true);
});

test('ScheduleService: submitting an identical patch twice is a no-op the second time (duplicate protection)', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  const first = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId: sessions[0]._id,
    patch: { roomId: 'room_1' }, // same as current -> no real change
  });
  assert.strictEqual(first.noop, true);
  assert.strictEqual(models.ScheduleChange._docs.length, 0);
});

test('ScheduleService: cancel then restore both create history entries', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId,
    patch: { status: SESSION_STATUS.CANCELLED },
  });
  await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId,
    patch: { status: SESSION_STATUS.ACTIVE },
  });

  const history = await service.getChangeHistory({ sessionId });
  assert.strictEqual(history.length, 2);
  assert.ok(history[0].changeTypes.includes('CANCELLED'));
  assert.ok(history[1].changeTypes.includes('RESTORED'));

  const session = await service.getSessionById(sessionId);
  assert.strictEqual(session.status, SESSION_STATUS.ACTIVE);
});

test('ScheduleService: room conflict produces a warning but the change still applies (warn, not block)', async () => {
  const { models, service } = scheduleFixture();
  // Two lecture templates in different subjects, same room+day, different times initially.
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    subjectId: 'subject_2',
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek: 'SATURDAY',
    startTime: '13:00',
    endTime: '15:00',
    roomId: 'room_1',
    doctorId: 'doctor_2',
    effectiveFrom: '2026-01-01',
  });

  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const subject2Session = sessions.find((s) => s.subjectId === 'subject_2');

  const result = await service.applyChange({
    actorUser: { id: 'user_2', role: ROLES.DOCTOR },
    sessionId: subject2Session._id,
    patch: { startTime: '10:30', endTime: '11:30' }, // now overlaps subject_1's 10-12 in room_1
  });

  assert.strictEqual(result.noop, false, 'the change should still be applied despite the conflict');
  assert.ok(result.warnings.some((w) => w.type === 'ROOM_CONFLICT'));
});

// ===========================================================================
// TaskService — permission model
// ===========================================================================

function taskFixture() {
  const { models } = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'ta', role: ROLES.TA, isActive: true },
      { username: 'dr2', role: ROLES.DOCTOR, isActive: true },
      { username: 'leader', role: ROLES.LEADER, isActive: true },
      { username: 'stu', role: ROLES.STUDENT, isActive: true },
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    tas: [{ userId: 'user_2', fullName: 'TA One', isActive: true }],
    leaders: [{ userId: 'user_4', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
    students: [{ userId: 'user_5', studentCode: 'S1', fullName: 'Stu', group: 'G1', isActive: true }],
    subjects: [
      { name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', taId: 'ta_1', isActive: true },
      { name: 'DB', code: 'DB101', doctorId: 'doctor_x', isActive: true }, // not user_3
    ],
  });
  const { audit } = spyAudit();
  const notificationService = createNotificationService({ models });
  const service = createTaskService({
    models,
    auditService: audit,
    notificationService,
    // G3C: TaskService now wraps each write + its notification dispatch
    // in a transaction (same established pattern as ScheduleService);
    // this passthrough fake session is the same one used throughout
    // this file's own scheduleFixture().
    runInTransaction: async (callback) => callback({ __passthroughFakeSession: true }),
  });
  return { models, service };
}

test('TaskService: TA can edit a task the Doctor created for their shared subject', async () => {
  const { models, service } = taskFixture();
  const task = await service.create({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    title: 'Assignment 1',
    subjectId: 'subject_1',
  });

  const updated = await service.update({
    actorUser: { id: 'user_2', role: ROLES.TA },
    taskId: task._id,
    title: 'Assignment 1 (updated by TA)',
  });

  assert.strictEqual(updated.title, 'Assignment 1 (updated by TA)');
});

test('TaskService: Doctor of a DIFFERENT subject cannot create a task for this subject', async () => {
  const { models, service } = taskFixture();
  await assert.rejects(
    () =>
      service.create({
        actorUser: { id: 'user_1', role: ROLES.DOCTOR }, // Dr One, owns subject_1 not subject_2
        title: 'Not allowed',
        subjectId: 'subject_2',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 403);
      return true;
    }
  );
});

test('TaskService: Leader can create a task for any subject', async () => {
  const { models, service } = taskFixture();
  const task = await service.create({
    actorUser: { id: 'user_4', role: ROLES.LEADER },
    title: 'Leader task',
    subjectId: 'subject_2',
  });
  assert.strictEqual(task.subjectId, 'subject_2');
});

test('TaskService: markDone is isolated per student', async () => {
  const { models, service } = taskFixture();
  // Add a second student to the same fixture.
  models.Student._docs.push({
    _id: 'student_2',
    userId: 'user_6',
    studentCode: 'S2',
    fullName: 'Stu Two',
    group: 'G1',
    isActive: true,
    save: async function save() {
      return this;
    },
  });

  const task = await service.create({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    title: 'Assignment 1',
    subjectId: 'subject_1',
  });

  await service.markDone({ actorUser: { id: 'user_5', role: ROLES.STUDENT }, taskId: task._id });
  await service.markDone({ actorUser: { id: 'user_6', role: ROLES.STUDENT }, taskId: task._id });

  let completions = models.TaskCompletion._docs.filter((c) => c.taskId === task._id);
  assert.strictEqual(completions.length, 2);
  assert.ok(completions.some((c) => c.studentId === 'student_1'));
  assert.ok(completions.some((c) => c.studentId === 'student_2'));

  // Student 1 un-marking must not affect student 2's completion.
  await service.unmarkDone({ actorUser: { id: 'user_5', role: ROLES.STUDENT }, taskId: task._id });
  completions = models.TaskCompletion._docs.filter((c) => c.taskId === task._id);
  assert.strictEqual(completions.length, 1);
  assert.strictEqual(completions[0].studentId, 'student_2');
});

test('TaskService: deadline change dispatches a DEADLINE_CHANGED notification', async () => {
  const { models, service } = taskFixture();
  const task = await service.create({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    title: 'Assignment 1',
    subjectId: 'subject_1',
    deadline: '2026-11-01T00:00:00.000Z',
  });

  await service.update({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    taskId: task._id,
    deadline: '2026-11-05T00:00:00.000Z',
  });

  const deadlineNotifs = models.Notification._docs.filter((n) => n.type === 'DEADLINE_CHANGED');
  assert.strictEqual(deadlineNotifs.length, 1);
});

// ===========================================================================
// RequestService
// ===========================================================================

test('RequestService: approving a GROUP_CHANGE request updates the student\'s group', async () => {
  const { models } = buildModels({
    users: [{ username: 'stu', role: ROLES.STUDENT, isActive: true }],
    students: [{ userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: 'G1', isActive: true }],
  });
  const service = createRequestService({
    models,
    auditService: { recordAudit: async () => {} },
    runInTransaction: createFakeTransactionRunner(models),
  });

  const request = await service.createGroupChangeRequest({
    actorUser: { id: 'user_1', role: ROLES.STUDENT },
    requestedGroup: 'G2',
  });

  await service.review({ actorUser: { id: 'admin_1', role: ROLES.ADMIN }, requestId: request._id, status: 'APPROVED' });

  const student = models.Student._docs.find((s) => s._id === 'student_1');
  assert.strictEqual(student.group, 'G2');
});

test('RequestService: reviewing an already-reviewed request is rejected', async () => {
  const { models } = buildModels({
    users: [{ username: 'stu', role: ROLES.STUDENT, isActive: true }],
    students: [{ userId: 'user_1', studentCode: 'S1', fullName: 'Stu', group: 'G1', isActive: true }],
  });
  const service = createRequestService({
    models,
    auditService: { recordAudit: async () => {} },
    runInTransaction: createFakeTransactionRunner(models),
  });

  const request = await service.createGroupChangeRequest({
    actorUser: { id: 'user_1', role: ROLES.STUDENT },
    requestedGroup: 'G2',
  });
  await service.review({ actorUser: { id: 'a', role: ROLES.ADMIN }, requestId: request._id, status: 'APPROVED' });

  await assert.rejects(
    () => service.review({ actorUser: { id: 'a', role: ROLES.ADMIN }, requestId: request._id, status: 'REJECTED' }),
    (err) => {
      assert.strictEqual(err.statusCode, 409);
      return true;
    }
  );
});

// ===========================================================================
// CORRECTION 1: Permanent schedule day/date (dayOfWeek) changes
// ===========================================================================

test('ScheduleService: Admin permanent change CAN change the recurring dayOfWeek pattern', async () => {
  const { models, service } = scheduleFixture();
  const template = await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  const result = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId: sessions[0]._id,
    patch: { dayOfWeek: 'WEDNESDAY' },
    isPermanent: true,
    effectiveFrom: '2026-10-07',
  });

  assert.strictEqual(result.noop, false);
  assert.ok(result.change.changeTypes.includes('DAY_CHANGED'));

  const oldTemplate = models.ScheduleTemplate._docs.find((t) => t._id === template._id);
  assert.strictEqual(oldTemplate.isActive, false);

  const newTemplate = models.ScheduleTemplate._docs.find(
    (t) => t.subjectId === 'subject_1' && t._id !== template._id
  );
  assert.strictEqual(newTemplate.dayOfWeek, 'WEDNESDAY');
  assert.strictEqual(newTemplate.isActive, true);
});

test('ScheduleService: future sessions materialize on the NEW day after a permanent dayOfWeek change', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const [firstSession] = await service.getSessionsForRange({
    startDate: '2026-10-03', // a Saturday
    endDate: '2026-10-03',
  });

  // Permanent change: from 2026-10-14 onward, this class is on Wednesday instead.
  await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId: firstSession._id,
    patch: { dayOfWeek: 'WEDNESDAY' },
    isPermanent: true,
    effectiveFrom: '2026-10-14',
  });

  // A Saturday BEFORE the effective date should still materialize under
  // the OLD (now isActive:false, but still historically valid) template.
  const stillOldPattern = await service.getSessionsForRange({
    startDate: '2026-10-10',
    endDate: '2026-10-10', // Saturday, before effectiveFrom
  });
  assert.strictEqual(stillOldPattern.length, 1, 'a pre-effective Saturday must still materialize under the old pattern');

  // A Wednesday ON/AFTER the effective date should materialize under the NEW pattern.
  const newPattern = await service.getSessionsForRange({
    startDate: '2026-10-14',
    endDate: '2026-10-14', // Wednesday, on effectiveFrom
  });
  assert.strictEqual(newPattern.length, 1, 'the new Wednesday pattern must materialize from the effective date');

  // And the OLD Saturday pattern must NOT produce a session on/after the effective date.
  const oldPatternAfterEffective = await service.getSessionsForRange({
    startDate: '2026-10-17', // the following Saturday, after effectiveFrom
    endDate: '2026-10-17',
  });
  assert.strictEqual(oldPatternAfterEffective.length, 0, 'the old Saturday pattern must not recur after the change');
});

test('ScheduleService: a permanent dayOfWeek change is rejected for a non-Admin / non-permanent request', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  await assert.rejects(
    () =>
      service.applyChange({
        actorUser: { id: 'user_1', role: ROLES.DOCTOR },
        sessionId: sessions[0]._id,
        patch: { dayOfWeek: 'WEDNESDAY' }, // no isPermanent
      }),
    (err) => {
      assert.strictEqual(err.code, 'DAY_OF_WEEK_REQUIRES_PERMANENT');
      return true;
    }
  );
});

// ===========================================================================
// CORRECTION 2: Idempotency / duplicate-request protection (layer 2 —
// protects against a REAL change being double-submitted, distinct from
// layer 1's "no difference from current" no-op already tested above)
// ===========================================================================

test('ScheduleService: a duplicate submission of the SAME real change by the SAME actor executes only once', async () => {
  // A true concurrent race (two near-simultaneous requests both reading
  // the pre-change state before either writes) can't be reproduced
  // deterministically against a single-threaded in-memory fake with no
  // real I/O latency — so this test instead directly sets up the exact
  // situation the duplicate check protects against: a ScheduleChange
  // recorded moments ago by this actor for this session with the SAME
  // resulting `after` state we are about to request again, while the
  // session's current state has (for whatever reason) reverted to
  // something else in between. This exercises the real
  // findRecentDuplicateChange code path exactly as applyChange() calls
  // it, deterministically and without sleeping in the test.
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  // Simulate: this actor's change to room_2 was already recorded 2
  // seconds ago (well within the 10s window)...
  await models.ScheduleChange.create({
    sessionId,
    changedBy: 'user_1',
    changedByRole: ROLES.DOCTOR,
    changeTypes: ['ROOM_CHANGED'],
    before: { roomId: 'room_1' },
    after: { roomId: 'room_2', startTime: '10:00', endTime: '12:00', doctorId: 'doctor_1', taId: null, date: null, status: 'ACTIVE' },
    isPermanent: false,
    createdAt: new Date(Date.now() - 2000),
  });
  // ...but session.current is (still/again) room_1 — e.g. the winning
  // racer's write hasn't landed from this actor's point of view yet.
  const session = await service.getSessionById(sessionId);
  session.current.roomId = 'room_1';
  await session.save();

  const result = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { roomId: 'room_2' }, // same target the "other racer" already recorded
  });

  assert.strictEqual(result.duplicate, true);
  assert.strictEqual(models.ScheduleChange._docs.length, 1, 'no second ScheduleChange must be created');
  assert.strictEqual(
    models.Notification._docs.filter((n) => n.relatedId === sessionId).length,
    0,
    'no notification must be dispatched for a detected duplicate'
  );
});

test('ScheduleService: a change outside the duplicate window is treated as genuinely new, not a duplicate', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  // An identical-looking change by the same actor exists, but from 20
  // seconds ago — outside the 10s duplicate window.
  await models.ScheduleChange.create({
    sessionId,
    changedBy: 'user_1',
    changedByRole: ROLES.DOCTOR,
    changeTypes: ['ROOM_CHANGED'],
    before: { roomId: 'room_1' },
    after: { roomId: 'room_2', startTime: '10:00', endTime: '12:00', doctorId: 'doctor_1', taId: null, date: null, status: 'ACTIVE' },
    isPermanent: false,
    createdAt: new Date(Date.now() - 20000),
  });

  const result = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { roomId: 'room_2' },
  });

  assert.strictEqual(result.duplicate, false, 'a change outside the window must not be treated as a duplicate');
  assert.strictEqual(models.ScheduleChange._docs.length, 2);
});

test('ScheduleService: two DIFFERENT actors making the same-looking change are NOT deduplicated (spec section 39)', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  const byDoctor = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { roomId: 'room_2' },
  });
  const byLeader = await service.applyChange({
    actorUser: { id: 'user_3', role: ROLES.LEADER },
    sessionId,
    patch: { roomId: 'room_2' },
  });

  assert.strictEqual(byDoctor.duplicate, false);
  assert.strictEqual(byLeader.noop, true);
  assert.strictEqual(models.ScheduleChange._docs.length, 1);
});

// ===========================================================================
// CORRECTION 3: Admin Broadcast Notifications
// ===========================================================================

function broadcastFixture() {
  const { models } = buildModels({
    users: [
      { username: 'stu1', role: ROLES.STUDENT, isActive: true },
      { username: 'dr1', role: ROLES.DOCTOR, isActive: true },
      { username: 'ta1', role: ROLES.TA, isActive: true },
      { username: 'admin1', role: ROLES.ADMIN, isActive: true },
    ],
    students: [{ userId: 'user_1', studentCode: 'S1', fullName: 'S', group: 'G1', isActive: true }],
    leaders: [{ userId: 'user_5', slot: 'MALE', isActive: true, linkedStudentId: 'x' }],
  });
  const service = createNotificationService({ models });
  return { models, service };
}

test('NotificationService.broadcast to STUDENTS reaches only students + Admin', async () => {
  const { models, service } = broadcastFixture();

  const notification = await service.broadcast({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    audience: 'STUDENTS',
    title: 'Heads up',
    message: 'Campus closed tomorrow.',
  });

  const recipientUserIds = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);

  assert.ok(recipientUserIds.includes('user_1'));
  assert.ok(recipientUserIds.includes('user_4'));
  assert.ok(!recipientUserIds.includes('user_2'));
  assert.ok(!recipientUserIds.includes('user_3'));
});

test('NotificationService.broadcast to EVERYONE reaches every role', async () => {
  const { models, service } = broadcastFixture();

  const notification = await service.broadcast({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    audience: 'EVERYONE',
    title: 'Announcement',
    message: 'System maintenance this weekend.',
  });

  const recipientUserIds = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);

  assert.ok(recipientUserIds.includes('user_1'));
  assert.ok(recipientUserIds.includes('user_2'));
  assert.ok(recipientUserIds.includes('user_3'));
  assert.ok(recipientUserIds.includes('user_5'));
  assert.ok(recipientUserIds.includes('user_4'));
});

test("NotificationService.broadcast: the acting Admin receives their OWN broadcast (overrides general actor exclusion)", async () => {
  const { models, service } = broadcastFixture();

  const notification = await service.broadcast({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    audience: 'EVERYONE',
    title: 'From the Admin',
    message: 'Please read this.',
  });

  const recipientUserIds = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);

  assert.ok(recipientUserIds.includes('user_4'), 'the acting Admin must still receive the broadcast');
});

test('NotificationService.broadcast rejects an invalid audience', async () => {
  const { models, service } = broadcastFixture();
  await assert.rejects(
    () =>
      service.broadcast({
        actorUser: { id: 'user_4', role: ROLES.ADMIN },
        audience: 'EVERYBODY',
        title: 't',
        message: 'm',
      }),
    (err) => {
      assert.strictEqual(err.statusCode, 422);
      return true;
    }
  );
});

// ===========================================================================
// CORRECTION 4: Conflict-behavior documentation check
// ===========================================================================

test('ScheduleService: a doctor double-booked across subjects produces a DOCTOR_CONFLICT warning, non-blocking', async () => {
  const { models, service } = scheduleFixture();
  const subject2 = models.Subject._docs.find((s) => s._id === 'subject_2');
  subject2.doctorId = 'doctor_1';

  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
    subjectId: 'subject_2',
    type: CLASS_TYPES.LECTURE,
    group: GROUPS.ALL,
    dayOfWeek: 'SATURDAY',
    startTime: '13:00',
    endTime: '15:00',
    roomId: 'room_1',
    doctorId: 'doctor_1',
    effectiveFrom: '2026-01-01',
  });

  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const subject2Session = sessions.find((s) => s.subjectId === 'subject_2');

  const result = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId: subject2Session._id,
    patch: { startTime: '10:30', endTime: '11:30' },
  });

  assert.strictEqual(result.noop, false, 'conflicts must warn, never block');
  assert.ok(result.warnings.some((w) => w.type === 'DOCTOR_CONFLICT'));
  assert.ok(
    !result.warnings.some((w) => w.type === 'TA_CONFLICT'),
    'no TA_CONFLICT type should ever be produced — not specified by the spec'
  );
});

// ===========================================================================
// Regression: Admin-causes-change -> Admin-receives-notification, exercised
// end-to-end through the real ScheduleService.applyChange() and
// TaskService.create() flows (not just the NotificationService unit tests
// above), directly reproducing the live-reported scenario.
// ===========================================================================

test('ScheduleService.applyChange: when ADMIN makes the change, that Admin still receives the resulting notification', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  // 'user_4' is the ADMIN in scheduleFixture() — same shape as the live
  // case: the admin who made the change is also among the notification's
  // intended recipients (every active Admin always is).
  const result = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId: sessions[0]._id,
    patch: { startTime: '11:00', endTime: '13:00' },
    reason: 'Phase 4 live test',
  });

  assert.strictEqual(result.noop, false);
  assert.ok(result.change.changeTypes.includes('TIME_CHANGED'));

  const notification = models.Notification._docs.find((n) => n.relatedId === sessions[0]._id);
  assert.ok(notification, 'a notification must have been created');

  const recipientUserIds = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);

  assert.ok(
    recipientUserIds.includes('user_4'),
    'the acting Admin must be among the notification recipients (this is the exact bug reported live)'
  );
});

test('ScheduleService.applyChange: when a DOCTOR makes the change, the Doctor is still excluded but Admin still receives it (no regression)', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  // 'user_1' is Dr One in scheduleFixture(), who owns subject_1.
  await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId: sessions[0]._id,
    patch: { roomId: 'room_2' },
  });

  const notification = models.Notification._docs.find((n) => n.relatedId === sessions[0]._id);
  const recipientUserIds = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);

  assert.ok(!recipientUserIds.includes('user_1'), 'the acting Doctor must still be excluded');
  assert.ok(recipientUserIds.includes('user_4'), 'Admin (not the actor here) must still receive it');
});

test('TaskService.create: an Admin who is also an active recipient receives their own NEW_TASK notification', async () => {
  const { models } = buildModels({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', isActive: true }],
  });
  const notificationService = createNotificationService({ models });
  const service = createTaskService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: async (callback) => callback({ __passthroughFakeSession: true }),
  });

  // The Admin (user_2) creates the task themselves.
  await service.create({
    actorUser: { id: 'user_2', role: ROLES.ADMIN },
    title: 'Admin task',
    subjectId: 'subject_1',
  });

  const notification = models.Notification._docs.find((n) => n.type === 'NEW_TASK');
  const recipientUserIds = models.NotificationRecipient._docs
    .filter((r) => r.notificationId === notification._id)
    .map((r) => r.userId);

  assert.ok(recipientUserIds.includes('user_2'), 'the acting Admin must receive their own NEW_TASK notification');
});

// ===========================================================================
// Schedule Engine gap closure — Part 1 (test-only): A) ONLINE change,
// B) combined multi-field one-time change, C) sequential multi-actor
// changes, D) one-time change followed by a permanent change. These are
// tests against EXISTING ScheduleService.applyChange() behavior — no
// production code is touched in this pass.
// ===========================================================================

// -- A) ONLINE change ---------------------------------------------------

test('Gap A: ACTIVE -> ONLINE creates a ScheduleChange with ONLINE and updates session.status', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;
  assert.strictEqual(sessions[0].status, SESSION_STATUS.ACTIVE);

  const result = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId,
    patch: { status: SESSION_STATUS.ONLINE },
    reason: 'Moving online for this session',
  });

  assert.strictEqual(result.noop, false);
  assert.ok(result.change.changeTypes.includes('ONLINE'));
  assert.strictEqual(result.session.status, SESSION_STATUS.ONLINE);

  const session = await service.getSessionById(sessionId);
  assert.strictEqual(session.status, SESSION_STATUS.ONLINE);
});

// -- B) Combined multi-field change in ONE request -----------------------

test('Gap B: a single request changing date + time + room produces ONE ScheduleChange with all three changeTypes', async () => {
  const { models, service } = scheduleFixture();
  await models.Room.create({ building: 'H', floor: '3', roomNumber: '301', isActive: true });

  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;
  const newRoom = models.Room._docs.find((r) => r.roomNumber === '301');

  const result = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId,
    patch: {
      date: '2026-10-04', // moved from Saturday 10-03 to Sunday 10-04 (spec section 34's own example shape)
      startTime: '14:00',
      endTime: '16:00',
      roomId: newRoom._id,
    },
    reason: 'Combined change — day, time, and room together',
  });

  assert.strictEqual(result.noop, false);
  assert.strictEqual(models.ScheduleChange._docs.length, 1, 'must be exactly ONE ScheduleChange record');
  const { changeTypes } = result.change;
  assert.ok(changeTypes.includes('DAY_CHANGED'), 'must include DAY_CHANGED');
  assert.ok(changeTypes.includes('TIME_CHANGED'), 'must include TIME_CHANGED');
  assert.ok(changeTypes.includes('ROOM_CHANGED'), 'must include ROOM_CHANGED');

  // The current state reflects all three changes together.
  assert.strictEqual(result.session.current.startTime, '14:00');
  assert.strictEqual(result.session.current.endTime, '16:00');
  assert.strictEqual(String(result.session.current.roomId), String(newRoom._id));
  assert.strictEqual(
    new Date(result.session.current.date).toISOString().slice(0, 10),
    '2026-10-04'
  );
});

// -- C) Sequential multi-actor changes on the same session ----------------

test('Gap C: Actor A then Actor B change the same session — latest state is current, BOTH remain in history', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  // Actor A: Dr One (owns subject_1) changes the room.
  const resultA = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { roomId: 'room_2' },
    reason: 'Actor A change',
  });

  // Actor B: the Leader changes the time (a DIFFERENT field) afterward.
  const resultB = await service.applyChange({
    actorUser: { id: 'user_3', role: ROLES.LEADER },
    sessionId,
    patch: { startTime: '15:00', endTime: '17:00' },
    reason: 'Actor B change',
  });

  assert.strictEqual(resultA.noop, false);
  assert.strictEqual(resultB.noop, false);

  // Latest state is current, and it's CUMULATIVE — B's change layered on
  // top of A's, not overwriting it.
  const finalSession = await service.getSessionById(sessionId);
  assert.strictEqual(String(finalSession.current.roomId), 'room_2', "A's room change must persist");
  assert.strictEqual(finalSession.current.startTime, '15:00', "B's time change must also be present");
  assert.strictEqual(finalSession.current.endTime, '17:00');

  // Both changes remain in history, correctly attributed.
  const history = await service.getChangeHistory({ sessionId });
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].changedBy, 'user_1');
  assert.strictEqual(history[0].changedByRole, ROLES.DOCTOR);
  assert.ok(history[0].changeTypes.includes('ROOM_CHANGED'));
  assert.strictEqual(history[1].changedBy, 'user_3');
  assert.strictEqual(history[1].changedByRole, ROLES.LEADER);
  assert.ok(history[1].changeTypes.includes('TIME_CHANGED'));
});

// -- D) One-time change followed by a permanent change ---------------------

test('Gap D: a one-time change followed by a permanent change preserves BOTH in history', async () => {
  const { models, service } = scheduleFixture();
  const template = await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  // Step 1: Doctor makes a ONE-TIME room change.
  const oneTime = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { roomId: 'room_2' },
    reason: 'One-time room swap',
  });
  assert.strictEqual(oneTime.change.isPermanent, false);

  // Step 2: Admin makes a PERMANENT time change on the SAME session.
  const permanent = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId,
    patch: { startTime: '09:00', endTime: '11:00' },
    isPermanent: true,
    effectiveFrom: '2026-10-10',
    reason: 'Permanent time change',
  });
  assert.strictEqual(permanent.change.isPermanent, true);

  // Both events remain in history (spec section 41).
  const history = await service.getChangeHistory({ sessionId });
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].isPermanent, false);
  assert.strictEqual(history[1].isPermanent, true);

  // NOTEWORTHY BEHAVIOR (documented, not asserted as "correct" or
  // "incorrect" — the spec doesn't explicitly state which is required):
  // the permanent change's own `before` snapshot reflects the ALREADY
  // one-time-changed room (room_2), not the original template's room_1,
  // because applyChange() always diffs against the session's CURRENT
  // state, never the original template. See the written report for this
  // gap-closure round for a full discussion of this specific point.
  assert.strictEqual(String(history[1].before.roomId), 'room_2');

  // The new template version becomes the correct future official state
  // for the field the permanent change actually touched...
  const newTemplate = models.ScheduleTemplate._docs.find(
    (t) => t.subjectId === 'subject_1' && t._id !== template._id
  );
  assert.strictEqual(newTemplate.startTime, '09:00');
  assert.strictEqual(newTemplate.endTime, '11:00');
  assert.strictEqual(newTemplate.isActive, true);
  const oldTemplate = models.ScheduleTemplate._docs.find((t) => t._id === template._id);
  assert.strictEqual(oldTemplate.isActive, false);

  // ...and ALSO carries forward the one-time room change into the new
  // template's roomId (since the permanent patch never touched room),
  // because it's built from session.current (already room_2) rather
  // than the ORIGINAL template's room_1. Documented as the same
  // noteworthy behavior as the `before` snapshot above.
  assert.strictEqual(String(newTemplate.roomId), 'room_2');
});

// ===========================================================================
// Schedule Engine gap closure — Part F: Concurrency (F-Full).
//
// These are the regression tests agreed alongside the F-Full
// implementation: they exercise ScheduleService.applyChange()'s
// validate-then-field-level-$set write path directly (not the
// concurrency race itself — see server/tests/concurrency.test.js for
// that), using the ordinary scheduleFixture() single-caller setup.
// ===========================================================================

test('Part F: endTime <= startTime is rejected before any write happens', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  await assert.rejects(
    () =>
      service.applyChange({
        actorUser: { id: 'user_1', role: ROLES.DOCTOR },
        sessionId,
        patch: { startTime: '14:00', endTime: '13:00' }, // endTime before startTime
        reason: 'Should be rejected by session.validate() before any write',
      }),
    /endTime must be later than.*startTime/
  );

  // Nothing was written: no ScheduleChange record, and current is untouched.
  assert.strictEqual(models.ScheduleChange._docs.length, 0);
  const sessionAfter = await service.getSessionById(sessionId);
  assert.strictEqual(sessionAfter.current.startTime, '10:00');
  assert.strictEqual(sessionAfter.current.endTime, '12:00');
});

test('Part F: a malformed time (fails TIME_OF_DAY_REGEX) is rejected before any write happens', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  await assert.rejects(
    () =>
      service.applyChange({
        actorUser: { id: 'user_1', role: ROLES.DOCTOR },
        sessionId,
        patch: { startTime: '25:00' }, // not a valid 24-hour HH:mm value
        reason: 'Should be rejected by session.validate() before any write',
      }),
    /HH:mm 24-hour format/
  );

  assert.strictEqual(models.ScheduleChange._docs.length, 0);
  const sessionAfter = await service.getSessionById(sessionId);
  assert.strictEqual(sessionAfter.current.startTime, '10:00');
});

test('Part F: a combined multi-field change (single caller, F-Full write path) still works correctly', async () => {
  const { models, service } = scheduleFixture();
  await models.Room.create({ building: 'H', floor: '3', roomNumber: '302', isActive: true });
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;
  const newRoom = models.Room._docs.find((r) => r.roomNumber === '302');

  const result = await service.applyChange({
    actorUser: { id: 'user_4', role: ROLES.ADMIN },
    sessionId,
    patch: { startTime: '15:00', endTime: '17:00', roomId: newRoom._id },
    reason: 'Combined time+room change under the F-Full write path',
  });

  assert.strictEqual(result.noop, false);
  assert.strictEqual(result.session.current.startTime, '15:00');
  assert.strictEqual(result.session.current.endTime, '17:00');
  assert.strictEqual(String(result.session.current.roomId), String(newRoom._id));

  // And it's genuinely persisted, not just reflected on the in-memory
  // return value — re-read through a fresh findById().
  const sessionAfter = await service.getSessionById(sessionId);
  assert.strictEqual(sessionAfter.current.startTime, '15:00');
  assert.strictEqual(sessionAfter.current.endTime, '17:00');
  assert.strictEqual(String(sessionAfter.current.roomId), String(newRoom._id));
});

test('Part F: the session write is a field-level $set, never a whole-`current` replace', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  // Spy on updateOne to capture exactly what ScheduleService passes it,
  // without changing its behavior (delegates through to the real fake).
  const originalUpdateOne = models.ScheduleSession.updateOne.bind(models.ScheduleSession);
  const calls = [];
  models.ScheduleSession.updateOne = async (filter, update, options) => {
    calls.push({ filter, update, options });
    return originalUpdateOne(filter, update, options);
  };

  await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { roomId: 'room_2' },
    reason: 'Room-only change',
  });

  models.ScheduleSession.updateOne = originalUpdateOne; // restore for cleanliness

  assert.strictEqual(calls.length, 1, 'applyChange() must call updateOne exactly once for this single-field change');
  const { update } = calls[0];
  assert.ok(update.$set, 'update must use $set');
  assert.ok('current.roomId' in update.$set, 'must $set the specific dot-path current.roomId');
  assert.strictEqual(update.$set['current.roomId'], 'room_2');
  // The whole point of Part F: NEVER $set the whole `current` subdocument.
  assert.ok(!('current' in update.$set), 'must NOT $set the whole `current` subdocument');
  // And it must not touch fields this patch never changed.
  assert.ok(!('current.startTime' in update.$set));
  assert.ok(!('current.endTime' in update.$set));
});

test('Part F: updateOne() receives the transaction session ({ session: dbSession })', async () => {
  const { models, service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  const originalUpdateOne = models.ScheduleSession.updateOne.bind(models.ScheduleSession);
  let capturedOptions;
  models.ScheduleSession.updateOne = async (filter, update, options) => {
    capturedOptions = options;
    return originalUpdateOne(filter, update, options);
  };

  await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { roomId: 'room_2' },
    reason: 'Room-only change',
  });

  models.ScheduleSession.updateOne = originalUpdateOne;

  assert.ok(capturedOptions, 'updateOne must have been called');
  assert.ok(
    capturedOptions.session && capturedOptions.session.__passthroughFakeSession,
    'updateOne must receive { session: dbSession } — the SAME fake transaction session runInTransaction handed it, ' +
      'proving the write still participates in the transaction'
  );
});

test('Part F: result.session.current/status still reflect the new state immediately (no regression to the in-memory return value)', async () => {
  const { service } = scheduleFixture();
  await service.createTemplate({
    actorUser: { id: 'a', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  const result = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId,
    patch: { status: 'ONLINE' },
    reason: 'Move online',
  });

  // Exactly the same contract as before Part F: the returned `session`
  // reflects the new state right away, even though the actual database
  // write is now a field-level updateOne() rather than session.save().
  assert.strictEqual(result.session.status, 'ONLINE');
});

// ===========================================================================
// Schedule Engine gap closure — Part 2: Transactional Integrity (E).
//
// SIMULATION-ONLY: these tests use helpers/fakeTransaction.js, an
// in-memory snapshot/restore mechanism over this test harness's fake
// collections. It does NOT exercise real MongoDB ACID behavior (no real
// isolation, no real durability, no real storage-engine atomicity) — it
// only proves that ScheduleService.applyChange()'s write phase, as
// written, correctly treats a thrown error from ANY write inside the
// transaction callback as a signal to undo every other write from that
// same callback invocation. Real transactional correctness against a
// live MongoDB replica set can only be verified by running this project
// against one directly — that is NOT what these tests do.
// ===========================================================================

function transactionalFixture(seed = {}) {
  const scope = createTestFixtureScope();
  const c = (prefix, key) => createFakeCollection(prefix, seed[key] || [], scope);
  const models = {
    User: c('user', 'users'),
    Student: c('student', 'students'),
    Doctor: c('doctor', 'doctors'),
    TA: c('ta', 'tas'),
    Leader: c('leader', 'leaders'),
    Subject: c('subject', 'subjects'),
    Room: c('room', 'rooms'),
    ScheduleTemplate: c('template', 'templates'),
    ScheduleSession: c('session', 'sessions'),
    ScheduleChange: c('change', 'changes'),
    Task: c('task', 'tasks'),
    TaskCompletion: c('completion', 'completions'),
    Notification: c('notification', 'notifications'),
    NotificationRecipient: c('recipient', 'recipients'),
    Request: c('request', 'requests'),
    AuditLog: c('audit', 'auditLogs'),
    SystemSettings: {
      getSingleton: async () => ({ maintenanceMode: false, maintenanceMessage: '' }),
    },
  };
  const notificationService = createNotificationService({ models });
  const service = createScheduleService({
    models,
    auditService: { recordAudit: async () => {} },
    notificationService,
    runInTransaction: createFakeTransactionRunner(models),
  });
  return { models, service };
}

test('[SIMULATION] E: a one-time change is fully rolled back when ScheduleChange.create fails', async () => {
  const { models, service } = transactionalFixture({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', isActive: true }],
    rooms: [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }],
  });

  await service.createTemplate({
    actorUser: { id: 'user_2', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;
  const originalCurrent = { ...sessions[0].current };
  const originalStatus = sessions[0].status;

  // Inject a failure at the ScheduleChange write step — simulates a DB
  // write failure partway through the transaction's write phase.
  const originalCreate = models.ScheduleChange.create;
  models.ScheduleChange.create = async () => {
    throw new Error('Simulated write failure at ScheduleChange.create');
  };

  await assert.rejects(
    () =>
      service.applyChange({
        actorUser: { id: 'user_1', role: ROLES.DOCTOR },
        sessionId,
        patch: { roomId: 'room_2' },
        reason: 'Should be rolled back',
      }),
    /Simulated write failure/
  );

  models.ScheduleChange.create = originalCreate; // restore for cleanliness

  // No partial state: session.current/status must be EXACTLY as before
  // the failed attempt — not left half-changed.
  const sessionAfter = await service.getSessionById(sessionId);
  assert.strictEqual(String(sessionAfter.current.roomId), String(originalCurrent.roomId));
  assert.strictEqual(sessionAfter.status, originalStatus);

  // No ScheduleChange, Notification, or NotificationRecipient must exist.
  assert.strictEqual(models.ScheduleChange._docs.length, 0);
  assert.strictEqual(models.Notification._docs.length, 0);
  assert.strictEqual(models.NotificationRecipient._docs.length, 0);
});

test('[SIMULATION] E: a permanent change is fully rolled back (session AND template versioning) when a later write fails', async () => {
  const { models, service } = transactionalFixture({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', isActive: true }],
    rooms: [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }],
  });

  const template = await service.createTemplate({
    actorUser: { id: 'user_2', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  // Fail at the ScheduleChange step — AFTER the template versioning
  // writes (old template closed, new template created) have already
  // happened earlier in the SAME callback invocation. This is the key
  // proof point for E: template versioning must be undone too, not just
  // the session.
  const originalCreate = models.ScheduleChange.create;
  models.ScheduleChange.create = async () => {
    throw new Error('Simulated write failure after template versioning');
  };

  await assert.rejects(() =>
    service.applyChange({
      actorUser: { id: 'user_2', role: ROLES.ADMIN },
      sessionId,
      patch: { startTime: '09:00', endTime: '11:00' },
      isPermanent: true,
      effectiveFrom: '2026-10-10',
      reason: 'Should be fully rolled back',
    })
  );

  models.ScheduleChange.create = originalCreate;

  // The OLD template must still be exactly as it was — NOT closed.
  const oldTemplateAfter = models.ScheduleTemplate._docs.find((t) => t._id === template._id);
  assert.strictEqual(oldTemplateAfter.isActive, true, 'old template must NOT have been closed');
  assert.strictEqual(
    oldTemplateAfter.effectiveTo,
    undefined,
    'effectiveTo must be back to its pre-mutation state (never explicitly set at creation)'
  );

  // No NEW template version must exist.
  const newTemplates = models.ScheduleTemplate._docs.filter((t) => t._id !== template._id);
  assert.strictEqual(newTemplates.length, 0, 'no new template version must have been created');

  // The session itself must be unchanged too.
  const sessionAfter = await service.getSessionById(sessionId);
  assert.strictEqual(sessionAfter.current.startTime, '10:00');
  assert.strictEqual(sessionAfter.current.endTime, '12:00');

  assert.strictEqual(models.ScheduleChange._docs.length, 0);
});

test('[SIMULATION] E: a failure during notification dispatch also rolls back the ScheduleChange record (proves the WHOLE write phase is atomic, not partially so)', async () => {
  const { models, service } = transactionalFixture({
    users: [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ],
    doctors: [{ userId: 'user_1', fullName: 'Dr One', isActive: true }],
    subjects: [{ name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', isActive: true }],
    rooms: [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }],
  });

  await service.createTemplate({
    actorUser: { id: 'user_2', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });
  const sessionId = sessions[0]._id;

  // Fail at the LAST write in the transaction's write phase — the
  // notification fan-out — to prove that even an early, otherwise-
  // successful write (the ScheduleChange record) is undone too, since
  // it happened inside the SAME callback invocation.
  const originalCreate = models.NotificationRecipient.create;
  models.NotificationRecipient.create = async () => {
    throw new Error('Simulated failure dispatching notifications');
  };

  await assert.rejects(() =>
    service.applyChange({
      actorUser: { id: 'user_1', role: ROLES.DOCTOR },
      sessionId,
      patch: { roomId: 'room_2' },
      reason: 'Should be rolled back even though ScheduleChange write itself succeeded',
    })
  );

  models.NotificationRecipient.create = originalCreate;

  assert.strictEqual(models.ScheduleChange._docs.length, 0, 'the earlier ScheduleChange write must also be undone');
  assert.strictEqual(models.Notification._docs.length, 0);
  const sessionAfter = await service.getSessionById(sessionId);
  assert.strictEqual(String(sessionAfter.current.roomId), 'room_1', 'session must be unchanged');
});

test('[SIMULATION] E: AuditService still records the change even though it runs OUTSIDE the transaction (by design)', async () => {
  const scope = createTestFixtureScope();
  const c = (prefix, key, seed = []) => createFakeCollection(prefix, seed, scope);
  const models = {
    User: c('user', 'users', [
      { username: 'dr', role: ROLES.DOCTOR, isActive: true },
      { username: 'admin', role: ROLES.ADMIN, isActive: true },
    ]),
    Student: c('student', 'students'),
    Doctor: c('doctor', 'doctors', [{ userId: 'user_1', fullName: 'Dr One', isActive: true }]),
    TA: c('ta', 'tas'),
    Leader: c('leader', 'leaders'),
    Subject: c('subject', 'subjects', [
      { name: 'OOP', code: 'OOP101', doctorId: 'doctor_1', isActive: true },
    ]),
    Room: c('room', 'rooms', [{ building: 'H', floor: '2', roomNumber: '204', isActive: true }]),
    ScheduleTemplate: c('template', 'templates'),
    ScheduleSession: c('session', 'sessions'),
    ScheduleChange: c('change', 'changes'),
    Notification: c('notification', 'notifications'),
    NotificationRecipient: c('recipient', 'recipients'),
    AuditLog: c('audit', 'auditLogs'),
    SystemSettings: { getSingleton: async () => ({ maintenanceMode: false, maintenanceMessage: '' }) },
  };
  const auditCalls = [];
  const notificationService = createNotificationService({ models });
  const service = createScheduleService({
    models,
    auditService: { recordAudit: async (p) => auditCalls.push(p) },
    notificationService,
    runInTransaction: createFakeTransactionRunner(models),
  });

  await service.createTemplate({
    actorUser: { id: 'user_2', role: ROLES.ADMIN },
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
  const sessions = await service.getSessionsForRange({ startDate: '2026-10-03', endDate: '2026-10-03' });

  await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId: sessions[0]._id,
    patch: { roomId: 'room_1' }, // no-op on purpose, doesn't matter for this test — real change below
  });
  const realResult = await service.applyChange({
    actorUser: { id: 'user_1', role: ROLES.DOCTOR },
    sessionId: sessions[0]._id,
    patch: { startTime: '11:00', endTime: '13:00' },
  });

  assert.strictEqual(realResult.noop, false);
  assert.ok(auditCalls.some((c) => c.action === 'SCHEDULE_CHANGED'), 'AuditService must still be called on success');
});
